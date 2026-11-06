/**
 * PDF reader → EbookDoc (best-effort).
 *
 * Limitazioni (chiare al consumer dell'app):
 *  - Layout complessi (colonne, tabelle, formule) vengono linearizzati come
 *    paragrafi nell'ordine in cui pdfjs emette i textItem. Su PDF "narrative"
 *    (libri, articoli) il risultato è ragionevole; su layout densi può
 *    produrre scrambled text — accettato.
 *  - Niente immagini in questa prima versione (le richiederebbe getOperatorList
 *    + decode PDF.js Stream object). Saranno aggiungibili in un secondo
 *    momento se serve davvero.
 *  - Heading detection euristica: una "linea" il cui font size è ≥ 1.3× il
 *    mediano del documento diventa heading (level dipende dal rapporto).
 *
 * Ogni pagina del PDF diventa un capitolo nell'EbookDoc se il documento ha
 * più di 50 pagine (così il TOC ha sense). Altrimenti l'intero documento è
 * un singolo capitolo e il reflow re-impagina liberamente sulle dimensioni
 * Sharp.
 */

import { readFile } from "node:fs/promises";
import type { EbookBlock, EbookDoc, TextRun } from "../format";

// pdfjs-dist 4 è ESM-only. In TS commonjs lo importiamo via dynamic import
// per evitare il problema "require() of ES Module".
type PdfjsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsCache: PdfjsModule | null = null;

async function loadPdfjs(): Promise<PdfjsModule> {
  if (pdfjsCache) return pdfjsCache;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const mod = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as PdfjsModule;
  // pdfjs v4 decodifica sul main thread tramite un "fake worker", ma DEVE
  // comunque importare il modulo worker via GlobalWorkerOptions.workerSrc.
  // Impostarlo a "" viene trattato come "non specificato" → errore
  // 'Setting up fake worker failed: No "GlobalWorkerOptions.workerSrc"
  // specified'. Puntiamo quindi al file worker reale come file:// URL
  // (cross-platform). NB: in build packaged il worker va lasciato fuori
  // dall'asar (vedi electron-builder.yml → asarUnpack) o il dynamic import
  // del .mjs dall'asar fallisce.
  if (mod.GlobalWorkerOptions) {
    const { pathToFileURL } = await import("node:url");
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    mod.GlobalWorkerOptions.workerSrc = pathToFileURL(
      req.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
    ).href;
  }
  pdfjsCache = mod;
  return mod;
}

// ---------------------------------------------------------------------------
//  Tipi minimali per i text item emessi da pdfjs
// ---------------------------------------------------------------------------

interface PdfTextItem {
  str: string;
  /** [sx, _, _, sy, tx, ty] — sy = font height in user-space. */
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
}

interface PdfLine {
  y: number;
  fontSize: number;
  text: string;
}

// ---------------------------------------------------------------------------
//  Page → lines (grouping per ty)
// ---------------------------------------------------------------------------

function groupItemsToLines(items: PdfTextItem[]): PdfLine[] {
  if (items.length === 0) return [];
  // Tolleranza Y per considerare due item sulla stessa linea. Usa la metà
  // del font dell'item più piccolo.
  const fontSizes = items.map((it) => Math.abs(it.transform[3]) || it.height || 10);
  const minFont = Math.max(2, Math.min(...fontSizes));
  const yTol = minFont * 0.5;

  // Ordina per ty discendente (PDF y cresce verso l'alto → top-down).
  const sorted = [...items].sort((a, b) => {
    const ya = a.transform[5];
    const yb = b.transform[5];
    if (Math.abs(ya - yb) > yTol) return yb - ya;
    return a.transform[4] - b.transform[4];
  });

  const lines: PdfLine[] = [];
  let cur: { y: number; fontSize: number; parts: string[] } | null = null;

  for (const it of sorted) {
    const y = it.transform[5];
    const fs = Math.abs(it.transform[3]) || it.height || 10;
    if (cur === null || Math.abs(cur.y - y) > yTol) {
      if (cur !== null) {
        lines.push({
          y: cur.y,
          fontSize: cur.fontSize,
          text: cur.parts.join("").replace(/\s+/g, " ").trim(),
        });
      }
      cur = { y, fontSize: fs, parts: [] };
    }
    // Mantieni il font più grande della linea (più rappresentativo per heading).
    if (fs > cur.fontSize) cur.fontSize = fs;
    // Se l'item precedente non finiva con uno spazio e il successivo non
    // inizia con uno, inseriamo uno spazio per non incollare parole.
    const last = cur.parts[cur.parts.length - 1];
    if (last && !last.endsWith(" ") && !it.str.startsWith(" ")) {
      cur.parts.push(" ");
    }
    cur.parts.push(it.str);
  }
  if (cur !== null) {
    lines.push({
      y: cur.y,
      fontSize: cur.fontSize,
      text: cur.parts.join("").replace(/\s+/g, " ").trim(),
    });
  }

  return lines.filter((l) => l.text !== "");
}

// ---------------------------------------------------------------------------
//  Lines → blocks
//
//  Strategia:
//   - Calcola fontSize mediano sul documento intero (più stabile del per-page).
//   - Una linea con fontSize ≥ 1.3 × mediana → heading. Il level è scalato
//     col rapporto (≥1.8× = h1, ≥1.5× = h2, altrimenti h3).
//   - Linee adiacenti normali vengono accumulate in un paragrafo. Cambio di
//     paragrafo: salto verticale > 1.6 × fontSize linea precedente, o linea
//     classificata heading.
// ---------------------------------------------------------------------------

function classifyHeadingLevel(
  ratio: number,
): 0 | 1 | 2 | 3 {
  if (ratio < 1.3) return 0;
  if (ratio >= 1.8) return 1;
  if (ratio >= 1.5) return 2;
  return 3;
}

function linesToBlocks(
  lines: PdfLine[],
  medianFont: number,
): EbookBlock[] {
  const blocks: EbookBlock[] = [];
  let paraRuns: TextRun[] = [];
  let prevLine: PdfLine | null = null;

  const flushParagraph = () => {
    if (paraRuns.length === 0) return;
    blocks.push({ kind: "paragraph", runs: paraRuns });
    paraRuns = [];
  };

  for (const line of lines) {
    const ratio = line.fontSize / Math.max(1, medianFont);
    const headingLevel = classifyHeadingLevel(ratio);

    if (headingLevel > 0) {
      flushParagraph();
      blocks.push({
        kind: "heading",
        level: headingLevel as 1 | 2 | 3,
        text: line.text,
      });
      prevLine = line;
      continue;
    }

    // Verifica break paragrafo: gap verticale grande.
    if (prevLine !== null) {
      const gap = Math.abs(prevLine.y - line.y);
      if (gap > prevLine.fontSize * 1.6) {
        flushParagraph();
      } else {
        paraRuns.push({ type: "text", text: " " });
      }
    }
    paraRuns.push({ type: "text", text: line.text });
    prevLine = line;
  }
  flushParagraph();
  return blocks;
}

// ---------------------------------------------------------------------------
//  Entry point
// ---------------------------------------------------------------------------

interface ParsePdfOptions {
  /** Se true (default per documenti > 50 pagine), ogni pagina PDF diventa
   *  un capitolo separato; utile per dare un TOC al lettore Orion. */
  pagePerChapter?: boolean;
  /** Limite massimo pagine da processare (safety net). Default 1000. */
  maxPages?: number;
  /** Callback chiamato dopo ogni pagina PDF estratta (current 1-based, total).
   *  Se ritorna Promise viene awaitata: usalo per yieldare al loop event. */
  onPage?: (current: number, total: number) => void | Promise<void>;
}

export async function parsePdf(
  bufOrPath: Buffer | string,
  opts: ParsePdfOptions = {},
): Promise<EbookDoc> {
  const pdfjs = await loadPdfjs();
  const data =
    typeof bufOrPath === "string" ? await readFile(bufOrPath) : bufOrPath;

  // pdfjs-dist accetta Uint8Array. Buffer estende Uint8Array, ma pdfjs
  // internamente fa instanceof check → passiamo una Uint8Array "pura".
  const u8 = new Uint8Array(
    data.buffer,
    data.byteOffset,
    data.byteLength,
  );

  // Disabilita feature non disponibili in Node (font sourcing dal disk).
  const loadingTask = pdfjs.getDocument({
    data: u8,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  });
  const pdf = await loadingTask.promise;

  const maxPages = Math.min(pdf.numPages, opts.maxPages ?? 1000);
  const allLines: PdfLine[][] = [];
  const allFontSizes: number[] = [];

  for (let i = 1; i <= maxPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const items = tc.items.filter(
      (it: unknown): it is PdfTextItem =>
        typeof (it as { str?: unknown }).str === "string",
    ) as PdfTextItem[];
    const lines = groupItemsToLines(items);
    for (const l of lines) allFontSizes.push(l.fontSize);
    allLines.push(lines);
    page.cleanup();
    if (opts.onPage) await opts.onPage(i, maxPages);
  }

  await pdf.cleanup();
  await pdf.destroy();

  // Mediana font size sul documento intero.
  const sortedFonts = [...allFontSizes].sort((a, b) => a - b);
  const medianFont =
    sortedFonts.length === 0
      ? 12
      : sortedFonts[Math.floor(sortedFonts.length / 2)];

  // Title: prima heading h1 trovata.
  let title: string | undefined;

  const pagePerChapter = opts.pagePerChapter ?? maxPages > 50;
  const chapters: EbookDoc["chapters"] = [];

  if (pagePerChapter) {
    for (let i = 0; i < allLines.length; i++) {
      const blocks = linesToBlocks(allLines[i], medianFont);
      const firstHeading = blocks.find((b) => b.kind === "heading");
      const chTitle =
        firstHeading?.kind === "heading"
          ? firstHeading.text.trim()
          : `Page ${i + 1}`;
      if (!title && firstHeading?.kind === "heading") {
        title = firstHeading.text.trim();
      }
      if (blocks.length > 0) chapters.push({ title: chTitle, blocks });
    }
  } else {
    const allBlocks: EbookBlock[] = [];
    for (let i = 0; i < allLines.length; i++) {
      const pageBlocks = linesToBlocks(allLines[i], medianFont);
      allBlocks.push(...pageBlocks);
    }
    const firstHeading = allBlocks.find((b) => b.kind === "heading");
    if (firstHeading?.kind === "heading") {
      title = firstHeading.text.trim();
    }
    chapters.push({ title, blocks: allBlocks });
  }

  return { title, chapters };
}
