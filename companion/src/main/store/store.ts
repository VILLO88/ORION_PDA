/**
 * App Store: browsing, installing on the card, publishing, moderating.
 *
 * On the card an app is `/apps/<slug>.lua`, and its data `/apps/data/<slug>/`
 * (firmware: app_launcher.c, orion_fs.c). A package from the store holds
 * exactly those two things, and nothing is written anywhere else: the paths
 * are checked here too, not only by the server, because a package is bytes
 * from the internet and the card is the user's.
 *
 * What came from the store is remembered in `/apps/.store.json` (slug ->
 * version), so the page can say "update available". The launcher lists only
 * `.lua` files, so the file is invisible on the device.
 */
import { app, dialog } from "electron";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, normalize, relative, resolve } from "node:path";
import type {
  StoreApp,
  StoreDecideRequest,
  StoreDetailResponse,
  StoreFlag,
  StoreInstalledResponse,
  StoreInstallRequest,
  StoreInstallResponse,
  StoreListRequest,
  StoreMyApp,
  StorePublishDraft,
  StorePublishRequest,
  StorePublishResponse,
  StoreShotFile,
  StoreTryPackage,
  StoreQueueItem,
  StoreReport,
  StoreReportRequest,
  StoreReview,
  StoreReviewRequest,
  StoreUninstallRequest,
} from "../../shared/ipc-types";
import { listOrionDevices } from "../ipc/device";
import { call } from "./account";

const enc = encodeURIComponent;

/* The firmware's limits, and the store server's (it refuses the same). */
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,26}$/;
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const MAX_MAIN = 32 * 1024;
const MAX_TOTAL = 4 * 1024 * 1024;
const MAX_FILES = 200;
/** SCRIPT_MAX 16 in app_launcher.c, one slot kept for a system entry. */
const LAUNCHER_LIMIT = 15;
const STORE_FILE = ".store.json";

// ---------------------------------------------------------------------------
//  Browsing, votes, comments
// ---------------------------------------------------------------------------

export function list(req: StoreListRequest): Promise<{ apps: StoreApp[] }> {
  const q = new URLSearchParams();
  if (req.q) q.set("q", req.q);
  if (req.category) q.set("category", req.category);
  if (req.sort) q.set("sort", req.sort);
  return call("GET", `/v1/apps?${q}`);
}

export const detail = (slug: string) => call<StoreDetailResponse>("GET", `/v1/apps/${enc(slug)}`);
export const reviews = (slug: string) => call<{ reviews: StoreReview[] }>("GET", `/v1/apps/${enc(slug)}/reviews`);

export async function review(req: StoreReviewRequest): Promise<void> {
  await call("PUT", `/v1/apps/${enc(req.slug)}/review`, { body: { stars: req.stars, body: req.body } });
}
export async function deleteReview(slug: string): Promise<void> {
  await call("DELETE", `/v1/apps/${enc(slug)}/review`);
}
export async function report(req: StoreReportRequest): Promise<void> {
  await call("POST", `/v1/apps/${enc(req.slug)}/report`, { body: { reason: req.reason } });
}

// ---------------------------------------------------------------------------
//  The card
// ---------------------------------------------------------------------------

async function assertDevice(mountPath: string): Promise<string> {
  const m = normalize(mountPath);
  const { devices } = await listOrionDevices();
  if (!devices.some((d) => normalize(d.mountPath) === m)) {
    throw new Error("ORION is not connected (or not in USB mode).");
  }
  return m;
}

type StoreIndex = Record<string, { version: string; installedAt: string }>;

async function readIndex(appsDir: string): Promise<StoreIndex> {
  try {
    return JSON.parse(await readFile(join(appsDir, STORE_FILE), "utf-8")) as StoreIndex;
  } catch {
    return {};
  }
}

async function writeIndex(appsDir: string, idx: StoreIndex): Promise<void> {
  await mkdir(appsDir, { recursive: true });
  await writeFile(join(appsDir, STORE_FILE), JSON.stringify(idx, null, 2), "utf-8");
}

export async function installed(mountPath: string): Promise<StoreInstalledResponse> {
  return installedIn(join(await assertDevice(mountPath), "apps"));
}

/** `installed()` on a given /apps folder: separate for the PC test. */
export async function installedIn(appsDir: string): Promise<StoreInstalledResponse> {
  const idx = await readIndex(appsDir);
  const apps: StoreInstalledResponse["apps"] = [];
  let voci: string[] = [];
  try {
    voci = await readdir(appsDir);
  } catch {
    /* no /apps yet */
  }
  for (const v of voci) {
    if (v.startsWith(".") || !v.toLowerCase().endsWith(".lua")) continue;
    const slug = v.slice(0, -4);
    apps.push({
      slug,
      version: idx[slug]?.version ?? null,
      hasData: existsSync(join(appsDir, "data", slug)),
    });
  }
  apps.sort((a, b) => a.slug.localeCompare(b.slug));
  return { apps, limit: LAUNCHER_LIMIT };
}

/** The card path of a package entry, or an error: only `<slug>.lua` and
 *  `data/...` under `/apps/data/<slug>/`. */
function cardPath(appsDir: string, slug: string, p: string): string {
  if (p === `${slug}.lua`) return join(appsDir, p);
  const seg = p.split("/");
  if (seg[0] !== "data" || seg.length < 2 || !seg.slice(1).every((s) => SEGMENT_RE.test(s) && s !== "." && s !== "..")) {
    throw new Error(`The package contains a path that is not allowed: ${p}`);
  }
  const dataDir = join(appsDir, "data", slug);
  const dest = resolve(dataDir, ...seg.slice(1));
  const rel = relative(dataDir, dest);
  if (rel.startsWith("..") || rel === "") throw new Error(`The package contains a path that is not allowed: ${p}`);
  return dest;
}

export async function install(req: StoreInstallRequest): Promise<StoreInstallResponse> {
  if (!SLUG_RE.test(req.slug)) throw new Error("Invalid app name");
  return installIn(join(await assertDevice(req.mountPath), "apps"), req.slug, req.version);
}

/** `install()` into a given /apps folder: separate for the PC test. */
/** A package from the store, its SHA-256 checked. `prova`: for the
 *  emulator, not counted as a download. */
async function scarica(slug: string, version?: string, prova = false): Promise<StoreTryPackage> {
  const q = new URLSearchParams();
  if (version) q.set("version", version);
  if (prova) q.set("try", "1");
  const r = await call<Response>("GET", `/v1/apps/${enc(slug)}/package?${q}`, { raw: true });
  const buf = Buffer.from(await r.arrayBuffer());
  const atteso = r.headers.get("X-Package-Sha256");
  /* Checked before a single byte reaches the card. */
  if (!atteso || createHash("sha256").update(buf).digest("hex") !== atteso) {
    throw new Error("The downloaded package is damaged (checksum mismatch): try again.");
  }
  const pkg = JSON.parse(buf.toString("utf-8")) as StoreTryPackage & { format: number };
  if (pkg.format !== 1 || pkg.slug !== slug || !Array.isArray(pkg.files)) {
    throw new Error("Unknown package format: update the Companion.");
  }
  return { slug: pkg.slug, version: pkg.version, files: pkg.files };
}

/** For installing over Bluetooth (written by the page, where the radio is):
 *  the package, checked, counted as a download like a USB install. */
export async function packageFiles(slug: string, version?: string): Promise<StoreTryPackage> {
  if (!SLUG_RE.test(slug)) throw new Error("Invalid app name");
  return scarica(slug, version, false);
}

/** For "Try": the package, to be written in the emulator's card. */
export async function tryFiles(slug: string, version?: string): Promise<StoreTryPackage> {
  if (!SLUG_RE.test(slug)) throw new Error("Invalid app name");
  return scarica(slug, version, true);
}

/** For "Try in emulator" while publishing: the app as it is on disk now. */
export async function localFiles(luaPath: string, exclude?: string[]): Promise<StoreTryPackage> {
  const { slug, files, errors } = await filesOf(luaPath, exclude);
  if (errors.length && !SLUG_RE.test(slug)) throw new Error(errors[0]);
  return { slug, version: "local", files: files.map((f) => ({ path: f.path, b64: f.data.toString("base64") })) };
}

export async function installIn(appsDir: string, slug: string, version?: string): Promise<StoreInstallResponse> {
  const pkg = await scarica(slug, version);

  /* Paths first, all of them: a bad entry halfway must not leave half an
     app on the card. */
  const piano = pkg.files.map((f) => ({ dest: cardPath(appsDir, pkg.slug, f.path), data: Buffer.from(f.b64, "base64") }));
  if (!piano.some((x) => x.dest === join(appsDir, `${pkg.slug}.lua`))) throw new Error("The package has no script.");

  /* The package's files overwrite, nothing else in data/ is touched: what
     the app saved itself (records, high scores) survives an update. */
  const written: string[] = [];
  /* The script last: until it is there the launcher does not show the app,
     so an interrupted install never shows an app without its data. */
  piano.sort((a, b) => Number(a.dest.endsWith(".lua") && dirname(a.dest) === appsDir) -
    Number(b.dest.endsWith(".lua") && dirname(b.dest) === appsDir));
  for (const x of piano) {
    await mkdir(dirname(x.dest), { recursive: true });
    await writeFile(x.dest, x.data);
    written.push(x.dest);
  }
  const idx = await readIndex(appsDir);
  idx[pkg.slug] = { version: pkg.version, installedAt: new Date().toISOString() };
  await writeIndex(appsDir, idx);
  return { version: pkg.version, written };
}

export async function uninstall(req: StoreUninstallRequest): Promise<void> {
  if (!SLUG_RE.test(req.slug)) throw new Error("Invalid app name");
  return uninstallIn(join(await assertDevice(req.mountPath), "apps"), req);
}

export async function uninstallIn(appsDir: string, req: { slug: string; removeData: boolean }): Promise<void> {
  if (!SLUG_RE.test(req.slug)) throw new Error("Invalid app name");
  await rm(join(appsDir, `${req.slug}.lua`), { force: true });
  if (req.removeData) await rm(join(appsDir, "data", req.slug), { recursive: true, force: true });
  const idx = await readIndex(appsDir);
  if (idx[req.slug]) {
    delete idx[req.slug];
    await writeIndex(appsDir, idx);
  }
}

// ---------------------------------------------------------------------------
//  Publishing
// ---------------------------------------------------------------------------

/** The same reading the store server does on every upload,
 *  shown to the author before sending. */
function flagsOf(files: { path: string; data: Buffer }[]): StoreFlag[] {
  const flags = new Set<StoreFlag>();
  for (const f of files) {
    if (/\.luac$/i.test(f.path)) flags.add("compiled");
    if (!/\.lua$/i.test(f.path)) continue;
    const src = f.data.toString("utf-8");
    /* shared/sounds/ = the system sounds every app may read: no warning. */
    if (/["']shared\/(?!sounds\/)/.test(src)) flags.add("shared");
    for (const api of ["serial", "gpio", "i2c", "ble", "mesh"] as const) {
      if (new RegExp(`orion\\.${api}\\b`).test(src)) flags.add(api);
    }
  }
  return [...flags].sort();
}

/**
 * What the script's head says about it, in the SDK's convention:
 *
 *   -- bricks.lua: a brick breaker with a title screen…   (summary)
 *   -- category: games
 *   -- version: 1.2.0        (optional)
 *   -- api: 0.3.0            (optional: the firmware API it needs)
 *   -- title: Bricks         (optional)
 *   --
 *   -- Keys: arrows move…    (the rest of the comment block: description)
 */
function leggiTesta(src: string) {
  const out = { title: "", summary: "", category: "", version: "", minApi: "", description: "" };
  const righe = src.split(/\r?\n/);
  const desc: string[] = [];
  let i = 0;
  const prima = /^--\s*[\w.-]+\.lua:\s*(.*)$/.exec(righe[0] ?? "");
  if (prima) {
    const parti = [prima[1].trim()];
    /* The summary may continue on the next lines, until a key or a blank comment. */
    for (i = 1; i < righe.length; i++) {
      const m = /^--\s?(.*)$/.exec(righe[i]);
      if (!m || !m[1].trim() || /^\s*(category|version|api|title)\s*:/i.test(m[1])) break;
      parti.push(m[1].trim());
    }
    out.summary = parti.join(" ");
  }
  for (; i < righe.length; i++) {
    const m = /^--\s?(.*)$/.exec(righe[i]);
    if (!m) break;
    const k = /^\s*(category|version|api|title)\s*:\s*(.+)$/i.exec(m[1]);
    if (k) {
      const v = k[2].trim();
      const key = k[1].toLowerCase();
      if (key === "category") out.category = v.toLowerCase();
      else if (key === "version") out.version = v;
      else if (key === "api") out.minApi = v;
      else out.title = v;
      continue;
    }
    desc.push(m[1]);
  }
  out.description = desc.join("\n").replace(/^\n+|\n+$/g, "");
  return out;
}

/** Files of an author's tree that usually do not belong on the card. The
 *  author can tick them back in the form: this is only the default. */
function esclusoDiDefault(p: string): boolean {
  const n = p.split("/").pop()!.toLowerCase();
  return /\.(py|psd|xcf|bak|tmp)$/.test(n) || n === "readme.md" || n === "leggimi.md" || n === "thumbs.db";
}

/**
 * The app's files: the script and its data folder. `exclude`: the data
 * paths the author left out (undefined = the default rule above). `tutti`
 * also lists the excluded ones, for the form.
 */
async function filesOf(luaPath: string, exclude?: string[]): Promise<{
  slug: string;
  files: { path: string; data: Buffer }[];
  tutti: { path: string; size: number; excluded: boolean }[];
  errors: string[];
  warnings: string[];
}> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const nome = basename(luaPath).replace(/\.lua$/i, "");
  const slug = nome.toLowerCase();
  if (!SLUG_RE.test(slug)) {
    errors.push(
      `"${nome}.lua": the file name is the app's name on the card — 2-27 characters, lowercase letters, digits, - and _. Rename the file.`,
    );
  } else if (slug !== nome) {
    warnings.push(`On the card the app will be "${slug}.lua" (lowercase).`);
  }
  const files: { path: string; data: Buffer }[] = [{ path: `${slug}.lua`, data: await readFile(luaPath) }];
  if (files[0].data.length > MAX_MAIN) {
    errors.push(`The script is ${Math.ceil(files[0].data.length / 1024)} KB: the device refuses scripts over 32 KB. Move code into modules under data/.`);
  }

  /* The data folder, in either of the two layouts authors use:
       - the card's (and the emulator's): data/<name>/ next to the script
         (SDK guide, "Sound, images, saving");
       - the SDK examples': a folder with the script's name next to it
         (doom.lua + doom/, wiki.lua + wiki/).
     On the card it is /apps/data/<name>/ either way. */
  const cand = [
    join(dirname(luaPath), "data", nome),
    join(dirname(luaPath), "data", slug),
    join(dirname(luaPath), nome),
    join(dirname(luaPath), slug),
  ];
  let dataDir: string | undefined;
  for (const d of cand) {
    if (existsSync(d) && (await stat(d)).isDirectory()) {
      dataDir = d;
      break;
    }
  }
  const tutti: { path: string; size: number; excluded: boolean }[] = [
    { path: files[0].path, size: files[0].data.length, excluded: false },
  ];
  if (dataDir) {
    const visita = async (dir: string, rel: string[]): Promise<void> => {
      for (const v of await readdir(dir, { withFileTypes: true })) {
        if (v.name.startsWith(".")) continue;
        if (!SEGMENT_RE.test(v.name)) {
          warnings.push(`Skipped "${[...rel, v.name].join("/")}": only letters, digits, . - _ in names.`);
          continue;
        }
        const full = join(dir, v.name);
        if (v.isDirectory()) await visita(full, [...rel, v.name]);
        else if (v.isFile()) {
          const p = ["data", ...rel, v.name].join("/");
          const fuori = exclude ? exclude.includes(p) : esclusoDiDefault(p);
          const data = await readFile(full);
          tutti.push({ path: p, size: data.length, excluded: fuori });
          if (!fuori) files.push({ path: p, data });
        }
      }
    };
    await visita(dataDir, []);
    warnings.push(`Data folder: ${dataDir} → /apps/data/${slug}/ on the card`);
  } else {
    warnings.push(`No data folder (looked for data/${nome}/ and ${nome}/ next to the script): only the script is published.`);
  }
  const total = files.reduce((n, f) => n + f.data.length, 0);
  if (total > MAX_TOTAL) errors.push(`The app is ${(total / 1024 / 1024).toFixed(1)} MB: the store takes up to 4 MB.`);
  if (files.length > MAX_FILES) errors.push(`${files.length} files: the store takes up to ${MAX_FILES}.`);
  return { slug, files, tutti, errors, warnings };
}

export async function readSource(luaPath: string): Promise<StorePublishDraft> {
  const { slug, files, tutti, errors, warnings } = await filesOf(luaPath);
  const t = leggiTesta(files[0].data.toString("utf-8"));
  if (!t.category) warnings.push('No "-- category:" line in the script: choose one below.');
  return {
    luaPath,
    slug,
    title: t.title || slug.charAt(0).toUpperCase() + slug.slice(1).replace(/[_-]/g, " "),
    summary: t.summary.slice(0, 120),
    description: t.description.slice(0, 4000),
    category: t.category,
    version: t.version || "1.0.0",
    changelog: "",
    minApi: t.minApi,
    files: tutti,
    totalSize: files.reduce((n, f) => n + f.data.length, 0),
    flags: flagsOf(files),
    errors,
    warnings,
  };
}

export async function pickSource(): Promise<StorePublishDraft | null> {
  const r = await dialog.showOpenDialog({
    title: "Choose the app to publish (its .lua file)",
    properties: ["openFile"],
    filters: [{ name: "Lua app", extensions: ["lua"] }],
  });
  if (r.canceled || r.filePaths.length === 0) return null;
  return readSource(r.filePaths[0]);
}

export async function publish(req: StorePublishRequest): Promise<StorePublishResponse> {
  /* The files are read again now, not taken from the draft: the author may
     have edited the script since. */
  const { slug, files, errors } = await filesOf(req.luaPath, req.exclude);
  if (errors.length) throw new Error(errors[0]);
  if (slug !== req.manifest.slug) throw new Error("The file was renamed since it was chosen: choose it again.");
  if (req.screenshots.length > MAX_SHOTS) throw new Error(`At most ${MAX_SHOTS} screenshots.`);
  const shots: { b64: string }[] = [];
  for (const p of req.screenshots) {
    const s = await readShot(p);
    if (s.error) throw new Error(`${basename(p)}: ${s.error}`);
    shots.push({ b64: s.data.toString("base64") });
  }
  return call("POST", "/v1/publish", {
    body: {
      manifest: req.manifest,
      files: files.map((f) => ({ path: f.path, b64: f.data.toString("base64") })),
      screenshots: shots,
    },
  });
}

// ---------------------------------------------------------------------------
//  Screenshots
// ---------------------------------------------------------------------------

/* The store server's limits for screenshots. */
const MAX_SHOTS = 5;
const MAX_SHOT = 1024 * 1024;

async function readShot(p: string): Promise<{ data: Buffer; mime: string; error?: string }> {
  const data = await readFile(p);
  const png = data.length > 24 && data.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const jpg = data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (!png && !jpg) return { data, mime: "", error: "only PNG or JPEG images" };
  if (data.length > MAX_SHOT) return { data, mime: "", error: `${(data.length / 1048576).toFixed(1)} MB, the store takes up to 1 MB per image` };
  if (png && (data.readUInt32BE(16) > 4096 || data.readUInt32BE(20) > 4096)) {
    return { data, mime: "", error: "over 4096 pixels per side" };
  }
  return { data, mime: png ? "image/png" : "image/jpeg" };
}

export async function pickScreenshots(): Promise<StoreShotFile[]> {
  const r = await dialog.showOpenDialog({
    title: "Choose screenshots (PNG or JPEG, up to 5)",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }],
  });
  if (r.canceled) return [];
  const out: StoreShotFile[] = [];
  for (const p of r.filePaths) {
    const s = await readShot(p);
    out.push({
      path: p,
      size: s.data.length,
      dataUrl: s.error ? "" : `data:${s.mime};base64,${s.data.toString("base64")}`,
      error: s.error,
    });
  }
  return out;
}

/** A frame captured in the emulator, kept as a PNG file so that it is sent
 *  like any other screenshot (publish() reads files). */
export async function saveCapture(dataUrl: string): Promise<StoreShotFile> {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new Error("Not a PNG capture");
  const dir = join(app.getPath("userData"), "store", "captures");
  await mkdir(dir, { recursive: true });
  const p = join(dir, `capture-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
  await writeFile(p, Buffer.from(m[1], "base64"));
  const s = await readShot(p);
  return { path: p, size: s.data.length, dataUrl: s.error ? "" : dataUrl, error: s.error };
}

/* Approved versions never change: their images are kept for the session.
   A pending one may be withdrawn and published again with the same number,
   so it is always asked anew. */
const shotCache = new Map<string, string>();

export async function screenshot(slug: string, version: string, i: number): Promise<string> {
  const k = `${slug}/${version}/${i}`;
  const c = shotCache.get(k);
  if (c) return c;
  const r = await call<Response>("GET", `/v1/apps/${enc(slug)}/screenshots/${enc(version)}/${i}`, { raw: true });
  const url = `data:${r.headers.get("Content-Type") ?? "image/png"};base64,${Buffer.from(await r.arrayBuffer()).toString("base64")}`;
  if (/public/.test(r.headers.get("Cache-Control") ?? "")) shotCache.set(k, url);
  return url;
}

export const myApps = () => call<{ apps: StoreMyApp[] }>("GET", "/v1/me/apps");
export async function withdraw(id: number): Promise<void> {
  await call("DELETE", `/v1/me/versions/${id}`);
}

// ---------------------------------------------------------------------------
//  Moderation
// ---------------------------------------------------------------------------

export const queue = () => call<{ queue: StoreQueueItem[] }>("GET", "/v1/admin/queue");
export async function decide(req: StoreDecideRequest): Promise<void> {
  await call("POST", `/v1/admin/versions/${req.versionId}`, { body: { action: req.action, reason: req.reason } });
}
export async function setHidden(slug: string, hidden: boolean): Promise<void> {
  await call("POST", `/v1/admin/apps/${enc(slug)}`, { body: { hidden } });
}
export async function hideReview(id: number): Promise<void> {
  await call("POST", `/v1/admin/reviews/${id}`, { body: { hidden: true } });
}
export const reports = () => call<{ reports: StoreReport[] }>("GET", "/v1/admin/reports");
export async function resolveReport(id: number): Promise<void> {
  await call("POST", `/v1/admin/reports/${id}/resolve`);
}
export async function ban(login: string, banned: boolean): Promise<void> {
  await call("POST", `/v1/admin/users/${enc(login)}`, { body: { banned } });
}
