/**
 * An article's HTML -> the text of the ORION Wiki format (FORMATO.md in the
 * SDK, internal/examples/wiki/FORMATO.md), plus the search key.
 *
 * ⚠️ The firmware's panel font draws ASCII and à è é ì ò ù £ € only:
 * everything else is transliterated HERE, once, so the device never draws
 * a '?'. And the search key must be exactly what wiki.lua computes from
 * what the user types: the two rules live in chiave() and in norm() there.
 *
 * The tokenizer behaves like Python's html.parser where it matters (this
 * code was checked byte for byte against the Python converter it replaces):
 * self-closing tags give a start and an end, script/style content is raw
 * text, entities are decoded in text and attributes, unknown '<' is text.
 */
import anyAscii from "any-ascii";
import { decodeHTML } from "entities";

const TENUTI = new Set([..."àèéìòù£€"]);
const MAIUSCOLE: Record<string, string> = { "À": "A'", "È": "E'", "É": "E'", "Ì": "I'", "Ò": "O'", "Ù": "U'" };
const SOSTITUTI: Record<string, string> = {
  " ": " ", " ": " ", " ": " ", "–": "-", "—": "-",
  "‘": "'", "’": "'", "“": '"', "”": '"', "«": '"',
  "»": '"', "…": "...", "°": " gradi ", "×": "x",
};
const SALTA_CAT = /^[\p{M}\p{C}]$/u;

/** Only what the font draws: printable ASCII and à è é ì ò ù £ €. */
export function translit(s: string): string {
  let out = "";
  for (const c of s) {
    const o = c.codePointAt(0)!;
    if ((o >= 0x20 && o < 0x7f) || TENUTI.has(c)) out += c;
    else if (c in MAIUSCOLE) out += MAIUSCOLE[c];
    else if (c in SOSTITUTI) out += SOSTITUTI[c];
    else if (c === "\n" || c === "\t" || c === "\r") out += " ";
    else if (SALTA_CAT.test(c)) continue;
    else out += anyAscii(c);
  }
  return out;
}

export const KEY_LEN = 24;

/** The search key: lower case, ASCII, a-z0-9 and single spaces, 24 bytes. */
export function chiave(titolo: string): Buffer {
  const s = anyAscii(titolo).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return Buffer.from(s, "ascii").subarray(0, KEY_LEN);
}

export const SEZIONI_VIA: Record<string, Set<string>> = {
  it: new Set(["note", "bibliografia", "collegamenti esterni", "altri progetti", "fonti",
    "riferimenti", "filmografia", "discografia", "opere"]),
  en: new Set(["references", "notes", "external links", "further reading", "bibliography",
    "sources", "citations"]),
};

const VIA_CLASSI = ["reference", "mw-ref", "reflist", "references", "hatnote", "noprint",
  "navbox", "mw-editsection", "metadata", "thumb", "gallery", "mw-empty-elt",
  "mwe-math-element", "sinottico_piede", "portale", "avviso", "ambox",
  "shortdescription", "nomobile", "phonos", "toc"];
const VIA_TAG = new Set(["script", "style", "sup", "figure", "img", "math", "audio", "video", "svg",
  "figcaption", "caption", "noscript", "link", "meta", "button", "input"]);
const VUOTI = new Set(["br", "img", "hr", "meta", "link", "input", "wbr", "source", "track", "col", "area"]);
const RAW = new Set(["script", "style"]);

/** Python's str.strip(): whitespace at both ends. */
const strip = (s: string): string => s.replace(/^\s+|\s+$/g, "");
const spazi = (s: string): string => s.replace(/\s+/g, " ");

/** One article. `risolvi` turns a link's href into an article number. */
export class Pagina {
  righe: string[] = [];
  scheda: string[] = [];
  private dentro = 0;
  private salta: number[] = [];
  private prof = 0;
  private buf: string[] = [];
  private blocco: string | null = null;
  private link: number | null = null;
  private viaLivello = 0;
  private infobox = 0;
  private rigaIb: [string, string] | null = null;
  private cella: string | null = null;

  constructor(private risolvi: (href: string) => number | null, private viaSezioni: Set<string>) {}

  chiudi(): void {
    const testo = strip(spazi(this.buf.join("")));
    this.buf = [];
    if (!testo || this.viaLivello) {
      this.blocco = null;
      return;
    }
    if (this.blocco && this.blocco[0] === "h") this.righe.push("\x01" + this.blocco[1] + testo);
    else if (this.blocco === "li") this.righe.push("\x02" + testo);
    else this.righe.push(testo);
    this.blocco = null;
  }

  private testo(s: string): void {
    if (!this.dentro || this.salta.length) return;
    if (this.cella !== null && this.rigaIb !== null) {
      this.rigaIb[this.cella === "th" ? 0 : 1] += s;
    } else if (this.infobox) {
      return;
    } else {
      this.buf.push(translit(s).replace(/[\x03\x04\x05]/g, ""));
    }
  }

  private start(tag: string, a: Record<string, string | null>): void {
    if (VUOTI.has(tag)) {
      if (tag === "br") this.testo(" ");
      return;
    }
    this.prof += 1;
    const classi = a["class"] ?? "";
    if (!this.dentro) {
      if (tag === "div" && classi.includes("mw-parser-output")) this.dentro = this.prof;
      return;
    }
    if (this.salta.length) return;
    const parole = classi.split(/\s+/).filter((x) => x.length);
    if (VIA_TAG.has(tag) || VIA_CLASSI.some((c) => parole.includes(c)) ||
        a["role"] === "note" || (a["style"] ?? "").replace(/ /g, "").includes("display:none")) {
      this.salta.push(this.prof);
      return;
    }
    if (tag === "table") {
      if (classi.includes("infobox") || classi.includes("sinottico")) {
        if (!this.infobox) {
          this.infobox = this.prof;
          return;
        }
      }
      this.salta.push(this.prof);
      return;
    }
    if (this.infobox) {
      if (tag === "tr") this.rigaIb = ["", ""];
      else if (tag === "th" || tag === "td") this.cella = tag;
      return;
    }
    if (tag === "h2" || tag === "h3" || tag === "h4") {
      this.chiudi();
      this.blocco = tag;
    } else if (tag === "p" || tag === "li" || tag === "dd" || tag === "dt") {
      this.chiudi();
      this.blocco = tag === "p" ? "p" : "li";
    } else if (tag === "a" && this.blocco && a["rel"] === "mw:WikiLink") {
      const n = this.risolvi(a["href"] ?? "");
      if (n !== null && !this.viaLivello) {
        this.link = n;
        this.buf.push("\x03");
      }
    }
  }

  private end(tag: string): void {
    if (VUOTI.has(tag)) return;
    if (this.salta.length && this.salta[this.salta.length - 1] === this.prof) {
      this.salta.pop();
    } else if (this.dentro && !this.salta.length) {
      if (this.infobox) {
        if ((tag === "div" || tag === "p" || tag === "li" || tag === "dd") && this.cella !== null && this.rigaIb !== null) {
          this.rigaIb[this.cella === "th" ? 0 : 1] += " "; // two values in one cell
        }
        if (tag === "th" || tag === "td") {
          this.cella = null;
        } else if (tag === "tr" && this.rigaIb !== null) {
          const [k, v] = this.rigaIb.map((x) => strip(spazi(translit(x))));
          if (k && v && !this.viaLivello) this.scheda.push("\x02" + k + ": " + v);
          this.rigaIb = null;
        } else if (tag === "table" && this.infobox === this.prof) {
          this.infobox = 0;
        }
      } else if (tag === "a" && this.link !== null) {
        if (this.buf.length && this.buf[this.buf.length - 1] === "\x03") this.buf.pop();
        else this.buf.push("\x04" + this.link + "\x05");
        this.link = null;
      } else if ((tag === "h2" || tag === "h3" || tag === "h4") && this.blocco === tag) {
        const titolo = strip(spazi(this.buf.join("")));
        const livello = Number(tag[1]);
        if (this.viaLivello && livello <= this.viaLivello) this.viaLivello = 0;
        if (this.viaSezioni.has(strip(titolo.toLowerCase().replace(/[^a-z ]/g, "")))) {
          this.buf = [];
          this.blocco = null;
          this.viaLivello = livello;
        } else {
          this.chiudi();
        }
      } else if (tag === "p" || tag === "li" || tag === "dd" || tag === "dt") {
        this.chiudi();
      }
      if (this.dentro === this.prof && tag === "div") {
        this.chiudi();
        this.dentro = 0;
      }
    }
    this.prof -= 1;
  }

  /** The whole document, as html.parser would see it. */
  feed(html: string): void {
    const n = html.length;
    let i = 0;
    let testo = "";
    const scarica = (): void => {
      if (testo) {
        this.testo(decodeHTML(testo));
        testo = "";
      }
    };
    while (i < n) {
      const lt = html.indexOf("<", i);
      if (lt < 0) {
        testo += html.slice(i);
        break;
      }
      testo += html.slice(i, lt);
      const c = html.charCodeAt(lt + 1);
      const lettera = (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
      if (html.startsWith("<!--", lt)) {
        scarica();
        const e = html.indexOf("-->", lt + 4);
        i = e < 0 ? n : e + 3;
      } else if (html[lt + 1] === "!" || html[lt + 1] === "?") {
        scarica();
        const e = html.indexOf(">", lt + 2);
        i = e < 0 ? n : e + 1;
      } else if (html[lt + 1] === "/") {
        const m = /^<\/([a-zA-Z][^\t\n\r\f />]*)[^>]*>/.exec(html.slice(lt, lt + 300));
        if (!m) {
          testo += "<";
          i = lt + 1;
          continue;
        }
        scarica();
        this.end(m[1].toLowerCase());
        i = lt + m[0].length;
      } else if (lettera) {
        const fine = fineTag(html, lt);
        if (fine < 0) {
          testo += "<";
          i = lt + 1;
          continue;
        }
        scarica();
        const corpo = html.slice(lt + 1, fine);
        const auto = corpo.endsWith("/");
        const { tag, attrs } = leggiTag(auto ? corpo.slice(0, -1) : corpo);
        this.start(tag, attrs);
        i = fine + 1;
        if (auto) this.end(tag);
        else if (RAW.has(tag)) {
          // script/style: everything up to the closing tag is text
          const re = new RegExp("</" + tag + "\\s*>", "i");
          const m = re.exec(html.slice(i));
          const e = m ? i + m.index : n;
          testo += html.slice(i, e);
          i = e;
          scarica();
        }
      } else {
        testo += "<";
        i = lt + 1;
      }
    }
    scarica();
  }
}

/** Where a start tag ends: the '>' outside quotes. */
function fineTag(s: string, da: number): number {
  let q = "";
  for (let i = da + 1; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = "";
    } else if (c === '"' || c === "'") q = c;
    else if (c === ">") return i;
  }
  return -1;
}

const ATTR = /([^\s/>"'=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function leggiTag(corpo: string): { tag: string; attrs: Record<string, string | null> } {
  const m = /^([a-zA-Z][^\t\n\r\f />]*)/.exec(corpo);
  const tag = (m ? m[1] : corpo).toLowerCase();
  const attrs: Record<string, string | null> = {};
  const resto = corpo.slice(m ? m[1].length : corpo.length);
  ATTR.lastIndex = 0;
  let a: RegExpExecArray | null;
  while ((a = ATTR.exec(resto)) !== null) {
    const nome = a[1].toLowerCase();
    const v = a[2] ?? a[3] ?? a[4];
    attrs[nome] = v === undefined ? null : decodeHTML(v); // the last one wins, as in dict()
  }
  return { tag, attrs };
}
