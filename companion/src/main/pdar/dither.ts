/**
 * Image → bitmap 1bpp via Floyd–Steinberg dithering.
 *
 * Pipeline:
 *  1. Decode con jimp (PNG/JPG/GIF/BMP, pure JS).
 *  2. Resize preservando aspect, max 528×256 (display Sharp ROT_90 con
 *     spazio per testo intorno). Width snap a multiplo di 8 per blit
 *     byte-aligned nel firmware.
 *  3. Conversione grayscale (R = G = B post-greyscale, prendiamo R).
 *  4. Error diffusion Floyd–Steinberg sul grayscale 8-bit.
 *  5. Threshold + bit-pack MSB-first → 1bpp coerente col framebuffer Sharp.
 *
 * Convenzione bit: bit=1 → pixel chiaro (LC OFF, schermo bianco normally-white),
 * bit=0 → pixel nero. Stessa del framebuffer del firmware (sharp_ls032.c).
 */

import Jimp from "jimp";
import type { DitheredImage } from "./format";
import { IMAGE_MAX_W, IMAGE_MAX_H } from "./format";

const DEFAULT_MAX_W = IMAGE_MAX_W;      // 528 px, multiplo di 8 per blit allineato
const DEFAULT_MAX_H = IMAGE_MAX_H;      // 256 px, lascia spazio al testo

export interface DitherOptions {
  /** Larghezza massima (px). Default = display width 336. */
  maxWidth?: number;
  /** Altezza massima (px). Default 400. */
  maxHeight?: number;
  /** Soglia 0..255 per la decisione di clamp pre-diffusione. Default 128. */
  threshold?: number;
}

export async function ditherImage(
  buf: Buffer,
  opts: DitherOptions = {},
): Promise<DitheredImage> {
  const maxW = opts.maxWidth ?? DEFAULT_MAX_W;
  const maxH = opts.maxHeight ?? DEFAULT_MAX_H;
  const threshold = opts.threshold ?? 128;

  const img = await Jimp.read(buf);

  // Resize preservando aspect
  let w = img.bitmap.width;
  let h = img.bitmap.height;
  const aspect = w / h;
  if (w > maxW) {
    w = maxW;
    h = Math.max(1, Math.round(w / aspect));
  }
  if (h > maxH) {
    h = maxH;
    w = Math.max(1, Math.round(h * aspect));
  }
  // Width snap a multiplo di 8 (vincolo del firmware: blit byte-aligned).
  // Arrotondamento verso il basso, mai oltre maxW. Min 8.
  w = Math.max(8, Math.floor(w / 8) * 8);
  if (w > maxW) w = Math.floor(maxW / 8) * 8;
  if (w !== img.bitmap.width || h !== img.bitmap.height) {
    img.resize(w, h, Jimp.RESIZE_BILINEAR);
  }
  img.greyscale();

  // Buffer di lavoro in Float32 per error diffusion senza saturazione precoce.
  const work = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    work[i] = img.bitmap.data[i * 4]; // R channel (g=b=r dopo greyscale)
  }

  const rowBytes = Math.ceil(w / 8);
  const pixels = Buffer.alloc(rowBytes * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const old = work[idx];
      const clamped = old < 0 ? 0 : old > 255 ? 255 : old;
      const isWhite = clamped >= threshold;
      const newVal = isWhite ? 255 : 0;
      const err = clamped - newVal;

      if (isWhite) {
        pixels[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
      }

      // Floyd–Steinberg
      if (x + 1 < w) work[idx + 1] += (err * 7) / 16;
      if (y + 1 < h) {
        if (x > 0) work[idx + w - 1] += (err * 3) / 16;
        work[idx + w] += (err * 5) / 16;
        if (x + 1 < w) work[idx + w + 1] += (err * 1) / 16;
      }
    }
  }

  return { width: w, height: h, pixels };
}
