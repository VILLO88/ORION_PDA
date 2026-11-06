import {
  useCallback,
  useEffect,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import {
  Video,
  Upload,
  CheckCircle2,
  AlertTriangle,
  Film,
  FolderOpen,
  X,
} from "lucide-react";
import { useDevices } from "@/lib/DeviceContext";
import { useActivity } from "@/lib/ActivityContext";
import { api } from "@/lib/api";
import VideoPreview from "@/components/VideoPreview";
import type {
  VideoDitherMode,
  VideoFitMode,
  VideoProgressEvent,
} from "@shared/ipc-types";

interface PendingJob {
  sourcePath: string;
  displayName: string;
  status: "queued" | "running" | "done" | "error";
  progress?: VideoProgressEvent;
  result?: {
    outputPath: string;
    frameCount: number;
    bytes: number;
    durationSec: number;
    fps: number;
  };
  error?: string;
}

const ACCEPT_EXT = [".mp4", ".mkv", ".mov", ".avi", ".webm", ".m4v"];
/* ⚠️ **Non si sceglie.** A 3 MHz il pannello riceve un fotogramma in 63 ms, e
   a 15 al secondo ce ne sono 67: e' il massimo che arriva intero. Dal
   9/10/2026; prima era 10, per un limite di datasheet che si e' rivelato
   prudente. Chiedere 30, come faceva questa pagina fino al 20/9/2026, non
   produceva un video piu' fluido — il lettore scartava i fotogrammi in piu'
   in modo irregolare, quindi piu' a scatti, e il file era piu' grande per
   niente. Deve restare uguale a `FPS_PANNELLO` di `main/ipc/video.ts`. */
const FPS_PANNELLO = 15;
const DITHER_OPTIONS: { value: VideoDitherMode; label: string }[] = [
  { value: "floyd_steinberg", label: "Floyd–Steinberg" },
  { value: "atkinson", label: "Atkinson" },
  { value: "bayer4", label: "Bayer 4×4" },
  { value: "bayer8", label: "Bayer 8×8" },
  { value: "threshold", label: "Threshold" },
];
const FIT_OPTIONS: { value: VideoFitMode; label: string }[] = [
  { value: "fit", label: "Fit (letterbox)" },
  { value: "fill", label: "Fill (crop)" },
  { value: "stretch", label: "Stretch" },
];

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
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec - m * 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const VideoPage = () => {
  const { devices } = useDevices();
  const device = devices[0] ?? null;
  const { log: logActivity } = useActivity();

  const fps = FPS_PANNELLO;
  const [ditherMode, setDitherMode] = useState<VideoDitherMode>("floyd_steinberg");
  const [fitMode, setFitMode] = useState<VideoFitMode>("fit");
  const [folder, setFolder] = useState("video");
  const [localOutDir, setLocalOutDir] = useState("");
  const [target, setTarget] = useState<"device" | "local">(
    device ? "device" : "local",
  );
  const [jobs, setJobs] = useState<PendingJob[]>([]);
  const [running, setRunning] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [ffmpegOk, setFfmpegOk] = useState<boolean | null>(null);
  const [ffmpegError, setFfmpegError] = useState<string | undefined>();

  const [selectedIdx, setSelectedIdx] = useState<number>(-1);

  useEffect(() => {
    void api.video.probeFfmpeg().then((r) => {
      setFfmpegOk(r.available);
      setFfmpegError(r.error);
    });
  }, []);

  // Progress: aggiorna il job running corrente. Identifichiamo l'indice
  // tramite stato `status === "running"` (uno alla volta).
  useEffect(() => {
    const unsub = api.video.onProgress((ev) => {
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
      if (next.length === 0) setSelectedIdx(-1);
      else if (i === selectedIdx) setSelectedIdx(Math.min(i, next.length - 1));
      else if (i < selectedIdx) setSelectedIdx(selectedIdx - 1);
      return next;
    });
  };

  const canRun =
    jobs.length > 0 &&
    !running &&
    (target === "local" || !!device) &&
    folder.trim().length > 0 &&
    ffmpegOk === true;

  const selectedJob =
    selectedIdx >= 0 && selectedIdx < jobs.length ? jobs[selectedIdx] : null;

  const onConvert = async () => {
    if (!canRun) return;
    setRunning(true);
    setJobs((prev) =>
      prev.map((j) => ({ ...j, status: "queued", error: undefined, result: undefined, progress: undefined })),
    );
    try {
      for (let i = 0; i < jobs.length; i++) {
        setJobs((prev) =>
          prev.map((j, k) => (k === i ? { ...j, status: "running" } : j)),
        );
        try {
          const r = await api.video.convert({
            sourcePath: jobs[i].sourcePath,
            fps,
            ditherMode,
            fitMode,
            mountPath: target === "device" ? device?.mountPath : undefined,
            folder: target === "device" ? folder.trim() : undefined,
            localOutDir:
              target === "local" && localOutDir.trim().length > 0
                ? localOutDir.trim()
                : undefined,
          });
          setJobs((prev) =>
            prev.map((j, k) =>
              k === i
                ? {
                    ...j,
                    status: "done",
                    result: {
                      outputPath: r.outputPath,
                      frameCount: r.frameCount,
                      bytes: r.bytes,
                      durationSec: r.durationSec,
                      fps: r.fps,
                    },
                  }
                : j,
            ),
          );
          logActivity({
            kind: "video-convert",
            status: "ok",
            title: `Video converted: ${jobs[i].displayName}`,
            detail: `${formatDuration(r.durationSec)} · ${formatBytes(r.bytes)}`,
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
            kind: "video-convert",
            status: "error",
            title: `Video failed: ${jobs[i].displayName}`,
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
        Convert <strong>.mp4</strong> / <strong>.mkv</strong> /{" "}
        <strong>.mov</strong> into 1-bit dithered <code>.av</code> format
        (Sharp 336×536). Pipeline: ffmpeg → resize + dither → mux audio_block +
        video frame.
      </p>

      {ffmpegOk === false && (
        <div className="ui-card flex items-start gap-3 border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-500/50 dark:bg-red-500/10 dark:text-red-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">ffmpeg not found on the system.</p>
            <p className="text-xs opacity-80">
              {ffmpegError ?? "Install with `brew install ffmpeg` (macOS) or download it from the official site."}
            </p>
          </div>
        </div>
      )}

      {/* Options row */}
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
            fotogrammi al secondo
          </label>
          <div
            className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm
                       text-zinc-700 dark:border-zinc-800 dark:text-zinc-200"
            title={
              "Il pannello di Orion riceve al massimo 15 fotogrammi al secondo. " +
              "Chiederne di piu' non li fa andare piu' veloci: il lettore li " +
              "scarta e il movimento diventa a scatti, con un file piu' grande. " +
              "Serve il firmware del 9/10/2026 o successivo: con uno piu' " +
              "vecchio il video salta fotogrammi."
            }
          >
            {FPS_PANNELLO} &middot; il massimo del pannello
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
            Dither
          </label>
          <select
            value={ditherMode}
            onChange={(e) => setDitherMode(e.target.value as VideoDitherMode)}
            disabled={running}
            className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-900 focus:border-accent focus:outline-none dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 disabled:opacity-50"
          >
            {DITHER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
            Fit
          </label>
          <select
            value={fitMode}
            onChange={(e) => setFitMode(e.target.value as VideoFitMode)}
            disabled={running}
            className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-900 focus:border-accent focus:outline-none dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 disabled:opacity-50"
          >
            {FIT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

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
              Folder on device
            </label>
            <input
              type="text"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              disabled={running}
              placeholder="es. video"
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
                placeholder="~/Documents/Orion/video-export"
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

      {target === "device" && !device && (
        <div className="ui-card flex items-start gap-3 border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/50 dark:bg-amber-500/10 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            No device connected. Switch to <em>Local export</em> to generate
            the <code>.av</code> in <code>~/Documents/Orion/video-export/</code>.
          </span>
        </div>
      )}

      {/* Drop zone + jobs list unificati */}
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
            : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
        }`}
      >
        {jobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10">
            <Video
              className={`h-8 w-8 ${dragOver ? "text-accent" : "text-zinc-400"}`}
            />
            <p className="text-sm text-zinc-700 dark:text-zinc-200">
              Drop video files here (or use <em>Choose files</em>)
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              .mp4 · .mkv · .mov · .avi · .webm · .m4v
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
                    <Film className="h-4 w-4 animate-pulse text-accent" />
                  ) : (
                    <Film className="h-4 w-4 text-zinc-400" />
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
                        {j.result.frameCount} frame · {formatDuration(j.result.durationSec)}
                      </p>
                      <p className="truncate text-[11px] text-zinc-500">
                        {formatBytes(j.result.bytes)} @ {j.result.fps} fps
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
                      {j.progress.phase}
                      {j.progress.frame !== undefined &&
                        j.progress.totalFrames !== undefined &&
                        ` · ${j.progress.frame}/${j.progress.totalFrames}`}
                      {j.progress.percent !== undefined &&
                        ` · ${j.progress.percent.toFixed(1)}%`}
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

      {/* Preview frame 536×336 con stesso dither/fit della conversione */}
      {selectedJob && (
        <VideoPreview
          sourcePath={selectedJob.sourcePath}
          ditherMode={ditherMode}
          fitMode={fitMode}
          fps={fps}
          title={selectedJob.displayName}
        />
      )}
    </div>
  );
};

export default VideoPage;
