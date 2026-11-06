/**
 * MP3 manager — porta i file audio sulla SD del device, convertendoli **solo
 * se serve**.
 *
 * ⚠️ **Un MP3 non si riconverte piu'** (20 settembre 2026). Fino a ieri ogni
 * file passava per libmp3lame perche' il firmware accettava solo 48 kHz;
 * dal 15/9/2026 il lettore ricampiona da solo qualunque frequenza **fino a**
 * 48 kHz, quindi un MP3 a 44,1 suona senza toccarlo.
 *
 * E riconvertire un MP3 vuol dire **decodificarlo e ricodificarlo**: la
 * codifica MP3 e' con perdita, quindi si buttava via qualita' a ogni
 * passaggio anche ricodificando a 320 kbps. Chi ci mette sopra la sua musica
 * se ne accorgeva.
 *
 * ⚠️ E il caso limite non esiste: il formato MP3 **non puo'** superare i
 * 48 kHz. MPEG-1 Layer III ammette 32/44,1/48, MPEG-2 16/22,05/24,
 * MPEG-2.5 8/11,025/12. Quindi "un MP3 si copia sempre" e' una regola senza
 * eccezioni, non una scommessa.
 *
 * Le due strade:
 *
 *   MP3  →  **copia** (`-c:a copy`): il flusso audio esce identico al byte,
 *           si riscrivono solo i tag ID3 che servono al device per ordinare
 *           l'album. Istantaneo.
 *
 *   tutto il resto (FLAC, WAV, ALAC, AAC, OGG…) →  loudnorm
 *           → libmp3lame **CBR 320 kbps** se il sorgente e' lossless,
 *             CBR clamp(src, 192, 320) se e' gia' lossy,
 *             VBR q=2 se la probe non ha detto niente.
 *
 * ⚠️ **CBR e non VBR, e c'e' una ragione che vale solo su questo
 * dispositivo**: il firmware stima la durata del brano dal bitrate del
 * **primo frame**. Con un CBR il conto e' esatto; con un VBR la barra di
 * avanzamento e il tempo residuo sbagliano per tutto il brano.
 *
 * Progress: parsing dello stderr di ffmpeg (`time=HH:MM:SS.xx`) confrontato
 * con la durata totale ottenuta da una chiamata ffprobe iniziale.
 */

import { spawn } from "node:child_process";
import { getFfmpegPathSync, getFfprobePathSync } from "../ffmpeg/paths";
import { writeAlbumCover, writeCoverFromUrl } from "./cover";
import { mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, join, parse as parsePath } from "node:path";
import type {
  FfmpegProbe,
  Mp3ConvertRequest,
  Mp3ConvertResponse,
  Mp3JobInput,
  Mp3JobResult,
  Mp3ProgressEvent,
} from "../../shared/ipc-types";

export type Mp3ProgressEmitter = (ev: Mp3ProgressEvent) => void;

const DEFAULT_LUFS = -14;

// ---------------------------------------------------------------------------
//  Probing
// ---------------------------------------------------------------------------

/** Esegue `<bin> -version` e ritorna la prima riga di stdout. */
function runProbe(bin: string): Promise<{ ok: boolean; firstLine?: string; err?: string }> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    const p = spawn(bin, ["-version"]);
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", (e) => resolve({ ok: false, err: e.message }));
    p.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, firstLine: out.split("\n")[0]?.trim() });
      } else {
        resolve({ ok: false, err: err || `exit code ${code}` });
      }
    });
  });
}

export async function probeFfmpeg(): Promise<FfmpegProbe> {
  const bin = getFfmpegPathSync();
  const r = await runProbe(bin);
  if (r.ok) {
    return { available: true, versionLine: r.firstLine, bin };
  }
  return { available: false, error: r.err };
}

// ---------------------------------------------------------------------------
//  Source probe via ffprobe (best effort)
//
//  Restituisce durata, codec dello stream audio, e bitrate effettivo (stream
//  o format-level fallback). Usato sia per la barra di progresso sia per la
//  scelta del bitrate di output (vedi pickEncoderArgs).
// ---------------------------------------------------------------------------

interface SourceInfo {
  durationSec: number | null;
  codec: string | null;
  /** Bitrate in kbps (stream a:0 se disponibile, altrimenti format/8). */
  bitrateKbps: number | null;
  /** Frequenza di campionamento, Hz. Serve a non ricampionare per niente. */
  sampleRate: number | null;
  /** Canali del sorgente: un mono non va gonfiato a stereo. */
  channels: number | null;
}

// Codec audio considerati lossless: vengono sempre transcodati a CBR 320.
const LOSSLESS_CODECS = new Set([
  "flac",
  "alac",
  "wavpack",
  "tta",
  "ape",
  "monkeysaudio",
  "truehd",
  "mlp",
  "pcm_s8",
  "pcm_u8",
  "pcm_s16le",
  "pcm_s16be",
  "pcm_s24le",
  "pcm_s24be",
  "pcm_s32le",
  "pcm_s32be",
  "pcm_f32le",
  "pcm_f32be",
  "pcm_f64le",
  "pcm_f64be",
]);

function probeSource(sourcePath: string): Promise<SourceInfo> {
  return new Promise((resolve) => {
    const args = [
      "-v", "error",
      "-print_format", "json",
      "-show_entries",
      "stream=codec_name,codec_type,bit_rate,sample_rate,channels:format=duration,bit_rate",
      "-select_streams", "a:0",
      sourcePath,
    ];
    let out = "";
    const p = spawn(getFfprobePathSync(), args);
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    const vuoto: SourceInfo = {
      durationSec: null, codec: null, bitrateKbps: null,
      sampleRate: null, channels: null,
    };
    p.on("error", () => resolve(vuoto));
    p.on("close", (code) => {
      if (code !== 0) return resolve(vuoto);
      try {
        const j = JSON.parse(out) as {
          streams?: {
            codec_name?: string;
            bit_rate?: string;
            sample_rate?: string;
            channels?: number;
          }[];
          format?: { duration?: string; bit_rate?: string };
        };
        const stream = j.streams?.[0];
        const codec = stream?.codec_name?.toLowerCase() ?? null;

        const durRaw = parseFloat(j.format?.duration ?? "");
        const durationSec =
          Number.isFinite(durRaw) && durRaw > 0 ? durRaw : null;

        const streamBr = parseInt(stream?.bit_rate ?? "", 10);
        const formatBr = parseInt(j.format?.bit_rate ?? "", 10);
        const bps = Number.isFinite(streamBr) && streamBr > 0
          ? streamBr
          : Number.isFinite(formatBr) && formatBr > 0
            ? formatBr
            : null;
        const bitrateKbps = bps !== null ? Math.round(bps / 1000) : null;

        const sr = parseInt(stream?.sample_rate ?? "", 10);
        const sampleRate = Number.isFinite(sr) && sr > 0 ? sr : null;
        const ch = stream?.channels;
        const channels = Number.isFinite(ch) && (ch as number) > 0
          ? (ch as number) : null;

        resolve({ durationSec, codec, bitrateKbps, sampleRate, channels });
      } catch {
        resolve(vuoto);
      }
    });
  });
}

/** Un MP3 si copia, tutto il resto si converte.
 *
 *  ⚠️ Non c'e' un controllo sulla frequenza, e non e' una dimenticanza: il
 *  formato MP3 non puo' superare i 48 kHz (MPEG-1 32/44,1/48, MPEG-2
 *  16/22,05/24, MPEG-2.5 8/11,025/12) e il firmware ricampiona da solo tutto
 *  cio' che sta sotto. Non esiste un MP3 che il device non sappia suonare. */
function siCopia(src: SourceInfo): boolean {
  return src.codec === "mp3";
}

/** La frequenza a cui codificare.
 *
 *  ⚠️ **Si resta nella famiglia del sorgente**, e da oggi si puo': il firmware
 *  suona 44,1 kHz senza problemi, quindi portare un FLAC da 44,1 a 48 sarebbe
 *  un ricampionamento in piu' — cioe' una perdita — **per niente**. 88,2 e
 *  176,4 scendono a 44,1 (rapporto intero, filtro pulito), 96 e 192 a 48.
 *
 *  ⚠️ Sopra i 48 kHz il firmware rifiuta davvero, quindi qui si scende sempre:
 *  interpolare verso l'alto non genera alias, scendere si' e pretende un
 *  filtro — che e' esattamente cio' che ffmpeg fa qui, una volta sola, sul
 *  PC. */
function frequenzaUscita(src: SourceInfo): number {
  const sr = src.sampleRate;
  if (sr === null) return 48000;
  if (sr === 44100 || sr === 48000) return sr;
  if (sr % 44100 === 0) return 44100;     // 88,2 · 176,4
  if (sr % 48000 === 0) return 48000;     // 96 · 192
  if (sr < 48000) return sr;              // 32, 22,05, … il device li suona
  return 48000;
}

/** Sceglie gli args ffmpeg per il bitrate in base al sorgente.
 *
 *  - Lossless (FLAC, WAV, ALAC, PCM, …) → CBR 320 kbps.
 *  - Lossy con bitrate noto → CBR pari al sorgente, clampato a [192, 320].
 *  - Fallback (codec/bitrate ignoti) → VBR q=2 (~190 kbps). */
function pickEncoderArgs(src: SourceInfo): { args: string[]; label: string } {
  const isLossless = src.codec !== null && LOSSLESS_CODECS.has(src.codec);
  if (isLossless) {
    return { args: ["-b:a", "320k"], label: "CBR 320k (lossless source)" };
  }
  if (src.bitrateKbps !== null) {
    const target = Math.max(192, Math.min(320, src.bitrateKbps));
    return {
      args: ["-b:a", `${target}k`],
      label: `CBR ${target}k (source ~${src.bitrateKbps} kbps)`,
    };
  }
  return { args: ["-q:a", "2"], label: "VBR q=2 (~190 kbps, fallback)" };
}

// ---------------------------------------------------------------------------
//  ffmpeg single-file conversion with progress
// ---------------------------------------------------------------------------

function parseTimeFromStderr(line: string): number | null {
  const m = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

interface TrackMeta {
  /** Numero traccia da scrivere nel tag ID3 (TRCK) per l'ordinamento. */
  track?: number;
  /** Titolo pulito da scrivere nel tag ID3 (TIT2). */
  title?: string;
}

function convertOne(
  inputPath: string,
  outputPath: string,
  durationSec: number | null,
  targetLufs: number,
  encoderArgs: string[],
  meta: TrackMeta,
  onPercent: (pct: number) => void,
  /** `null` = copia il flusso senza ricodificare (sorgente gia' MP3). */
  codifica: { sampleRate: number; channels: number } | null,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const af = `loudnorm=I=${targetLufs}:TP=-1:LRA=11`;

    /* ⚠️ **La copia non e' "ffmpeg con meno opzioni": e' un'altra cosa.**
       `-c:a copy` rimuxa, cioe' riscrive il contenitore e i tag lasciando il
       flusso audio **identico al byte**. Niente loudnorm (normalizzare vuol
       dire ricodificare), niente resample, niente perdita. I tag si
       riscrivono lo stesso perche' il device ordina l'album per numero di
       traccia, non per nome file. */
    const argsCopia = [
      "-y",
      "-i", inputPath,
      "-vn",
      "-c:a", "copy",
    ];

    const argsCodifica = [
      "-y",
      "-i", inputPath,
      "-vn",                          // ignora video tag (cover art ecc.)
      "-ar", String(codifica?.sampleRate ?? 48000),
      "-ac", String(codifica?.channels ?? 2),
      "-af", af,
      "-c:a", "libmp3lame",
      ...encoderArgs,
    ];

    const args = [
      ...(codifica === null ? argsCopia : argsCodifica),
      "-id3v2_version", "3",
      // Metadata per il player del firmware: il numero traccia preserva
      // l'ordine dell'album (il device altrimenti ordina per nome file), il
      // titolo riflette il nome pulito. artist/album restano dai tag sorgente
      // (ffmpeg copia i metadata globali per default).
      ...(meta.track != null ? ["-metadata", `track=${meta.track}`] : []),
      ...(meta.title ? ["-metadata", `title=${meta.title}`] : []),
      outputPath,
    ];

    const p = spawn(getFfmpegPathSync(), args);
    let stderrBuf = "";
    let stderrTail = "";

    p.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderrBuf += s;
      // Tail per parsing time= (ffmpeg manda ogni riga in chunk separati).
      stderrTail = (stderrTail + s).slice(-2048);
      const t = parseTimeFromStderr(stderrTail);
      if (t !== null && durationSec && durationSec > 0) {
        const pct = Math.min(100, Math.max(0, (t / durationSec) * 100));
        onPercent(pct);
      }
    });

    p.on("error", (e) => resolve({ ok: false, error: e.message }));
    p.on("close", (code) => {
      if (code === 0) {
        onPercent(100);
        resolve({ ok: true });
      } else {
        // Estrai le ultime linee di stderr come messaggio d'errore.
        const lines = stderrBuf.trim().split("\n");
        const tail = lines.slice(-6).join("\n");
        resolve({ ok: false, error: tail || `ffmpeg exit ${code}` });
      }
    });
  });
}

// ---------------------------------------------------------------------------
//  Batch convert + upload
// ---------------------------------------------------------------------------

async function ensureDir(p: string): Promise<void> {
  if (!existsSync(p)) await mkdir(p, { recursive: true });
}

function sanitizeFolder(folder: string): string {
  // Normalizza separatori, blocca path traversal.
  const cleaned = folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").trim();
  if (cleaned === "" || cleaned.includes("..")) return "music";
  return cleaned;
}

function sanitizeFilename(name: string): string {
  // 1) Normalizza NFC: macOS legge i nomi file in NFD (es. "è" = "e" + U+0300).
  //    Sul firmware il font ha solo i codepoint precomposti, quindi senza fold
  //    NFD→NFC l'accento isolato cadeva su '?'. La conversione qui assicura
  //    che il nome scritto sulla SD sia già precomposto.
  // 2) Sostituisce i caratteri vietati da FAT/exFAT (< > : " / \ | ? * e ctrl).
  return name.normalize("NFC").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

function buildOutputPath(
  targetDir: string,
  job: Mp3JobInput,
): string {
  const parsed = parsePath(job.sourcePath);
  const baseName = sanitizeFilename(
    (job.outputBaseName ?? parsed.name).trim() || parsed.name,
  );
  return join(targetDir, `${baseName}.mp3`);
}

/** Estrae il numero di traccia dal nome file originale (es. "01 Title",
 *  "02.Title", "3 - Title" → 1/2/3). Null se non c'è un numero iniziale. */
function parseLeadingTrackNo(name: string): number | null {
  const m = name.match(/^\s*(\d{1,3})\b/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Titolo "pulito" da scrivere nel tag ID3 (può contenere caratteri vietati
 *  nei filename, qui non sanitizziamo). */
function cleanTitle(job: Mp3JobInput): string {
  const parsed = parsePath(job.sourcePath);
  return (job.outputBaseName ?? parsed.name).trim() || parsed.name;
}

/** Risolve la directory di output:
 *  - device:   <mountPath>/music/<folder>
 *  - locale:   <localOutDir>/<folder>   (default ~/Documents/Orion/music-export/<folder>) */
function resolveTargetDir(req: Mp3ConvertRequest, folder: string): string {
  if (req.mountPath) {
    return join(req.mountPath, "music", folder);
  }
  if (req.localOutDir && req.localOutDir.trim().length > 0) {
    return join(req.localOutDir, folder);
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
  return join(home, "Documents", "Orion", "music-export", folder);
}

async function uniquePath(target: string): Promise<string> {
  if (!existsSync(target)) return target;
  const { dir, name, ext } = parsePath(target);
  let i = 1;
  while (existsSync(join(dir, `${name} (${i})${ext}`))) i++;
  return join(dir, `${name} (${i})${ext}`);
}

export async function convertAndUpload(
  req: Mp3ConvertRequest,
  emit: Mp3ProgressEmitter,
): Promise<Mp3ConvertResponse> {
  const folder = sanitizeFolder(req.folder);
  const targetDir = resolveTargetDir(req, folder);
  await ensureDir(targetDir);
  const lufs = req.targetLufs ?? DEFAULT_LUFS;

  const results: Mp3JobResult[] = [];

  for (let i = 0; i < req.jobs.length; i++) {
    const job = req.jobs[i];

    // Phase: probe
    emit({ jobIndex: i, sourcePath: job.sourcePath, phase: "probe" });

    // Verifica esistenza sorgente.
    try {
      await stat(job.sourcePath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      emit({
        jobIndex: i,
        sourcePath: job.sourcePath,
        phase: "error",
        error: msg,
      });
      results.push({
        sourcePath: job.sourcePath,
        outputPath: "",
        ok: false,
        error: msg,
      });
      continue;
    }

    const source = await probeSource(job.sourcePath);
    const copia = siCopia(source);
    const encoder = pickEncoderArgs(source);
    const outputPath = await uniquePath(buildOutputPath(targetDir, job));

    /* ⚠️ I canali non si gonfiano: un mono che diventa stereo raddoppia il
       file per niente, e il firmware il mono lo suona. Si taglia solo
       l'eccesso — un 5.1 non lo suonerebbe nessuno. */
    const canali = Math.min(2, Math.max(1, source.channels ?? 2));

    // Numero traccia per preservare l'ordine dell'album nel player del
    // firmware (che ordina per tag traccia, non per nome file): preso dal
    // numero iniziale del nome file originale, altrimenti dalla posizione in
    // coda (1-based), che riflette già l'ordine alfabetico dei sorgenti.
    const trackNo = parseLeadingTrackNo(parsePath(job.sourcePath).name) ?? i + 1;

    // Phase: convert
    emit({
      jobIndex: i,
      sourcePath: job.sourcePath,
      phase: "convert",
      percent: 0,
    });

    const r = await convertOne(
      job.sourcePath,
      outputPath,
      source.durationSec,
      lufs,
      encoder.args,
      { track: trackNo, title: cleanTitle(job) },
      (pct) =>
        emit({
          jobIndex: i,
          sourcePath: job.sourcePath,
          phase: "convert",
          percent: pct,
        }),
      copia ? null : { sampleRate: frequenzaUscita(source), channels: canali },
    );

    if (!r.ok) {
      emit({
        jobIndex: i,
        sourcePath: job.sourcePath,
        phase: "error",
        error: r.error,
      });
      results.push({
        sourcePath: job.sourcePath,
        outputPath,
        ok: false,
        error: r.error,
      });
      continue;
    }

    emit({ jobIndex: i, sourcePath: job.sourcePath, phase: "done", percent: 100 });
    results.push({ sourcePath: job.sourcePath, outputPath, ok: true });
  }

  // Album cover → cover.bin (1bpp 200×200) nella root dell'album. La scelta
  // arriva dal picker della UI; default "embedded" per retro-compatibilità.
  // Best-effort: un errore non compromette la conversione audio già fatta.
  let coverWritten = false;
  const coverChoice = req.cover ?? { kind: "embedded" as const };
  try {
    if (coverChoice.kind === "url") {
      coverWritten = (await writeCoverFromUrl(targetDir, coverChoice.url)) !== null;
    } else if (coverChoice.kind === "embedded") {
      const coverPath = await writeAlbumCover(
        targetDir,
        req.jobs.map((j) => j.sourcePath),
      );
      coverWritten = coverPath !== null;
    }
    // kind === "none" → nessuna copertina.
  } catch {
    coverWritten = false;
  }

  return { results, coverWritten };
}

// ---------------------------------------------------------------------------
//  Helper esposto per test / accettare path direttamente (no drag-drop)
// ---------------------------------------------------------------------------

export function looksLikeAudio(p: string): boolean {
  const ext = extname(p).toLowerCase();
  return [".mp3", ".flac", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".wma"].includes(ext);
}

export function defaultBaseName(p: string): string {
  return basename(p, extname(p));
}
