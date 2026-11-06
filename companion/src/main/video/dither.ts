/**
 * Per-frame dithering del video pipeline.
 *
 * Lavora su buffer grayscale (Uint8Array) di dimensione LOGIC_W × LOGIC_H
 * forniti da ffmpeg (`-pix_fmt gray`). Output: Uint8Array dello stesso
 * shape con valori {0,1}, dove 1 = pixel chiaro.
 *
 * Algoritmi supportati: threshold, floyd_steinberg, atkinson, bayer4, bayer8.
 */

import { LOGIC_W, LOGIC_H } from "./sharp";

export type DitherMode =
  | "threshold"
  | "floyd_steinberg"
  | "atkinson"
  | "bayer4"
  | "bayer8";

// ---------------------------------------------------------------------------
//  Bayer matrices
// ---------------------------------------------------------------------------

const BAYER4: Float32Array = new Float32Array(
  [
    0, 8, 2, 10,
    12, 4, 14, 6,
    3, 11, 1, 9,
    15, 7, 13, 5,
  ].map((v) => v / 16),
);

const BAYER8: Float32Array = new Float32Array(
  [
    0, 32, 8, 40, 2, 34, 10, 42,
    48, 16, 56, 24, 50, 18, 58, 26,
    12, 44, 4, 36, 14, 46, 6, 38,
    60, 28, 52, 20, 62, 30, 54, 22,
    3, 35, 11, 43, 1, 33, 9, 41,
    51, 19, 59, 27, 49, 17, 57, 25,
    15, 47, 7, 39, 13, 45, 5, 37,
    63, 31, 55, 23, 61, 29, 53, 21,
  ].map((v) => v / 64),
);

// ---------------------------------------------------------------------------
//  Adjustments (brightness / contrast / gamma / invert)
// ---------------------------------------------------------------------------

export interface AdjustParams {
  brightness?: number; // -100..+100
  contrast?: number;   // 0..3 (1.0 = neutro)
  gamma?: number;      // 0.1..3 (1.0 = neutro)
  invert?: boolean;
}

export function applyAdjustments(gray: Uint8Array, p: AdjustParams = {}): Uint8Array {
  const b = p.brightness ?? 0;
  const c = p.contrast ?? 1.0;
  const g = p.gamma ?? 1.0;
  const inv = p.invert ?? false;
  const out = new Uint8Array(gray.length);
  const gammaInv = 1.0 / Math.max(g, 1e-3);
  for (let i = 0; i < gray.length; i++) {
    let v = (gray[i] - 128) * c + 128 + b;
    if (v < 0) v = 0;
    else if (v > 255) v = 255;
    if (Math.abs(g - 1) > 1e-3) {
      v = 255 * Math.pow(v / 255, gammaInv);
      if (v < 0) v = 0;
      else if (v > 255) v = 255;
    }
    out[i] = inv ? 255 - v : v;
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Dither algorithms (input: gray uint8, output: bw {0,1})
// ---------------------------------------------------------------------------

function ditherThreshold(gray: Uint8Array, thr: number): Uint8Array {
  const out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) out[i] = gray[i] >= thr ? 1 : 0;
  return out;
}

function ditherBayer(
  gray: Uint8Array,
  w: number,
  h: number,
  mat: Float32Array,
  matSize: number,
): Uint8Array {
  const out = new Uint8Array(gray.length);
  for (let y = 0; y < h; y++) {
    const my = y % matSize;
    for (let x = 0; x < w; x++) {
      const mx = x % matSize;
      const t = mat[my * matSize + mx];
      out[y * w + x] = gray[y * w + x] / 255 > t ? 1 : 0;
    }
  }
  return out;
}

function ditherFloydSteinberg(
  gray: Uint8Array,
  w: number,
  h: number,
): Uint8Array {
  // Buffer Float32 di lavoro per propagazione errore.
  const f = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) f[i] = gray[i];

  const out = new Uint8Array(gray.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const old = f[idx];
      const isWhite = old >= 128;
      out[idx] = isWhite ? 1 : 0;
      const err = old - (isWhite ? 255 : 0);
      if (x + 1 < w) f[idx + 1] += (err * 7) / 16;
      if (y + 1 < h) {
        if (x > 0) f[idx + w - 1] += (err * 3) / 16;
        f[idx + w] += (err * 5) / 16;
        if (x + 1 < w) f[idx + w + 1] += (err * 1) / 16;
      }
    }
  }
  return out;
}

function ditherAtkinson(gray: Uint8Array, w: number, h: number): Uint8Array {
  const f = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) f[i] = gray[i];

  const out = new Uint8Array(gray.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const old = f[idx];
      const isWhite = old >= 128;
      out[idx] = isWhite ? 1 : 0;
      const err = (old - (isWhite ? 255 : 0)) / 8;
      const offsets: Array<[number, number]> = [
        [1, 0], [2, 0], [-1, 1], [0, 1], [1, 1], [0, 2],
      ];
      for (const [dx, dy] of offsets) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
          f[ny * w + nx] += err;
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Public API: dither a full frame at LOGIC_W × LOGIC_H
// ---------------------------------------------------------------------------

export interface DitherFrameOptions {
  mode?: DitherMode;
  threshold?: number;
  /** Brightness/contrast/gamma/invert pre-dither. */
  adjust?: AdjustParams;
}

export function ditherFrame(
  gray: Uint8Array,
  opts: DitherFrameOptions = {},
): Uint8Array {
  if (gray.length !== LOGIC_W * LOGIC_H) {
    throw new Error(
      `ditherFrame: expected ${LOGIC_W * LOGIC_H} bytes, got ${gray.length}`,
    );
  }
  const mode = opts.mode ?? "floyd_steinberg";
  const thr = opts.threshold ?? 128;
  const adjusted = opts.adjust ? applyAdjustments(gray, opts.adjust) : gray;

  switch (mode) {
    case "threshold":
      return ditherThreshold(adjusted, thr);
    case "bayer4":
      return ditherBayer(adjusted, LOGIC_W, LOGIC_H, BAYER4, 4);
    case "bayer8":
      return ditherBayer(adjusted, LOGIC_W, LOGIC_H, BAYER8, 8);
    case "atkinson":
      return ditherAtkinson(adjusted, LOGIC_W, LOGIC_H);
    case "floyd_steinberg":
    default:
      return ditherFloydSteinberg(adjusted, LOGIC_W, LOGIC_H);
  }
}

// ---------------------------------------------------------------------------
//  Zero-alloc variant: scrive in `bwOut` riusando `work` (Float32) per i
//  dithering con error diffusion. Pensato per il loop di convertVideo dove
//  ogni frame altrimenti allocava ~900KB tra Float32 e Uint8 → GC pressure.
// ---------------------------------------------------------------------------

export interface DitherBuffers {
  /** Float32 di lavoro per FS/Atkinson, LOGIC_W*LOGIC_H. */
  work: Float32Array;
  /** Output bw {0,1}, LOGIC_W*LOGIC_H. */
  bwOut: Uint8Array;
  /** Buffer adjusted opzionale (se servono adjustments senza scrivere il src). */
  adjustedOut?: Uint8Array;
}

export function createDitherBuffers(): DitherBuffers {
  return {
    work: new Float32Array(LOGIC_W * LOGIC_H),
    bwOut: new Uint8Array(LOGIC_W * LOGIC_H),
    adjustedOut: new Uint8Array(LOGIC_W * LOGIC_H),
  };
}

function ditherThresholdInto(gray: Uint8Array, bw: Uint8Array, thr: number) {
  for (let i = 0; i < gray.length; i++) bw[i] = gray[i] >= thr ? 1 : 0;
}

function ditherBayerInto(
  gray: Uint8Array,
  bw: Uint8Array,
  w: number,
  h: number,
  mat: Float32Array,
  matSize: number,
) {
  for (let y = 0; y < h; y++) {
    const my = y % matSize;
    for (let x = 0; x < w; x++) {
      const mx = x % matSize;
      const t = mat[my * matSize + mx];
      bw[y * w + x] = gray[y * w + x] / 255 > t ? 1 : 0;
    }
  }
}

function ditherFloydSteinbergInto(
  gray: Uint8Array,
  bw: Uint8Array,
  work: Float32Array,
  w: number,
  h: number,
) {
  for (let i = 0; i < gray.length; i++) work[i] = gray[i];
  for (let y = 0; y < h; y++) {
    const rb = y * w;
    for (let x = 0; x < w; x++) {
      const idx = rb + x;
      const old = work[idx];
      const isWhite = old >= 128;
      bw[idx] = isWhite ? 1 : 0;
      const err = old - (isWhite ? 255 : 0);
      if (x + 1 < w) work[idx + 1] += (err * 7) / 16;
      if (y + 1 < h) {
        if (x > 0) work[idx + w - 1] += (err * 3) / 16;
        work[idx + w] += (err * 5) / 16;
        if (x + 1 < w) work[idx + w + 1] += (err * 1) / 16;
      }
    }
  }
}

function ditherAtkinsonInto(
  gray: Uint8Array,
  bw: Uint8Array,
  work: Float32Array,
  w: number,
  h: number,
) {
  for (let i = 0; i < gray.length; i++) work[i] = gray[i];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const old = work[idx];
      const isWhite = old >= 128;
      bw[idx] = isWhite ? 1 : 0;
      const err = (old - (isWhite ? 255 : 0)) / 8;
      if (x + 1 < w) work[idx + 1] += err;
      if (x + 2 < w) work[idx + 2] += err;
      if (y + 1 < h) {
        if (x > 0) work[idx + w - 1] += err;
        work[idx + w] += err;
        if (x + 1 < w) work[idx + w + 1] += err;
      }
      if (y + 2 < h) work[idx + 2 * w] += err;
    }
  }
}

function applyAdjustmentsInto(
  gray: Uint8Array,
  out: Uint8Array,
  p: AdjustParams,
) {
  const b = p.brightness ?? 0;
  const c = p.contrast ?? 1.0;
  const g = p.gamma ?? 1.0;
  const inv = p.invert ?? false;
  const gammaInv = 1.0 / Math.max(g, 1e-3);
  const gammaActive = Math.abs(g - 1) > 1e-3;
  for (let i = 0; i < gray.length; i++) {
    let v = (gray[i] - 128) * c + 128 + b;
    if (v < 0) v = 0;
    else if (v > 255) v = 255;
    if (gammaActive) {
      v = 255 * Math.pow(v / 255, gammaInv);
      if (v < 0) v = 0;
      else if (v > 255) v = 255;
    }
    out[i] = inv ? 255 - v : v;
  }
}

/** Dithera `gray` dentro `bufs.bwOut` senza allocare. */
export function ditherFrameInto(
  gray: Uint8Array,
  bufs: DitherBuffers,
  opts: DitherFrameOptions = {},
): Uint8Array {
  if (gray.length !== LOGIC_W * LOGIC_H) {
    throw new Error(
      `ditherFrameInto: expected ${LOGIC_W * LOGIC_H} bytes, got ${gray.length}`,
    );
  }
  const mode = opts.mode ?? "floyd_steinberg";
  const thr = opts.threshold ?? 128;

  let src: Uint8Array;
  if (opts.adjust) {
    if (!bufs.adjustedOut) bufs.adjustedOut = new Uint8Array(gray.length);
    applyAdjustmentsInto(gray, bufs.adjustedOut, opts.adjust);
    src = bufs.adjustedOut;
  } else {
    src = gray;
  }

  switch (mode) {
    case "threshold":
      ditherThresholdInto(src, bufs.bwOut, thr);
      break;
    case "bayer4":
      ditherBayerInto(src, bufs.bwOut, LOGIC_W, LOGIC_H, BAYER4, 4);
      break;
    case "bayer8":
      ditherBayerInto(src, bufs.bwOut, LOGIC_W, LOGIC_H, BAYER8, 8);
      break;
    case "atkinson":
      ditherAtkinsonInto(src, bufs.bwOut, bufs.work, LOGIC_W, LOGIC_H);
      break;
    case "floyd_steinberg":
    default:
      ditherFloydSteinbergInto(src, bufs.bwOut, bufs.work, LOGIC_W, LOGIC_H);
      break;
  }
  return bufs.bwOut;
}
