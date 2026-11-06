/**
 * Le note protette di ORION, viste dal PC.
 *
 * Sul dispositivo la categoria `PRIVATE` contiene note CIFRATE (`.enc`). La
 * chiave che le cifra sta nel DEPOSITO (88 byte), a sua volta cifrata con una
 * chiave ricavata dalla password. Qui si rifà lo stesso percorso: scrypt
 * viene da `node:crypto`; ChaCha20-Poly1305 **no**, perché in Electron non
 * c'è — vedi `./chacha.ts`.
 *
 * ⚠️ **Dal 10/10/2026 il deposito non sta più sulla microSD**: sta nella
 * flash di ORION, e la Companion ne tiene UNA COPIA SUA, che si fa dare una
 * volta sola via console (vedi `vaultSource` più sotto, e nel firmware
 * `docs/PIANO_CIFRATURA_NOTE.md` §7c). Sulla card resta solo una SIGLA,
 * `.orion_vault_id`: dice quale deposito apre quelle note, e non è un segreto.
 *
 * La copia è un file normale nella cartella dati dell'app, **in chiaro e
 * senza portachiavi** — scelta dell'utente, e non è una leggerezza: sono gli
 * stessi 88 byte che fino a ieri stavano sulla card, già protetti da scrypt
 * e dalla password. Così è uguale su macOS, Windows e Linux.
 *
 * I formati sono definiti nel firmware, e vanno letti lì:
 *   - il deposito: `ORIONV3_IDE/Core/Inc/deposito.h`
 *   - la nota:     `ORIONV3_IDE/Core/Src/ui_note.c`, "The protected category"
 * Lo scambio fra i due è provato nel repository del firmware
 * (`prove_pc/deposito_apri.mjs`, `prove_pc/nota_apri.mjs`).
 *
 * ⚠️ **La chiave resta in memoria, nel processo principale, e da nessun'altra
 * parte.** Non va al renderer, non va su disco, non va nei log. Si butta dopo
 * dieci minuti senza usarla, quando l'utente richiude, e quando l'app esce.
 *
 * ⚠️ **Qui non c'è il blocco dopo cinque tentativi.** Sul dispositivo ferma
 * chi lo ha in mano; sul PC non fermerebbe nessuno — chi ha la microSD prova
 * le password con un programma suo. La difesa contro quello è il costo di
 * scrypt per la lunghezza della password, e basta.
 */

import { createHash, randomBytes, scryptSync } from "node:crypto";
import { aeadOpen, aeadSeal, TagError } from "./chacha";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Il deposito dentro `<mount>/NOTE/`, com'era fino al 10/10/2026: lo lascia
 *  lì un firmware di prima, e con questo nome lo si mette accanto a un backup. */
export const VAULT_FILE = ".orion_vault";
/** La sigla del deposito, scritta dal dispositivo sulla card. */
export const VAULT_ID_FILE = ".orion_vault_id";
/** La categoria protetta, e l'estensione delle sue note. */
export const PROTECTED_DIR = "PRIVATE";
export const PROTECTED_EXT = ".enc";

const VAULT_BYTES = 88;
const NOTE_OVERHEAD = 8 + 12 + 16; // intestazione, nonce, tag
const NOTE_HEADER = Buffer.from([0x4f, 0x52, 0x4e, 0x4e, 1, 0, 0, 0]); // "ORNN" 1
/** Dieci minuti senza usarla e la chiave si butta. */
const AUTO_LOCK_MS = 10 * 60 * 1000;

interface Aperto {
  chiave: Buffer;
  timer: NodeJS.Timeout;
}

/** Una chiave per radice `<mount>/NOTE`: due dispositivi, due depositi. */
const aperti = new Map<string, Aperto>();

/* ---------------------------------------------------------------------------
 *  Dove sta il deposito che apre queste note
 * ------------------------------------------------------------------------- */

/** La cartella delle copie. La dice `index.ts` all'avvio: questo file non
 *  conosce Electron, così gli script di prova lo usano senza. */
let storeDir: string | null = null;
export function setVaultStoreDir(dir: string): void {
  storeDir = dir;
}

/** La sigla di un deposito: i primi 8 byte del suo SHA-256, in esadecimale.
 *  Lo stesso conto che fa il firmware (`deposito_sigla`). */
export function vaultId(deposito: Buffer): string {
  return createHash("sha256").update(deposito).digest("hex").slice(0, 16);
}

function formatoOk(d: Buffer): boolean {
  return (
    d.length === VAULT_BYTES &&
    d.subarray(0, 4).toString("latin1") === "ORNV" &&
    d[4] === 1 &&
    d[5] === 1
  );
}

function cardId(noteRoot: string): string | null {
  try {
    const s = readFileSync(join(noteRoot, VAULT_ID_FILE), "latin1").trim().toLowerCase();
    return /^[0-9a-f]{16}$/.test(s) ? s : null;
  } catch {
    return null;
  }
}

/** Le copie si chiamano con la propria sigla: due dispositivi, o lo stesso
 *  prima e dopo un cambio di password, non si pestano. */
function storePath(id: string): string | null {
  return storeDir ? join(storeDir, `${id}.vault`) : null;
}

export interface VaultSource {
  /** Il file da cui leggere gli 88 byte; `null` se non c'è da nessuna parte. */
  path: string | null;
  /** La card dice quale deposito serve e qui non c'è: va chiesto a ORION. */
  needsKey: boolean;
}

/**
 * ⚠️ L'ordine conta.
 *  1. La card ha una sigla (firmware dal 10/10/2026): vale la copia con
 *     QUELLA sigla, e nessun'altra. Se manca ma sulla card c'è ancora il
 *     file di prima e la sua sigla coincide, lo si prende da lì — è lo
 *     stesso deposito, e si risparmia all'utente il giro sul dispositivo.
 *     Se non coincide (la password è stata cambiata dopo) NON lo si usa:
 *     aprirebbe con la password vecchia, e sembrerebbe un errore.
 *  2. Nessuna sigla: è un firmware di prima, il deposito è il file sulla card.
 */
export function vaultSource(noteRoot: string): VaultSource {
  const legacy = join(noteRoot, VAULT_FILE);
  const id = cardId(noteRoot);
  if (!id) return { path: existsSync(legacy) ? legacy : null, needsKey: false };

  const copia = storePath(id);
  if (copia && existsSync(copia)) return { path: copia, needsKey: false };
  if (existsSync(legacy)) {
    try {
      const d = readFileSync(legacy);
      if (formatoOk(d) && vaultId(d) === id) {
        if (!copia) return { path: legacy, needsKey: false };
        mkdirSync(storeDir as string, { recursive: true });
        writeFileSync(copia, d);
        return { path: copia, needsKey: false };
      }
    } catch {
      /* illeggibile: come se non ci fosse */
    }
  }
  return { path: null, needsKey: true };
}

/** Il file del deposito, o `null`. */
export function vaultPath(noteRoot: string): string | null {
  return vaultSource(noteRoot).path;
}

/** Su questo dispositivo è stata impostata una password delle note. Vero
 *  anche quando la copia del deposito manca ancora (`needsKey`). */
export function vaultExists(noteRoot: string): boolean {
  const s = vaultSource(noteRoot);
  return s.needsKey || candidati(noteRoot).length > 0;
}

/**
 * Il deposito arrivato da ORION (`ORNV KEY <176 hex>`): lo si tiene solo se
 * è proprio quello che la card dice di volere.
 */
export function vaultImport(noteRoot: string, hex: string): void {
  if (!/^[0-9a-fA-F]{176}$/.test(hex)) throw new Error("ORION sent something that is not a notes key.");
  const d = Buffer.from(hex, "hex");
  if (!formatoOk(d)) throw new Error("ORION sent a notes key in a format I do not know.");
  const id = vaultId(d);
  const vuole = cardId(noteRoot);
  if (vuole && vuole !== id) {
    throw new Error("The key ORION sent is not the one of the notes on this card.");
  }
  const copia = storePath(id);
  if (!copia) throw new Error("No place to keep the notes key.");
  mkdirSync(storeDir as string, { recursive: true });
  writeFileSync(copia, d);
}

export function vaultUnlocked(noteRoot: string): boolean {
  return aperti.has(noteRoot);
}

export function vaultLock(noteRoot: string): void {
  const a = aperti.get(noteRoot);
  if (!a) return;
  clearTimeout(a.timer);
  a.chiave.fill(0);
  aperti.delete(noteRoot);
}

export function vaultLockAll(): void {
  for (const k of [...aperti.keys()]) vaultLock(k);
}

function armaTimer(noteRoot: string): NodeJS.Timeout {
  const t = setTimeout(() => vaultLock(noteRoot), AUTO_LOCK_MS);
  t.unref?.(); // non deve tenere viva l'app
  return t;
}

/** La chiave, se il deposito è aperto. Usarla rimanda la richiusura. */
export function vaultKey(noteRoot: string): Buffer | null {
  const a = aperti.get(noteRoot);
  if (!a) return null;
  clearTimeout(a.timer);
  a.timer = armaTimer(noteRoot);
  return a.chiave;
}

/* ---------------------------------------------------------------------------
 *  Quale deposito, quando la card non lo dice
 * ------------------------------------------------------------------------- */

/** Le copie tenute qui, la più recente per prima. */
function storeCopies(): string[] {
  if (!storeDir || !existsSync(storeDir)) return [];
  return readdirSync(storeDir)
    .filter((n) => /^[0-9a-f]{16}\.vault$/.test(n))
    .map((n) => join(storeDir as string, n))
    .sort((x, y) => statSync(y).mtimeMs - statSync(x).mtimeMs);
}

/**
 * I depositi da provare con la password, in ordine.
 *
 * Di norma è uno solo: quello che la sigla indica. Ma la sigla è un file
 * sulla card, e può non esserci — una card nuova, un file cancellato a mano
 * (visto il 10/10/2026, alla prima prova del ripristino). Allora non si sa
 * QUALE copia serve, e non c'è bisogno di saperlo: si provano tutte, e la
 * password dice qual è. Se la card vuole un deposito preciso che qui manca
 * (`needsKey`), invece, non si prova niente: le altre copie sono di un'altra
 * password o di un altro dispositivo.
 */
function candidati(noteRoot: string): string[] {
  const s = vaultSource(noteRoot);
  if (s.path) return [s.path];
  if (s.needsKey) return [];
  return storeCopies();
}

/** La chiave principale, se `password` apre `d`; `null` se è sbagliata (o
 *  il file è stato alterato: non si può distinguere, ed è giusto così). */
function apri(d: Buffer, password: string): Buffer | null {
  if (!formatoOk(d)) {
    throw new Error("Il deposito delle note non è in un formato che conosco.");
  }
  const log2n = d[8];
  const r = d[9];
  const p = d[10];
  /* I parametri vengono dal file: un file che ne chiede di assurdi farebbe
     allocare gigabyte. Il firmware scrive 12 / 8 / 1. */
  if (log2n < 10 || log2n > 20 || r < 1 || r > 16 || p < 1 || p > 4) {
    throw new Error("Il deposito delle note chiede parametri fuori misura.");
  }
  const N = 2 ** log2n;
  /* La tastiera del dispositivo produce solo ASCII: `latin1` dà gli stessi
     byte, uno per carattere, che ha usato il firmware. */
  const kek = scryptSync(Buffer.from(password, "latin1"), d.subarray(12, 28), 32, {
    N,
    r,
    p,
    maxmem: 256 * N * r,
  });
  try {
    return aeadOpen(kek, d.subarray(28, 40), d.subarray(0, 28), d.subarray(40, 72), d.subarray(72, 88));
  } catch (e) {
    /* SOLO il sigillo che non torna vuol dire "password sbagliata". Ogni
       altro errore va fuori com'è: la prima versione li prendeva tutti per
       una password sbagliata, e un cifrario che mancava è rimasto nascosto
       dietro un dialogo che si chiudeva. */
    if (e instanceof TagError) return null;
    throw e;
  } finally {
    kek.fill(0);
  }
}

/** Una nota protetta della card, per vedere se una chiave è la sua. La
 *  prima non vuota che si trova; `null` se non ce ne sono. */
function notaDiProva(noteRoot: string): Buffer | null {
  const visita = (dir: string): Buffer | null => {
    let voci;
    try {
      voci = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const v of voci) {
      const full = join(dir, v.name);
      if (v.isDirectory()) {
        const n = visita(full);
        if (n) return n;
      } else if (!v.name.startsWith(".") && v.name.toLowerCase().endsWith(PROTECTED_EXT)) {
        /* ⚠️ Deve ESSERE una nota, non solo chiamarsi come una. Su una card
           FAT macOS lascia accanto ai file i suoi `._nome.enc`: il 10/10/2026
           uno di quelli è stato preso per la nota di prova, nessuna chiave
           lo apriva, e ogni password risultava "sbagliata". */
        const f = readFileSync(full);
        if (f.length >= NOTE_OVERHEAD && f.subarray(0, 5).equals(NOTE_HEADER.subarray(0, 5))) {
          return f;
        }
      }
    }
    return null;
  };
  return visita(join(noteRoot, PROTECTED_DIR));
}

function apreLaNota(nota: Buffer, chiave: Buffer): boolean {
  try {
    aeadOpen(
      chiave,
      nota.subarray(8, 20),
      nota.subarray(0, 8),
      nota.subarray(20, nota.length - 16),
      nota.subarray(nota.length - 16),
    );
    return true;
  } catch (e) {
    if (e instanceof TagError) return false;
    throw e;
  }
}

/**
 * Il deposito che `password` apre, fra i candidati. Con più di un candidato
 * conta anche che la chiave apra una nota di QUESTA card: due dispositivi
 * possono avere la stessa password e chiavi diverse.
 */
function trova(noteRoot: string, password: string): { d: Buffer; chiave: Buffer } | null {
  const lista = candidati(noteRoot);
  if (lista.length === 0) {
    throw new Error("The notes key is not here yet: get it from ORION first.");
  }
  const nota = lista.length > 1 ? notaDiProva(noteRoot) : null;
  for (const f of lista) {
    const d = readFileSync(f);
    const chiave = apri(d, password);
    if (!chiave) continue;
    if (nota && !apreLaNota(nota, chiave)) {
      chiave.fill(0);
      continue;
    }
    return { d, chiave };
  }
  return null;
}

/**
 * Prova la password sul deposito. `true` e il deposito resta aperto;
 * `false` se la password è sbagliata.
 */
export async function vaultUnlock(noteRoot: string, password: string): Promise<boolean> {
  vaultLock(noteRoot);
  const t = trova(noteRoot, password);
  if (!t) return false;
  aperti.set(noteRoot, { chiave: t.chiave, timer: armaTimer(noteRoot) });
  return true;
}

/** true se `p` sta dentro `<noteRoot>/PRIVATE` (o è quella cartella). */
export function isProtectedPath(noteRoot: string, p: string): boolean {
  const rel = relative(noteRoot, p);
  if (rel === "" || rel.startsWith("..")) return false;
  return rel.split(sep)[0].toUpperCase() === PROTECTED_DIR;
}

/**
 * true se una chiave di sincronizzazione (`cartella/nota`, senza estensione)
 * cade nella categoria protetta.
 *
 * ⚠️ Le sincronizzazioni con Obsidian e Notion la usano in due modi, secondo
 * lo stato del deposito:
 *  - **chiuso**: `PRIVATE` resta fuori in tutti e due i versi, e le sue righe
 *    nel manifest si portano avanti intatte — sparite dall'elenco non vuol
 *    dire cancellate;
 *  - **aperto**: `PRIVATE` si sincronizza come le altre cartelle, **in chiaro
 *    dall'altra parte** (lo ha chiesto l'utente: sbloccare è il consenso) e
 *    cifrata sul dispositivo. Chi scrive sul dispositivo passa da
 *    `deviceNotePath` e `deviceNoteBytes`, mai da un `.txt` scritto a mano:
 *    un `.txt` dentro `PRIVATE` il firmware non lo elenca nemmeno.
 */
export function isProtectedKey(key: string): boolean {
  return key.split("/")[0].toUpperCase() === PROTECTED_DIR;
}

/** I limiti del firmware sui nomi (`NOTE_TITLE_LEN`, `NOTE_NAME_LEN` in
 *  `ui_priv.h`, meno il terminatore). */
export const DEVICE_TITLE_MAX = 47;
export const DEVICE_FOLDER_MAX = 23;

/**
 * Dove sta sul dispositivo la nota di una chiave di sincronizzazione.
 *
 * ⚠️ Rifiuta i nomi che il dispositivo non sa riaprire. Il firmware tiene il
 * titolo in un buffer e da quello ricostruisce il percorso: una nota col nome
 * più lungo compare in elenco e poi non si apre (visto il 9/10/2026 con una
 * nota nata in Obsidian). Meglio un errore qui, che dice quale nota e perché,
 * di un file sulla microSD che si può solo guardare.
 */
export function deviceNotePath(noteRoot: string, key: string): string {
  const pezzi = key.split("/");
  const titolo = pezzi[pezzi.length - 1];
  if (titolo.length > DEVICE_TITLE_MAX) {
    throw new Error(
      `Name too long for the device (${titolo.length} characters, max ${DEVICE_TITLE_MAX}): rename the note.`,
    );
  }
  const lunga = pezzi.slice(0, -1).find((c) => c.length > DEVICE_FOLDER_MAX);
  if (lunga) {
    throw new Error(
      `Folder name too long for the device ("${lunga}", max ${DEVICE_FOLDER_MAX} characters).`,
    );
  }
  return join(noteRoot, ...key.split("/")) + (isProtectedKey(key) ? PROTECTED_EXT : ".txt");
}

/** I byte da scrivere sul dispositivo per `testo` destinato a `target`:
 *  cifrati se `target` cade in `PRIVATE`, altrimenti com'è. A deposito
 *  chiuso (anche richiuso a metà lavoro) si rifiuta invece di scrivere in
 *  chiaro. */
export function deviceNoteBytes(noteRoot: string, target: string, testo: Buffer): Buffer {
  if (!isProtectedPath(noteRoot, target)) return testo;
  const chiave = vaultKey(noteRoot);
  if (!chiave) throw new Error("PRIVATE is locked: unlock it first.");
  return encryptNote(testo.toString("utf8"), chiave);
}

/** true se `p` è proprio la cartella protetta. */
export function isProtectedRoot(noteRoot: string, p: string): boolean {
  return relative(noteRoot, p).toUpperCase() === PROTECTED_DIR;
}

/**
 * La copia del deposito da ridare a ORION. Vuole la password, e non per
 * prudenza: è lei che dice QUALE copia — vedi `candidati` — e che garantisce
 * che su ORION torni un deposito che l'utente sa aprire, non uno di una
 * password di tre cambi fa. `null` se la password non ne apre nessuna.
 */
export function vaultExport(noteRoot: string, password: string): { hex: string; id: string } | null {
  const t = trova(noteRoot, password);
  if (!t) return null;
  t.chiave.fill(0);
  return { hex: t.d.toString("hex"), id: vaultId(t.d) };
}

/** Il testo di una nota protetta. Un file vuoto è una nota vuota: appena
 *  creata sul dispositivo e mai salvata. */
export function decryptNote(file: Buffer, chiave: Buffer): string {
  if (file.length === 0) return "";
  if (file.length < NOTE_OVERHEAD || !file.subarray(0, 5).equals(NOTE_HEADER.subarray(0, 5))) {
    throw new Error("Non è una nota protetta ORION.");
  }
  try {
    const testo = aeadOpen(
      chiave,
      file.subarray(8, 20),
      file.subarray(0, 8),
      file.subarray(20, file.length - 16),
      file.subarray(file.length - 16),
    );
    return testo.toString("utf8");
  } catch (e) {
    if (!(e instanceof TagError)) throw e;
    throw new Error(
      "La nota non si apre: è stata alterata, o è stata cifrata con un altro deposito.",
    );
  }
}

/** Il file di una nota protetta, com'è scritto dal dispositivo. Il nonce è
 *  nuovo a ogni chiamata: lo stesso due volte sotto la stessa chiave
 *  regalerebbe i due testi. */
export function encryptNote(testo: string, chiave: Buffer): Buffer {
  const nonce = randomBytes(12);
  const { ct, tag } = aeadSeal(chiave, nonce, NOTE_HEADER, Buffer.from(testo, "utf8"));
  return Buffer.concat([NOTE_HEADER, nonce, ct, tag]);
}
