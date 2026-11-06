import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type FC,
  type ReactNode,
} from "react";

/**
 * Recent Activity store — persistent across app restarts via localStorage.
 *
 * Every long-running job records an entry when it finishes (or fails). The
 * Home page renders the latest N entries. The store is renderer-local for
 * now (single window app), no main process involvement.
 */

export type ActivityKind =
  | "ebook-convert"
  | "mp3-convert"
  | "video-convert"
  | "notes-backup"
  | "obsidian-sync"
  | "notion-sync"
  | "files-upload"
  | "files-delete"
  | "firmware-flash";

export type ActivityStatus = "ok" | "error";

export interface ActivityEntry {
  /** UUID-ish unique id. */
  id: string;
  kind: ActivityKind;
  status: ActivityStatus;
  /** One-line human-readable description (e.g. "Ebook added: book.pdar"). */
  title: string;
  /** Optional secondary detail (e.g. "12 tracks · 23.4 MB"). */
  detail?: string;
  /** ISO 8601 timestamp when the activity completed. */
  whenIso: string;
}

interface ActivityContextValue {
  entries: ActivityEntry[];
  log: (e: Omit<ActivityEntry, "id" | "whenIso">) => void;
  clear: () => void;
}

const ActivityContext = createContext<ActivityContextValue>({
  entries: [],
  log: () => undefined,
  clear: () => undefined,
});

const STORAGE_KEY = "orion.activity.v1";
const MAX_ENTRIES = 50;

function loadInitial(): ActivityEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is ActivityEntry =>
        typeof x === "object" &&
        x !== null &&
        typeof (x as ActivityEntry).id === "string" &&
        typeof (x as ActivityEntry).title === "string",
    );
  } catch {
    return [];
  }
}

function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface ProviderProps {
  children: ReactNode;
}

export const ActivityProvider: FC<ProviderProps> = ({ children }) => {
  const [entries, setEntries] = useState<ActivityEntry[]>(() => loadInitial());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // Quota exceeded or storage disabled — non-fatal.
    }
  }, [entries]);

  const log = useCallback(
    (e: Omit<ActivityEntry, "id" | "whenIso">) => {
      setEntries((prev) => {
        const entry: ActivityEntry = {
          ...e,
          id: genId(),
          whenIso: new Date().toISOString(),
        };
        const next = [entry, ...prev];
        return next.length > MAX_ENTRIES ? next.slice(0, MAX_ENTRIES) : next;
      });
    },
    [],
  );

  const clear = useCallback(() => setEntries([]), []);

  const value = useMemo<ActivityContextValue>(
    () => ({ entries, log, clear }),
    [entries, log, clear],
  );

  return (
    <ActivityContext.Provider value={value}>
      {children}
    </ActivityContext.Provider>
  );
};

export const useActivity = (): ActivityContextValue => useContext(ActivityContext);
