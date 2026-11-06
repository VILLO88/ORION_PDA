/**
 * L'aritmetica dei pacchetti BLE, provata senza un Bluetooth.
 *
 * ⚠️ Esiste per un bug preciso, trovato il 23/9/2026: il passo dei dati non
 * teneva conto dei 5 caratteri di `"DATA "`, quindi ogni scrittura usciva di
 * 5 byte oltre il pacchetto **misurato**. Su macOS una scrittura piu' lunga
 * dell'MTU non viene rifiutata: viene **troncata in silenzio**, il base64
 * troncato decodifica lo stesso — solo piu' corto — e il conto non torna solo
 * alla fine, con un "byte mancanti" che sembra arrivare dal nulla.
 *
 * L'invariante e' una riga: **la scrittura non deve mai superare il pacchetto
 * misurato**, per nessuna dimensione e per nessun prefisso.
 */
import {
  PACCHETTI_PROVATI,
  finestraPer,
  lunghezzaScrittura,
  passoDati,
} from "../src/renderer/src/lib/bleOrion";

/* L'anello di ricezione del firmware: BLE_RX_N in Core/Inc/ble.h. Se cambia
   li', cambia qui — e la prova lo dice invece di lasciarlo scoprire a un
   pacchetto che sparisce. */
const ANELLO_FIRMWARE = 2048;
const SPESA_AT = 16;

const PREFISSI = ["DATA ", "ECHO ", "OPEN 123456 /calendar/calendar.cal "];
let errori = 0;

for (const pacchetto of PACCHETTI_PROVATI) {
  for (const prefisso of PREFISSI) {
    const passo = passoDati(pacchetto, prefisso);
    const scrittura = lunghezzaScrittura(passo, prefisso);
    if (scrittura > pacchetto) {
      console.error(
        `KO pacchetto ${pacchetto}, prefisso "${prefisso}": ` +
          `${passo} byte diventano una scrittura da ${scrittura}`,
      );
      errori++;
    }
    // E non deve nemmeno sprecarne: un gruppo base64 in piu' ci starebbe?
    if (lunghezzaScrittura(passo + 3, prefisso) <= pacchetto) {
      console.error(
        `KO pacchetto ${pacchetto}, prefisso "${prefisso}": ` +
          `ci starebbero ${passo + 3} byte invece di ${passo}`,
      );
      errori++;
    }
  }
}

/* ⚠️ La seconda invariante, quella che e' costata il pomeriggio del 23/9:
   **quanti byte stanno in volo**, non quanti pacchetti. Otto pacchetti da 180
   sono 1568 e stanno nell'anello; otto da 492 sono 4064 e lo fanno traboccare,
   e un pacchetto caduto si vede come "nessuna risposta". */
for (const pacchetto of PACCHETTI_PROVATI) {
  const inVolo = finestraPer(pacchetto) * (pacchetto + SPESA_AT);
  if (inVolo > ANELLO_FIRMWARE) {
    console.error(
      `KO pacchetto ${pacchetto}: finestra ${finestraPer(pacchetto)} = ` +
        `${inVolo} byte in volo, l'anello del firmware ne ha ${ANELLO_FIRMWARE}`,
    );
    errori++;
  }
}

if (errori > 0) {
  console.error(`FALLITA: ${errori} errori`);
  process.exit(1);
}
console.log(
  `prova pacchetti BLE: ${PACCHETTI_PROVATI.length} dimensioni x ` +
    `${PREFISSI.length} prefissi, tutte dentro il limite`,
);
for (const p of PACCHETTI_PROVATI) {
  console.log(
    `  pacchetto ${String(p).padStart(3)}: ${passoDati(p, "DATA ")} byte di dati, ` +
      `finestra ${finestraPer(p)}, ${finestraPer(p) * (p + SPESA_AT)} byte in volo`,
  );
}
