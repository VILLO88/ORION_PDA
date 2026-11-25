import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  ArrowDownToLine,
  Bluetooth,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Code,
  Copy,
  Download,
  Eye,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSync,
  Library,
  Lock,
  LockOpen,
  Pencil,
  RefreshCw,
  Scissors,
  Trash2,
} from "lucide-react";
import { useDevices } from "@/lib/DeviceContext";
import { useActivity } from "@/lib/ActivityContext";
import { api, isElectron } from "@/lib/api";
import NotionSyncPanel from "@/components/NotionSyncPanel";
import { bleCondiviso } from "@/lib/bleOrion";
import { bleNoteAllinea, bleNoteAllineato, bleNoteSpingi } from "@/lib/bleNote";
import { useBle } from "@/lib/useBle";
import { chiediDepositoAOrion, ripristinaDepositoSuOrion } from "@/lib/serialVault";
import { eMarkdown, markdownInHtml } from "@/lib/markdown";
import type {
  NoteTreeFile,
  NoteTreeFolder,
  NoteTreeNode,
} from "@shared/ipc-types";

const DND_MIME = "application/x-orion-notes";
const OBSIDIAN_VAULT_KEY = "orion.obsidian.vault";
const SYNC_PROVIDER_KEY = "orion.sync.provider";
/* Come si mostra una nota `.md`: renderizzata o com'e' scritta. Una scelta
   sola per tutte, ricordata fra una sessione e l'altra. */
const MD_VIEW_KEY = "orion.notes.mdView";
type MdView = "rendered" | "source";

type SyncProvider = "obsidian" | "notion";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatMtime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function findNode(root: NoteTreeFolder, path: string): NoteTreeNode | null {
  if (root.path === path) return root;
  for (const c of root.children) {
    if (c.path === path) return c;
    if (c.kind === "folder") {
      const r = findNode(c, path);
      if (r) return r;
    }
  }
  return null;
}

function isAncestor(maybeAncestor: string, p: string): boolean {
  if (maybeAncestor === p) return true;
  const prefix = maybeAncestor.endsWith("/")
    ? maybeAncestor
    : maybeAncestor + "/";
  return p.startsWith(prefix);
}

type ContextMenuState = {
  x: number;
  y: number;
  target: NoteTreeNode;
};

type PromptState = {
  title: string;
  label: string;
  defaultValue: string;
  confirmLabel: string;
  /** Campo mascherato, e il valore passa COM'È: una password con uno spazio
   *  in fondo è una password diversa, non una da ripulire. */
  password?: boolean;
  onConfirm: (value: string) => void | Promise<void>;
};

const NotesPage = () => {
  const { devices } = useDevices();
  /* Senza cavo la pagina lavora sullo "specchio": una copia locale di
     /NOTE tenuta allineata al dispositivo via Bluetooth (vedi
     `lib/bleNote.ts`). Per il resto della pagina e' un dispositivo come un
     altro, con la sua `mountPath`. Il cavo, se c'e', vince. */
  const usb = devices[0] ?? null;
  const ble = useBle();
  const [bleMount, setBleMount] = useState<string | null>(null);
  const [bleStato, setBleStato] = useState("");
  const [bleBusy, setBleBusy] = useState(false);
  const viaBle = !usb && ble.connesso && !!bleMount && bleNoteAllineato();
  const device = useMemo(
    () =>
      usb ??
      (viaBle && bleMount
        ? {
            mountPath: bleMount,
            deviceId: null,
            fwVersion: null,
            lastSeen: null,
            label: "ORION (Bluetooth)",
          }
        : null),
    [usb, viaBle, bleMount],
  );
  const { log: logActivity } = useActivity();

  /** Connette se serve, manda cio' che era rimasto indietro, rilegge. */
  const allineaBle = async () => {
    setBleBusy(true);
    setBleStato("Connecting…");
    try {
      const root = await bleNoteAllinea(setBleStato);
      setBleMount(root);
      setBleStato("");
      return true;
    } catch (e) {
      setBleStato(`Bluetooth: ${(e as Error).message}`);
      return false;
    } finally {
      setBleBusy(false);
    }
  };

  const [tree, setTree] = useState<NoteTreeFolder | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<NoteTreeNode | null>(null);
  const [preview, setPreview] = useState<string>("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [mdView, setMdViewState] = useState<MdView>(
    () => (localStorage.getItem(MD_VIEW_KEY) === "source" ? "source" : "rendered"),
  );
  const setMdView = (v: MdView) => {
    setMdViewState(v);
    localStorage.setItem(MD_VIEW_KEY, v);
  };
  const selezionataMd = !!selected && selected.kind === "file" && eMarkdown(selected.name);
  const previewHtml = useMemo(
    () => (selezionataMd && mdView === "rendered" && !previewLoading ? markdownInHtml(preview) : ""),
    [selezionataMd, mdView, preview, previewLoading],
  );
  const [defaultDir, setDefaultDir] = useState<string>("");
  const [vaultPath, setVaultPath] = useState<string>(
    () => localStorage.getItem(OBSIDIAN_VAULT_KEY) ?? "",
  );
  const [provider, setProvider] = useState<SyncProvider>(
    () => (localStorage.getItem(SYNC_PROVIDER_KEY) as SyncProvider) ?? "obsidian",
  );
  const [syncing, setSyncing] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<{
    path: string;
    mode: "copy" | "cut";
  } | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [prompt, setPromptState] = useState<PromptState | null>(null);
  const noteRootRef = useRef<string>("");

  // ---- Lifecycle ----------------------------------------------------------

  useEffect(() => {
    if (!isElectron) return;
    void api.notes
      .defaults()
      .then((r) => setDefaultDir(r.defaultBackupDir))
      .catch(() => undefined);
  }, []);

  const reload = useCallback(async () => {
    if (!device) {
      setTree(null);
      setSelected(null);
      setPreview("");
      return;
    }
    setLoading(true);
    /* Ogni modifica passa da qui dopo essere stata fatta nello specchio:
       e' il momento di portarla sul dispositivo. Se non c'e' niente da
       portare non parte nemmeno un pacchetto. */
    if (viaBle) {
      try {
        const n = await bleNoteSpingi(setBleStato);
        setBleStato(n > 0 ? `✓ ${n} change${n === 1 ? "" : "s"} sent to ORION` : "");
      } catch (e) {
        setBleStato(
          `Bluetooth: not sent — ${(e as Error).message}. It will be retried at the next change.`,
        );
      }
    }
    try {
      const r = await api.notes.tree({ mountPath: device.mountPath });
      setTree(r.root);
      noteRootRef.current = r.root.path;
      // espandi la root di default
      setExpanded((cur) => {
        const next = new Set(cur);
        next.add(r.root.path);
        return next;
      });
      // mantieni la selezione se esiste ancora
      setSelected((cur) => (cur ? findNode(r.root, cur.path) : null));
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [device, viaBle]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Preview of the selected note (.txt, .md, or .enc decrypted)
  useEffect(() => {
    if (!selected || selected.kind !== "file") {
      setPreview("");
      return;
    }
    setPreviewLoading(true);
    api.notes
      .read({ devicePath: selected.path })
      .then((r) => setPreview(r.content))
      .catch((e) => setPreview(`Read error: ${(e as Error).message}`))
      .finally(() => setPreviewLoading(false));
  }, [selected]);

  // Close context menu on outside click / escape
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [contextMenu]);

  // ---- La categoria protetta ----------------------------------------------

  /* Il deposito sta nella flash di ORION: la prima volta, e dopo un cambio
     di password, la Companion se ne fa dare una copia via USB. La password
     la chiede ORION sul suo pannello; qui si aspetta. */
  const [gettingKey, setGettingKey] = useState(false);

  const onUnlockVault = async () => {
    if (!device) return;
    try {
      const st = await api.notes.vaultStatus({ mountPath: device.mountPath });
      if (st.exists && st.needsKey) {
        setGettingKey(true);
        setStatus("Asking ORION for the notes key… (ORION must be on its USB screen)");
        const hex = await chiediDepositoAOrion(setStatus);
        await api.notes.vaultImport({ mountPath: device.mountPath, hex });
        setStatus("Notes key received from ORION.");
      }
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`);
      return;
    } finally {
      setGettingKey(false);
    }
    setPromptState({
      title: "Unlock PRIVATE",
      label: "Notes password (the one set on the device)",
      defaultValue: "",
      confirmLabel: "Unlock",
      password: true,
      onConfirm: async (password) => {
        try {
          const r = await api.notes.vaultUnlock({ mountPath: device.mountPath, password });
          if (!r.exists) setStatus("No notes password has been set on this device.");
          else if (!r.unlocked) setStatus("Wrong password.");
          else setStatus("PRIVATE unlocked.");
          await reload();
        } catch (e) {
          setStatus(`Error: ${(e as Error).message}`);
        }
      },
    });
  };

  /* ORION ha perso il deposito (una cancellazione completa della flash):
     gli si ridà la copia tenuta qui. Lo decide comunque lui, con un ENTER. */
  const onRestoreKey = () => {
    if (!device) return;
    /* La password si chiede QUI, e serve a scegliere: la Companion può avere
       più copie (una per ogni cambio di password), e a ORION deve tornare
       quella che l'utente sa aprire. */
    setPromptState({
      title: "Restore the notes key to ORION",
      label: "Notes password (it picks the right key; it is not sent to ORION)",
      defaultValue: "",
      confirmLabel: "Restore",
      password: true,
      onConfirm: async (password) => {
        setGettingKey(true);
        try {
          const { hex, id } = await api.notes.vaultExport({
            mountPath: device.mountPath,
            password,
          });
          setStatus("Offering the notes key to ORION… (ORION must be on its USB screen)");
          await ripristinaDepositoSuOrion(hex, id, setStatus);
          setStatus("Notes key restored on ORION, with the password you just typed.");
        } catch (e) {
          /* Electron mette davanti "Error invoking remote method…": si tiene
             solo ciò che serve a chi legge. */
          setStatus(`Error: ${(e as Error).message.replace(/^.*?Error: /, "")}`);
        } finally {
          setGettingKey(false);
        }
      },
    });
  };

  const onLockVault = async () => {
    if (!device) return;
    await api.notes.vaultLock({ mountPath: device.mountPath });
    setPreview("");
    setStatus("PRIVATE locked.");
    await reload();
  };

  // ---- Helpers ------------------------------------------------------------

  const toggleExpand = (path: string) => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const refreshAfterMutation = async (newlyTouchedPath?: string) => {
    await reload();
    if (newlyTouchedPath) {
      setExpanded((cur) => {
        const next = new Set(cur);
        next.add(newlyTouchedPath);
        return next;
      });
    }
  };

  // ---- Operations ---------------------------------------------------------

  /** Ritorna la cartella di destinazione per un nuovo elemento, in base
   *  al nodo selezionato: se folder → quel folder; se file → il suo parent;
   *  altrimenti la root. */
  const targetFolderPath = (): string => {
    if (!tree) return "";
    if (!selected) return tree.path;
    if (selected.kind === "folder") return selected.path;
    // file → parent
    const idx = Math.max(
      selected.path.lastIndexOf("/"),
      selected.path.lastIndexOf("\\"),
    );
    return idx >= 0 ? selected.path.slice(0, idx) : tree.path;
  };

  const onNewFolder = (parent?: string) => {
    const parentPath = parent ?? targetFolderPath();
    if (!parentPath) return;
    setPromptState({
      title: "New folder",
      label: "Folder name",
      defaultValue: "",
      confirmLabel: "Create",
      onConfirm: async (name) => {
        try {
          const r = await api.notes.mkdir({ parent: parentPath, name });
          setStatus(`Created folder: ${name}`);
          await refreshAfterMutation(parentPath);
          setExpanded((cur) => {
            const next = new Set(cur);
            next.add(r.path);
            return next;
          });
        } catch (e) {
          setStatus(`Error: ${(e as Error).message}`);
        }
      },
    });
  };

  const onRename = (node: NoteTreeNode) => {
    setPromptState({
      title: `Rename ${node.kind === "folder" ? "folder" : "note"}`,
      label: "New name",
      defaultValue: node.name,
      confirmLabel: "Rename",
      onConfirm: async (newName) => {
        if (newName === node.name) return;
        try {
          await api.notes.rename({ from: node.path, newName });
          setStatus(`Renamed: ${node.name} → ${newName}`);
          await reload();
        } catch (e) {
          setStatus(`Error: ${(e as Error).message}`);
        }
      },
    });
  };

  const onDelete = async (node: NoteTreeNode) => {
    const isFolder = node.kind === "folder";
    const ok = window.confirm(
      `Delete ${isFolder ? "folder" : "note"} "${node.name}"${
        isFolder ? " and all its contents" : ""
      }? This cannot be undone.`,
    );
    if (!ok) return;
    try {
      await api.notes.del({ path: node.path });
      setStatus(`Deleted: ${node.name}`);
      if (selected && (selected.path === node.path || isAncestor(node.path, selected.path))) {
        setSelected(null);
      }
      await reload();
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`);
    }
  };

  const onPaste = async (dstDir?: string) => {
    if (!clipboard) return;
    const dst = dstDir ?? targetFolderPath();
    if (!dst) return;
    if (isAncestor(clipboard.path, dst)) {
      setStatus("Cannot paste a folder into itself.");
      return;
    }
    try {
      if (clipboard.mode === "copy") {
        const r = await api.notes.copy({
          sourcePath: clipboard.path,
          dstDir: dst,
          uniqueOnConflict: true,
        });
        setStatus(`Copied to: ${r.writtenPath}`);
      } else {
        const r = await api.notes.move({
          sourcePath: clipboard.path,
          dstDir: dst,
          uniqueOnConflict: true,
        });
        setStatus(`Moved to: ${r.writtenPath}`);
        setClipboard(null);
      }
      await refreshAfterMutation(dst);
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`);
    }
  };

  const onBackupOne = async (n: NoteTreeFile) => {
    setStatus(`Backup ${n.name}…`);
    try {
      const r = await api.notes.backup({ devicePath: n.path });
      setStatus(`✓ Saved to ${r.writtenPath}`);
      logActivity({
        kind: "notes-backup",
        status: "ok",
        title: `Note backed up: ${n.name}`,
        detail: r.writtenPath,
      });
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`);
      logActivity({
        kind: "notes-backup",
        status: "error",
        title: `Note backup failed: ${n.name}`,
        detail: (e as Error).message,
      });
    }
  };

  const onBackupAll = async () => {
    if (!device) return;
    setStatus(`Backing up notes…`);
    try {
      const r = await api.notes.backupAll({ mountPath: device.mountPath });
      const failed = r.errors.length;
      setStatus(
        failed === 0
          ? `✓ Saved ${r.written.length} files`
          : `${r.written.length} saved, ${failed} errors`,
      );
      logActivity({
        kind: "notes-backup",
        status: failed === 0 ? "ok" : "error",
        title:
          failed === 0
            ? `Notes synced: ${r.written.length} file${r.written.length === 1 ? "" : "s"}`
            : `Notes sync: ${r.written.length} ok, ${failed} failed`,
      });
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`);
      logActivity({
        kind: "notes-backup",
        status: "error",
        title: `Notes sync failed`,
        detail: (e as Error).message,
      });
    }
  };

  const onReveal = async () => {
    if (!defaultDir) return;
    try {
      await api.notes.revealBackupDir(defaultDir);
    } catch {
      /* ignore */
    }
  };

  // ---- Obsidian sync ------------------------------------------------------

  const onChooseVault = async () => {
    try {
      const r = await api.obsidian.pickVault();
      if (r.path) {
        setVaultPath(r.path);
        localStorage.setItem(OBSIDIAN_VAULT_KEY, r.path);
        setStatus(`Obsidian vault: ${r.path}`);
      }
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`);
    }
  };

  const onSyncObsidian = async () => {
    if (!device || !vaultPath) return;
    setSyncing(true);
    setStatus("Syncing with Obsidian…");
    try {
      const r = await api.obsidian.sync({
        mountPath: device.mountPath,
        vaultPath,
      });
      const parts: string[] = [];
      if (r.pushed.length) parts.push(`↑${r.pushed.length} to vault`);
      if (r.pulled.length) parts.push(`↓${r.pulled.length} to device`);
      if (r.deletedVault.length) parts.push(`−${r.deletedVault.length} in vault`);
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
      setStatus(`✓ Obsidian sync: ${summary}`);
      logActivity({
        kind: "obsidian-sync",
        status: r.errors.length ? "error" : "ok",
        title: `Obsidian sync: ${summary}`,
        detail: vaultPath,
      });
      await reload();
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`);
      logActivity({
        kind: "obsidian-sync",
        status: "error",
        title: "Obsidian sync failed",
        detail: (e as Error).message,
      });
    } finally {
      setSyncing(false);
    }
  };

  // ---- Drag & drop --------------------------------------------------------

  const onDragStart = (e: DragEvent<HTMLDivElement>, node: NoteTreeNode) => {
    e.dataTransfer.setData(DND_MIME, JSON.stringify({ path: node.path }));
    e.dataTransfer.effectAllowed = "copyMove";
  };

  const acceptsInternalDrop = (e: DragEvent<HTMLDivElement>): boolean => {
    return Array.from(e.dataTransfer.types).includes(DND_MIME);
  };

  const onDropOnFolder = async (
    e: DragEvent<HTMLDivElement>,
    folder: NoteTreeFolder,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverPath(null);
    if (!acceptsInternalDrop(e)) return;
    const raw = e.dataTransfer.getData(DND_MIME);
    if (!raw) return;
    let parsed: { path: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (isAncestor(parsed.path, folder.path)) {
      setStatus("Cannot drop a folder into itself.");
      return;
    }
    // Alt o Ctrl/Cmd held → copy. Default = move.
    const wantCopy = e.altKey || e.ctrlKey || e.metaKey;
    try {
      if (wantCopy) {
        await api.notes.copy({
          sourcePath: parsed.path,
          dstDir: folder.path,
          uniqueOnConflict: true,
        });
        setStatus("Copied.");
      } else {
        await api.notes.move({
          sourcePath: parsed.path,
          dstDir: folder.path,
          uniqueOnConflict: true,
        });
        setStatus("Moved.");
      }
      await refreshAfterMutation(folder.path);
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`);
    }
  };

  // ---- Keyboard shortcuts -------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Solo se la pagina è focused e non c'è un input attivo
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      const meta = e.metaKey || e.ctrlKey;
      if (!selected) return;
      if (meta && e.key === "c") {
        e.preventDefault();
        setClipboard({ path: selected.path, mode: "copy" });
        setStatus(`Copied "${selected.name}" to clipboard`);
      } else if (meta && e.key === "x") {
        e.preventDefault();
        setClipboard({ path: selected.path, mode: "cut" });
        setStatus(`Cut "${selected.name}" to clipboard`);
      } else if (meta && e.key === "v") {
        e.preventDefault();
        void onPaste();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (meta || e.shiftKey) {
          e.preventDefault();
          void onDelete(selected);
        }
      } else if (e.key === "F2") {
        e.preventDefault();
        void onRename(selected);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, clipboard]);

  // ---- Render -------------------------------------------------------------

  const totalNotes = useMemo(() => {
    if (!tree) return 0;
    let n = 0;
    const walk = (node: NoteTreeNode) => {
      if (node.kind === "file") n++;
      else for (const c of node.children) walk(c);
    };
    walk(tree);
    return n;
  }, [tree]);

  if (!device) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="ui-card max-w-md p-10 text-center">
          <FileText className="mx-auto h-8 w-8 text-zinc-400" />
          <p className="mt-3 text-zinc-800 dark:text-zinc-100">
            No device connected.
          </p>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Connect the PDA V3 in USB MSC mode from the firmware menu — or
            read the notes over Bluetooth, without the cable.
          </p>
          <button
            type="button"
            onClick={() => void allineaBle()}
            disabled={bleBusy}
            className="btn-ghost mx-auto mt-4 disabled:opacity-40"
          >
            <Bluetooth className={`h-4 w-4 ${bleBusy ? "animate-pulse" : ""}`} />
            {bleBusy ? "Reading…" : "Use Bluetooth"}
          </button>
          {bleStato && (
            <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">{bleStato}</p>
          )}
          <p className="mt-3 text-[11px] text-zinc-400">
            The first time every note is read from the device, slowly; after
            that only what changed.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {totalNotes} note{totalNotes === 1 ? "" : "s"} in{" "}
          {viaBle ? (
            <span className="inline-flex items-center gap-1">
              <Bluetooth className="h-3.5 w-3.5 text-accent" />
              {ble.nome}, over Bluetooth
            </span>
          ) : (
            <code className="font-mono">{device.mountPath}/NOTE/</code>
          )}
          {bleStato && <span className="ml-3 text-xs">{bleStato}</span>}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void (viaBle ? allineaBle().then(() => reload()) : reload())}
            disabled={loading || bleBusy}
            className="btn-ghost"
            title={viaBle ? "Read again from ORION what changed there" : undefined}
          >
            <RefreshCw className={`h-4 w-4 ${loading || bleBusy ? "animate-spin" : ""}`} />
            Reload
          </button>
          {viaBle && (
            <button
              type="button"
              onClick={() => {
                bleCondiviso.disconnetti();
                setBleMount(null);
              }}
              disabled={loading || bleBusy}
              className="btn-ghost"
            >
              Disconnect
            </button>
          )}
          <button
            type="button"
            onClick={() => void onNewFolder()}
            className="btn-ghost"
            title="New folder inside the selected folder"
          >
            <FolderPlus className="h-4 w-4" />
            New folder
          </button>
          <button
            type="button"
            onClick={() => void onBackupAll()}
            disabled={loading || totalNotes === 0}
            className="btn-ghost"
          >
            <Download className="h-4 w-4" />
            Backup all to PC
          </button>
        </div>
      </div>

      {/* Destination + reveal */}
      {defaultDir && (
        <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
          <span>Destination:</span>
          <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono dark:bg-zinc-800">
            {defaultDir}
          </code>
          <button
            type="button"
            onClick={() => void onReveal()}
            className="inline-flex items-center gap-1 rounded border border-zinc-200 px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <FolderOpen className="h-3 w-3" />
            Open
          </button>
        </div>
      )}

      {/* Sync notes with… (provider selector) */}
      <div className="ui-card flex flex-col gap-3 p-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
            Sync notes with
          </span>
          <select
            value={provider}
            onChange={(e) => {
              const p = e.target.value as SyncProvider;
              setProvider(p);
              localStorage.setItem(SYNC_PROVIDER_KEY, p);
            }}
            className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-900 outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          >
            <option value="obsidian">Obsidian</option>
            <option value="notion">Notion</option>
          </select>
        </div>

        {provider === "obsidian" && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              Vault:
            </span>
            {vaultPath ? (
              <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs dark:bg-zinc-800">
                {vaultPath}
              </code>
            ) : (
              <span className="text-xs italic text-zinc-500 dark:text-zinc-400">
                none selected
              </span>
            )}
            <button
              type="button"
              onClick={() => void onChooseVault()}
              className="inline-flex items-center gap-1 rounded border border-zinc-200 px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <Library className="h-3 w-3" />
              {vaultPath ? "Change" : "Choose vault…"}
            </button>
            <button
              type="button"
              onClick={() => void onSyncObsidian()}
              disabled={syncing || loading || !vaultPath}
              className="btn-accent ml-auto"
              title={
                vaultPath
                  ? "Two-way sync with the Obsidian vault"
                  : "Choose an Obsidian vault first"
              }
            >
              <FolderSync
                className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`}
              />
              Sync with Obsidian
            </button>
          </div>
        )}

        {provider === "notion" && (
          <NotionSyncPanel
            mountPath={device.mountPath}
            onSynced={() => void reload()}
            setStatus={setStatus}
          />
        )}
      </div>

      {status && (
        <div className="ui-card px-3 py-2 text-sm text-zinc-700 dark:text-zinc-200">
          {status}
        </div>
      )}

      {/* Split: tree | preview */}
      <div className="grid min-h-0 flex-1 grid-cols-[320px_1fr] gap-3">
        {/* Tree pane */}
        <div
          className={`ui-card overflow-auto p-0 ${
            dragOverPath === tree?.path
              ? "ring-2 ring-accent ring-offset-1"
              : ""
          }`}
          onDragOver={(e) => {
            if (acceptsInternalDrop(e) && tree) {
              e.preventDefault();
              e.dataTransfer.dropEffect = e.altKey || e.ctrlKey || e.metaKey ? "copy" : "move";
              setDragOverPath(tree.path);
            }
          }}
          onDragLeave={() => setDragOverPath(null)}
          onDrop={(e) => {
            if (tree) void onDropOnFolder(e, tree);
          }}
        >
          {tree && (
            <div className="py-1">
              <TreeView
                node={tree}
                depth={0}
                expanded={expanded}
                selected={selected}
                clipboard={clipboard}
                dragOverPath={dragOverPath}
                setDragOverPath={setDragOverPath}
                onToggleExpand={toggleExpand}
                onSelect={setSelected}
                onDragStart={onDragStart}
                onDropOnFolder={(e, f) => void onDropOnFolder(e, f)}
                onContextMenu={(e, node) => {
                  e.preventDefault();
                  setSelected(node);
                  setContextMenu({ x: e.clientX, y: e.clientY, target: node });
                }}
                acceptsInternalDrop={acceptsInternalDrop}
              />
            </div>
          )}
          {tree && tree.children.length === 0 && !loading && (
            <p className="p-4 text-sm text-zinc-500 dark:text-zinc-400">
              No notes yet. Right-click here to create a folder.
            </p>
          )}
        </div>

        {/* Preview pane */}
        <div className="ui-card flex flex-col overflow-hidden">
          {!selected && (
            <div className="m-auto px-6 py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">
              Select a note on the left to view its content.
            </div>
          )}
          {/* La categoria protetta. Chiusa non mostra niente — né titoli né
              quante note ci sono — come sul dispositivo. */}
          {selected && selected.kind === "folder" && selected.protected && selected.locked && (
            <div className="m-auto px-6 py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">
              <Lock className="mx-auto mb-2 h-8 w-8 text-zinc-400" />
              <p className="font-medium text-zinc-700 dark:text-zinc-200">PRIVATE is locked</p>
              <p className="mt-1 text-xs">
                These notes are encrypted on the device. Enter the notes
                password to read them here.
              </p>
              <button
                type="button"
                onClick={() => void onUnlockVault()}
                disabled={gettingKey}
                className="btn-accent mt-4"
              >
                <LockOpen className="h-3.5 w-3.5" />
                {gettingKey ? "Waiting for ORION…" : "Unlock"}
              </button>
              <p className="mt-4 text-xs">
                The first time, and after a password change on the device,
                ORION is asked for the key over USB: keep it on its USB
                screen and type the notes password there when it asks.
              </p>
              <button
                type="button"
                onClick={onRestoreKey}
                disabled={gettingKey}
                className="btn-ghost mt-4"
                title="For an ORION whose memory was erased: gives it back the copy of the notes key kept here"
              >
                ORION lost its notes key? Restore it
              </button>
              <p className="mt-4 text-xs">
                Backup works while locked too: the notes are copied as they
                are, encrypted, together with the vault that opens them.
              </p>
            </div>
          )}
          {selected && selected.kind === "folder" && !(selected.protected && selected.locked) && (
            <div className="m-auto px-6 py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">
              <FolderOpen className="mx-auto mb-2 h-8 w-8 text-zinc-400" />
              Folder selected: <code className="font-mono">{selected.relPath || "/"}</code>
              <p className="mt-1 text-xs">
                {selected.children.length} entr
                {selected.children.length === 1 ? "y" : "ies"}
              </p>
              {selected.protected && (
                <>
                  <p className="mt-3 text-xs">
                    Unlocked. It locks itself after ten minutes without use.
                  </p>
                  <button type="button" onClick={() => void onLockVault()} className="btn-ghost mt-2">
                    <Lock className="h-3.5 w-3.5" />
                    Lock now
                  </button>
                </>
              )}
            </div>
          )}
          {selected && selected.kind === "file" && (
            <>
              <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-2 dark:border-zinc-800">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-100">
                    {selected.name}
                  </p>
                  <p className="truncate text-xs font-mono text-zinc-500 dark:text-zinc-400">
                    {selected.relPath} · {formatBytes(selected.size)} ·{" "}
                    {formatMtime(selected.mtimeIso)}
                    {selected.protected ? " · encrypted on the device" : ""}
                  </p>
                </div>
                {selezionataMd && (
                  /* Il toggle dell'anteprima, come sul dispositivo (MENU >
                     Markdown preview) e come in VS Code. */
                  <div className="mr-2 inline-flex overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
                    <button
                      type="button"
                      onClick={() => setMdView("rendered")}
                      className={`inline-flex items-center gap-1 px-2 py-1 text-xs ${
                        mdView === "rendered"
                          ? "bg-accent-soft text-accent"
                          : "text-zinc-600 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
                      }`}
                      title="Show the Markdown rendered"
                    >
                      <Eye className="h-3.5 w-3.5" />
                      Rendered
                    </button>
                    <button
                      type="button"
                      onClick={() => setMdView("source")}
                      className={`inline-flex items-center gap-1 border-l border-zinc-200 px-2 py-1 text-xs dark:border-zinc-800 ${
                        mdView === "source"
                          ? "bg-accent-soft text-accent"
                          : "text-zinc-600 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
                      }`}
                      title="Show the Markdown as written"
                    >
                      <Code className="h-3.5 w-3.5" />
                      Source
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => void onBackupOne(selected)}
                  className="btn-ghost"
                  title="Backup this note"
                >
                  <ArrowDownToLine className="h-3.5 w-3.5" />
                  Backup
                </button>
              </div>
              {selezionataMd && mdView === "rendered" && !previewLoading ? (
                /* HTML ristretto: vedi lib/markdown.ts. */
                <div
                  className="md-preview flex-1 overflow-auto p-4 text-sm text-zinc-800 dark:text-zinc-100"
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                />
              ) : (
                <pre className="flex-1 overflow-auto whitespace-pre-wrap p-4 font-mono text-sm text-zinc-800 dark:text-zinc-100">
                  {previewLoading ? "Loading…" : preview}
                </pre>
              )}
            </>
          )}
        </div>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          className="fixed z-50 min-w-[180px] rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.target.kind === "folder" && (
            <MenuItem
              icon={<FolderPlus className="h-3.5 w-3.5" />}
              label="New folder"
              onClick={() => {
                setContextMenu(null);
                void onNewFolder(
                  (contextMenu.target as NoteTreeFolder).path,
                );
              }}
            />
          )}
          <MenuItem
            icon={<Pencil className="h-3.5 w-3.5" />}
            label="Rename"
            onClick={() => {
              setContextMenu(null);
              void onRename(contextMenu.target);
            }}
          />
          <MenuItem
            icon={<Copy className="h-3.5 w-3.5" />}
            label="Copy"
            onClick={() => {
              setClipboard({ path: contextMenu.target.path, mode: "copy" });
              setStatus(`Copied "${contextMenu.target.name}" to clipboard`);
              setContextMenu(null);
            }}
          />
          <MenuItem
            icon={<Scissors className="h-3.5 w-3.5" />}
            label="Cut"
            onClick={() => {
              setClipboard({ path: contextMenu.target.path, mode: "cut" });
              setStatus(`Cut "${contextMenu.target.name}" to clipboard`);
              setContextMenu(null);
            }}
          />
          {clipboard && contextMenu.target.kind === "folder" && (
            <MenuItem
              icon={<ClipboardPaste className="h-3.5 w-3.5" />}
              label="Paste here"
              onClick={() => {
                setContextMenu(null);
                void onPaste((contextMenu.target as NoteTreeFolder).path);
              }}
            />
          )}
          {contextMenu.target.kind === "file" && (
            <MenuItem
              icon={<ArrowDownToLine className="h-3.5 w-3.5" />}
              label="Backup to PC"
              onClick={() => {
                setContextMenu(null);
                void onBackupOne(contextMenu.target as NoteTreeFile);
              }}
            />
          )}
          {/* Non si elimina la root NOTE/ */}
          {contextMenu.target.path !== tree?.path && (
            <>
              <div className="my-1 border-t border-zinc-100 dark:border-zinc-800" />
              <MenuItem
                icon={<Trash2 className="h-3.5 w-3.5" />}
                label="Delete"
                danger
                onClick={() => {
                  setContextMenu(null);
                  void onDelete(contextMenu.target);
                }}
              />
            </>
          )}
        </div>
      )}

      {/* Prompt dialog (sostituisce window.prompt che Electron disabilita) */}
      {prompt && (
        <PromptDialog
          state={prompt}
          onCancel={() => setPromptState(null)}
          onConfirm={async (value) => {
            const finale = prompt.password ? value : value.trim();
            if (!finale) return;
            setPromptState(null);
            await prompt.onConfirm(finale);
          }}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
//  Subcomponents
// ---------------------------------------------------------------------------

interface TreeViewProps {
  node: NoteTreeFolder;
  depth: number;
  expanded: Set<string>;
  selected: NoteTreeNode | null;
  clipboard: { path: string; mode: "copy" | "cut" } | null;
  dragOverPath: string | null;
  setDragOverPath: (p: string | null) => void;
  onToggleExpand: (path: string) => void;
  onSelect: (node: NoteTreeNode) => void;
  onDragStart: (e: DragEvent<HTMLDivElement>, node: NoteTreeNode) => void;
  onDropOnFolder: (e: DragEvent<HTMLDivElement>, folder: NoteTreeFolder) => void;
  onContextMenu: (
    e: ReactMouseEvent<HTMLDivElement>,
    node: NoteTreeNode,
  ) => void;
  acceptsInternalDrop: (e: DragEvent<HTMLDivElement>) => boolean;
}

const TreeView = (props: TreeViewProps) => {
  const {
    node,
    depth,
    expanded,
    selected,
    clipboard,
    dragOverPath,
    setDragOverPath,
    onToggleExpand,
    onSelect,
    onDragStart,
    onDropOnFolder,
    onContextMenu,
    acceptsInternalDrop,
  } = props;

  const isOpen = expanded.has(node.path);
  const isSelected = selected?.path === node.path;
  const isRoot = depth === 0;
  const isDropTarget = dragOverPath === node.path;
  const cutMuted = clipboard?.mode === "cut" && clipboard.path === node.path;

  return (
    <div>
      {/* Riga della cartella (la root la rappresento come "NOTE/") */}
      <div
        draggable={!isRoot}
        onDragStart={(e) => onDragStart(e, node)}
        onDragOver={(e) => {
          if (acceptsInternalDrop(e)) {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = e.altKey || e.ctrlKey || e.metaKey ? "copy" : "move";
            setDragOverPath(node.path);
          }
        }}
        onDragLeave={(e) => {
          e.stopPropagation();
          if (dragOverPath === node.path) setDragOverPath(null);
        }}
        onDrop={(e) => onDropOnFolder(e, node)}
        onClick={() => {
          onSelect(node);
          if (node.children.length > 0) onToggleExpand(node.path);
        }}
        onContextMenu={(e) => onContextMenu(e, node)}
        className={`group flex cursor-pointer items-center gap-1 px-2 py-1 text-sm transition-colors ${
          isSelected ? "bg-accent-soft text-accent" : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
        } ${isDropTarget ? "ring-1 ring-accent ring-inset" : ""} ${
          cutMuted ? "opacity-50" : ""
        }`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        <span className="flex h-4 w-4 items-center justify-center">
          {node.children.length > 0 ? (
            isOpen ? (
              <ChevronDown className="h-3.5 w-3.5 text-zinc-500" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-zinc-500" />
            )
          ) : null}
        </span>
        {isOpen ? (
          <FolderOpen className="h-4 w-4 shrink-0 text-amber-500" />
        ) : (
          <Folder className="h-4 w-4 shrink-0 text-amber-500" />
        )}
        <span className="truncate">
          {isRoot ? "NOTE" : node.name}
        </span>
        {node.protected &&
          (node.locked ? (
            <Lock className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
          ) : (
            <LockOpen className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
          ))}
      </div>

      {/* Children */}
      {isOpen &&
        node.children.map((child) => {
          if (child.kind === "folder") {
            return (
              <TreeView
                key={child.path}
                node={child}
                depth={depth + 1}
                expanded={expanded}
                selected={selected}
                clipboard={clipboard}
                dragOverPath={dragOverPath}
                setDragOverPath={setDragOverPath}
                onToggleExpand={onToggleExpand}
                onSelect={onSelect}
                onDragStart={onDragStart}
                onDropOnFolder={onDropOnFolder}
                onContextMenu={onContextMenu}
                acceptsInternalDrop={acceptsInternalDrop}
              />
            );
          }
          return (
            <FileRow
              key={child.path}
              node={child}
              depth={depth + 1}
              selected={selected}
              clipboard={clipboard}
              onSelect={onSelect}
              onDragStart={onDragStart}
              onContextMenu={onContextMenu}
            />
          );
        })}
    </div>
  );
};

interface FileRowProps {
  node: NoteTreeFile;
  depth: number;
  selected: NoteTreeNode | null;
  clipboard: { path: string; mode: "copy" | "cut" } | null;
  onSelect: (node: NoteTreeNode) => void;
  onDragStart: (e: DragEvent<HTMLDivElement>, node: NoteTreeNode) => void;
  onContextMenu: (
    e: ReactMouseEvent<HTMLDivElement>,
    node: NoteTreeNode,
  ) => void;
}

const FileRow = ({
  node,
  depth,
  selected,
  clipboard,
  onSelect,
  onDragStart,
  onContextMenu,
}: FileRowProps) => {
  const isSelected = selected?.path === node.path;
  const cutMuted = clipboard?.mode === "cut" && clipboard.path === node.path;
  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, node)}
      onClick={() => onSelect(node)}
      onContextMenu={(e) => onContextMenu(e, node)}
      className={`flex cursor-pointer items-center gap-1 px-2 py-1 text-sm transition-colors ${
        isSelected
          ? "bg-accent-soft text-accent"
          : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
      } ${cutMuted ? "opacity-50" : ""}`}
      style={{ paddingLeft: `${8 + depth * 14}px` }}
    >
      <span className="h-4 w-4" />
      <FileText className="h-4 w-4 shrink-0 text-zinc-400" />
      <span className="truncate">{node.name}</span>
      {eMarkdown(node.name) && (
        <span className="ml-1 shrink-0 rounded bg-zinc-100 px-1 font-mono text-[10px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
          MD
        </span>
      )}
    </div>
  );
};

interface MenuItemProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}

const MenuItem = ({ icon, label, onClick, danger }: MenuItemProps) => (
  <button
    type="button"
    onClick={onClick}
    className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm transition-colors ${
      danger
        ? "text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
        : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
    }`}
  >
    {icon}
    <span>{label}</span>
  </button>
);

interface PromptDialogProps {
  state: PromptState;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}

const PromptDialog = ({ state, onCancel, onConfirm }: PromptDialogProps) => {
  const [value, setValue] = useState(state.defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onCancel}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <div
        className="w-[400px] rounded-lg border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-3 text-base font-semibold text-zinc-900 dark:text-zinc-100">
          {state.title}
        </h3>
        <label className="mb-1 block text-xs text-zinc-500 dark:text-zinc-400">
          {state.label}
        </label>
        <input
          ref={inputRef}
          type={state.password ? "password" : "text"}
          autoComplete={state.password ? "off" : undefined}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onConfirm(value);
            if (e.key === "Escape") onCancel();
          }}
          className="w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(value)}
            disabled={state.password ? value.length === 0 : !value.trim()}
            className="btn-accent"
          >
            {state.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

export default NotesPage;
