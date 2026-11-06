import {
  useCallback,
  useEffect,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import {
  BookOpen,
  Upload,
  CheckCircle2,
  AlertTriangle,
  FileText,
  FolderOpen,
  X,
  Bluetooth,
} from "lucide-react";
import { useDevices } from "@/lib/DeviceContext";
import { bleCondiviso } from "@/lib/bleOrion";
import { confermaInvioBle } from "@/lib/useBle";
import { useActivity } from "@/lib/ActivityContext";
import { api } from "@/lib/api";
import EbookPreview from "@/components/EbookPreview";
import type {
  EbookPreviewResponse,
  EbookProgressEvent,
} from "@shared/ipc-types";

interface PendingJob {
  sourcePath: string;
  displayName: string;
  status: "queued" | "running" | "done" | "error";
  progress?: EbookProgressEvent;
  result?: {
    outputPath: string;
    pageCount: number;
    bytes: number;
  };
  error?: string;
}

const ACCEPT_EXT = [".md", ".markdown", ".txt", ".epub", ".pdf"];

function isSupportedPath(p: string): boolean {
  const lower = p.toLowerCase();
  return ACCEPT_EXT.some((e) => lower.endsWith(e));
}

function basenameOf(p: string): string {
  const lastSep = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  const fname = lastSep >= 0 ? p.slice(lastSep + 1) : p;
  const dot = fname.lastIndexOf(".");
  return dot > 0 ? fname.slice(0, dot) : fname;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** Dove il firmware cerca i libri (`EB_DIR` in `ui_priv.h`). */
const BLE_BOOKS_DIR = "/books";

const EbookPage = () => {
  const { devices } = useDevices();
  const device = devices[0] ?? null;
  const { log: logActivity } = useActivity();

  /* ⚠️ **Scala 2, e la scelta e' stata tolta il 21/9/2026.** Il "compatto"
     (scala 1: 70 caratteri per riga invece di 42, 1470 per pagina invece di
     504) e' stato provato sul dispositivo e bocciato: a scala 1 i tratti delle
     lettere sono da **un pixel**, e sul pannello riflettivo senza
     retroilluminazione risultano troppo chiari per leggere a lungo.
     L'emulatore non poteva dirlo — li' i pixel sono neri su un monitor acceso.
     ⚠️ Il meccanismo sotto **resta**: la scala viaggia dentro il `.pdar` e il
     firmware la legge. Non e' codice morto per pigrizia — e' cio' che rende
     sicuro un cambio di impaginazione il giorno che si trovera' la strada
     giusta (un font disegnato a meta' strada, coi tratti da due pixel). Prima
     era un patto a voce fra due programmi, e cambiarlo voleva dire rompere i
     libri gia' convertiti senza accorgersene. */
  const scale = 2 as const;

  const [folder, setFolder] = useState("books");
  const [localOutDir, setLocalOutDir] = useState("");
  const [target, setTarget] = useState<"device" | "local" | "bluetooth">(
    device ? "device" : "local",
  );
  const [bleMsg, setBleMsg] = useState("");
  const [jobs, setJobs] = useState<PendingJob[]>([]);
  const [running, setRunning] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const [selectedIdx, setSelectedIdx] = useState<number>(-1);
  const [preview, setPreview] = useState<EbookPreviewResponse | null>(null);
  const [previewPageIdx, setPreviewPageIdx] = useState(0);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Sottoscrizione globale agli eventi di progresso conversione.
  // Identifichiamo il job di destinazione cercando quello con status="running"
  // (la pipeline esegue un job alla volta).
  useEffect(() => {
    const unsub = api.ebook.onProgress((ev) => {
      setJobs((prev) => {
        const idx = prev.findIndex((j) => j.status === "running");
        if (idx < 0) return prev;
        const next = [...prev];
        next[idx] = { ...next[idx], progress: ev };
        return next;
      });
    });
    return () => {
      unsub();
    };
  }, []);

  const addPaths = useCallback((paths: string[]) => {
    const items: PendingJob[] = [];
    for (const p of paths) {
      if (!p || !isSupportedPath(p)) continue;
      items.push({
        sourcePath: p,
        displayName: basenameOf(p),
        status: "queued",
      });
    }
    if (items.length > 0) {
      setJobs((prev) => {
        const next = [...prev, ...items];
        // Auto-seleziona il primo job se non c'è già una selezione
        if (prev.length === 0) setSelectedIdx(0);
        return next;
      });
    }
  }, []);

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      const paths = files
        .map((f) => api.fs.getPathForFile(f))
        .filter((p) => !!p);
      addPaths(paths);
    },
    [addPaths],
  );

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    const paths = files.map((f) => api.fs.getPathForFile(f)).filter((p) => !!p);
    addPaths(paths);
    e.target.value = "";
  };

  const removeJob = (i: number) => {
    if (running) return;
    setJobs((prev) => {
      const next = prev.filter((_, idx) => idx !== i);
      // Aggiorna la selezione coerentemente
      if (next.length === 0) setSelectedIdx(-1);
      else if (i === selectedIdx) setSelectedIdx(Math.min(i, next.length - 1));
      else if (i < selectedIdx) setSelectedIdx(selectedIdx - 1);
      return next;
    });
  };

  const canRun =
    jobs.length > 0 &&
    !running &&
    (target !== "device" || !!device) &&
    folder.trim().length > 0;

  const selectedJob =
    selectedIdx >= 0 && selectedIdx < jobs.length ? jobs[selectedIdx] : null;

  useEffect(() => {
    if (!selectedJob) {
      setPreview(null);
      setPreviewError(null);
      setPreviewPageIdx(0);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    api.ebook
      .preview({ sourcePath: selectedJob.sourcePath, scale })
      .then((res) => {
        if (cancelled) return;
        setPreview(res);
        setPreviewPageIdx(0);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setPreview(null);
        setPreviewError(e.message);
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedJob?.sourcePath, scale]);

  const onConvert = async () => {
    if (!canRun) return;
    setRunning(true);
    setJobs((prev) =>
      prev.map((j) => ({
        ...j,
        status: "queued",
        error: undefined,
        result: undefined,
        progress: undefined,
      })),
    );
    try {
      /* Via radio il libro si converte in una cartella temporanea e poi si
         manda: sul dispositivo non c'e' un volume su cui scrivere. */
      const tmpBle = target === "bluetooth" ? await api.ble.tmpDir() : undefined;
      for (let i = 0; i < jobs.length; i++) {
        setJobs((prev) =>
          prev.map((j, k) => (k === i ? { ...j, status: "running" } : j)),
        );
        try {
          const r = await api.ebook.convert({
            sourcePath: jobs[i].sourcePath,
            scale,
            mountPath: target === "device" ? device?.mountPath : undefined,
            folder: target === "device" ? folder.trim() : undefined,
            localOutDir:
              tmpBle ??
              (target === "local" && localOutDir.trim().length > 0
                ? localOutDir.trim()
                : undefined),
          });
          if (target === "bluetooth") {
            const f = await api.ble.readLocal({ path: r.outputPath });
            if (!bleCondiviso.connesso) {
              setBleMsg("Connecting…");
              await bleCondiviso.connetti();
            }
            /* Un libro e' quasi sempre "grosso" per la radio: si dice
               quanto ci vuole e si chiede, libro per libro. */
            setBleMsg("");
            if (!confermaInvioBle(f.dati.length)) {
              throw new Error("Converted, but not sent over Bluetooth (cancelled).");
            }
            const mandato = await bleCondiviso.inviaSeDiverso(
              `${BLE_BOOKS_DIR}/${f.nome}`,
              f.dati,
              (p) => {
                if (p.inviati === undefined || !p.totali) return;
                setBleMsg(
                  `Sending ${f.nome}… ${Math.round((p.inviati / p.totali) * 100)}%`,
                );
              },
            );
            setBleMsg(mandato ? "" : `${f.nome} is already on the device: nothing sent.`);
          }
          setJobs((prev) =>
            prev.map((j, k) =>
              k === i
                ? {
                    ...j,
                    status: "done",
                    result: {
                      outputPath: r.outputPath,
                      pageCount: r.pageCount,
                      bytes: r.bytes,
                    },
                  }
                : j,
            ),
          );
          logActivity({
            kind: "ebook-convert",
            status: "ok",
            title: `Ebook converted: ${jobs[i].displayName}`,
            detail: `${r.pageCount} pages · ${formatBytes(r.bytes)}`,
          });
        } catch (e) {
          setJobs((prev) =>
            prev.map((j, k) =>
              k === i
                ? { ...j, status: "error", error: (e as Error).message }
                : j,
            ),
          );
          logActivity({
            kind: "ebook-convert",
            status: "error",
            title: `Ebook failed: ${jobs[i].displayName}`,
            detail: (e as Error).message,
          });
        }
      }
    } finally {
      setRunning(false);
    }
  };

  // ---- Render -------------------------------------------------------------

  return (
    <div className="flex h-full flex-col gap-5">
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Convert <strong>.md</strong> / <strong>.txt</strong> /{" "}
        <strong>.epub</strong> / <strong>.pdf</strong> files to the{" "}
        <code>.pdar</code> binary format, paginated for the Sharp 336×536 display.
      </p>

      {/* Options row */}
      <div className="flex flex-wrap items-end gap-4">
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
            <button
              type="button"
              onClick={() => setTarget("bluetooth")}
              disabled={running}
              className={`flex items-center gap-1 px-3 py-1.5 text-sm transition-colors disabled:opacity-50 ${
                target === "bluetooth"
                  ? "bg-accent text-white"
                  : "bg-white text-zinc-700 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
              }`}
            >
              <Bluetooth className="h-3.5 w-3.5" />
              Bluetooth
            </button>
          </div>
        </div>

        {target === "device" && (
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              Folder on device
            </label>
            <input
              type="text"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              disabled={running}
              placeholder="es. books"
              className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-900 placeholder-zinc-400 focus:border-accent focus:outline-none dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 disabled:opacity-50"
            />
          </div>
        )}

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
                placeholder="~/Documents/Orion/books-export"
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
          <label className="btn-ghost cursor-pointer">
            Choose files
            <input
              type="file"
              multiple
              accept={ACCEPT_EXT.join(",")}
              onChange={onPick}
              className="hidden"
              disabled={running}
            />
          </label>
          <button
            type="button"
            onClick={() => void onConvert()}
            disabled={!canRun}
            className="btn-accent"
          >
            <Upload className="h-4 w-4" />
            {running ? "Converting…" : "Convert"}
          </button>
        </div>
      </div>

      {/* Device required warning */}
      {target === "device" && !device && (
        <div className="ui-card flex items-start gap-3 border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/50 dark:bg-amber-500/10 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            No device connected. Switch to <em>Local export</em> to
            generate the <code>.pdar</code> in{" "}
            <code>~/Documents/Orion/books-export/</code>.
          </span>
        </div>
      )}

      {target === "bluetooth" && (
        <div className="ui-card flex items-start gap-3 border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/50 dark:bg-amber-500/10 dark:text-amber-200">
          <Bluetooth className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Sent to <code>{BLE_BOOKS_DIR}</code> on the device, without the cable. Bluetooth
            carries about 1 KB per second: a short text is fine, a whole book takes many
            minutes. You are told how long, and asked, before each one.
            {bleMsg && <strong className="ml-2">{bleMsg}</strong>}
          </span>
        </div>
      )}

      {/* Drop zone + job list unificati */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!running) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`rounded-xl border-2 border-dashed transition-colors ${
          dragOver
            ? "border-accent bg-accent-soft"
            : jobs.length > 0
              ? "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
              : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
        }`}
      >
        {jobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10">
            <BookOpen
              className={`h-8 w-8 ${dragOver ? "text-accent" : "text-zinc-400"}`}
            />
            <p className="text-sm text-zinc-700 dark:text-zinc-200">
              Drop ebook files here (or use <em>Choose files</em>)
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              .md · .markdown · .txt · .epub · .pdf
            </p>
          </div>
        ) : (
          <>
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {jobs.map((j, i) => (
                <li
                  key={`${j.sourcePath}-${i}`}
                  onClick={() => setSelectedIdx(i)}
                  className={`cursor-pointer px-4 py-3 transition-colors ${
                    i === selectedIdx
                      ? "bg-accent-soft"
                      : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    {j.status === "done" ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    ) : j.status === "error" ? (
                      <AlertTriangle className="h-4 w-4 text-red-500" />
                    ) : j.status === "running" ? (
                      <FileText className="h-4 w-4 animate-pulse text-accent" />
                    ) : (
                      <FileText className="h-4 w-4 text-zinc-400" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-zinc-800 dark:text-zinc-100">
                        {j.displayName}
                      </p>
                      <p className="truncate text-[11px] text-zinc-500">
                        {j.sourcePath}
                      </p>
                    </div>
                    {j.result && (
                      <div className="text-right text-xs">
                        <p className="text-zinc-700 dark:text-zinc-300">
                          {j.result.pageCount} pages · {formatBytes(j.result.bytes)}
                        </p>
                        <p className="truncate text-[11px] text-zinc-500">
                          {j.result.outputPath}
                        </p>
                      </div>
                    )}
                    {!running && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeJob(i);
                        }}
                        className="rounded p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                        aria-label="Remove"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  {j.status === "running" && j.progress && (
                    <div className="ml-7 mt-2">
                      <div className="h-1 w-full overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800">
                        <div
                          className="h-full bg-accent transition-all"
                          style={{ width: `${j.progress.percent ?? 0}%` }}
                        />
                      </div>
                      <p className="mt-1 text-[11px] text-zinc-500">
                        {j.progress.phase === "read" &&
                          (j.progress.totalChapters
                            ? `Reading source · ${j.progress.chapterIdx}/${j.progress.totalChapters}`
                            : "Reading source…")}
                        {j.progress.phase === "reflow" &&
                          (j.progress.totalChapters
                            ? `Paginating chapter ${j.progress.chapterIdx}/${j.progress.totalChapters}`
                            : "Paginating…")}
                        {j.progress.phase === "write" && "Writing .pdar…"}
                        {j.progress.phase === "done" && "Done"}
                        {j.progress.phase === "error" && (j.progress.error ?? "Error")}
                        {j.progress.percent !== undefined &&
                          ` · ${j.progress.percent.toFixed(0)}%`}
                      </p>
                    </div>
                  )}
                  {j.error && (
                    <p className="ml-7 mt-2 rounded bg-red-500/10 p-2 font-mono text-[11px] text-red-700 dark:text-red-300">
                      {j.error}
                    </p>
                  )}
                </li>
              ))}
            </ul>
            <div className="border-t border-dashed border-zinc-200 px-4 py-2 text-center text-[11px] text-zinc-500 dark:border-zinc-700 dark:text-zinc-500">
              Drop more files here or use <em>Choose files</em> to add them
            </div>
          </>
        )}
      </div>

      {/* Preview canvas 536×336 — fedele al rendering firmware */}
      {selectedJob && (
        <>
          {previewError && (
            <div className="ui-card flex items-start gap-3 border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-500/50 dark:bg-red-500/10 dark:text-red-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Preview failed: {previewError}</span>
            </div>
          )}
          <EbookPreview
            preview={preview}
            pageIdx={previewPageIdx}
            onPageChange={setPreviewPageIdx}
            loading={previewLoading}
            title={selectedJob.displayName}
          />
        </>
      )}
    </div>
  );
};

export default EbookPage;
