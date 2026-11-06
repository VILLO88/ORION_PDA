/**
 * Video pipeline — mp4/mkv/mov/avi → file .av (PDAV) per Orion.
 *
 * Architettura (port di videoconv_toolV1/sharp_processor.py::encode_av_to_file):
 *
 *  1. ffprobe → durata sorgente.
 *  2. ffmpeg #1 (audio) → estrae PCM s16le al sample_rate richiesto, salva
 *     in un file temporaneo. Per video di pochi minuti la traccia audio
 *     occupa pochi MB (es. 48000 × 2 × 2 × 600 s ≈ 110 MB max; per video
 *     più lunghi resta accettabile).
 *  3. ffmpeg #2 (video) → estrae frame grayscale 536×336 a fps target con
 *     letterbox; stream rawvideo `gray` su stdout. Pipe-based: leggiamo
 *     LOGIC_W*LOGIC_H byte per ciclo.
 *  4. Per ogni frame: dither (FS / Atkinson / Bayer / threshold) → rotate +
 *     pack → 23586 byte. Mux con audio_block dello stesso frame index.
 *  5. Header riscritto a fine encode col frame_count effettivo.
 *
 * Vincoli:
 *   - ⚠️ **fps = 15, fisso** (9 ottobre 2026; era 10). Non è una preferenza:
 *     è quanto il pannello riesce a ricevere. Vedi FPS_PANNELLO qui sotto.
 *   - ⚠️ **audio mono**. A 15 fps lo stereo ci starebbe (12 800 byte per
 *     blocco contro i 16 384 del lettore; a 10 erano 19 200 e il file veniva
 *     **rifiutato**), ma raddoppia l'audio di un file già grande.
 *   - fps deve restare un divisore esatto del sample rate: 48000/15 = 3200.
 *   - Output direttamente su <mount>/video/<name>.av (o local export se
 *     non c'è device).
 *
 * Progress: percentuale calcolata su frame_estimate = duration × fps.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, parse as parsePath } from "node:path";
import { randomBytes } from "node:crypto";
import { getFfmpegPathSync, getFfprobePathSync } from "../ffmpeg/paths";
import {
  createDitherBuffers,
  ditherFrame,
  ditherFrameInto,
  type DitherMode,
  type AdjustParams,
} from "../video/dither";
import {
  AV_FLAG_HAS_AUDIO,
  AV_HEADER_BYTES,
  buildAvHeader,
} from "../video/avFormat";
import {
  buildFrameBitstream,
  buildFrameBitstreamInto,
  LOGIC_H,
  LOGIC_W,
  VIDEO_FRAME_BYTES,
} from "../video/sharp";

// ---------------------------------------------------------------------------
//  Public types
// ---------------------------------------------------------------------------

export interface VideoConvertRequest {
  /** Path locale del video sorgente. */
  sourcePath: string;
  /** fps di output (intero, divisore di audio sample rate). Default 30. */
  fps?: number;
  /** Sample rate audio (48000 default). */
  audioSampleRate?: number;
  /** Canali audio (1 = mono, 2 = stereo, default 2). */
  audioChannels?: 1 | 2;
  /** Dither mode. Default "floyd_steinberg". */
  ditherMode?: DitherMode;
  /** Threshold per mode "threshold". Default 128. */
  threshold?: number;
  /** Adjustments tonali pre-dither. */
  adjust?: AdjustParams;
  /** Fit mode video → 536×336. "fit" letterbox (default), "fill" crop, "stretch". */
  fitMode?: "fit" | "fill" | "stretch";
  /** Mount path device. Se assente, scrive in ~/Documents/Orion/video-export. */
  mountPath?: string;
  /** Sotto-cartella su <mount>/. Default "video". */
  folder?: string;
  /** Basename output (no extension). Default = basename(sourcePath). */
  outputBaseName?: string;
  /** Cartella di destinazione assoluta per il local export. Se assente (e
   *  manca anche `mountPath`) si usa il default ~/Documents/Orion/video-export. */
  localOutDir?: string;
  /** `false` forza la conversione a un solo ffmpeg, com'era fino all'8/10/2026.
   *  Default: a pezzi in parallelo dove conviene (vedi `segmentiPerVideo`). */
  parallelo?: boolean;
}

export interface VideoConvertResponse {
  outputPath: string;
  frameCount: number;
  bytes: number;
  durationSec: number;
  fps: number;
}

export interface VideoProgressEvent {
  phase: "probe" | "audio" | "video" | "done" | "error";
  /** Frame index correntemente scritto (durante "video"). */
  frame?: number;
  /** Frame totali stimati. */
  totalFrames?: number;
  /** 0..100. */
  percent?: number;
  error?: string;
}

export type VideoProgressEmitter = (ev: VideoProgressEvent) => void;

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

/**
 * ⚠️ **Quindici fotogrammi al secondo, e non è una scelta di gusto.**
 *
 * Comanda la **banda**: il firmware del 9/10/2026 manda i video a 3 MHz di
 * SCLK, un frame da 23 586 byte impiega 63 ms, e a 15 fotogrammi al secondo
 * ce ne sono 67. Il fotogramma deve **finire di arrivare** prima del
 * successivo: 16 non ci sta (62,5 ms), e il gradino sopra i 3 MHz sporca il
 * pannello.
 *
 * ⚠️ Fino al 9/10/2026 qui c'era **10**, per il massimo di `fSCS` del
 * datasheet del LS032B7DD02 (Table 6-3-1). È un limite prudente: a 15 il
 * pannello resta pulito, e sul movimento la differenza si vede — a 10 il
 * confine fra fotogramma vecchio e nuovo attraversava lo schermo con uno
 * scalino grande, un effetto da rolling shutter. `PDAV3/APP_VIDEO.md` §2.
 *
 * ⚠️ **Vuole il firmware del 9/10/2026.** Uno precedente manda i video a
 * 2,5 MHz (75 ms per frame): un file a 15 lì salta fotogrammi.
 *
 * ⚠️ Chiedere di più non li fa andare più veloci: il lettore butta la
 * differenza e la conta come "salti". Un file a 24 non si vede meglio di uno
 * a 15, si vede **peggio** — i fotogrammi scartati in modo irregolare fanno
 * un movimento a scatti invece che fluido — e occupa più spazio per niente.
 */
const FPS_PANNELLO = 15;

/** Il tetto del blocco audio per fotogramma, da `video_player.c`
 *  (`AV_BLOCCO_MAX`). Oltre, il lettore rifiuta il file all'apertura. */
const AV_BLOCCO_MAX = 16384;

const DEFAULT_FPS = FPS_PANNELLO;

const DEFAULT_AUDIO_SR = 48000;
/** ⚠️ Mono: per una traccia parlata su un altoparlante solo è la scelta
 *  giusta, e tiene piccolo il file. Non è più un obbligo: lo era a 10 fps,
 *  dove lo stereo sforava `AV_BLOCCO_MAX`. */
const DEFAULT_AUDIO_CH = 1 as const;
const AUDIO_BITS = 16;
const FRAME_PIXELS = LOGIC_W * LOGIC_H;

function sanitizeFolder(folder: string): string {
  const cleaned = folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").trim();
  if (cleaned === "" || cleaned.includes("..")) return "video";
  return cleaned;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

async function ensureDir(p: string): Promise<void> {
  if (!existsSync(p)) await mkdir(p, { recursive: true });
}

async function uniquePath(target: string): Promise<string> {
  if (!existsSync(target)) return target;
  const { dir, name, ext } = parsePath(target);
  let i = 1;
  while (existsSync(join(dir, `${name} (${i})${ext}`))) i++;
  return join(dir, `${name} (${i})${ext}`);
}

// ---------------------------------------------------------------------------
//  ffprobe / ffmpeg subprocesses
// ---------------------------------------------------------------------------

function probeDuration(sourcePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const args = [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      sourcePath,
    ];
    let out = "";
    let err = "";
    const p = spawn(getFfprobePathSync(), args);
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`ffprobe exit ${code}: ${err.trim() || "unknown"}`));
      }
      const n = parseFloat(out.trim());
      if (!Number.isFinite(n) || n <= 0) {
        return reject(new Error(`ffprobe: durata non determinabile per ${sourcePath}`));
      }
      resolve(n);
    });
  });
}

async function extractAudioPcm(
  sourcePath: string,
  sampleRate: number,
  channels: number,
  tmpPath: string,
): Promise<{ hasAudio: boolean }> {
  return new Promise((resolve) => {
    const args = [
      "-nostdin", "-hide_banner", "-loglevel", "error",
      "-i", sourcePath,
      "-vn",
      "-ac", String(channels),
      "-ar", String(sampleRate),
      "-f", "s16le",
      "-y",
      tmpPath,
    ];
    let err = "";
    const p = spawn(getFfmpegPathSync(), args);
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", () => resolve({ hasAudio: false }));
    p.on("close", (code) => {
      // Se il video non ha audio, ffmpeg fallisce: trattiamo come "no audio"
      // e zero-paddiamo lato muxer.
      if (code !== 0) {
        // best-effort: prova a guardare se c'è un file comunque
        resolve({ hasAudio: false });
      } else {
        // Se l'output è vuoto consideriamo no audio.
        resolve({ hasAudio: true });
      }
      void err; // tracciato per debug, non rilanciato.
    });
  });
}

/** Pixel per fotogramma del primo flusso video, 0 se non si riesce a saperlo.
 *  Non fa fallire niente: serve solo a scegliere la via, e nel dubbio si
 *  resta su quella di sempre. */
function probePixel(sourcePath: string): Promise<number> {
  return new Promise((resolve) => {
    const args = [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=p=0:s=x",
      sourcePath,
    ];
    let out = "";
    const p = spawn(getFfprobePathSync(), args);
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.on("error", () => resolve(0));
    p.on("close", () => {
      const m = /(\d+)x(\d+)/.exec(out);
      resolve(m ? Number(m[1]) * Number(m[2]) : 0);
    });
  });
}

function buildVideoFilter(fitMode: "fit" | "fill" | "stretch"): string {
  // Scaling a 536×336 + dither lavoriamo lato JS (più flessibilità).
  // fps filter spostato in args separati così ffmpeg lo applica prima dello scale.
  if (fitMode === "stretch") {
    return `scale=${LOGIC_W}:${LOGIC_H},format=gray`;
  }
  if (fitMode === "fill") {
    return `scale=${LOGIC_W}:${LOGIC_H}:force_original_aspect_ratio=increase,crop=${LOGIC_W}:${LOGIC_H},format=gray`;
  }
  // "fit" letterbox black
  return [
    `scale=${LOGIC_W}:${LOGIC_H}:force_original_aspect_ratio=decrease`,
    `pad=${LOGIC_W}:${LOGIC_H}:(ow-iw)/2:(oh-ih)/2:color=black`,
    "format=gray",
  ].join(",");
}

// ---------------------------------------------------------------------------
//  Per-frame audio block reader
//
//  L'audio è in un file temporaneo (s16le interleaved). Per non tenere
//  tutto in RAM lo leggiamo a blocchi di samples_per_frame * channels * 2
//  byte sequenzialmente. Se il video è più lungo dell'audio, pad zero.
// ---------------------------------------------------------------------------

interface AudioReader {
  /** Legge `blockBytes` byte dentro `target` a partire da `offset`. Pad zero
   *  in coda. Riusabile in un loop senza allocazioni per-frame. */
  readIntoBlock(target: Buffer, offset: number, blockBytes: number): Promise<void>;
  close(): Promise<void>;
  exists: boolean;
}

async function openAudioReader(
  pcmPath: string,
  hasAudio: boolean,
): Promise<AudioReader> {
  if (!hasAudio) {
    return {
      readIntoBlock(target, offset, blockBytes) {
        target.fill(0, offset, offset + blockBytes);
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
      exists: false,
    };
  }
  const fd = await open(pcmPath, "r");
  return {
    async readIntoBlock(target, offset, blockBytes) {
      const { bytesRead } = await fd.read(target, offset, blockBytes, null);
      if (bytesRead < blockBytes) {
        target.fill(0, offset + bytesRead, offset + blockBytes);
      }
    },
    async close() {
      await fd.close();
    },
    exists: true,
  };
}

// ---------------------------------------------------------------------------
//  Conversione a pezzi, in parallelo
//
//  Il tempo di una conversione è quasi tutto DECODIFICA del sorgente: ffmpeg
//  deve decodificare ogni fotogramma per tenerne dieci al secondo. Il dithering
//  in JS costa ~3 ms a fotogramma e non è il collo di bottiglia.
//
//  Misurato l'8/10/2026 su un M1, parte ffmpeg soltanto:
//
//    |                               | 1080p H.264, 60 s | 4K HEVC, 30 s |
//    | un ffmpeg, CPU (com'era)      |       6,3 s       |    17,0 s     |
//    | un ffmpeg, decodifica hardware|       8,3 s       |    11,7 s     |
//    | 4 ffmpeg, decodifica hardware |       4,1 s       |     5,6 s     |
//    | 4 ffmpeg, CPU                 |       5,6 s       |    15,2 s     |
//
//  E sulla conversione intera, su quattro minuti di un film vero (4K HEVC a
//  10 bit, 24 fps): 57,8 s a un pezzo, 25,0 s a quattro. I due file sono
//  IDENTICI byte per byte, audio compreso.
//
//  ⚠️ NON È UN GUADAGNO SU TUTTO. Su un 1080p H.264 la stessa prova ha dato
//  5,0 s a un pezzo e 5,0-5,1 a quattro: lì la CPU decodifica già quanto
//  l'hardware, e quattro avvii con quattro salti si mangiano il resto. Per
//  questo la via a pezzi si prende solo sopra il 1080p (`PARALLELO_MIN_PIXEL`).
//
//  ⚠️ Le due cose servono INSIEME. La decodifica hardware da sola aiuta poco o
//  niente, e più processi su CPU nemmeno — ffmpeg usa già tutti i core. È il
//  decodificatore del chip (VideoToolbox) a reggere più flussi alla volta.
//  Per questo la via a pezzi si prende solo su macOS.
//
//  ⚠️ La GPU non c'entra col dithering: Floyd-Steinberg e Atkinson propagano
//  l'errore da un pixel al successivo, sono sequenziali per costruzione.
//
//  Il formato si presta: ogni fotogramma occupa un numero fisso di byte, quindi
//  il fotogramma n ha un posto nel file che si conosce prima di cominciare, e
//  il suo blocco audio un posto nel PCM. Ogni pezzo scrive nei suoi posti, e
//  il sincronismo fra audio e video non dipende da quale pezzo finisce prima.
// ---------------------------------------------------------------------------

/** Sotto questa durata non si divide: avviare quattro ffmpeg costa più di
 *  quanto si guadagna. */
const PARALLELO_MIN_SEC = 60;
const PARALLELO_SEGMENTI = 4;
/** Più di un 1080p: è dove la decodifica pesa abbastanza da ripagare. */
const PARALLELO_MIN_PIXEL = 1920 * 1080 + 1;

function segmentiPerVideo(
  req: VideoConvertRequest,
  durataSec: number,
  pixel: number,
): number {
  if (req.parallelo === false) return 1;
  if (process.env.ORION_VIDEO_SERIALE === "1") return 1;
  if (process.platform !== "darwin") return 1;
  if (durataSec < PARALLELO_MIN_SEC) return 1;
  /* `parallelo: true` lo chiede comunque: serve a provare e a misurare. */
  if (req.parallelo !== true && pixel < PARALLELO_MIN_PIXEL) return 1;
  return PARALLELO_SEGMENTI;
}

/**
 * Legge lo stdout di un ffmpeg che emette fotogrammi `gray` e chiama
 * `onFrame` per ognuno, UNO ALLA VOLTA e aspettando che finisca.
 *
 * ⚠️ L'iterazione asincrona dello stream fa da freno: finché `onFrame` non
 * ritorna non si legge altro, la pipe si riempie e ffmpeg aspetta. Senza, con
 * quattro ffmpeg più veloci del dithering, i fotogrammi in coda crescerebbero
 * in memoria senza un tetto — 180 KB l'uno, per un film sono gigabyte.
 *
 * `frame` è riusato a ogni chiamata: chi ne ha bisogno dopo lo copia.
 */
async function pompaFotogrammi(
  proc: ChildProcess,
  onFrame: (frame: Uint8Array, indice: number) => Promise<void>,
): Promise<number> {
  const out = proc.stdout;
  if (!out) throw new Error("ffmpeg senza stdout");

  let coda = "";
  proc.stderr?.on("data", (d: Buffer) => {
    coda = (coda + d.toString()).slice(-2048);
  });
  const chiuso = new Promise<number>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) => resolve(code ?? -1));
  });

  const frame = new Uint8Array(FRAME_PIXELS);
  let pieno = 0;
  let n = 0;
  for await (const pezzo of out as AsyncIterable<Buffer>) {
    let off = 0;
    while (off < pezzo.length) {
      const k = Math.min(FRAME_PIXELS - pieno, pezzo.length - off);
      frame.set(pezzo.subarray(off, off + k), pieno);
      pieno += k;
      off += k;
      if (pieno === FRAME_PIXELS) {
        await onFrame(frame, n++);
        pieno = 0;
      }
    }
  }

  const code = await chiuso;
  if (code !== 0) {
    throw new Error(`ffmpeg video exit ${code}: ${coda.trim() || "unknown"}`);
  }
  return n;
}

// ---------------------------------------------------------------------------
//  Main pipeline
// ---------------------------------------------------------------------------

export async function convertVideo(
  req: VideoConvertRequest,
  emit: VideoProgressEmitter,
): Promise<VideoConvertResponse> {
  const fps = Math.round(req.fps ?? DEFAULT_FPS);
  const sr = req.audioSampleRate ?? DEFAULT_AUDIO_SR;
  const ch = req.audioChannels ?? DEFAULT_AUDIO_CH;
  if (fps <= 0) throw new Error("fps deve essere > 0");
  if (sr % fps !== 0) {
    throw new Error(
      `sample rate (${sr}) non divisibile per fps (${fps}): a ${fps} fps il ` +
        `blocco audio non è un numero intero di campioni. Con sr=48000 il ` +
        `valore giusto è ${FPS_PANNELLO}.`,
    );
  }
  const samplesPerFrame = sr / fps;
  const audioBlockBytes = samplesPerFrame * ch * (AUDIO_BITS / 8);

  /* ⚠️ Si controlla **qui** e non sul device. Il lettore rifiuta il file
     all'apertura con "header non valido", cioè dopo che l'utente ha aspettato
     la conversione e ha copiato il file: un errore che arriva alla fine del
     viaggio invece che all'inizio. */
  if (audioBlockBytes > AV_BLOCCO_MAX) {
    throw new Error(
      `blocco audio ${audioBlockBytes} byte per fotogramma: il lettore ne ` +
        `accetta ${AV_BLOCCO_MAX}. A ${fps} fps servono ${ch === 1 ? "" : "mono"}` +
        `${ch === 1 ? "meno campioni" : " invece di stereo"}.`,
    );
  }

  await stat(req.sourcePath); // ENOENT se non esiste

  // ---- Probe -------------------------------------------------------------
  emit({ phase: "probe" });
  const duration = await probeDuration(req.sourcePath);
  const totalFrames = Math.max(1, Math.round(duration * fps));

  // ---- Audio extraction --------------------------------------------------
  emit({ phase: "audio" });
  const tmpId = randomBytes(6).toString("hex");
  const tmpPcm = join(tmpdir(), `orion-av-${tmpId}.pcm`);
  let audioOk = false;
  try {
    const r = await extractAudioPcm(req.sourcePath, sr, ch, tmpPcm);
    audioOk = r.hasAudio && existsSync(tmpPcm);
  } catch {
    audioOk = false;
  }

  const audioReader = await openAudioReader(tmpPcm, audioOk);
  const flags = audioReader.exists ? AV_FLAG_HAS_AUDIO : 0;

  // Buffer pre-allocati riusati per ogni frame: zero GC pressure nel loop.
  const ditherBufs = createDitherBuffers();
  // [audio block | video frame] in un unico Buffer → singolo fs.write per frame.
  const combinedBuf = Buffer.alloc(audioBlockBytes + VIDEO_FRAME_BYTES);

  // ---- Output path -------------------------------------------------------
  const folder = sanitizeFolder(req.folder ?? "video");
  const baseRaw =
    req.outputBaseName ?? basename(req.sourcePath, extname(req.sourcePath));
  const base = sanitizeFilename(baseRaw);

  let outDir: string;
  if (req.mountPath) {
    outDir = join(req.mountPath, folder);
  } else if (req.localOutDir && req.localOutDir.trim().length > 0) {
    outDir = req.localOutDir;
  } else {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
    outDir = join(home, "Documents", "Orion", "video-export");
  }
  await ensureDir(outDir);
  const outPath = await uniquePath(join(outDir, `${base}.av`));

  // ---- Header placeholder + open output ---------------------------------
  // Scriviamo l'header iniziale con frame_count = totalFrames; lo riscriviamo
  // a fine encode se diverso.
  const initialHeader = buildAvHeader({
    flags,
    fps,
    audioSampleRate: sr,
    audioChannels: ch,
    audioBitsPerSample: AUDIO_BITS,
    audioBlockBytes,
    frameCount: totalFrames,
    videoFrameBytes: VIDEO_FRAME_BYTES,
  });

  const outFd = await open(outPath, "w");
  try {
    await outFd.write(initialHeader, 0, initialHeader.length, 0);

    // ---- Video: un ffmpeg solo, com'è sempre stato -----------------------
    const convertiSeriale = async (): Promise<number> => {
      emit({ phase: "video", frame: 0, totalFrames, percent: 0 });

      const videoArgs = [
        "-nostdin", "-hide_banner", "-loglevel", "error",
        "-i", req.sourcePath,
        "-an",
        "-vf", `fps=${fps},${buildVideoFilter(req.fitMode ?? "fit")}`,
        "-pix_fmt", "gray",
        "-f", "rawvideo",
        "-",
      ];
      const ffVideo = spawn(getFfmpegPathSync(), videoArgs);
      let stderrTail = "";
      ffVideo.stderr.on("data", (d: Buffer) => {
        stderrTail = (stderrTail + d.toString()).slice(-2048);
      });

      // Pump byte-stream from stdout into FRAME_PIXELS-sized buffers.
      let written = 0;
      let writeOffset = AV_HEADER_BYTES;
      let leftover: Buffer = Buffer.alloc(0);

      const onFrame = async (frameGray: Uint8Array): Promise<void> => {
        // 1. Audio block dentro combinedBuf[0..audioBlockBytes]
        await audioReader.readIntoBlock(combinedBuf, 0, audioBlockBytes);

        // 2. Dither in-place nel buffer pre-allocato (zero alloc)
        ditherFrameInto(frameGray, ditherBufs, {
          mode: req.ditherMode,
          threshold: req.threshold,
          adjust: req.adjust,
        });

        // 3. Pack bw direttamente dentro combinedBuf[audioBlockBytes..]
        buildFrameBitstreamInto(ditherBufs.bwOut, combinedBuf, audioBlockBytes);

        // 4. Singolo write atomico (audio + frame) → halve gli yield del loop
        await outFd.write(combinedBuf, 0, combinedBuf.length, writeOffset);
        writeOffset += combinedBuf.length;

        written++;
        if (written % 8 === 0 || written === totalFrames) {
          const percent = Math.min(
            100,
            Math.max(0, (written / totalFrames) * 100),
          );
          emit({ phase: "video", frame: written, totalFrames, percent });
        }
      };

      await new Promise<void>((resolve, reject) => {
        let pending: Promise<void> = Promise.resolve();
        let errored = false;

        ffVideo.stdout.on("data", (chunk: Buffer) => {
          if (errored) return;
          // Concatenate with leftover (rare, only on partial reads).
          const buf =
            leftover.length === 0
              ? chunk
              : Buffer.concat([leftover, chunk]);
          const fullFrames = Math.floor(buf.length / FRAME_PIXELS);
          for (let i = 0; i < fullFrames; i++) {
            const start = i * FRAME_PIXELS;
            const frameGray = new Uint8Array(
              buf.buffer,
              buf.byteOffset + start,
              FRAME_PIXELS,
            );
            // Copia perché reusiamo il buffer sottostante (chunk).
            const frameCopy = new Uint8Array(frameGray);
            pending = pending.then(() => onFrame(frameCopy)).catch((e) => {
              errored = true;
              ffVideo.kill("SIGKILL");
              reject(e);
            });
          }
          const consumed = fullFrames * FRAME_PIXELS;
          leftover =
            consumed === buf.length ? Buffer.alloc(0) : buf.subarray(consumed);
        });

        ffVideo.on("error", (e) => reject(e));
        ffVideo.on("close", (code) => {
          if (errored) return;
          pending
            .then(() => {
              if (code !== 0) {
                reject(
                  new Error(
                    `ffmpeg video pipe exit ${code}: ${stderrTail.trim() || "unknown"}`,
                  ),
                );
              } else {
                resolve();
              }
            })
            .catch(reject);
        });
      });
      return written;
    };

    // ---- Video: a pezzi in parallelo, decodifica hardware ----------------
    const convertiParallelo = async (nSeg: number): Promise<number> => {
      const perSeg = Math.ceil(totalFrames / nSeg);
      const passo = audioBlockBytes + VIDEO_FRAME_BYTES;
      const pcmFd = audioOk ? await open(tmpPcm, "r") : null;
      const procs: ChildProcess[] = [];
      let scritti = 0;

      /* Il blocco audio del fotogramma n sta in un posto fisso del PCM: si
         legge per posizione, perché i pezzi avanzano ognuno per conto suo. */
      const leggiAudio = async (buf: Buffer, n: number): Promise<void> => {
        if (!pcmFd) {
          buf.fill(0, 0, audioBlockBytes);
          return;
        }
        const { bytesRead } = await pcmFd.read(
          buf, 0, audioBlockBytes, n * audioBlockBytes,
        );
        if (bytesRead < audioBlockBytes) buf.fill(0, bytesRead, audioBlockBytes);
      };

      const segmento = async (i: number): Promise<number> => {
        const f0 = i * perSeg;
        if (f0 >= totalFrames) return 0;
        const ultimo = i === nSeg - 1;
        const attesi = Math.min(perSeg, totalFrames - f0);
        const bufs = createDitherBuffers();
        const buf = Buffer.alloc(passo);

        /* `-ss` PRIMA di `-i`: ffmpeg salta al fotogramma chiave precedente,
           decodifica e scarta fino al tempo esatto, e da lì i tempi ripartono
           da zero. `start_time=0` ancora la griglia dei dieci al secondo a
           quel punto invece che al primo fotogramma decodificato, che può
           cadere una frazione dopo: così il fotogramma k del pezzo è quello
           del tempo (f0 + k) / fps, lo stesso della conversione a un pezzo.
           L'ultimo pezzo non ha un tetto: va fino alla fine del file, perché
           `totalFrames` viene dalla durata dichiarata, che è una stima. */
        const args = [
          "-nostdin", "-hide_banner", "-loglevel", "error",
          "-hwaccel", "videotoolbox",
          "-ss", (f0 / fps).toFixed(3),
          "-i", req.sourcePath,
          "-an",
          "-vf", `fps=${fps}:start_time=0,${buildVideoFilter(req.fitMode ?? "fit")}`,
          ...(ultimo ? [] : ["-frames:v", String(attesi)]),
          "-pix_fmt", "gray",
          "-f", "rawvideo",
          "-",
        ];
        const proc = spawn(getFfmpegPathSync(), args);
        procs.push(proc);

        const scrivi = async (n: number): Promise<void> => {
          await leggiAudio(buf, n);
          await outFd.write(buf, 0, passo, AV_HEADER_BYTES + n * passo);
          scritti++;
          if (scritti % 16 === 0) {
            emit({
              phase: "video",
              frame: scritti,
              totalFrames,
              percent: Math.min(100, (scritti / totalFrames) * 100),
            });
          }
        };

        const fatti = await pompaFotogrammi(proc, async (gray, k) => {
          ditherFrameInto(gray, bufs, {
            mode: req.ditherMode,
            threshold: req.threshold,
            adjust: req.adjust,
          });
          buildFrameBitstreamInto(bufs.bwOut, buf, audioBlockBytes);
          await scrivi(f0 + k);
        });

        /* Un pezzo di mezzo che esce corto lascerebbe un buco nel file, e
           tutto ciò che segue fuori sincrono. Si riempie ripetendo l'ultima
           immagine — in `buf` c'è ancora — con il SUO audio: un fermo
           immagine si nota meno di un salto. Non dovrebbe succedere; se
           succede, il sorgente ha un buco nei tempi. */
        let n = fatti;
        if (!ultimo && fatti > 0) {
          for (; n < attesi; n++) await scrivi(f0 + n);
        }
        if (!ultimo && fatti === 0) {
          throw new Error(`il pezzo ${i + 1} di ${nSeg} non ha dato fotogrammi`);
        }
        return n;
      };

      try {
        const fatti = await Promise.all(
          Array.from({ length: nSeg }, (_, i) => segmento(i)),
        );
        /* I pezzi di mezzo sono pieni per costruzione: il conto vero lo fa
           l'ultimo che ha dato qualcosa. */
        let tot = 0;
        for (let i = 0; i < nSeg; i++) {
          if (fatti[i] > 0) tot = i * perSeg + fatti[i];
        }
        return tot;
      } catch (e) {
        for (const p of procs) p.kill("SIGKILL");
        throw e;
      } finally {
        await pcmFd?.close().catch(() => undefined);
      }
    };

    emit({ phase: "video", frame: 0, totalFrames, percent: 0 });
    const nSeg = segmentiPerVideo(req, duration, await probePixel(req.sourcePath));
    let written: number;
    if (nSeg > 1) {
      try {
        written = await convertiParallelo(nSeg);
      } catch (e) {
        /* La via nuova non deve poter togliere una conversione che la vecchia
           avrebbe fatto: un contenitore su cui il salto non funziona, un
           codec che l'hardware rifiuta male. Si ricomincia da capo a un pezzo
           solo — il file viene riscritto dall'inizio, e ciò che i pezzi
           avevano messo più avanti va tolto, o resterebbe in coda. */
        console.warn(
          `[video] conversione a pezzi fallita, ripiego su un ffmpeg solo: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        await outFd.truncate(AV_HEADER_BYTES);
        written = await convertiSeriale();
      }
    } else {
      written = await convertiSeriale();
    }

    // ---- Rewrite header with effective frame_count ---------------------
    if (written !== totalFrames) {
      const finalHeader = buildAvHeader({
        flags,
        fps,
        audioSampleRate: sr,
        audioChannels: ch,
        audioBitsPerSample: AUDIO_BITS,
        audioBlockBytes,
        frameCount: written,
        videoFrameBytes: VIDEO_FRAME_BYTES,
      });
      await outFd.write(finalHeader, 0, finalHeader.length, 0);
    }

    emit({ phase: "done", frame: written, totalFrames: written, percent: 100 });
    const fileStat = await stat(outPath);
    return {
      outputPath: outPath,
      frameCount: written,
      bytes: fileStat.size,
      durationSec: duration,
      fps,
    };
  } finally {
    await outFd.close().catch(() => undefined);
    await audioReader.close().catch(() => undefined);
    if (existsSync(tmpPcm)) await unlink(tmpPcm).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
//  Smoke-test util (export per autotest diagnostici)
// ---------------------------------------------------------------------------

/** Genera un .av sintetico (un solo frame fade) per validare il writer
 *  senza dipendere da ffmpeg. Ritorna il Buffer del file completo. */
export function smokeBuildSingleFrameAv(): Buffer {
  const fps = 30;
  const sr = 48000;
  const ch = 2;
  const samplesPerFrame = sr / fps;
  const audioBlockBytes = samplesPerFrame * ch * 2;

  const header = buildAvHeader({
    flags: AV_FLAG_HAS_AUDIO,
    fps,
    audioSampleRate: sr,
    audioChannels: ch,
    audioBitsPerSample: AUDIO_BITS,
    audioBlockBytes,
    frameCount: 1,
    videoFrameBytes: VIDEO_FRAME_BYTES,
  });
  const audio = Buffer.alloc(audioBlockBytes); // silenzio

  // Frame logico fade orizzontale (Floyd-Steinberg di un gradiente).
  const gray = new Uint8Array(FRAME_PIXELS);
  for (let y = 0; y < LOGIC_H; y++) {
    for (let x = 0; x < LOGIC_W; x++) {
      gray[y * LOGIC_W + x] = Math.round((x / (LOGIC_W - 1)) * 255);
    }
  }
  const bw = ditherFrame(gray, { mode: "floyd_steinberg" });
  const frame = buildFrameBitstream(bw);

  return Buffer.concat([header, audio, frame]);
}

// Re-export per consentire test diagnostici diretti senza spawn ffmpeg.
export async function writeRawTestAv(targetPath: string): Promise<void> {
  await writeFile(targetPath, smokeBuildSingleFrameAv());
}

export async function probeFfmpegBin(): Promise<{ available: boolean; version?: string; error?: string }> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    const p = spawn(getFfmpegPathSync(), ["-version"]);
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", (e) => resolve({ available: false, error: e.message }));
    p.on("close", (code) => {
      if (code === 0) {
        resolve({ available: true, version: out.split("\n")[0]?.trim() });
      } else {
        resolve({ available: false, error: err || `exit ${code}` });
      }
    });
  });
}

/** Lettura file di debugging utile in test. */
export async function _readFile(p: string): Promise<Buffer> {
  return readFile(p);
}

// ---------------------------------------------------------------------------
//  Preview: estrae un singolo frame dithered al timestamp richiesto.
//  Usa lo stesso scale/letterbox + dither di convertVideo così la preview
//  è bit-exact rispetto a quello che finirà nel .av.
// ---------------------------------------------------------------------------

import type {
  VideoPreviewRequest,
  VideoPreviewResponse,
  VideoProbeRequest,
  VideoProbeResponse,
} from "../../shared/ipc-types";

export async function probeVideoSource(
  req: VideoProbeRequest,
): Promise<VideoProbeResponse> {
  await stat(req.sourcePath);
  const durationSec = await probeDuration(req.sourcePath);
  return { durationSec };
}

function extractSingleFrameGray(
  sourcePath: string,
  timeSec: number,
  fitMode: "fit" | "fill" | "stretch",
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const args = [
      "-nostdin", "-hide_banner", "-loglevel", "error",
      // -ss prima di -i = fast seek al keyframe più vicino: ok per la preview.
      "-ss", String(Math.max(0, timeSec)),
      "-i", sourcePath,
      "-frames:v", "1",
      "-an",
      "-vf", buildVideoFilter(fitMode),
      "-pix_fmt", "gray",
      "-f", "rawvideo",
      "-",
    ];
    const chunks: Buffer[] = [];
    let err = "";
    const p = spawn(getFfmpegPathSync(), args);
    p.stdout.on("data", (d: Buffer) => chunks.push(d));
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) {
        return reject(
          new Error(
            `ffmpeg preview exit ${code}: ${err.trim() || "unknown"}`,
          ),
        );
      }
      const buf = Buffer.concat(chunks);
      if (buf.length < FRAME_PIXELS) {
        return reject(
          new Error(
            `ffmpeg preview: ricevuti ${buf.length} byte, attesi ${FRAME_PIXELS} (sorgente troncato o filtro errato).`,
          ),
        );
      }
      // Copia per slegarci dai chunks (che possono essere riusati).
      const out = new Uint8Array(FRAME_PIXELS);
      out.set(buf.subarray(0, FRAME_PIXELS));
      resolve(out);
    });
  });
}

export async function previewVideoFrame(
  req: VideoPreviewRequest,
): Promise<VideoPreviewResponse> {
  await stat(req.sourcePath);
  const duration = await probeDuration(req.sourcePath);
  // Clamp: evita di chiedere oltre la fine; lasciamo 50 ms di guardia.
  const requested = req.timeSec ?? 0;
  const timeSec = Math.max(0, Math.min(Math.max(0, duration - 0.05), requested));

  const gray = await extractSingleFrameGray(
    req.sourcePath,
    timeSec,
    req.fitMode ?? "fit",
  );
  const bw = ditherFrame(gray, {
    mode: req.ditherMode,
    threshold: req.threshold,
    adjust: req.adjust,
  });

  return {
    width: LOGIC_W,
    height: LOGIC_H,
    pixels: bw,
    durationSec: duration,
    timeSec,
  };
}
