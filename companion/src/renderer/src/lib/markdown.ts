/**
 * Markdown di una nota `.md` in HTML, per l'anteprima della pagina Note.
 *
 * ⚠️ Il testo arriva dalla microSD, cioe' da chiunque ci abbia scritto, e
 * l'HTML finisce in `dangerouslySetInnerHTML` dentro Electron. Per questo
 * il renderer di `marked` e' ristretto:
 *  - l'**HTML grezzo** dentro la nota esce come testo, non come markup:
 *    niente `<script>`, niente `<img onerror>`;
 *  - i **link** sono solo testo sottolineato (l'indirizzo nel tooltip):
 *    cliccandone uno la finestra dell'app navigherebbe via;
 *  - le **immagini** mostrano il testo alternativo e non caricano niente.
 * E' anche cio' che fa il dispositivo, che di link e immagini mostra il
 * testo.
 *
 * `breaks: true` perche' sul dispositivo ogni riga e' una riga (come in
 * Obsidian di default), e i `[[wiki link]]` di Obsidian si mostrano col loro
 * testo, come sul dispositivo (`md_render.c`).
 */
import { Marked, type Tokens } from "marked";

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface WikiLink extends Tokens.Generic {
  type: "wikilink";
  raw: string;
  testo: string;
}

const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html(html: string): string {
      return escape(html);
    },
    link(href: string, _title: string | null | undefined, text: string): string {
      return `<span class="md-link" title="${escape(href ?? "")}">${text}</span>`;
    },
    image(_href: string, _title: string | null, text: string): string {
      return `<span class="md-img">[${escape(text || "image")}]</span>`;
    },
  },
  extensions: [
    {
      name: "wikilink",
      level: "inline",
      start(src: string) {
        const i = src.indexOf("[[");
        return i < 0 ? undefined : i;
      },
      tokenizer(src: string): WikiLink | undefined {
        const m = /^\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/.exec(src);
        if (!m) return undefined;
        return { type: "wikilink", raw: m[0], testo: (m[2] ?? m[1]).trim() };
      },
      renderer(t: Tokens.Generic): string {
        return `<span class="md-link">${escape((t as WikiLink).testo)}</span>`;
      },
    },
  ],
});

export function markdownInHtml(testo: string): string {
  return md.parse(testo, { async: false }) as string;
}

export function eMarkdown(nome: string): boolean {
  return nome.toLowerCase().endsWith(".md");
}
