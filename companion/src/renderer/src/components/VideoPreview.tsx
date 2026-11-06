import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import {
  captureFrameToGray,
  createDitherBuffers,
  ditherFrameInto,
  LOGIC_H,
  LOGIC_W,
  paintBwToCanvas,
  type DitherWorkBuffers,
} from "@/lib/videoDither";
import type {
  VideoAdjustParams,
  VideoDitherMode,
  VideoFitMode,
} from "@shared/ipc-types";

/**
 * Preview video: scrub-only, niente playback.
 *
 *  - HTML5 (default): un <video> nascosto carica il sorgente via lo schema
 *    privilegiato `orion-media://`. Lo slider muove `video.currentTime`; ad
 *    ogni `seeked` rifacciamo grab → grayscale → dither → paint sul canvas
 *    536×336. Scrubbing pressoché istantaneo perché niente process spawn.
 *
 *  - Fallback ffmpeg: se Chromium non riesce a decodificare il file (codec
 *    esotici in .mkv/.avi) usiamo `api.video.preview()` come prima.
 */

interface VideoPreviewProps {
  sourcePath: string;
  ditherMode: VideoDitherMode;
  fitMode: VideoFitMode;
  threshold?: number;
  adjust?: VideoAdjustParams;
  fps: number;
  title?: string;
}

function buildMediaUrl(absPath: string): string {
  return `orion-media:///${encodeURIComponent(absPath.replace(/^\//, ""))}`;
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00.000";
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}

export const VideoPreview = ({
  sourcePath,
  ditherMode,
  fitMode,
  threshold,
  adjust,
  fps,
  title,
}: VideoPreviewProps) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scratchRef = useRef<HTMLCanvasElement | null>(null);
  const scratchCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const displayRef = useRef<HTMLCanvasElement | null>(null);
  const buffersRef = useRef<DitherWorkBuffers | null>(null);

  const [mode, setMode] = useState<"html5" | "ffmpeg">("html5");
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ---- Setup buffers + scratch canvas (una sola volta) -------------------
  useEffect(() => {
    if (!buffersRef.current) buffersRef.current = createDitherBuffers();
    if (!scratchRef.current) {
      const c = document.createElement("canvas");
      c.width = LOGIC_W;
      c.height = LOGIC_H;
      scratchRef.current = c;
      scratchCtxRef.current = c.getContext("2d", {
        willReadFrequently: true,
      });
    }
  }, []);

  // ---- Sorgente cambiato: reset ------------------------------------------
  useEffect(() => {
    setReady(false);
    setLoadError(null);
    setMode("html5");
    setDuration(0);
    setCurrentTime(0);
  }, [sourcePath]);

  // ---- Disegno frame corrente (su seek o option change) ------------------
  const renderCurrentFrame = useCallback(() => {
    const v = videoRef.current;
    const sc = scratchRef.current;
    const scx = scratchCtxRef.current;
    const dst = displayRef.current;
    const buf = buffersRef.current;
    if (!v || !sc || !scx || !dst || !buf) return;
    if (v.readyState < 2) return; // HAVE_CURRENT_DATA
    captureFrameToGray(v, sc, scx, buf, fitMode);
    ditherFrameInto(buf, { mode: ditherMode, threshold, adjust });
    paintBwToCanvas(dst, buf.bw);
  }, [fitMode, ditherMode, threshold, adjust]);

  // ---- Eventi <video> -----------------------------------------------------
  useEffect(() => {
    if (mode !== "html5") return;
    const v = videoRef.current;
    if (!v) return;

    const onMeta = () => {
      setDuration(v.duration || 0);
      setReady(true);
    };
    const onSeeked = () => {
      setCurrentTime(v.currentTime);
      renderCurrentFrame();
    };
    const onError = () => {
      setMode("ffmpeg");
      setReady(false);
      setLoadError(null);
    };

    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("seeked", onSeeked);
    v.addEventListener("error", onError);
    v.addEventListener("loadeddata", renderCurrentFrame);

    return () => {
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("seeked", onSeeked);
      v.removeEventListener("error", onError);
      v.removeEventListener("loadeddata", renderCurrentFrame);
    };
  }, [mode, renderCurrentFrame]);

  // ---- Re-render quando cambiano dither/fit ------------------------------
  useEffect(() => {
    if (mode === "html5") renderCurrentFrame();
  }, [renderCurrentFrame, mode]);

  // ---- Fallback ffmpeg ----------------------------------------------------
  const [ffmpegLoading, setFfmpegLoading] = useState(false);
  useEffect(() => {
    if (mode !== "ffmpeg") return;
    let cancelled = false;
    setFfmpegLoading(true);
    setLoadError(null);
    api.video
      .probe({ sourcePath })
      .then((p) => {
        if (cancelled) return;
        setDuration(p.durationSec);
        setReady(true);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setLoadError(`Probe failed: ${e.message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, sourcePath]);

  useEffect(() => {
    if (mode !== "ffmpeg" || !ready) return;
    let cancelled = false;
    setFfmpegLoading(true);
    api.video
      .preview({
        sourcePath,
        timeSec: currentTime,
        ditherMode,
        fitMode,
        threshold,
        adjust,
      })
      .then((res) => {
        if (cancelled) return;
        const dst = displayRef.current;
        if (dst) paintBwToCanvas(dst, res.pixels);
        if (res.durationSec) setDuration(res.durationSec);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setLoadError(`Preview failed: ${e.message}`);
      })
      .finally(() => {
        if (!cancelled) setFfmpegLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, ready, sourcePath, currentTime, ditherMode, fitMode, threshold, adjust]);

  // ---- Controlli (solo scrub) --------------------------------------------
  const step = fps > 0 ? 1 / fps : 1 / 30;
  const clamp = useCallback(
    (t: number) => Math.max(0, Math.min(Math.max(0, duration - step), t)),
    [duration, step],
  );

  const seekTo = useCallback(
    (t: number) => {
      const safe = clamp(t);
      setCurrentTime(safe);
      if (mode === "html5") {
        const v = videoRef.current;
        if (v) v.currentTime = safe;
      }
    },
    [clamp, mode],
  );

  const goPrev = useCallback(
    () => seekTo(currentTime - step),
    [currentTime, seekTo, step],
  );
  const goNext = useCallback(
    () => seekTo(currentTime + step),
    [currentTime, seekTo, step],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!ready) return;
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (e.key === "ArrowLeft") {
        goPrev();
        e.preventDefault();
      } else if (e.key === "ArrowRight") {
        goNext();
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ready, goPrev, goNext]);

  const mediaUrl = mode === "html5" ? buildMediaUrl(sourcePath) : "";

  return (
    <div className="ui-card flex flex-col gap-3 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
            Preview
          </h3>
          <span className="text-[11px] text-zinc-500">
            {LOGIC_W}×{LOGIC_H} px · 1-bit dithered
            {mode === "ffmpeg" ? " · ffmpeg fallback" : " · native decode"}
            {title ? ` · ${title}` : ""}
          </span>
        </div>
        <span className="font-mono text-[11px] text-zinc-500">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
      </div>

      {loadError && (
        <div className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800 dark:border-red-500/50 dark:bg-red-500/10 dark:text-red-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{loadError}</span>
        </div>
      )}

      <div className="flex items-center justify-center overflow-auto rounded-lg bg-zinc-100 p-3 dark:bg-zinc-950">
        <div
          className="relative"
          style={{ width: `${LOGIC_W}px`, height: `${LOGIC_H}px` }}
        >
          {mode === "html5" && (
            // Decoder Chromium nascosto sotto al canvas: stesso bounding box
            // così resta in viewport (Chromium altrimenti sospende il decode).
            <video
              ref={videoRef}
              src={mediaUrl}
              preload="auto"
              muted
              playsInline
              width={LOGIC_W}
              height={LOGIC_H}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: `${LOGIC_W}px`,
                height: `${LOGIC_H}px`,
                opacity: 0,
                pointerEvents: "none",
                zIndex: 0,
              }}
            />
          )}
          <canvas
            ref={displayRef}
            width={LOGIC_W}
            height={LOGIC_H}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: `${LOGIC_W}px`,
              height: `${LOGIC_H}px`,
              imageRendering: "pixelated",
              boxShadow: "0 0 0 1px rgba(0,0,0,0.1)",
              zIndex: 1,
            }}
          />
          {((mode === "html5" && !ready) ||
            (mode === "ffmpeg" && ffmpegLoading)) && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/30">
              <Loader2 className="h-5 w-5 animate-spin text-white" />
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={goPrev}
          disabled={!ready || currentTime <= 0}
          className="btn-ghost disabled:opacity-40"
          title="Previous frame (←)"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(0, duration - step)}
          step={step}
          value={Math.min(currentTime, Math.max(0, duration - step))}
          onChange={(e) => seekTo(parseFloat(e.target.value))}
          disabled={!ready}
          className="flex-1 accent-[var(--accent,#f97316)]"
        />
        <button
          type="button"
          onClick={goNext}
          disabled={!ready || currentTime >= duration - step}
          className="btn-ghost disabled:opacity-40"
          title="Next frame (→)"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
};

export default VideoPreview;
