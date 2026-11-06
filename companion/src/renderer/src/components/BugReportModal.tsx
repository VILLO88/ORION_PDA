import { useCallback, useEffect, useMemo, useState, type FC } from "react";
import {
  Bug,
  Check,
  Copy,
  Mail,
  X,
} from "lucide-react";
import { api, isElectron } from "@/lib/api";
import { useDevices } from "@/lib/DeviceContext";
import { useActivity } from "@/lib/ActivityContext";
import {
  BUG_REPORT_EMAIL,
  buildBugReportSubject,
  buildMailtoUrl,
  formatBugReport,
  type BugReportContext,
} from "@/lib/bugReport";
import type { FfmpegProbe, SystemInfo } from "@shared/ipc-types";

interface Props {
  open: boolean;
  onClose: () => void;
}

const BugReportModal: FC<Props> = ({ open, onClose }) => {
  const { devices } = useDevices();
  const device = devices[0] ?? null;
  const { entries } = useActivity();

  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState("");
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [ffmpeg, setFfmpeg] = useState<FfmpegProbe | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [copied, setCopied] = useState(false);

  // Carica system info + probe ffmpeg quando il modale apre.
  useEffect(() => {
    if (!open) return;
    void api.system.info().then(setSystem).catch(() => setSystem(null));
    void api.mp3
      .probeFfmpeg()
      .then(setFfmpeg)
      .catch(() => setFfmpeg(null));
  }, [open]);

  // Reset stato locale quando il modale si chiude (form pulito al riapri).
  useEffect(() => {
    if (open) return;
    setDescription("");
    setSteps("");
    setShowDetails(false);
    setCopied(false);
  }, [open]);

  // ESC per chiudere.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const ctx = useMemo<BugReportContext>(
    () => ({
      description,
      steps,
      system,
      ffmpeg,
      device,
      activity: entries,
    }),
    [description, steps, system, ffmpeg, device, entries],
  );

  const fullReport = useMemo(() => formatBugReport(ctx), [ctx]);
  const subject = useMemo(() => buildBugReportSubject(ctx), [ctx]);

  const onSendEmail = useCallback(() => {
    const { url } = buildMailtoUrl(subject, fullReport);
    // Electron intercetta i mailto:// e li passa all'OS, che apre il client
    // di posta predefinito. window.location funziona uguale sia in dev sia
    // nel bundle.
    window.location.href = url;
  }, [subject, fullReport]);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(
        `Subject: ${subject}\nTo: ${BUG_REPORT_EMAIL}\n\n${fullReport}`,
      );
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: mostriamo il textarea sotto al click su "Show details" così
      // l'utente può comunque selezionare e copiare a mano.
      setShowDetails(true);
    }
  }, [subject, fullReport]);

  if (!open) return null;

  const canSend = description.trim().length > 0 || steps.trim().length > 0;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="ui-card flex max-h-[90vh] w-full max-w-2xl flex-col p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft">
            <Bug className="h-5 w-5 text-accent" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
              Report a bug
            </h2>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              Sends an email to{" "}
              <code className="font-mono">{BUG_REPORT_EMAIL}</code> with your
              description and the system info shown below.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 flex-1 space-y-4 overflow-y-auto pr-1">
          <div>
            <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              What went wrong?
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              autoFocus
              placeholder="e.g. The app crashes when I convert a FLAC album with non-ASCII characters in the title."
              className="mt-1 w-full resize-y rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-accent focus:outline-none dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              Steps to reproduce (optional)
            </label>
            <textarea
              value={steps}
              onChange={(e) => setSteps(e.target.value)}
              rows={3}
              placeholder={"1. Open the Music tab\n2. Drag an album with…\n3. Click Convert"}
              className="mt-1 w-full resize-y rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-accent focus:outline-none dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
            />
          </div>

          <div className="rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
            <button
              type="button"
              onClick={() => setShowDetails((v) => !v)}
              className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-zinc-600 dark:text-zinc-300"
            >
              <span>
                System info auto-attached ({entries.length} activity entries)
              </span>
              <span className="text-zinc-400">
                {showDetails ? "Hide" : "Show"}
              </span>
            </button>
            {showDetails && (
              <pre className="max-h-64 overflow-auto border-t border-zinc-200 px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-700 dark:border-zinc-800 dark:text-zinc-300">
                {fullReport}
              </pre>
            )}
          </div>

          {!isElectron && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/50 dark:bg-amber-500/10 dark:text-amber-200">
              Running outside Electron — system info is incomplete.
            </div>
          )}
        </div>

        <div className="mt-5 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => void onCopy()}
            className="btn-ghost"
          >
            {copied ? (
              <Check className="h-4 w-4 text-emerald-500" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
            {copied ? "Copied" : "Copy full report"}
          </button>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="btn-ghost">
              Cancel
            </button>
            <button
              type="button"
              onClick={onSendEmail}
              disabled={!canSend}
              className="btn-accent disabled:opacity-40"
              title={
                canSend
                  ? "Open your mail client with the report pre-filled"
                  : "Add a description first"
              }
            >
              <Mail className="h-4 w-4" />
              Send via email
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default BugReportModal;
