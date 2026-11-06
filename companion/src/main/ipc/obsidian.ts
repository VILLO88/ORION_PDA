/**
 * Sincronizzazione bidirezionale tra le note del device (<mount>/NOTE/, file
 * .txt) e una vault di Obsidian (cartella di file .md scelta dall'utente).
 *
 * Modello:
 *  - Una "nota" è identificata dalla sua `relKey` = path relativo SENZA
 *    estensione, con separatori "/" (es. device `ideas/foo.txt` e vault
 *    `ideas/foo.md` condividono la key `ideas/foo`). La gerarchia di cartelle
 *    è quindi mirrorata su entrambi i lati.
 *  - Solo cambio estensione: il contenuto è copiato byte-per-byte, nessuna
 *    trasformazione (no frontmatter).
 *
 * Bidirezionalità sicura via manifest:
 *  - Salviamo in <userData>/obsidian-sync/<key>.json lo snapshot dell'ultimo
 *    sync (relKey -> hash). Serve a distinguere "nuovo da un lato" da
 *    "cancellato dall'altro" e a rilevare conflitti reali.
 *  - Il PRIMO sync ha manifest vuoto => puramente additivo (merge), nessuna
 *    cancellazione: zero rischio di perdita dati.
 *  - Confronto hash-first: se i contenuti sono identici non c'è azione, il che
 *    evita falsi conflitti dovuti alla granularità mtime ~2s di FAT.
 *  - Conflitto reale (entrambi i lati modificati dall'ultimo sync): vince
 *    l'mtime più recente, il perdente viene conservato come copia `(conflict …)`.
 */

import { app, dialog } from "electron";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative } from "node:path";
import type {
  ObsidianConflict,
  ObsidianPickVaultResponse,
  ObsidianSyncRequest,
  ObsidianSyncResponse,
} from "../../shared/ipc-types";
import { listNotes } from "./notes";
import {
  decryptNote,
  deviceNoteBytes,
  deviceNotePath,
  isProtectedKey,
  vaultKey,
  vaultUnlocked,
} from "../notes/vault";

const NOTES_SUBDIR = "NOTE";

// ---------------------------------------------------------------------------
//  Folder picker
// ---------------------------------------------------------------------------

export async function pickVault(): Promise<ObsidianPickVaultResponse> {
  const r = await dialog.showOpenDialog({
    title: "Choose Obsidian vault folder",
    properties: ["openDirectory", "createDirectory"],
  });
  if (r.canceled || r.filePaths.length === 0) return { path: null };
  return { path: r.filePaths[0] };
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

interface SideFile {
  path: string;
  mtimeMs: number;
  buf: Buffer;
  hash: string;
}

function hashBuf(buf: Buffer): string {
  return createHash("sha1").update(buf).digest("hex");
}

/** relPath (es. "ideas/foo.txt") -> relKey ("ideas/foo"), separatori "/". */
function toKey(relPath: string): string {
  const noExt = relPath.replace(/\.[^./\\]+$/, "");
  return noExt.split(/[/\\]/).join("/");
}

function vaultPathFor(vaultRoot: string, key: string): string {
  return join(vaultRoot, ...key.split("/")) + ".md";
}

async function writeFileEnsured(target: string, buf: Buffer): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, buf);
}

/** Verso il dispositivo: dentro `PRIVATE` il testo si cifra per strada. */
async function writeDevice(noteRoot: string, target: string, testo: Buffer): Promise<void> {
  await writeFileEnsured(target, deviceNoteBytes(noteRoot, target, testo));
}

function conflictStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/** Conserva `buf` accanto a `originalPath` come copia "(conflict …)". */
async function writeConflictCopy(
  originalPath: string,
  buf: Buffer,
  noteRoot?: string, // dato quando la copia va sul dispositivo
): Promise<string> {
  const { dir, name, ext } = parse(originalPath);
  const stamp = conflictStamp();
  let candidate = join(dir, `${name} (conflict ${stamp})${ext}`);
  let i = 1;
  while (existsSync(candidate)) {
    candidate = join(dir, `${name} (conflict ${stamp} ${i})${ext}`);
    i++;
  }
  await writeFile(candidate, noteRoot ? deviceNoteBytes(noteRoot, candidate, buf) : buf);
  return candidate;
}

// ---------------------------------------------------------------------------
//  Manifest (snapshot dell'ultimo sync)
// ---------------------------------------------------------------------------

interface Manifest {
  vaultPath: string;
  entries: Record<string, { hash: string; syncedAt: string }>;
}

function manifestPath(vaultPath: string): string {
  const key = createHash("sha1").update(vaultPath).digest("hex").slice(0, 16);
  return join(app.getPath("userData"), "obsidian-sync", `${key}.json`);
}

async function loadManifest(vaultPath: string): Promise<Manifest> {
  try {
    const raw = await readFile(manifestPath(vaultPath), "utf-8");
    const m = JSON.parse(raw) as Manifest;
    if (m && typeof m === "object" && m.entries) {
      return { vaultPath, entries: m.entries };
    }
  } catch {
    // mancante o corrotto -> manifest fresco (sync additivo)
  }
  return { vaultPath, entries: {} };
}

async function saveManifest(m: Manifest): Promise<void> {
  const p = manifestPath(m.vaultPath);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(m, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
//  Enumerazione dei due lati
// ---------------------------------------------------------------------------

async function collectDevice(
  mountPath: string,
  noteRoot: string,
  aperto: boolean,
): Promise<Map<string, SideFile>> {
  const out = new Map<string, SideFile>();
  const { notes } = await listNotes({ mountPath });
  for (const n of notes) {
    const protetta = n.protected || isProtectedKey(toKey(n.relPath));
    if (protetta && !aperto) continue;
    try {
      let buf = await readFile(n.devicePath);
      if (protetta) {
        /* Da qui in poi la nota protetta e' il suo TESTO: e' quello che si
           confronta e che va nella vault. Il file cifrato cambia a ogni
           salvataggio (nonce nuovo) e come hash non varrebbe niente. */
        const chiave = vaultKey(noteRoot);
        if (!chiave) continue;
        buf = Buffer.from(decryptNote(buf, chiave), "utf8");
      }
      out.set(toKey(n.relPath), {
        path: n.devicePath,
        mtimeMs: Date.parse(n.mtimeIso) || 0,
        buf,
        hash: hashBuf(buf),
      });
    } catch {
      // file sparito tra list e read: skip
    }
  }
  return out;
}

async function collectVault(
  vaultRoot: string,
  aperto: boolean,
): Promise<Map<string, SideFile>> {
  const out = new Map<string, SideFile>();
  async function rec(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      // Salta dotfiles e cartelle di config Obsidian (.obsidian, .trash, …).
      if (e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await rec(full);
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
        try {
          const buf = await readFile(full);
          const s = await stat(full);
          const chiave = toKey(relative(vaultRoot, full));
          /* A deposito chiuso PRIVATE non si tocca in nessun verso. */
          if (!aperto && isProtectedKey(chiave)) continue;
          out.set(chiave, {
            path: full,
            mtimeMs: s.mtimeMs,
            buf,
            hash: hashBuf(buf),
          });
        } catch {
          // skip
        }
      }
    }
  }
  await rec(vaultRoot);
  return out;
}

// ---------------------------------------------------------------------------
//  Motore di sync
// ---------------------------------------------------------------------------

export async function syncObsidian(
  req: ObsidianSyncRequest,
): Promise<ObsidianSyncResponse> {
  const { mountPath, vaultPath } = req;
  if (!vaultPath || !isAbsolute(vaultPath)) {
    throw new Error("Vault path non valido (deve essere assoluto).");
  }
  if (!existsSync(vaultPath)) {
    throw new Error(`La cartella vault non esiste: ${vaultPath}`);
  }
  if (!mountPath || !existsSync(mountPath)) {
    throw new Error(`Device non disponibile: ${mountPath}`);
  }

  const noteRoot = join(mountPath, NOTES_SUBDIR);
  // Garantisce NOTE/ per i pull (vault -> device) anche se il device non ne ha.
  await mkdir(noteRoot, { recursive: true });

  const manifest = await loadManifest(vaultPath);
  const prev = manifest.entries;
  const nextEntries: Manifest["entries"] = {};

  const aperto = vaultUnlocked(noteRoot);
  const [deviceMap, vaultMap] = await Promise.all([
    collectDevice(mountPath, noteRoot, aperto),
    collectVault(vaultPath, aperto),
  ]);

  const res: ObsidianSyncResponse = {
    pushed: [],
    pulled: [],
    conflicts: [],
    deletedDevice: [],
    deletedVault: [],
    unchanged: 0,
    errors: [],
  };

  const now = () => new Date().toISOString();
  const keys = new Set<string>([...deviceMap.keys(), ...vaultMap.keys()]);

  for (const key of keys) {
    try {
      const d = deviceMap.get(key);
      const v = vaultMap.get(key);
      const p = prev[key];

      if (d && v) {
        // Presente su entrambi i lati.
        if (d.hash === v.hash) {
          res.unchanged++;
          nextEntries[key] = { hash: d.hash, syncedAt: now() };
          continue;
        }
        const deviceChanged = !p || p.hash !== d.hash;
        const vaultChanged = !p || p.hash !== v.hash;

        if (deviceChanged && !vaultChanged) {
          await writeFileEnsured(v.path, d.buf);
          res.pushed.push(key);
          nextEntries[key] = { hash: d.hash, syncedAt: now() };
        } else if (vaultChanged && !deviceChanged) {
          await writeDevice(noteRoot, d.path, v.buf);
          res.pulled.push(key);
          nextEntries[key] = { hash: v.hash, syncedAt: now() };
        } else {
          // Conflitto reale: entrambi modificati (o nessuno snapshot). Vince mtime.
          const deviceWins = d.mtimeMs >= v.mtimeMs;
          const conflict: ObsidianConflict = deviceWins
            ? {
                relKey: key,
                winner: "device",
                conflictCopy: await writeConflictCopy(v.path, v.buf),
              }
            : {
                relKey: key,
                winner: "vault",
                conflictCopy: await writeConflictCopy(d.path, d.buf, noteRoot),
              };
          if (deviceWins) {
            await writeFileEnsured(v.path, d.buf);
            nextEntries[key] = { hash: d.hash, syncedAt: now() };
          } else {
            await writeDevice(noteRoot, d.path, v.buf);
            nextEntries[key] = { hash: v.hash, syncedAt: now() };
          }
          res.conflicts.push(conflict);
        }
      } else if (d && !v) {
        // Solo sul device.
        if (p) {
          // Era sincronizzato, ora rimosso dalla vault -> cancella sul device.
          await rm(d.path, { force: true });
          res.deletedDevice.push(key);
        } else {
          // Nuovo sul device -> crea .md in vault.
          await writeFileEnsured(vaultPathFor(vaultPath, key), d.buf);
          res.pushed.push(key);
          nextEntries[key] = { hash: d.hash, syncedAt: now() };
        }
      } else if (!d && v) {
        // Solo in vault.
        if (p) {
          await rm(v.path, { force: true });
          res.deletedVault.push(key);
        } else {
          await writeDevice(noteRoot, deviceNotePath(noteRoot, key), v.buf);
          res.pulled.push(key);
          nextEntries[key] = { hash: v.hash, syncedAt: now() };
        }
      }
    } catch (e) {
      res.errors.push({
        relKey: key,
        message: e instanceof Error ? e.message : String(e),
      });
      // Conserva lo stato precedente per non perdere il riferimento al prossimo sync.
      if (prev[key]) nextEntries[key] = prev[key];
    }
  }

  /* A deposito chiuso le note protette non sono state nemmeno guardate:
     le loro righe passano avanti com'erano. Senza, al prossimo sync a
     deposito aperto sembrerebbero tutte nuove da due lati, cioe' conflitti. */
  if (!aperto) {
    for (const [key, e] of Object.entries(prev)) {
      if (isProtectedKey(key) && !nextEntries[key]) nextEntries[key] = e;
    }
  }

  manifest.entries = nextEntries;
  await saveManifest(manifest);
  return res;
}
