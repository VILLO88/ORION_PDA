/**
 * Device discovery: trova dispositivi Orion tra i volumi USB montati.
 *
 * Strategia: scan dei mount points specifici per piattaforma, poi
 * apertura di `.orion-device` (JSON) nella root. Match se `magic` ===
 * "ORION_DEVICE". Niente dipendenze native (drivelist & co. evitabili).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, join } from "node:path";
import { platform } from "node:os";
import type {
  DeviceEjectRequest,
  DeviceEjectResponse,
  DeviceInfo,
  DeviceListResponse,
} from "../../shared/ipc-types";

export const MARKER_FILENAME = ".orion-device";
export const MARKER_MAGIC = "ORION_DEVICE";

/** Lista i mount points candidati (qualsiasi volume montato), non
 *  necessariamente Orion. Filtraggio Orion avviene in `probeMarker`. */
async function listCandidateMounts(): Promise<string[]> {
  const plat = platform();
  const out: string[] = [];

  if (plat === "darwin") {
    try {
      const entries = await readdir("/Volumes");
      for (const e of entries) out.push(join("/Volumes", e));
    } catch {
      /* niente /Volumes? improbabile su macOS */
    }
  } else if (plat === "linux") {
    const user = process.env.USER ?? process.env.USERNAME ?? "user";
    for (const base of [`/media/${user}`, `/run/media/${user}`, "/media", "/mnt"]) {
      try {
        const entries = await readdir(base);
        for (const e of entries) {
          const full = join(base, e);
          try {
            const s = await stat(full);
            if (s.isDirectory()) out.push(full);
          } catch {
            /* skip */
          }
        }
      } catch {
        /* base non esiste, passa al successivo */
      }
    }
  } else if (plat === "win32") {
    // Enumera drive letters A: → Z:. readdir su drive non presente
    // throwa ENOENT istantaneamente, niente lock né freeze.
    const probes: Promise<string | null>[] = [];
    for (let code = 65 /* 'A' */; code <= 90 /* 'Z' */; code++) {
      const letter = String.fromCharCode(code);
      const root = `${letter}:\\`;
      probes.push(
        readdir(root)
          .then(() => root)
          .catch(() => null),
      );
    }
    for (const r of await Promise.all(probes)) if (r) out.push(r);
  }

  return out;
}

/** Legge `.orion-device` nella root del mount. Ritorna null se non c'è
 *  o se il magic non combacia. */
async function probeMarker(mountPath: string): Promise<DeviceInfo | null> {
  const markerPath = join(mountPath, MARKER_FILENAME);
  let raw: string;
  try {
    raw = await readFile(markerPath, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.magic !== MARKER_MAGIC) return null;

  return {
    mountPath,
    deviceId: typeof obj.device_id === "string" ? obj.device_id : null,
    fwVersion: typeof obj.fw_version === "string" ? obj.fw_version : null,
    lastSeen: typeof obj.last_seen === "string" ? obj.last_seen : null,
    label: basename(mountPath) || mountPath,
  };
}

/** One-shot scan completo. */
export async function listOrionDevices(): Promise<DeviceListResponse> {
  const mounts = await listCandidateMounts();
  const probed = await Promise.all(mounts.map(probeMarker));
  return { devices: probed.filter((d): d is DeviceInfo => d !== null) };
}

// ---------------------------------------------------------------------------
//  Watcher: polling ogni N ms con emit-on-change
// ---------------------------------------------------------------------------

const WATCH_INTERVAL_MS = 2000;

let watchTimer: NodeJS.Timeout | null = null;
let lastSignature = "";

function devicesSignature(devices: DeviceInfo[]): string {
  return devices
    .map((d) => `${d.mountPath}|${d.deviceId ?? ""}|${d.fwVersion ?? ""}`)
    .sort()
    .join("\n");
}

export type DeviceWatchEmit = (devices: DeviceInfo[]) => void;

export function startDeviceWatch(emit: DeviceWatchEmit): void {
  if (watchTimer) return;
  const tick = async (): Promise<void> => {
    try {
      const { devices } = await listOrionDevices();
      const sig = devicesSignature(devices);
      if (sig !== lastSignature) {
        lastSignature = sig;
        emit(devices);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("device watch tick failed", err);
    }
  };
  void tick();
  watchTimer = setInterval(() => void tick(), WATCH_INTERVAL_MS);
}

export function stopDeviceWatch(): void {
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = null;
  lastSignature = "";
}

// ---------------------------------------------------------------------------
//  Eject sicuro del volume — cross-platform via comandi nativi
// ---------------------------------------------------------------------------

function runCmd(
  cmd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    p.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    p.on("error", (e) =>
      resolve({ code: -1, stdout: "", stderr: e.message }),
    );
    p.on("close", (code) =>
      resolve({ code: code ?? -1, stdout, stderr }),
    );
  });
}

export async function ejectDevice(
  req: DeviceEjectRequest,
): Promise<DeviceEjectResponse> {
  const mp = req.mountPath;
  if (!mp) return { ok: false, message: "mountPath mancante" };

  const plat = platform();
  if (plat === "darwin") {
    // diskutil eject smonta + alimenta off l'unità rimovibile.
    const r = await runCmd("diskutil", ["eject", mp]);
    return {
      ok: r.code === 0,
      message: r.code === 0 ? r.stdout.trim() : (r.stderr.trim() || r.stdout.trim()),
    };
  }

  if (plat === "linux") {
    // udisksctl gestisce mount automount-friendly. Fallback a umount.
    let r = await runCmd("udisksctl", ["unmount", "-b", mp]);
    if (r.code !== 0) {
      // Riprova con umount classico (richiede permessi sull'mountpoint).
      r = await runCmd("umount", [mp]);
    }
    return {
      ok: r.code === 0,
      message: r.code === 0 ? "unmounted" : (r.stderr.trim() || r.stdout.trim()),
    };
  }

  if (plat === "win32") {
    // Windows: usiamo PowerShell + Shell.Application.NameSpace(17).ParseName(L).InvokeVerb("Eject")
    // mp è del tipo "E:\\" → estraiamo la lettera.
    const letter = mp.replace(/[\\:].*$/, "").toUpperCase();
    if (!/^[A-Z]$/.test(letter)) {
      return { ok: false, message: `mountPath non riconosciuto: ${mp}` };
    }
    const ps = [
      "$drive = (New-Object -comObject Shell.Application).NameSpace(17).ParseName('" + letter + ":');",
      "if ($drive) { $drive.InvokeVerb('Eject'); 'ok' } else { 'drive not found'; exit 1 }",
    ].join(" ");
    const r = await runCmd("powershell", ["-NoProfile", "-Command", ps]);
    return {
      ok: r.code === 0,
      message: r.code === 0 ? "ejected" : (r.stderr.trim() || r.stdout.trim()),
    };
  }

  return { ok: false, message: `Piattaforma "${plat}" non supportata` };
}
