/**
 * Storage breakdown del device.
 *
 *  - Capienza totale / libera lette da `fs.statfs` sul mount (Node 18+).
 *  - Per ogni categoria conosciuta cerchiamo una cartella case-insensitive
 *    nella root del mount e ne sommiamo i file ricorsivamente.
 *  - `other` = usedBytes - somma(categorie note). Comprende ebooks, file di
 *    sistema FAT, file dell'utente fuori dalle cartelle riconosciute, ecc.
 *
 *  Tutto è I/O bound: walk veloce con readdir(withFileTypes) + stat sequenziale
 *  per evitare di esaurire i file descriptor su SD lente. Per device tipici
 *  (16 GB con pochi GB occupati) il walk completo è < 1 s.
 */

import { readdir, stat, statfs } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  DeviceStorageRequest,
  DeviceStorageResponse,
} from "../../shared/ipc-types";

interface CategorySpec {
  key: "notes" | "memos" | "music" | "video";
  /** Nomi possibili della cartella (case-insensitive). */
  names: string[];
}

const CATEGORIES: CategorySpec[] = [
  { key: "notes", names: ["NOTE", "notes"] },
  { key: "memos", names: ["MEMO", "memos", "voice", "VOICE"] },
  { key: "music", names: ["music", "MUSIC"] },
  { key: "video", names: ["video", "VIDEO"] },
];

async function findFolderCi(
  root: string,
  candidates: string[],
): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const lower = candidates.map((n) => n.toLowerCase());
  for (const e of entries) {
    if (e.isDirectory() && lower.includes(e.name.toLowerCase())) {
      return join(root, e.name);
    }
  }
  return null;
}

async function dirSize(path: string): Promise<number> {
  let total = 0;
  const stack: string[] = [path];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries;
    try {
      entries = await readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      // Skip dotfiles e cose tipo .Spotlight-V100 / .Trashes / .fseventsd
      // su mount macOS che gonfiano artificialmente.
      if (e.name.startsWith(".")) continue;
      const full = join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile()) {
        try {
          const s = await stat(full);
          total += s.size;
        } catch {
          // file scomparso / permission denied: salta
        }
      }
    }
  }
  return total;
}

export async function getDeviceStorage(
  req: DeviceStorageRequest,
): Promise<DeviceStorageResponse> {
  if (!req.mountPath || !existsSync(req.mountPath)) {
    throw new Error(`mountPath inesistente: ${req.mountPath}`);
  }

  // Total / free dal filesystem
  const fsStats = await statfs(req.mountPath);
  const totalBytes = fsStats.bsize * fsStats.blocks;
  const freeBytes = fsStats.bsize * fsStats.bavail;
  const usedBytes = Math.max(0, totalBytes - freeBytes);

  // Walk categorie in parallelo
  const sizes = await Promise.all(
    CATEGORIES.map(async (c) => {
      const folder = await findFolderCi(req.mountPath, c.names);
      const bytes = folder ? await dirSize(folder) : 0;
      return [c.key, bytes] as const;
    }),
  );

  const breakdown = {
    notes: 0,
    memos: 0,
    music: 0,
    video: 0,
    other: 0,
  };
  for (const [k, v] of sizes) breakdown[k] = v;

  const categorized = breakdown.notes + breakdown.memos + breakdown.music + breakdown.video;
  breakdown.other = Math.max(0, usedBytes - categorized);

  return { totalBytes, freeBytes, usedBytes, breakdown };
}
