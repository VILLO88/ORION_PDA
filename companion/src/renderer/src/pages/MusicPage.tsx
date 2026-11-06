import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FC,
} from "react";
import {
  Music2,
  Upload,
  Trash2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  X,
  FolderOpen,
  ChevronDown,
  Search,
  ImageOff,
  Info,
} from "lucide-react";
import { useDevices } from "@/lib/DeviceContext";
import { useActivity } from "@/lib/ActivityContext";
import { api, isElectron } from "@/lib/api";
import type {
  FfmpegProbe,
  Mp3ProgressEvent,
  CoverCandidate,
  Mp3CoverChoice,
} from "@shared/ipc-types";

/** Selezione copertina nel picker: id candidato iTunes, oppure sentinelle. */
const COVER_EMBEDDED = "__embedded__";
const COVER_NONE = "__none__";

const AUDIO_EXT = [
  ".mp3", ".flac", ".wav", ".m4a", ".aac",
  ".ogg", ".opus", ".wma", ".aif", ".aiff",
];

function isAudioPath(p: string): boolean {
  const lower = p.toLowerCase();
  return AUDIO_EXT.some((e) => lower.endsWith(e));
}

function basenameNoExt(p: string): string {
  const lastSep = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  const fname = lastSep >= 0 ? p.slice(lastSep + 1) : p;
  const dot = fname.lastIndexOf(".");
  return dot > 0 ? fname.slice(0, dot) : fname;
}

/** Basename di un path/directory (senza extension stripping). */
function basenameOf(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, "");
  const lastSep = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return lastSep >= 0 ? trimmed.slice(lastSep + 1) : trimmed;
}

/** Folder name FAT-friendly: rimuove caratteri illegali. */
function sanitizeFolderName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
}

/** Limite firmware Orion per nomi di brano/album (caratteri, spazi e
 *  caratteri speciali inclusi). */
const MAX_NAME_LEN = 47;

/** Conta i caratteri "logici" (code point, normalizzati NFC) in modo
 *  coerente col conteggio del firmware. */
function nameLength(s: string): number {
  return [...s.normalize("NFC")].length;
}

/** Rimuove numeri e caratteri speciali iniziali dal nome di un brano.
 *  Es. "02.Hello" -> "Hello", "01 - Intro" -> "Intro". Se il risultato
 *  sarebbe vuoto (nome interamente numerico/simbolico) mantiene il nome
 *  originale ripulito. */
function cleanTrackName(name: string): string {
  const cleaned = name.replace(/^[^\p{L}]+/u, "").trim();
  return cleaned.length > 0 ? cleaned : name.trim();
}

/** Costruisce il path-cartella di destinazione per il device a partire da
 *  genere / artista / album. Risultato del tipo "Rock/John Mayer/Born and
 *  Raised". Segmenti vuoti vengono scartati, così combinazioni parziali
 *  (solo album, genere+album, ecc.) restano valide. */
function buildDeviceFolder(genre: string, artist: string, album: string): string {
  return [
    sanitizeFolderName(genre),
    sanitizeFolderName(artist),
    sanitizeFolderName(album),
  ]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("/");
}

/** Voce in attesa di correzione perché supera MAX_NAME_LEN. */
interface LongName {
  kind: "genre" | "artist" | "album" | "track";
  /** Indice nel jobs[] per i brani; -1 per genere/artista/album. */
  jobIndex: number;
  /** Path sorgente (solo per i brani), mostrato come riferimento. */
  source: string;
  value: string;
}

interface QueuedJob {
  sourcePath: string;
  displayName: string;
  status: "queued" | "probing" | "converting" | "done" | "error";
  percent: number;
  error?: string;
}

const StatusIcon: FC<{ s: QueuedJob["status"] }> = ({ s }) => {
  switch (s) {
    case "queued":     return <span className="h-4 w-4 rounded-full border border-zinc-300 dark:border-zinc-600" />;
    case "probing":    return <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />;
    case "converting": return <Loader2 className="h-4 w-4 animate-spin text-accent" />;
    case "done":       return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
    case "error":      return <XCircle className="h-4 w-4 text-red-500" />;
  }
};

/** Tile selezionabile del picker copertina (immagine o icona + etichetta). */
const CoverTile: FC<{
  selected: boolean;
  onClick: () => void;
  label: string;
  img?: string;
  disabled?: boolean;
  children?: React.ReactNode;
}> = ({ selected, onClick, label, img, disabled, children }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    title={label}
    className={`group flex w-20 flex-col items-center gap-1 rounded-lg border p-1.5 transition-colors disabled:opacity-50 ${
      selected
        ? "border-accent ring-2 ring-accent"
        : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700"
    }`}
  >
    <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800">
      {img ? (
        <img src={img} alt={label} className="h-full w-full object-cover" />
      ) : (
        children
      )}
    </div>
    <span className="w-full truncate text-center text-[10px] text-zinc-500 dark:text-zinc-400">
      {label}
    </span>
  </button>
);

const MusicPage = () => {
  const { devices } = useDevices();
  const device = devices[0] ?? null;
  const { log: logActivity } = useActivity();

  const [probe, setProbe] = useState<FfmpegProbe | null>(null);
  const [folder, setFolder] = useState<string>("music");
  const [folderTouched, setFolderTouched] = useState(false);
  // Cartella "genere" padre sul device (es. Rock) sotto cui finisce l'artista.
  const [genre, setGenre] = useState<string>("");
  // Cartella "artista" intermedia (music/<genere>/<artista>/<album>).
  const [artist, setArtist] = useState<string>("");
  // Cartelle già presenti sotto <mount>/music/ per il dropdown.
  const [genreFolders, setGenreFolders] = useState<string[]>([]);
  // "Auto": deduce genere/artista/album online dopo la scelta dell'album.
  const [auto, setAuto] = useState<boolean>(true);
  const autoRef = useRef(true);
  useEffect(() => {
    autoRef.current = auto;
  }, [auto]);
  // Ultimo suggerimento (artista/genere/album) ricavato online, per poterlo
  // applicare se l'utente attiva "Auto" dopo aver già selezionato l'album.
  const suggestionRef = useRef<{ artist: string; genre: string; album: string } | null>(
    null,
  );
  const [jobs, setJobs] = useState<QueuedJob[]>([]);
  const [running, setRunning] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [target, setTarget] = useState<"device" | "local">(
    device ? "device" : "local",
  );
  const [localOutDir, setLocalOutDir] = useState("");
  // Nomi che superano MAX_NAME_LEN, in attesa di correzione nel popup.
  const [nameFixes, setNameFixes] = useState<LongName[] | null>(null);
  // --- Copertina album (ricerca online iTunes) ---
  const [coverResults, setCoverResults] = useState<CoverCandidate[]>([]);
  const [coverSel, setCoverSel] = useState<string>(COVER_NONE);
  const [coverTerm, setCoverTerm] = useState<string>("");
  const [coverTermTouched, setCoverTermTouched] = useState(false);
  const [coverLoading, setCoverLoading] = useState(false);
  const [embeddedThumb, setEmbeddedThumb] = useState<string | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const firstSource = jobs[0]?.sourcePath;

  // Ref ai valori correnti per l'effect di suggerimento copertine, che si
  // rigenera solo al cambio del primo brano ma deve leggere l'intera coda.
  const jobsRef = useRef<QueuedJob[]>([]);
  const folderRef = useRef<string>("");
  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);
  useEffect(() => {
    folderRef.current = folder;
  }, [folder]);

  /** Decisione copertina effettiva derivata dalla selezione nel picker. */
  const coverChoice = useMemo<Mp3CoverChoice>(() => {
    if (coverSel === COVER_NONE) return { kind: "none" };
    if (coverSel === COVER_EMBEDDED) return { kind: "embedded" };
    const c = coverResults.find((r) => r.id === coverSel);
    if (c) return { kind: "url", url: c.imageUrl };
    return embeddedThumb ? { kind: "embedded" } : { kind: "none" };
  }, [coverSel, coverResults, embeddedThumb]);

  /** Azzera lo stato del picker copertina (per iniziare un album pulito). */
  const resetCoverState = useCallback(() => {
    setCoverResults([]);
    setCoverSel(COVER_NONE);
    setEmbeddedThumb(undefined);
    setCoverTerm("");
    setCoverTermTouched(false);
    suggestionRef.current = null;
  }, []);

  // Se il device viene scollegato durante l'uso, switcha automaticamente a local.
  useEffect(() => {
    if (!device && target === "device") setTarget("local");
  }, [device, target]);

  // Probe ffmpeg al mount
  useEffect(() => {
    if (!isElectron) return;
    void api.mp3.probeFfmpeg().then(setProbe);
  }, []);

  // Carica le cartelle "genere" esistenti sotto <mount>/music/ per il dropdown.
  const reloadGenres = useCallback(async () => {
    if (target !== "device" || !device) {
      setGenreFolders([]);
      return;
    }
    try {
      const res = await api.files.list({ path: `${device.mountPath}/music` });
      setGenreFolders(
        res.entries.filter((e) => e.isDirectory).map((e) => e.name).sort(),
      );
    } catch {
      // /music/ non esiste ancora o device non leggibile: nessun suggerimento.
      setGenreFolders([]);
    }
  }, [target, device]);

  useEffect(() => {
    void reloadGenres();
  }, [reloadGenres]);

  /** Compila genere/artista/album dai dati dedotti online (sanitizzati, così i
   *  campi mostrano esattamente i nomi cartella che verranno creati). */
  const applyAutoFill = useCallback(
    (s: { artist: string; genre: string; album: string }) => {
      if (s.genre) setGenre(sanitizeFolderName(s.genre));
      if (s.artist) setArtist(sanitizeFolderName(s.artist));
      if (s.album) {
        setFolder(sanitizeFolderName(s.album));
        setFolderTouched(true);
      }
    },
    [],
  );

  /** Auto-suggerimento copertine: quando cambia il primo brano in coda legge i
   *  tag (artista/album) e interroga iTunes. Online prioritario → pre-seleziona
   *  il primo risultato, altrimenti la cover embedded, altrimenti nessuna.
   *  Se "Auto" è attivo, compila anche genere/artista/album. */
  useEffect(() => {
    if (!firstSource) {
      setCoverResults([]);
      setEmbeddedThumb(undefined);
      setCoverSel(COVER_NONE);
      setCoverTermTouched(false);
      return;
    }
    let cancelled = false;
    setCoverLoading(true);
    void api.cover
      .suggest({
        sourcePaths: jobsRef.current.map((j) => j.sourcePath),
        albumHint: folderRef.current.trim(),
      })
      .then((res) => {
        if (cancelled) return;
        setCoverResults(res.results);
        setEmbeddedThumb(res.embeddedThumb);
        if (res.term && !coverTermTouched) setCoverTerm(res.term);
        setCoverSel(
          res.results.length > 0
            ? res.results[0].id
            : res.embeddedThumb
              ? COVER_EMBEDDED
              : COVER_NONE,
        );
        // Suggerimento genere/artista/album dal miglior risultato online.
        const best = res.results[0];
        const suggestion = {
          artist: best?.artist || res.artist || "",
          genre: best?.genre || "",
          album: best?.title || res.album || "",
        };
        suggestionRef.current = suggestion;
        if (autoRef.current) applyAutoFill(suggestion);
      })
      .finally(() => {
        if (!cancelled) setCoverLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Si rigenera solo al cambio del primo brano: evita query a ogni keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstSource]);

  const toggleAuto = useCallback(() => {
    setAuto((prev) => {
      const next = !prev;
      // Attivando Auto applico subito l'ultimo suggerimento online disponibile.
      if (next && suggestionRef.current) applyAutoFill(suggestionRef.current);
      return next;
    });
  }, [applyAutoFill]);

  const onManualCoverSearch = useCallback(async () => {
    const term = coverTerm.trim();
    if (!term) return;
    setCoverLoading(true);
    try {
      const res = await api.cover.search({ term });
      setCoverResults(res.results);
      setCoverSel(
        res.results.length > 0
          ? res.results[0].id
          : embeddedThumb
            ? COVER_EMBEDDED
            : COVER_NONE,
      );
    } finally {
      setCoverLoading(false);
    }
  }, [coverTerm, embeddedThumb]);

  // Subscribe a mp3:progress
  useEffect(() => {
    const unsub = api.mp3.onProgress((ev: Mp3ProgressEvent) => {
      setJobs((prev) =>
        prev.map((j, i) => {
          if (i !== ev.jobIndex) return j;
          if (ev.phase === "probe") return { ...j, status: "probing" };
          if (ev.phase === "convert")
            return {
              ...j,
              status: "converting",
              percent: ev.percent ?? j.percent,
            };
          if (ev.phase === "done")
            return { ...j, status: "done", percent: 100 };
          if (ev.phase === "error")
            return { ...j, status: "error", error: ev.error };
          return j;
        }),
      );
    });
    return unsub;
  }, []);

  /** Aggiunge alla queue una lista di path arbitrari (file e/o directory).
   *  Le directory vengono espanse ricorsivamente lato main. Se gli input
   *  contengono almeno una directory e l'utente non ha ancora toccato il
   *  campo folder, suggerisco il basename della prima directory come nome
   *  di destinazione. */
  const addPaths = useCallback(
    async (paths: string[]) => {
      const cleaned = paths.filter((p) => !!p);
      if (cleaned.length === 0) return;

      setScanning(true);
      try {
        // Se la coda precedente è un batch già convertito (tutti done/error e
        // non in esecuzione), una nuova selezione avvia un album pulito:
        // svuota coda + copertina e riabilita l'auto-detect del nome album.
        const prevJobs = jobsRef.current;
        const batchFinished =
          prevJobs.length > 0 &&
          !running &&
          prevJobs.every((j) => j.status === "done" || j.status === "error");
        let touched = folderTouched;
        if (batchFinished) {
          setJobs([]);
          setFolderTouched(false);
          touched = false;
          resetCoverState();
        }

        // Auto-folder name: identifica la prima directory tra gli input.
        if (!touched) {
          for (const p of cleaned) {
            if (await api.fs.isDirectory(p)) {
              const suggested = sanitizeFolderName(basenameOf(p));
              if (suggested) setFolder(suggested);
              break;
            }
          }
        }

        const audio = await api.fs.expandAudioPaths(cleaned);

        setJobs((prev) => {
          const base = batchFinished ? [] : prev;
          const existing = new Set(base.map((j) => j.sourcePath));
          const fresh = audio
            .filter((p) => isAudioPath(p) && !existing.has(p))
            .map<QueuedJob>((p) => ({
              sourcePath: p,
              // Ripulisce numeri/caratteri speciali iniziali (es. "02.Hello").
              displayName: cleanTrackName(basenameNoExt(p)),
              status: "queued",
              percent: 0,
            }));
          return [...base, ...fresh];
        });
      } finally {
        setScanning(false);
      }
    },
    [folderTouched, running, resetCoverState],
  );

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      const paths = files
        .map((f) => api.fs.getPathForFile(f))
        .filter((p) => !!p);
      void addPaths(paths);
    },
    [addPaths],
  );

  const onPickFiles = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      const paths = files
        .map((f) => api.fs.getPathForFile(f))
        .filter((p) => !!p);
      void addPaths(paths);
      e.target.value = "";
    },
    [addPaths],
  );

  const onChooseFolder = useCallback(async () => {
    const dir = await api.fs.chooseDirectory();
    if (!dir) return;
    await addPaths([dir]);
  }, [addPaths]);

  const removeJob = (idx: number) => {
    if (running) return;
    setJobs((prev) => prev.filter((_, i) => i !== idx));
  };

  const clearAll = () => {
    if (running) return;
    setJobs([]);
    setFolderTouched(false);
    setArtist("");
    resetCoverState();
  };

  /** Path-cartella di destinazione (relativo a /music/ o a localOutDir):
   *  - device: <genere>/<album> (segmenti vuoti scartati)
   *  - local:  <album> */
  const effectiveFolder = useMemo(() => {
    if (target === "device") return buildDeviceFolder(genre, artist, folder);
    return sanitizeFolderName(folder).trim();
  }, [target, genre, artist, folder]);

  const canRun =
    !!probe?.available &&
    jobs.length > 0 &&
    !running &&
    effectiveFolder.length > 0 &&
    (target === "local" || !!device);

  /** Esegue effettivamente la conversione batch con i job/folder dati
   *  (già validati / corretti rispetto al limite di MAX_NAME_LEN). */
  const runConvert = useCallback(
    async (jobsToRun: QueuedJob[], folderName: string) => {
      if (target === "device" && !device) return;
      setRunning(true);
      setJobs((prev) =>
        prev.map((j) => ({ ...j, status: "queued", percent: 0, error: undefined })),
      );
      const totalCount = jobsToRun.length;
      try {
        const r = await api.mp3.convert({
          mountPath: target === "device" ? device?.mountPath : undefined,
          folder: folderName,
          jobs: jobsToRun.map((j) => ({
            sourcePath: j.sourcePath,
            // Il nome (ripulito/corretto) diventa il filename di output.
            outputBaseName: j.displayName,
          })),
          localOutDir:
            target === "local" && localOutDir.trim().length > 0
              ? localOutDir.trim()
              : undefined,
          cover: coverChoice,
        });
        const ok = r.results.filter((x) => x.ok).length;
        const ko = r.results.length - ok;
        logActivity({
          kind: "mp3-convert",
          status: ko === 0 ? "ok" : "error",
          title:
            ko === 0
              ? `${ok} track${ok === 1 ? "" : "s"} added to ${folderName}`
              : `${ok} ok, ${ko} failed in ${folderName}`,
          detail: `${totalCount} file${totalCount === 1 ? "" : "s"}${
            r.coverWritten ? " · cover ✓" : ""
          }`,
        });
      } catch (e) {
        console.error(e);
        logActivity({
          kind: "mp3-convert",
          status: "error",
          title: `Music conversion failed`,
          detail: (e as Error).message,
        });
      } finally {
        setRunning(false);
        // Una nuova cartella genere/album può essere stata creata: aggiorna il
        // dropdown.
        void reloadGenres();
      }
    },
    [target, device, localOutDir, logActivity, reloadGenres, coverChoice],
  );

  /** Click su "Convert & upload": prima controlla che nessun nome di
   *  brano o dell'album superi il limite firmware. Se trova nomi troppo
   *  lunghi apre il popup di correzione, altrimenti avvia la conversione. */
  const handleConvertClick = useCallback(() => {
    if (!canRun) return;
    const albumName = folder.trim();
    const genreName = genre.trim();
    const artistName = artist.trim();
    const offenders: LongName[] = [];
    // Genere/artista/album sono segmenti distinti del path: ciascuno è una
    // cartella sul device e deve rispettare il limite da solo.
    if (target === "device" && genreName && nameLength(genreName) > MAX_NAME_LEN) {
      offenders.push({ kind: "genre", jobIndex: -1, source: "", value: genreName });
    }
    if (target === "device" && artistName && nameLength(artistName) > MAX_NAME_LEN) {
      offenders.push({ kind: "artist", jobIndex: -1, source: "", value: artistName });
    }
    if (albumName && nameLength(albumName) > MAX_NAME_LEN) {
      offenders.push({ kind: "album", jobIndex: -1, source: "", value: albumName });
    }
    jobs.forEach((j, i) => {
      if (nameLength(j.displayName) > MAX_NAME_LEN) {
        offenders.push({
          kind: "track",
          jobIndex: i,
          source: j.sourcePath,
          value: j.displayName,
        });
      }
    });
    if (offenders.length > 0) {
      setNameFixes(offenders);
      return;
    }
    void runConvert(jobs, effectiveFolder);
  }, [canRun, folder, genre, artist, target, jobs, effectiveFolder, runConvert]);

  /** Applica le correzioni del popup e avvia la conversione. */
  const applyNameFixes = useCallback(
    (fixed: LongName[]) => {
      let newGenre = genre.trim();
      let newArtist = artist.trim();
      let newAlbum = folder.trim();
      const corrections = new Map<number, string>();
      for (const f of fixed) {
        const v = f.value.trim();
        if (f.kind === "genre") newGenre = v;
        else if (f.kind === "artist") newArtist = v;
        else if (f.kind === "album") newAlbum = v;
        else corrections.set(f.jobIndex, v);
      }
      const newJobs = jobs.map((j, i) =>
        corrections.has(i) ? { ...j, displayName: corrections.get(i)! } : j,
      );
      if (newGenre !== genre.trim()) setGenre(newGenre);
      if (newArtist !== artist.trim()) setArtist(newArtist);
      if (newAlbum !== folder.trim()) {
        setFolder(newAlbum);
        setFolderTouched(true);
      }
      setJobs(newJobs);
      setNameFixes(null);
      const targetFolder =
        target === "device"
          ? buildDeviceFolder(newGenre, newArtist, newAlbum)
          : sanitizeFolderName(newAlbum).trim();
      void runConvert(newJobs, targetFolder);
    },
    [genre, artist, folder, target, jobs, runConvert],
  );

  // Stats compact summary
  const stats = useMemo(() => {
    const done = jobs.filter((j) => j.status === "done").length;
    const err = jobs.filter((j) => j.status === "error").length;
    return { total: jobs.length, done, err };
  }, [jobs]);

  // Avanzamento complessivo per la status bar (include la frazione del brano
  // attualmente in conversione → percentuale fluida in realtime).
  const prog = useMemo(() => {
    const total = jobs.length;
    if (total === 0) {
      return { overall: 0, doneW: 0, errW: 0, curW: 0, curName: "", remaining: 0 };
    }
    const doneCount = jobs.filter((j) => j.status === "done").length;
    const errCount = jobs.filter((j) => j.status === "error").length;
    let curFrac = 0;
    let curName = "";
    for (const j of jobs) {
      if (j.status === "converting") {
        curFrac += j.percent / 100;
        if (!curName) curName = j.displayName;
      } else if (j.status === "probing" && !curName) {
        curName = j.displayName;
      }
    }
    const doneW = (doneCount / total) * 100;
    const errW = (errCount / total) * 100;
    const curW = (curFrac / total) * 100;
    return {
      overall: doneW + errW + curW,
      doneW,
      errW,
      curW,
      curName,
      remaining: total - doneCount - errCount,
    };
  }, [jobs]);

  // ---- Render -------------------------------------------------------------

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto pb-2">
      {/* ffmpeg detection banner */}
      {probe && !probe.available && (
        <div className="ui-card flex items-start gap-3 border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-500/50 dark:bg-amber-500/10 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">ffmpeg not found.</p>
            <p className="mt-1 opacity-80">
              Conversion requires{" "}
              <code className="rounded bg-black/10 px-1 dark:bg-black/30">
                ffmpeg
              </code>{" "}
              installed and on the <code>PATH</code>.
            </p>
            <p className="mt-2 text-xs opacity-70">
              macOS: <code>brew install ffmpeg</code> · Ubuntu/Debian:{" "}
              <code>sudo apt install ffmpeg</code> · Windows: download from
              ffmpeg.org and add it to PATH.
            </p>
            {probe.error && (
              <p className="mt-2 text-xs opacity-60">
                Dettaglio: {probe.error}
              </p>
            )}
          </div>
        </div>
      )}

      {probe?.available && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {probe.versionLine}
        </p>
      )}

      {/* Output target + folder + actions */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
            Output
          </label>
          <div className="flex overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
            <button
              type="button"
              onClick={() => setTarget("device")}
              disabled={running || !device}
              className={`px-3 py-1.5 text-sm transition-colors disabled:opacity-50 ${
                target === "device"
                  ? "bg-accent text-white"
                  : "bg-white text-zinc-700 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
              }`}
            >
              Device {!device && "(none)"}
            </button>
            <button
              type="button"
              onClick={() => setTarget("local")}
              disabled={running}
              className={`px-3 py-1.5 text-sm transition-colors disabled:opacity-50 ${
                target === "local"
                  ? "bg-accent text-white"
                  : "bg-white text-zinc-700 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
              }`}
            >
              Local export
            </button>
          </div>
        </div>

        {target === "device" && (
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              Rilevamento
            </label>
            <label
              title={
                "Auto: dopo aver selezionato un album, la Companion cerca online " +
                "(iTunes) artista e genere e compila automaticamente Genere, " +
                "Artista e Album, creando le cartelle in " +
                "/music/<genere>/<artista>/<album>/. Puoi sempre modificare i " +
                "campi a mano; disattiva Auto per impostarli solo manualmente."
              }
              className="flex h-[34px] cursor-pointer items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 dark:border-zinc-800 dark:bg-zinc-900"
            >
              <input
                type="checkbox"
                checked={auto}
                onChange={toggleAuto}
                disabled={running}
                className="h-4 w-4 accent-accent"
              />
              <span className="text-sm text-zinc-700 dark:text-zinc-200">
                Auto
              </span>
              <Info className="h-3.5 w-3.5 text-zinc-400" />
            </label>
          </div>
        )}

        {target === "device" && (
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              Genere (cartella sotto /music/)
            </label>
            <div className="relative">
              <input
                type="text"
                list="genre-folders"
                value={genre}
                onChange={(e) => setGenre(e.target.value)}
                disabled={running}
                placeholder="es. Rock — scegli o crea"
                className="w-44 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 pr-8 text-sm text-zinc-900 placeholder-zinc-400 focus:border-accent focus:outline-none dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 disabled:opacity-50"
              />
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <datalist id="genre-folders">
                {genreFolders.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </div>
          </div>
        )}

        {target === "device" && (
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              Artista (sottocartella)
            </label>
            <input
              type="text"
              value={artist}
              onChange={(e) => setArtist(e.target.value)}
              disabled={running}
              placeholder="es. John Mayer"
              className="w-44 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-900 placeholder-zinc-400 focus:border-accent focus:outline-none dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 disabled:opacity-50"
            />
          </div>
        )}

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
            {target === "device"
              ? "Album (sottocartella)"
              : "Subfolder (album name)"}
          </label>
          <input
            type="text"
            value={folder}
            onChange={(e) => {
              setFolder(e.target.value);
              setFolderTouched(true);
            }}
            disabled={running}
            placeholder="es. Greatest Hits"
            className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-900 placeholder-zinc-400 focus:border-accent focus:outline-none dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 disabled:opacity-50"
          />
        </div>

        {target === "local" && (
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              Destination folder
            </label>
            <div className="flex items-stretch gap-1">
              <input
                type="text"
                value={localOutDir}
                onChange={(e) => setLocalOutDir(e.target.value)}
                disabled={running}
                placeholder="~/Documents/Orion/music-export"
                className="min-w-[18rem] rounded-l-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-900 placeholder-zinc-400 focus:border-accent focus:outline-none dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 disabled:opacity-50"
              />
              <button
                type="button"
                onClick={async () => {
                  const dir = await api.fs.chooseDirectory();
                  if (dir) setLocalOutDir(dir);
                }}
                disabled={running}
                className="flex items-center gap-1 rounded-r-lg border border-l-0 border-zinc-200 bg-white px-3 text-sm text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800 disabled:opacity-50"
                title="Browse…"
              >
                <FolderOpen className="h-4 w-4" />
                Browse
              </button>
            </div>
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={clearAll}
            disabled={running || jobs.length === 0}
            className="btn-ghost"
          >
            <Trash2 className="h-4 w-4" />
            Clear list
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={running || scanning}
            className="btn-ghost"
          >
            Choose files
          </button>
          <button
            type="button"
            onClick={() => void onChooseFolder()}
            disabled={running || scanning}
            className="btn-ghost"
          >
            <FolderOpen className="h-4 w-4" />
            Choose folder…
          </button>
          <button
            type="button"
            onClick={handleConvertClick}
            disabled={!canRun}
            className="btn-accent"
          >
            <Upload className="h-4 w-4" />
            {running ? "Converting…" : "Convert & upload"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={AUDIO_EXT.join(",")}
            onChange={onPickFiles}
            className="hidden"
          />
        </div>
      </div>

      {/* Progress panel — grande, ben visibile, realtime, resta in cima (sticky) */}
      {jobs.length > 0 && (running || stats.done > 0 || stats.err > 0) && (
        <div className="ui-card sticky top-0 z-10 flex flex-col gap-3 p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              {running ? (
                <Loader2 className="h-5 w-5 animate-spin text-accent" />
              ) : stats.err > 0 ? (
                <AlertTriangle className="h-5 w-5 text-amber-500" />
              ) : (
                <CheckCircle2 className="h-5 w-5 text-emerald-500" />
              )}
              <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                {running
                  ? "Conversione in corso"
                  : stats.err > 0
                    ? "Completato con errori"
                    : "Conversione completata"}
              </span>
              <span className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
                {stats.done + stats.err}/{stats.total}
              </span>
            </div>
            <span className="text-2xl font-bold tabular-nums text-zinc-900 dark:text-zinc-50">
              {Math.round(prog.overall)}%
            </span>
          </div>

          {/* Status bar segmentata */}
          <div className="flex h-3.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
            <div
              className="h-full bg-gradient-to-r from-emerald-400 to-emerald-500 transition-all duration-300"
              style={{ width: `${prog.doneW}%` }}
            />
            <div
              className="h-full animate-pulse bg-gradient-to-r from-sky-400 to-accent transition-all duration-300"
              style={{ width: `${prog.curW}%` }}
            />
            <div
              className="h-full bg-gradient-to-r from-red-400 to-red-500 transition-all duration-300"
              style={{ width: `${prog.errW}%` }}
            />
          </div>

          {/* Legenda + brano corrente */}
          <div className="flex items-center justify-between gap-3 text-xs">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="flex items-center gap-1.5 font-medium text-emerald-600 dark:text-emerald-400">
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                {stats.done} completati
              </span>
              {stats.err > 0 && (
                <span className="flex items-center gap-1.5 font-medium text-red-600 dark:text-red-400">
                  <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
                  {stats.err} errori
                </span>
              )}
              <span className="flex items-center gap-1.5 font-medium text-zinc-500 dark:text-zinc-400">
                <span className="h-2.5 w-2.5 rounded-full bg-zinc-300 dark:bg-zinc-600" />
                {prog.remaining} in coda
              </span>
            </div>
            {running && prog.curName && (
              <span className="flex min-w-0 items-center gap-1.5 text-zinc-600 dark:text-zinc-300">
                <Music2 className="h-3.5 w-3.5 shrink-0 text-accent" />
                <span className="truncate">{prog.curName}</span>
              </span>
            )}
          </div>
        </div>
      )}

      {/* Drop zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!running) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed py-10 transition-colors ${
          dragOver
            ? "border-accent bg-accent-soft"
            : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
        }`}
      >
        {scanning ? (
          <>
            <Loader2 className="h-8 w-8 animate-spin text-accent" />
            <p className="text-sm text-zinc-700 dark:text-zinc-200">
              Scanning folders…
            </p>
          </>
        ) : (
          <>
            <Music2
              className={`h-8 w-8 ${dragOver ? "text-accent" : "text-zinc-400"}`}
            />
            <p className="text-sm text-zinc-700 dark:text-zinc-200">
              Drop audio files or whole folders here
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              MP3 · FLAC · WAV · M4A · OGG · OPUS · AAC · directories scanned recursively
            </p>
          </>
        )}
      </div>

      {/* Album cover picker (ricerca online iTunes) */}
      {jobs.length > 0 && (
        <div className="ui-card flex flex-col gap-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-zinc-800 dark:text-zinc-100">
                Copertina album
              </p>
              {coverLoading && (
                <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
              )}
            </div>
            <div className="flex items-stretch gap-1">
              <input
                type="text"
                value={coverTerm}
                onChange={(e) => {
                  setCoverTerm(e.target.value);
                  setCoverTermTouched(true);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void onManualCoverSearch();
                }}
                disabled={running}
                placeholder="artista album"
                className="w-56 rounded-l-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-900 placeholder-zinc-400 focus:border-accent focus:outline-none dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => void onManualCoverSearch()}
                disabled={running || coverLoading || coverTerm.trim().length === 0}
                className="flex items-center gap-1 rounded-r-lg border border-l-0 border-zinc-200 bg-white px-3 text-sm text-zinc-700 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800 disabled:opacity-50"
              >
                <Search className="h-4 w-4" />
                Cerca
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {/* Nessuna copertina */}
            <CoverTile
              selected={coverSel === COVER_NONE}
              onClick={() => setCoverSel(COVER_NONE)}
              label="Nessuna"
              disabled={running}
            >
              <ImageOff className="h-5 w-5 text-zinc-400" />
            </CoverTile>

            {/* Cover embedded nei brani (se presente) */}
            {embeddedThumb && (
              <CoverTile
                selected={coverSel === COVER_EMBEDDED}
                onClick={() => setCoverSel(COVER_EMBEDDED)}
                label="Dai brani"
                img={embeddedThumb}
                disabled={running}
              />
            )}

            {/* Risultati iTunes */}
            {coverResults.map((c) => (
              <CoverTile
                key={c.id}
                selected={coverSel === c.id}
                onClick={() => setCoverSel(c.id)}
                label={c.title || c.artist}
                img={c.thumbUrl}
                disabled={running}
              />
            ))}
          </div>

          {!coverLoading && coverResults.length === 0 && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Nessun risultato online.{" "}
              {embeddedThumb
                ? "Userò la copertina presente nei brani."
                : "Non verrà scritta alcuna copertina."}
            </p>
          )}
        </div>
      )}

      {/* Job list */}
      {jobs.length > 0 && (
        <div className="ui-card flex flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-2 dark:border-zinc-800">
            <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              {stats.total} file
              {stats.done > 0 && ` · ${stats.done} done`}
              {stats.err > 0 && ` · ${stats.err} errors`}
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              → <code className="font-mono">
                {target === "device"
                  ? `${device?.mountPath ?? "(no device)"}/music/${effectiveFolder || "?"}/`
                  : `${localOutDir.trim() || "~/Documents/Orion/music-export"}/${effectiveFolder || "?"}/`}
              </code>
            </p>
          </div>
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {jobs.map((j, i) => (
              <li key={`${j.sourcePath}-${i}`} className="px-4 py-3">
                <div className="flex items-center gap-3">
                  <StatusIcon s={j.status} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-zinc-800 dark:text-zinc-100">
                      {j.displayName}
                    </p>
                    <p className="truncate text-[11px] text-zinc-500">
                      {j.sourcePath}
                    </p>
                  </div>
                  <div className="w-32">
                    {(j.status === "converting" || j.status === "done") && (
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                        <div
                          className={`h-full transition-all ${
                            j.status === "done" ? "bg-emerald-500" : "bg-accent"
                          }`}
                          style={{ width: `${j.percent}%` }}
                        />
                      </div>
                    )}
                  </div>
                  {!running && (
                    <button
                      type="button"
                      onClick={() => removeJob(i)}
                      className="rounded p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                      aria-label="Remove"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
                {j.error && (
                  <p className="ml-7 mt-2 max-h-32 overflow-auto rounded bg-red-500/10 p-2 font-mono text-[11px] text-red-700 dark:text-red-300">
                    {j.error}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!device && target === "device" && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/50 dark:bg-amber-500/10 dark:text-amber-200">
          No device connected — switch to <em>Local export</em> to convert to a
          folder on this PC, or connect Orion via USB MSC.
        </div>
      )}

      {nameFixes && (
        <NameFixDialog
          items={nameFixes}
          onCancel={() => setNameFixes(null)}
          onConfirm={applyNameFixes}
        />
      )}
    </div>
  );
};

/** Popup di correzione dei nomi troppo lunghi (> MAX_NAME_LEN). Mostra un
 *  campo editabile per ogni brano/album fuori limite; il pulsante di conferma
 *  resta disabilitato finché tutti i nomi non rientrano nel limite. */
const NameFixDialog: FC<{
  items: LongName[];
  onCancel: () => void;
  onConfirm: (items: LongName[]) => void;
}> = ({ items, onCancel, onConfirm }) => {
  const [draft, setDraft] = useState<LongName[]>(() =>
    items.map((it) => ({ ...it })),
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const update = (idx: number, value: string) =>
    setDraft((prev) => prev.map((it, i) => (i === idx ? { ...it, value } : it)));

  const allValid = draft.every((it) => {
    const v = it.value.trim();
    return v.length > 0 && nameLength(v) <= MAX_NAME_LEN;
  });

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-6"
      onClick={onCancel}
    >
      <div
        className="ui-card flex max-h-[90vh] w-full max-w-lg flex-col p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-500/15">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
              Attenzione: nome troppo lungo
            </h2>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Il nome del brano/album supera il limite di {MAX_NAME_LEN}{" "}
              caratteri consentito da Orion (spazi e caratteri speciali
              inclusi). Correggi i nomi qui sotto prima di continuare.
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-3 overflow-auto">
          {draft.map((it, i) => {
            const v = it.value.trim();
            const len = nameLength(v);
            const over = len > MAX_NAME_LEN;
            const empty = v.length === 0;
            return (
              <div key={`${it.kind}-${it.jobIndex}`} className="flex flex-col gap-1">
                <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  {it.kind === "genre"
                    ? "Genere / cartella"
                    : it.kind === "artist"
                      ? "Artista / sottocartella"
                      : it.kind === "album"
                        ? "Album / sottocartella"
                        : "Brano"}
                  {it.source && (
                    <span className="ml-1 truncate font-normal text-zinc-400">
                      · {it.source}
                    </span>
                  )}
                </label>
                <input
                  type="text"
                  autoFocus={i === 0}
                  value={it.value}
                  maxLength={MAX_NAME_LEN}
                  onChange={(e) => update(i, e.target.value)}
                  className={`rounded-lg border bg-white px-3 py-1.5 text-sm text-zinc-900 focus:outline-none dark:bg-zinc-900 dark:text-zinc-100 ${
                    over || empty
                      ? "border-red-400 focus:border-red-500"
                      : "border-zinc-200 focus:border-accent dark:border-zinc-800"
                  }`}
                />
                <span
                  className={`text-[11px] ${
                    over || empty ? "text-red-500" : "text-zinc-400"
                  }`}
                >
                  {len}/{MAX_NAME_LEN}
                </span>
              </div>
            );
          })}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="btn-ghost">
            Annulla
          </button>
          <button
            type="button"
            onClick={() => onConfirm(draft)}
            disabled={!allValid}
            className="btn-accent"
          >
            Conferma e converti
          </button>
        </div>
      </div>
    </div>
  );
};

export default MusicPage;
