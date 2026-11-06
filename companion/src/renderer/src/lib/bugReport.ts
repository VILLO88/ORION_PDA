/**
 * Bug Report — costruzione del messaggio + apertura del client mail.
 *
 * Il modale raccoglie descrizione + passi per riprodurre dall'utente,
 * il resto è auto-compilato (system info, ffmpeg version, device connesso,
 * ultime attività dal log persistente). Il report finale viene anche
 * pre-formattato in Markdown-friendly così che incollarlo in una mail
 * o in un issue tracker resti leggibile.
 */

import type { DeviceInfo, FfmpegProbe, SystemInfo } from "@shared/ipc-types";
import type { ActivityEntry } from "./ActivityContext";

/** Destinatario del report. Modificare qui se cambia. */
export const BUG_REPORT_EMAIL = "info@mvlabs.org";

/** Subject fisso della mail, come richiesto. */
export const BUG_REPORT_SUBJECT = "orion_companion_bug";

/** Quante voci di Activity allegare (max). */
export const BUG_REPORT_ACTIVITY_LIMIT = 20;

/** mailto: ha un limite pratico (~2000 byte su Outlook/Windows; di più va
 *  bene su macOS Mail/Gmail web). Per stare al sicuro tagliamo il body
 *  oltre questa soglia e segnaliamo all'utente di incollare il resto. */
const MAILTO_BODY_SOFT_LIMIT = 1800;

export interface BugReportContext {
  description: string;
  steps: string;
  system: SystemInfo | null;
  ffmpeg: FfmpegProbe | null;
  device: DeviceInfo | null;
  activity: ActivityEntry[];
}

function formatSystemSection(s: SystemInfo | null): string {
  if (!s) return "(system info unavailable)";
  return [
    `- App version: ${s.appVersion}`,
    `- Platform:    ${s.platform} ${s.arch} (release ${s.osRelease})`,
    `- Electron:    ${s.electronVersion}`,
    `- Chrome:      ${s.chromeVersion}`,
    `- Node:        ${s.nodeVersion}`,
  ].join("\n");
}

function formatFfmpegSection(f: FfmpegProbe | null): string {
  if (!f) return "(not probed)";
  if (!f.available) return `not available — ${f.error ?? "unknown error"}`;
  return [
    `- Version: ${f.versionLine ?? "(unknown)"}`,
    f.bin ? `- Binary:  ${f.bin}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatDeviceSection(d: DeviceInfo | null): string {
  if (!d) return "(no device connected)";
  return [
    `- Label:       ${d.label}`,
    `- Mount path:  ${d.mountPath}`,
    `- Device ID:   ${d.deviceId ?? "(unknown)"}`,
    `- Firmware:    ${d.fwVersion ?? "(unknown)"}`,
    `- Last seen:   ${d.lastSeen ?? "(unknown)"}`,
  ].join("\n");
}

function formatActivitySection(entries: ActivityEntry[]): string {
  if (entries.length === 0) return "(no recent activity)";
  const head = entries.slice(0, BUG_REPORT_ACTIVITY_LIMIT);
  return head
    .map((e) => {
      const marker = e.status === "ok" ? "[ok]" : "[ERR]";
      const detail = e.detail ? ` — ${e.detail}` : "";
      return `- ${e.whenIso} ${marker} ${e.kind}: ${e.title}${detail}`;
    })
    .join("\n");
}

/** Compone il body completo del report (plain text, sezioni separate). */
export function formatBugReport(ctx: BugReportContext): string {
  const desc = ctx.description.trim() || "(no description provided)";
  const steps = ctx.steps.trim() || "(no steps provided)";

  return [
    "## Description",
    desc,
    "",
    "## Steps to reproduce",
    steps,
    "",
    "## System",
    formatSystemSection(ctx.system),
    "",
    "## ffmpeg",
    formatFfmpegSection(ctx.ffmpeg),
    "",
    "## Device",
    formatDeviceSection(ctx.device),
    "",
    "## Recent activity",
    formatActivitySection(ctx.activity),
    "",
  ].join("\n");
}

/** Subject della mail — fisso a `orion_companion_bug` come richiesto.
 *  Il context resta per simmetria con la chiamata, ma non viene usato:
 *  versione e descrizione finiscono comunque nel body. */
export function buildBugReportSubject(_ctx: BugReportContext): string {
  return BUG_REPORT_SUBJECT;
}

/** Costruisce l'URL `mailto:` con subject + body. Se il body supera la
 *  soglia, viene troncato e si appende una nota all'utente. Il caller
 *  dovrebbe comunque offrire "Copy full report to clipboard" per il caso
 *  in cui l'utente abbia bisogno del report completo. */
export function buildMailtoUrl(
  subject: string,
  body: string,
  to: string = BUG_REPORT_EMAIL,
): { url: string; truncated: boolean } {
  let finalBody = body;
  let truncated = false;
  if (body.length > MAILTO_BODY_SOFT_LIMIT) {
    finalBody =
      body.slice(0, MAILTO_BODY_SOFT_LIMIT) +
      "\n\n…(report truncated; use 'Copy full report' and paste here)";
    truncated = true;
  }
  const url =
    `mailto:${encodeURIComponent(to)}` +
    `?subject=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(finalBody)}`;
  return { url, truncated };
}
