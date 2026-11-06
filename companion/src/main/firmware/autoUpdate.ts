/**
 * Auto-update orchestration for the Orion firmware.
 *
 * Responsibilities:
 *   - Background fetch of the sidecar manifest at
 *     https://orionpda.org/companion/firmware/manifest.json and download
 *     of the .bin it points at.
 *   - On-disk cache under <userData>/firmware-cache/.
 *   - SD trigger writer: drops an empty `DFU` file in the SD root, ejects.
 *   - SD version reader: scans the SD root for `<version>.fwver`.
 *
 * The companion site is behind a CDN that returns the SPA's index HTML
 * for any path that doesn't match a real file (so a 404 looks like 200
 * with `text/html`). We defend against this by requiring the manifest
 * response to either declare a JSON content-type or to start with `{`.
 *
 * Wire format with the firmware (single source of truth, also documented
 * in fw_update.md):
 *   - Version marker: SD root contains exactly one empty file named
 *     `<version>.fwver` (e.g. `1.2.3.fwver`). The firmware re-creates it
 *     on every boot if missing / outdated.
 *   - DFU trigger: companion writes an empty file `DFU` (no extension) at
 *     SD root. Firmware in USB MSC mode polls for this file and, when
 *     found, reboots into the STM32 system bootloader (VID:PID 0483:df11).
 */

import { app } from "electron";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import type {
  FirmwareDfuTriggerRequest,
  FirmwareDfuTriggerResponse,
  FirmwareIntegrityError,
  FirmwareManifest,
  FirmwareSdVersionRequest,
  FirmwareSdVersionResponse,
  FirmwareUpdateState,
} from "../../shared/ipc-types";
import { ejectDevice } from "../ipc/device";

const FIRMWARE_BASE_URL = "https://orionpda.org/companion/firmware/";
const MANIFEST_URL = `${FIRMWARE_BASE_URL}manifest.json`;
const FWVER_EXT = ".fwver";
const DFU_TRIGGER_FILENAME = "DFU";
const FETCH_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
//  In-memory state + listeners
// ---------------------------------------------------------------------------

let state: FirmwareUpdateState = {
  latest: null,
  binCached: false,
  binPath: null,
  fetchError: null,
  integrityError: null,
  fetching: false,
  lastFetchedAt: null,
};

type Listener = (s: FirmwareUpdateState) => void;
const listeners = new Set<Listener>();

export function getUpdateState(): FirmwareUpdateState {
  return state;
}

export function subscribeUpdateState(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function setState(patch: Partial<FirmwareUpdateState>): void {
  state = { ...state, ...patch };
  for (const cb of listeners) {
    try {
      cb(state);
    } catch {
      // ignored
    }
  }
}

// ---------------------------------------------------------------------------
//  Cache layout
// ---------------------------------------------------------------------------

function cacheDir(): string {
  return join(app.getPath("userData"), "firmware-cache");
}

function binPathFor(version: string): string {
  // FAT-friendly filename; version is already a dotted string.
  const safe = version.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(cacheDir(), `firmware-${safe}.bin`);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function sha256OfFile(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(p);
    s.on("data", (chunk) => h.update(chunk));
    s.on("end", () => resolve(h.digest("hex")));
    s.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
//  Directory-listing scan + .bin fetch
// ---------------------------------------------------------------------------

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Natural version compare. Handles `1.2.3` vs `1.2.4` as well as
 *  alphanumeric tags like `01beta` < `02beta` < `02beta2`. Uses
 *  Intl.Collator with `numeric: true` so embedded numbers sort by value
 *  and not lexically. */
function compareVersions(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** Parses the manifest JSON. Required fields: `version` and `file`. */
function parseManifest(raw: unknown): { version: string; file: string;
  size?: number; sha256?: string; releaseDate?: string; notes?: string }
  | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const version =
    typeof o.version === "string" && o.version.trim().length > 0
      ? o.version.trim()
      : null;
  const file =
    typeof o.file === "string" && o.file.trim().length > 0
      ? o.file.trim()
      : null;
  if (!version || !file) return null;
  // Defensive: file must be a simple basename, no scheme, no traversal.
  if (file.includes("..") || /[/\\]/.test(file) || /[:?]/.test(file)) {
    return null;
  }
  return {
    version,
    file,
    size: typeof o.size === "number" ? o.size : undefined,
    sha256: typeof o.sha256 === "string" ? o.sha256 : undefined,
    releaseDate:
      typeof o.releaseDate === "string" ? o.releaseDate : undefined,
    notes: typeof o.notes === "string" ? o.notes : undefined,
  };
}

async function downloadBinTo(
  url: string,
  dst: string,
): Promise<{ size: number; lastModified: string | null }> {
  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  if (!res.body) {
    throw new Error("Empty response body");
  }
  await mkdir(cacheDir(), { recursive: true });
  const tmp = `${dst}.partial`;
  const nodeStream = Readable.fromWeb(res.body as never);
  await pipeline(nodeStream, createWriteStream(tmp));
  const { rename } = await import("node:fs/promises");
  await rename(tmp, dst);
  const s = await stat(dst);
  return {
    size: s.size,
    lastModified: res.headers.get("last-modified"),
  };
}

/** Public: fetch the sidecar manifest + ensure the referenced .bin is
 *  cached locally. */
export async function refreshFirmwareUpdate(): Promise<FirmwareUpdateState> {
  if (state.fetching) return state;
  setState({ fetching: true, fetchError: null });
  try {
    await mkdir(cacheDir(), { recursive: true });

    // 1. Fetch the manifest. The host's SPA fallback returns 200 + HTML
    //    for any unknown path, so we have to defend against that: only
    //    accept responses that either declare JSON or start with `{`.
    const res = await fetchWithTimeout(MANIFEST_URL);
    if (!res.ok) {
      throw new Error(
        `Manifest HTTP ${res.status} ${res.statusText} at ${MANIFEST_URL}`,
      );
    }
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    const body = await res.text();
    const looksJson = ct.includes("json") || body.trimStart().startsWith("{");
    if (!looksJson) {
      // eslint-disable-next-line no-console
      console.warn(
        `[firmware-update] manifest URL returned non-JSON (content-type=${ct}). First 200 chars:\n${body.slice(0, 200)}`,
      );
      throw new Error(
        `Manifest at ${MANIFEST_URL} is not JSON (server returned ${ct || "no content-type"} — likely the SPA fallback). Publish a manifest.json next to the firmware .bin.`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      throw new Error(`Manifest JSON parse error: ${(e as Error).message}`);
    }
    const manifestData = parseManifest(parsed);
    if (!manifestData) {
      throw new Error(
        `Malformed manifest at ${MANIFEST_URL}. Expected {"version":"…","file":"…"}.`,
      );
    }

    // 2. Ensure the .bin is cached locally. We may have to re-download
    //    once if the cached copy fails integrity verification.
    const binUrl = new URL(manifestData.file, FIRMWARE_BASE_URL).toString();
    const targetBin = binPathFor(manifestData.version);
    const expectedSha = manifestData.sha256?.toLowerCase() ?? null;
    let size = manifestData.size;

    const fetchAndVerify = async (): Promise<{ ok: true } | {
      ok: false;
      got: string;
    }> => {
      if (!(await fileExists(targetBin))) {
        const d = await downloadBinTo(binUrl, targetBin);
        if (!size) size = d.size;
      } else {
        const s = await stat(targetBin);
        if (!size) size = s.size;
      }
      if (!expectedSha) return { ok: true };
      const got = (await sha256OfFile(targetBin)).toLowerCase();
      return got === expectedSha ? { ok: true } : { ok: false, got };
    };

    let verdict = await fetchAndVerify();
    if (verdict.ok === false) {
      // Discard the cached copy and try one more time — could be a
      // truncated download or transient CDN corruption.
      // eslint-disable-next-line no-console
      console.warn(
        `[firmware-update] sha256 mismatch on cached ${targetBin} ` +
          `(expected ${expectedSha}, got ${verdict.got}); retrying download once`,
      );
      await rm(targetBin, { force: true });
      verdict = await fetchAndVerify();
    }
    if (verdict.ok === false) {
      // Persistent corruption. Delete the bad file, surface to the UI
      // via integrityError, and fail the refresh.
      await rm(targetBin, { force: true });
      const err: FirmwareIntegrityError = {
        version: manifestData.version,
        expected: expectedSha ?? "",
        got: verdict.got,
        sourceUrl: binUrl,
        whenIso: new Date().toISOString(),
      };
      setState({
        binCached: false,
        binPath: null,
        integrityError: err,
        fetchError: `sha256 mismatch on firmware ${manifestData.version}`,
        fetching: false,
      });
      // eslint-disable-next-line no-console
      console.warn(
        `[firmware-update] integrity check failed for ${manifestData.version}: expected ${err.expected}, got ${err.got}`,
      );
      return state;
    }

    const manifest: FirmwareManifest = {
      version: manifestData.version,
      url: binUrl,
      size,
      sha256: manifestData.sha256,
      releaseDate: manifestData.releaseDate,
      notes: manifestData.notes,
    };

    setState({
      latest: manifest,
      binCached: true,
      binPath: targetBin,
      fetchError: null,
      // A successful verified download clears any prior integrity error.
      integrityError: null,
      fetching: false,
      lastFetchedAt: new Date().toISOString(),
    });

    // 3. GC older cached .bin (keep only latest).
    void gcOldBins(manifest.version);

    // eslint-disable-next-line no-console
    console.log(
      `[firmware-update] latest=${manifest.version} cached at ${targetBin}`,
    );
    return state;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[firmware-update] fetch from ${MANIFEST_URL} failed:`,
      (err as Error).message,
    );
    setState({
      fetchError: (err as Error).message,
      fetching: false,
    });
    return state;
  }
}

/** Renderer hook: clear the integrity error after the popup is shown. */
export function ackIntegrityError(): FirmwareUpdateState {
  if (state.integrityError) setState({ integrityError: null });
  return state;
}

async function gcOldBins(keepVersion: string): Promise<void> {
  try {
    const entries = await readdir(cacheDir());
    const keepName = `firmware-${keepVersion.replace(/[^a-zA-Z0-9._-]/g, "_")}.bin`;
    for (const e of entries) {
      if (!e.endsWith(".bin")) continue;
      if (e === keepName) continue;
      await rm(join(cacheDir(), e), { force: true });
    }
  } catch {
    // ignored
  }
}

/** Scan the cache dir for the highest `<version>.bin` already on disk.
 *  Files we wrote are named `firmware-<version>.bin` (see binPathFor)
 *  so we strip that prefix to recover the original version string. */
async function loadCachedLatest(): Promise<FirmwareManifest | null> {
  let entries: string[] = [];
  try {
    entries = await readdir(cacheDir());
  } catch {
    return null;
  }
  let bestVer = "";
  let bestName = "";
  for (const e of entries) {
    if (!e.toLowerCase().endsWith(".bin")) continue;
    const basename = e.slice(0, -4);
    const version = basename.replace(/^firmware[-_]?/i, "");
    if (!version) continue;
    if (!bestVer || compareVersions(version, bestVer) > 0) {
      bestVer = version;
      bestName = e;
    }
  }
  if (!bestVer) return null;
  const path = join(cacheDir(), bestName);
  let size: number | undefined;
  try {
    size = (await stat(path)).size;
  } catch {
    return null;
  }
  return {
    version: bestVer,
    url: new URL(bestName, FIRMWARE_BASE_URL).toString(),
    size,
  };
}

/** Boot-time hydrate: load whatever's already cached, then kick off refresh. */
export async function initFirmwareUpdate(): Promise<void> {
  const cached = await loadCachedLatest();
  if (cached) {
    setState({
      latest: cached,
      binCached: true,
      binPath: binPathFor(cached.version),
    });
  }
  // Fire and forget; UI gets updates via the state listeners.
  void refreshFirmwareUpdate();
}

// ---------------------------------------------------------------------------
//  SD version reader
// ---------------------------------------------------------------------------

export async function readSdVersion(
  req: FirmwareSdVersionRequest,
): Promise<FirmwareSdVersionResponse> {
  const entries = await readdir(req.mountPath).catch(() => [] as string[]);
  for (const e of entries) {
    if (!e.toLowerCase().endsWith(FWVER_EXT)) continue;
    // basename without extension is the version
    const base = e.slice(0, e.length - FWVER_EXT.length);
    if (base.length > 0) return { version: base };
  }
  return { version: null };
}

// ---------------------------------------------------------------------------
//  DFU trigger (write file + eject)
// ---------------------------------------------------------------------------

export async function triggerDfu(
  req: FirmwareDfuTriggerRequest,
): Promise<FirmwareDfuTriggerResponse> {
  const triggerPath = join(req.mountPath, DFU_TRIGGER_FILENAME);
  try {
    await writeFile(triggerPath, "", "utf8");
  } catch (e) {
    return {
      ok: false,
      ejected: false,
      message: `Cannot write DFU trigger: ${(e as Error).message}`,
    };
  }

  // Best-effort fsync via fs.open(...).sync()
  try {
    const { open } = await import("node:fs/promises");
    const fh = await open(triggerPath, "r+");
    await fh.sync();
    await fh.close();
  } catch {
    // not fatal — many filesystems don't honor fsync from userspace anyway.
  }

  // Now eject the volume so the firmware re-acquires the SD bus.
  const ejectRes = await ejectDevice({ mountPath: req.mountPath });
  return {
    ok: true,
    ejected: ejectRes.ok,
    message: ejectRes.ok
      ? "DFU trigger written, volume ejected."
      : `DFU trigger written but eject failed: ${ejectRes.message ?? "unknown"}`,
  };
}
