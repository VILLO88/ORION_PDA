/**
 * The Wikipedia converter from the command line, the same code as the app's
 * Wikipedia page (src/main/wiki):
 *
 *   npm run wiki -- wikipedia_it_top_mini_2026-10.zim /Volumes/ORION/wiki/it_top
 */
import { converti } from "../src/main/wiki/converti";

const [zim, uscita] = process.argv.slice(2);
if (!zim || !uscita) {
  console.error("uso: npm run wiki -- FILE.zim CARTELLA");
  process.exit(2);
}
let ultimo = "";
converti(zim, uscita, (p) => {
  const riga = `${p.fase} ${p.totale > 1 ? Math.floor((100 * p.fatti) / p.totale) + "%" : ""}`;
  if (riga !== ultimo) { process.stdout.write("\r" + riga.padEnd(20)); ultimo = riga; }
}).then((r) => {
  console.log(`\nfatto: ${r.articoli} articoli, ${r.titoli} titoli, ${r.geo} con coordinate, ` +
              `${(r.byte / 1e6).toFixed(1)} MB, ${r.secondi.toFixed(0)} s`);
}).catch((e) => { console.error("\n" + (e as Error).message); process.exit(1); });
