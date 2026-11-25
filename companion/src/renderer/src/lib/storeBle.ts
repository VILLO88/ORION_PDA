/**
 * App Store over Bluetooth: install, list and remove apps on ORION without
 * the cable. The same rules as the USB path (src/main/store/store.ts):
 * `<slug>.lua` in /apps/, data in /apps/data/<slug>/, nothing elsewhere, the
 * script last, and `/apps/.store.json` remembering which version came from
 * the store.
 *
 * The radio lives in this page (Web Bluetooth), so this runs here and not in
 * the main process; the package comes from the main process, already
 * checked against its SHA-256.
 *
 * ⚠️ Speed: ~0.5-1.3 kB/s (docs/firmware/BLE_DATI.md). A small app is
 * seconds, a big one minutes: the page warns before starting. Files that
 * are already on the card with the same size and CRC are not sent again,
 * so an update moves only what changed.
 *
 * Firmware: ble_dati.c refuses writes in /apps/ while an app other than
 * the launcher is open (FatFs has no locking), and tells the launcher to
 * re-read the folder, so a new app appears with Apps on screen.
 */
import type { StoreInstalledResponse, StoreTryPackage } from "@shared/ipc-types";
import { api } from "./api";
import { bleCondiviso, crc32, type EmettiProgresso } from "./bleOrion";

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,26}$/;
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
/** path_vero[96] in ble_dati.c, minus ".part". */
const MAX_PATH = 90;
const LAUNCHER_LIMIT = 15;
const INDICE = "/apps/.store.json";

type Indice = Record<string, { version: string; installedAt: string }>;

function b64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The card path of a package entry, or an error (same rule as USB). */
function percorso(slug: string, p: string): string {
  let dest: string;
  if (p === `${slug}.lua`) dest = `/apps/${p}`;
  else {
    const seg = p.split("/");
    if (seg[0] !== "data" || seg.length < 2 || !seg.slice(1).every((s) => SEGMENT_RE.test(s) && s !== "." && s !== "..")) {
      throw new Error(`The package contains a path that is not allowed: ${p}`);
    }
    dest = `/apps/data/${slug}/${seg.slice(1).join("/")}`;
  }
  if (dest.length > MAX_PATH) throw new Error(`Path too long for ORION's Bluetooth link (max ${MAX_PATH}): ${dest}`);
  return dest;
}

function vuoleOrion(): void {
  if (!bleCondiviso.connesso) throw new Error("ORION is not connected over Bluetooth.");
  if (!bleCondiviso.naviga) throw new Error("ORION's firmware is too old to manage files over Bluetooth: update it.");
}

/** Errors from the device in words for the page. */
function chiaro(e: unknown): Error {
  const m = (e as Error).message ?? String(e);
  if (/app aperta/.test(m)) return new Error("An app is open on ORION: close it (Apps on screen is fine) and try again.");
  if (/non ci sta/.test(m)) return new Error("Not enough free space on ORION's card.");
  if (/occupato/.test(m)) return new Error(`ORION is busy (${m.replace(/^.*occupato:\s*/, "")}): try again when it is done.`);
  return e instanceof Error ? e : new Error(m);
}

async function leggiIndice(): Promise<Indice> {
  try {
    if (!(await bleCondiviso.stat(INDICE))) return {};
    return JSON.parse(new TextDecoder().decode(await bleCondiviso.leggiFile(INDICE))) as Indice;
  } catch {
    return {}; // unreadable: as if nothing came from the store
  }
}

async function scriviIndice(idx: Indice): Promise<void> {
  await bleCondiviso.inviaFile(INDICE, new TextEncoder().encode(JSON.stringify(idx, null, 2)));
}

/** Bytes still to send for a package: what is not already on the card. */
export async function daMandare(pkg: StoreTryPackage): Promise<{ file: number; byte: number; totale: number }> {
  vuoleOrion();
  let file = 0, byte = 0, totale = 0;
  for (const f of pkg.files) {
    const dati = b64(f.b64);
    totale += dati.length;
    const gia = await bleCondiviso.stat(percorso(pkg.slug, f.path));
    if (!gia || gia.byte !== dati.length || gia.crc !== crc32(dati)) {
      file++;
      byte += dati.length;
    }
  }
  return { file, byte, totale };
}

/** Seconds to send `byte`, as the link measured itself. */
export function stimaSecondi(byte: number): number {
  return Math.ceil(byte / Math.max(bleCondiviso.velocitaStimata, 200));
}

export async function scaricaPacchetto(slug: string, version?: string): Promise<StoreTryPackage> {
  if (!SLUG_RE.test(slug)) throw new Error("Invalid app name");
  return api.store.packageFiles(slug, version);
}

export async function installaBle(
  pkg: StoreTryPackage,
  emetti?: (fatto: number, totale: number, file: string) => void,
): Promise<{ version: string; inviati: number }> {
  vuoleOrion();
  /* Every path checked before the first byte goes. */
  const piano = pkg.files.map((f) => ({ dest: percorso(pkg.slug, f.path), dati: b64(f.b64) }));
  const script = `/apps/${pkg.slug}.lua`;
  if (!piano.some((x) => x.dest === script)) throw new Error("The package has no script.");
  /* The script last: until it is there the launcher does not show the app. */
  piano.sort((a, b) => Number(a.dest === script) - Number(b.dest === script));

  const totale = piano.reduce((n, x) => n + x.dati.length, 0);
  let base = 0, inviati = 0;
  try {
    for (const x of piano) {
      const prog: EmettiProgresso = (p) => emetti?.(base + (p.inviati ?? 0), totale, x.dest);
      if (await bleCondiviso.inviaSeDiverso(x.dest, x.dati, prog)) inviati++;
      base += x.dati.length;
      emetti?.(base, totale, x.dest);
    }
    const idx = await leggiIndice();
    idx[pkg.slug] = { version: pkg.version, installedAt: new Date().toISOString() };
    await scriviIndice(idx);
  } catch (e) {
    throw chiaro(e);
  }
  return { version: pkg.version, inviati };
}

export async function installateBle(): Promise<StoreInstalledResponse> {
  vuoleOrion();
  let voci: { nome: string; cartella: boolean }[] = [];
  try {
    voci = await bleCondiviso.ls("/apps");
  } catch {
    /* no /apps yet */
  }
  let dati: string[] = [];
  try {
    dati = (await bleCondiviso.ls("/apps/data")).filter((v) => v.cartella).map((v) => v.nome);
  } catch {
    /* no data folder */
  }
  const idx = await leggiIndice();
  const apps = voci
    .filter((v) => !v.cartella && v.nome.toLowerCase().endsWith(".lua"))
    .map((v) => {
      const slug = v.nome.slice(0, -4);
      return { slug, version: idx[slug]?.version ?? null, hasData: dati.includes(slug) };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
  return { apps, limit: LAUNCHER_LIMIT };
}

/** A folder and everything in it: files first, then folders deepest first
 *  (DEL removes only empty folders). */
async function cancellaTutto(dir: string): Promise<void> {
  let voci;
  try {
    voci = await bleCondiviso.ls(dir);
  } catch {
    return; // not there
  }
  for (const v of voci) {
    const p = `${dir}/${v.nome}`;
    if (v.cartella) await cancellaTutto(p);
    else await bleCondiviso.cancella(p);
  }
  await bleCondiviso.cancella(dir);
}

export async function rimuoviBle(slug: string, removeData: boolean): Promise<void> {
  vuoleOrion();
  if (!SLUG_RE.test(slug)) throw new Error("Invalid app name");
  try {
    if (await bleCondiviso.stat(`/apps/${slug}.lua`)) await bleCondiviso.cancella(`/apps/${slug}.lua`);
    if (removeData) await cancellaTutto(`/apps/data/${slug}`);
    const idx = await leggiIndice();
    if (idx[slug]) {
      delete idx[slug];
      await scriviIndice(idx);
    }
  } catch (e) {
    throw chiaro(e);
  }
}
