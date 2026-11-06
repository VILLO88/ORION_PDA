/**
 * Scrittore del formato `.cal` che legge il dispositivo.
 *
 * Spec: `PDAV3/CALENDARIO.md` §4. Il riferimento eseguibile e'
 * `PDAV3/prove_pc/finto_calendario.py`, e il lettore vero e'
 * `ORIONV3_IDE/Core/Src/cal_reader.c` — provato sul PC contro i file di quello
 * script (`prove_pc/cal_file.c`).
 *
 * ⚠️ **Qui si fa tutto il lavoro di calendario.** Il dispositivo non sa cosa
 * siano ricorrenze, fusi orari e ora legale: riceve occorrenze singole, gia'
 * ordinate, con l'ora di parete locale. Chi tocca questo file sta tenendo in
 * piedi quella promessa.
 */

import { writeFile } from "node:fs/promises";

export const MAGIC = Buffer.from("ORCAL1\0\0", "latin1");
export const VERSIONE = 1;
export const DURATA_GIORNO = 0xffff;

export const F_GIORNO_INTERO = 0x01;
export const F_CONTINUA = 0x02;
export const F_ANNULLATO = 0x04;

/** Tetto del lettore: oltre, il file viene rifiutato dal dispositivo. */
export const EVENTI_MAX = 2000;

/** Byte utili, terminatore escluso (cal_reader.h). */
const TITOLO_MAX = 63;
const LUOGO_MAX = 39;
const NOME_CAL_MAX = 31;
const CALENDARI_MAX = 16;

export type EventoOrion = {
  titolo: string;
  luogo: string;
  calendario: string;
  /** Ora di parete locale, "yyyy-MM-ddTHH:mm". */
  inizio: string;
  fine: string;
  giornoIntero: boolean;
};

/**
 * ⚠️ Il font del dispositivo conosce l'ASCII piu' otto caratteri soli:
 * `à è é ì ò ù £ €` (`bitmap_fonts.c`, `font_5x7_cp_map`). Tutto il resto
 * diventerebbe `?` sullo schermo, quindi lo si traduce **qui**, dove si puo'
 * scegliere, invece che sul dispositivo, dove si puo' solo subire.
 */
const TENUTI = new Set(["à", "è", "é", "ì", "ò", "ù", "£", "€"]);

const SPECIALI: Record<string, string> = {
  "–": "-", "—": "-", "‑": "-", "−": "-",
  "’": "'", "‘": "'", "‛": "'", "´": "'", "`": "'",
  "“": '"', "”": '"', "„": '"', "«": '"', "»": '"',
  "…": "...", "•": "-", "·": "-", "°": "o",
  " ": " ", "\t": " ",
};

export function perOrion(testo: string): string {
  let fuori = "";
  for (const c of testo ?? "") {
    if (TENUTI.has(c)) { fuori += c; continue; }
    if (SPECIALI[c] !== undefined) { fuori += SPECIALI[c]; continue; }
    const code = c.codePointAt(0)!;
    if (code >= 0x20 && code <= 0x7e) { fuori += c; continue; }
    if (code === 0x0a || code === 0x0d) { fuori += " "; continue; }
    // Accenti non disponibili: si toglie il segno e resta la lettera.
    const nudo = c.normalize("NFD").replace(/[̀-ͯ]/g, "");
    fuori += /^[\x20-\x7e]+$/.test(nudo) ? nudo : "";
  }
  return fuori.replace(/\s+/g, " ").trim();
}

/** Taglia a `max` byte **senza spezzare un carattere**. */
function tagliaByte(testo: string, max: number): Buffer {
  let b = Buffer.from(testo, "utf8");
  if (b.length <= max) return b;
  let tagliato = testo;
  while (Buffer.byteLength(tagliato, "utf8") > max) {
    tagliato = [...tagliato].slice(0, -1).join("");
  }
  b = Buffer.from(tagliato, "utf8");
  return b;
}

/** Giorni dal 2000-01-01. `Date.UTC` non conosce l'ora legale: e' apposta. */
export function giorniDal2000(anno: number, mese: number, giorno: number): number {
  return Math.round(
    (Date.UTC(anno, mese - 1, giorno) - Date.UTC(2000, 0, 1)) / 86400000,
  );
}

/**
 * ⚠️ La stringa si legge con una regex e **non si passa da `Date`**: sono ore
 * di parete, e farle passare da un oggetto che conosce i fusi vuol dire
 * inventarsi un'ora diversa due volte l'anno, la notte del cambio.
 */
export function minutiLocali(quando: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(quando);
  if (!m) throw new Error(`data non valida: ${quando}`);
  const g = giorniDal2000(Number(m[1]), Number(m[2]), Number(m[3]));
  return g * 1440 + Number(m[4]) * 60 + Number(m[5]);
}

type Piatto = {
  inizio: number;
  durata: number;
  flag: number;
  cal: number;
  titolo: Buffer;
  luogo: Buffer;
};

/**
 * ⚠️ Un evento che scavalca la mezzanotte diventa **un record per giorno**.
 * E' la regola che rende completa la ricerca binaria del dispositivo: tutti
 * gli eventi di un giorno cominciano dentro quel giorno, e il lettore non deve
 * mai guardare indietro per sapere se qualcosa e' ancora in corso.
 */
function spezza(inizio: number, durata: number, flag: number): Array<[number, number, number]> {
  const fuori: Array<[number, number, number]> = [];
  let m = inizio;
  let resta = durata;
  let primo = true;
  while (resta > 0) {
    const aMezzanotte = 1440 - (m % 1440);
    const pezzo = Math.min(resta, aMezzanotte);
    fuori.push([m, pezzo, primo ? flag : flag | F_CONTINUA]);
    m += pezzo;
    resta -= pezzo;
    primo = false;
  }
  return fuori;
}

export type RisultatoCal = {
  eventi: number;      // record scritti (uno per giorno per gli eventi lunghi)
  origine: number;     // eventi di partenza
  byte: number;
  calendari: string[];
  troncati: boolean;   // si e' superato EVENTI_MAX
};

export function costruisciCal(
  eventi: EventoOrion[],
  adesso = new Date(),
): { buffer: Buffer; info: RisultatoCal } {
  // I nomi dei calendari diventano una tabella: il record porta un indice.
  const nomi: string[] = [];
  const indiceDi = (nome: string): number => {
    const pulito = perOrion(nome);
    let i = nomi.indexOf(pulito);
    if (i < 0) {
      if (nomi.length >= CALENDARI_MAX) return 0;
      nomi.push(pulito);
      i = nomi.length - 1;
    }
    return i;
  };

  const piatti: Piatto[] = [];
  for (const ev of eventi) {
    const inizio = minutiLocali(ev.inizio);
    const cal = indiceDi(ev.calendario);
    const titolo = tagliaByte(perOrion(ev.titolo) || "(no title)", TITOLO_MAX);
    const luogo = tagliaByte(perOrion(ev.luogo), LUOGO_MAX);

    if (ev.giornoIntero) {
      /* ⚠️ Un evento di giorno intero si ancora alla **mezzanotte del suo
         giorno**, e la durata in minuti non vorrebbe dire niente a chi lo
         disegna: si usa `DURATA_GIORNO`.
         ⚠️ E se dura piu' giorni — le vacanze di Natale, una fiera — ne esce
         **uno per giorno**. Senza, comparirebbe solo il primo: la vista del
         mese e quella del giorno cercano gli eventi dentro il giorno che
         stanno mostrando, e nessuno guarda indietro (e' la regola che rende
         completa la ricerca binaria del dispositivo). */
      const g0 = Math.floor(inizio / 1440);
      let gFine = g0;
      try {
        gFine = Math.floor(minutiLocali(ev.fine) / 1440);
      } catch {
        /* senza una fine credibile vale un giorno solo */
      }
      const ultimo = Math.max(g0, Math.min(gFine, g0 + 366));
      for (let g = g0; g <= ultimo; g++) {
        piatti.push({
          inizio: g * 1440, durata: DURATA_GIORNO,
          flag: F_GIORNO_INTERO | (g > g0 ? F_CONTINUA : 0),
          cal, titolo, luogo,
        });
      }
      continue;
    }

    const fine = minutiLocali(ev.fine);
    const durata = Math.max(1, Math.min(fine - inizio, 366 * 1440));
    for (const [m, d, f] of spezza(inizio, durata, 0)) {
      piatti.push({ inizio: m, durata: d, flag: f, cal, titolo, luogo });
    }
  }

  // A parita' di minuto il giorno intero viene prima: e' l'unica cosa che il
  // dispositivo non puo' decidere da solo senza rileggere i flag.
  piatti.sort((a, b) =>
    a.inizio !== b.inizio
      ? a.inizio - b.inizio
      : (b.flag & F_GIORNO_INTERO) - (a.flag & F_GIORNO_INTERO),
  );

  const troncati = piatti.length > EVENTI_MAX;
  const tenuti = troncati ? piatti.slice(0, EVENTI_MAX) : piatti;

  // Blob dei testi: titolo e luogo attaccati, un offset solo per i due.
  const blob: Buffer[] = [];
  let off = 0;
  const offsets: number[] = [];
  for (const p of tenuti) {
    offsets.push(off);
    blob.push(p.titolo, p.luogo);
    off += p.titolo.length + p.luogo.length;
  }

  const n = tenuti.length;
  const offTesti = 32 + 16 * n + 512;

  const header = Buffer.alloc(32);
  MAGIC.copy(header, 0);
  header.writeUInt16LE(VERSIONE, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt32LE(n, 12);
  header.writeUInt32LE(offTesti, 16);
  header.writeUInt32LE(
    minutiLocali(
      `${adesso.getFullYear()}-${String(adesso.getMonth() + 1).padStart(2, "0")}-` +
      `${String(adesso.getDate()).padStart(2, "0")}T` +
      `${String(adesso.getHours()).padStart(2, "0")}:` +
      `${String(adesso.getMinutes()).padStart(2, "0")}`,
    ),
    20,
  );
  // Scostamento da UTC in minuti: informativo, serve alla Companion per
  // accorgersi che il file e' stato scritto in un altro fuso.
  header.writeInt16LE(-adesso.getTimezoneOffset(), 24);
  header.writeUInt16LE(n > 0 ? Math.floor(tenuti[0].inizio / 1440) : 0, 26);
  header.writeUInt16LE(n > 0 ? Math.floor(tenuti[n - 1].inizio / 1440) : 0, 28);
  header.writeUInt16LE(0, 30);

  const record = Buffer.alloc(16 * n);
  tenuti.forEach((p, i) => {
    const b = i * 16;
    record.writeUInt32LE(p.inizio, b);
    record.writeUInt16LE(p.durata, b + 4);
    record.writeUInt8(p.flag, b + 6);
    record.writeUInt8(p.cal, b + 7);
    record.writeUInt32LE(offsets[i], b + 8);
    record.writeUInt8(p.titolo.length, b + 12);
    record.writeUInt8(p.luogo.length, b + 13);
    record.writeUInt16LE(0, b + 14);
  });

  const tabella = Buffer.alloc(512);
  nomi.slice(0, CALENDARI_MAX).forEach((nome, i) => {
    tagliaByte(nome, NOME_CAL_MAX).copy(tabella, i * 32);
  });

  const buffer = Buffer.concat([header, record, tabella, ...blob]);
  return {
    buffer,
    info: {
      eventi: n,
      origine: eventi.length,
      byte: buffer.length,
      calendari: nomi,
      troncati,
    },
  };
}

export async function scriviCal(
  percorso: string,
  eventi: EventoOrion[],
): Promise<RisultatoCal> {
  const { buffer, info } = costruisciCal(eventi);
  await writeFile(percorso, buffer);
  return info;
}
