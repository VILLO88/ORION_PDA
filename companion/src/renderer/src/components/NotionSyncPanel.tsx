import { useCallback, useEffect, useState } from "react";
import {
  Link2,
  Loader2,
  RefreshCw,
  Unlink,
} from "lucide-react";
import { api } from "@/lib/api";
import { useActivity } from "@/lib/ActivityContext";
import type { NotionPageRef, NotionStatusResponse } from "@shared/ipc-types";

interface NotionSyncPanelProps {
  /** Mount del device, o null se nessun device connesso. */
  mountPath: string | null;
  /** Ricarica l'albero note dopo un sync (può importare nuovi file). */
  onSynced: () => void;
  /** Aggiorna la status bar condivisa della pagina. */
  setStatus: (s: string) => void;
}

const NotionSyncPanel = ({
  mountPath,
  onSynced,
  setStatus,
}: NotionSyncPanelProps) => {
  const { log: logActivity } = useActivity();

  const [status, setStatusState] = useState<NotionStatusResponse>({
    connected: false,
  });
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [pages, setPages] = useState<NotionPageRef[] | null>(null);
  const [loadingPages, setLoadingPages] = useState(false);
  const [syncErrors, setSyncErrors] = useState<
    { relKey: string; message: string }[]
  >([]);

  const refreshStatus = useCallback(async () => {
    try {
      setStatusState(await api.notion.status());
    } catch {
      setStatusState({ connected: false });
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const onConnect = async () => {
    setConnecting(true);
    setStatus("Apertura del login Notion nel browser…");
    try {
      const r = await api.notion.connect();
      setStatus(
        r.connected
          ? `✓ Notion collegato: ${r.workspaceName ?? ""}`
          : "Notion non collegato.",
      );
      await refreshStatus();
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`);
    } finally {
      setConnecting(false);
    }
  };

  const onDisconnect = async () => {
    try {
      await api.notion.disconnect();
      setPages(null);
      await refreshStatus();
      setStatus("Notion scollegato.");
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`);
    }
  };

  const loadPages = async () => {
    setLoadingPages(true);
    try {
      const r = await api.notion.listPages();
      setPages(r.pages);
      if (r.pages.length === 0) {
        setStatus(
          "Nessuna pagina condivisa: in Notion apri ⋯ → Connections → la tua integrazione, sulle pagine che vuoi sincronizzare.",
        );
      }
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`);
    } finally {
      setLoadingPages(false);
    }
  };

  const onPickParent = async (pageId: string) => {
    const page = pages?.find((p) => p.id === pageId);
    if (!page) return;
    try {
      await api.notion.setParent({ pageId: page.id, title: page.title });
      await refreshStatus();
      setStatus(`Pagina genitore: ${page.title}`);
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`);
    }
  };

  const onSync = async () => {
    if (!mountPath) return;
    setSyncing(true);
    setStatus("Syncing with Notion…");
    try {
      const r = await api.notion.sync({ mountPath });
      setSyncErrors(r.errors);
      const parts: string[] = [];
      if (r.pushed.length) parts.push(`↑${r.pushed.length} to Notion`);
      if (r.pulled.length) parts.push(`↓${r.pulled.length} to device`);
      if (r.deletedNotion.length)
        parts.push(`−${r.deletedNotion.length} in Notion`);
      if (r.deletedDevice.length)
        parts.push(`−${r.deletedDevice.length} on device`);
      if (r.conflicts.length)
        parts.push(
          `⚠ ${r.conflicts.length} conflict${r.conflicts.length === 1 ? "" : "s"}`,
        );
      if (r.errors.length)
        parts.push(`${r.errors.length} error${r.errors.length === 1 ? "" : "s"}`);
      const summary = parts.length
        ? parts.join(" · ")
        : `already in sync (${r.unchanged} note${r.unchanged === 1 ? "" : "s"})`;
      setStatus(`✓ Notion sync: ${summary}`);
      logActivity({
        kind: "notion-sync",
        status: r.errors.length ? "error" : "ok",
        title: `Notion sync: ${summary}`,
        detail: status.workspaceName,
      });
      onSynced();
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`);
      logActivity({
        kind: "notion-sync",
        status: "error",
        title: "Notion sync failed",
        detail: (e as Error).message,
      });
    } finally {
      setSyncing(false);
    }
  };

  // ---- Not connected ------------------------------------------------------

  if (!status.connected) {
    return (
      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => void onConnect()}
          disabled={connecting}
          className="btn-accent self-start"
        >
          {connecting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Link2 className="h-4 w-4" />
          )}
          Collega Notion
        </button>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Si apre il browser: accedi a Notion e <strong>scegli quali pagine
          condividere</strong>. L'app vede solo le pagine che selezioni.
        </p>
      </div>
    );
  }

  // ---- Connected ----------------------------------------------------------

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
        <span>Workspace:</span>
        <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono dark:bg-zinc-800">
          {status.workspaceName}
        </code>
        <button
          type="button"
          onClick={() => void onDisconnect()}
          className="inline-flex items-center gap-1 rounded border border-zinc-200 px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          <Unlink className="h-3 w-3" />
          Scollega
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
        <span>Pagina genitore:</span>
        {status.parentPageTitle ? (
          <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono dark:bg-zinc-800">
            {status.parentPageTitle}
          </code>
        ) : (
          <span className="italic">non scelta</span>
        )}
        {pages === null ? (
          <button
            type="button"
            onClick={() => void loadPages()}
            disabled={loadingPages}
            className="inline-flex items-center gap-1 rounded border border-zinc-200 px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {loadingPages ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            {status.parentPageTitle ? "Change" : "Choose page…"}
          </button>
        ) : (
          <select
            value={status.parentPageId ?? ""}
            onChange={(e) => void onPickParent(e.target.value)}
            className="rounded border border-zinc-300 bg-white px-2 py-0.5 text-xs text-zinc-900 outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          >
            <option value="" disabled>
              {pages.length ? "Seleziona una pagina…" : "Nessuna pagina condivisa"}
            </option>
            {pages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        )}
      </div>

      <button
        type="button"
        onClick={() => void onSync()}
        disabled={syncing || !mountPath || !status.parentPageId}
        className="btn-accent self-start"
        title={
          !mountPath
            ? "Connect the device first"
            : !status.parentPageId
              ? "Choose a parent page first"
              : "Two-way sync with Notion"
        }
      >
        {syncing ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <RefreshCw className="h-4 w-4" />
        )}
        Sync now
      </button>

      {syncErrors.length > 0 && (
        <div className="mt-1 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
          <p className="mb-1 font-medium">
            {syncErrors.length} error{syncErrors.length === 1 ? "" : "s"} during
            sync:
          </p>
          <ul className="list-disc space-y-0.5 pl-4">
            {Array.from(new Set(syncErrors.map((e) => e.message)))
              .slice(0, 5)
              .map((msg) => (
                <li key={msg} className="break-words font-mono">
                  {msg}
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default NotionSyncPanel;
