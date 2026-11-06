/**
 * Scrive un `.cal` di prova con lo **scrittore vero** (`src/main/calendario/cal.ts`).
 *
 * ⚠️ Serve perche' questo formato ha due scrittori — questo e
 * `PDAV3/prove_pc/finto_calendario.py` — e un lettore solo, sul dispositivo.
 * Gli offset di un formato con due scrittori si sfasano in silenzio: qui si
 * produce il file, e a giudicarlo e' il lettore vero compilato sul PC.
 *
 *   npx tsx scripts/prova-cal.ts /tmp/prova_ts.cal
 *   ../prove_pc/cal_file --generico /tmp/prova_ts.cal
 *
 * (`npm run prova:cal` fa tutti e due.)
 */
import { costruisciCal, perOrion, minutiLocali } from "../src/main/calendario/cal";
import { writeFileSync } from "node:fs";

const uscita = process.argv[2] ?? "/tmp/prova_ts.cal";

const eventi = [
  // Giornata piena.
  { titolo: "Stand-up", luogo: "Teams", calendario: "Lavoro",
    inizio: "2026-09-23T08:30", fine: "2026-09-23T09:00", giornoIntero: false },
  { titolo: "Revisione del firmware", luogo: "Ufficio 2", calendario: "Lavoro",
    inizio: "2026-09-23T09:00", fine: "2026-09-23T10:00", giornoIntero: false },
  { titolo: "Ferie", luogo: "", calendario: "Famiglia",
    inizio: "2026-09-23T00:00", fine: "2026-09-23T23:59", giornoIntero: true },
  // ⚠️ Scavalca la mezzanotte: devono uscire due record, il secondo CONTINUA.
  { titolo: "Volo notturno per Lisbona", luogo: "Malpensa T1", calendario: "Famiglia",
    inizio: "2026-09-24T22:00", fine: "2026-09-25T03:00", giornoIntero: false },
  // ⚠️ Tre giorni: tre record.
  { titolo: "Fiera di Monaco", luogo: "Messe Munchen", calendario: "Lavoro",
    inizio: "2026-09-27T09:00", fine: "2026-09-30T18:00", giornoIntero: false },
  // ⚠️ Accentate che il font ha, e un titolo oltre i 63 byte.
  { titolo: "Caffè con perché e però", luogo: "città", calendario: "Famiglia",
    inizio: "2026-09-24T16:00", fine: "2026-09-24T16:30", giornoIntero: false },
  { titolo: "Riunione di allineamento sulla roadmap del prodotto, di secondàri e altro",
    luogo: "Sala grande, primo piano", calendario: "Lavoro",
    inizio: "2026-09-24T15:00", fine: "2026-09-24T15:30", giornoIntero: false },
  // ⚠️ Roba che il font non ha: deve uscirne testo leggibile, non "?".
  { titolo: "Обед — café “naïve” 🍕", luogo: "Zürich", calendario: "Viaggi",
    inizio: "2026-09-26T12:00", fine: "2026-09-26T13:00", giornoIntero: false },
  // Fine anno e 29 febbraio.
  { titolo: "Cenone", luogo: "Da Marco", calendario: "Famiglia",
    inizio: "2026-12-31T23:00", fine: "2027-01-01T01:00", giornoIntero: false },
  { titolo: "29 febbraio", luogo: "", calendario: "Lavoro",
    inizio: "2028-02-29T09:00", fine: "2028-02-29T10:00", giornoIntero: false },
];

const { buffer, info } = costruisciCal(eventi);
writeFileSync(uscita, buffer);

console.log(`${uscita}: ${info.eventi} record da ${info.origine} eventi, ` +
            `${info.byte} byte, calendari: ${info.calendari.join(", ")}`);

// Due controlli che non richiedono il lettore C.
//
// ⚠️ L'atteso dice cosa **succede davvero**, non cosa si spererebbe:
//   - "Обед" sparisce, perche' il font non ha il cirillico e non c'e' nessuna
//     traslitterazione: meglio niente che una fila di "?";
//   - "café" resta con l'accento, perche' la é il font **ce l'ha**;
//   - "naïve" perde la dieresi, che il font non ha, e resta la lettera;
//   - l'emoji sparisce, il trattino lungo diventa un trattino, le virgolette
//     tipografiche diventano quelle diritte.
// Un titolo che sparisse del tutto diventa "(no title)" in `costruisciCal`.
const atteso = "- café \"naive\"";
const avuto = perOrion("Обед — café “naïve” 🍕");
if (avuto !== atteso) {
  console.error(`KO traduzione: "${avuto}" invece di "${atteso}"`);
  process.exit(1);
}
if (minutiLocali("2000-01-01T00:00") !== 0) {
  console.error("KO: l'epoca non e' il 2000-01-01");
  process.exit(1);
}
console.log("traduzione dei caratteri: ok");
