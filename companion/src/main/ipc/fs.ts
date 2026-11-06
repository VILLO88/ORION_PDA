/**
 * Filesystem helpers esposti al renderer: walk ricorsivo per raccogliere
 * file audio, directory picker nativo, stat directory.
 */

import { dialog } from "electron";
import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";

const AUDIO_EXT = new Set([
  ".mp3", ".flac", ".wav", ".m4a", ".aac",
  ".ogg", ".opus", ".wma", ".aif", ".aiff", ".mp4", ".mka",
]);

function isAudioFile(p: string): boolean {
  return AUDIO_EXT.has(extname(p).toLowerCase());
}

/** Walk ricorsivo; salta dotfiles e dotdirs. */
async function walk(dir: string, acc: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await walk(full, acc);
    } else if (e.isFile() && isAudioFile(full)) {
      acc.push(full);
    }
  }
}

export async function expandAudioPaths(paths: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of paths) {
    let s;
    try {
      s = await stat(p);
    } catch {
      continue;
    }
    if (s.isFile()) {
      if (isAudioFile(p)) out.push(p);
    } else if (s.isDirectory()) {
      await walk(p, out);
    }
  }
  // Ordine alfabetico stabile cross-platform.
  out.sort((a, b) => a.localeCompare(b));
  // Deduplica (utile se l'utente trascina sia parent che child).
  return Array.from(new Set(out));
}

export async function chooseDirectory(): Promise<string | null> {
  const r = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
    title: "Select folder",
  });
  if (r.canceled || r.filePaths.length === 0) return null;
  return r.filePaths[0];
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}
