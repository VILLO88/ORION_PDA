/**
 * Il lato "disco del PC" del Bluetooth.
 *
 * Web Bluetooth vive nel renderer, quindi a parlare con ORION è la finestra.
 * Ma tutto ciò che la Companion sa fare con le note — l'albero, le note
 * protette, il backup, i sync con Obsidian e Notion — è scritto nel main e
 * lavora su una cartella: `<mount>/NOTE`.
 *
 * Invece di riscriverlo due volte, senza cavo gli si dà una cartella vera:
 * **lo specchio**, una copia di `/NOTE` tenuta in `userData/ble-mirror`. La
 * finestra la riempie leggendo dal dispositivo (`pull`) e, dopo ogni
 * modifica, riporta sul dispositivo le differenze (`push`): vedi
 * `renderer/src/lib/bleNote.ts`. Qui ci sono solo i mattoni: elencare lo
 * specchio, scriverci, e ricordare **la fotografia** di com'era il
 * dispositivo l'ultima volta che lo si è visto.
 *
 * ⚠️ La fotografia è ciò che distingue "nuovo nello specchio" (da mandare)
 * da "sparito dal dispositivo" (da togliere). Senza, ogni differenza sarebbe
 * ambigua — ed è lo stesso motivo per cui i sync hanno un manifest.
 */

import { app } from "electron";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type {
  BleMirrorState,
  BleSnapshot,
} from "../../shared/ipc-types";

const NOTES_SUBDIR = "NOTE";
/* Il deposito (firmware fino al 10/10/2026) e la sua sigla (da li' in poi):
   vedi notes/vault.ts. */
const VAULT_FILES = [".orion_vault", ".orion_vault_id"];
const SNAPSHOT_FILE = "snapshot.json";

/** La radice dello specchio: fa da `mountPath` per tutto il codice delle note. */
export function bleMirrorRoot(): string {
  return join(app.getPath("userData"), "ble-mirror");
}

function noteRoot(): string {
  return join(bleMirrorRoot(), NOTES_SUBDIR);
}

/** `rel` è relativo a NOTE, con "/" come separatore. Niente uscite. */
function assoluto(rel: string): string {
  const pezzi = rel.split("/").filter((p) => p.length > 0);
  if (pezzi.length === 0 || pezzi.some((p) => p === "." || p === "..")) {
    throw new Error(`Percorso non valido nello specchio: "${rel}"`);
  }
  const p = resolve(noteRoot(), ...pezzi);
  if (!p.startsWith(noteRoot() + sep)) {
    throw new Error(`Percorso fuori dallo specchio: "${rel}"`);
  }
  return p;
}

let tabella: Uint32Array | null = null;

/** CRC32 come zlib: lo stesso di `crc32_agg()` nel firmware. */
function crc32(dati: Uint8Array): number {
  if (!tabella) {
    tabella = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      tabella[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < dati.length; i++) crc = tabella[(crc ^ dati[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Ciò che dello specchio viaggia: le note, e il deposito delle protette. */
function eNota(nome: string): boolean {
  const n = nome.toLowerCase();
  /* `.md` dal firmware del 25/11/2026. La bozza di una `.md` sul
     dispositivo e' `nome.md.tmp`: finisce in `.tmp`, quindi resta fuori. */
  return n.endsWith(".txt") || n.endsWith(".md") || n.endsWith(".enc");
}

async function leggiFotografia(): Promise<BleSnapshot | null> {
  try {
    const s = JSON.parse(
      await readFile(join(bleMirrorRoot(), SNAPSHOT_FILE), "utf-8"),
    ) as BleSnapshot;
    if (s && s.files && Array.isArray(s.dirs)) return s;
  } catch {
    /* mai fatta, o rovinata: come la prima volta */
  }
  return null;
}

export async function bleMirrorState(): Promise<BleMirrorState> {
  const radice = noteRoot();
  await mkdir(radice, { recursive: true });
  const files: BleMirrorState["files"] = [];
  const dirs: string[] = [];

  const visita = async (dir: string, rel: string): Promise<void> => {
    for (const v of await readdir(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${v.name}` : v.name;
      const full = join(dir, v.name);
      if (v.isDirectory()) {
        if (v.name.startsWith(".")) continue;
        dirs.push(r);
        await visita(full, r);
      } else if (v.isFile() && (eNota(v.name) || (rel === "" && VAULT_FILES.includes(v.name)))) {
        const dati = await readFile(full);
        files.push({ rel: r, size: dati.length, crc: crc32(dati) });
      }
    }
  };
  await visita(radice, "");
  return { root: bleMirrorRoot(), files, dirs, snapshot: await leggiFotografia() };
}

export async function bleMirrorWrite(req: { rel: string; dati: Uint8Array }): Promise<void> {
  const p = assoluto(req.rel);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, Buffer.from(req.dati));
}

export async function bleMirrorRead(req: { rel: string }): Promise<Uint8Array> {
  return new Uint8Array(await readFile(assoluto(req.rel)));
}

export async function bleMirrorDelete(req: { rel: string }): Promise<void> {
  await rm(assoluto(req.rel), { recursive: true, force: true });
}

export async function bleMirrorMkdir(req: { rel: string }): Promise<void> {
  await mkdir(assoluto(req.rel), { recursive: true });
}

export async function bleMirrorSaveSnapshot(s: BleSnapshot): Promise<void> {
  await mkdir(bleMirrorRoot(), { recursive: true });
  await writeFile(join(bleMirrorRoot(), SNAPSHOT_FILE), JSON.stringify(s), "utf-8");
}

/** I byte di un file del PC, per mandarli via radio. */
export async function bleReadLocal(req: {
  path: string;
}): Promise<{ nome: string; dati: Uint8Array }> {
  const st = await stat(req.path);
  if (!st.isFile()) throw new Error(`Not a file: ${req.path}`);
  return { nome: basename(req.path), dati: new Uint8Array(await readFile(req.path)) };
}

/** Una cartella temporanea, per ciò che si converte solo per mandarlo. */
export async function bleTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "orion-ble-"));
}

/** true se lo specchio esiste: allora vale come "mount" per le note. */
export function bleMirrorEsiste(): boolean {
  return existsSync(noteRoot());
}
