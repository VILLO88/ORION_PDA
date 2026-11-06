/**
 * Note sync + folder management.
 *
 * Le note vivono sotto `<mountPath>/NOTE/` (UPPERCASE come da firmware).
 * Il firmware adesso le organizza in sottocartelle: il companion gestisce
 * l'albero (CRUD su folder + .txt) e il backup PC ← device mirrora la
 * gerarchia.
 *
 * Safety model:
 *  - Tutte le ops di scrittura (mkdir/rename/del/copy/move) richiedono che
 *    sorgente e destinazione siano dentro `<mount>/NOTE/`, con `mount`
 *    appartenente a un device Orion connesso. Nessun path arbitrario
 *    sull'host.
 *  - Sui file accettiamo solo `.txt`. Sulle cartelle nessun filtro di
 *    estensione (sono solo nomi).
 *
 * ⚠️ **La categoria protetta** (9 ottobre 2026). Dentro `NOTE/PRIVATE` le note
 * sono `.enc`, cifrate dal dispositivo (vedi `../notes/vault.ts`). Tre regole
 * che discendono da cosa fa il firmware, e non sono gusti:
 *  - **a deposito chiuso `PRIVATE` risulta vuota**, come sul dispositivo:
 *    niente titoli, niente conteggio;
 *  - **una nota non passa da una zona all'altra**: un `.txt` messo in
 *    `PRIVATE` il dispositivo non lo elenca, e un `.enc` fuori nemmeno.
 *    Copiare e spostare fra le due zone viene rifiutato, dicendolo;
 *  - **`PRIVATE` non si rinomina**: è dal nome che il firmware la riconosce.
 */

import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  resolve,
} from "node:path";
import type {
  NoteBackupAllRequest,
  NoteBackupAllResponse,
  NoteBackupRequest,
  NoteBackupResponse,
  NoteCopyRequest,
  NoteCopyResponse,
  NoteDefaultsResponse,
  NoteDeleteRequest,
  NoteFile,
  NoteListRequest,
  NoteListResponse,
  NoteMkdirRequest,
  NoteMkdirResponse,
  NoteMoveRequest,
  NoteMoveResponse,
  NoteReadRequest,
  NoteReadResponse,
  NoteRenameRequest,
  NoteRenameResponse,
  NoteTreeFolder,
  NoteTreeNode,
  NoteTreeRequest,
  NoteTreeResponse,
  NoteVaultExport,
  NoteVaultImportRequest,
  NoteVaultRequest,
  NoteVaultStatus,
  NoteVaultUnlockRequest,
} from "../../shared/ipc-types";
import { listOrionDevices } from "./device";
import { bleMirrorEsiste, bleMirrorRoot } from "./bleLocal";
import {
  decryptNote,
  isProtectedPath,
  isProtectedRoot,
  PROTECTED_DIR,
  PROTECTED_EXT,
  VAULT_FILE,
  vaultExists,
  vaultExport,
  vaultImport,
  vaultKey,
  vaultLock,
  vaultPath,
  vaultSource,
  vaultUnlock,
  vaultUnlocked,
} from "../notes/vault";

const NOTES_SUBDIR = "NOTE";
const ALLOWED_EXT = ".txt";

// ---------------------------------------------------------------------------
//  Safety helpers (scoped to <mount>/NOTE/)
// ---------------------------------------------------------------------------

async function knownMounts(): Promise<string[]> {
  const r = await listOrionDevices();
  const m = r.devices.map((d) => normalize(d.mountPath));
  /* Senza cavo le note stanno nello specchio Bluetooth, che per questo
     codice è un mount come un altro: vedi `./bleLocal.ts`. */
  if (bleMirrorEsiste()) m.push(normalize(bleMirrorRoot()));
  return m;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Risolve il `<mount>/NOTE/` che contiene `p`, oppure throw. */
async function assertInsideNoteDir(p: string): Promise<string> {
  if (!isAbsolute(p)) throw new Error(`Path non assoluto: ${p}`);
  const norm = normalize(p);
  const mounts = await knownMounts();
  for (const m of mounts) {
    const noteRoot = normalize(join(m, NOTES_SUBDIR));
    if (isInside(norm, noteRoot)) return noteRoot;
  }
  throw new Error(`Operazione rifiutata: "${p}" non è dentro <mount>/NOTE/.`);
}

function assertValidName(name: string): string {
  const clean = name.trim();
  if (!clean || /[/\\]/.test(clean) || clean === "." || clean === "..") {
    throw new Error(`Nome non valido: "${name}"`);
  }
  return clean;
}

// ---------------------------------------------------------------------------
//  Defaults
// ---------------------------------------------------------------------------

export function defaultBackupDir(): string {
  // ~/Documents/Orion/notes/ su mac/linux; %USERPROFILE%\Documents\Orion\notes su Win.
  const docs = platform() === "win32"
    ? join(homedir(), "Documents")
    : join(homedir(), "Documents");
  return join(docs, "Orion", "notes");
}

export async function getDefaults(): Promise<NoteDefaultsResponse> {
  return { defaultBackupDir: defaultBackupDir() };
}

// ---------------------------------------------------------------------------
//  Tree (ricorsivo)
// ---------------------------------------------------------------------------

async function buildTree(absDir: string, noteRoot: string): Promise<NoteTreeFolder> {
  const name = absDir === noteRoot ? "" : basename(absDir);
  const rel = absDir === noteRoot ? "" : relative(noteRoot, absDir);
  const protetta = isProtectedPath(noteRoot, absDir);
  const ext = protetta ? PROTECTED_EXT : ALLOWED_EXT;
  const folder: NoteTreeFolder = {
    kind: "folder",
    name,
    path: absDir,
    relPath: rel,
    children: [],
  };
  if (protetta) {
    folder.protected = true;
    folder.locked = !vaultUnlocked(noteRoot);
    /* Chiusa, non si guarda nemmeno dentro: né titoli né quante sono. */
    if (folder.locked) return folder;
  }
  let dirents;
  try {
    dirents = await readdir(absDir, { withFileTypes: true });
  } catch {
    return folder;
  }
  for (const d of dirents) {
    if (d.name.startsWith(".")) continue;
    const full = join(absDir, d.name);
    try {
      if (d.isDirectory()) {
        folder.children.push(await buildTree(full, noteRoot));
      } else if (d.isFile() && extname(d.name).toLowerCase() === ext) {
        const s = await stat(full);
        folder.children.push({
          kind: "file",
          name: d.name,
          path: full,
          relPath: relative(noteRoot, full),
          size: s.size,
          mtimeIso: s.mtime.toISOString(),
          ...(protetta ? { protected: true } : {}),
        });
      }
    } catch {
      // entry sparita tra readdir e stat: skip
    }
  }
  // Cartelle prima dei file, ordine alfabetico stabile.
  folder.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return folder;
}

export async function treeNotes(req: NoteTreeRequest): Promise<NoteTreeResponse> {
  const noteRoot = join(req.mountPath, NOTES_SUBDIR);
  // Se NOTE/ non esiste ancora, ritorna un root vuoto (l'utente può crearla).
  if (!existsSync(noteRoot)) {
    return {
      root: { kind: "folder", name: "", path: noteRoot, relPath: "", children: [] },
    };
  }
  return { root: await buildTree(noteRoot, noteRoot) };
}

// ---------------------------------------------------------------------------
//  List (ricorsivo) — mantenuto per compatibilità (Home / activity / backup all)
// ---------------------------------------------------------------------------

function flattenFiles(node: NoteTreeNode, out: NoteFile[]): void {
  if (node.kind === "file") {
    out.push({
      name: node.name,
      size: node.size,
      mtimeIso: node.mtimeIso,
      devicePath: node.path,
      relPath: node.relPath,
      ...(node.protected ? { protected: true } : {}),
    });
    return;
  }
  for (const c of node.children) flattenFiles(c, out);
}

export async function listNotes(req: NoteListRequest): Promise<NoteListResponse> {
  const { root } = await treeNotes({ mountPath: req.mountPath });
  const out: NoteFile[] = [];
  flattenFiles(root, out);
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { notes: out };
}

// ---------------------------------------------------------------------------
//  Read
// ---------------------------------------------------------------------------

export async function readNote(req: NoteReadRequest): Promise<NoteReadResponse> {
  const safePath = resolve(req.devicePath);
  const noteRoot = await assertInsideNoteDir(safePath);
  const ext = extname(safePath).toLowerCase();
  if (ext === PROTECTED_EXT && isProtectedPath(noteRoot, safePath)) {
    const chiave = vaultKey(noteRoot);
    if (!chiave) throw new Error("PRIVATE is locked: unlock it first.");
    return { content: decryptNote(await readFile(safePath), chiave), fallbackEncoding: false };
  }
  if (ext !== ALLOWED_EXT) {
    throw new Error("Refused: only .txt notes are allowed");
  }
  const buf = await readFile(safePath);
  try {
    const utf8 = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return { content: utf8, fallbackEncoding: false };
  } catch {
    return { content: buf.toString("latin1"), fallbackEncoding: true };
  }
}

// ---------------------------------------------------------------------------
//  Backup (mirror della gerarchia)
// ---------------------------------------------------------------------------

async function ensureDir(p: string): Promise<void> {
  if (!existsSync(p)) await mkdir(p, { recursive: true });
}

/** Restituisce un path di destinazione non esistente. */
function uniqueTargetPath(absPath: string): string {
  if (!existsSync(absPath)) return absPath;
  const { dir, name, ext } = parse(absPath);
  let i = 1;
  while (existsSync(join(dir, `${name} (${i})${ext}`))) i++;
  return join(dir, `${name} (${i})${ext}`);
}

/**
 * ⚠️ Il backup di una nota protetta dipende dallo stato del deposito:
 *  - **aperto**: va **in chiaro**, come `.txt` (`copiaNota`). Lo ha chiesto
 *    l'utente: un backup che si apre solo con il dispositivo in mano e la
 *    sua password serve a poco, e sbloccare è il consenso;
 *  - **chiuso**: va **così com'è, cifrata** — per copiare un file cifrato la
 *    chiave non serve. E una nota cifrata senza il suo deposito non si apre
 *    più: per questo il deposito viene copiato insieme (`salvaDeposito`).
 */
async function salvaDeposito(noteRoot: string, targetRoot: string): Promise<string | null> {
  /* Da dove viene: la copia della Companion, o il file sulla card di un
     firmware di prima. Nel backup ha sempre lo stesso nome. */
  const origine = vaultPath(noteRoot);
  if (!origine) return null;
  const dati = await readFile(origine);
  const dest = join(targetRoot, VAULT_FILE);
  /* Lo stesso deposito non si ricopia. Uno DIVERSO non sovrascrive quello
     di prima: le note cifrate con il vecchio servono ancora quello. */
  if (existsSync(dest) && (await readFile(dest)).equals(dati)) return dest;
  await ensureDir(targetRoot);
  const finale = uniqueTargetPath(dest);
  await copyFile(origine, finale);
  return finale;
}

/** Copia una nota nel backup. Ritorna dove l'ha scritta, e se è rimasta
 *  cifrata (cioè se le serve il deposito accanto). */
async function copiaNota(
  noteRoot: string,
  devicePath: string,
  targetRoot: string,
): Promise<{ dest: string; cifrata: boolean }> {
  const rel = relative(noteRoot, devicePath);
  const protetta =
    extname(devicePath).toLowerCase() === PROTECTED_EXT && isProtectedPath(noteRoot, devicePath);
  const chiave = protetta ? vaultKey(noteRoot) : null;
  if (chiave) {
    const testo = decryptNote(await readFile(devicePath), chiave);
    const { dir, name } = parse(join(targetRoot, rel));
    await ensureDir(dir);
    const dest = uniqueTargetPath(join(dir, name + ALLOWED_EXT));
    await writeFile(dest, testo, "utf8");
    return { dest, cifrata: false };
  }
  const destInitial = join(targetRoot, rel);
  await ensureDir(dirname(destInitial));
  const dest = uniqueTargetPath(destInitial);
  await copyFile(devicePath, dest);
  return { dest, cifrata: protetta };
}

export async function backupNote(req: NoteBackupRequest): Promise<NoteBackupResponse> {
  const ext = extname(req.devicePath).toLowerCase();
  if (ext !== ALLOWED_EXT && ext !== PROTECTED_EXT) {
    throw new Error("Refused: only notes");
  }
  const noteRoot = await assertInsideNoteDir(req.devicePath);
  const targetRoot = req.targetDir ?? defaultBackupDir();
  const { dest, cifrata } = await copiaNota(noteRoot, req.devicePath, targetRoot);
  if (cifrata) await salvaDeposito(noteRoot, targetRoot);
  return { writtenPath: dest };
}

export async function backupAllNotes(
  req: NoteBackupAllRequest,
): Promise<NoteBackupAllResponse> {
  const { notes } = await listNotes({ mountPath: req.mountPath });
  const targetRoot = req.targetDir ?? defaultBackupDir();
  await ensureDir(targetRoot);
  const noteRoot = join(req.mountPath, NOTES_SUBDIR);

  /* A deposito CHIUSO l'elenco non contiene le note protette, ma il backup
     le deve prendere lo stesso: per copiare un file cifrato la chiave non
     serve. Si aggiungono qui, leggendo la cartella direttamente. */
  if (!vaultUnlocked(noteRoot)) {
    const cifrate: NoteFile[] = [];
    const visita = async (dir: string): Promise<void> => {
      let voci;
      try {
        voci = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const v of voci) {
        if (v.name.startsWith(".")) continue;
        const full = join(dir, v.name);
        if (v.isDirectory()) await visita(full);
        else if (v.isFile() && extname(v.name).toLowerCase() === PROTECTED_EXT) {
          const st = await stat(full);
          cifrate.push({
            name: v.name,
            size: st.size,
            mtimeIso: st.mtime.toISOString(),
            devicePath: full,
            relPath: relative(noteRoot, full),
          });
        }
      }
    };
    try {
      for (const v of await readdir(noteRoot, { withFileTypes: true })) {
        if (v.isDirectory() && isProtectedRoot(noteRoot, join(noteRoot, v.name))) {
          await visita(join(noteRoot, v.name));
        }
      }
    } catch {
      /* NOTE/ non c'è: niente da aggiungere */
    }
    notes.push(...cifrate);
  }

  const written: string[] = [];
  const errors: NoteBackupAllResponse["errors"] = [];
  let serveDeposito = false;
  for (const n of notes) {
    try {
      const { dest, cifrata } = await copiaNota(noteRoot, n.devicePath, targetRoot);
      if (cifrata) serveDeposito = true;
      written.push(dest);
    } catch (e) {
      errors.push({
        devicePath: n.devicePath,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  if (serveDeposito) {
    try {
      const d = await salvaDeposito(noteRoot, targetRoot);
      if (d) written.push(d);
      else {
        /* Note cifrate copiate senza ciò che le apre: va detto, non taciuto. */
        errors.push({
          devicePath: join(noteRoot, PROTECTED_DIR),
          message:
            "The encrypted notes were copied WITHOUT the key that opens them: unlock PRIVATE once (it gets the key from ORION), then back up again.",
        });
      }
    } catch (e) {
      errors.push({
        devicePath: vaultPath(noteRoot) ?? join(noteRoot, PROTECTED_DIR),
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { written, errors };
}

// ---------------------------------------------------------------------------
//  Folder/file ops (mkdir / rename / del / copy / move) scoped a NOTE/
// ---------------------------------------------------------------------------

export async function notesMkdir(req: NoteMkdirRequest): Promise<NoteMkdirResponse> {
  await assertInsideNoteDir(req.parent);
  const name = assertValidName(req.name);
  const target = resolve(req.parent, name);
  await assertInsideNoteDir(target);
  await mkdir(target, { recursive: false });
  return { path: target };
}

export async function notesRename(req: NoteRenameRequest): Promise<NoteRenameResponse> {
  const noteRoot = await assertInsideNoteDir(req.from);
  const newName = assertValidName(req.newName);
  if (isProtectedRoot(noteRoot, req.from)) {
    throw new Error("Refused: PRIVATE cannot be renamed — the device knows it by that name.");
  }
  // Un file tiene la sua estensione: .txt, o .enc dentro PRIVATE.
  const fromStat = await stat(req.from);
  if (
    fromStat.isFile() &&
    extname(newName).toLowerCase() !== extname(req.from).toLowerCase()
  ) {
    throw new Error(`Refused: the note must keep its ${extname(req.from)} extension`);
  }
  const target = join(dirname(req.from), newName);
  await assertInsideNoteDir(target);
  await rename(req.from, target);
  return { path: target };
}

export async function notesDelete(req: NoteDeleteRequest): Promise<void> {
  const noteRoot = await assertInsideNoteDir(req.path);
  if (normalize(req.path) === noteRoot) {
    throw new Error("Refused: non puoi cancellare la cartella NOTE/.");
  }
  await rm(req.path, { recursive: true, force: false });
}

async function copyRecursive(src: string, dst: string): Promise<void> {
  const s = await stat(src);
  if (s.isDirectory()) {
    await mkdir(dst, { recursive: true });
    const entries = await readdir(src, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      // dentro NOTE/ filtra le note (e ricorsione su folder). Le due zone
      // non si mescolano: lo garantisce `assertStessaZona` a monte.
      if (
        e.isFile() &&
        extname(e.name).toLowerCase() !== ALLOWED_EXT &&
        extname(e.name).toLowerCase() !== PROTECTED_EXT
      ) continue;
      await copyRecursive(join(src, e.name), join(dst, e.name));
    }
  } else {
    await copyFile(src, dst);
  }
}

/**
 * Una nota non passa dalla zona protetta a quella normale, né viceversa:
 * cambierebbe cartella ma non contenuto — un `.txt` in chiaro dentro
 * `PRIVATE`, o un `.enc` fuori — e il dispositivo non elencherebbe né l'uno
 * né l'altro. Convertirla vuol dire decifrarla o cifrarla, che è un'altra
 * operazione e va chiesta per nome.
 */
function assertStessaZona(noteRoot: string, sourcePath: string, dstDir: string): void {
  if (isProtectedRoot(noteRoot, sourcePath)) {
    throw new Error("Refused: PRIVATE cannot be moved or copied.");
  }
  if (isProtectedPath(noteRoot, sourcePath) !== isProtectedPath(noteRoot, dstDir)) {
    throw new Error(
      "Refused: protected notes stay inside PRIVATE, and plain notes outside it.",
    );
  }
}

export async function notesCopy(req: NoteCopyRequest): Promise<NoteCopyResponse> {
  const noteRoot = await assertInsideNoteDir(req.sourcePath);
  await assertInsideNoteDir(req.dstDir);
  assertStessaZona(noteRoot, req.sourcePath, req.dstDir);
  const srcStat = await stat(req.sourcePath);
  const srcExt = extname(req.sourcePath).toLowerCase();
  if (srcStat.isFile() && srcExt !== ALLOWED_EXT && srcExt !== PROTECTED_EXT) {
    throw new Error("Refused: only notes");
  }
  const dstInitial = join(req.dstDir, basename(req.sourcePath));
  if (
    dstInitial === req.sourcePath ||
    isInside(dstInitial, normalize(req.sourcePath))
  ) {
    throw new Error("Cannot copy a folder into itself.");
  }
  const target = req.uniqueOnConflict === false
    ? dstInitial
    : uniqueTargetPath(dstInitial);
  await copyRecursive(req.sourcePath, target);
  return { writtenPath: target };
}

export async function notesMove(req: NoteMoveRequest): Promise<NoteMoveResponse> {
  const noteRoot = await assertInsideNoteDir(req.sourcePath);
  await assertInsideNoteDir(req.dstDir);
  assertStessaZona(noteRoot, req.sourcePath, req.dstDir);
  const dstInitial = join(req.dstDir, basename(req.sourcePath));
  if (dstInitial === req.sourcePath) {
    return { writtenPath: req.sourcePath };
  }
  if (isInside(dstInitial, normalize(req.sourcePath))) {
    throw new Error("Cannot move a folder into itself.");
  }
  const target = req.uniqueOnConflict === false
    ? dstInitial
    : uniqueTargetPath(dstInitial);
  await mkdir(dirname(target), { recursive: true });
  await rename(req.sourcePath, target);
  return { writtenPath: target };
}

// ---------------------------------------------------------------------------
//  Il deposito delle note protette
// ---------------------------------------------------------------------------

function stato(noteRoot: string, unlocked: boolean): NoteVaultStatus {
  return { exists: vaultExists(noteRoot), unlocked, needsKey: vaultSource(noteRoot).needsKey };
}

export async function notesVaultStatus(req: NoteVaultRequest): Promise<NoteVaultStatus> {
  const noteRoot = join(req.mountPath, NOTES_SUBDIR);
  return stato(noteRoot, vaultUnlocked(noteRoot));
}

/** La copia tenuta qui, per rimetterla su un ORION che l'ha persa. Non è
 *  la chiave: sono gli 88 byte che senza la password non aprono niente. */
export async function notesVaultExport(req: NoteVaultUnlockRequest): Promise<NoteVaultExport> {
  const r = vaultExport(join(req.mountPath, NOTES_SUBDIR), req.password);
  if (!r) throw new Error("Wrong password: none of the notes keys kept here opens with it.");
  return r;
}

/** Il deposito appena arrivato da ORION sulla seriale. */
export async function notesVaultImport(req: NoteVaultImportRequest): Promise<NoteVaultStatus> {
  const noteRoot = join(req.mountPath, NOTES_SUBDIR);
  vaultImport(noteRoot, req.hex);
  return stato(noteRoot, vaultUnlocked(noteRoot));
}

/** La password arriva dal renderer, si usa e si lascia cadere: non viene
 *  tenuta, e non compare in nessun messaggio d'errore. */
export async function notesVaultUnlock(req: NoteVaultUnlockRequest): Promise<NoteVaultStatus> {
  const noteRoot = join(req.mountPath, NOTES_SUBDIR);
  if (!vaultExists(noteRoot)) return { exists: false, unlocked: false, needsKey: false };
  if (vaultSource(noteRoot).needsKey) return stato(noteRoot, false);
  const ok = await vaultUnlock(noteRoot, req.password);
  return stato(noteRoot, ok);
}

export async function notesVaultLock(req: NoteVaultRequest): Promise<NoteVaultStatus> {
  const noteRoot = join(req.mountPath, NOTES_SUBDIR);
  vaultLock(noteRoot);
  return stato(noteRoot, false);
}
