/**
 * Import di un file `.ics` (iCalendar), per chi non ha un Mac — e per chi non
 * vuole dare il permesso al Calendario di sistema.
 *
 * ⚠️ **Perche' esiste, e non e' solo un ripiego.** Il calendario di sistema si
 * puo' leggere per davvero **solo su macOS**: su Windows l'API moderna
 * (`Windows.ApplicationModel.Appointments`) vuole un'app impacchettata MSIX
 * con la capability dichiarata, e su Linux non esiste *il* calendario di
 * sistema — c'e' Evolution Data Server su GNOME, Akonadi su KDE, ciascuno se
 * c'e' quel desktop. Un file `.ics` invece lo esportano tutti, e non tocca
 * nessun sistema di permessi da nessuna parte.
 *
 * ⚠️ **Sbocca nello stesso posto.** Gli eventi escono di qui nella forma di
 * `EventoOrion`, cioe' quella che produce anche l'helper EventKit: da li' in
 * avanti il percorso e' uno solo, e il dispositivo non sa da dove sono
 * arrivati. Il giorno che si aggiungera' CalDAV sara' una terza sorgente che
 * finisce nello stesso imbuto, non un altro formato.
 *
 * ⚠️ **Le ricorrenze le srotola `ical.js`, non noi.** Scrivere a mano
 * l'espansione delle RRULE e' il modo piu' rapido di avere qualcosa che
 * sembra funzionare e sbaglia il quinto martedi' del mese, le eccezioni
 * (`EXDATE`) e le singole occorrenze spostate (`RECURRENCE-ID`). Questa e' la
 * libreria di Thunderbird: fa esattamente quel lavoro e lo fa da vent'anni.
 */

import { readFile } from "node:fs/promises";
import ICAL from "ical.js";

import type { EventoOrion } from "./cal";

/** Tetto: un `.ics` con dentro dieci anni di riunioni non deve fondere l'app. */
const OCCORRENZE_MAX = 5000;

function due(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Da istante assoluto a **ora di parete locale di questo computer**.
 *
 * ⚠️ E' la conversione che decide tutto: nel `.cal` ci vanno ore di parete,
 * perche' l'orologio del dispositivo conta ore locali e non sa cosa sia un
 * fuso (CALENDARIO.md §3). Un `.ics` puo' portare orari in UTC, in un fuso
 * dichiarato (`TZID`) o "fluttuanti"; `ical.js` li risolve in un istante, e
 * qui l'istante torna a essere l'ora che l'utente vede sul suo orologio.
 */
function oraLocale(d: Date): string {
  return (
    `${d.getFullYear()}-${due(d.getMonth() + 1)}-${due(d.getDate())}T` +
    `${due(d.getHours())}:${due(d.getMinutes())}`
  );
}

/** Per gli eventi di giorno intero non c'e' nessun fuso da risolvere: la data
    e' una data, e passarla da un istante la sposterebbe di un giorno a ogni
    cambio d'ora legale. Si prendono i componenti come stanno scritti. */
function soloData(t: ICAL.Time): string {
  return `${t.year}-${due(t.month)}-${due(t.day)}T00:00`;
}

export type EsitoIcs = {
  ok: boolean;
  errore?: string;
  eventi: EventoOrion[];
  /** Quante occorrenze sono state tagliate dal tetto. */
  troncate: number;
  /** Nome del calendario dentro il file, se lo dichiara. */
  nome: string;
};

export async function leggiIcs(
  percorso: string,
  da: Date,
  a: Date,
): Promise<EsitoIcs> {
  let testo: string;
  try {
    testo = await readFile(percorso, "utf8");
  } catch (e) {
    return { ok: false, errore: `non riesco a leggere il file: ${String(e)}`,
             eventi: [], troncate: 0, nome: "" };
  }

  let radice: ICAL.Component;
  try {
    radice = new ICAL.Component(ICAL.parse(testo));
  } catch (e) {
    return { ok: false, errore: `non e' un file iCalendar valido: ${String(e)}`,
             eventi: [], troncate: 0, nome: "" };
  }

  /* ⚠️ I fusi dichiarati nel file vanno registrati **prima** di leggere gli
     orari: senza, `ical.js` non sa cosa voglia dire "Europe/Rome" e lascia
     l'ora dov'e', cioe' sbagliata di un'ora o due. */
  for (const vt of radice.getAllSubcomponents("vtimezone")) {
    const tz = new ICAL.Timezone(vt);
    if (!ICAL.TimezoneService.has(tz.tzid)) ICAL.TimezoneService.register(tz);
  }

  const nome =
    (radice.getFirstPropertyValue("x-wr-calname") as string | null) ?? "";
  const nomeCal = nome || "Imported";

  const inizio = ICAL.Time.fromJSDate(da, false);
  const fine = ICAL.Time.fromJSDate(a, false);

  /* Le occorrenze spostate (`RECURRENCE-ID`) vanno attaccate al loro evento
     padre, o comparirebbero due volte: una nella serie e una da sole. */
  const serie = new Map<string, ICAL.Event>();
  const singoli: ICAL.Event[] = [];
  const eccezioni: ICAL.Event[] = [];

  for (const ve of radice.getAllSubcomponents("vevent")) {
    let ev: ICAL.Event;
    try {
      ev = new ICAL.Event(ve);
    } catch {
      continue;                     /* VEVENT storto: si salta, non si muore */
    }
    if (ev.isRecurrenceException()) eccezioni.push(ev);
    else if (ev.isRecurring()) serie.set(ev.uid, ev);
    else singoli.push(ev);
  }
  for (const ecc of eccezioni) {
    const padre = serie.get(ecc.uid);
    if (padre) padre.relateException(ecc);
    else singoli.push(ecc);         /* orfana: meglio mostrarla che perderla */
  }

  const fuori: EventoOrion[] = [];
  let troncate = 0;

  const aggiungi = (
    partenza: ICAL.Time,
    arrivo: ICAL.Time,
    titolo: string,
    luogo: string,
  ): void => {
    if (fuori.length >= OCCORRENZE_MAX) { troncate++; return; }
    const tuttoIlGiorno = partenza.isDate;
    fuori.push({
      titolo: titolo || "",
      luogo: luogo || "",
      calendario: nomeCal,
      inizio: tuttoIlGiorno ? soloData(partenza) : oraLocale(partenza.toJSDate()),
      /* ⚠️ Nell'iCalendar il `DTEND` di un evento di giorno intero e'
         **escluso**: un giorno solo finisce il giorno dopo. Qui si riporta
         all'ultimo giorno incluso, cosi' le due sorgenti — questa ed
         EventKit — dicono la stessa cosa allo scrittore del `.cal`. */
      fine: tuttoIlGiorno
        ? (() => {
            const u = arrivo.clone();
            u.adjust(-1, 0, 0, 0);
            return `${soloData(u).slice(0, 10)}T23:59`;
          })()
        : oraLocale(arrivo.toJSDate()),
      giornoIntero: tuttoIlGiorno,
    });
  };

  for (const ev of singoli) {
    const s = ev.startDate;
    if (s.compare(fine) > 0) continue;
    const e = ev.endDate ?? s;
    if (e.compare(inizio) < 0) continue;
    aggiungi(s, e, ev.summary, ev.location);
  }

  for (const ev of serie.values()) {
    const durataSec = ev.duration ? ev.duration.toSeconds() : 0;
    const it = ev.iterator();
    let quando: ICAL.Time | null;
    let giri = 0;

    while ((quando = it.next()) && giri < OCCORRENZE_MAX) {
      giri++;
      if (quando.compare(fine) > 0) break;
      if (quando.compare(inizio) < 0) continue;

      /* `getOccurrenceDetails` applica le occorrenze spostate: se il martedi'
         di quella settimana e' stato mosso alle 15, qui esce alle 15. */
      const d = ev.getOccurrenceDetails(quando);
      const arrivo = d.endDate ?? (() => {
        const f = d.startDate.clone();
        f.addDuration(ICAL.Duration.fromSeconds(durataSec));
        return f;
      })();
      aggiungi(d.startDate, arrivo, d.item.summary, d.item.location);
    }
  }

  return { ok: true, eventi: fuori, troncate, nome: nomeCal };
}
