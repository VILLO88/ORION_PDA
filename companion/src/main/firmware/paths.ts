/**
 * Risoluzione del path di `dfu-util` per platform.
 *
 * Strategia (in ordine):
 *  1. Bundle pacchettizzato: `process.resourcesPath/dfu-util/<plat>/<bin>`
 *  2. Dev (electron-vite, non packaged): `src/main/resources/dfu-util/<plat>/<bin>`
 *  3. Fallback: `dfu-util` (o `dfu-util.exe`) preso dal PATH del sistema.
 *
 * Il fallback evita di bloccare lo sviluppo se non hai ancora copiato i
 * binari bundle dentro `src/main/resources/`. Per le release di produzione
 * (electron-builder) devono comunque essere presenti tutti e quattro.
 */

import { app } from "electron";
import { existsSync } from "node:fs";
import { arch as nodeArch, platform as nodePlatform } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

function platformKey(): string {
  const p = nodePlatform();
  if (p === "darwin") {
    return nodeArch() === "arm64" ? "darwin-arm64" : "darwin-x64";
  }
  if (p === "win32") return "win32-x64";
  if (p === "linux") return "linux-x64";
  return `${p}-${nodeArch()}`;
}

function binaryName(): string {
  return nodePlatform() === "win32" ? "dfu-util.exe" : "dfu-util";
}

/** Path comuni dove cercare binari quando l'app è launchata da Finder (su
 *  macOS le GUI app NON ereditano il PATH della shell, quindi /opt/homebrew/bin
 *  non è visibile a `which`). */
function wellKnownPaths(name: string): string[] {
  const p = nodePlatform();
  if (p === "darwin") {
    return [
      `/opt/homebrew/bin/${name}`,   // Apple Silicon homebrew
      `/usr/local/bin/${name}`,      // Intel homebrew / legacy
      `/usr/bin/${name}`,
      `/opt/local/bin/${name}`,      // MacPorts
    ];
  }
  if (p === "linux") {
    return [
      `/usr/bin/${name}`,
      `/usr/local/bin/${name}`,
      `/snap/bin/${name}`,
    ];
  }
  if (p === "win32") {
    // win32 GUI app eredita PATH dal registro di sistema, `where` di solito
    // funziona; ma includiamo qualche default come safety net.
    return [
      `C:\\Program Files\\dfu-util\\${name}`,
      `C:\\Program Files (x86)\\dfu-util\\${name}`,
    ];
  }
  return [];
}

function tryPathOnSystem(name: string): Promise<string | null> {
  // `which` o `where` per trovare il binario nel PATH.
  return new Promise((resolve) => {
    const isWin = nodePlatform() === "win32";
    const cmd = isWin ? "where" : "which";
    const args = [name];
    let out = "";
    const p = spawn(cmd, args);
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.on("error", () => resolve(null));
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

let cached: string | null | undefined;

export async function getDfuUtilPath(): Promise<string | null> {
  if (cached !== undefined) return cached;
  const bin = binaryName();
  const plat = platformKey();

  // 1. Bundle pacchettizzato
  if (app.isPackaged) {
    const p = join(process.resourcesPath, "dfu-util", plat, bin);
    if (existsSync(p)) {
      cached = p;
      return p;
    }
  } else {
    // 2. Dev: src/main/resources/dfu-util/<plat>/<bin>
    // __dirname in dev punta a out/main/, quindi risali due livelli.
    const devPath = resolve(
      __dirname,
      "..",
      "..",
      "src",
      "main",
      "resources",
      "dfu-util",
      plat,
      bin,
    );
    if (existsSync(devPath)) {
      cached = devPath;
      return devPath;
    }
  }

  // 3. PATH di sistema (fallback per sviluppo)
  const onPath = await tryPathOnSystem(bin);
  cached = onPath;
  return onPath;
}

export function resetDfuPathCache(): void {
  cached = undefined;
}
