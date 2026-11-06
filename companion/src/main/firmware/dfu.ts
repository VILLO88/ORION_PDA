/**
 * Wrapper per `dfu-util` — detect device + flash firmware + parse progress.
 *
 *  - detect:  `dfu-util -l` + parse output per device con VID:PID 0483:df11.
 *  - flash:   `dfu-util -a 0 -s 0x08000000:leave -D <bin>` con stdout/stderr
 *             streamati al callback per progress bar + log live.
 *  - cancel:  kill del subprocess in corso (best effort).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { getDfuUtilPath } from "./paths";
import type {
  DfuDevice,
  FirmwareFlashProgress,
  FirmwareFlashResult,
} from "../../shared/ipc-types";

export const ORION_DFU_VID = "0483";
export const ORION_DFU_PID = "df11";

/** Parsa l'output di `dfu-util -l`. Esempio:
 *   Found DFU: [0483:df11] ver=0200, devnum=14, cfg=1, intf=0,
 *     path="20-1", alt=0, name="@Internal Flash  /0x08000000/01*004Kg",
 *     serial="208E36886677"
 */
function parseDfuList(out: string): DfuDevice[] {
  const devices: DfuDevice[] = [];
  const re = /Found DFU:\s*\[([0-9a-f]{4}):([0-9a-f]{4})\][\s\S]*?serial="([^"]*)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(out)) !== null) {
    devices.push({
      vid: m[1].toLowerCase(),
      pid: m[2].toLowerCase(),
      serial: m[3],
      name: "STM32 BOOTLOADER",
    });
  }
  return devices;
}

export async function detectDfuDevice(): Promise<DfuDevice | null> {
  const bin = await getDfuUtilPath();
  if (!bin) {
    throw new Error(
      "dfu-util non trovato. Bundle non presente e binario non sul PATH.",
    );
  }
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    const p = spawn(bin, ["-l"], { stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => {
      // `dfu-util -l` torna 0 anche con nessun device trovato.
      if (code !== 0 && code !== null) {
        // Eccezione: se non c'è nessun device dfu-util a volte ritorna non-zero
        // su alcune versioni; preferiamo non rejectare in questo caso.
      }
      const devices = parseDfuList(out);
      const orion = devices.find(
        (d) => d.vid === ORION_DFU_VID && d.pid === ORION_DFU_PID,
      );
      void err; // ignored, ma utile in debug
      resolve(orion ?? null);
    });
  });
}

// ---------------------------------------------------------------------------
//  flash con parsing progress
// ---------------------------------------------------------------------------

export type FlashEmitter = (ev: FirmwareFlashProgress) => void;
export type LogEmitter = (line: string) => void;

let currentProc: ChildProcess | null = null;

/** Parsa una riga di stdout/stderr dfu-util ed eventualmente emette un
 *  FirmwareFlashProgress. La line di download tipica è:
 *
 *    Download	[=========================] 100%       123456 bytes
 *
 *  oppure (su versioni recenti, output multiline con \r):
 *
 *    Downloading to address = 0x08000000, size = 123456
 *    Download	[=========================] 100%       123456 bytes
 *    Download done.
 */
function parseProgressLine(
  line: string,
): FirmwareFlashProgress | null {
  // Linea "Download [...] PCT% BYTES bytes"
  const m = /Download\s*\[[^\]]*\]\s+(\d+)%\s+(\d+)\s+bytes/i.exec(line);
  if (m) {
    return {
      phase: "write",
      pct: Math.min(100, Math.max(0, parseInt(m[1], 10))),
      bytesWritten: parseInt(m[2], 10),
    };
  }
  if (/Erasing/i.test(line)) {
    return { phase: "erase", pct: 0, bytesWritten: 0 };
  }
  if (/Verifying/i.test(line)) {
    return { phase: "verify", pct: 0, bytesWritten: 0 };
  }
  return null;
}

export async function flashFirmware(
  binPath: string,
  onProgress: FlashEmitter,
  onLog: LogEmitter,
): Promise<FirmwareFlashResult> {
  if (currentProc) {
    return { ok: false, message: "Another flash is already in progress." };
  }
  const dfu = await getDfuUtilPath();
  if (!dfu) {
    return {
      ok: false,
      message:
        "dfu-util not found. Install with `brew install dfu-util` (macOS) or bundle the binary.",
    };
  }

  // Sanity check sul .bin
  const s = await stat(binPath).catch(() => null);
  if (!s) {
    return { ok: false, message: `Firmware file not found: ${binPath}` };
  }
  if (s.size < 4096) {
    return { ok: false, message: `Firmware file too small (${s.size} B). Likely not a valid .bin.` };
  }
  if (s.size > 2 * 1024 * 1024) {
    return {
      ok: false,
      message: `Firmware file too large (${(s.size / 1024 / 1024).toFixed(
        2,
      )} MB). STM32U575 flash is 2 MB.`,
    };
  }

  const args = ["-a", "0", "-s", "0x08000000:leave", "-D", binPath];

  return new Promise((resolve) => {
    let stderrTail = "";
    let downloadSucceeded = false;
    const proc = spawn(dfu, args, { stdio: ["ignore", "pipe", "pipe"] });
    currentProc = proc;

    const handleStream = (chunk: Buffer): void => {
      const text = chunk.toString();
      // dfu-util usa \r per la progress in-place — splittiamo su entrambi.
      const lines = text.split(/[\r\n]+/);
      for (const line of lines) {
        if (line.length === 0) continue;
        // "File downloaded successfully." è la prova definitiva che il flash
        // è andato a buon fine, prima del "leave" che fa rebootare il device
        // (e quindi fallire l'ultimo get_status → exit code != 0).
        if (/File downloaded successfully/i.test(line)) {
          downloadSucceeded = true;
        }
        onLog(line);
        const ev = parseProgressLine(line);
        if (ev) onProgress(ev);
      }
    };

    proc.stdout.on("data", handleStream);
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4096);
      handleStream(chunk);
    });

    proc.on("error", (e) => {
      currentProc = null;
      resolve({ ok: false, message: e.message });
    });

    proc.on("close", (code) => {
      currentProc = null;
      if (code === 0 || downloadSucceeded) {
        // exit != 0 dopo "File downloaded successfully" è normale con :leave —
        // il device reboota prima di rispondere al get_status finale.
        onProgress({ phase: "write", pct: 100, bytesWritten: s.size });
        resolve({
          ok: true,
          message: "Firmware flashed successfully. Device rebooting…",
        });
      } else {
        resolve({
          ok: false,
          message: `dfu-util exit ${code}`,
          stderr: stderrTail.trim(),
        });
      }
    });
  });
}

export function cancelFlash(): void {
  if (currentProc) {
    try {
      currentProc.kill("SIGTERM");
    } catch {
      // ignored
    }
    currentProc = null;
  }
}
