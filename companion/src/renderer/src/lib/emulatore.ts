/**
 * The ORION emulator inside the Companion: the SDK's emulator compiled to
 * WebAssembly (SDK/emulator/web, `make web`), copied here as
 * `src/renderer/src/emu/orion-emu.mjs` by `npm run emu:copia`.
 *
 * Same runtime as the device (Lua, orion_api, fonts); the page owns the
 * clock and the keyboard. The card lives in the module's memory: each run
 * starts from an empty /card/apps with the system sounds already in
 * /card/sounds, so what an app saved is gone when the window closes.
 *
 * Keys like the desktop emulator: arrows, Enter, Esc, Backspace, Delete,
 * F1 MENU, F2 SAVE, F3 SEARCH, F4 PLAY, F5/F6 RW/FW, Alt = Fn, Shift.
 */
import type { StoreTryPackage } from "@shared/ipc-types";

export const EMU_W = 536;
export const EMU_H = 336;

/* The panel's two colours, as the desktop emulator draws them. */
const NERO = [0x10, 0x10, 0x10];
const BIANCO = [0xe8, 0xe8, 0xe0];

interface Modulo {
  FS: {
    mkdirTree: (p: string) => void;
    writeFile: (p: string, d: Uint8Array) => void;
    readdir: (p: string) => string[];
    stat: (p: string) => { mode: number };
    isDir: (m: number) => boolean;
    unlink: (p: string) => void;
    rmdir: (p: string) => void;
    analyzePath: (p: string) => { exists: boolean };
  };
  HEAPU8: Uint8Array;
  ccall: (n: string, r: string | null, t: string[], a: unknown[]) => number;
  _emu_web_passo: () => number;
  _emu_web_fb: () => number;
  _emu_web_sporco: () => number;
  _emu_web_tasto: (c: number, giu: number) => void;
  _emu_web_mod: (s: number, f: number) => void;
  _emu_web_esci: () => void;
  _emu_web_frame_interi: () => number;
  SDL2?: { audioContext?: AudioContext };
}

let modulo: Promise<Modulo> | null = null;
let logger: (riga: string, errore: boolean) => void = () => undefined;

/** The module is loaded once and kept: it is a few MB, and an app's state
 *  is reset by emu_web_avvia() anyway. */
function carica(): Promise<Modulo> {
  if (!modulo) {
    modulo = import("../emu/orion-emu.mjs").then((m) =>
      (m.default as (o: object) => Promise<Modulo>)({
        print: (t: string) => logger(t, false),
        printErr: (t: string) => logger(t, true),
      }),
    );
    modulo.catch(() => {
      modulo = null;
    });
  }
  return modulo;
}

function svuota(M: Modulo, dir: string): void {
  if (!M.FS.analyzePath(dir).exists) return;
  for (const n of M.FS.readdir(dir)) {
    if (n === "." || n === "..") continue;
    const p = `${dir}/${n}`;
    if (M.FS.isDir(M.FS.stat(p).mode)) {
      svuota(M, p);
      M.FS.rmdir(p);
    } else M.FS.unlink(p);
  }
}

function b64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* A typed character as the device encodes it: ASCII, or 0x80..0x87 for
   à è ì ò ù é £ € (keyboard.h, the private range). */
const PRIVATI: Record<string, number> = { à: 0x80, è: 0x81, ì: 0x82, ò: 0x83, ù: 0x84, é: 0x85, "£": 0x86, "€": 0x87 };
function carattere(k: string): number {
  if (k.length !== 1) return 0;
  const c = k.charCodeAt(0);
  if (c >= 0x20 && c < 0x7f) return c;
  return PRIVATI[k] ?? 0;
}

const NOMI: Record<string, string> = {
  Escape: "ESC", Enter: "ENTER", Backspace: "BACK", Delete: "DEL",
  ArrowUp: "UP", ArrowDown: "DOWN", ArrowLeft: "LEFT", ArrowRight: "RIGHT",
  F1: "MENU", F2: "SAVE", F3: "SEARCH", F4: "PLAY", F5: "RW", F6: "FW",
};

export class Emulatore {
  private M: Modulo | null = null;
  private timer: number | null = null;
  private img: ImageData;
  private ctx: CanvasRenderingContext2D;
  private codici = new Map<string, number>();
  private emessi = new Map<string, number>();     // physical key -> code queued, for keyup
  private slug = "";
  onFine: () => void = () => undefined;

  constructor(private canvas: HTMLCanvasElement, log: (riga: string, errore: boolean) => void) {
    logger = log;
    canvas.width = EMU_W;
    canvas.height = EMU_H;
    this.ctx = canvas.getContext("2d")!;
    this.img = this.ctx.createImageData(EMU_W, EMU_H);
    canvas.tabIndex = 0;
    canvas.addEventListener("keydown", this.giu);
    canvas.addEventListener("keyup", this.su);
    canvas.addEventListener("blur", this.rilasciaTutto);
    canvas.addEventListener("mousedown", () => void this.audio());
  }

  /** Writes the package in the emulated card and starts the app. */
  async avvia(pkg: StoreTryPackage): Promise<void> {
    const M = (this.M = await carica());
    this.ferma();
    M._emu_web_esci();
    svuota(M, "/card/apps");
    M.FS.mkdirTree("/card/apps");
    for (const f of pkg.files) {
      /* Same two places as on the device: the script, and its data folder. */
      const p = f.path === `${pkg.slug}.lua` ? `/card/apps/${f.path}` : `/card/apps/data/${pkg.slug}/${f.path.slice(5)}`;
      if (f.path !== `${pkg.slug}.lua` && !f.path.startsWith("data/")) continue;
      M.FS.mkdirTree(p.slice(0, p.lastIndexOf("/")));
      M.FS.writeFile(p, b64(f.b64));
    }
    this.slug = pkg.slug;
    for (const [k, nome] of Object.entries(NOMI)) this.codici.set(k, M.ccall("emu_web_nome", "number", ["string"], [nome]));
    if (!M.ccall("emu_web_avvia", "number", ["string"], [`apps/${pkg.slug}.lua`])) {
      throw new Error(`The emulator could not start ${pkg.slug}.lua (see the log).`);
    }
    this.disegna(true);
    /* The desktop emulator turns every 10 ms; so does this. */
    this.timer = window.setInterval(() => this.giro(), 10);
    this.canvas.focus();
  }

  async riavvia(pkg: StoreTryPackage): Promise<void> {
    await this.avvia(pkg);
  }

  /** The screen as a PNG (data: URL), at `scala` times the panel's pixels. */
  cattura(scala = 2): string {
    const c = document.createElement("canvas");
    c.width = EMU_W * scala;
    c.height = EMU_H * scala;
    const x = c.getContext("2d")!;
    x.imageSmoothingEnabled = false;
    x.drawImage(this.canvas, 0, 0, c.width, c.height);
    return c.toDataURL("image/png");
  }

  /** Full frames sent so far: on the device each costs ~75 ms. */
  frameInteri(): number {
    return this.M ? this.M._emu_web_frame_interi() : 0;
  }

  ferma(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  distruggi(): void {
    this.ferma();
    this.M?._emu_web_esci();
    this.canvas.removeEventListener("keydown", this.giu);
    this.canvas.removeEventListener("keyup", this.su);
    this.canvas.removeEventListener("blur", this.rilasciaTutto);
  }

  get app(): string {
    return this.slug;
  }

  private giro(): void {
    const M = this.M;
    if (!M) return;
    const viva = M._emu_web_passo();
    this.disegna(false);
    if (!viva) {
      this.ferma();
      this.onFine();
    }
  }

  private disegna(forza: boolean): void {
    const M = this.M;
    if (!M || (!M._emu_web_sporco() && !forza)) return;
    const fb = M.HEAPU8.subarray(M._emu_web_fb(), M._emu_web_fb() + EMU_W * EMU_H);
    const d = this.img.data;
    for (let i = 0; i < fb.length; i++) {
      const c = fb[i] ? NERO : BIANCO;
      d[i * 4] = c[0];
      d[i * 4 + 1] = c[1];
      d[i * 4 + 2] = c[2];
      d[i * 4 + 3] = 255;
    }
    this.ctx.putImageData(this.img, 0, 0);
  }

  /* Browsers start audio only after a gesture: the first key or click. */
  private async audio(): Promise<void> {
    const ac = this.M?.SDL2?.audioContext;
    if (ac && ac.state === "suspended") await ac.resume().catch(() => undefined);
  }

  private mod(e: KeyboardEvent): void {
    this.M?._emu_web_mod(e.shiftKey ? 1 : 0, e.altKey ? 1 : 0);
  }

  private giu = (e: KeyboardEvent): void => {
    const M = this.M;
    if (!M) return;
    void this.audio();
    this.mod(e);
    if (e.metaKey || e.ctrlKey) return;            // leave Cmd/Ctrl shortcuts to the app window
    e.preventDefault();
    if (e.repeat) return;                          // the device repeats keys itself
    let code = this.codici.get(e.key) ?? 0;
    if (!code) {
      /* Alt is Fn: the key without what the OS layout does with Alt
         (Alt+e on a Mac is a dead key), as the desktop emulator does. */
      if (e.altKey && /^Key[A-Z]$/.test(e.code)) code = e.code.charCodeAt(3) + 32;
      else if (e.altKey && /^Digit[0-9]$/.test(e.code)) code = e.code.charCodeAt(5);
      else code = carattere(e.key);
    }
    if (!code) return;
    this.emessi.set(e.code, code);
    M._emu_web_tasto(code, 1);
  };

  private su = (e: KeyboardEvent): void => {
    const M = this.M;
    if (!M) return;
    this.mod(e);
    const code = this.emessi.get(e.code);
    if (code === undefined) return;
    e.preventDefault();
    this.emessi.delete(e.code);
    M._emu_web_tasto(code, 0);
  };

  /* Focus lost with a key held: release it, or the app sees it down forever. */
  private rilasciaTutto = (): void => {
    for (const c of this.emessi.values()) this.M?._emu_web_tasto(c, 0);
    this.emessi.clear();
    this.M?._emu_web_mod(0, 0);
  };

  /** An on-screen button for the keys a PC keyboard does not have. */
  premi(nome: string, giu: boolean): void {
    const M = this.M;
    if (!M) return;
    void this.audio();
    const code = M.ccall("emu_web_nome", "number", ["string"], [nome]);
    if (code) M._emu_web_tasto(code, giu ? 1 : 0);
    this.canvas.focus();
  }
}
