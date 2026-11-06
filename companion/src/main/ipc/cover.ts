/**
 * Album cover art → `cover.bin` 1bpp 200×200 per il player del firmware.
 *
 * Pipeline:
 *   1. Estrazione della cover art embedded dal primo brano che ne ha una
 *      (ffmpeg legge l'attached_pic come stream video e la ricodifica in PNG).
 *   2. Decode con jimp, grayscale, fit-in-200×200 preservando l'aspect e
 *      padding bianco (scaleToFit + composite su canvas bianco).
 *   3. Floyd–Steinberg + threshold → bit-pack MSB-first 1bpp.
 *
 * Output: esattamente 5000 byte (25 byte/riga × 200 righe), nessun header.
 * Convenzione bit: bit=1 → pixel chiaro (bianco), bit=0 → nero. Identica al
 * framebuffer Sharp / alle immagini ebook PDAR → il firmware fa blit diretto.
 */

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import Jimp from "jimp";
import { getFfmpegPathSync, getFfprobePathSync } from "../ffmpeg/paths";
import type {
  CoverCandidate,
  CoverSuggestRequest,
  CoverSuggestResponse,
} from "../../shared/ipc-types";

export const COVER_SIZE = 200;
export const COVER_FILENAME = "cover.bin";
const ROW_BYTES = COVER_SIZE / 8; // 25
const COVER_BYTES = ROW_BYTES * COVER_SIZE; // 5000
const THRESHOLD = 128;

/** Estrae la prima cover art embedded da un file audio come PNG (Buffer).
 *  Ritorna null se il file non ha immagine allegata o l'estrazione fallisce. */
export function extractEmbeddedCover(sourcePath: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const args = [
      "-v", "error",
      "-i", sourcePath,
      "-an", // niente audio
      "-map", "0:v:0?", // primo stream video (= attached_pic); "?" = opzionale
      "-frames:v", "1",
      "-vcodec", "png",
      "-f", "image2pipe",
      "pipe:1",
    ];
    let proc;
    try {
      proc = spawn(getFfmpegPathSync(), args);
    } catch {
      return resolve(null);
    }
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (d: Buffer) => chunks.push(d));
    proc.on("error", () => resolve(null));
    proc.on("close", (code) => {
      if (code === 0 && chunks.length > 0) {
        const buf = Buffer.concat(chunks);
        resolve(buf.length > 0 ? buf : null);
      } else {
        resolve(null);
      }
    });
  });
}

/** Dithera un'immagine (Buffer PNG/JPG/…) in 200×200 1bpp packed (5000 byte). */
export async function ditherCover(buf: Buffer): Promise<Buffer> {
  const img = await Jimp.read(buf);
  img.greyscale();
  // Scala dentro 200×200 preservando l'aspect (nessun crop).
  img.scaleToFit(COVER_SIZE, COVER_SIZE, Jimp.RESIZE_BILINEAR);

  // Canvas bianco opaco 200×200, ci centriamo sopra l'immagine: il padding
  // (se l'immagine non è quadrata) resta bianco.
  const canvas = new Jimp(COVER_SIZE, COVER_SIZE, 0xffffffff);
  const ox = Math.floor((COVER_SIZE - img.bitmap.width) / 2);
  const oy = Math.floor((COVER_SIZE - img.bitmap.height) / 2);
  canvas.composite(img, ox, oy);

  // Float32 di lavoro per error diffusion senza saturazione precoce.
  const work = new Float32Array(COVER_SIZE * COVER_SIZE);
  for (let i = 0; i < work.length; i++) {
    work[i] = canvas.bitmap.data[i * 4]; // R channel (g=b=r dopo greyscale)
  }

  const out = Buffer.alloc(COVER_BYTES); // zero-filled → bit=0 = nero
  for (let y = 0; y < COVER_SIZE; y++) {
    for (let x = 0; x < COVER_SIZE; x++) {
      const idx = y * COVER_SIZE + x;
      const old = work[idx];
      const clamped = old < 0 ? 0 : old > 255 ? 255 : old;
      const isWhite = clamped >= THRESHOLD;
      const err = clamped - (isWhite ? 255 : 0);

      if (isWhite) {
        out[y * ROW_BYTES + (x >> 3)] |= 0x80 >> (x & 7);
      }

      // Floyd–Steinberg
      if (x + 1 < COVER_SIZE) work[idx + 1] += (err * 7) / 16;
      if (y + 1 < COVER_SIZE) {
        if (x > 0) work[idx + COVER_SIZE - 1] += (err * 3) / 16;
        work[idx + COVER_SIZE] += (err * 5) / 16;
        if (x + 1 < COVER_SIZE) work[idx + COVER_SIZE + 1] += (err * 1) / 16;
      }
    }
  }
  return out;
}

/** Cerca la prima cover art embedded tra `sources`, la dithera a 200×200 e la
 *  scrive come `<targetDir>/cover.bin`. Best-effort: ritorna il path scritto,
 *  oppure null se nessun brano ha una cover (o l'immagine è indecodificabile).
 *  Non solleva mai: i fallimenti vengono ignorati per non bloccare il batch. */
export async function writeAlbumCover(
  targetDir: string,
  sources: string[],
): Promise<string | null> {
  for (const src of sources) {
    let raw: Buffer | null;
    try {
      raw = await extractEmbeddedCover(src);
    } catch {
      raw = null;
    }
    if (!raw) continue;
    try {
      const packed = await ditherCover(raw);
      const outPath = join(targetDir, COVER_FILENAME);
      await writeFile(outPath, packed);
      return outPath;
    } catch {
      // Immagine non decodificabile: prova il brano successivo.
      continue;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
//  Lettura tag + ricerca online (iTunes Search API)
// ---------------------------------------------------------------------------

interface TrackTags {
  artist: string;
  album: string;
}

/** Legge artista/album dai tag del file via ffprobe. Campi mancanti = "". */
function probeTrackTags(sourcePath: string): Promise<TrackTags> {
  return new Promise((resolve) => {
    const args = [
      "-v", "error",
      "-print_format", "json",
      "-show_entries", "format_tags=artist,album,album_artist,ALBUM,ARTIST",
      sourcePath,
    ];
    let out = "";
    let proc;
    try {
      proc = spawn(getFfprobePathSync(), args);
    } catch {
      return resolve({ artist: "", album: "" });
    }
    proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
    proc.on("error", () => resolve({ artist: "", album: "" }));
    proc.on("close", () => {
      try {
        const j = JSON.parse(out) as {
          format?: { tags?: Record<string, string> };
        };
        const t = j.format?.tags ?? {};
        // Le chiavi dei tag possono variare per case/formato: normalizziamo.
        const lower: Record<string, string> = {};
        for (const [k, v] of Object.entries(t)) lower[k.toLowerCase()] = v;
        const artist = (lower["album_artist"] || lower["artist"] || "").trim();
        const album = (lower["album"] || "").trim();
        resolve({ artist, album });
      } catch {
        resolve({ artist: "", album: "" });
      }
    });
  });
}

/** Eleva la risoluzione dell'artworkUrl100 iTunes (…/100x100bb.jpg →
 *  …/600x600bb.jpg). Robusto: se il pattern non c'è ritorna l'originale. */
function hiResArtwork(url100: string): string {
  return url100.replace(/\/\d+x\d+bb\.(jpg|png)$/i, "/600x600bb.$1");
}

/** Interroga la iTunes Search API per copertine di album. Best-effort:
 *  ritorna [] su errore di rete o risposta non valida. */
export async function searchItunesCovers(
  term: string,
  limit = 8,
): Promise<CoverCandidate[]> {
  const q = term.trim();
  if (!q) return [];
  const url =
    "https://itunes.apple.com/search?" +
    new URLSearchParams({
      term: q,
      entity: "album",
      media: "music",
      limit: String(limit),
    }).toString();
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      results?: Array<{
        collectionId?: number;
        collectionName?: string;
        artistName?: string;
        artworkUrl100?: string;
        primaryGenreName?: string;
      }>;
    };
    const raw = (data.results ?? []).filter((r) => r.artworkUrl100);
    // Scarichiamo le miniature lato main e le restituiamo come data URL: la CSP
    // del renderer (img-src 'self' data: blob:) blocca gli URL https remoti.
    const out = await Promise.all(
      raw.map(async (r): Promise<CoverCandidate> => {
        const url100 = r.artworkUrl100 as string;
        const buf = await downloadImage(url100);
        const thumbUrl = buf
          ? `data:image/jpeg;base64,${buf.toString("base64")}`
          : url100;
        return {
          id: String(r.collectionId ?? `${r.artistName}-${r.collectionName}`),
          title: r.collectionName ?? "",
          artist: r.artistName ?? "",
          genre: r.primaryGenreName ?? "",
          thumbUrl,
          imageUrl: hiResArtwork(url100),
        };
      }),
    );
    return out;
  } catch {
    return [];
  }
}

/** Scarica un'immagine da URL come Buffer. Null su errore. */
async function downloadImage(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

/** Scarica l'immagine all'URL dato, la dithera a 200×200 e la scrive come
 *  cover.bin in targetDir. Ritorna il path scritto o null. */
export async function writeCoverFromUrl(
  targetDir: string,
  url: string,
): Promise<string | null> {
  const raw = await downloadImage(url);
  if (!raw) return null;
  try {
    const packed = await ditherCover(raw);
    const outPath = join(targetDir, COVER_FILENAME);
    await writeFile(outPath, packed);
    return outPath;
  } catch {
    return null;
  }
}

/** Estrae la prima cover embedded e la restituisce come data URL PNG ridotto
 *  (per l'anteprima nel picker). Null se nessun brano ha art. */
async function embeddedThumbDataUrl(
  sources: string[],
): Promise<string | undefined> {
  for (const src of sources) {
    const raw = await extractEmbeddedCover(src).catch(() => null);
    if (!raw) continue;
    try {
      const img = await Jimp.read(raw);
      img.scaleToFit(160, 160, Jimp.RESIZE_BILINEAR);
      const b64 = await img.getBase64Async(Jimp.MIME_PNG);
      return b64;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Suggerisce copertine: legge i tag del primo brano, costruisce il termine di
 *  ricerca e interroga iTunes; include anche la thumbnail embedded se presente. */
export async function suggestCovers(
  req: CoverSuggestRequest,
): Promise<CoverSuggestResponse> {
  const sources = req.sourcePaths.filter(Boolean);
  let tags: TrackTags = { artist: "", album: "" };
  for (const s of sources) {
    tags = await probeTrackTags(s);
    if (tags.artist || tags.album) break;
  }
  const album = (tags.album || req.albumHint || "").trim();
  const artist = tags.artist.trim();
  const term = [artist, album].filter(Boolean).join(" ").trim();

  const [results, embeddedThumb] = await Promise.all([
    term ? searchItunesCovers(term) : Promise.resolve([]),
    embeddedThumbDataUrl(sources),
  ]);

  return { artist, album, term, results, embeddedThumb };
}
