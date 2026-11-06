import { useState, type FC } from "react";
import {
  AlertTriangle,
  Bell,
  Cpu,
  Loader2,
  Moon,
  Sun,
  Power,
} from "lucide-react";
import { useTheme } from "@/lib/ThemeContext";
import { useDevices } from "@/lib/DeviceContext";
import { useFirmwareUpdate } from "@/lib/FirmwareUpdateContext";
import { api } from "@/lib/api";

interface Props {
  /** Titolo della pagina corrente (mostrato in alto a sinistra). */
  title: string;
  subtitle?: string;
}

const greeting = (): string => {
  const h = new Date().getHours();
  if (h < 6) return "Good night";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
};

const Header: FC<Props> = ({ title, subtitle }) => {
  const { theme, toggle } = useTheme();
  const { devices } = useDevices();
  const device = devices[0];
  const isHome = title === "Home";
  const { state: fwState, refresh: refreshFw } = useFirmwareUpdate();
  const latestVersion = fwState.latest?.version ?? null;
  const fwLabel = fwState.fetching && !latestVersion
    ? "Checking…"
    : latestVersion
      ? `Latest fw: ${latestVersion}`
      : fwState.fetchError
        ? "Latest fw: offline"
        : "Latest fw: —";

  const [ejecting, setEjecting] = useState(false);
  const onEject = async () => {
    if (!device) return;
    setEjecting(true);
    try {
      const r = await api.device.eject({ mountPath: device.mountPath });
      if (!r.ok) {
        // eslint-disable-next-line no-alert
        alert(`Eject failed: ${r.message ?? "unknown error"}`);
      }
    } catch (e) {
      // eslint-disable-next-line no-alert
      alert(`Eject failed: ${(e as Error).message}`);
    } finally {
      setEjecting(false);
    }
  };

  return (
    <header className="flex items-start justify-between border-b border-zinc-200 bg-white px-8 py-5 dark:border-zinc-800 dark:bg-zinc-950">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          {isHome ? (
            <span>
              {greeting()} <span aria-hidden>👋</span>
            </span>
          ) : (
            title
          )}
        </h1>
        {subtitle && (
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {subtitle}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2">
        {device && (
          <button
            type="button"
            onClick={() => void onEject()}
            disabled={ejecting}
            className="btn-ghost disabled:opacity-50"
            title={`Safely eject ${device.label}`}
          >
            {ejecting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Power className="h-4 w-4" />
            )}
            Eject
          </button>
        )}
        <button
          type="button"
          onClick={() => void refreshFw()}
          disabled={fwState.fetching}
          title={
            fwState.fetchError
              ? `Last fetch failed: ${fwState.fetchError}. Click to retry.`
              : fwState.lastFetchedAt
                ? `Last checked: ${new Date(fwState.lastFetchedAt).toLocaleString()}`
                : "Click to check for firmware updates"
          }
          className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          {fwState.fetching ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />
          ) : fwState.fetchError ? (
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
          ) : (
            <Cpu className="h-3.5 w-3.5 text-zinc-400" />
          )}
          <span className="font-mono">{fwLabel}</span>
        </button>
        <button
          type="button"
          className="rounded-lg border border-zinc-200 bg-white p-2 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          aria-label="Notifications"
        >
          <Bell className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={toggle}
          className="rounded-lg border border-zinc-200 bg-white p-2 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          aria-label="Toggle theme"
          title={theme === "dark" ? "Switch to light" : "Switch to dark"}
        >
          {theme === "dark" ? (
            <Sun className="h-4 w-4" />
          ) : (
            <Moon className="h-4 w-4" />
          )}
        </button>
      </div>
    </header>
  );
};

export default Header;
