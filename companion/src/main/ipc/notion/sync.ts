/**
 * Sync bidirezionale tra le note del device (<mount>/NOTE/, file .txt o .md) e Notion
 * (sottopagine sotto una pagina genitore scelta dall'utente).
 *
 * Stesso modello del sync Obsidian (vedi ../obsidian.ts): manifest dell'ultimo
 * sync (relKey → hash) per distinguere "nuovo da un lato" da "cancellato
 * dall'altro" e rilevare conflitti reali. Confronto hash-first. Conflitto reale
 * (entrambi i lati modificati): vince il più recente (mtime device vs
 * last_edited_time Notion), il perdente è conservato (copia .txt o sottopagina).
 *
 * Mappa filesystem ↔ Notion:
 *  - relKey = catena di nomi senza estensione, separatori "/" (es. "ideas/foo");
 *  - cartella device ↔ child_page "contenitore" (ha sottopagine);
 *  - nota .txt o .md ↔ child_page foglia (senza sottopagine), contenuto =
 *    paragrafi. Una pagina nuova da Notion nasce `.txt`: il suo testo e'
 *    piano, non Markdown. `foo.txt` e `foo.md` insieme sul dispositivo hanno
 *    la stessa chiave: la chiave si salta con un errore (vedi ../obsidian.ts).
 */

import { app } from "electron";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import type {
  NotionConflict,
  NotionSyncRequest,
  NotionSyncResponse,
} from "../../../shared/ipc-types";
import { listNotes } from "../notes";
import {
  decryptNote,
  deviceNoteBytes,
  deviceNotePath,
  isProtectedKey,
  vaultKey,
  vaultUnlocked,
} from "../../notes/vault";
import { getConnection } from "./tokenStore";
import {
  archivePage,
  createNotePage,
  ensureFolderPage,
  getPageLastEditedMs,
  getPagePlainText,
  listChildPages,
  replacePageContent,
} from "./api";

const NOTES_SUBDIR = "NOTE";

// ---------------------------------------------------------------------------
//  Helpers testo / hash / path
// ---------------------------------------------------------------------------

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function hashStr(text: string): string {
  return createHash("sha1").update(normalize(text), "utf8").digest("hex");
}

function decodeBuf(buf: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return buf.toString("latin1");
  }
}

function toKey(relPath: string): string {
  return relPath.replace(/\.[^./\\]+$/, "").split(/[/\\]/).join("/");
}

function conflictStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/** Verso il dispositivo: dentro `PRIVATE` il testo si cifra per strada. */
async function writeDeviceFile(noteRoot: string, target: string, text: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(
    target,
    deviceNoteBytes(noteRoot, target, Buffer.from(normalize(text), "utf8")),
  );
}

async function writeDeviceConflictCopy(
  noteRoot: string,
  originalPath: string,
  text: string,
): Promise<string> {
  const { dir, name, ext } = parse(originalPath);
  let candidate = join(dir, `${name} (conflict ${conflictStamp()})${ext}`);
  let i = 1;
  while (existsSync(candidate)) {
    candidate = join(dir, `${name} (conflict ${conflictStamp()} ${i})${ext}`);
    i++;
  }
  await writeFile(
    candidate,
    deviceNoteBytes(noteRoot, candidate, Buffer.from(normalize(text), "utf8")),
  );
  return candidate;
}

// ---------------------------------------------------------------------------
//  Manifest
// ---------------------------------------------------------------------------

interface Manifest {
  parentPageId: string;
  entries: Record<string, { pageId: string; hash: string; syncedAt: string }>;
}

function manifestPath(workspaceId: string): string {
  const key = createHash("sha1").update(workspaceId).digest("hex").slice(0, 16);
  return join(app.getPath("userData"), "notion", `manifest-${key}.json`);
}

async function loadManifest(
  workspaceId: string,
  parentPageId: string,
): Promise<Manifest> {
  try {
    const raw = await readFile(manifestPath(workspaceId), "utf-8");
    const m = JSON.parse(raw) as Manifest;
    // Se il genitore è cambiato, riparti da zero (sync additivo).
    if (m && m.entries && m.parentPageId === parentPageId) return m;
  } catch {
    /* mancante/corrotto → fresco */
  }
  return { parentPageId, entries: {} };
}

async function saveManifest(workspaceId: string, m: Manifest): Promise<void> {
  const p = manifestPath(workspaceId);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(m, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
//  Enumerazione dei due lati
// ---------------------------------------------------------------------------

interface DeviceNote {
  path: string;
  mtimeMs: number;
  text: string;
  hash: string;
}
interface NotionNote {
  pageId: string;
  text: string;
  hash: string;
}

async function collectDevice(
  mountPath: string,
  noteRoot: string,
  aperto: boolean,
): Promise<{ map: Map<string, DeviceNote>; doppie: Set<string> }> {
  const out = new Map<string, DeviceNote>();
  const doppie = new Set<string>();
  const viste = new Set<string>();
  const { notes } = await listNotes({ mountPath });
  for (const n of notes) {
    const protetta = n.protected || isProtectedKey(toKey(n.relPath));
    if (protetta && !aperto) continue;
    const k = toKey(n.relPath);
    if (viste.has(k)) doppie.add(k);
    viste.add(k);
    try {
      const raw = await readFile(n.devicePath);
      let text: string;
      if (protetta) {
        /* La nota protetta e' il suo testo: vedi ../obsidian.ts. */
        const chiave = vaultKey(noteRoot);
        if (!chiave) continue;
        text = decryptNote(raw, chiave);
      } else {
        text = decodeBuf(raw);
      }
      out.set(toKey(n.relPath), {
        path: n.devicePath,
        mtimeMs: Date.parse(n.mtimeIso) || 0,
        text,
        hash: hashStr(text),
      });
    } catch {
      /* skip */
    }
  }
  return { map: out, doppie };
}

/** Ritorna le note (foglie) e la mappa cartella→pageId trovate sotto rootId. */
async function collectNotion(
  rootId: string,
  aperto: boolean,
): Promise<{ notes: Map<string, NotionNote>; folders: Map<string, string> }> {
  const notes = new Map<string, NotionNote>();
  const folders = new Map<string, string>();

  async function walk(parentId: string, prefix: string): Promise<void> {
    const children = await listChildPages(parentId);
    for (const c of children) {
      const key = prefix ? `${prefix}/${c.title}` : c.title;
      /* A deposito chiuso PRIVATE non si tocca in nessun verso. */
      if (!aperto && isProtectedKey(key)) continue;
      const grand = await listChildPages(c.id);
      if (grand.length > 0) {
        folders.set(key, c.id);
        await walk(c.id, key);
      } else {
        const text = await getPagePlainText(c.id);
        notes.set(key, { pageId: c.id, text, hash: hashStr(text) });
      }
    }
  }

  await walk(rootId, "");
  return { notes, folders };
}

/** Risolve (creando se serve) il pageId del genitore per un relKey foglia. */
async function ensureParentForKey(
  rootId: string,
  key: string,
  folders: Map<string, string>,
): Promise<string> {
  const segments = key.split("/");
  segments.pop(); // l'ultimo è la nota stessa
  let parentId = rootId;
  let acc = "";
  for (const seg of segments) {
    acc = acc ? `${acc}/${seg}` : seg;
    let id = folders.get(acc);
    if (!id) {
      id = await ensureFolderPage(parentId, seg);
      folders.set(acc, id);
    }
    parentId = id;
  }
  return parentId;
}

// ---------------------------------------------------------------------------
//  Motore
// ---------------------------------------------------------------------------

export async function syncNotion(
  req: NotionSyncRequest,
): Promise<NotionSyncResponse> {
  const conn = await getConnection();
  if (!conn) throw new Error("Notion non collegato.");
  if (!conn.parentPageId) {
    throw new Error("Scegli prima una pagina genitore in Notion.");
  }
  if (!existsSync(req.mountPath)) {
    throw new Error(`Device non disponibile: ${req.mountPath}`);
  }

  const rootId = conn.parentPageId;
  const noteRoot = join(req.mountPath, NOTES_SUBDIR);
  await mkdir(noteRoot, { recursive: true });

  const manifest = await loadManifest(conn.workspaceId, rootId);
  const prev = manifest.entries;
  const next: Manifest["entries"] = {};

  const aperto = vaultUnlocked(noteRoot);
  const { map: deviceMap, doppie } = await collectDevice(req.mountPath, noteRoot, aperto);
  const { notes: notionMap, folders } = await collectNotion(rootId, aperto);

  const res: NotionSyncResponse = {
    pushed: [],
    pulled: [],
    conflicts: [],
    deletedDevice: [],
    deletedNotion: [],
    unchanged: 0,
    errors: [],
  };

  const now = () => new Date().toISOString();
  const keys = new Set<string>([...deviceMap.keys(), ...notionMap.keys()]);

  for (const key of keys) {
    if (doppie.has(key)) {
      res.errors.push({
        relKey: key,
        message: `Both "${key}.txt" and "${key}.md" are on the device: rename one of them.`,
      });
      if (prev[key]) next[key] = prev[key];
      continue;
    }
    try {
      const d = deviceMap.get(key);
      const n = notionMap.get(key);
      const p = prev[key];
      const leafTitle = key.split("/").pop() ?? key;

      if (d && n) {
        if (d.hash === n.hash) {
          res.unchanged++;
          next[key] = { pageId: n.pageId, hash: d.hash, syncedAt: now() };
          continue;
        }
        const deviceChanged = !p || p.hash !== d.hash;
        const notionChanged = !p || p.hash !== n.hash;

        if (deviceChanged && !notionChanged) {
          await replacePageContent(n.pageId, d.text);
          res.pushed.push(key);
          next[key] = { pageId: n.pageId, hash: d.hash, syncedAt: now() };
        } else if (notionChanged && !deviceChanged) {
          await writeDeviceFile(noteRoot, d.path, n.text);
          res.pulled.push(key);
          next[key] = { pageId: n.pageId, hash: n.hash, syncedAt: now() };
        } else {
          // Conflitto reale: vince il più recente.
          const notionMs = await getPageLastEditedMs(n.pageId);
          const deviceWins = d.mtimeMs >= notionMs;
          let conflict: NotionConflict;
          if (deviceWins) {
            // Preserva il contenuto Notion perdente come sottopagina sibling.
            const parentId = await ensureParentForKey(rootId, key, folders);
            const copyId = await createNotePage(
              parentId,
              `${leafTitle} (conflict ${conflictStamp()})`,
              n.text,
            );
            await replacePageContent(n.pageId, d.text);
            conflict = { relKey: key, winner: "device", conflictCopy: copyId };
            next[key] = { pageId: n.pageId, hash: d.hash, syncedAt: now() };
          } else {
            const copy = await writeDeviceConflictCopy(noteRoot, d.path, d.text);
            await writeDeviceFile(noteRoot, d.path, n.text);
            conflict = { relKey: key, winner: "notion", conflictCopy: copy };
            next[key] = { pageId: n.pageId, hash: n.hash, syncedAt: now() };
          }
          res.conflicts.push(conflict);
        }
      } else if (d && !n) {
        if (p) {
          // Archiviata in Notion → cancella sul device.
          await rm(d.path, { force: true });
          res.deletedDevice.push(key);
        } else {
          // Nuova sul device → crea in Notion.
          const parentId = await ensureParentForKey(rootId, key, folders);
          const pageId = await createNotePage(parentId, leafTitle, d.text);
          res.pushed.push(key);
          next[key] = { pageId, hash: d.hash, syncedAt: now() };
        }
      } else if (!d && n) {
        if (p) {
          // Cancellata sul device → archivia in Notion.
          await archivePage(n.pageId);
          res.deletedNotion.push(key);
        } else {
          // Nuova in Notion → crea sul device.
          await writeDeviceFile(noteRoot, deviceNotePath(noteRoot, key), n.text);
          res.pulled.push(key);
          next[key] = { pageId: n.pageId, hash: n.hash, syncedAt: now() };
        }
      }
    } catch (e) {
      res.errors.push({
        relKey: key,
        message: e instanceof Error ? e.message : String(e),
      });
      if (prev[key]) next[key] = prev[key];
    }
  }

  /* A deposito chiuso le righe delle note protette passano avanti intatte:
     vedi ../obsidian.ts. */
  if (!aperto) {
    for (const [key, e] of Object.entries(prev)) {
      if (isProtectedKey(key) && !next[key]) next[key] = e;
    }
  }

  manifest.entries = next;
  await saveManifest(conn.workspaceId, manifest);
  return res;
}
