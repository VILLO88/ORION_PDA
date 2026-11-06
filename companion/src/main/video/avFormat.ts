/**
 * Formato file .av (PDAV magic) — header 32 byte + frame multiplexati.
 *
 * Vedi anche `videoconv_toolV1/sharp_processor.py::encode_av_to_file` per la
 * versione Python di riferimento, e la memory `project_av_format` per la
 * descrizione completa del layout multiplex.
 *
 * Layout header (little-endian, struct `<4sHHHHIBBHIII`):
 *   off  size  field
 *    0    4    magic           "PDAV"
 *    4    2    version u16     1
 *    6    2    flags u16       (bit 0 = audio presente)
 *    8    2    fps u16
 *   10    2    reserved
 *   12    4    audio_sample_rate u32
 *   16    1    audio_channels u8
 *   17    1    audio_bits_per_sample u8
 *   18    2    reserved
 *   20    4    audio_block_bytes u32
 *   24    4    frame_count u32
 *   28    4    video_frame_bytes u32
 */

export const AV_MAGIC = Buffer.from([0x50, 0x44, 0x41, 0x56]); // "PDAV"
export const AV_VERSION = 1;
export const AV_HEADER_BYTES = 32;
export const AV_FLAG_HAS_AUDIO = 0x0001;

export interface AvHeaderFields {
  flags: number;
  fps: number;
  audioSampleRate: number;
  audioChannels: number;
  audioBitsPerSample: number;
  audioBlockBytes: number;
  frameCount: number;
  videoFrameBytes: number;
}

export function buildAvHeader(h: AvHeaderFields): Buffer {
  const buf = Buffer.alloc(AV_HEADER_BYTES);
  AV_MAGIC.copy(buf, 0);
  buf.writeUInt16LE(AV_VERSION, 4);
  buf.writeUInt16LE(h.flags & 0xffff, 6);
  buf.writeUInt16LE(h.fps & 0xffff, 8);
  buf.writeUInt16LE(0, 10); // reserved
  buf.writeUInt32LE(h.audioSampleRate >>> 0, 12);
  buf.writeUInt8(h.audioChannels & 0xff, 16);
  buf.writeUInt8(h.audioBitsPerSample & 0xff, 17);
  buf.writeUInt16LE(0, 18); // reserved
  buf.writeUInt32LE(h.audioBlockBytes >>> 0, 20);
  buf.writeUInt32LE(h.frameCount >>> 0, 24);
  buf.writeUInt32LE(h.videoFrameBytes >>> 0, 28);
  return buf;
}
