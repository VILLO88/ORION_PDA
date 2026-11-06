/**
 * Port renderer-side dei dither algorithms del main process (video/dither.ts).
 * Le routine sono pure ma allocano buffer di lavoro consistenti (Float32Array
 * 720KB per FS/Atkinson); per usarle a 30 fps nella preview HTML5
 * accettiamo `WorkBuffers` riusabili così l'overhead per-frame è zero.
 *
 * Convenzione bit: 1 → pixel chiaro (LC OFF), 0 → pixel nero (LC ON),
 * coerente col writer firmware.
 */

import type { VideoAdjustParams, VideoDitherMode, VideoFitMode } from "@shared/ipc-types";

export const LOGIC_W = 536;
export const LOGIC_H = 336;
export const FRAME_PIXELS = LOGIC_W * LOGIC_H;

/** Buffer di lavoro riusabili tra frame consecutivi della preview. */
export interface DitherWorkBuffers {
  /** Float32 per error diffusion (FS / Atkinson). LOGIC_W*LOGIC_H. */
  work: Float32Array;
  /** Output 1bpp logical: 0 = nero, 1 = chiaro. LOGIC_W*LOGIC_H. */
  bw: Uint8Array;
  /** Buffer grayscale sorgente (post-letterbox/fit). LOGIC_W*LOGIC_H. */
  gray: Uint8Array;
}

export function createDitherBuffers(): DitherWorkBuffers {
  return {
    work: new Float32Array(FRAME_PIXELS),
    bw: new Uint8Array(FRAME_PIXELS),
    gray: new Uint8Array(FRAME_PIXELS),
  };
}

// ---------------------------------------------------------------------------
//  Bayer matrices (uguali a main/video/dither.ts)
// ---------------------------------------------------------------------------

const BAYER4 = new Float32Array(
  [
    0, 8, 2, 10,
    12, 4, 14, 6,
    3, 11, 1, 9,
    15, 7, 13, 5,
  ].map((v) => v / 16),
);

const BAYER8 = new Float32Array(
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
//  Adjustments brightness/contrast/gamma/invert
// ---------------------------------------------------------------------------

export function applyAdjustments(
  gray: Uint8Array,
  out: Uint8Array,
  p: VideoAdjustParams | undefined,
): Uint8Array {
  if (!p) {
    if (out !== gray) out.set(gray);
    return out;
  }
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
  return out;
}

// ---------------------------------------------------------------------------
//  Dither algorithms (input: gray, output: bw {0,1})
// ---------------------------------------------------------------------------

function ditherThresholdInto(
  gray: Uint8Array,
  bw: Uint8Array,
  thr: number,
): void {
  for (let i = 0; i < gray.length; i++) bw[i] = gray[i] >= thr ? 1 : 0;
}

function ditherBayerInto(
  gray: Uint8Array,
  bw: Uint8Array,
  w: number,
  h: number,
  mat: Float32Array,
  matSize: number,
): void {
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
): void {
  // Inizializza work = gray (cast implicit a float)
  for (let i = 0; i < gray.length; i++) work[i] = gray[i];

  for (let y = 0; y < h; y++) {
    const rowBase = y * w;
    for (let x = 0; x < w; x++) {
      const idx = rowBase + x;
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
): void {
  for (let i = 0; i < gray.length; i++) work[i] = gray[i];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const old = work[idx];
      const isWhite = old >= 128;
      bw[idx] = isWhite ? 1 : 0;
      const err = (old - (isWhite ? 255 : 0)) / 8;
      // (+1,0) (+2,0) (-1,+1) (0,+1) (+1,+1) (0,+2)
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

// ---------------------------------------------------------------------------
//  Dispatch
// ---------------------------------------------------------------------------

export interface DitherOptions {
  mode?: VideoDitherMode;
  threshold?: number;
  adjust?: VideoAdjustParams;
}

/**
 * Dithera in place dentro `buffers.bw`. `buffers.gray` deve essere già
 * popolato (grayscale 536×336). Ritorna lo stesso buffer.bw.
 */
export function ditherFrameInto(
  buffers: DitherWorkBuffers,
  opts: DitherOptions = {},
): Uint8Array {
  const mode = opts.mode ?? "floyd_steinberg";
  const thr = opts.threshold ?? 128;

  // Adjustments scrivono in `gray` stesso (in-place), così evitiamo un buffer.
  const adjusted = applyAdjustments(buffers.gray, buffers.gray, opts.adjust);

  switch (mode) {
    case "threshold":
      ditherThresholdInto(adjusted, buffers.bw, thr);
      break;
    case "bayer4":
      ditherBayerInto(adjusted, buffers.bw, LOGIC_W, LOGIC_H, BAYER4, 4);
      break;
    case "bayer8":
      ditherBayerInto(adjusted, buffers.bw, LOGIC_W, LOGIC_H, BAYER8, 8);
      break;
    case "atkinson":
      ditherAtkinsonInto(adjusted, buffers.bw, buffers.work, LOGIC_W, LOGIC_H);
      break;
    case "floyd_steinberg":
    default:
      ditherFloydSteinbergInto(adjusted, buffers.bw, buffers.work, LOGIC_W, LOGIC_H);
      break;
  }
  return buffers.bw;
}

// ---------------------------------------------------------------------------
//  Frame composition: video element / canvas source → gray buffer
// ---------------------------------------------------------------------------

/**
 * Calcola il rettangolo di destinazione per il fit mode richiesto.
 * Sorgente w×h va proiettato dentro LOGIC_W×LOGIC_H (536×336).
 */
export function computeFitRect(
  srcW: number,
  srcH: number,
  fit: VideoFitMode,
): { dx: number; dy: number; dw: number; dh: number } {
  const dstAr = LOGIC_W / LOGIC_H;
  const srcAr = srcW / srcH;
  if (fit === "stretch") {
    return { dx: 0, dy: 0, dw: LOGIC_W, dh: LOGIC_H };
  }
  if (fit === "fill") {
    // Riempi crop-style: lato corto matcha, l'altro eccede.
    if (srcAr > dstAr) {
      // src più largo: matcha altezza, crop ai lati
      const dh = LOGIC_H;
      const dw = Math.round(dh * srcAr);
      return { dx: Math.round((LOGIC_W - dw) / 2), dy: 0, dw, dh };
    } else {
      const dw = LOGIC_W;
      const dh = Math.round(dw / srcAr);
      return { dx: 0, dy: Math.round((LOGIC_H - dh) / 2), dw, dh };
    }
  }
  // "fit" (letterbox)
  if (srcAr > dstAr) {
    const dw = LOGIC_W;
    const dh = Math.round(dw / srcAr);
    return { dx: 0, dy: Math.round((LOGIC_H - dh) / 2), dw, dh };
  } else {
    const dh = LOGIC_H;
    const dw = Math.round(dh * srcAr);
    return { dx: Math.round((LOGIC_W - dw) / 2), dy: 0, dw, dh };
  }
}

/**
 * Disegna `source` (HTMLVideoElement) in un offscreen canvas 536×336 con
 * il fit richiesto e popola `buffers.gray` con la luminanza.
 *
 * Riusa l'offscreen canvas passato in input (chiamante lo crea una volta).
 */
export function captureFrameToGray(
  source: HTMLVideoElement,
  _scratch: HTMLCanvasElement,
  scratchCtx: CanvasRenderingContext2D,
  buffers: DitherWorkBuffers,
  fit: VideoFitMode,
): void {
  const sw = source.videoWidth;
  const sh = source.videoHeight;
  if (sw === 0 || sh === 0) return;

  // Sfondo nero per il letterbox (fit) o quando l'aspect è ≠ del dst.
  scratchCtx.fillStyle = "#000";
  scratchCtx.fillRect(0, 0, LOGIC_W, LOGIC_H);

  const r = computeFitRect(sw, sh, fit);
  scratchCtx.drawImage(source, r.dx, r.dy, r.dw, r.dh);

  const imageData = scratchCtx.getImageData(0, 0, LOGIC_W, LOGIC_H);
  const data = imageData.data;
  const gray = buffers.gray;
  // Luma BT.601: Y = 0.299R + 0.587G + 0.114B (matcha ffmpeg `format=gray`).
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
  }
}

// ---------------------------------------------------------------------------
//  Display: paint bw (0/1) su un canvas user-facing 536×336
// ---------------------------------------------------------------------------

const PIXEL_LIGHT_R = 0xe6;
const PIXEL_LIGHT_G = 0xeb;
const PIXEL_LIGHT_B = 0xef;
const PIXEL_DARK = 0x0a;

export function paintBwToCanvas(
  canvas: HTMLCanvasElement,
  bw: Uint8Array,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  const img = ctx.createImageData(LOGIC_W, LOGIC_H);
  const out = img.data;
  for (let i = 0; i < FRAME_PIXELS; i++) {
    const isLight = bw[i] !== 0;
    const o = i * 4;
    out[o] = isLight ? PIXEL_LIGHT_R : PIXEL_DARK;
    out[o + 1] = isLight ? PIXEL_LIGHT_G : PIXEL_DARK;
    out[o + 2] = isLight ? PIXEL_LIGHT_B : PIXEL_DARK;
    out[o + 3] = 0xff;
  }
  ctx.putImageData(img, 0, 0);
}
