import { useState } from "react";
import { RefreshCw, HardDrive, Hash, Clock, AlertTriangle } from "lucide-react";
import { useDevices } from "@/lib/DeviceContext";
import { isElectron } from "@/lib/api";
import type { DeviceInfo } from "@shared/ipc-types";

const DeviceCard = ({ d }: { d: DeviceInfo }) => (
  <div className="ui-card p-5">
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
          Device
        </p>
        <h3 className="mt-1 text-xl font-semibold text-zinc-900 dark:text-zinc-50">
          {d.deviceId ?? d.label}
        </h3>
      </div>
      <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
        Connected
      </span>
    </div>
    <dl className="grid grid-cols-[24px_120px_1fr] items-center gap-x-3 gap-y-2 text-sm">
      <HardDrive className="h-4 w-4 text-zinc-400" />
      <dt className="text-zinc-500 dark:text-zinc-400">Mount</dt>
      <dd className="font-mono text-zinc-800 dark:text-zinc-200">{d.mountPath}</dd>

      <Hash className="h-4 w-4 text-zinc-400" />
      <dt className="text-zinc-500 dark:text-zinc-400">Firmware</dt>
      <dd className="text-zinc-800 dark:text-zinc-200">
        {d.fwVersion ?? <em className="text-zinc-400">unknown</em>}
      </dd>

      <Clock className="h-4 w-4 text-zinc-400" />
      <dt className="text-zinc-500 dark:text-zinc-400">Last seen</dt>
      <dd className="text-zinc-800 dark:text-zinc-200">
        {d.lastSeen ?? <em className="text-zinc-400">never</em>}
      </dd>
    </dl>
  </div>
);

const DevicePage = () => {
  const { devices, ready, refresh } = useDevices();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-5">
      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing || !isElectron}
          className="btn-ghost"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {!isElectron && (
        <div className="ui-card flex items-start gap-3 border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-500/50 dark:bg-amber-500/10 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">Renderer aperto in browser.</p>
            <p className="opacity-80">
              Per l'esperienza completa apri l'app con{" "}
              <code className="rounded bg-black/10 px-1 dark:bg-black/30">
                npm run dev
              </code>
              ; la finestra Electron carica il preload e abilita l'IPC.
            </p>
          </div>
        </div>
      )}

      {ready && devices.length === 0 && isElectron && (
        <div className="flex flex-1 items-center justify-center">
          <div className="ui-card max-w-md p-8 text-center">
            <p className="text-zinc-800 dark:text-zinc-100">
              No Orion device connected.
            </p>
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              Connect the PDA V3 via USB in MSC mode. The app looks for a{" "}
              <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">
                .orion-device
              </code>{" "}
              file in the root of every mounted USB volume.
            </p>
          </div>
        </div>
      )}

      {devices.length > 0 && (
        <div className="grid gap-3">
          {devices.map((d) => (
            <DeviceCard key={d.mountPath} d={d} />
          ))}
        </div>
      )}
    </div>
  );
};

export default DevicePage;
