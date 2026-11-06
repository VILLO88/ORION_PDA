/**
 * Reflow paginato dell'AST EbookDoc → lista di ReflowedPage.
 *
 * Modello di line-breaking semplice:
 *  - word-wrap per blank (parole troppo lunghe vengono spezzate hard).
 *  - paragrafo = sequenza di TextRun emessi in inline, terminato da PARAGRAPH
 *    (gap di 1 riga vuota).
 *  - heading = riga dedicata + gap successivo (riga vuota).
 *  - code_block = righe pre-formattate, ogni line break del sorgente conta;
 *    hard-wrap orizzontale (no troncamento) se più lunghe di cols.
 *
 * Limite: niente justify, niente bold/italic mid-word (i runs si separano
 * sulle word boundaries normalmente già nel reader).
 */

import {
  FONT_ADVANCE_H,
  metricsForScale,
  PdarToken,
  type EbookBlock,
  type EbookDoc,
  type PageItem,
  type ReflowedPage,
  type RunStyle,
} from "./format";

interface ReflowState {
  cols: number;
  rows: number;
  scale: 1 | 2 | 3;
  pages: ReflowedPage[];
  pageItems: PageItem[];
  currentRow: number;
  currentCol: number;
  pendingChapterTitle?: string;
}

function newState(
  cols: number,
  rows: number,
  scale: 1 | 2 | 3,
  chapterTitle?: string,
): ReflowState {
  return {
    cols,
    rows,
    scale,
    pages: [],
    pageItems: [],
    currentRow: 0,
    currentCol: 0,
    pendingChapterTitle: chapterTitle,
  };
}

function commitPage(st: ReflowState): void {
  if (st.pageItems.length === 0) return;
  // Skippa pagine fatte di soli NEWLINE/PARAGRAPH (whitespace puro).
  // Tipico caso: paragrafo finisce esattamente a fine pagina → pushNewline
  // committa, poi pushParagraphBreak appende un PARAGRAPH su pagina fresca.
  // Se il blocco successivo è inizio capitolo (commitPage prima del titolo),
  // resta una pagina con solo [PARAGRAPH] che renderizza bianca sul firmware.
  const hasRenderable = st.pageItems.some(
    (it) => it.t !== PdarToken.NEWLINE && it.t !== PdarToken.PARAGRAPH,
  );
  if (!hasRenderable) {
    st.pageItems = [];
    st.currentRow = 0;
    st.currentCol = 0;
    // Preserva pendingChapterTitle: la prossima pagina reale lo erediterà.
    return;
  }
  st.pages.push({
    items: st.pageItems,
    chapterTitle: st.pendingChapterTitle,
  });
  st.pageItems = [];
  st.currentRow = 0;
  st.currentCol = 0;
  st.pendingChapterTitle = undefined;
}

function pushNewline(st: ReflowState): void {
  st.pageItems.push({ t: PdarToken.NEWLINE });
  st.currentRow++;
  st.currentCol = 0;
  if (st.currentRow >= st.rows) {
    commitPage(st);
  }
}

function pushParagraphBreak(st: ReflowState): void {
  st.pageItems.push({ t: PdarToken.PARAGRAPH });
  // PARAGRAPH = newline + blank line (gap maggiore).
  st.currentRow += 2;
  st.currentCol = 0;
  if (st.currentRow >= st.rows) {
    commitPage(st);
  }
}

function tokenForStyle(s: RunStyle): PdarToken {
  switch (s) {
    case "text":        return PdarToken.TEXT;
    case "bold":        return PdarToken.TEXT_BOLD;
    case "italic":      return PdarToken.TEXT_ITALIC;
    case "code_inline": return PdarToken.CODE_INLINE;
  }
}

/** Entità HTML comuni → carattere. Il lexer markdown (marked) lascia entità
 *  tipo &quot; &amp; &mdash; nel testo dei token; senza decodifica finirebbero
 *  letterali sul device. (Il path EPUB decodifica già via node-html-parser.) */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", bull: "\u2022",
  laquo: "\u00AB", raquo: "\u00BB", ldquo: "\u201C", rdquo: "\u201D",
  lsquo: "\u2018", rsquo: "\u2019",
};

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    const v = NAMED_ENTITIES[body.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

/**
 * Normalizza la tipografia Unicode per il firmware.
 *
 * Il `cp_map` di font_6x12 (Core/Src/display/bitmap_fonts.c) copre le
 * accentate italiane (à è é ì ò ù) PIÙ la punteggiatura
 * tipografica: – — ‘ ’ “ ” • …. Questi caratteri ora
 * vengono resi dal font, quindi passano INVARIATI (niente piu' appiattimento
 * in ASCII).
 *
 * I codepoint non ancora coperti li mappiamo su un glifo supportato — NON su
 * ASCII — cosi' la tipografia resta gradevole. Altri codepoint > 0x7E non
 * gestiti qui finiscono come '?'. NB: deve accadere prima del word-wrap
 * perche' cambia il conteggio colonne (es. … ora vale 1 colonna, non 3).
 */
function normalizeForDisplay(text: string): string {
  return decodeEntities(text)
    .replace(/[\u00AB\u2039]/g, "“")  // « ‹ -> " aperte
    .replace(/[\u00BB\u203A]/g, "”")  // » › -> " chiuse
    .replace(/\u201E/g, "“")           // „ double low-9 -> " aperta
    .replace(/\u201A/g, "‘")           // ‚ single low-9 -> ' aperta
    .replace(/\u25E6/g, "•")           // ◦ white bullet -> •
    .replace(/\u00A0/g, " ")           // NBSP -> spazio normale
    .replace(/\u00B7/g, ".");          // · middot -> .
}

/** Hard-split di una parola troppo lunga in chunk da `max` caratteri. */
function splitLongWord(word: string, max: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < word.length; i += max) {
    out.push(word.slice(i, i + max));
  }
  return out;
}

function pushTextChunk(
  st: ReflowState,
  text: string,
  style: RunStyle,
): void {
  if (text === "") return;
  st.pageItems.push({
    t: tokenForStyle(style) as
      | PdarToken.TEXT
      | PdarToken.TEXT_BOLD
      | PdarToken.TEXT_ITALIC
      | PdarToken.CODE_INLINE,
    s: text,
  });
  st.currentCol += text.length;
}

/** Renderizza un run inline parola-per-parola con word-wrap. */
function renderRun(
  st: ReflowState,
  text: string,
  style: RunStyle,
): void {
  text = normalizeForDisplay(text);
  // Split su whitespace, mantenendo gli spazi per ricostruire l'output.
  const tokens = text.split(/(\s+)/);
  for (const tok of tokens) {
    if (tok === "") continue;
    if (/^\s+$/.test(tok)) {
      // Whitespace: o spazio inline, o salto a inizio riga.
      if (st.currentCol > 0) {
        // Compatta gli whitespace multipli in 1 solo space.
        pushTextChunk(st, " ", style);
        if (st.currentCol >= st.cols) {
          pushNewline(st);
        }
      }
      continue;
    }
    // Parola: spezza se troppo lunga.
    const chunks =
      tok.length > st.cols ? splitLongWord(tok, st.cols) : [tok];
    for (const chunk of chunks) {
      if (st.currentCol + chunk.length > st.cols) {
        pushNewline(st);
        // (dopo newline currentCol=0, currentRow++)
      }
      pushTextChunk(st, chunk, style);
      if (st.currentCol >= st.cols) {
        pushNewline(st);
      }
    }
  }
}

function wrapHeadingLines(text: string, cols: number): string[] {
  text = normalizeForDisplay(text);
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (w.length > cols) {
      // Parola più lunga di una riga intera: chiudi la linea corrente,
      // poi spezza la parola in chunk di `cols` char.
      if (line) {
        lines.push(line);
        line = "";
      }
      for (let i = 0; i < w.length; i += cols) {
        const chunk = w.slice(i, i + cols);
        if (chunk.length === cols) lines.push(chunk);
        else line = chunk; // resto, può ancora accogliere parole successive
      }
      continue;
    }
    const candidate = line ? `${line} ${w}` : w;
    if (candidate.length <= cols) {
      line = candidate;
    } else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function renderHeading(
  st: ReflowState,
  level: number,
  text: string,
): void {
  // Forziamo a inizio riga se siamo in mezzo a un paragraph.
  if (st.currentCol > 0) pushNewline(st);
  // Heading wrappa sui confini di parola (non a metà parola come prima).
  const lines = wrapHeadingLines(text, st.cols);
  for (const line of lines) {
    st.pageItems.push({ t: PdarToken.HEADING, level, s: line });
    st.currentRow++;
    st.currentCol = 0;
    if (st.currentRow >= st.rows) commitPage(st);
  }
  // Gap dopo heading: una riga vuota.
  if (st.currentRow > 0) {
    st.pageItems.push({ t: PdarToken.NEWLINE });
    st.currentRow++;
    st.currentCol = 0;
    if (st.currentRow >= st.rows) commitPage(st);
  }
}

function renderCodeBlock(st: ReflowState, text: string): void {
  if (st.currentCol > 0) pushNewline(st);
  text = normalizeForDisplay(text);
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    // Code: hard-wrap a `cols` invece di troncare, così non si perde codice.
    // splitLongWord("") = [], quindi forziamo [""] per preservare righe vuote.
    const chunks =
      line.length > st.cols ? splitLongWord(line, st.cols) : [line];
    for (const chunk of chunks) {
      st.pageItems.push({ t: PdarToken.CODE_BLOCK, s: chunk });
      st.currentRow++;
      st.currentCol = 0;
      if (st.currentRow >= st.rows) commitPage(st);
    }
  }
  // Gap dopo blocco codice.
  st.pageItems.push({ t: PdarToken.NEWLINE });
  st.currentRow++;
  if (st.currentRow >= st.rows) commitPage(st);
}

function renderImage(
  st: ReflowState,
  img: { width: number; height: number; pixels: Buffer },
): void {
  if (st.currentCol > 0) pushNewline(st);
  const lineH = FONT_ADVANCE_H * st.scale;
  const linesNeeded = Math.ceil(img.height / lineH);

  // Se l'immagine non sta nella pagina corrente, page break.
  if (linesNeeded <= st.rows && st.currentRow + linesNeeded > st.rows) {
    commitPage(st);
  }
  // (Se linesNeeded > rows, comunque l'emettiamo: il firmware potrà clipping.
  //  Non vogliamo nasconderla, l'utente vorrà comunque vederla.)

  st.pageItems.push({
    t: PdarToken.IMAGE,
    width: img.width,
    height: img.height,
    pixels: img.pixels,
  });
  st.currentRow += linesNeeded;
  st.currentCol = 0;
  if (st.currentRow >= st.rows) commitPage(st);
}

function renderBlock(st: ReflowState, block: EbookBlock): void {
  switch (block.kind) {
    case "heading":
      renderHeading(st, block.level, block.text);
      break;
    case "paragraph":
      for (const run of block.runs) renderRun(st, run.text, run.type);
      pushParagraphBreak(st);
      break;
    case "code_block":
      renderCodeBlock(st, block.text);
      break;
    case "image":
      renderImage(st, block.data);
      break;
  }
}

export interface ReflowResult {
  pages: ReflowedPage[];
  /** TOC: lista capitoli mappati alla loro pagina di inizio. */
  toc: Array<{ title: string; pageIdx: number }>;
}

export interface ReflowProgress {
  /** Chiamata dopo ogni capitolo elaborato. `chapterIdx` è 1-based.
   *  Se ritorna una Promise viene awaitata: questo permette al chiamante
   *  di yieldare al loop event (e.g. `await new Promise(r => setImmediate(r))`)
   *  così gli IPC events arrivano al renderer in tempo reale. */
  onChapter?: (chapterIdx: number, total: number) => void | Promise<void>;
}

export async function reflow(
  doc: EbookDoc,
  scale: 1 | 2 | 3,
  progress?: ReflowProgress,
): Promise<ReflowResult> {
  const { cols, rows } = metricsForScale(scale);
  const st = newState(cols, rows, scale);
  const toc: ReflowResult["toc"] = [];
  const total = doc.chapters.length;

  for (let i = 0; i < doc.chapters.length; i++) {
    const ch = doc.chapters[i];
    // Inizio nuovo capitolo: page break se la pagina corrente ha già contenuto.
    if (st.pageItems.length > 0) commitPage(st);
    if (ch.title) {
      toc.push({ title: ch.title, pageIdx: st.pages.length });
      st.pendingChapterTitle = ch.title;
    }
    for (const b of ch.blocks) renderBlock(st, b);
    if (progress?.onChapter) {
      await progress.onChapter(i + 1, total);
    }
  }
  if (st.pageItems.length > 0) commitPage(st);

  return { pages: st.pages, toc };
}
