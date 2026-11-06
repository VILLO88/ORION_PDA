import { useEffect, useMemo, useState, type FC } from "react";
import {
  ArrowRight,
  RefreshCw,
  BookOpen,
  Music2,
  Video,
  StickyNote,
  FolderOpen,
  FolderSync,
  Database,
  Zap,
  CheckCircle2,
  AlertTriangle,
  Inbox,
  Loader2,
  Trash2,
} from "lucide-react";
import { useDevices } from "@/lib/DeviceContext";
import { api } from "@/lib/api";
import NewsletterCard from "@/components/NewsletterCard";
import { useActivity, type ActivityEntry, type ActivityKind } from "@/lib/ActivityContext";
import type { DeviceStorageResponse } from "@shared/ipc-types";

interface Props {
  onNavigate: (page: string) => void;
}

// ---------------------------------------------------------------------------
//  Sub-components
// ---------------------------------------------------------------------------

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

const STORAGE_SEGMENTS = [
  { key: "notes", label: "Notes",        color: "bg-sky-500" },
  { key: "memos", label: "Voice memos",  color: "bg-violet-500" },
  { key: "music", label: "Music",        color: "bg-emerald-500" },
  { key: "video", label: "Video",        color: "bg-accent" },
  { key: "other", label: "Other",        color: "bg-zinc-400 dark:bg-zinc-500" },
] as const;
type SegmentKey = (typeof STORAGE_SEGMENTS)[number]["key"];

const EMPTY_STORAGE: DeviceStorageResponse = {
  totalBytes: 0,
  freeBytes: 0,
  usedBytes: 0,
  breakdown: { notes: 0, memos: 0, music: 0, video: 0, other: 0 },
};

const StorageBar: FC<{
  storage: DeviceStorageResponse | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  /** Se false: barra grigia vuota + tutti i valori a 0, refresh disabilitato. */
  deviceConnected: boolean;
}> = ({ storage, loading, error, onRefresh, deviceConnected }) => {
  const data = deviceConnected ? storage : EMPTY_STORAGE;

  return (
    <div className="ui-card p-5">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          Storage
        </h3>
        <div className="flex items-center gap-3">
          {data && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {formatBytes(data.usedBytes)} / {formatBytes(data.totalBytes)} used
            </p>
          )}
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading || !deviceConnected}
            className="rounded p-1 text-zinc-400 hover:text-zinc-700 disabled:opacity-40 dark:hover:text-zinc-200"
            title={deviceConnected ? "Refresh" : "No device connected"}
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>

      {error && deviceConnected && !storage ? (
        <p className="rounded bg-red-500/10 p-2 text-xs text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : !data || (deviceConnected && !storage && loading) ? (
        <div className="flex h-2 w-full animate-pulse overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800" />
      ) : (
        <>
          <div className="flex h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
            {STORAGE_SEGMENTS.map((seg) => {
              const bytes = data.breakdown[seg.key as SegmentKey];
              const pct = data.totalBytes > 0 ? (bytes / data.totalBytes) * 100 : 0;
              if (pct <= 0) return null;
              return (
                <div
                  key={seg.key}
                  className={seg.color}
                  style={{ width: `${pct}%` }}
                  title={`${seg.label}: ${formatBytes(bytes)}`}
                />
              );
            })}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3 lg:grid-cols-5">
            {STORAGE_SEGMENTS.map((seg) => {
              const bytes = data.breakdown[seg.key as SegmentKey];
              return (
                <div key={seg.key} className="flex items-center gap-2">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${seg.color}`} />
                  <span className="text-zinc-700 dark:text-zinc-300">
                    {seg.label}
                  </span>
                  <span className="ml-auto text-zinc-500 dark:text-zinc-500">
                    {formatBytes(bytes)}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-[11px] text-zinc-400">
            {deviceConnected
              ? `Free: ${formatBytes(data.freeBytes)}`
              : "No device connected"}
          </p>
        </>
      )}
    </div>
  );
};

const KIND_ICON: Record<ActivityKind, typeof BookOpen> = {
  "ebook-convert":   BookOpen,
  "mp3-convert":     Music2,
  "video-convert":   Video,
  "notes-backup":    StickyNote,
  "obsidian-sync":   FolderSync,
  "notion-sync":     Database,
  "files-upload":    FolderOpen,
  "files-delete":    FolderOpen,
  "firmware-flash":  Zap,
};

const RecentActivity: FC<{ items: ActivityEntry[]; onClear: () => void }> = ({
  items,
  onClear,
}) => {
  const visible = items.slice(0, 6);
  return (
    <div className="ui-card p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          Recent Activity
        </h3>
        {items.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
            title="Clear history"
          >
            <Trash2 className="h-3 w-3" />
            Clear
          </button>
        )}
      </div>

      {visible.length === 0 ? (
        <div className="flex items-center gap-3 rounded-lg border border-dashed border-zinc-200 px-3 py-4 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          <Inbox className="h-4 w-4 text-zinc-400" />
          No activity yet. Convert a file or back up your notes to start
          tracking history here.
        </div>
      ) : (
        <ul className="space-y-2.5">
          {visible.map((it) => {
            const Icon = KIND_ICON[it.kind] ?? CheckCircle2;
            const ok = it.status === "ok";
            return (
              <li
                key={it.id}
                className="flex items-center justify-between gap-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <Icon className="h-4 w-4 shrink-0 text-zinc-400" />
                  <div className="min-w-0">
                    <p className="truncate text-sm text-zinc-800 dark:text-zinc-100">
                      {it.title}
                    </p>
                    <p className="truncate text-[11px] text-zinc-500">
                      {it.detail
                        ? `${it.detail} · ${formatRelative(it.whenIso)}`
                        : formatRelative(it.whenIso)}
                    </p>
                  </div>
                </div>
                {ok ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                ) : (
                  <AlertTriangle className="h-4 w-4 shrink-0 text-red-500" />
                )}
              </li>
            );
          })}
        </ul>
      )}

      {items.length > visible.length && (
        <p className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-zinc-400">
          {items.length - visible.length} more entries
          <ArrowRight className="h-3 w-3" />
        </p>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
//  HomePage
// ---------------------------------------------------------------------------

const HomePage: FC<Props> = ({ onNavigate }) => {
  const { devices } = useDevices();
  const device = devices[0];
  const { entries, clear } = useActivity();

  const [storage, setStorage] = useState<DeviceStorageResponse | null>(null);
  const [storageLoading, setStorageLoading] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [refreshCounter, setRefreshCounter] = useState(0);

  useEffect(() => {
    if (!device) {
      setStorage(null);
      setStorageError(null);
      setStorageLoading(false);
      return;
    }
    let cancelled = false;
    setStorageLoading(true);
    setStorageError(null);
    api.storage
      .read({ mountPath: device.mountPath })
      .then((s) => {
        if (cancelled) return;
        setStorage(s);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setStorageError(e.message);
        setStorage(null);
      })
      .finally(() => {
        if (!cancelled) setStorageLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [device?.mountPath, refreshCounter]);

  const recent = useMemo(() => entries, [entries]);

  return (
    <div className="grid h-full gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(360px,1fr)]">
      {/* Colonna principale */}
      <div className="flex min-w-0 flex-col gap-5">
        {/* Device summary — sempre visibile, mostra "Not connected" se assente */}
        <div className="ui-card flex items-center justify-between gap-4 p-5">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">
              Connected device
            </p>
            <p className="mt-1 text-xl font-semibold text-zinc-900 dark:text-zinc-50">
              {device ? (device.deviceId ?? device.label) : "Not connected"}
            </p>
            <div className="mt-1 flex items-center gap-2 text-xs">
              <span className="text-zinc-500 dark:text-zinc-400">
                Firmware {device?.fwVersion ?? "—"}
              </span>
              {device ? (
                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                  Up to date
                </span>
              ) : (
                <span className="rounded-full bg-zinc-500/15 px-2 py-0.5 text-[10px] font-medium text-zinc-500 dark:text-zinc-400">
                  Offline
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => onNavigate("device")}
            disabled={!device}
            className="btn-ghost disabled:opacity-40"
          >
            Device info
          </button>
        </div>

        {/* Storage — sempre visibile, segmenti a 0 se nessun device */}
        <StorageBar
          storage={storage}
          loading={storageLoading}
          error={storageError}
          onRefresh={() => setRefreshCounter((n) => n + 1)}
          deviceConnected={!!device}
        />

        {/* Recent activity — entries reali da useActivity */}
        <RecentActivity items={recent} onClear={clear} />
      </div>

      {/* Colonna destra: newsletter — cresce proporzionalmente con la finestra */}
      <div className="flex h-full min-h-[480px] min-w-0 flex-col">
        <NewsletterCard />
      </div>
    </div>
  );
};

export default HomePage;
