import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FC,
} from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Loader2,
  Power,
  RefreshCw,
  ShieldAlert,
  Zap,
} from "lucide-react";
import { api } from "@/lib/api";
import { useDevices } from "@/lib/DeviceContext";
import { useFirmwareUpdate } from "@/lib/FirmwareUpdateContext";
import { useActivity } from "@/lib/ActivityContext";
import type {
  DfuDevice,
  FirmwareFlashProgress,
  FirmwareFlashResult,
} from "@shared/ipc-types";

/**
 * Firmware update flow (fully automated):
 *
 *   1. App boot → main downloads the latest manifest + .bin in background.
 *   2. Device connect → companion reads `<ver>.fwver` from SD root.
 *   3. If local version < latest version → "Update available" card shown.
 *      The sidebar icon also blinks (handled in Shell) and we auto-route
 *      here on first detection.
 *   4. User clicks "Start update" → confirmation modal
 *      ("Please do not disconnect the device during the update.")
 *   5. Companion writes empty `DFU` file on SD root, then ejects.
 *   6. Firmware (still in USB MSC mode) sees the trigger, reboots into
 *      the STM32 system bootloader (VID:PID 0483:df11).
 *   7. Companion polls dfu-util -l until the bootloader appears, then
 *      flashes the cached .bin. Progress streamed live.
 *   8. On success the device reboots into normal firmware. On its next
 *      boot the firmware rewrites the .fwver file with the new version
 *      and deletes the leftover DFU file.
 */

const DFU_WAIT_TIMEOUT_MS = 90_000;
const DFU_POLL_INTERVAL_MS = 1_000;

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

type FlowPhase =
  | "idle"
  | "confirming"
  | "triggering"
  | "waiting-dfu"
  | "flashing"
  | "done"
  | "error";

const ConfirmModal: FC<{
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ onConfirm, onCancel }) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
    <div className="ui-card w-full max-w-md p-6">
      <div className="flex items-start gap-3">
        <ShieldAlert className="mt-0.5 h-6 w-6 shrink-0 text-accent" />
        <div>
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
            Update firmware?
          </h2>
          <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">
            <strong>Please do not disconnect the device during the update.</strong>
          </p>
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
            The companion will write a DFU trigger on the SD card and eject
            the volume. Orion will reboot into bootloader mode and the new
            firmware will be flashed automatically. The whole process takes
            about 30–60 seconds.
          </p>
        </div>
      </div>
      <div className="mt-5 flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn-ghost">
          Cancel
        </button>
        <button type="button" onClick={onConfirm} className="btn-accent">
          <Zap className="h-4 w-4" />
          Start update
        </button>
      </div>
    </div>
  </div>
);

const FirmwarePage: FC = () => {
  const { devices } = useDevices();
  const device = devices[0] ?? null;
  const {
    state: updateState,
    deviceVersion,
    updateAvailable,
    refresh,
    refreshDeviceVersion,
  } = useFirmwareUpdate();
  const { log: logActivity } = useActivity();

  const [phase, setPhase] = useState<FlowPhase>("idle");
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [progress, setProgress] = useState<FirmwareFlashProgress | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [result, setResult] = useState<FirmwareFlashResult | null>(null);
  const [dfuDevice, setDfuDevice] = useState<DfuDevice | null>(null);
  const [dfuUtilAvailable, setDfuUtilAvailable] = useState<boolean | null>(null);

  const cancelRef = useRef<{ aborted: boolean } | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  // Background DFU polling: ogni 5s mentre la pagina è in idle (e quindi
  // anche quando l'MSC non c'è) chiediamo a dfu-util se vede Orion in
  // bootloader. Così l'utente può triggerare un flash anche entrando in
  // DFU manualmente dal device, senza passare per il volume MSC.
  useEffect(() => {
    if (phase !== "idle") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const POLL_MS = 5_000;

    const tick = async (): Promise<void> => {
      try {
        const r = await api.firmware.detect();
        if (cancelled) return;
        setDfuUtilAvailable(r.dfuUtilAvailable);
        setDfuDevice(r.device);
      } catch {
        // ignored — dfu-util può fallire transiente, riproviamo al prossimo giro
      }
      if (cancelled) return;
      timer = setTimeout(() => void tick(), POLL_MS);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [phase]);

  // Subscribe to flash progress + log
  useEffect(() => {
    const unsubP = api.firmware.onProgress((ev) => setProgress(ev));
    const unsubL = api.firmware.onLog((line) => {
      setLog((prev) => {
        const next = [...prev, line];
        return next.length > 200 ? next.slice(next.length - 200) : next;
      });
    });
    return () => {
      unsubP();
      unsubL();
    };
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [log.length]);

  // ---- Flow control ------------------------------------------------------
  const startFlow = useCallback(() => {
    if (!updateState.binCached) return;
    // Due entry-point:
    //   A) MSC connesso + update disponibile → flow normale (trigger SD)
    //   B) DFU già rilevato (MSC assente, l'utente è entrato in bootloader
    //      a mano dal device) → flash diretto senza trigger SD
    const hasMsc = !!device && updateAvailable;
    const hasDirectDfu = !!dfuDevice && !device;
    if (!hasMsc && !hasDirectDfu) return;
    setPhase("confirming");
  }, [device, dfuDevice, updateAvailable, updateState.binCached]);

  const cancelFlow = useCallback(() => {
    if (cancelRef.current) cancelRef.current.aborted = true;
    void api.firmware.cancel();
    setPhase("idle");
    setStatusMessage("");
  }, []);

  const runFlow = useCallback(async () => {
    // Servono o un MSC (per trigger SD) o un DFU già rilevato.
    if (!device && !dfuDevice) return;
    setResult(null);
    setProgress(null);
    setLog([]);

    const ctrl = { aborted: false };
    cancelRef.current = ctrl;
    let found: DfuDevice | null = dfuDevice;

    try {
      // ---- Step 1: trigger SD (saltato se già in DFU) ------------------
      if (!found && device) {
        setPhase("triggering");
        setStatusMessage("Writing DFU trigger on SD and ejecting…");

        const trig = await api.firmware.update.triggerDfu({
          mountPath: device.mountPath,
        });
        if (!trig.ok) {
          setResult({ ok: false, message: trig.message ?? "DFU trigger failed" });
          setPhase("error");
          return;
        }

        // ---- Step 2: aspetta che appaia il bootloader ------------------
        setPhase("waiting-dfu");
        setStatusMessage(
          trig.ejected
            ? "Volume ejected. Waiting for Orion to enter DFU mode…"
            : "DFU trigger written. Waiting for Orion to enter DFU mode…",
        );

        const start = Date.now();
        while (!ctrl.aborted && Date.now() - start < DFU_WAIT_TIMEOUT_MS) {
          const r = await api.firmware.detect();
          setDfuUtilAvailable(r.dfuUtilAvailable);
          if (r.dfuUtilAvailable === false) {
            setResult({
              ok: false,
              message:
                "dfu-util not found. Install it or bundle the binary in the app.",
            });
            setPhase("error");
            return;
          }
          if (r.device) {
            found = r.device;
            setDfuDevice(r.device);
            break;
          }
          await new Promise((res) => setTimeout(res, DFU_POLL_INTERVAL_MS));
        }
        if (ctrl.aborted) {
          setPhase("idle");
          return;
        }
        if (!found) {
          setResult({
            ok: false,
            message:
              "Timed out waiting for the device to enter DFU mode. Try again or reset the Orion manually.",
          });
          setPhase("error");
          return;
        }
      } else {
        // DFU già attivo (utente è entrato in bootloader da menu device)
        setPhase("waiting-dfu");
        setStatusMessage("Orion is already in DFU mode. Starting flash…");
      }

      // ---- Step 3: flash -----------------------------------------------
      setPhase("flashing");
      setStatusMessage("Flashing firmware…");
      const r = await api.firmware.update.flashCached();
      setResult(r);
      if (r.ok) {
        setPhase("done");
        setStatusMessage(r.message);
        logActivity({
          kind: "firmware-flash",
          status: "ok",
          title: `Firmware updated to ${updateState.latest?.version ?? "—"}`,
          detail: `Was ${deviceVersion ?? "—"}`,
        });
        // Re-read SD version after a few seconds (device reboots and
        // rewrites the .fwver file).
        setTimeout(() => {
          void refreshDeviceVersion();
        }, 5_000);
      } else {
        setPhase("error");
        logActivity({
          kind: "firmware-flash",
          status: "error",
          title: `Firmware update failed`,
          detail: r.message,
        });
      }
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message });
      setPhase("error");
    } finally {
      cancelRef.current = null;
    }
  }, [
    device,
    dfuDevice,
    updateState.latest?.version,
    deviceVersion,
    logActivity,
    refreshDeviceVersion,
  ]);

  // ---- Render ------------------------------------------------------------
  const flowActive =
    phase === "triggering" || phase === "waiting-dfu" || phase === "flashing";
  const latest = updateState.latest;

  return (
    <div className="flex h-full flex-col gap-5">
      {phase === "confirming" && (
        <ConfirmModal
          onCancel={() => setPhase("idle")}
          onConfirm={() => void runFlow()}
        />
      )}

      {/* dfu-util availability banner */}
      {dfuUtilAvailable === false && (
        <div className="ui-card flex items-start gap-3 border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-500/50 dark:bg-red-500/10 dark:text-red-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">dfu-util not found.</p>
            <p className="mt-1 text-xs opacity-80">
              Install with <code>brew install dfu-util</code> (macOS),{" "}
              <code>sudo apt install dfu-util</code> (Linux), or bundle the
              binary in <code>src/main/resources/dfu-util/</code> for a
              packaged build.
            </p>
          </div>
        </div>
      )}

      {/* Versions overview */}
      <div className="ui-card p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
            Firmware status
          </h3>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={updateState.fetching || flowActive}
            className="inline-flex items-center gap-1 text-xs font-medium text-zinc-500 hover:text-zinc-900 disabled:opacity-40 dark:text-zinc-400 dark:hover:text-zinc-100"
            title="Re-check the orionpda.org update channel"
          >
            {updateState.fetching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Check again
          </button>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <p className="text-[11px] uppercase tracking-wider text-zinc-400">
              On device
            </p>
            <p className="mt-1 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
              {device ? (deviceVersion ?? "—") : "Not connected"}
            </p>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              {device?.label ?? "Plug in your Orion to see the running version."}
            </p>
          </div>
          <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <p className="text-[11px] uppercase tracking-wider text-zinc-400">
              Latest stable
            </p>
            <p className="mt-1 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
              {latest?.version ?? "—"}
            </p>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              {updateState.fetchError
                ? `Fetch error: ${updateState.fetchError}`
                : latest
                  ? updateState.binCached
                    ? `Downloaded · ${latest.size ? formatBytes(latest.size) : "—"}`
                    : "Downloading…"
                  : updateState.fetching
                    ? "Checking the update channel…"
                    : "No update channel reachable yet."}
            </p>
            {latest?.releaseDate && (
              <p className="mt-0.5 text-[11px] text-zinc-400">
                Published {latest.releaseDate}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Update action card */}
      <div className="ui-card p-5">
        {!device && dfuDevice && !flowActive && phase !== "done" && phase !== "error" ? (
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <CircleDot className="mt-0.5 h-4 w-4 shrink-0 animate-pulse text-accent" />
              <div>
                <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                  Orion detected in DFU (bootloader) mode
                </p>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  Ready to flash {latest?.version ?? "the latest firmware"} directly.
                  The companion can't read the running version while the
                  device is in bootloader, so make sure this is the firmware
                  you want.
                </p>
                <p className="mt-1 text-[11px] text-zinc-400">
                  STM32 BOOTLOADER · {dfuDevice.vid}:{dfuDevice.pid} · serial{" "}
                  <code className="font-mono">{dfuDevice.serial}</code>
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={startFlow}
                disabled={!updateState.binCached || dfuUtilAvailable === false}
                className="btn-accent disabled:opacity-40"
              >
                <Zap className="h-4 w-4" />
                Flash latest firmware
              </button>
            </div>
          </div>
        ) : !device && !flowActive && phase !== "done" && phase !== "error" ? (
          <div className="flex items-start gap-3 text-sm text-zinc-600 dark:text-zinc-300">
            <Power className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" />
            <p>
              Waiting for Orion… plug it in via USB (normal mode or DFU) to
              check for firmware updates.
            </p>
          </div>
        ) : flowActive || phase === "done" || phase === "error" ? (
          <div className="flex items-center gap-2">
            {flowActive && (
              <button
                type="button"
                onClick={cancelFlow}
                className="btn-ghost"
              >
                Cancel
              </button>
            )}
          </div>
        ) : updateAvailable && device ? (
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 h-2.5 w-2.5 animate-pulse rounded-full bg-accent" />
              <div>
                <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                  Update available — {deviceVersion} → {latest?.version}
                </p>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  Click below to start. Orion will reboot into DFU mode, flash
                  the new firmware, then reboot into your usual home screen.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={startFlow}
                disabled={!updateState.binCached || dfuUtilAvailable === false}
                className="btn-accent disabled:opacity-40"
              >
                <Zap className="h-4 w-4" />
                Start firmware update
              </button>
            </div>
          </div>
        ) : deviceVersion && latest ? (
          <div className="flex items-start gap-3 text-sm text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              Your Orion is on the latest stable firmware ({deviceVersion}).
            </p>
          </div>
        ) : (
          <div className="flex items-start gap-3 text-sm text-zinc-600 dark:text-zinc-300">
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-zinc-400" />
            <p>
              Reading version information…
              {!latest && " (still waiting for the update channel)"}
            </p>
          </div>
        )}

        {/* Live status during the flow */}
        {(flowActive || phase === "done" || phase === "error") && (
          <div className="mt-4 space-y-3">
            <div className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
              {phase === "triggering" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {phase === "waiting-dfu" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {phase === "flashing" && <CircleDot className="h-3.5 w-3.5 text-accent" />}
              {phase === "done" && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
              {phase === "error" && <AlertTriangle className="h-3.5 w-3.5 text-red-500" />}
              <span>{statusMessage || result?.message}</span>
            </div>

            {(phase === "flashing" || progress) && (
              <div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                  <div
                    className={`h-full transition-all ${
                      result?.ok === false
                        ? "bg-red-500"
                        : progress?.pct === 100
                          ? "bg-emerald-500"
                          : "bg-accent"
                    }`}
                    style={{ width: `${progress?.pct ?? 0}%` }}
                  />
                </div>
                <p className="mt-1 text-[11px] text-zinc-500">
                  {progress?.phase ?? "—"} · {(progress?.pct ?? 0).toFixed(0)}%
                  {progress?.bytesWritten
                    ? ` · ${formatBytes(progress.bytesWritten)}`
                    : ""}
                </p>
              </div>
            )}

            {result && !result.ok && (
              <div className="rounded bg-red-500/10 p-2 text-xs text-red-700 dark:text-red-300">
                <p className="font-medium">{result.message}</p>
                {result.stderr && (
                  <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[11px] opacity-80">
                    {result.stderr}
                  </pre>
                )}
              </div>
            )}

            {dfuDevice && (phase === "flashing" || phase === "done") && (
              <p className="text-[11px] text-zinc-500">
                STM32 BOOTLOADER · {dfuDevice.vid}:{dfuDevice.pid} · serial{" "}
                <code className="font-mono">{dfuDevice.serial}</code>
              </p>
            )}

            {log.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-zinc-500 dark:text-zinc-400">
                  <ChevronRight className="inline h-3 w-3" /> dfu-util log
                  ({log.length} lines)
                </summary>
                <pre className="mt-2 max-h-48 overflow-auto rounded bg-zinc-50 p-2 font-mono text-[11px] text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                  {log.map((line, i) => (
                    <div key={i}>{line}</div>
                  ))}
                  <div ref={logEndRef} />
                </pre>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default FirmwarePage;
