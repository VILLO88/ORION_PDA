/**
 * Sharp LS032 panel bitstream encoder.
 *
 * Port TypeScript di videoconv_toolV1/sharp_processor.py — solo le parti
 * necessarie al video pipeline:
 *   - rotazione logic→native (90° CW)
 *   - bit-pack MSB-first
 *   - costruzione del bitstream per riga (header 2B + 42B dati) × 536 + 2B
 *     trailer = 23586 byte/frame, identico a mldma_buffer in sharp_ls032.c.
 *
 * Convenzione bit nel frame logico (input): 1 = pixel chiaro (bianco
 * normally-white sul Sharp), 0 = nero. Coerente col framebuffer firmware.
 */

export const NATIVE_W = 336;
export const NATIVE_H = 536;
export const BYTES_PER_LINE = NATIVE_W / 8; // 42

/** Area logica dopo rotazione 90° CW (vista landscape utente). */
export const LOGIC_W = NATIVE_H; // 536
export const LOGIC_H = NATIVE_W; // 336

/** Dimensione byte di un frame video impacchettato. */
export const VIDEO_FRAME_BYTES = NATIVE_H * (2 + BYTES_PER_LINE) + 2; // 23586

// ---------------------------------------------------------------------------
//  Per-row header (M0/M1/M2 + AG0..AG9), pre-calcolato una volta sola
// ---------------------------------------------------------------------------

/** Codifica un header riga (2 byte). n = numero riga 1-based (1..536). */
function encodeRowHeader(n: number, isFirst: boolean): [number, number] {
  // byte0 = [M0][M1][M2][DMY][DMY][DMY][AG0][AG1]
  // byte1 = [AG2..AG9]   (AG0 = bit0 di n LSB, AG9 = bit9 di n MSB)
  let b0 = isFirst ? 0x80 : 0x00; // M0 sulla prima riga
  if (n & (1 << 0)) b0 |= 0x02;   // AG0 -> byte0 bit 1
  if (n & (1 << 1)) b0 |= 0x01;   // AG1 -> byte0 bit 0
  let b1 = 0;
  for (let k = 2; k < 10; k++) {
    if (n & (1 << k)) b1 |= 1 << (9 - k); // AG2->b7, AG3->b6, …, AG9->b0
  }
  return [b0, b1];
}

const FRAME_HEADERS: Uint8Array = (() => {
  const buf = new Uint8Array(NATIVE_H * 2);
  for (let i = 0; i < NATIVE_H; i++) {
    const [b0, b1] = encodeRowHeader(i + 1, i === 0);
    buf[i * 2] = b0;
    buf[i * 2 + 1] = b1;
  }
  return buf;
})();

// ---------------------------------------------------------------------------
//  Rotation + packing (combinati per evitare buffer intermedi)
//
//  Input: bwLogic — Uint8Array di (LOGIC_W * LOGIC_H) = 536 × 336 byte,
//         row-major, ogni byte ∈ {0, 1} (1 = bianco).
//
//  Pipeline:
//    1. (rotation) bw_native[py, px] = bw_logic[335 - px, py]
//    2. (packing)  D0 nel bit 7 del primo byte di ogni riga nativa
//
//  Output direttamente nel framebuffer 23586 byte, già pronto per SPI DMA.
// ---------------------------------------------------------------------------

/**
 * Costruisce il bitstream 23586-byte da un frame logico binario.
 *
 * @param bwLogic Uint8Array len = LOGIC_W * LOGIC_H = 180096. Row-major.
 *                Ogni byte: 1 → pixel chiaro, 0 → pixel scuro.
 * @returns Buffer 23586 byte, byte-identico a mldma_buffer firmware.
 */
export function buildFrameBitstream(bwLogic: Uint8Array): Buffer {
  const out = Buffer.alloc(VIDEO_FRAME_BYTES);
  buildFrameBitstreamInto(bwLogic, out, 0);
  return out;
}

/**
 * Variante zero-alloc: scrive `VIDEO_FRAME_BYTES` byte dentro `out` a partire
 * da `dstOff`. Pensata per il loop di `convertVideo` dove riusiamo un Buffer
 * pre-allocato per evitare GC pressure.
 */
export function buildFrameBitstreamInto(
  bwLogic: Uint8Array,
  out: Buffer,
  dstOff: number,
): void {
  if (bwLogic.length !== LOGIC_W * LOGIC_H) {
    throw new Error(
      `buildFrameBitstream: bwLogic length ${bwLogic.length} != ${LOGIC_W * LOGIC_H}`,
    );
  }
  if (out.length - dstOff < VIDEO_FRAME_BYTES) {
    throw new Error(
      `buildFrameBitstreamInto: spazio insufficiente (${out.length - dstOff} < ${VIDEO_FRAME_BYTES})`,
    );
  }
  let off = dstOff;
  for (let py = 0; py < NATIVE_H; py++) {
    out[off++] = FRAME_HEADERS[py * 2];
    out[off++] = FRAME_HEADERS[py * 2 + 1];
    for (let byteIdx = 0; byteIdx < BYTES_PER_LINE; byteIdx++) {
      const px0 = byteIdx * 8;
      let b = 0;
      for (let bit = 0; bit < 8; bit++) {
        const px = px0 + bit;
        const srcIdx = (LOGIC_H - 1 - px) * LOGIC_W + py;
        if (bwLogic[srcIdx]) b |= 0x80 >> bit;
      }
      out[off++] = b;
    }
  }
  // 2 byte trailer 0x00
  out[off++] = 0;
  out[off] = 0;
}
