/**
 * L'import `.ics`, provato sul file `scripts/fixture.ics`.
 *
 * ⚠️ Il fixture non e' un calendario qualunque: contiene **apposta** le cose
 * che si sbagliano — un orario in un fuso dichiarato, uno in UTC, un evento di
 * giorno intero lungo tre giorni (dove il `DTEND` dell'iCalendar e' escluso),
 * una serie settimanale con un'occorrenza **cancellata** (`EXDATE`) e una
 * **spostata** (`RECURRENCE-ID`), e un evento che scavalca la mezzanotte.
 *
 *   npx tsx scripts/prova-ics.ts
 */
import { leggiIcs } from "../src/main/calendario/ics";
import { costruisciCal } from "../src/main/calendario/cal";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const uscita = process.argv[2] ?? "/tmp/prova_ics.cal";
let errori = 0;

function ok(condizione: boolean, cosa: string): void {
  if (!condizione) {
    console.error(`  KO ${cosa}`);
    errori++;
  }
}

async function main(): Promise<void> {
  const r = await leggiIcs(
    join(__dirname, "fixture.ics"),
    new Date("2026-09-01"),
    new Date("2027-01-31"),
  );

  ok(r.ok, `lettura: ${r.errore ?? ""}`);
  ok(r.nome === "Prova ORION", "il nome del calendario viene da X-WR-CALNAME");

  const per = (t: string) => r.eventi.filter((e) => e.titolo.startsWith(t));

  // Fuso dichiarato: l'ora resta quella scritta nel file.
  ok(per("Riunione")[0]?.inizio === "2026-10-01T09:30", "TZID: ora di parete");

  // ⚠️ UTC: 14:00Z d'ottobre in Italia sono le 16:00. Se questa riga diventa
  // rossa, qualcuno ha tolto la conversione — e gli orari sarebbero sbagliati
  // di due ore senza che niente protesti.
  ok(per("Evento in UTC")[0]?.inizio === "2026-10-02T16:00", "UTC -> ora locale");

  // Giorno intero: DTEND 27/12 escluso -> ultimo giorno incluso il 26.
  const vac = per("Vacanze")[0];
  ok(vac?.giornoIntero === true, "giorno intero riconosciuto");
  ok(vac?.inizio === "2026-12-24T00:00", "giorno intero: inizio");
  ok(vac?.fine === "2026-12-26T23:59", "giorno intero: DTEND e' escluso");

  // Serie settimanale: COUNT=5, una cancellata, una spostata.
  const pal = r.eventi.filter((e) => e.titolo.startsWith("Palestra"));
  ok(pal.length === 4, `serie: 4 occorrenze (COUNT 5 meno l'EXDATE), ne ho ${pal.length}`);
  ok(
    pal.some((e) => e.inizio === "2026-10-13T20:00" && e.titolo.includes("spostata")),
    "RECURRENCE-ID: l'occorrenza spostata prende ora e titolo nuovi",
  );
  ok(!pal.some((e) => e.inizio.startsWith("2026-10-20")), "EXDATE: quella tolta non c'e'");
  ok(
    pal.some((e) => e.inizio === "2026-11-03T18:00"),
    "dopo il cambio d'ora legale l'orario di parete non si sposta",
  );

  // Dal `.ics` al `.cal`: lo spezzamento lo fa lo scrittore.
  const { buffer, info } = costruisciCal(r.eventi);
  writeFileSync(uscita, buffer);
  ok(info.origine === 8, `8 eventi letti, ne ho ${info.origine}`);
  ok(
    info.eventi === 11,
    `11 record: +2 per i tre giorni di vacanza, +1 per la mezzanotte scavalcata, ne ho ${info.eventi}`,
  );

  if (errori > 0) {
    console.error(`FALLITA: ${errori} errori`);
    process.exit(1);
  }
  console.log(
    `prova .ics: ${info.origine} eventi -> ${info.eventi} record, ` +
      `${info.byte} byte in ${uscita}`,
  );
}

void main();
