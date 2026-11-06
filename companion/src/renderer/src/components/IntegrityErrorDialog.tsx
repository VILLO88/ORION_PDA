import { useCallback, useState, type FC } from "react";
import { AlertTriangle, Loader2, RefreshCw, X } from "lucide-react";
import { useFirmwareUpdate } from "@/lib/FirmwareUpdateContext";

/**
 * Modal popup shown when the downloaded firmware .bin fails sha256
 * verification against the manifest. Mounted at Shell level so it
 * surfaces regardless of which page the user is on.
 *
 * The integrity error stays on the main-side state until the user
 * acknowledges it — that way the popup is reliable even if the
 * renderer was on a different page when the failure happened.
 */
const IntegrityErrorDialog: FC = () => {
  const { state, ackIntegrityError, refresh } = useFirmwareUpdate();
  const err = state.integrityError;
  const [retrying, setRetrying] = useState(false);

  const onDismiss = useCallback(() => {
    void ackIntegrityError();
  }, [ackIntegrityError]);

  const onRetry = useCallback(async () => {
    setRetrying(true);
    try {
      await ackIntegrityError();
      await refresh();
    } finally {
      setRetrying(false);
    }
  }, [ackIntegrityError, refresh]);

  if (!err) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-6">
      <div className="ui-card w-full max-w-lg p-6">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-500/15">
            <AlertTriangle className="h-5 w-5 text-red-500" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
              Firmware integrity check failed
            </h2>
            <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">
              The firmware <strong>{err.version}</strong> we just downloaded
              from <code className="font-mono text-xs">{err.sourceUrl}</code>{" "}
              does not match the sha256 declared in the manifest. The corrupt
              file has been deleted and <em>will not</em> be flashed to your
              Orion.
            </p>
            <details className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-[11px] dark:border-zinc-800 dark:bg-zinc-900">
              <summary className="cursor-pointer text-zinc-500 dark:text-zinc-400">
                Details
              </summary>
              <dl className="mt-2 space-y-1 font-mono text-zinc-700 dark:text-zinc-300">
                <div className="flex gap-2">
                  <dt className="w-20 shrink-0 text-zinc-500">expected</dt>
                  <dd className="break-all">{err.expected || "—"}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-20 shrink-0 text-zinc-500">got</dt>
                  <dd className="break-all">{err.got}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-20 shrink-0 text-zinc-500">when</dt>
                  <dd>{new Date(err.whenIso).toLocaleString()}</dd>
                </div>
              </dl>
            </details>
            <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
              Possible causes: transient network corruption (try again), a
              mismatched sha256 in the published manifest (republish), or the
              CDN serving a stale copy.
            </p>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button type="button" onClick={onDismiss} className="btn-ghost">
            Dismiss
          </button>
          <button
            type="button"
            onClick={() => void onRetry()}
            disabled={retrying}
            className="btn-accent disabled:opacity-40"
          >
            {retrying ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Retry download
          </button>
        </div>
      </div>
    </div>
  );
};

export default IntegrityErrorDialog;
