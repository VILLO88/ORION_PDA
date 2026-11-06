/**
 * File manager IPC — operazioni filesystem sul device Orion.
 *
 * Tutte le operazioni richiedono che il path target sia DENTRO il mount
 * point di un device Orion attualmente connesso. Validazione fatta qui
 * (no traversal arbitrario sull'host).
 *
 *  - list   : readdir + stat per popolare le righe della UI
 *  - del    : rm ricorsivo (file o directory). Refuso del marker .orion-device
 *  - upload : copy del file locale dentro la dstDir; rinomina con suffisso
 *             " (N)" se uniqueOnConflict
 *  - mkdir  : crea directory dentro parent
 *  - rename : rename atomico (o move se dst su stesso fs)
 */

import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, parse, relative, resolve } from "node:path";
import type {
  FilesCopyRequest,
  FilesCopyResponse,
  FilesDeleteRequest,
  FilesEntry,
  FilesListRequest,
  FilesListResponse,
  FilesMkdirRequest,
  FilesMkdirResponse,
  FilesMoveRequest,
  FilesMoveResponse,
  FilesRenameRequest,
  FilesUploadRequest,
  FilesUploadResponse,
} from "../../shared/ipc-types";
import { listOrionDevices, MARKER_FILENAME } from "./device";

// ---------------------------------------------------------------------------
//  Safety: ogni path deve essere dentro un mount Orion connesso
// ---------------------------------------------------------------------------

async function knownMounts(): Promise<string[]> {
  const r = await listOrionDevices();
  return r.devices.map((d) => normalize(d.mountPath));
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function assertInsideKnownMount(p: string): Promise<void> {
  if (!isAbsolute(p)) {
    throw new Error(`Path non assoluto: ${p}`);
  }
  const norm = normalize(p);
  const mounts = await knownMounts();
  if (!mounts.some((m) => isInside(norm, m))) {
    throw new Error(
      `Operazione rifiutata: "${p}" non è dentro un device Orion connesso.`,
    );
  }
}

function isMarkerFile(p: string): boolean {
  return basename(p) === MARKER_FILENAME;
}

// ---------------------------------------------------------------------------
//  list
// ---------------------------------------------------------------------------

export async function listFiles(
  req: FilesListRequest,
): Promise<FilesListResponse> {
  await assertInsideKnownMount(req.path);
  const dirents = await readdir(req.path, { withFileTypes: true });
  const entries: FilesEntry[] = [];
  for (const d of dirents) {
    if (d.name.startsWith(".")) continue; // hidden / system
    const full = join(req.path, d.name);
    try {
      const s = await stat(full);
      entries.push({
        name: d.name,
        path: full,
        isDirectory: d.isDirectory(),
        size: d.isDirectory() ? 0 : s.size,
        mtimeIso: s.mtime.toISOString(),
      });
    } catch {
      // ignored
    }
  }
  // Cartelle prima, poi file, ordine alfabetico
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { entries };
}

// ---------------------------------------------------------------------------
//  delete (ricorsivo)
// ---------------------------------------------------------------------------

export async function deleteFile(req: FilesDeleteRequest): Promise<void> {
  await assertInsideKnownMount(req.path);
  if (isMarkerFile(req.path)) {
    throw new Error(`Non puoi cancellare il marker ${MARKER_FILENAME}.`);
  }
  // Refuso di cancellare il mount stesso
  const mounts = await knownMounts();
  if (mounts.some((m) => normalize(req.path) === m)) {
    throw new Error("Non puoi cancellare la root del device.");
  }
  await rm(req.path, { recursive: true, force: false });
}

// ---------------------------------------------------------------------------
//  upload (copia file PC → device)
// ---------------------------------------------------------------------------

function buildUniquePath(dst: string): string {
  if (!existsSync(dst)) return dst;
  const { dir, name, ext } = parse(dst);
  let i = 1;
  while (existsSync(join(dir, `${name} (${i})${ext}`))) i++;
  return join(dir, `${name} (${i})${ext}`);
}

export async function uploadFile(
  req: FilesUploadRequest,
): Promise<FilesUploadResponse> {
  await assertInsideKnownMount(req.dstDir);
  if (!existsSync(req.sourcePath)) {
    throw new Error(`Sorgente inesistente: ${req.sourcePath}`);
  }
  const targetInitial = join(req.dstDir, basename(req.sourcePath));
  const target = req.uniqueOnConflict
    ? buildUniquePath(targetInitial)
    : targetInitial;
  await copyFile(req.sourcePath, target);
  const s = await stat(target);
  return { writtenPath: target, bytes: s.size };
}

// ---------------------------------------------------------------------------
//  mkdir
// ---------------------------------------------------------------------------

export async function makeDirectory(
  req: FilesMkdirRequest,
): Promise<FilesMkdirResponse> {
  await assertInsideKnownMount(req.parent);
  const cleanName = req.name.trim();
  if (!cleanName || /[/\\]/.test(cleanName) || cleanName === "." || cleanName === "..") {
    throw new Error(`Nome cartella non valido: "${req.name}"`);
  }
  const target = resolve(req.parent, cleanName);
  await assertInsideKnownMount(target);
  await mkdir(target, { recursive: false });
  return { path: target };
}

// ---------------------------------------------------------------------------
//  rename / move
// ---------------------------------------------------------------------------

export async function renameFile(req: FilesRenameRequest): Promise<void> {
  await assertInsideKnownMount(req.from);
  await assertInsideKnownMount(req.to);
  if (isMarkerFile(req.from)) {
    throw new Error(`Non puoi rinominare ${MARKER_FILENAME}.`);
  }
  // Crea il parent del destinatario se manca
  await mkdir(dirname(req.to), { recursive: true });
  await rename(req.from, req.to);
}

// ---------------------------------------------------------------------------
//  copy (ricorsivo file o directory)
// ---------------------------------------------------------------------------

async function copyRecursive(src: string, dst: string): Promise<void> {
  const s = await stat(src);
  if (s.isDirectory()) {
    await mkdir(dst, { recursive: true });
    const entries = await readdir(src, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      await copyRecursive(join(src, e.name), join(dst, e.name));
    }
  } else {
    await copyFile(src, dst);
  }
}

export async function copyEntry(
  req: FilesCopyRequest,
): Promise<FilesCopyResponse> {
  await assertInsideKnownMount(req.sourcePath);
  await assertInsideKnownMount(req.dstDir);
  if (isMarkerFile(req.sourcePath)) {
    throw new Error(`Non puoi copiare ${MARKER_FILENAME}.`);
  }
  // Refuso di copiare dentro se stesso (loop infinito su directory)
  const dstInitial = join(req.dstDir, basename(req.sourcePath));
  if (
    dstInitial === req.sourcePath ||
    isInside(dstInitial, normalize(req.sourcePath))
  ) {
    throw new Error("Cannot copy a folder into itself.");
  }
  const target = req.uniqueOnConflict
    ? buildUniquePath(dstInitial)
    : dstInitial;
  await copyRecursive(req.sourcePath, target);
  return { writtenPath: target };
}

// ---------------------------------------------------------------------------
//  move (rename con resolve di basename e parent target)
// ---------------------------------------------------------------------------

export async function moveEntry(
  req: FilesMoveRequest,
): Promise<FilesMoveResponse> {
  await assertInsideKnownMount(req.sourcePath);
  await assertInsideKnownMount(req.dstDir);
  if (isMarkerFile(req.sourcePath)) {
    throw new Error(`Non puoi spostare ${MARKER_FILENAME}.`);
  }
  const dstInitial = join(req.dstDir, basename(req.sourcePath));
  if (dstInitial === req.sourcePath) {
    // Stesso posto, no-op
    return { writtenPath: req.sourcePath };
  }
  if (isInside(dstInitial, normalize(req.sourcePath))) {
    throw new Error("Cannot move a folder into itself.");
  }
  const target = req.uniqueOnConflict
    ? buildUniquePath(dstInitial)
    : dstInitial;
  await mkdir(dirname(target), { recursive: true });
  await rename(req.sourcePath, target);
  return { writtenPath: target };
}
