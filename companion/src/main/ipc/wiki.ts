/**
 * Wikipedia for ORION: the IPC side of src/main/wiki. One conversion at a
 * time; it runs in the main process and yields every few hundred articles,
 * like the ebook converter.
 */
import { statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import { converti, leggiInfo } from "../wiki/converti";
import type {
  WikiConvertRequest,
  WikiConvertResponse,
  WikiInfoResponse,
  WikiProgressEvent,
} from "../../shared/ipc-types";

let annulla = false;
let inCorso = false;

export function wikiInfo(zimPath: string): WikiInfoResponse {
  return { ...leggiInfo(zimPath), dimensione: statSync(zimPath).size };
}

/** Free bytes where the folder would go, or -1 if it cannot be told. */
export function wikiSpazio(dir: string): number {
  try {
    const s = statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return -1;
  }
}

/** A name FAT32 takes and wiki.lua finds: letters, digits, _ and -. */
function nomeSicuro(n: string): string {
  return n.trim().replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40) || "wiki";
}

export async function wikiConvert(
  req: WikiConvertRequest,
  emit: (ev: WikiProgressEvent) => void,
): Promise<WikiConvertResponse> {
  if (inCorso) throw new Error("a conversion is already running");
  const base = req.mountPath ? join(req.mountPath, "wiki") : req.localOutDir;
  if (!base) throw new Error("no destination");
  const outputPath = join(base, nomeSicuro(req.nome));
  inCorso = true;
  annulla = false;
  try {
    const r = await converti(req.zimPath, outputPath, emit, () => annulla);
    return { outputPath, ...r };
  } finally {
    inCorso = false;
  }
}

export function wikiCancel(): void {
  annulla = true;
}
