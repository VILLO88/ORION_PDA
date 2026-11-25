/**
 * A Kiwix ZIM of Wikipedia -> the ORION Wiki format, read by wiki.lua on
 * the device. The format and its reasons: internal/examples/wiki/FORMATO.md
 * in the SDK.
 *
 * All the heavy work happens here, once: on ORION the app only seeks and
 * reads short pieces. In order:
 *   1. list the ZIM's articles and redirects, and number the articles in
 *      order of search key;
 *   2. turn each article's HTML into text with a few codes (headings, list
 *      items, links already resolved to article numbers), transliterating
 *      what the panel font does not have;
 *   3. write the title index (redirects included) and the geographic one.
 *
 * Articles are processed in CLUSTER order, not in number order: a cluster
 * holds hundreds of articles in one zstd block, and in number order each
 * would be decompressed again for every article in it. The numbers stay in
 * key order; only where each text sits in text.NNN changes.
 *
 * Coordinates come from the ZIM itself, Wikipedia's primary coordinate,
 * which mwoffliner writes in one of two places depending on its version:
 * "wgCoordinates" in the page's configuration (ZIMs of October 2026), or
 * <meta name="geo.position"> in the head (July 2026, which has no such
 * configuration at all: reading only the first gave an empty geo.idx).
 */
import { closeSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
import { basename, join } from "node:path";
import { Zim, REDIRECT, type Dirent } from "./zim";
import { chiave, KEY_LEN, Pagina, SEZIONI_VIA, translit } from "./testo";

export const FORMATO = 1;
const TEXT_MAX = 512 * 1024 * 1024; // a text file under 512 MB (FORMATO.md)
const TOP_OGNI = 128;

export interface WikiProgresso {
  fase: "elenco" | "testo" | "indici" | "fatto";
  fatti: number;
  totale: number;
}

export interface WikiRisultato {
  articoli: number;
  titoli: number;
  geo: number;
  byte: number;
  secondi: number;
}

export interface WikiInfo {
  titolo: string;
  lingua: string;
  data: string;
  descrizione: string;
  articoli: number;
}

/** What the ZIM says about itself, without converting anything. */
export function leggiInfo(zimPath: string): WikiInfo {
  const z = new Zim(zimPath);
  try {
    const [a, b] = z.namespaceRange(z.articleNs());
    let articoli = 0;
    for (let i = a; i < b; i++) {
      const d = z.dirent(i);
      if (d.mime !== REDIRECT && (z.mimes[d.mime] ?? "").startsWith("text/html")) articoli++;
    }
    return {
      titolo: z.metadata("Title"),
      lingua: z.metadata("Language"),
      data: z.metadata("Date"),
      descrizione: z.metadata("Description"),
      articoli,
    };
  } finally {
    z.close();
  }
}

/** Python's tuple order on (bytes, str, str): bytes, then code points. */
function perCodepoint(a: string, b: string): number {
  if (a === b) return 0;
  const x = [...a];
  const y = [...b];
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (x[i] !== y[i]) return x[i].codePointAt(0)! - y[i].codePointAt(0)!;
  }
  return x.length - y.length;
}

/** Python's round(): halves go to the even neighbour. */
function roundPy(x: number): number {
  const r = Math.round(x);
  return Math.abs(x - Math.trunc(x)) === 0.5 ? 2 * Math.round(x / 2) : r;
}

function cella(lat: number, lon: number): number {
  return Math.trunc((lat + 90) * 100) * 36000 + Math.trunc((lon + 180) * 100);
}

/** urllib.parse.unquote: %XX runs decoded as UTF-8, bad bytes as U+FFFD. */
function unquote(s: string): string {
  if (!s.includes("%")) return s;
  return s.replace(/(%[0-9A-Fa-f]{2})+/g, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(run.substr(i * 3 + 1, 2), 16);
    return new TextDecoder("utf-8").decode(bytes);
  });
}

interface Articolo { k: Buffer; titolo: string; path: string; cluster: number; blob: number }

export async function converti(
  zimPath: string,
  uscita: string,
  progresso: (p: WikiProgresso) => void = () => {},
  annullato: () => boolean = () => false,
): Promise<WikiRisultato> {
  const t0 = Date.now();
  const z = new Zim(zimPath);
  const fds: number[] = [];
  try {
    mkdirSync(uscita, { recursive: true });
    const lingua = (z.metadata("Language") || "it").slice(0, 2);
    const viaSezioni = SEZIONI_VIA[lingua] ?? SEZIONI_VIA.en;
    const mainPath = z.mainPage !== 0xffffffff ? z.dirent(z.mainPage).path : "";

    // 1. articles and redirects
    const [a, b] = z.namespaceRange(z.articleNs());
    const articoli: Articolo[] = [];
    const redirect = new Map<string, Dirent>();
    for (let i = a; i < b; i++) {
      const d = z.dirent(i);
      if (d.mime === REDIRECT) {
        redirect.set(d.path, d);
      } else if ((z.mimes[d.mime] ?? "").startsWith("text/html") && d.path !== mainPath) {
        articoli.push({ k: chiave(d.title), titolo: d.title, path: d.path, cluster: d.cluster, blob: d.blob });
      }
      if (i % 20000 === 0) {
        progresso({ fase: "elenco", fatti: i - a, totale: b - a });
        await new Promise((r) => setImmediate(r));
      }
    }
    articoli.sort((x, y) => Buffer.compare(x.k, y.k) || perCodepoint(x.titolo, y.titolo) || perCodepoint(x.path, y.path));
    const numero = new Map<string, number>();
    articoli.forEach((art, n) => numero.set(art.path, n));

    const finale = (path: string, giri = 0): number | null => {
      const n = numero.get(path);
      if (n !== undefined) return n;
      const e = redirect.get(path);
      if (!e || giri > 5) return null;
      if (e.redirect < 0 || e.redirect >= z.entryCount) return null;
      return finale(z.dirent(e.redirect).path, giri + 1);
    };
    const risolvi = (href: string): number | null => {
      let h = unquote(href.split("#")[0]);
      if (h.startsWith("./")) h = h.slice(2);
      return h ? finale(h) : null;
    };

    // 2. the text, in cluster order
    const ordine = articoli.map((_, n) => n).sort((x, y) =>
      articoli[x].cluster - articoli[y].cluster || articoli[x].blob - articoli[y].blob);
    const coordRe = /"wgCoordinates":\{"lat":(-?[\d.]+),"lon":(-?[\d.]+)\}/;
    const metaRe = /<meta name="geo\.position" content="(-?[\d.]+);\s*(-?[\d.]+)"/;
    const idx = Buffer.alloc(articoli.length * 12);
    const geo: [number, number, number, number][] = [];
    let nfile = 0;
    let pos = 0;
    let testoTot = 0;
    let fd = openSync(join(uscita, "text.000"), "w");
    fds.push(fd);
    for (let j = 0; j < ordine.length; j++) {
      if (annullato()) throw new Error("annullato");
      const n = ordine[j];
      const art = articoli[n];
      const html = z.blob(art.cluster, art.blob).toString("utf8");
      const p = new Pagina(risolvi, viaSezioni);
      p.feed(html);
      p.chiudi();
      // The infobox goes after the first paragraph: on a 12-line page it can
      // take three pages, and the reader wants the first sentence first.
      const righe = p.righe.length ? [...p.righe.slice(0, 1), ...p.scheda, ...p.righe.slice(1)] : p.scheda;
      const testo = Buffer.from("\x011" + translit(art.titolo) + "\n" + righe.join("\n") + "\n", "utf8");
      if (pos + testo.length > TEXT_MAX) {
        closeSync(fd);
        fds.pop();
        nfile += 1;
        fd = openSync(join(uscita, "text." + String(nfile).padStart(3, "0")), "w");
        fds.push(fd);
        pos = 0;
      }
      writeSync(fd, testo);
      // the meta is in <head>: no need to scan a 600 KB page for it
      const head = html.indexOf("</head>");
      const m = coordRe.exec(html) ?? metaRe.exec(head > 0 ? html.slice(0, head) : html);
      const ll = m ? [parseFloat(m[1]), parseFloat(m[2])] : null;
      idx.writeUInt32LE(pos, n * 12);
      idx.writeUInt32LE(testo.length, n * 12 + 4);
      idx.writeUInt16LE(nfile, n * 12 + 8);
      idx.writeUInt16LE(ll ? 1 : 0, n * 12 + 10);
      pos += testo.length;
      testoTot += testo.length;
      if (ll && ll[0] >= -90 && ll[0] <= 90 && ll[1] >= -180 && ll[1] <= 180) {
        geo.push([cella(ll[0], ll[1]), roundPy(ll[0] * 1e6), roundPy(ll[1] * 1e6), n]);
      }
      if (j % 500 === 0) {
        progresso({ fase: "testo", fatti: j, totale: ordine.length });
        await new Promise((r) => setImmediate(r));
      }
    }
    closeSync(fd);
    fds.pop();
    writeFileSync(join(uscita, "art.idx"), idx);

    // 3. titles, redirects included
    progresso({ fase: "indici", fatti: 0, totale: 1 });
    const titoli: { k: Buffer; t: string; n: number }[] = articoli.map((art, n) => ({ k: art.k, t: art.titolo, n }));
    for (const [path, e] of redirect) {
      const n = finale(path);
      if (n !== null) titoli.push({ k: chiave(e.title), t: e.title, n });
    }
    titoli.sort((x, y) => Buffer.compare(x.k, y.k) || perCodepoint(x.t, y.t));
    const tidx = Buffer.alloc(titoli.length * 32);
    const tdatParti: Buffer[] = [];
    let tdatLen = 0;
    const ttop = Buffer.alloc(Math.ceil(titoli.length / TOP_OGNI) * KEY_LEN);
    titoli.forEach((t, i) => {
      const tb = Buffer.from(translit(t.t), "utf8").subarray(0, 255);
      t.k.copy(tidx, i * 32);
      tidx.writeUInt32LE(t.n, i * 32 + 24);
      tidx.writeUInt32LE(tdatLen, i * 32 + 28);
      tdatParti.push(Buffer.from([tb.length]), tb);
      tdatLen += 1 + tb.length;
      if (i % TOP_OGNI === 0) t.k.copy(ttop, (i / TOP_OGNI) * KEY_LEN);
    });
    writeFileSync(join(uscita, "titles.idx"), tidx);
    writeFileSync(join(uscita, "titles.dat"), Buffer.concat(tdatParti, tdatLen));
    writeFileSync(join(uscita, "titles.top"), ttop);

    // 4. the geographic index
    geo.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || x[3] - y[3]);
    const gb = Buffer.alloc(geo.length * 16);
    geo.forEach(([c, la, lo, n], i) => {
      gb.writeUInt32LE(c, i * 16);
      gb.writeInt32LE(la, i * 16 + 4);
      gb.writeInt32LE(lo, i * 16 + 8);
      gb.writeUInt32LE(n, i * 16 + 12);
    });
    writeFileSync(join(uscita, "geo.idx"), gb);

    const info: [string, string | number][] = [
      ["format", FORMATO], ["name", translit(z.metadata("Title"))], ["lang", lingua],
      ["source", basename(zimPath)], ["date", z.metadata("Date")],
      ["articles", articoli.length], ["titles", titoli.length], ["geo", geo.length],
      ["text_files", nfile + 1], ["license", "Testo da Wikipedia, CC BY-SA 4.0"],
    ];
    writeFileSync(join(uscita, "info.txt"), info.map(([k, v]) => `${k}=${v}\n`).join(""));

    const byte = idx.length + tidx.length + tdatLen + ttop.length + gb.length + testoTot;
    progresso({ fase: "fatto", fatti: 1, totale: 1 });
    return { articoli: articoli.length, titoli: titoli.length, geo: geo.length, byte, secondi: (Date.now() - t0) / 1000 };
  } finally {
    for (const f of fds) closeSync(f);
    z.close();
  }
}
