/**
 * Tipi condivisi main ↔ renderer.
 *
 * Convenzione: ogni feature definisce qui le sue request/response.
 * Il preload espone una funzione tipizzata per ogni channel, derivata
 * da queste interfacce → autocomplete e type-check end-to-end nel renderer.
 */

// ---------------------------------------------------------------------------
//  System / sanity
// ---------------------------------------------------------------------------

export interface PingRequest {
  message: string;
}

export interface PingResponse {
  echo: string;
  pid: number;
  versions: {
    node: string;
    chrome: string;
    electron: string;
  };
}

// ---------------------------------------------------------------------------
//  System info — usata dal modulo Bug Report per allegare al messaggio
//  versione app, OS e versioni dei runtime (Electron/Chrome/Node).
// ---------------------------------------------------------------------------

export interface SystemInfo {
  /** package.json version (es. "0.4.1"). */
  appVersion: string;
  /** "darwin" | "win32" | "linux". */
  platform: string;
  /** "x64" | "arm64". */
  arch: string;
  /** Kernel release (es. macOS Darwin "24.6.0"). */
  osRelease: string;
  electronVersion: string;
  nodeVersion: string;
  chromeVersion: string;
}

// ---------------------------------------------------------------------------
//  Device discovery (Step 2)
//
//  L'app identifica un device "Orion" cercando un file marker nella root
//  della SD montata: `.orion-device` (JSON). Vedi `MARKER_*` in
//  main/ipc/device.ts per i valori esatti.
// ---------------------------------------------------------------------------

export interface DeviceInfo {
  /** Path assoluto del mount point (es. "/Volumes/ORION", "E:\\"). */
  mountPath: string;
  /** Stringa identificativa del device (può coincidere col serial MCU). */
  deviceId: string | null;
  /** Versione firmware dichiarata dal marker. */
  fwVersion: string | null;
  /** Ultima scrittura del marker da parte del firmware (ISO 8601). */
  lastSeen: string | null;
  /** Nome leggibile (basename del mount), fallback se manca device_id. */
  label: string;
}

export interface DeviceListResponse {
  devices: DeviceInfo[];
}

export interface DeviceEjectRequest {
  mountPath: string;
}

export interface DeviceEjectResponse {
  ok: boolean;
  /** Messaggio leggibile dall'OS (sia in caso di successo che di errore). */
  message?: string;
}

// ---------------------------------------------------------------------------
//  Firmware DFU update (USB bootloader STM32 0483:df11)
// ---------------------------------------------------------------------------

export interface DfuDevice {
  vid: string;
  pid: string;
  serial: string;
  name: string;
}

export interface FirmwareDetectResponse {
  device: DfuDevice | null;
  /** True se dfu-util è raggiungibile (bundle o PATH). False = errore di setup. */
  dfuUtilAvailable: boolean;
  /** Path effettivo del binario usato (per debug). */
  dfuUtilPath?: string | null;
}

export interface FirmwareFlashRequest {
  binPath: string;
}

export interface FirmwareFlashProgress {
  phase: "erase" | "write" | "verify";
  pct: number;
  bytesWritten: number;
}

export interface FirmwareFlashResult {
  ok: boolean;
  message: string;
  stderr?: string;
}

export type FirmwareProgressListener = (ev: FirmwareFlashProgress) => void;
export type FirmwareLogListener = (line: string) => void;

// ---------------------------------------------------------------------------
//  Firmware auto-update (companion fetches latest stable from
//  https://orionpda.org/companion/updates/, compares against the version file
//  on the device SD, and orchestrates DFU via an SD trigger).
//
//  Contract with the firmware:
//   - SD ROOT contains exactly one empty file named "<version>.fwver"
//     where <version> is the running firmware version (e.g. "1.2.3.fwver").
//   - Companion creates an empty file named "DFU" (no extension) at SD root
//     to ask the firmware-in-USB-MSC to reboot into DFU bootloader.
//   - On boot the firmware syncs the .fwver filename and deletes any DFU
//     file left behind by the previous update.
// ---------------------------------------------------------------------------

export interface FirmwareManifest {
  /** Latest stable version string from the manifest, e.g. "01beta". */
  version: string;
  /** Absolute URL of the firmware .bin (resolved against the manifest URL). */
  url: string;
  /** Size of the .bin in bytes (manifest value, or Content-Length on download). */
  size?: number;
  /** Optional sha256 of the .bin for integrity check. */
  sha256?: string;
  /** Optional release date (free-form, displayed verbatim). */
  releaseDate?: string;
  /** Optional release notes. */
  notes?: string;
}

export interface FirmwareIntegrityError {
  /** Version the corrupt file was supposed to be. */
  version: string;
  /** sha256 expected from the manifest. */
  expected: string;
  /** sha256 actually computed over the downloaded bytes. */
  got: string;
  /** Absolute URL we downloaded from. */
  sourceUrl: string;
  /** ISO 8601 timestamp of the failure. */
  whenIso: string;
}

export interface FirmwareUpdateState {
  /** Last successful manifest fetch. */
  latest: FirmwareManifest | null;
  /** True if the .bin for `latest.version` is cached on disk. */
  binCached: boolean;
  /** Absolute path on the host of the cached .bin (only when binCached). */
  binPath: string | null;
  /** Last fetch error message, if any. */
  fetchError: string | null;
  /** Set when the downloaded .bin failed sha256 verification against the
   *  manifest. The corrupt file is deleted before this is raised; the
   *  field stays set until the renderer acknowledges (so the popup can
   *  be shown after the user switches pages). */
  integrityError: FirmwareIntegrityError | null;
  /** True while a manifest/bin fetch is in flight. */
  fetching: boolean;
  /** Timestamp of the last successful fetch (ISO). */
  lastFetchedAt: string | null;
}

export interface FirmwareSdVersionRequest {
  mountPath: string;
}

export interface FirmwareSdVersionResponse {
  /** Version string parsed from the .fwver filename on SD root, or null. */
  version: string | null;
}

export interface FirmwareDfuTriggerRequest {
  mountPath: string;
}

export interface FirmwareDfuTriggerResponse {
  ok: boolean;
  /** "trigger-written" | "ejected" | "eject-failed" | "...". */
  message?: string;
  /** True if the eject step succeeded after writing the DFU file. */
  ejected: boolean;
}

export type FirmwareUpdateStateListener = (s: FirmwareUpdateState) => void;

// ---------------------------------------------------------------------------
//  File manager (Files tab) — operazioni sul filesystem del device
//
//  Tutte le operazioni sono limitate al mount path di un device Orion
//  conosciuto: il main valida che ogni `path` ricevuto sia dentro la
//  cartella del mount per evitare traversal arbitrari sul filesystem host.
// ---------------------------------------------------------------------------

/** La fotografia del dispositivo all'ultimo scambio via Bluetooth: vedi
 *  `main/ipc/bleLocal.ts`. `ts` è la data FAT del file, vuota se non nota. */
export interface BleSnapshot {
  files: Record<string, { size: number; crc: number; ts: string }>;
  dirs: string[];
}

export interface BleMirrorState {
  /** Fa da `mountPath` per le API delle note. */
  root: string;
  files: { rel: string; size: number; crc: number }[];
  dirs: string[];
  snapshot: BleSnapshot | null;
}

export interface FilesEntry {
  /** Basename (es. "books"). */
  name: string;
  /** Path assoluto sull'host (es. "/Volumes/ORION/books"). */
  path: string;
  isDirectory: boolean;
  /** Bytes (0 per directory, dimensione file per file). */
  size: number;
  /** mtime ISO 8601. */
  mtimeIso: string;
}

export interface FilesListRequest {
  path: string;
}

export interface FilesListResponse {
  entries: FilesEntry[];
}

export interface FilesDeleteRequest {
  /** Path assoluto da rimuovere. Directory rimosse ricorsivamente. */
  path: string;
}

export interface FilesUploadRequest {
  /** Path sul PC. */
  sourcePath: string;
  /** Directory di destinazione sul device. */
  dstDir: string;
  /** Se esiste un file con lo stesso nome: rinomina con suffisso " (N)". */
  uniqueOnConflict?: boolean;
}

export interface FilesUploadResponse {
  /** Path finale del file sul device dopo eventuale rename anti-collisione. */
  writtenPath: string;
  bytes: number;
}

export interface FilesMkdirRequest {
  /** Parent directory + nuovo nome. */
  parent: string;
  name: string;
}

export interface FilesMkdirResponse {
  path: string;
}

export interface FilesRenameRequest {
  from: string;
  to: string;
}

export interface FilesCopyRequest {
  /** Path sorgente (file o directory) — deve essere dentro un device Orion. */
  sourcePath: string;
  /** Directory di destinazione (idem). Il nome finale è basename(sourcePath). */
  dstDir: string;
  /** Se esiste un file/cartella con lo stesso nome: rinomina con " (N)". */
  uniqueOnConflict?: boolean;
}

export interface FilesCopyResponse {
  writtenPath: string;
}

export interface FilesMoveRequest {
  /** Path sorgente da spostare. */
  sourcePath: string;
  /** Directory di destinazione (basename(sourcePath) come nome finale). */
  dstDir: string;
  uniqueOnConflict?: boolean;
}

export interface FilesMoveResponse {
  writtenPath: string;
}

// ---------------------------------------------------------------------------
//  Note sync (Step 3)
//
//  Backup PC ← device only. Niente push, edit, delete (per ora).
// ---------------------------------------------------------------------------

export interface NoteFile {
  /** Nome file (basename, es. "shopping.txt"). */
  name: string;
  /** Dimensione in byte. */
  size: number;
  /** Mtime ISO 8601. */
  mtimeIso: string;
  /** Path assoluto sul device (es. "/Volumes/KINGSTON/NOTE/shopping.txt"). */
  devicePath: string;
  /** Una nota cifrata della categoria `PRIVATE`: il suo contenuto NON è
   *  testo, e non va trattato come tale. */
  protected?: boolean;
  /** Path relativo a `<mount>/NOTE/` (es. "ideas/2026/foo.txt").
   *  Vuoto per le note nella root NOTE/. */
  relPath: string;
}

export interface NoteListRequest {
  mountPath: string;
}

export interface NoteListResponse {
  notes: NoteFile[];
}

// ---- Tree (Step "folders inside NOTE/") -----------------------------------

export interface NoteTreeFolder {
  kind: "folder";
  /** Basename della cartella (es. "ideas"). Stringa vuota = root NOTE/. */
  name: string;
  /** Path assoluto sul device. */
  path: string;
  /** Path relativo a `<mount>/NOTE/`. Vuoto per la root. */
  relPath: string;
  children: NoteTreeNode[];
  /** La categoria protetta (`PRIVATE`) o una sua sottocartella. */
  protected?: boolean;
  /** Protetta e a deposito chiuso: `children` è vuoto di proposito, come sul
   *  dispositivo, che chiusa non mostra né titoli né quante note ci sono. */
  locked?: boolean;
}

export interface NoteTreeFile {
  kind: "file";
  /** Basename del file (es. "shopping.txt"). */
  name: string;
  /** Path assoluto sul device. */
  path: string;
  /** Path relativo a `<mount>/NOTE/`. */
  relPath: string;
  size: number;
  mtimeIso: string;
  /** Una nota cifrata (`.enc`): si legge solo a deposito aperto. */
  protected?: boolean;
}

export type NoteTreeNode = NoteTreeFolder | NoteTreeFile;

// ---- Il deposito delle note protette --------------------------------------

export interface NoteVaultRequest {
  mountPath: string;
}
export interface NoteVaultUnlockRequest {
  mountPath: string;
  /** Usata nel processo principale e lasciata cadere: non viene conservata. */
  password: string;
}
export interface NoteVaultImportRequest {
  mountPath: string;
  /** Gli 88 byte del deposito come li manda ORION: 176 caratteri esadecimali. */
  hex: string;
}
export interface NoteVaultExport {
  /** Gli 88 byte, in esadecimale, come li vuole `vault put`. */
  hex: string;
  /** La loro sigla: ciò che `vault id` risponde se ORION ha già questo deposito. */
  id: string;
}
export interface NoteVaultStatus {
  /** Su questo dispositivo è stata impostata una password delle note. */
  exists: boolean;
  /** Il deposito sta nella flash di ORION e qui non ce n'è una copia (o è
   *  cambiata la password): va chiesto a ORION via USB prima di sbloccare. */
  needsKey: boolean;
  /** Aperto in questa sessione della Companion. Si richiude da solo dopo
   *  dieci minuti senza usarlo. */
  unlocked: boolean;
}

export interface NoteTreeRequest {
  mountPath: string;
}

export interface NoteTreeResponse {
  /** Albero radicato in `<mount>/NOTE/`. `root.relPath === ""`. */
  root: NoteTreeFolder;
}

// ---- Folder/file CRUD scoped a <mount>/NOTE/ ------------------------------

export interface NoteMkdirRequest {
  /** Path assoluto della cartella parent (deve essere dentro <mount>/NOTE/). */
  parent: string;
  /** Nome nuova sottocartella (senza separatori). */
  name: string;
}
export interface NoteMkdirResponse {
  path: string;
}

export interface NoteRenameRequest {
  /** Path corrente (file o folder), dentro <mount>/NOTE/. */
  from: string;
  /** Nuovo basename (senza separatori). Lo stesso parent viene preservato. */
  newName: string;
}
export interface NoteRenameResponse {
  path: string;
}

export interface NoteDeleteRequest {
  /** Path da eliminare (file o folder ricorsivo). */
  path: string;
}

export interface NoteCopyRequest {
  /** Sorgente (file o folder) dentro <mount>/NOTE/. */
  sourcePath: string;
  /** Cartella di destinazione (dentro <mount>/NOTE/). */
  dstDir: string;
  /** Se true (default), accoda " (N)" in caso di collisione. */
  uniqueOnConflict?: boolean;
}
export interface NoteCopyResponse {
  writtenPath: string;
}

export interface NoteMoveRequest {
  sourcePath: string;
  dstDir: string;
  uniqueOnConflict?: boolean;
}
export interface NoteMoveResponse {
  writtenPath: string;
}

export interface NoteReadRequest {
  devicePath: string;
}

export interface NoteReadResponse {
  content: string;
  /** True se contiene byte non-UTF-8 (fallback latin-1). */
  fallbackEncoding: boolean;
}

export interface NoteBackupRequest {
  /** Path assoluto della nota sul device. */
  devicePath: string;
  /** Cartella di destinazione sul PC. Default: ~/Documents/Orion/notes/. */
  targetDir?: string;
}

export interface NoteBackupResponse {
  /** Path del file scritto sul PC. */
  writtenPath: string;
}

export interface NoteBackupAllRequest {
  mountPath: string;
  targetDir?: string;
}

export interface NoteBackupAllResponse {
  written: string[];
  errors: { devicePath: string; message: string }[];
}

/** Path di default per il backup, calcolato dal main al primo accesso. */
export interface NoteDefaultsResponse {
  defaultBackupDir: string;
}

// ---------------------------------------------------------------------------
//  Obsidian sync (bidirezionale device <-> vault)
//
//  La "vault" di Obsidian è una cartella di file .md scelta dall'utente. La
//  sync mirrora la gerarchia di <mount>/NOTE/ (file .txt) nella vault come .md
//  e viceversa. È bidirezionale e usa un manifest dell'ultimo sync per:
//   - distinguere "nuovo da un lato" da "cancellato dall'altro";
//   - rilevare conflitti reali (entrambi i lati modificati dall'ultimo sync).
//  Solo cambio estensione: nessuna trasformazione del contenuto.
// ---------------------------------------------------------------------------

export interface ObsidianPickVaultResponse {
  /** Cartella scelta dall'utente, o null se ha annullato. */
  path: string | null;
}

export interface ObsidianSyncRequest {
  mountPath: string;
  /** Cartella vault di Obsidian (cartella di file .md). */
  vaultPath: string;
}

export interface ObsidianConflict {
  /** Path relativo senza estensione (es. "ideas/2026/foo"). */
  relKey: string;
  /** Lato che ha vinto il conflitto (mtime più recente). */
  winner: "device" | "vault";
  /** Path della copia del perdente, conservata per non perdere dati. */
  conflictCopy: string;
}

export interface ObsidianSyncResponse {
  /** Note copiate device → vault (nuove o aggiornate). relKey. */
  pushed: string[];
  /** Note copiate vault → device (nuove o aggiornate). relKey. */
  pulled: string[];
  /** Conflitti risolti per mtime, col perdente conservato. */
  conflicts: ObsidianConflict[];
  /** Note cancellate sul device perché rimosse dalla vault. relKey. */
  deletedDevice: string[];
  /** Note cancellate nella vault perché rimosse dal device. relKey. */
  deletedVault: string[];
  /** Numero di note già allineate (nessuna azione). */
  unchanged: number;
  errors: { relKey: string; message: string }[];
}

// ---------------------------------------------------------------------------
//  Notion sync (bidirezionale device <-> pagine Notion, via OAuth)
//
//  L'utente collega il PROPRIO Notion con OAuth (login nel browser). Il
//  client_secret vive solo nel broker, mai nell'app distribuita; l'access
//  token cifrato resta solo sul Mac dell'utente (safeStorage). Le note del
//  device (file .txt) diventano sottopagine sotto una pagina genitore scelta
//  dall'utente; le cartelle diventano sottopagine annidate. Bidirezionale con
//  manifest, come Obsidian. Solo testo↔paragrafi (no rich text preservato).
// ---------------------------------------------------------------------------

export interface NotionConnectResponse {
  connected: boolean;
  /** Nome del workspace collegato (per la UI). */
  workspaceName?: string;
}

export interface NotionStatusResponse {
  connected: boolean;
  workspaceName?: string;
  /** Pagina genitore scelta dove vivono le note. */
  parentPageId?: string;
  parentPageTitle?: string;
}

/** Una pagina Notion accessibile all'integrazione (per il selettore genitore). */
export interface NotionPageRef {
  id: string;
  title: string;
}

export interface NotionListPagesResponse {
  pages: NotionPageRef[];
}

export interface NotionSetParentRequest {
  pageId: string;
  title: string;
}

export interface NotionSyncRequest {
  mountPath: string;
}

export interface NotionConflict {
  /** Path relativo senza estensione (es. "ideas/2026/foo"). */
  relKey: string;
  /** Lato che ha vinto il conflitto (last-edited più recente). */
  winner: "device" | "notion";
  /** Dove è conservato il perdente (path file o id pagina conflict). */
  conflictCopy: string;
}

export interface NotionSyncResponse {
  /** Note copiate device → Notion (nuove o aggiornate). relKey. */
  pushed: string[];
  /** Note copiate Notion → device (nuove o aggiornate). relKey. */
  pulled: string[];
  conflicts: NotionConflict[];
  /** Note cancellate sul device perché archiviate in Notion. relKey. */
  deletedDevice: string[];
  /** Pagine archiviate in Notion perché rimosse dal device. relKey. */
  deletedNotion: string[];
  unchanged: number;
  errors: { relKey: string; message: string }[];
}

// ---------------------------------------------------------------------------
//  Storage breakdown del device
//
//  Walk ricorsivo delle cartelle note: NOTE/, MEMO/, music/, video/. Tutto il
//  resto (incluso books/, file di sistema FAT, ecc.) finisce in `other`.
//  Total/free derivati da fs.statfs sul mount.
// ---------------------------------------------------------------------------

export interface DeviceStorageRequest {
  mountPath: string;
}

export interface DeviceStorageResponse {
  /** Capienza totale del filesystem in byte. */
  totalBytes: number;
  /** Spazio libero in byte. */
  freeBytes: number;
  /** Spazio occupato in byte (totalBytes - freeBytes). */
  usedBytes: number;
  /** Byte per categoria di contenuto. */
  breakdown: {
    notes: number;
    memos: number;
    music: number;
    video: number;
    /** Tutto il resto: ebooks, file di sistema, altro. */
    other: number;
  };
}

// ---------------------------------------------------------------------------
//  MP3 manager (Step 4)
//
//  Pipeline ffmpeg: loudnorm I=-14 LUFS + 48 kHz stereo + libmp3lame con
//  bitrate adattivo (CBR 320 per sorgenti lossless, CBR pari al sorgente
//  con floor 192 e cap 320 per sorgenti lossy, VBR q=2 fallback).
//  Destinazione: <mountPath>/music/<folder>/ se device, altrimenti
//  <localOutDir>/<folder>/ per export locale (default ~/Documents/Orion/music-export).
// ---------------------------------------------------------------------------

export interface FfmpegProbe {
  available: boolean;
  /** Output di "ffmpeg -version" prima riga, se trovato. */
  versionLine?: string;
  /** Path effettivamente trovato (which/where). */
  bin?: string;
  /** Stderr in caso di errore. */
  error?: string;
}

export interface Mp3JobInput {
  /** Path del file sorgente sul filesystem locale (PC). */
  sourcePath: string;
  /** Nome basename desiderato senza estensione (default = basename del sourcePath). */
  outputBaseName?: string;
}

export interface Mp3ConvertRequest {
  /** Mount path del device Orion (es. "/Volumes/KINGSTON"). Se assente
   *  si usa `localOutDir` (export su disco PC). */
  mountPath?: string;
  /** Sotto-cartella in <mount>/music/ o <localOutDir>/. Default "music". */
  folder: string;
  /** Lista file da processare. */
  jobs: Mp3JobInput[];
  /** Target LUFS (default -14). */
  targetLufs?: number;
  /** Cartella di destinazione assoluta per il local export. Usata solo
   *  quando `mountPath` è assente. Se anch'essa assente si usa il default
   *  ~/Documents/Orion/music-export. */
  localOutDir?: string;
  /** Scelta della copertina album da scrivere come cover.bin. Se assente
   *  si usa il default "embedded" (retro-compatibile). */
  cover?: Mp3CoverChoice;
}

/** Decisione su quale copertina scrivere come cover.bin nella root dell'album. */
export type Mp3CoverChoice =
  | { kind: "none" }
  | { kind: "embedded" }
  | { kind: "url"; url: string };

export interface Mp3JobResult {
  sourcePath: string;
  outputPath: string;
  ok: boolean;
  error?: string;
}

export interface Mp3ConvertResponse {
  results: Mp3JobResult[];
  /** True se è stata estratta una cover art embedded e scritta come
   *  `cover.bin` (1bpp 200×200) nella cartella di destinazione. */
  coverWritten?: boolean;
}

/** Eventi di progresso emessi durante una conversione batch. */
export interface Mp3ProgressEvent {
  /** Indice del job nel batch (0-based). */
  jobIndex: number;
  /** Path sorgente del job corrente. */
  sourcePath: string;
  /** Fase: probe (ffprobe), convert (ffmpeg), upload (copy ondevice), done. */
  phase: "probe" | "convert" | "done" | "error";
  /** Percentuale 0..100 della fase convert (durante "convert"). */
  percent?: number;
  /** Messaggio di errore in fase "error". */
  error?: string;
}

export type Mp3ProgressListener = (ev: Mp3ProgressEvent) => void;

// ---------------------------------------------------------------------------
//  Album cover online search (iTunes Search API)
// ---------------------------------------------------------------------------

/** Un candidato copertina restituito dalla ricerca online. */
export interface CoverCandidate {
  /** Id univoco (collectionId iTunes), per la selezione nella UI. */
  id: string;
  /** Nome album/collection. */
  title: string;
  /** Artista. */
  artist: string;
  /** Genere primario (primaryGenreName iTunes), es. "Rock". Può essere "". */
  genre: string;
  /** URL miniatura (100×100) per la griglia. */
  thumbUrl: string;
  /** URL immagine ad alta risoluzione da scaricare e ditherare. */
  imageUrl: string;
}

/** Suggerimento copertine a partire dai brani in coda: legge i tag del primo
 *  brano (artista/album) e interroga iTunes. */
export interface CoverSuggestRequest {
  /** Path sorgente dei brani; i tag vengono letti dal primo disponibile. */
  sourcePaths: string[];
  /** Override opzionale del nome album (es. la sottocartella scelta). */
  albumHint?: string;
}

export interface CoverSuggestResponse {
  /** Artista dedotto dai tag (può essere vuoto). */
  artist: string;
  /** Album dedotto dai tag o dall'hint. */
  album: string;
  /** Termine di ricerca effettivamente usato. */
  term: string;
  results: CoverCandidate[];
  /** Data URL (PNG) della cover embedded del primo brano che ne ha una, per
   *  mostrarla come opzione selezionabile. Assente se nessun brano ha art. */
  embeddedThumb?: string;
}

/** Ricerca manuale con termine libero. */
export interface CoverSearchRequest {
  term: string;
}

export interface CoverSearchResponse {
  results: CoverCandidate[];
}

// ---------------------------------------------------------------------------
//  Ebook converter (Step 5+6)
//
//  Input: file .md / .txt (.epub e .pdf arrivano negli step 7-8).
//  Pipeline: reader → reflow paginato 336×536 → .pdar binary.
// ---------------------------------------------------------------------------

export interface EbookConvertRequest {
  sourcePath: string;
  scale?: 1 | 2 | 3;
  mountPath?: string;
  folder?: string;
  outputBaseName?: string;
  /** Cartella di destinazione assoluta per il local export. Se assente (e
   *  manca anche `mountPath`) si usa il default ~/Documents/Orion/books-export. */
  localOutDir?: string;
}

export interface EbookConvertResponse {
  outputPath: string;
  pageCount: number;
  tocLength: number;
  bytes: number;
}

/**
 * Progress event durante una conversione ebook. Emesso dal main su `ebook:progress`.
 *
 * Fasi:
 *  - "read"   : lettura + parsing del sorgente (md/epub/pdf). percent stimato.
 *  - "reflow" : paginazione capitolo-per-capitolo. percent = chapterIdx/total
 *               linearizzato nell'intervallo 10..90.
 *  - "write"  : scrittura del .pdar su disco.
 *  - "done"   : conversione completata (percent 100).
 *  - "error"  : errore con messaggio.
 */
export interface EbookProgressEvent {
  phase: "read" | "reflow" | "write" | "done" | "error";
  /** 0..100. */
  percent?: number;
  /** Per la fase reflow: capitolo corrente (1-based) e totale. */
  chapterIdx?: number;
  totalChapters?: number;
  error?: string;
}

export type EbookProgressListener = (ev: EbookProgressEvent) => void;

/**
 * Preview di un ebook: stesso reflow del convert ma il risultato non viene
 * scritto su disco — torna le pagine paginate così il renderer può dipingerle
 * su un canvas 536×336 fedele a quel che vedrà il firmware.
 *
 * `pixels` viaggia come Uint8Array (Buffer → Uint8Array via structured clone).
 */
export interface EbookPreviewRequest {
  sourcePath: string;
  scale?: 1 | 2 | 3;
}

export type EbookPreviewItem =
  | { t: 1 | 2 | 3 | 7; s: string }
  | { t: 4; level: number; s: string }
  | { t: 5 }
  | { t: 6 }
  | { t: 8; s: string }
  | { t: 16; width: number; height: number; pixels: Uint8Array };

export interface EbookPreviewPage {
  items: EbookPreviewItem[];
  chapterTitle?: string;
}

export interface EbookPreviewResponse {
  /** Dimensioni logiche del display (post ROT_90). Sempre 536×336 oggi. */
  displayWidth: number;
  displayHeight: number;
  /** Margini usati dal reflow (px). Servono al canvas per posizionare. */
  marginLeft: number;
  marginRight: number;
  marginTop: number;
  marginBottom: number;
  /** Avance del font (px) a scale=1. Cella = advance × scale. */
  fontAdvanceW: number;
  fontAdvanceH: number;
  scale: 1 | 2 | 3;
  cols: number;
  rows: number;
  pages: EbookPreviewPage[];
  toc: { title: string; pageIdx: number }[];
}

// ---------------------------------------------------------------------------
//  Video pipeline (Step 10)
//
//  mp4/mkv/mov/avi → file .av (PDAV magic) per <mount>/video/.
//  Pipeline: ffmpeg estrae frame grayscale 536×336 + audio PCM s16le,
//  poi dithering JS + Sharp panel pack + mux audio_block + video_frame.
// ---------------------------------------------------------------------------

export type VideoDitherMode =
  | "threshold"
  | "floyd_steinberg"
  | "atkinson"
  | "bayer4"
  | "bayer8";

export type VideoFitMode = "fit" | "fill" | "stretch";

export interface VideoAdjustParams {
  brightness?: number;
  contrast?: number;
  gamma?: number;
  invert?: boolean;
}

export interface VideoConvertRequest {
  sourcePath: string;
  fps?: number;                       // default 30
  audioSampleRate?: number;           // default 48000
  audioChannels?: 1 | 2;              // default 2
  ditherMode?: VideoDitherMode;       // default "floyd_steinberg"
  threshold?: number;                 // per mode "threshold"
  adjust?: VideoAdjustParams;
  fitMode?: VideoFitMode;             // default "fit"
  mountPath?: string;
  folder?: string;                    // default "video"
  outputBaseName?: string;
  /** Cartella di destinazione assoluta per il local export. Se assente (e
   *  manca anche `mountPath`) si usa il default ~/Documents/Orion/video-export. */
  localOutDir?: string;
}

export interface VideoConvertResponse {
  outputPath: string;
  frameCount: number;
  bytes: number;
  durationSec: number;
  fps: number;
}

/**
 * Preview di un singolo frame video al timestamp richiesto: ffmpeg estrae il
 * frame, lo scala+letterbox a 536×336 e lo passa attraverso lo stesso dither
 * usato in convertVideo. Il renderer dipinge `pixels` su un canvas 536×336.
 */
export interface VideoPreviewRequest {
  sourcePath: string;
  /** Secondi del frame da estrarre (clamp 0..duration-epsilon). Default 0. */
  timeSec?: number;
  ditherMode?: VideoDitherMode;
  threshold?: number;
  adjust?: VideoAdjustParams;
  fitMode?: VideoFitMode;
}

export interface VideoPreviewResponse {
  /** Larghezza canvas (sempre LOGIC_W = 536). */
  width: number;
  /** Altezza canvas (sempre LOGIC_H = 336). */
  height: number;
  /** Pixels {0=nero, 1=chiaro}, length = width*height. */
  pixels: Uint8Array;
  /** Durata totale del video sorgente (sec). */
  durationSec: number;
  /** Tempo effettivamente decodificato (sec, dopo clamp). */
  timeSec: number;
}

/** Probe leggero del sorgente: solo durata, per inizializzare lo slider tempo. */
export interface VideoProbeRequest {
  sourcePath: string;
}

export interface VideoProbeResponse {
  durationSec: number;
}

export interface VideoProgressEvent {
  phase: "probe" | "audio" | "video" | "done" | "error";
  frame?: number;
  totalFrames?: number;
  percent?: number;
  error?: string;
}

export type VideoProgressListener = (ev: VideoProgressEvent) => void;

// ---------------------------------------------------------------------------
//  API esposta dal preload (window.orion)
// ---------------------------------------------------------------------------

export type DeviceChangedListener = (devices: DeviceInfo[]) => void;

export interface OrionAPI {
  ping: (req: PingRequest) => Promise<PingResponse>;

  system: {
    /** Versione app + OS + versioni runtime. Usata dal Bug Report modal. */
    info: () => Promise<SystemInfo>;
  };

  device: {
    /** One-shot scan dei mount points. */
    list: () => Promise<DeviceListResponse>;
    /** Avvia polling sul main (idempotente). */
    startWatch: () => Promise<void>;
    /** Ferma il polling. */
    stopWatch: () => Promise<void>;
    /** Eject sicuro del volume (diskutil/udisksctl/mountvol secondo OS). */
    eject: (req: DeviceEjectRequest) => Promise<DeviceEjectResponse>;
    /**
     * Registra un listener per ogni cambio di stato (connessione /
     * disconnessione). Ritorna una funzione di unsubscribe.
     */
    onChanged: (cb: DeviceChangedListener) => () => void;
  };

  storage: {
    /** Capienza + breakdown per categoria del device montato. */
    read: (req: DeviceStorageRequest) => Promise<DeviceStorageResponse>;
  };

  firmware: {
    /** Cerca un device STM32 in DFU mode (VID:PID 0483:df11). */
    detect: () => Promise<FirmwareDetectResponse>;
    /** Avvia il flash del firmware via dfu-util. */
    flash: (req: FirmwareFlashRequest) => Promise<FirmwareFlashResult>;
    /** Termina un flash in corso (best effort). */
    cancel: () => Promise<void>;
    /** Listener progresso (erase/write/verify + pct). Ritorna unsubscribe. */
    onProgress: (cb: FirmwareProgressListener) => () => void;
    /** Listener log raw (stdout/stderr di dfu-util, una linea per evento). */
    onLog: (cb: FirmwareLogListener) => () => void;

    /** Auto-update orchestration (manifest fetch + SD trigger). */
    update: {
      /** Current cached manifest + cache status. */
      getState: () => Promise<FirmwareUpdateState>;
      /** Force a manifest re-fetch and download of the .bin. */
      refresh: () => Promise<FirmwareUpdateState>;
      /** Listener for state changes. Returns unsubscribe. */
      onState: (cb: FirmwareUpdateStateListener) => () => void;
      /** Reads the running firmware version from the SD `.fwver` marker. */
      readSdVersion: (
        req: FirmwareSdVersionRequest,
      ) => Promise<FirmwareSdVersionResponse>;
      /** Writes empty `DFU` file at SD root, then ejects the volume. */
      triggerDfu: (
        req: FirmwareDfuTriggerRequest,
      ) => Promise<FirmwareDfuTriggerResponse>;
      /** Flashes the cached .bin once the device is in DFU mode. */
      flashCached: () => Promise<FirmwareFlashResult>;
      /** Clears the integrityError on the main-side state (call after
       *  the renderer has shown the popup to the user). */
      ackIntegrityError: () => Promise<FirmwareUpdateState>;
    };
  };

  files: {
    list: (req: FilesListRequest) => Promise<FilesListResponse>;
    del: (req: FilesDeleteRequest) => Promise<void>;
    upload: (req: FilesUploadRequest) => Promise<FilesUploadResponse>;
    mkdir: (req: FilesMkdirRequest) => Promise<FilesMkdirResponse>;
    rename: (req: FilesRenameRequest) => Promise<void>;
    copy: (req: FilesCopyRequest) => Promise<FilesCopyResponse>;
    move: (req: FilesMoveRequest) => Promise<FilesMoveResponse>;
  };

  notes: {
    /** Lista i file *.txt dentro <mountPath>/NOTE/ in modo ricorsivo
     *  (include sottocartelle). */
    list: (req: NoteListRequest) => Promise<NoteListResponse>;
    /** Albero ricorsivo di <mount>/NOTE/ (cartelle + .txt). */
    tree: (req: NoteTreeRequest) => Promise<NoteTreeResponse>;
    /** Legge il contenuto di una singola nota (UTF-8 best effort). */
    read: (req: NoteReadRequest) => Promise<NoteReadResponse>;
    /** Backup di una singola nota in targetDir (default = defaults.defaultBackupDir).
     *  Preserva la subdir relativa. */
    backup: (req: NoteBackupRequest) => Promise<NoteBackupResponse>;
    /** Backup di tutte le note del device. Mirror della gerarchia. */
    backupAll: (req: NoteBackupAllRequest) => Promise<NoteBackupAllResponse>;
    /** Path di default per il backup sul PC. */
    defaults: () => Promise<NoteDefaultsResponse>;
    /** Apre la cartella di backup nel file manager dell'OS. */
    revealBackupDir: (path: string) => Promise<void>;
    /** Crea una sottocartella dentro <mount>/NOTE/. */
    mkdir: (req: NoteMkdirRequest) => Promise<NoteMkdirResponse>;
    /** Rinomina file o folder (stesso parent). */
    rename: (req: NoteRenameRequest) => Promise<NoteRenameResponse>;
    /** Elimina file o folder ricorsivamente. */
    del: (req: NoteDeleteRequest) => Promise<void>;
    /** Copia file o folder (ricorsivo) dentro dstDir. */
    copy: (req: NoteCopyRequest) => Promise<NoteCopyResponse>;
    /** Sposta file o folder dentro dstDir. */
    move: (req: NoteMoveRequest) => Promise<NoteMoveResponse>;
    vaultStatus: (req: NoteVaultRequest) => Promise<NoteVaultStatus>;
    vaultUnlock: (req: NoteVaultUnlockRequest) => Promise<NoteVaultStatus>;
    vaultLock: (req: NoteVaultRequest) => Promise<NoteVaultStatus>;
    vaultImport: (req: NoteVaultImportRequest) => Promise<NoteVaultStatus>;
    vaultExport: (req: NoteVaultUnlockRequest) => Promise<NoteVaultExport>;
  };

  obsidian: {
    /** Apre un dialog nativo per scegliere la cartella vault. */
    pickVault: () => Promise<ObsidianPickVaultResponse>;
    /** Sincronizza in modo bidirezionale <mount>/NOTE/ con la vault. */
    sync: (req: ObsidianSyncRequest) => Promise<ObsidianSyncResponse>;
  };

  notion: {
    /** Avvia il flusso OAuth (browser + loopback). Risolve a connessione fatta. */
    connect: () => Promise<NotionConnectResponse>;
    /** Stato corrente della connessione Notion. */
    status: () => Promise<NotionStatusResponse>;
    /** Rimuove la connessione (token incluso) dal Mac. */
    disconnect: () => Promise<void>;
    /** Elenca le pagine condivise con l'integrazione (per scegliere il genitore). */
    listPages: () => Promise<NotionListPagesResponse>;
    /** Imposta la pagina genitore dove vivono le note. */
    setParent: (req: NotionSetParentRequest) => Promise<void>;
    /** Sincronizza in modo bidirezionale <mount>/NOTE/ con Notion. */
    sync: (req: NotionSyncRequest) => Promise<NotionSyncResponse>;
  };

  mp3: {
    /** Verifica disponibilità ffmpeg sul sistema. */
    probeFfmpeg: () => Promise<FfmpegProbe>;
    /** Avvia la conversione batch e l'upload sul device. */
    convert: (req: Mp3ConvertRequest) => Promise<Mp3ConvertResponse>;
    /** Listener per gli eventi di progresso. Ritorna unsubscribe. */
    onProgress: (cb: Mp3ProgressListener) => () => void;
  };

  cover: {
    /** Suggerisce copertine dai tag dei brani + ricerca iTunes. */
    suggest: (req: CoverSuggestRequest) => Promise<CoverSuggestResponse>;
    /** Ricerca copertine con termine libero (iTunes). */
    search: (req: CoverSearchRequest) => Promise<CoverSearchResponse>;
  };

  ebook: {
    /** Converte un singolo file .md/.txt/.epub/.pdf in .pdar e lo salva. */
    convert: (req: EbookConvertRequest) => Promise<EbookConvertResponse>;
    /** Reflow in memoria delle pagine, senza scrivere su disco — alimenta la
     *  preview canvas 536×336 nel renderer. */
    preview: (req: EbookPreviewRequest) => Promise<EbookPreviewResponse>;
    /** Listener per progresso conversione. Ritorna unsubscribe. */
    onProgress: (cb: EbookProgressListener) => () => void;
  };

  /** The App Store: Lua apps published by anyone, approved by a moderator,
   *  downloaded, rated and commented by everyone (a Cloudflare Worker). */
  store: {
    /** The signed-in account, or null. Refreshed from the server when online. */
    account: () => Promise<StoreAccount | null>;
    /** Login with GitHub in the system browser (loopback, like Notion). */
    signIn: () => Promise<StoreAccount>;
    signOut: () => Promise<void>;
    list: (req: StoreListRequest) => Promise<{ apps: StoreApp[] }>;
    detail: (slug: string) => Promise<StoreDetailResponse>;
    reviews: (slug: string) => Promise<{ reviews: StoreReview[] }>;
    review: (req: StoreReviewRequest) => Promise<void>;
    deleteReview: (slug: string) => Promise<void>;
    report: (req: StoreReportRequest) => Promise<void>;
    /** The apps on the card, and which version came from the store. */
    installed: (mountPath: string) => Promise<StoreInstalledResponse>;
    install: (req: StoreInstallRequest) => Promise<StoreInstallResponse>;
    uninstall: (req: StoreUninstallRequest) => Promise<void>;
    /** Choose an app's .lua on the computer and read it into a draft. */
    pickSource: () => Promise<StorePublishDraft | null>;
    /** Read again a source chosen before (after editing it). */
    readSource: (luaPath: string) => Promise<StorePublishDraft>;
    publish: (req: StorePublishRequest) => Promise<StorePublishResponse>;
    /** Choose screenshot images (PNG/JPEG) on the computer, with previews. */
    pickScreenshots: () => Promise<StoreShotFile[]>;
    /** One screenshot of a version, as a data: URL (the page's CSP allows
     *  only those, and a pending version's images need the token). */
    screenshot: (slug: string, version: string, index: number) => Promise<string>;
    /** A store app's package, for installing over Bluetooth (a download). */
    packageFiles: (slug: string, version?: string) => Promise<StoreTryPackage>;
    /** "Try": a store app's package for the emulator (not a download). */
    tryFiles: (slug: string, version?: string) => Promise<StoreTryPackage>;
    /** "Try in emulator" while publishing: the app as it is on disk. */
    localFiles: (luaPath: string, exclude?: string[]) => Promise<StoreTryPackage>;
    /** Keep an emulator capture (PNG data: URL) as a screenshot file. */
    saveCapture: (dataUrl: string) => Promise<StoreShotFile>;
    myApps: () => Promise<{ apps: StoreMyApp[] }>;
    withdraw: (versionId: number) => Promise<void>;
    // Moderators only (the server says no to everyone else).
    queue: () => Promise<{ queue: StoreQueueItem[] }>;
    decide: (req: StoreDecideRequest) => Promise<void>;
    setHidden: (slug: string, hidden: boolean) => Promise<void>;
    hideReview: (reviewId: number) => Promise<void>;
    reports: () => Promise<{ reports: StoreReport[] }>;
    resolveReport: (reportId: number) => Promise<void>;
    ban: (login: string, banned: boolean) => Promise<void>;
  };

  wiki: {
    /** What a ZIM says about itself, without converting. */
    info: (zimPath: string) => Promise<WikiInfoResponse>;
    /** Free bytes in a folder, -1 if unknown. */
    space: (dir: string) => Promise<number>;
    /** ZIM -> ORION Wiki folder. One at a time. */
    convert: (req: WikiConvertRequest) => Promise<WikiConvertResponse>;
    cancel: () => Promise<void>;
    onProgress: (cb: WikiProgressListener) => () => void;
  };

  video: {
    /** Verifica ffmpeg/ffprobe disponibili. */
    probeFfmpeg: () => Promise<FfmpegProbe>;
    /** Avvia conversione video → .av. */
    convert: (req: VideoConvertRequest) => Promise<VideoConvertResponse>;
    /** Listener per eventi di progresso. Ritorna unsubscribe. */
    onProgress: (cb: VideoProgressListener) => () => void;
    /** Probe leggero della durata del sorgente. */
    probe: (req: VideoProbeRequest) => Promise<VideoProbeResponse>;
    /** Estrae un singolo frame dithered alla posizione richiesta. */
    preview: (req: VideoPreviewRequest) => Promise<VideoPreviewResponse>;
  };

  ble: {
    mirrorState: () => Promise<BleMirrorState>;
    mirrorWrite: (req: { rel: string; dati: Uint8Array }) => Promise<void>;
    mirrorRead: (req: { rel: string }) => Promise<Uint8Array>;
    mirrorDelete: (req: { rel: string }) => Promise<void>;
    mirrorMkdir: (req: { rel: string }) => Promise<void>;
    mirrorSaveSnapshot: (s: BleSnapshot) => Promise<void>;
    readLocal: (req: { path: string }) => Promise<{ nome: string; dati: Uint8Array }>;
    tmpDir: () => Promise<string>;
  };

  calendario: {
    /** Chiede a macOS l'accesso al Calendario (la prima volta apre il pannello). */
    permesso: () => Promise<CalendarioPermessoResponse>;
    /** I calendari disponibili sul Mac. */
    elenco: () => Promise<CalendariListResponse>;
    /** Cosa verrebbe mandato, senza mandarlo. */
    anteprima: (req: CalendarioFinestra) => Promise<CalendarioAnteprima>;
    /** Scrive `<mount>/calendar/calendar.cal` sulla microSD. */
    scrivi: (req: CalendarioScriviRequest) => Promise<CalendarioScriviResponse>;
    /** Il `.cal` in memoria, per mandarlo via Bluetooth dal renderer. */
    dati: (req: CalendarioFinestra) => Promise<CalendarioDatiResponse>;
  };

  fs: {
    /** Ottiene il path filesystem di un File ricevuto via drag&drop.
     *  In Electron 30 con sandbox, File.path è undefined: serve webUtils. */
    getPathForFile: (file: File) => string;
    /** Espande una lista di path (file e/o directory) nei soli file audio
     *  contenuti (walk ricorsivo, dotfiles esclusi). */
    expandAudioPaths: (paths: string[]) => Promise<string[]>;
    /** Apre il directory picker nativo dell'OS. */
    chooseDirectory: () => Promise<string | null>;
    /** True se il path è una directory esistente. */
    isDirectory: (p: string) => Promise<boolean>;
  };
}

/* ==========================================================================
 *  Calendario  (vedi PDAV3/CALENDARIO.md)
 * ========================================================================== */

export interface CalendarioVoce {
  id: string;
  nome: string;
  conto: string;
  /** "#RRGGBB", per il pallino nella lista. Sul dispositivo non arriva. */
  colore: string;
}

export interface CalendariListResponse {
  ok: boolean;
  errore?: string;
  calendari: CalendarioVoce[];
}

export interface CalendarioPermessoResponse {
  ok: boolean;
  /** "ok" | "negato" | "da chiedere" | "solo scrittura" | ... */
  stato: string;
}

export interface CalendarioFinestra {
  /** Giorni indietro da oggi. */
  indietro?: number;
  /** Giorni in avanti. */
  avanti?: number;
  /** Id dei calendari scelti: vuoto vuol dire **niente**, non "tutti". */
  calendari: string[];
  /**
   * Percorso di un file `.ics` da usare **al posto** del Calendario di
   * sistema. E' la strada per Windows e Linux, dove il calendario di sistema
   * non e' raggiungibile da un'app non impacchettata, e per chi su macOS non
   * vuole concedere il permesso.
   */
  ics?: string;
}

export interface CalendarioInfo {
  /** Record scritti: gli eventi lunghi ne producono uno per giorno. */
  eventi: number;
  /** Eventi di partenza, prima dello spezzamento. */
  origine: number;
  byte: number;
  calendari: string[];
  /** Si e' superato il tetto di 2000 record del lettore. */
  troncati: boolean;
}

export interface CalendarioAnteprima extends CalendarioInfo {
  ok: boolean;
  errore?: string;
  /** Prime righe gia' tradotte nei caratteri che il display sa disegnare. */
  esempi: string[];
}

export interface CalendarioScriviRequest extends CalendarioFinestra {
  /** Radice della microSD (mountPath del dispositivo). */
  mountPath: string;
}

export interface CalendarioDatiResponse {
  ok: boolean;
  errore?: string;
  /** Il `.cal` gia' pronto, da mandare via Bluetooth. */
  dati?: Uint8Array;
  info?: CalendarioInfo;
}

export interface CalendarioScriviResponse {
  ok: boolean;
  errore?: string;
  percorso?: string;
  info?: CalendarioInfo;
}

/* ==========================================================================
 *  Wikipedia: a Kiwix ZIM -> the ORION Wiki format (src/main/wiki)
 * ========================================================================== */
export interface WikiInfoResponse {
  titolo: string;
  lingua: string;
  data: string;
  descrizione: string;
  articoli: number;
  /** Bytes of the ZIM file. */
  dimensione: number;
}

export interface WikiConvertRequest {
  zimPath: string;
  /** Mount point of ORION's card: the folder goes in <mount>/wiki/<nome>. */
  mountPath?: string;
  /** Or a folder on the computer: the folder goes in <localOutDir>/<nome>. */
  localOutDir?: string;
  /** Folder name, e.g. "it_top". */
  nome: string;
}

export interface WikiConvertResponse {
  outputPath: string;
  articoli: number;
  titoli: number;
  geo: number;
  byte: number;
  secondi: number;
}

export interface WikiProgressEvent {
  fase: "elenco" | "testo" | "indici" | "fatto";
  fatti: number;
  totale: number;
}

export type WikiProgressListener = (ev: WikiProgressEvent) => void;

// ===========================================================================
//  App Store (src/main/store, server in store/)
// ===========================================================================

export const STORE_CATEGORIES = ["games", "office", "utility", "radio", "music", "dev", "other"] as const;
export type StoreCategory = (typeof STORE_CATEGORIES)[number];

/** What the server can tell from an app's code; shown before installing.
 *  `shared` = reads and writes the whole card. */
export type StoreFlag = "shared" | "serial" | "gpio" | "i2c" | "ble" | "mesh" | "compiled";

export interface StoreAccount {
  login: string;
  avatar: string | null;
  admin: boolean;
}

export interface StoreListRequest {
  q?: string;
  category?: string;
  sort?: "popular" | "rating" | "new";
}

export interface StoreApp {
  slug: string;
  title: string;
  summary: string;
  category: string;
  author: string;
  version: string | null;
  minApi: string | null;
  size: number | null;
  sha256: string | null;
  flags: StoreFlag[];
  /** Average of the stars, one decimal; null with no votes. */
  rating: number | null;
  ratings: number;
  downloads: number;
  updatedAt: string;
  /** How many screenshots the shown version has. */
  screenshots: number;
}

export interface StoreAppDetail extends StoreApp {
  description: string;
  hidden: boolean;
  public: boolean;
  isOwner: boolean;
}

export interface StoreVersion {
  id: number;
  version: string;
  status: "pending" | "approved" | "rejected";
  changelog: string;
  rejectReason?: string | null;
  createdAt: string;
  reviewedAt: string | null;
  screenshots: number;
}

export interface StoreDetailResponse {
  app: StoreAppDetail;
  versions: StoreVersion[];
  /** Votes with 1..5 stars, in this order. */
  histogram: number[];
  myReview: { stars: number; body: string } | null;
}

export interface StoreReview {
  id: number;
  login: string;
  avatar: string | null;
  stars: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoreReviewRequest {
  slug: string;
  stars: number;
  body: string;
}

export interface StoreReportRequest {
  slug: string;
  reason: string;
}

export interface StoreInstalled {
  slug: string;
  /** The store version installed by the Companion; null if the app was
   *  copied by hand (or is not from the store). */
  version: string | null;
  hasData: boolean;
}

export interface StoreInstalledResponse {
  apps: StoreInstalled[];
  /** How many scripts the launcher can list (SCRIPT_MAX - 1 in app_launcher.c). */
  limit: number;
}

export interface StoreInstallRequest {
  mountPath: string;
  slug: string;
  /** Only for the author or a moderator: a version not yet approved. */
  version?: string;
}

export interface StoreInstallResponse {
  version: string;
  written: string[];
}

export interface StoreUninstallRequest {
  mountPath: string;
  slug: string;
  /** Also delete /apps/data/<slug>/: the app's saved data and assets. */
  removeData: boolean;
}

export interface StoreManifest {
  slug: string;
  title: string;
  summary: string;
  description: string;
  category: string;
  version: string;
  changelog: string;
  minApi: string;
}

/** An app read from the computer, ready to be completed and published. */
export interface StorePublishDraft extends StoreManifest {
  luaPath: string;
  /** Every file found; `excluded` = left out of the package (the author
   *  can change it: README, sources and tools are out by default). */
  files: { path: string; size: number; excluded: boolean }[];
  totalSize: number;
  flags: StoreFlag[];
  /** Problems that block publishing (bad name, script over 32 KB...). */
  errors: string[];
  /** Things worth knowing (files skipped, no data folder...). */
  warnings: string[];
}

export interface StorePublishRequest {
  luaPath: string;
  manifest: StoreManifest;
  /** Data paths left out of the package (StorePublishDraft.files). */
  exclude: string[];
  /** Image files, in the order shown. Empty on an update: the approved
   *  version's screenshots carry over. */
  screenshots: string[];
}

export interface StorePublishResponse {
  slug: string;
  version: string;
  status: "pending";
  flags: StoreFlag[];
  screenshots: number;
  screenshotsInherited: boolean;
}

/** An app's files as the store packs them: `<slug>.lua` and `data/...`. */
export interface StoreTryPackage {
  slug: string;
  version: string;
  files: { path: string; b64: string }[];
}

export interface StoreShotFile {
  path: string;
  size: number;
  /** Preview, data: URL. Empty when the file is refused. */
  dataUrl: string;
  /** Why it cannot be sent (not PNG/JPEG, over 1 MB...). */
  error?: string;
}

export interface StoreMyApp {
  slug: string;
  title: string;
  hidden: boolean;
  public: boolean;
  downloads: number;
  rating: number | null;
  ratings: number;
  versions: { id: number; version: string; status: StoreVersion["status"]; rejectReason: string | null; createdAt: string }[];
}

export interface StoreQueueItem {
  id: number;
  slug: string;
  version: string;
  author: string;
  isNew: boolean;
  title: string;
  summary: string;
  description: string;
  category: string;
  changelog: string;
  minApi: string | null;
  size: number;
  sha256: string;
  flags: StoreFlag[];
  screenshots: number;
  createdAt: string;
}

export interface StoreDecideRequest {
  versionId: number;
  action: "approve" | "reject";
  reason?: string;
}

export interface StoreReport {
  id: number;
  slug: string;
  title: string;
  login: string;
  reason: string;
  createdAt: string;
}
