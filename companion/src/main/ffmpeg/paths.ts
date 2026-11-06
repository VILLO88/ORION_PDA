/**
 * Risoluzione del path di `ffmpeg` / `ffprobe` per platform.
 *
 * Strategia (in ordine), identica al pattern usato da `firmware/paths.ts`
 * per `dfu-util`:
 *
 *  1. Bundle pacchettizzato: `process.resourcesPath/ffmpeg/<plat>/<bin>`
 *  2. Dev (electron-vite, non packaged): `src/main/resources/ffmpeg/<plat>/<bin>`
 *  3. Fallback: `ffmpeg` (o `ffmpeg.exe`) preso dal PATH del sistema.
 *
 * Il fallback evita di bloccare lo sviluppo se non hai ancora copiato i
 * binari bundle dentro `src/main/resources/ffmpeg/`. Per le release di
 * produzione (electron-builder) devono essere presenti tutti e quattro i
 * platform target, altrimenti `which` su una macchina utente senza
 * homebrew/apt fallirà con "ffmpeg not found".
 */

import { app } from "electron";
import { existsSync } from "node:fs";
import { arch as nodeArch, platform as nodePlatform } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

type FfBin = "ffmpeg" | "ffprobe";

function platformKey(): string {
  const p = nodePlatform();
  if (p === "darwin") {
    return nodeArch() === "arm64" ? "darwin-arm64" : "darwin-x64";
  }
  if (p === "win32") return "win32-x64";
  if (p === "linux") return "linux-x64";
  return `${p}-${nodeArch()}`;
}

function binaryName(bin: FfBin): string {
  return nodePlatform() === "win32" ? `${bin}.exe` : bin;
}

/** Path comuni dove cercare binari quando l'app è launchata da Finder.
 *  Su macOS le GUI app non ereditano PATH della shell. */
function wellKnownPaths(name: string): string[] {
  const p = nodePlatform();
  if (p === "darwin") {
    return [
      `/opt/homebrew/bin/${name}`,
      `/usr/local/bin/${name}`,
      `/usr/bin/${name}`,
      `/opt/local/bin/${name}`,
    ];
  }
  if (p === "linux") {
    return [
      `/usr/bin/${name}`,
      `/usr/local/bin/${name}`,
      `/snap/bin/${name}`,
    ];
  }
  return [];
}

function tryPathOnSystem(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    const isWin = nodePlatform() === "win32";
    const cmd = isWin ? "where" : "which";
    let out = "";
    const p = spawn(cmd, [name]);
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.on("error", () => resolve(checkWellKnown()));
    p.on("close", (code) => {
      if (code !== 0) return resolve(checkWellKnown());
      const first = out.split(/\r?\n/).find((s) => s.trim().length > 0);
      resolve(first ? first.trim() : checkWellKnown());
    });
  });

  function checkWellKnown(): string | null {
    for (const p of wellKnownPaths(name)) {
      if (existsSync(p)) return p;
    }
    return null;
  }
}

const cache = new Map<FfBin, string | null>();

async function resolveBin(bin: FfBin): Promise<string | null> {
  if (cache.has(bin)) return cache.get(bin) ?? null;

  const fname = binaryName(bin);
  const plat = platformKey();

  if (app.isPackaged) {
    const p = join(process.resourcesPath, "ffmpeg", plat, fname);
    if (existsSync(p)) {
      cache.set(bin, p);
      return p;
    }
  } else {
    const devPath = resolve(
      __dirname,
      "..",
      "..",
      "src",
      "main",
      "resources",
      "ffmpeg",
      plat,
      fname,
    );
    if (existsSync(devPath)) {
      cache.set(bin, devPath);
      return devPath;
    }
  }

  const onPath = await tryPathOnSystem(fname);
  cache.set(bin, onPath);
  return onPath;
}

/** Ritorna il path eseguibile di ffmpeg, oppure `null` se non trovato.
 *  In pratica i call site assumono la presenza e lasciano fallire lo
 *  `spawn` con ENOENT, che produce un errore visibile all'utente. */
export async function getFfmpegPath(): Promise<string | null> {
  return resolveBin("ffmpeg");
}

export async function getFfprobePath(): Promise<string | null> {
  return resolveBin("ffprobe");
}

/** Variante sincrona "best effort" per i call site che oggi fanno
 *  `spawn("ffmpeg", ...)` direttamente senza await. Restituisce il path
 *  del bundle/dev se esiste, altrimenti la stringa "ffmpeg" che lascia
 *  fare lookup PATH allo spawn nativo (comportamento attuale). */
export function getFfmpegPathSync(): string {
  return resolveBinSync("ffmpeg");
}

export function getFfprobePathSync(): string {
  return resolveBinSync("ffprobe");
}

function resolveBinSync(bin: FfBin): string {
  const cached = cache.get(bin);
  if (cached) return cached;

  const fname = binaryName(bin);
  const plat = platformKey();

  if (app.isPackaged) {
    const p = join(process.resourcesPath, "ffmpeg", plat, fname);
    if (existsSync(p)) {
      cache.set(bin, p);
      return p;
    }
  } else {
    const devPath = resolve(
      __dirname,
      "..",
      "..",
      "src",
      "main",
      "resources",
      "ffmpeg",
      plat,
      fname,
    );
    if (existsSync(devPath)) {
      cache.set(bin, devPath);
      return devPath;
    }
  }

  // Sync fallback: prova i path "ben conosciuti" prima di delegare allo
  // spawn nativo. Necessario per le GUI app macOS che non ereditano $PATH.
  for (const p of wellKnownPaths(fname)) {
    if (existsSync(p)) {
      cache.set(bin, p);
      return p;
    }
  }
  return fname;
}

export function resetFfmpegPathCache(): void {
  cache.clear();
}
