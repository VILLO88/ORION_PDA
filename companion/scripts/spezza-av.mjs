/**
 * Spezza un video `.av` troppo grande per la FAT32 in piu' file, ognuno
 * riproducibile da solo.
 *
 * ⚠️ Non e' un taglio a meta' dei byte: un `.av` e' un'intestazione da 32 byte
 * seguita da fotogrammi di lunghezza fissa (blocco audio + frame video), e il
 * lettore non ha indice. Si taglia quindi **solo fra un fotogramma e l'altro**,
 * e ogni parte riceve la sua copia dell'intestazione con il numero di
 * fotogrammi corretto. Audio e video stanno nello stesso fotogramma, quindi
 * restano allineati. Formato in `../APP_VIDEO.md` §4.
 *
 *   node scripts/spezza-av.mjs film.av            # il minimo numero di parti
 *   node scripts/spezza-av.mjs film.av 3          # tre parti
 *
 * Scrive `film_1.av`, `film_2.av`, ... accanto all'originale, che non tocca.
 */
import { openSync, readSync, writeSync, closeSync, fstatSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

/* La FAT32 tiene la dimensione in 32 bit: un file arriva a 4 GiB meno un byte. */
const FAT32_MAX = 0xffffffff;
const HDR = 32;
const PEZZO = 8 * 1024 * 1024;

const [sorgente, partiArg] = process.argv.slice(2);
if (!sorgente) {
  console.error("uso: node scripts/spezza-av.mjs <file.av> [parti]");
  process.exit(1);
}

const fd = openSync(sorgente, "r");
const dimensione = fstatSync(fd).size;
const hdr = Buffer.alloc(HDR);
if (readSync(fd, hdr, 0, HDR, 0) !== HDR || hdr.toString("latin1", 0, 4) !== "PDAV") {
  console.error("non e' un file .av: manca \"PDAV\" in testa");
  process.exit(1);
}

const fps = hdr.readUInt16LE(8);
const fotogrammaB = hdr.readUInt32LE(20) + hdr.readUInt32LE(28);
const corpo = dimensione - HDR;
const fotogrammi = Math.floor(corpo / fotogrammaB);
const avanzo = corpo - fotogrammi * fotogrammaB;

/* Il conto si fa sulla lunghezza del file e non sul campo dell'intestazione,
 * che e' solo informativo: e' il file a dire quanti fotogrammi ci sono. */
if (fotogrammi !== hdr.readUInt32LE(24))
  console.warn(`attenzione: l'intestazione dichiara ${hdr.readUInt32LE(24)} fotogrammi, il file ne contiene ${fotogrammi}`);
if (avanzo)
  console.warn(`attenzione: ${avanzo} byte in coda non fanno un fotogramma intero, li scarto`);

const perParteMax = Math.floor((FAT32_MAX - HDR) / fotogrammaB);
const minimo = Math.ceil(fotogrammi / perParteMax);
const parti = partiArg ? Number(partiArg) : Math.max(2, minimo);
if (!Number.isInteger(parti) || parti < 1 || parti > fotogrammi) {
  console.error(`numero di parti non valido: ${partiArg}`);
  process.exit(1);
}
if (parti < minimo) {
  console.error(`${parti} parti non bastano: per stare sotto i 4 GiB ne servono almeno ${minimo}`);
  process.exit(1);
}

const durata = (n) => {
  const s = Math.round(n / fps);
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

const ext = extname(sorgente);
const radice = join(dirname(sorgente), basename(sorgente, ext));
const buf = Buffer.alloc(PEZZO);

/* L'elenco dei video del firmware tronca i nomi a 31 caratteri
 * (`VID_NAME_LEN` in `ui_priv.h`) e poi apre il nome troncato: il file c'e',
 * e il dispositivo dice "file non apribile". Si dice qui, prima di copiare
 * due gigabyte su una scheda. */
const NOME_MAX = 31;
const piuLungo = `${basename(radice)}_${parti}${ext}`;
if (piuLungo.length > NOME_MAX)
  console.warn(
    `attenzione: "${piuLungo}" e' lungo ${piuLungo.length} caratteri, il dispositivo ne regge ${NOME_MAX}: ` +
      `rinomina le parti prima di caricarle, o non si apriranno`
  );
let primo = 0;

for (let i = 0; i < parti; i++) {
  /* Parti uguali, con il resto distribuito sulle prime. */
  const n = Math.floor(fotogrammi / parti) + (i < fotogrammi % parti ? 1 : 0);
  const nome = `${radice}_${i + 1}${ext}`;
  const out = openSync(nome, "wx");

  const h = Buffer.from(hdr);
  h.writeUInt32LE(n, 24);
  writeSync(out, h);

  let pos = HDR + primo * fotogrammaB;
  let restano = n * fotogrammaB;
  while (restano > 0) {
    const letti = readSync(fd, buf, 0, Math.min(PEZZO, restano), pos);
    if (letti <= 0) throw new Error(`lettura interrotta a ${pos}`);
    writeSync(out, buf, 0, letti);
    pos += letti;
    restano -= letti;
  }
  closeSync(out);

  console.log(
    `${basename(nome)}: ${n} fotogrammi, ${durata(n)} (da ${durata(primo)}), ` +
      `${((HDR + n * fotogrammaB) / 2 ** 30).toFixed(2)} GiB`
  );
  primo += n;
}
closeSync(fd);
