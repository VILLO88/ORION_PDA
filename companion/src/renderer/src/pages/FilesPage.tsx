import {
  useCallback,
  useEffect,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import {
  ArrowUp,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Files as FilesIcon,
  Folder,
  FolderPlus,
  HardDrive,
  Loader2,
  RefreshCw,
  Scissors,
  Trash2,
  Upload,
  Pencil,
  AlertTriangle,
  FileText,
} from "lucide-react";
import { useDevices } from "@/lib/DeviceContext";
import { useActivity } from "@/lib/ActivityContext";
import { api } from "@/lib/api";
import type { FilesEntry } from "@shared/ipc-types";

const PATH_SEP = "/"; // tutti i path che ci interessano sono POSIX su macOS/Linux;
                     // su Windows i mountPath sono "E:\\" e join continua a funzionare.

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function formatMtime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function joinPath(parent: string, name: string): string {
  if (parent.endsWith("/") || parent.endsWith("\\")) return parent + name;
  return parent + PATH_SEP + name;
}

function parentOf(p: string, root: string): string | null {
  if (p === root) return null;
  const norm = p.replace(/[\\/]+$/, "");
  const idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  if (idx < 0) return null;
  const parent = norm.slice(0, idx) || root;
  return parent.length < root.length ? root : parent;
}

function relativeSegments(p: string, root: string): string[] {
  const rel = p.startsWith(root) ? p.slice(root.length) : p;
  return rel
    .split(/[\\/]+/)
    .filter((s) => s.length > 0);
}

const FilesPage = () => {
  const { devices } = useDevices();
  const device = devices[0] ?? null;
  const { log: logActivity } = useActivity();
  const root = device?.mountPath ?? null;

  const [cwd, setCwd] = useState<string | null>(null);
  const [entries, setEntries] = useState<FilesEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dragOver, setDragOver] = useState(false);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  /** Clipboard interno: paths + modalità. `cut` rende il sorgente "grigio"
   *  finché non si fa Paste; `copy` lascia tutto com'è. */
  const [clipboard, setClipboard] = useState<{
    paths: string[];
    mode: "copy" | "cut";
  } | null>(null);

  // Quando il device cambia: torna alla root
  useEffect(() => {
    if (root) setCwd(root);
    else setCwd(null);
    setSelected(new Set());
  }, [root]);

  const reload = useCallback(async () => {
    if (!cwd) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.files.list({ path: cwd });
      setEntries(r.entries);
    } catch (e) {
      setError((e as Error).message);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // ---- Navigation -------------------------------------------------------
  const navigateTo = useCallback(
    (path: string) => {
      setCwd(path);
      setSelected(new Set());
    },
    [],
  );

  const navigateUp = useCallback(() => {
    if (!cwd || !root) return;
    const p = parentOf(cwd, root);
    if (p) navigateTo(p);
  }, [cwd, root, navigateTo]);

  // ---- Selection --------------------------------------------------------
  const toggleSelect = (path: string, multi: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (multi) {
        if (next.has(path)) next.delete(path);
        else next.add(path);
      } else {
        if (next.has(path) && next.size === 1) next.clear();
        else {
          next.clear();
          next.add(path);
        }
      }
      return next;
    });
  };

  // ---- Actions ----------------------------------------------------------
  const onDelete = async () => {
    if (selected.size === 0) return;
    const targets = [...selected];
    const ok = window.confirm(
      targets.length === 1
        ? `Delete "${targets[0].split(/[\\/]/).pop()}"?`
        : `Delete ${targets.length} items?`,
    );
    if (!ok) return;
    setBusyAction("delete");
    setError(null);
    try {
      for (const p of targets) await api.files.del({ path: p });
      setSelected(new Set());
      await reload();
      logActivity({
        kind: "files-delete",
        status: "ok",
        title:
          targets.length === 1
            ? `Deleted: ${targets[0].split(/[\\/]/).pop() ?? ""}`
            : `Deleted ${targets.length} items`,
      });
    } catch (e) {
      setError((e as Error).message);
      logActivity({
        kind: "files-delete",
        status: "error",
        title: `Delete failed`,
        detail: (e as Error).message,
      });
    } finally {
      setBusyAction(null);
    }
  };

  const onNewFolder = async () => {
    if (!cwd) return;
    const name = window.prompt("New folder name:");
    if (!name) return;
    setBusyAction("mkdir");
    setError(null);
    try {
      await api.files.mkdir({ parent: cwd, name });
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyAction(null);
    }
  };

  const onRename = async () => {
    if (selected.size !== 1 || !cwd) return;
    const path = [...selected][0];
    const oldName = path.split(/[\\/]/).pop() ?? "";
    const newName = window.prompt("New name:", oldName);
    if (!newName || newName === oldName) return;
    setBusyAction("rename");
    setError(null);
    try {
      await api.files.rename({ from: path, to: joinPath(cwd, newName) });
      setSelected(new Set());
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyAction(null);
    }
  };

  const uploadPaths = useCallback(
    async (paths: string[]) => {
      if (!cwd || paths.length === 0) return;
      setBusyAction("upload");
      setError(null);
      try {
        for (const p of paths) {
          await api.files.upload({
            sourcePath: p,
            dstDir: cwd,
            uniqueOnConflict: true,
          });
        }
        await reload();
        logActivity({
          kind: "files-upload",
          status: "ok",
          title:
            paths.length === 1
              ? `Uploaded: ${paths[0].split(/[\\/]/).pop() ?? ""}`
              : `Uploaded ${paths.length} files`,
          detail: cwd,
        });
      } catch (e) {
        setError((e as Error).message);
        logActivity({
          kind: "files-upload",
          status: "error",
          title: `Upload failed`,
          detail: (e as Error).message,
        });
      } finally {
        setBusyAction(null);
      }
    },
    [cwd, reload, logActivity],
  );

  // Sposta una lista di path nella dstDir (rename via files:move).
  const movePathsTo = useCallback(
    async (paths: string[], dstDir: string) => {
      if (paths.length === 0) return;
      setBusyAction("move");
      setError(null);
      try {
        for (const p of paths) {
          await api.files.move({
            sourcePath: p,
            dstDir,
            uniqueOnConflict: true,
          });
        }
        setSelected(new Set());
        await reload();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusyAction(null);
      }
    },
    [reload],
  );

  // Copia una lista di path nella dstDir (ricorsivo per directory).
  const copyPathsTo = useCallback(
    async (paths: string[], dstDir: string) => {
      if (paths.length === 0) return;
      setBusyAction("copy");
      setError(null);
      try {
        for (const p of paths) {
          await api.files.copy({
            sourcePath: p,
            dstDir,
            uniqueOnConflict: true,
          });
        }
        await reload();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusyAction(null);
      }
    },
    [reload],
  );

  // ---- Clipboard --------------------------------------------------------
  const onCopy = useCallback(() => {
    if (selected.size === 0) return;
    setClipboard({ paths: [...selected], mode: "copy" });
  }, [selected]);

  const onCut = useCallback(() => {
    if (selected.size === 0) return;
    setClipboard({ paths: [...selected], mode: "cut" });
  }, [selected]);

  const onPaste = useCallback(async () => {
    if (!cwd || !clipboard || clipboard.paths.length === 0) return;
    if (clipboard.mode === "cut") {
      await movePathsTo(clipboard.paths, cwd);
      setClipboard(null);
    } else {
      await copyPathsTo(clipboard.paths, cwd);
      // Per copy il clipboard resta valido (puoi incollare in più posti)
    }
  }, [cwd, clipboard, movePathsTo, copyPathsTo]);

  // ---- Keyboard shortcuts ----------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Non intercettare se l'utente sta scrivendo in un input/textarea
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const key = e.key.toLowerCase();
      if (key === "c") {
        onCopy();
        e.preventDefault();
      } else if (key === "x") {
        onCut();
        e.preventDefault();
      } else if (key === "v") {
        void onPaste();
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCopy, onCut, onPaste]);

  // ---- Drag&drop interno -----------------------------------------------
  /** Encoding semplificato dei path nel dataTransfer interno. Usiamo un
   *  MIME custom per distinguere drag interni da quelli del file system. */
  const INTERNAL_MIME = "application/x-orion-files";

  const onRowDragStart = (
    e: React.DragEvent<HTMLLIElement>,
    path: string,
  ) => {
    // Se il path non è già selezionato, lo selezioniamo (drag senza select prima)
    let paths: string[];
    if (selected.has(path)) {
      paths = [...selected];
    } else {
      setSelected(new Set([path]));
      paths = [path];
    }
    e.dataTransfer.setData(INTERNAL_MIME, JSON.stringify(paths));
    e.dataTransfer.effectAllowed = "copyMove";
  };

  const isInternalDrag = (e: React.DragEvent): boolean =>
    Array.from(e.dataTransfer.types).includes(INTERNAL_MIME);

  const onFolderDragOver = (e: React.DragEvent, path: string) => {
    if (!isInternalDrag(e) && e.dataTransfer.types.indexOf("Files") < 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = e.altKey || e.ctrlKey ? "copy" : "move";
    setDragOverPath(path);
  };

  const onFolderDrop = async (
    e: React.DragEvent,
    dstDir: string,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverPath(null);
    setDragOver(false);
    // Drag interno: muovi (o copia se Alt/Ctrl).
    if (isInternalDrag(e)) {
      try {
        const paths: string[] = JSON.parse(
          e.dataTransfer.getData(INTERNAL_MIME),
        );
        // Filtra: non droppare un path su se stesso
        const filtered = paths.filter((p) => p !== dstDir);
        if (filtered.length === 0) return;
        if (e.altKey || e.ctrlKey) {
          await copyPathsTo(filtered, dstDir);
        } else {
          await movePathsTo(filtered, dstDir);
        }
      } catch {
        // dataTransfer malformato → ignora
      }
      return;
    }
    // Drag esterno (file dal sistema): upload nella dstDir
    const files = Array.from(e.dataTransfer.files);
    const localPaths = files
      .map((f) => api.fs.getPathForFile(f))
      .filter((p) => !!p);
    if (localPaths.length > 0) {
      // Upload temporaneo nella cwd corrente; riusa l'azione esistente
      const savedCwd = cwd;
      setBusyAction("upload");
      setError(null);
      try {
        for (const p of localPaths) {
          await api.files.upload({
            sourcePath: p,
            dstDir,
            uniqueOnConflict: true,
          });
        }
        if (savedCwd === cwd) await reload();
        logActivity({
          kind: "files-upload",
          status: "ok",
          title:
            localPaths.length === 1
              ? `Uploaded: ${localPaths[0].split(/[\\/]/).pop() ?? ""}`
              : `Uploaded ${localPaths.length} files`,
          detail: dstDir,
        });
      } catch (err) {
        setError((err as Error).message);
        logActivity({
          kind: "files-upload",
          status: "error",
          title: `Upload failed`,
          detail: (err as Error).message,
        });
      } finally {
        setBusyAction(null);
      }
    }
  };

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      // Riusa la stessa logica delle folder rows ma con target = cwd corrente.
      if (!cwd) return;
      void onFolderDrop(e, cwd);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cwd, copyPathsTo, movePathsTo, reload],
  );

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    const paths = files.map((f) => api.fs.getPathForFile(f)).filter((p) => !!p);
    void uploadPaths(paths);
    e.target.value = "";
  };

  // ---- Render -----------------------------------------------------------
  if (!device || !root || !cwd) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="ui-card max-w-md p-10 text-center">
          <HardDrive className="mx-auto h-8 w-8 text-zinc-400" />
          <p className="mt-3 text-zinc-800 dark:text-zinc-100">
            No device connected.
          </p>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Connect the PDA V3 via USB MSC to browse its SD card.
          </p>
        </div>
      </div>
    );
  }

  const segments = relativeSegments(cwd, root);
  const canGoUp = cwd !== root;

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Toolbar + breadcrumb */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={navigateUp}
          disabled={!canGoUp}
          className="btn-ghost disabled:opacity-40"
          title="Go up"
        >
          <ArrowUp className="h-4 w-4" />
        </button>

        <div className="flex flex-1 items-center gap-1 overflow-hidden rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-800 dark:bg-zinc-900">
          <HardDrive className="h-4 w-4 shrink-0 text-zinc-400" />
          <button
            type="button"
            onClick={() => navigateTo(root)}
            onDragOver={(ev) => onFolderDragOver(ev, root)}
            onDragLeave={() => {
              if (dragOverPath === root) setDragOverPath(null);
            }}
            onDrop={(ev) => void onFolderDrop(ev, root)}
            className={`truncate font-mono text-xs text-zinc-700 hover:text-accent dark:text-zinc-200 ${
              dragOverPath === root ? "rounded bg-accent-soft px-1 text-accent" : ""
            }`}
          >
            {device.label}
          </button>
          {segments.map((seg, i) => {
            const target =
              root.replace(/[\\/]+$/, "") +
              PATH_SEP +
              segments.slice(0, i + 1).join(PATH_SEP);
            return (
              <span key={target} className="flex items-center gap-1">
                <ChevronRight className="h-3 w-3 shrink-0 text-zinc-400" />
                <button
                  type="button"
                  onClick={() => navigateTo(target)}
                  onDragOver={(ev) => onFolderDragOver(ev, target)}
                  onDragLeave={() => {
                    if (dragOverPath === target) setDragOverPath(null);
                  }}
                  onDrop={(ev) => void onFolderDrop(ev, target)}
                  className={`truncate font-mono text-xs text-zinc-700 hover:text-accent dark:text-zinc-200 ${
                    dragOverPath === target ? "rounded bg-accent-soft px-1 text-accent" : ""
                  }`}
                >
                  {seg}
                </button>
              </span>
            );
          })}
        </div>

        <button
          type="button"
          onClick={() => void reload()}
          disabled={loading}
          className="btn-ghost disabled:opacity-40"
          title="Refresh"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
        </button>

        <button
          type="button"
          onClick={() => void onNewFolder()}
          disabled={!!busyAction}
          className="btn-ghost disabled:opacity-40"
          title="New folder"
        >
          <FolderPlus className="h-4 w-4" />
          New folder
        </button>

        <label className="btn-ghost cursor-pointer">
          <Upload className="h-4 w-4" />
          Upload
          <input
            type="file"
            multiple
            onChange={onPick}
            className="hidden"
            disabled={!!busyAction}
          />
        </label>

        <button
          type="button"
          onClick={onCopy}
          disabled={!!busyAction || selected.size === 0}
          className="btn-ghost disabled:opacity-40"
          title="Copy (Cmd/Ctrl+C)"
        >
          <Copy className="h-4 w-4" />
          Copy
        </button>

        <button
          type="button"
          onClick={onCut}
          disabled={!!busyAction || selected.size === 0}
          className="btn-ghost disabled:opacity-40"
          title="Cut (Cmd/Ctrl+X)"
        >
          <Scissors className="h-4 w-4" />
          Cut
        </button>

        <button
          type="button"
          onClick={() => void onPaste()}
          disabled={!!busyAction || !clipboard || clipboard.paths.length === 0}
          className="btn-ghost disabled:opacity-40"
          title="Paste (Cmd/Ctrl+V)"
        >
          <ClipboardPaste className="h-4 w-4" />
          Paste{clipboard && clipboard.paths.length > 1
            ? ` (${clipboard.paths.length})`
            : ""}
        </button>

        <button
          type="button"
          onClick={() => void onRename()}
          disabled={!!busyAction || selected.size !== 1}
          className="btn-ghost disabled:opacity-40"
          title="Rename"
        >
          <Pencil className="h-4 w-4" />
          Rename
        </button>

        <button
          type="button"
          onClick={() => void onDelete()}
          disabled={!!busyAction || selected.size === 0}
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100 disabled:opacity-40 dark:border-red-500/50 dark:bg-red-500/10 dark:text-red-300 dark:hover:bg-red-500/20"
          title="Delete"
        >
          <Trash2 className="mr-1 inline-block h-4 w-4 align-text-bottom" />
          Delete{selected.size > 1 ? ` (${selected.size})` : ""}
        </button>
      </div>

      {error && (
        <div className="ui-card flex items-start gap-2 border-red-300 bg-red-50 p-2 text-xs text-red-800 dark:border-red-500/50 dark:bg-red-500/10 dark:text-red-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Listing — drop target */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!busyAction) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`ui-card flex min-h-0 flex-1 flex-col overflow-hidden transition-colors ${
          dragOver ? "border-accent bg-accent-soft" : ""
        }`}
      >
        {entries.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 py-10 text-sm text-zinc-500">
            <FilesIcon className="h-8 w-8 text-zinc-300" />
            {loading ? "Loading…" : "Empty folder. Drop files here to upload."}
          </div>
        ) : (
          <ul className="flex-1 overflow-auto divide-y divide-zinc-100 dark:divide-zinc-800">
            {entries.map((e) => {
              const isSelected = selected.has(e.path);
              const isCut =
                clipboard?.mode === "cut" && clipboard.paths.includes(e.path);
              const isDropTarget = e.isDirectory && dragOverPath === e.path;
              return (
                <li
                  key={e.path}
                  draggable
                  onDragStart={(ev) => onRowDragStart(ev, e.path)}
                  onDragOver={(ev) => {
                    if (e.isDirectory) onFolderDragOver(ev, e.path);
                  }}
                  onDragLeave={() => {
                    if (dragOverPath === e.path) setDragOverPath(null);
                  }}
                  onDrop={(ev) => {
                    if (e.isDirectory) void onFolderDrop(ev, e.path);
                  }}
                  onClick={(ev) =>
                    toggleSelect(e.path, ev.metaKey || ev.ctrlKey || ev.shiftKey)
                  }
                  onDoubleClick={() => {
                    if (e.isDirectory) navigateTo(e.path);
                  }}
                  className={`flex cursor-pointer items-center gap-3 px-4 py-2 text-sm transition-colors ${
                    isDropTarget
                      ? "bg-accent-soft ring-1 ring-accent"
                      : isSelected
                        ? "bg-accent-soft"
                        : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                  } ${isCut ? "opacity-50" : ""}`}
                >
                  {e.isDirectory ? (
                    <Folder className="h-4 w-4 shrink-0 text-accent" />
                  ) : (
                    <FileText className="h-4 w-4 shrink-0 text-zinc-400" />
                  )}
                  <span
                    className={`flex-1 truncate ${
                      isSelected
                        ? "font-medium text-accent"
                        : "text-zinc-800 dark:text-zinc-100"
                    }`}
                  >
                    {e.name}
                  </span>
                  <span className="hidden w-24 text-right text-xs text-zinc-500 sm:inline">
                    {e.isDirectory ? "—" : formatBytes(e.size)}
                  </span>
                  <span className="hidden w-40 text-right text-xs text-zinc-500 md:inline">
                    {formatMtime(e.mtimeIso)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {busyAction && (
          <div className="border-t border-zinc-100 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800">
            <Loader2 className="mr-2 inline h-3 w-3 animate-spin" />
            {busyAction === "upload" && "Uploading…"}
            {busyAction === "delete" && "Deleting…"}
            {busyAction === "move" && "Moving…"}
            {busyAction === "copy" && "Copying…"}
            {busyAction === "mkdir" && "Creating folder…"}
            {busyAction === "rename" && "Renaming…"}
          </div>
        )}
      </div>

      <p className="text-[11px] text-zinc-400">
        {entries.length} item{entries.length === 1 ? "" : "s"} ·{" "}
        <span className="font-mono">{cwd}</span>
        {clipboard && (
          <span className="ml-3">
            · Clipboard: {clipboard.paths.length}{" "}
            {clipboard.mode === "cut" ? "to move" : "to copy"}
          </span>
        )}
      </p>
    </div>
  );
};

export default FilesPage;
