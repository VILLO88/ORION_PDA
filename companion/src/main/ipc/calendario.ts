/**
 * Calendario: dal Mac al dispositivo.
 *
 * Il lavoro vero lo fanno due pezzi che stanno altrove:
 *   - `src/main/calendario/helper.swift`, un eseguibile che chiede a EventKit
 *     le **occorrenze gia' espanse** (niente ricorrenze da srotolare qui);
 *   - `src/main/calendario/cal.ts`, che le impacchetta nel formato `.cal`.
 *
 * Qui in mezzo c'e' solo il collegamento: trovare il binario, lanciarlo,
 * leggere il JSON. Vedi `PDAV3/CALENDARIO.md`.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { app } from "electron";

import { leggiIcs } from "../calendario/ics";
import {
  costruisciCal,
  type EventoOrion,
  type RisultatoCal,
} from "../calendario/cal";
import { writeFile } from "node:fs/promises";

/** Il nome del file sulla microSD: lo cerca il firmware in `cal_reader.h`. */
export const CAL_SOTTOCARTELLA = "calendar";
export const CAL_NOME_FILE = "calendar.cal";

function chiavePiattaforma(): string {
  return `darwin-${arch() === "arm64" ? "arm64" : "x64"}`;
}

/** Dove sta l'eseguibile: pacchettizzato o in sviluppo, come per ffmpeg. */
function percorsoHelper(): string | null {
  if (platform() !== "darwin") return null;
  const nome = "orion-calendario";
  const chiave = chiavePiattaforma();

  const candidati = app.isPackaged
    ? [join(process.resourcesPath, "calendario", chiave, nome)]
    : [
        resolve(__dirname, "..", "..", "src", "main", "resources", "calendario", chiave, nome),
        resolve(process.cwd(), "src", "main", "resources", "calendario", chiave, nome),
      ];

  for (const p of candidati) if (existsSync(p)) return p;
  return null;
}

type RispostaHelper = {
  ok: boolean;
  errore?: string;
  [k: string]: unknown;
};

/**
 * ⚠️ Il timeout non e' prudenza generica: la **prima** chiamata puo' fermarsi
 * sul pannello di consenso del sistema, che l'utente potrebbe non vedere
 * subito. Sessanta secondi lo aspettano; senza timeout, un "no" mai dato
 * lascerebbe l'app appesa per sempre.
 */
function lancia(args: string[], timeoutMs = 65_000): Promise<RispostaHelper> {
  const bin = percorsoHelper();
  if (!bin) {
    return Promise.resolve({
      ok: false,
      errore:
        platform() === "darwin"
          ? "helper del Calendario non compilato: npm run build:calendario"
          : "la lettura del Calendario esiste solo su macOS",
    });
  }

  return new Promise((risolvi) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          risolvi({
            ok: false,
            errore: `helper: ${err.message}${stderr ? ` (${stderr.trim()})` : ""}`,
          });
          return;
        }
        try {
          risolvi(JSON.parse(stdout) as RispostaHelper);
        } catch {
          risolvi({ ok: false, errore: `risposta illeggibile: ${stdout.slice(0, 200)}` });
        }
      });
  });
}

export type CalendarioVoce = {
  id: string;
  nome: string;
  conto: string;
  colore: string;
};

export async function calendariDisponibili(): Promise<{
  ok: boolean;
  errore?: string;
  calendari: CalendarioVoce[];
}> {
  const r = await lancia(["--calendari"]);
  if (!r.ok) return { ok: false, errore: r.errore, calendari: [] };
  return { ok: true, calendari: (r.calendari as CalendarioVoce[]) ?? [] };
}

export async function chiediPermesso(): Promise<{ ok: boolean; stato: string }> {
  const r = await lancia(["--permesso"]);
  return { ok: Boolean(r.ok), stato: String(r.stato ?? r.errore ?? "sconosciuto") };
}

function comeData(d: Date): string {
  return (
    `${d.getFullYear()}-` +
    `${String(d.getMonth() + 1).padStart(2, "0")}-` +
    `${String(d.getDate()).padStart(2, "0")}`
  );
}

export type FinestraCal = {
  /** Un `.ics` al posto del Calendario di sistema. */
  ics?: string;
  /** Giorni indietro da oggi (default 7). */
  indietro?: number;
  /** Giorni in avanti (default 120). */
  avanti?: number;
  /** Id dei calendari scelti. Vuoto = nessuno: non si manda tutto per sbaglio. */
  calendari: string[];
};

export async function leggiEventi(
  f: FinestraCal,
): Promise<{ ok: boolean; errore?: string; eventi: EventoOrion[] }> {
  const oggi = new Date();

  /* ⚠️ Il file vince sul Calendario di sistema, e non e' una gerarchia: sono
     due sorgenti che sboccano nella **stessa** forma, e da qui in giu' il
     percorso e' uno solo. Il dispositivo non sa da dove sono arrivati gli
     eventi, e non deve saperlo. */
  if (f.ics) {
    const da = new Date(oggi);
    da.setDate(da.getDate() - (f.indietro ?? 7));
    const a = new Date(oggi);
    a.setDate(a.getDate() + (f.avanti ?? 120));
    const r = await leggiIcs(f.ics, da, a);
    if (!r.ok) return { ok: false, errore: r.errore, eventi: [] };
    return { ok: true, eventi: r.eventi };
  }

  if (!f.calendari || f.calendari.length === 0) {
    return { ok: false, errore: "nessun calendario selezionato", eventi: [] };
  }
  const da2 = new Date(oggi);
  da2.setDate(da2.getDate() - (f.indietro ?? 7));
  const a2 = new Date(oggi);
  a2.setDate(a2.getDate() + (f.avanti ?? 120));

  const r = await lancia(["--eventi", comeData(da2), comeData(a2), ...f.calendari]);
  if (!r.ok) return { ok: false, errore: r.errore, eventi: [] };
  return { ok: true, eventi: (r.eventi as EventoOrion[]) ?? [] };
}

export type AnteprimaCal = RisultatoCal & {
  ok: boolean;
  errore?: string;
  /** Le prime righe, per far vedere **cosa si manda** prima di mandarlo. */
  esempi: string[];
};

/**
 * Costruisce il file senza scriverlo: serve alla pagina per mostrare quanti
 * eventi, quanti byte e che aspetto avranno i titoli **dopo** la traduzione
 * dei caratteri. ⚠️ Vedere prima cosa si manda e' l'unica difesa contro
 * l'errore piu' costoso: mandare il calendario sbagliato.
 */
export async function anteprimaCal(f: FinestraCal): Promise<AnteprimaCal> {
  const vuota: AnteprimaCal = {
    ok: false, eventi: 0, origine: 0, byte: 0,
    calendari: [], troncati: false, esempi: [],
  };
  const letti = await leggiEventi(f);
  if (!letti.ok) return { ...vuota, errore: letti.errore };

  const { info } = costruisciCal(letti.eventi);
  const esempi = letti.eventi.slice(0, 8).map((e) => {
    const quando = e.giornoIntero ? "tutto il giorno" : e.inizio.replace("T", " ");
    return `${quando}  ${e.titolo}`;
  });
  return { ...info, ok: true, esempi };
}

/** Scrive il `.cal` dove chiede il chiamante (la microSD, o un file di prova). */
export async function scriviCalIn(
  cartella: string,
  f: FinestraCal,
): Promise<{ ok: boolean; errore?: string; percorso?: string; info?: RisultatoCal }> {
  const letti = await leggiEventi(f);
  if (!letti.ok) return { ok: false, errore: letti.errore };

  const dir = join(cartella, CAL_SOTTOCARTELLA);
  const percorso = join(dir, CAL_NOME_FILE);
  try {
    await mkdir(dir, { recursive: true });
    const { buffer, info } = costruisciCal(letti.eventi);
    await writeFile(percorso, buffer);
    return { ok: true, percorso, info };
  } catch (e) {
    return { ok: false, errore: `non riesco a scrivere ${percorso}: ${String(e)}` };
  }
}

/** Il `.cal` in memoria, per mandarlo via Bluetooth (Fase 3). */
export async function calInMemoria(
  f: FinestraCal,
): Promise<{ ok: boolean; errore?: string; dati?: Uint8Array; info?: RisultatoCal }> {
  const letti = await leggiEventi(f);
  if (!letti.ok) return { ok: false, errore: letti.errore };
  const { buffer, info } = costruisciCal(letti.eventi);
  return { ok: true, dati: new Uint8Array(buffer), info };
}

export const _soloPerProve = { percorsoHelper, dirname };
