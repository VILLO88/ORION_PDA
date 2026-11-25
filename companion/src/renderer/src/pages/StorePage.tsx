/**
 * App Store: Lua apps for ORION, published by anyone, approved by a
 * moderator, downloaded, rated and commented by everyone.
 *
 * Four tabs: Browse (and an app's own page), Installed (what is on the
 * card), My apps (publish, versions, why one was rejected), Moderation (only
 * for the moderators listed in the server's ADMINS).
 *
 * Main process: src/main/store. Server: store/ (Cloudflare Worker).
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Play,
  ChevronLeft,
  ChevronRight,
  ImagePlus,
  Download,
  Eye,
  EyeOff,
  Flag,
  Bluetooth,
  Github,
  LogOut,
  Package,
  RefreshCw,
  Search,
  ShieldCheck,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useDevices } from "@/lib/DeviceContext";
import { useActivity } from "@/lib/ActivityContext";
import { api, isElectron } from "@/lib/api";
import { markdownInHtml } from "@/lib/markdown";
import EmulatorWindow from "@/components/EmulatorWindow";
import { useBle } from "@/lib/useBle";
import { bleCondiviso } from "@/lib/bleOrion";
import { daMandare, installaBle, installateBle, rimuoviBle, scaricaPacchetto, stimaSecondi } from "@/lib/storeBle";
import {
  STORE_CATEGORIES,
  type StoreAccount,
  type StoreApp,
  type StoreDetailResponse,
  type StoreFlag,
  type StoreInstalledResponse,
  type StoreMyApp,
  type StorePublishDraft,
  type StoreQueueItem,
  type StoreReport,
  type StoreReview,
  type StoreShotFile,
} from "@shared/ipc-types";

type Tab = "browse" | "installed" | "mine" | "moderation";
type Via = "usb" | "ble" | null;
const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} kB`);

/** What each flag means for the person installing. `shared` is the one
 *  that matters: the app can touch the whole card. */
const FLAG_INFO: Record<StoreFlag, { label: string; text: string; danger?: boolean }> = {
  shared: { label: "Whole card", text: "Can read and write every file on the microSD (notes, music…).", danger: true },
  serial: { label: "Serial", text: "Uses the serial port of the expansion connector." },
  gpio: { label: "GPIO", text: "Drives the pins of the expansion connector." },
  i2c: { label: "I2C", text: "Talks to devices on the expansion connector." },
  ble: { label: "Bluetooth", text: "Exchanges messages over Bluetooth." },
  mesh: { label: "Mesh radio", text: "Sends and receives on the LoRa mesh (boards with the radio)." },
  compiled: { label: "Compiled code", text: "Contains precompiled Lua (.luac): the moderator could not read all of it." },
};

const fmtSize = (n: number | null) =>
  n === null ? "—" : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "—");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------------------
//  Small pieces
// ---------------------------------------------------------------------------

const Stars = ({ value, size = 14 }: { value: number | null; size?: number }) => (
  <span className="inline-flex items-center">
    {[1, 2, 3, 4, 5].map((i) => (
      <Star
        key={i}
        style={{ width: size, height: size }}
        className={
          value !== null && i <= Math.round(value)
            ? "fill-accent text-accent"
            : "text-zinc-300 dark:text-zinc-600"
        }
      />
    ))}
  </span>
);

const StarPicker = ({ value, onChange }: { value: number; onChange: (n: number) => void }) => {
  const [hover, setHover] = useState(0);
  return (
    <span className="inline-flex" onMouseLeave={() => setHover(0)}>
      {[1, 2, 3, 4, 5].map((i) => (
        <button key={i} type="button" onMouseEnter={() => setHover(i)} onClick={() => onChange(i)} title={`${i} star${i > 1 ? "s" : ""}`}>
          <Star
            className={`h-6 w-6 ${(hover || value) >= i ? "fill-accent text-accent" : "text-zinc-300 dark:text-zinc-600"}`}
          />
        </button>
      ))}
    </span>
  );
};

const FlagBadges = ({ flags }: { flags: StoreFlag[] }) =>
  flags.length === 0 ? null : (
    <span className="flex flex-wrap gap-1">
      {flags.map((f) => (
        <span
          key={f}
          title={FLAG_INFO[f]?.text}
          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
            FLAG_INFO[f]?.danger
              ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
              : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
          }`}
        >
          {FLAG_INFO[f]?.label ?? f}
        </span>
      ))}
    </span>
  );

/** One screenshot, loaded through the main process (see api.store.screenshot). */
const Shot = ({ slug, version, i, className, onClick }: {
  slug: string; version: string; i: number; className?: string; onClick?: () => void;
}) => {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let vivo = true;
    void api.store.screenshot(slug, version, i).then((u) => vivo && setUrl(u)).catch(() => undefined);
    return () => {
      vivo = false;
    };
  }, [slug, version, i]);
  return url ? (
    <img src={url} alt={`Screenshot ${i + 1}`} onClick={onClick}
      className={`${className ?? ""} ${onClick ? "cursor-zoom-in" : ""} bg-zinc-100 object-contain dark:bg-zinc-800`} />
  ) : (
    <div className={`${className ?? ""} animate-pulse bg-zinc-100 dark:bg-zinc-800`} />
  );
};

/** A version's screenshots in a row; a click shows one large, arrows move. */
const Gallery = ({ slug, version, count }: { slug: string; version: string; count: number }) => {
  const [big, setBig] = useState<number | null>(null);
  useEffect(() => {
    if (big === null) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") setBig(null);
      if (e.key === "ArrowRight") setBig((b) => (b === null ? b : (b + 1) % count));
      if (e.key === "ArrowLeft") setBig((b) => (b === null ? b : (b + count - 1) % count));
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [big, count]);
  if (count === 0) return null;
  return (
    <>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {Array.from({ length: count }, (_, i) => (
          <Shot key={i} slug={slug} version={version} i={i} onClick={() => setBig(i)}
            className="h-40 w-64 shrink-0 rounded-lg border border-zinc-200 dark:border-zinc-800" />
        ))}
      </div>
      {big !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center gap-4 bg-black/80 p-8" onClick={() => setBig(null)}>
          {count > 1 && (
            <button type="button" className="text-white/80 hover:text-white"
              onClick={(e) => { e.stopPropagation(); setBig((big + count - 1) % count); }}>
              <ChevronLeft className="h-10 w-10" />
            </button>
          )}
          <Shot slug={slug} version={version} i={big} className="max-h-full max-w-full rounded-lg" />
          {count > 1 && (
            <button type="button" className="text-white/80 hover:text-white"
              onClick={(e) => { e.stopPropagation(); setBig((big + 1) % count); }}>
              <ChevronRight className="h-10 w-10" />
            </button>
          )}
        </div>
      )}
    </>
  );
};

const StatusBadge = ({ status }: { status: "pending" | "approved" | "rejected" }) => (
  <span
    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
      status === "approved"
        ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300"
        : status === "pending"
          ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
          : "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
    }`}
  >
    {status === "pending" ? "waiting for review" : status}
  </span>
);

/* The app name rule of the store (the file name on the card): Try needs it. */
const SLUG_OK = /^[a-z0-9][a-z0-9_-]{1,26}$/;

const inputCls =
  "w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100";

interface AskState {
  title: string;
  label: string;
  confirm: string;
  multiline?: boolean;
  onConfirm: (v: string) => void | Promise<void>;
}

/** Electron has no window.prompt: a small dialog of our own. */
const AskDialog = ({ s, onClose }: { s: AskState; onClose: () => void }) => {
  const [v, setV] = useState("");
  const ok = async () => {
    if (!v.trim()) return;
    onClose();
    await s.onConfirm(v.trim());
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-[440px] rounded-lg border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-3 text-base font-semibold text-zinc-900 dark:text-zinc-100">{s.title}</h3>
        <label className="mb-1 block text-xs text-zinc-500 dark:text-zinc-400">{s.label}</label>
        {s.multiline ? (
          <textarea autoFocus rows={4} value={v} onChange={(e) => setV(e.target.value)} className={inputCls} />
        ) : (
          <input
            autoFocus
            value={v}
            onChange={(e) => setV(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void ok();
              if (e.key === "Escape") onClose();
            }}
            className={inputCls}
          />
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-accent" disabled={!v.trim()} onClick={() => void ok()}>
            {s.confirm}
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
//  The page
// ---------------------------------------------------------------------------

const StorePage = () => {
  const { devices } = useDevices();
  const device = devices[0] ?? null;
  const { log } = useActivity();

  const [tab, setTab] = useState<Tab>("browse");
  const [account, setAccount] = useState<StoreAccount | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<AskState | null>(null);
  const [open, setOpen] = useState<string | null>(null); // slug of the app page shown
  const [installed, setInstalled] = useState<StoreInstalledResponse | null>(null);
  const ble = useBle();
  /* How apps reach ORION: the cable wins (much faster); without it, the
     Bluetooth link if the firmware can manage files over it. */
  const via: Via = device ? "usb" : ble.connesso && ble.naviga ? "ble" : null;

  useEffect(() => {
    if (isElectron) void api.store.account().then(setAccount).catch(() => setAccount(null));
  }, []);

  const refreshInstalled = useCallback(async () => {
    try {
      if (via === "usb" && device) setInstalled(await api.store.installed(device.mountPath));
      else if (via === "ble") setInstalled(await installateBle());
      else setInstalled(null);
    } catch {
      setInstalled(null);
    }
  }, [device, via]);

  useEffect(() => {
    void refreshInstalled();
  }, [refreshInstalled]);

  /** Runs an action with the busy flag and the error in the status line. */
  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setStatus("");
    try {
      await fn();
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`);
      /* A lost session shows up as "Sign in" again. */
      void api.store.account().then(setAccount).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }, []);

  const signIn = () =>
    run(async () => {
      setStatus("Complete the sign-in in your browser…");
      const a = await api.store.signIn();
      setAccount(a);
      setStatus(`Signed in as ${a.login}`);
    });

  const installedVersion = (slug: string) => installed?.apps.find((a) => a.slug === slug);

  const install = (slug: string, version?: string) =>
    run(async () => {
      if (!via) throw new Error("Connect ORION over USB (USB mode) or Bluetooth to install apps.");
      const nuovo = !installedVersion(slug);
      if (nuovo && installed && installed.apps.length >= installed.limit) {
        const ok = window.confirm(
          `The card already has ${installed.apps.length} apps, and the launcher on ORION shows at most ${installed.limit}. Install anyway?`,
        );
        if (!ok) return;
      }
      let r: { version: string };
      if (via === "usb" && device) {
        setStatus(`Installing ${slug}…`);
        r = await api.store.install({ mountPath: device.mountPath, slug, version });
      } else {
        setStatus(`Downloading ${slug}…`);
        const pkg = await scaricaPacchetto(slug, version);
        setStatus(`Comparing with what is on ORION…`);
        const m = await daMandare(pkg);
        const sec = stimaSecondi(m.byte);
        /* Over the radio a big app takes minutes: said before, not discovered. */
        if (sec > 60 && !window.confirm(
          `${slug}: ${kb(m.byte)} to send over Bluetooth, about ${Math.ceil(sec / 60)} minutes. ORION must stay on and close. ` +
          `With the USB cable it takes seconds. Send over Bluetooth?`,
        )) return;
        const t0 = Date.now();
        r = await installaBle(pkg, (fatto, totale) => {
          const pc = totale ? Math.round((fatto / totale) * 100) : 100;
          const resto = fatto > 0 ? Math.round(((Date.now() - t0) / fatto) * (totale - fatto) / 1000) : sec;
          setStatus(`Sending ${slug} to ORION over Bluetooth… ${pc}% · ${kb(fatto)} of ${kb(totale)}${resto > 5 ? ` · ~${resto} s left` : ""}`);
        });
      }
      setStatus(`✓ ${slug} ${r.version} installed: on ORION it is under Apps.`);
      log({ kind: "store-install", status: "ok", title: `App installed: ${slug}`, detail: `version ${r.version}` });
      await refreshInstalled();
    });

  const uninstall = (slug: string) =>
    run(async () => {
      if (!via) throw new Error("ORION is not connected.");
      const has = installedVersion(slug)?.hasData;
      if (!window.confirm(`Remove ${slug} from ORION?`)) return;
      const removeData = has
        ? window.confirm(`Also delete what ${slug} saved on the card (apps/data/${slug})? Cancel keeps it.`)
        : false;
      if (via === "usb" && device) await api.store.uninstall({ mountPath: device.mountPath, slug, removeData });
      else await rimuoviBle(slug, removeData);
      setStatus(`${slug} removed${removeData ? " with its data" : ""}.`);
      await refreshInstalled();
    });

  const tabs: { k: Tab; label: string }[] = [
    { k: "browse", label: "Browse" },
    { k: "installed", label: "Installed" },
    { k: "mine", label: "My apps" },
    ...(account?.admin ? [{ k: "moderation" as Tab, label: "Moderation" }] : []),
  ];

  const ctx: Ctx = { account, device: via, connectBle: () => run(async () => {
    setStatus("Choose ORION in the Bluetooth window…");
    await bleCondiviso.connetti();
    setStatus(bleCondiviso.naviga
      ? "Connected to ORION over Bluetooth. Install from the home screen of ORION (with firmware 0.3.0, coming soon, also from Apps)."
      : "Connected, but this firmware cannot manage files over Bluetooth: update it.");
  }), busy, run, setStatus, setAsk, install, uninstall, installedVersion, setOpen };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      {/* Tabs + account */}
      <div className="flex items-center justify-between gap-4">
        <div className="inline-flex overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
          {tabs.map((t) => (
            <button
              key={t.k}
              type="button"
              onClick={() => {
                setTab(t.k);
                setOpen(null);
              }}
              className={`px-3 py-1.5 text-sm ${
                tab === t.k
                  ? "bg-accent-soft font-medium text-accent"
                  : "text-zinc-600 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {account ? (
          <div className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300">
            {account.avatar && <img src={account.avatar} alt="" className="h-6 w-6 rounded-full" />}
            <span>{account.login}</span>
            {account.admin && <ShieldCheck className="h-4 w-4 text-accent" aria-label="moderator" />}
            <button
              type="button"
              className="btn-ghost"
              onClick={() => run(async () => {
                await api.store.signOut();
                setAccount(null);
              })}
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign out
            </button>
          </div>
        ) : (
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => void signIn()}>
            <Github className="h-3.5 w-3.5" />
            Sign in with GitHub
          </button>
        )}
      </div>

      {status && <div className="ui-card px-3 py-2 text-sm text-zinc-700 dark:text-zinc-200">{status}</div>}

      {open ? (
        <AppPage slug={open} ctx={ctx} onBack={() => setOpen(null)} />
      ) : tab === "browse" ? (
        <Browse ctx={ctx} />
      ) : tab === "installed" ? (
        <Installed ctx={ctx} installed={installed} onRefresh={refreshInstalled} />
      ) : tab === "mine" ? (
        <MyApps ctx={ctx} onSignIn={() => void signIn()} />
      ) : (
        <Moderation ctx={ctx} />
      )}

      {ask && <AskDialog s={ask} onClose={() => setAsk(null)} />}
    </div>
  );
};

interface Ctx {
  account: StoreAccount | null;
  /** How apps reach ORION now: "usb", "ble", or null (not connected). */
  device: Via;
  connectBle: () => Promise<void>;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  setStatus: (s: string) => void;
  setAsk: (a: AskState | null) => void;
  install: (slug: string, version?: string) => Promise<void>;
  uninstall: (slug: string) => Promise<void>;
  installedVersion: (slug: string) => { version: string | null; hasData: boolean } | undefined;
  setOpen: (slug: string | null) => void;
}

// ---------------------------------------------------------------------------
//  Browse
// ---------------------------------------------------------------------------

const Browse = ({ ctx }: { ctx: Ctx }) => {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState<"popular" | "rating" | "new">("popular");
  const [apps, setApps] = useState<StoreApp[] | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    setErr("");
    try {
      const r = await api.store.list({ q: q.trim() || undefined, category: category || undefined, sort });
      setApps(r.apps);
    } catch (e) {
      setErr((e as Error).message);
      setApps([]);
    }
  }, [q, category, sort]);

  useEffect(() => {
    const t = setTimeout(() => void load(), q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-2 top-2 h-4 w-4 text-zinc-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search apps or authors" className={`${inputCls} pl-8`} />
        </div>
        <select value={category} onChange={(e) => setCategory(e.target.value)} className={`${inputCls} w-auto`}>
          <option value="">All categories</option>
          {STORE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {cap(c)}
            </option>
          ))}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} className={`${inputCls} w-auto`}>
          <option value="popular">Most downloaded</option>
          <option value="rating">Best rated</option>
          <option value="new">Newest</option>
        </select>
        <button type="button" className="btn-ghost" onClick={() => void load()} title="Reload">
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {err && <p className="text-sm text-red-600 dark:text-red-400">{err}</p>}
      {apps === null ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : apps.length === 0 && !err ? (
        <div className="ui-card p-10 text-center text-sm text-zinc-500 dark:text-zinc-400">
          <Package className="mx-auto mb-2 h-8 w-8 text-zinc-400" />
          No apps here yet. Wrote one? Publish it from <b>My apps</b>.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {apps.map((a) => {
            const inst = ctx.installedVersion(a.slug);
            const update = inst?.version && a.version && inst.version !== a.version;
            return (
              <button
                key={a.slug}
                type="button"
                onClick={() => ctx.setOpen(a.slug)}
                className="ui-card flex flex-col gap-1.5 p-4 text-left transition-colors hover:border-accent"
              >
                {a.screenshots > 0 && a.version && (
                  <Shot slug={a.slug} version={a.version} i={0} className="mb-1 h-36 w-full rounded-md" />
                )}
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-zinc-900 dark:text-zinc-100">{a.title}</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      by {a.author} · {cap(a.category)} · v{a.version}
                    </p>
                  </div>
                  {inst && (
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                        update ? "bg-accent text-white" : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                      }`}
                    >
                      {update ? "UPDATE" : "INSTALLED"}
                    </span>
                  )}
                </div>
                <p className="line-clamp-2 text-sm text-zinc-600 dark:text-zinc-300">{a.summary}</p>
                <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400">
                  <span className="inline-flex items-center gap-1">
                    <Stars value={a.rating} size={12} />
                    {a.rating !== null ? `${a.rating.toFixed(1)} (${a.ratings})` : "no votes"}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Download className="h-3 w-3" />
                    {a.downloads}
                  </span>
                  <FlagBadges flags={a.flags} />
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
//  An app's page: rating, comments, install
// ---------------------------------------------------------------------------

const AppPage = ({ slug, ctx, onBack }: { slug: string; ctx: Ctx; onBack: () => void }) => {
  const [d, setD] = useState<StoreDetailResponse | null>(null);
  const [revs, setRevs] = useState<StoreReview[]>([]);
  const [err, setErr] = useState("");
  const [stars, setStars] = useState(0);
  const [body, setBody] = useState("");

  const load = useCallback(async () => {
    setErr("");
    try {
      const det = await api.store.detail(slug);
      setD(det);
      setStars(det.myReview?.stars ?? 0);
      setBody(det.myReview?.body ?? "");
      setRevs(det.app.public ? (await api.store.reviews(slug)).reviews : []);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load, ctx.account]);

  const descHtml = useMemo(() => (d ? markdownInHtml(d.app.description || "") : ""), [d]);
  const [prova, setProva] = useState(false);

  if (err) {
    return (
      <div className="flex flex-col gap-3">
        <BackBtn onBack={onBack} />
        <p className="text-sm text-red-600 dark:text-red-400">{err}</p>
      </div>
    );
  }
  if (!d) return <p className="text-sm text-zinc-500">Loading…</p>;
  const a = d.app;
  /* What "Try" runs: the public version, or — for the author and the
     moderators of an app not public yet — the newest one. */
  const provaVersione = a.public ? a.version : d.versions[0]?.version ?? null;
  const inst = ctx.installedVersion(a.slug);
  const update = !!inst?.version && !!a.version && inst.version !== a.version;
  const totale = d.histogram.reduce((x, y) => x + y, 0);
  const pericolosa = a.flags.includes("shared");

  return (
    <div className="flex flex-col gap-4">
      <BackBtn onBack={onBack} />
      {prova && provaVersione && (
        <EmulatorWindow
          title={`${a.title} ${provaVersione}`}
          load={() => api.store.tryFiles(a.slug, a.public && provaVersione === a.version ? undefined : provaVersione)}
          onClose={() => setProva(false)}
        />
      )}

      <div className="ui-card flex flex-col gap-3 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">{a.title}</h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              by <b>{a.author}</b> · {cap(a.category)} · v{a.version ?? "—"} · {fmtSize(a.size)} · updated {fmtDate(a.updatedAt)}
              {a.minApi ? ` · needs firmware API ${a.minApi}` : ""}
            </p>
            <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-200">{a.summary}</p>
            {!a.public && (
              <p className="mt-2 text-xs font-medium text-amber-600 dark:text-amber-400">
                {a.hidden ? "Hidden by a moderator: nobody else sees it." : "Not public yet: waiting for a moderator."}
              </p>
            )}
          </div>
          <div className="flex flex-col items-end gap-2">
            {provaVersione && (
              <button type="button" className="btn-ghost" onClick={() => setProva(true)} title="Run it in the emulator, without ORION">
                <Play className="h-3.5 w-3.5" />
                Try {a.public ? "" : provaVersione}
              </button>
            )}
            {a.public && (
              <div className="flex gap-2">
                {inst && (
                  <button type="button" className="btn-ghost" disabled={ctx.busy} onClick={() => void ctx.uninstall(a.slug)}>
                    <Trash2 className="h-3.5 w-3.5" />
                    Remove
                  </button>
                )}
                {(!inst || update || !inst.version) && (
                  <button
                    type="button"
                    className="btn-accent"
                    disabled={ctx.busy || !ctx.device}
                    title={ctx.device === "ble" ? "Over Bluetooth" : ctx.device ? "" : "Connect ORION over USB or Bluetooth"}
                    onClick={() => {
                      if (pericolosa && !window.confirm(`${a.title} can read and write EVERY file on the microSD. Install it only if you trust ${a.author}. Continue?`)) return;
                      void ctx.install(a.slug);
                    }}
                  >
                    <Download className="h-3.5 w-3.5" />
                    {update ? `Update to ${a.version}` : inst ? "Reinstall" : "Install on ORION"}
                  </button>
                )}
                {inst && !update && inst.version && (
                  <span className="inline-flex items-center gap-1 text-sm text-green-700 dark:text-green-400">
                    <Check className="h-4 w-4" /> Installed
                  </span>
                )}
              </div>
            )}
            {!ctx.device && a.public && (
              <p className="flex items-center gap-2 text-xs text-zinc-500">
                Connect ORION over USB, or
                <button type="button" className="inline-flex items-center gap-1 text-accent hover:underline" onClick={() => void ctx.connectBle()}>
                  <Bluetooth className="h-3 w-3" /> Bluetooth
                </button>
              </p>
            )}
            {ctx.device === "ble" && a.public && (
              <p className="flex items-center gap-1 text-xs text-zinc-500">
                <Bluetooth className="h-3 w-3" /> over Bluetooth{a.size ? ` · ${kb(a.size)}, about ${Math.max(1, Math.round(stimaSecondi(a.size)))} s` : ""}
              </p>
            )}
            <div className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300">
              <Stars value={a.rating} />
              {a.rating !== null ? `${a.rating.toFixed(1)} · ${a.ratings} vote${a.ratings === 1 ? "" : "s"}` : "no votes yet"}
              <span className="inline-flex items-center gap-1">
                <Download className="h-3.5 w-3.5" /> {a.downloads}
              </span>
            </div>
          </div>
        </div>

        {a.flags.length > 0 && (
          <div className={`rounded-lg border p-3 text-sm ${pericolosa ? "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40" : "border-zinc-200 dark:border-zinc-800"}`}>
            <p className="mb-1 flex items-center gap-1 font-medium text-zinc-800 dark:text-zinc-100">
              <AlertTriangle className={`h-4 w-4 ${pericolosa ? "text-red-600" : "text-zinc-400"}`} />
              What this app uses
            </p>
            <ul className="ml-5 list-disc text-zinc-600 dark:text-zinc-300">
              {a.flags.map((f) => (
                <li key={f}>
                  <b>{FLAG_INFO[f]?.label ?? f}</b>: {FLAG_INFO[f]?.text}
                </li>
              ))}
            </ul>
          </div>
        )}

        {a.version && a.screenshots > 0 && <Gallery slug={a.slug} version={a.version} count={a.screenshots} />}

        {a.description && (
          <div className="md-preview text-sm text-zinc-800 dark:text-zinc-100" dangerouslySetInnerHTML={{ __html: descHtml }} />
        )}

        {ctx.account?.admin && (
          <div className="flex gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
            <button
              type="button"
              className="btn-ghost"
              onClick={() => ctx.run(async () => {
                await api.store.setHidden(a.slug, !a.hidden);
                await load();
              })}
            >
              {a.hidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              {a.hidden ? "Show again" : "Hide from the store"}
            </button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {/* Votes */}
        <div className="ui-card flex flex-col gap-2 p-4">
          <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">Ratings</p>
          {[5, 4, 3, 2, 1].map((s) => (
            <div key={s} className="flex items-center gap-2 text-xs text-zinc-500">
              <span className="w-3">{s}</span>
              <Star className="h-3 w-3 fill-accent text-accent" />
              <div className="h-2 flex-1 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800">
                <div className="h-full bg-accent" style={{ width: `${totale ? (d.histogram[s - 1] / totale) * 100 : 0}%` }} />
              </div>
              <span className="w-6 text-right">{d.histogram[s - 1]}</span>
            </div>
          ))}
          <p className="mt-2 text-sm font-semibold text-zinc-800 dark:text-zinc-100">Versions</p>
          <ul className="flex flex-col gap-1.5 text-xs text-zinc-600 dark:text-zinc-300">
            {d.versions.map((v) => (
              <li key={v.id}>
                <span className="font-mono">{v.version}</span> · {fmtDate(v.createdAt)} {v.status !== "approved" && <StatusBadge status={v.status} />}
                {v.changelog && <p className="text-zinc-500">{v.changelog}</p>}
              </li>
            ))}
          </ul>
        </div>

        {/* Comments */}
        <div className="flex flex-col gap-3 md:col-span-2">
          {a.public && (
            <div className="ui-card flex flex-col gap-2 p-4">
              {!ctx.account ? (
                <p className="text-sm text-zinc-500">Sign in with GitHub (top right) to rate and comment.</p>
              ) : a.isOwner ? (
                <p className="text-sm text-zinc-500">This is your app: you cannot rate it.</p>
              ) : (
                <>
                  <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                    {d.myReview ? "Your review" : "Rate this app"}
                  </p>
                  <StarPicker value={stars} onChange={setStars} />
                  <textarea
                    rows={3}
                    maxLength={2000}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    placeholder="A comment (optional)"
                    className={inputCls}
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="btn-accent"
                      disabled={ctx.busy || stars === 0}
                      onClick={() => ctx.run(async () => {
                        await api.store.review({ slug: a.slug, stars, body });
                        ctx.setStatus("Thanks: your review is saved.");
                        await load();
                      })}
                    >
                      {d.myReview ? "Update" : "Publish"}
                    </button>
                    {d.myReview && (
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => ctx.run(async () => {
                          await api.store.deleteReview(a.slug);
                          await load();
                        })}
                      >
                        Delete
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-ghost ml-auto"
                      title="Report this app to the moderators"
                      onClick={() =>
                        ctx.setAsk({
                          title: `Report ${a.title}`,
                          label: "What is wrong with it? (moderators only see this)",
                          confirm: "Report",
                          multiline: true,
                          onConfirm: (reason) => ctx.run(async () => {
                            await api.store.report({ slug: a.slug, reason });
                            ctx.setStatus("Reported: a moderator will look at it.");
                          }),
                        })
                      }
                    >
                      <Flag className="h-3.5 w-3.5" />
                      Report
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {revs.length === 0 ? (
            <p className="text-sm text-zinc-500">{a.public ? "No comments yet." : ""}</p>
          ) : (
            revs.map((r) => (
              <div key={r.id} className="ui-card flex flex-col gap-1 p-4">
                <div className="flex items-center gap-2 text-sm">
                  {r.avatar && <img src={r.avatar} alt="" className="h-5 w-5 rounded-full" />}
                  <b className="text-zinc-800 dark:text-zinc-100">{r.login}</b>
                  <Stars value={r.stars} size={12} />
                  <span className="text-xs text-zinc-500">{fmtDate(r.updatedAt)}</span>
                  {ctx.account?.admin && (
                    <span className="ml-auto flex gap-1">
                      <button
                        type="button"
                        className="btn-ghost px-2 py-0.5 text-xs"
                        onClick={() => ctx.run(async () => {
                          await api.store.hideReview(r.id);
                          await load();
                        })}
                      >
                        Hide
                      </button>
                      <button
                        type="button"
                        className="btn-ghost px-2 py-0.5 text-xs text-red-600"
                        onClick={() => {
                          if (!window.confirm(`Ban ${r.login} from the store? Their comments disappear and they cannot sign in.`)) return;
                          void ctx.run(async () => {
                            await api.store.ban(r.login, true);
                            await load();
                          });
                        }}
                      >
                        Ban
                      </button>
                    </span>
                  )}
                </div>
                {r.body && <p className="whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-200">{r.body}</p>}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

const BackBtn = ({ onBack }: { onBack: () => void }) => (
  <button type="button" className="btn-ghost self-start" onClick={onBack}>
    <ArrowLeft className="h-3.5 w-3.5" />
    Back
  </button>
);

// ---------------------------------------------------------------------------
//  Installed
// ---------------------------------------------------------------------------

const Installed = ({
  ctx,
  installed,
  onRefresh,
}: {
  ctx: Ctx;
  installed: StoreInstalledResponse | null;
  onRefresh: () => Promise<void>;
}) => {
  const [latest, setLatest] = useState<Record<string, string>>({});
  useEffect(() => {
    void api.store
      .list({})
      .then((r) => setLatest(Object.fromEntries(r.apps.map((a) => [a.slug, a.version ?? ""]))))
      .catch(() => undefined);
  }, []);

  if (!ctx.device) {
    return (
      <div className="ui-card flex flex-col items-center gap-3 p-10 text-center text-sm text-zinc-500">
        <p>Connect ORION over USB (USB mode) to see its apps — or over Bluetooth, slower but without the cable.</p>
        <p className="text-xs">
          Over Bluetooth, leave ORION on the home screen while installing. Firmware 0.3.0 (coming soon) also lets you stay in Apps,
          shows a new app there by itself, and refuses to overwrite an app while it runs.
        </p>
        <button type="button" className="btn-ghost" disabled={ctx.busy} onClick={() => void ctx.connectBle()}>
          <Bluetooth className="h-3.5 w-3.5" />
          Connect over Bluetooth
        </button>
      </div>
    );
  }
  if (!installed) return <p className="text-sm text-zinc-500">{ctx.device === "ble" ? "Reading ORION over Bluetooth…" : "Reading the card…"}</p>;
  const pieno = installed.apps.length >= installed.limit;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between text-sm text-zinc-600 dark:text-zinc-300">
        <span className={pieno ? "font-medium text-amber-600 dark:text-amber-400" : ""}>
          {ctx.device === "ble" && <Bluetooth className="mr-1 inline h-3.5 w-3.5" />}
          {installed.apps.length} of {installed.limit} apps the launcher can show
          {pieno ? " — the launcher is full: remove one to see a new one" : ""}
        </span>
        <button type="button" className="btn-ghost" onClick={() => void onRefresh()}>
          <RefreshCw className="h-3.5 w-3.5" />
          Reload
        </button>
      </div>
      {installed.apps.length === 0 ? (
        <div className="ui-card p-10 text-center text-sm text-zinc-500">No apps on the card yet.</div>
      ) : (
        <div className="ui-card divide-y divide-zinc-100 dark:divide-zinc-800">
          {installed.apps.map((a) => {
            const ultima = latest[a.slug];
            const update = a.version && ultima && ultima !== a.version;
            return (
              <div key={a.slug} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <Package className="h-4 w-4 text-zinc-400" />
                <button
                  type="button"
                  className="font-medium text-zinc-800 hover:text-accent disabled:hover:text-zinc-800 dark:text-zinc-100"
                  disabled={!ultima}
                  onClick={() => ctx.setOpen(a.slug)}
                >
                  {a.slug}
                </button>
                <span className="text-xs text-zinc-500">
                  {a.version ? `v${a.version} from the store` : "copied by hand"}
                  {a.hasData ? " · has data" : ""}
                </span>
                <span className="ml-auto flex gap-2">
                  {update && (
                    <button type="button" className="btn-accent" disabled={ctx.busy} onClick={() => void ctx.install(a.slug)}>
                      <Download className="h-3.5 w-3.5" />
                      Update to {ultima}
                    </button>
                  )}
                  <button type="button" className="btn-ghost" disabled={ctx.busy} onClick={() => void ctx.uninstall(a.slug)}>
                    <Trash2 className="h-3.5 w-3.5" />
                    Remove
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
//  My apps: publish, follow the review
// ---------------------------------------------------------------------------

const Field = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) => (
  <label className="flex flex-col gap-1 text-xs text-zinc-500 dark:text-zinc-400">
    <span>
      {label}
      {hint && <span className="ml-1 text-zinc-400">— {hint}</span>}
    </span>
    {children}
  </label>
);

const MyApps = ({ ctx, onSignIn }: { ctx: Ctx; onSignIn: () => void }) => {
  const [mine, setMine] = useState<StoreMyApp[] | null>(null);
  const [draft, setDraft] = useState<StorePublishDraft | null>(null);
  const [shots, setShots] = useState<StoreShotFile[]>([]);
  const [prova, setProva] = useState(false);
  const muovi = (i: number, d: -1 | 1) =>
    setShots((l) => {
      const j = i + d;
      if (j < 0 || j >= l.length) return l;
      const n = [...l];
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });

  const load = useCallback(async () => {
    if (!ctx.account) return;
    try {
      setMine((await api.store.myApps()).apps);
    } catch (e) {
      ctx.setStatus(`Error: ${(e as Error).message}`);
    }
  }, [ctx.account]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!ctx.account) {
    return (
      <div className="ui-card flex flex-col items-center gap-3 p-10 text-center text-sm text-zinc-600 dark:text-zinc-300">
        <Upload className="h-8 w-8 text-zinc-400" />
        <p>Publishing is free: sign in with GitHub, choose your app's .lua, and a moderator puts it in the store.</p>
        <button type="button" className="btn-accent" onClick={onSignIn}>
          <Github className="h-3.5 w-3.5" />
          Sign in with GitHub
        </button>
      </div>
    );
  }

  const precedente = draft ? mine?.find((m) => m.slug === draft.slug) : undefined;
  const set = <K extends keyof StorePublishDraft>(k: K, v: StorePublishDraft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const inclusi = draft ? draft.files.filter((f) => !f.excluded) : [];
  const esclusi = draft ? draft.files.filter((f) => f.excluded).map((f) => f.path) : [];
  const pesoInclusi = inclusi.reduce((n, f) => n + f.size, 0);
  /* Size and count depend on the ticks: recomputed here, not taken from the
     first reading of the folder. */
  const errori = draft
    ? [
        ...draft.errors.filter((e) => !/^The app is |files: the store takes/.test(e)),
        ...(pesoInclusi > 4 * 1024 * 1024 ? [`The app is ${(pesoInclusi / 1048576).toFixed(1)} MB: the store takes up to 4 MB. Untick what is not needed.`] : []),
        ...(inclusi.length > 200 ? [`${inclusi.length} files: the store takes up to 200.`] : []),
      ]
    : [];

  return (
    <div className="flex flex-col gap-4">
      {prova && draft && (
        <EmulatorWindow
          title={`${draft.title || draft.slug} — from your disk`}
          load={() => api.store.localFiles(draft.luaPath, esclusi)}
          onCapture={async (png) => {
            if (shots.length >= 5) throw new Error("Already 5 screenshots: remove one first");
            const f = await api.store.saveCapture(png);
            setShots((l) => [...l, f].slice(0, 5));
          }}
          onClose={() => setProva(false)}
        />
      )}
      {!draft ? (
        <div className="ui-card flex items-center justify-between gap-4 p-4">
          <div className="text-sm text-zinc-600 dark:text-zinc-300">
            <p className="font-medium text-zinc-800 dark:text-zinc-100">Publish an app, or a new version</p>
            <p className="text-xs">
              Choose the app's <code>.lua</code>. Its data folder is taken from <code>data/&lt;name&gt;/</code> next to it, as in the emulator's
              card. Every version is checked by a moderator before it goes public.
            </p>
          </div>
          <button
            type="button"
            className="btn-accent shrink-0"
            onClick={() => ctx.run(async () => {
              const dd = await api.store.pickSource();
              if (dd) {
                setDraft(dd);
                setShots([]);
              }
            })}
          >
            <Upload className="h-3.5 w-3.5" />
            Choose .lua…
          </button>
        </div>
      ) : (
        <div className="ui-card flex flex-col gap-3 p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-semibold text-zinc-900 dark:text-zinc-100">
                {precedente ? `New version of ${draft.slug}` : `New app: ${draft.slug}`}
              </p>
              <p className="text-xs text-zinc-500">
                {draft.luaPath} · {inclusi.length} file{inclusi.length === 1 ? "" : "s"} · {fmtSize(pesoInclusi)}
                {precedente ? ` · last version: ${precedente.versions[0]?.version ?? "—"}` : ""}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-accent"
                disabled={!SLUG_OK.test(draft.slug)}
                title="Run it in the emulator; Capture adds screenshots"
                onClick={() => setProva(true)}
              >
                <Play className="h-3.5 w-3.5" />
                Try in emulator
              </button>
              <button
                type="button"
                className="btn-ghost"
                title="Read the file again after editing it"
                onClick={() => ctx.run(async () => {
                  const n = await api.store.readSource(draft.luaPath);
                  /* The author's ticks survive a re-read; new files get the default. */
                  const prima = new Map(draft.files.map((f) => [f.path, f.excluded]));
                  n.files = n.files.map((f) => (prima.has(f.path) ? { ...f, excluded: prima.get(f.path)! } : f));
                  setDraft((d) => (d ? { ...n, title: d.title, summary: d.summary, description: d.description, category: d.category || n.category, version: d.version, changelog: d.changelog, minApi: d.minApi } : n));
                })}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Re-read
              </button>
              <button type="button" className="btn-ghost" onClick={() => { setDraft(null); setShots([]); }}>
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {errori.map((e) => (
            <p key={e} className="rounded bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
              {e}
            </p>
          ))}
          {draft.warnings.map((w) => (
            <p key={w} className="text-xs text-zinc-500">
              {w}
            </p>
          ))}
          {draft.flags.length > 0 && (
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              Shown to users before they install: <FlagBadges flags={draft.flags} />
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Title" hint="up to 40">
              <input maxLength={40} value={draft.title} onChange={(e) => set("title", e.target.value)} className={inputCls} />
            </Field>
            <Field label="Category">
              <select value={draft.category} onChange={(e) => set("category", e.target.value)} className={inputCls}>
                <option value="">— choose —</option>
                {STORE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {cap(c)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Summary" hint="one line, up to 120">
              <input maxLength={120} value={draft.summary} onChange={(e) => set("summary", e.target.value)} className={inputCls} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Version" hint="e.g. 1.0.0">
                <input maxLength={16} value={draft.version} onChange={(e) => set("version", e.target.value)} className={inputCls} />
              </Field>
              <Field label="Firmware API" hint="optional, e.g. 0.3.0">
                <input maxLength={16} value={draft.minApi} onChange={(e) => set("minApi", e.target.value)} className={inputCls} />
              </Field>
            </div>
          </div>
          <Field label="Description" hint="Markdown; keys, how to play, what it saves">
            <textarea rows={6} maxLength={4000} value={draft.description} onChange={(e) => set("description", e.target.value)} className={inputCls} />
          </Field>
          <Field label="What changed" hint="optional">
            <textarea rows={2} maxLength={1000} value={draft.changelog} onChange={(e) => set("changelog", e.target.value)} className={inputCls} />
          </Field>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                Screenshots — PNG or JPEG, up to 5, 1 MB each. A capture of the emulator window works well.
              </span>
              <button
                type="button"
                className="btn-ghost"
                disabled={shots.length >= 5}
                onClick={() => ctx.run(async () => {
                  const nuove = await api.store.pickScreenshots();
                  setShots((l) => [...l, ...nuove].slice(0, 5));
                })}
              >
                <ImagePlus className="h-3.5 w-3.5" />
                Add images…
              </button>
            </div>
            {shots.length === 0 ? (
              <p className="text-xs text-zinc-500">
                {precedente?.public
                  ? "None chosen: the screenshots of the version now in the store carry over."
                  : "None chosen: the app page will have no images."}
              </p>
            ) : (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {shots.map((sh, i) => (
                  <div key={sh.path + i} className="flex w-48 shrink-0 flex-col gap-1">
                    {sh.dataUrl ? (
                      <img src={sh.dataUrl} alt="" className="h-28 w-48 rounded border border-zinc-200 bg-zinc-100 object-contain dark:border-zinc-800 dark:bg-zinc-800" />
                    ) : (
                      <div className="flex h-28 w-48 items-center justify-center rounded bg-red-50 p-2 text-center text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
                        {sh.error}
                      </div>
                    )}
                    <div className="flex items-center justify-between text-[11px] text-zinc-500">
                      <span className="truncate" title={sh.path}>{sh.path.split(/[\\/]/).pop()}</span>
                      <span className="flex shrink-0">
                        <button type="button" title="Move left" disabled={i === 0} onClick={() => muovi(i, -1)}><ChevronLeft className="h-4 w-4" /></button>
                        <button type="button" title="Move right" disabled={i === shots.length - 1} onClick={() => muovi(i, 1)}><ChevronRight className="h-4 w-4" /></button>
                        <button type="button" title="Remove" onClick={() => setShots((l) => l.filter((_, k) => k !== i))}><X className="h-4 w-4" /></button>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <details className="text-xs text-zinc-500" open={draft.files.length > 1 && draft.files.length <= 40}>
            <summary className="cursor-pointer">
              Files in the package — {inclusi.length} of {draft.files.length}, {fmtSize(pesoInclusi)}
              {draft.files.length > 1 ? " (untick what the app does not need on the card)" : ""}
            </summary>
            <ul className="mt-1 max-h-60 overflow-auto font-mono">
              {draft.files.map((f) => (
                <li key={f.path} className={f.excluded ? "text-zinc-400 line-through" : ""}>
                  <label className="inline-flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={!f.excluded}
                      disabled={f.path === `${draft.slug}.lua`}
                      onChange={(e) => set("files", draft.files.map((x) => (x.path === f.path ? { ...x, excluded: !e.target.checked } : x)))}
                    />
                    {f.path === `${draft.slug}.lua` ? f.path : `apps/data/${draft.slug}/${f.path.slice(5)}`} · {fmtSize(f.size)}
                  </label>
                </li>
              ))}
            </ul>
          </details>
          <div className="flex justify-end">
            <button
              type="button"
              className="btn-accent"
              disabled={ctx.busy || errori.length > 0 || shots.some((x) => x.error) || !draft.category || !draft.title.trim() || !draft.summary.trim()}
              onClick={() => ctx.run(async () => {
                const r = await api.store.publish({
                  luaPath: draft.luaPath,
                  exclude: esclusi,
                  manifest: {
                    slug: draft.slug,
                    title: draft.title,
                    summary: draft.summary,
                    description: draft.description,
                    category: draft.category,
                    version: draft.version,
                    changelog: draft.changelog,
                    minApi: draft.minApi,
                  },
                  screenshots: shots.map((x) => x.path),
                });
                const imm = r.screenshots
                  ? ` with ${r.screenshots} screenshot${r.screenshots === 1 ? "" : "s"}${r.screenshotsInherited ? " (from the previous version)" : ""}`
                  : "";
                ctx.setStatus(`✓ ${r.slug} ${r.version} sent${imm}: it goes public once a moderator approves it.`);
                setDraft(null);
                setShots([]);
                await load();
              })}
            >
              <Upload className="h-3.5 w-3.5" />
              Send for review
            </button>
          </div>
        </div>
      )}

      {mine === null ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : mine.length === 0 ? (
        <p className="text-sm text-zinc-500">You have not published anything yet.</p>
      ) : (
        mine.map((m) => (
          <div key={m.slug} className="ui-card flex flex-col gap-2 p-4">
            <div className="flex items-center gap-3">
              <button type="button" className="font-semibold text-zinc-900 hover:text-accent dark:text-zinc-100" onClick={() => ctx.setOpen(m.slug)}>
                {m.title}
              </button>
              <span className="font-mono text-xs text-zinc-500">{m.slug}</span>
              <span className="ml-auto flex items-center gap-3 text-xs text-zinc-500">
                {m.public ? "public" : m.hidden ? "hidden by a moderator" : "not public yet"}
                <span className="inline-flex items-center gap-1">
                  <Stars value={m.rating} size={11} /> {m.ratings}
                </span>
                <span className="inline-flex items-center gap-1">
                  <Download className="h-3 w-3" /> {m.downloads}
                </span>
              </span>
            </div>
            <ul className="flex flex-col gap-1 text-sm">
              {m.versions.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{v.version}</span>
                  <StatusBadge status={v.status} />
                  <span className="text-xs text-zinc-500">{fmtDate(v.createdAt)}</span>
                  {v.status === "rejected" && v.rejectReason && <span className="text-xs text-red-600 dark:text-red-400">“{v.rejectReason}”</span>}
                  {v.status === "pending" && (
                    <button
                      type="button"
                      className="btn-ghost px-2 py-0.5 text-xs"
                      onClick={() => {
                        if (!window.confirm(`Withdraw ${m.slug} ${v.version} from the review queue?`)) return;
                        void ctx.run(async () => {
                          await api.store.withdraw(v.id);
                          await load();
                        });
                      }}
                    >
                      Withdraw
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
//  Moderation
// ---------------------------------------------------------------------------

const Moderation = ({ ctx }: { ctx: Ctx }) => {
  const [q, setQ] = useState<StoreQueueItem[] | null>(null);
  const [reps, setReps] = useState<StoreReport[]>([]);
  const [prova, setProva] = useState<StoreQueueItem | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([api.store.queue(), api.store.reports()]);
      setQ(a.queue);
      setReps(b.reports);
    } catch (e) {
      ctx.setStatus(`Error: ${(e as Error).message}`);
      setQ([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      {prova && (
        <EmulatorWindow
          title={`${prova.title} ${prova.version} — waiting for review`}
          load={() => api.store.tryFiles(prova.slug, prova.version)}
          onClose={() => setProva(null)}
        />
      )}
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-600 dark:text-zinc-300">
          Try a version in the emulator, or install it on ORION, before approving. Look hard at anything marked <b>Whole card</b>.
        </p>
        <button type="button" className="btn-ghost" onClick={() => void load()}>
          <RefreshCw className="h-3.5 w-3.5" />
          Reload
        </button>
      </div>

      {q === null ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : q.length === 0 ? (
        <div className="ui-card p-8 text-center text-sm text-zinc-500">Nothing waiting for review.</div>
      ) : (
        q.map((v) => (
          <div key={v.id} className="ui-card flex flex-col gap-2 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <b className="text-zinc-900 dark:text-zinc-100">{v.title}</b>
              <span className="font-mono text-xs text-zinc-500">
                {v.slug} {v.version}
              </span>
              <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold dark:bg-zinc-800">{v.isNew ? "NEW APP" : "UPDATE"}</span>
              <span className="text-xs text-zinc-500">
                by {v.author} · {cap(v.category)} · {fmtSize(v.size)} · {fmtDate(v.createdAt)}
              </span>
              <FlagBadges flags={v.flags} />
            </div>
            <p className="text-sm text-zinc-700 dark:text-zinc-200">{v.summary}</p>
            {v.screenshots > 0 ? (
              <Gallery slug={v.slug} version={v.version} count={v.screenshots} />
            ) : (
              <p className="text-xs text-zinc-500">No screenshots.</p>
            )}
            {v.changelog && <p className="text-xs text-zinc-500">Changes: {v.changelog}</p>}
            {v.description && (
              <details className="text-sm">
                <summary className="cursor-pointer text-xs text-zinc-500">Description</summary>
                <div className="md-preview mt-1" dangerouslySetInnerHTML={{ __html: markdownInHtml(v.description) }} />
              </details>
            )}
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-ghost" onClick={() => setProva(v)} title="Run this pending version in the emulator">
                <Play className="h-3.5 w-3.5" />
                Try in emulator
              </button>
              <button
                type="button"
                className="btn-ghost"
                disabled={ctx.busy || !ctx.device}
                title={ctx.device ? "Install this pending version on the connected ORION" : "Connect ORION over USB or Bluetooth"}
                onClick={() => void ctx.install(v.slug, v.version)}
              >
                <Download className="h-3.5 w-3.5" />
                Install on ORION to test
              </button>
              <button
                type="button"
                className="btn-accent"
                disabled={ctx.busy}
                onClick={() => {
                  if (v.flags.includes("shared") && !window.confirm(`${v.slug} can write anywhere on users' cards. Approve it?`)) return;
                  void ctx.run(async () => {
                    await api.store.decide({ versionId: v.id, action: "approve" });
                    ctx.setStatus(`${v.slug} ${v.version} approved: it is public.`);
                    await load();
                  });
                }}
              >
                <Check className="h-3.5 w-3.5" />
                Approve
              </button>
              <button
                type="button"
                className="btn-ghost text-red-600"
                disabled={ctx.busy}
                onClick={() =>
                  ctx.setAsk({
                    title: `Reject ${v.slug} ${v.version}`,
                    label: "Why? The author reads this.",
                    confirm: "Reject",
                    multiline: true,
                    onConfirm: (reason) => ctx.run(async () => {
                      await api.store.decide({ versionId: v.id, action: "reject", reason });
                      await load();
                    }),
                  })
                }
              >
                <X className="h-3.5 w-3.5" />
                Reject
              </button>
            </div>
          </div>
        ))
      )}

      <p className="mt-2 text-sm font-semibold text-zinc-800 dark:text-zinc-100">Reports</p>
      {reps.length === 0 ? (
        <p className="text-sm text-zinc-500">No open reports.</p>
      ) : (
        reps.map((r) => (
          <div key={r.id} className="ui-card flex items-start gap-3 p-3 text-sm">
            <Flag className="mt-0.5 h-4 w-4 text-red-500" />
            <div className="flex-1">
              <button type="button" className="font-medium hover:text-accent" onClick={() => ctx.setOpen(r.slug)}>
                {r.title}
              </button>{" "}
              <span className="text-xs text-zinc-500">
                by {r.login} · {fmtDate(r.createdAt)}
              </span>
              <p className="whitespace-pre-wrap text-zinc-700 dark:text-zinc-200">{r.reason}</p>
            </div>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => ctx.run(async () => {
                await api.store.resolveReport(r.id);
                await load();
              })}
            >
              Resolved
            </button>
          </div>
        ))
      )}
    </div>
  );
};

export default StorePage;
