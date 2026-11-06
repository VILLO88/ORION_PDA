/**
 * Ebook converter — Step 5+6: input Markdown → reflow paginato → .pdar.
 * Salva sul device in <mount>/books/<basename>.pdar.
 *
 * Step successivi (Step 7-8) aggiungeranno EPUB + PDF reader e image dithering.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, join, parse as parsePath } from "node:path";
import { parseEpub } from "../pdar/readers/epub";
import { parseMarkdown } from "../pdar/readers/md";
import { parsePdf } from "../pdar/readers/pdf";
import { reflow } from "../pdar/reflow";
import { buildPdar } from "../pdar/writer";
import {
  FONT_ADVANCE_H,
  FONT_ADVANCE_W,
  PAGE_MARGIN_BOTTOM,
  layoutForScale,
  PAGE_MARGIN_TOP,
  SHARP_H,
  SHARP_W,
  metricsForScale,
  type EbookDoc,
} from "../pdar/format";
import type {
  EbookPreviewPage,
  EbookPreviewRequest,
  EbookPreviewResponse,
  EbookProgressEvent,
} from "../../shared/ipc-types";

export type EbookProgressEmitter = (ev: EbookProgressEvent) => void;

export interface EbookConvertRequest {
  /** Path del sorgente sul PC. */
  sourcePath: string;
  /** Scala UI nel firmware (1, 2, 3). Default 2. */
  scale?: 1 | 2 | 3;
  /** Mount path device. Se assente, salva nel default backup dir locale. */
  mountPath?: string;
  /** Sotto-cartella su <mount>/. Default "books". */
  folder?: string;
  /** Basename del file output (no extension). Default = basename(sourcePath). */
  outputBaseName?: string;
  /** Cartella di destinazione assoluta per il local export. Se assente (e
   *  manca anche `mountPath`) si usa il default ~/Documents/Orion/books-export. */
  localOutDir?: string;
}

export interface EbookConvertResponse {
  outputPath: string;
  pageCount: number;
  tocLength: number;
  bytes: number;
}

interface ReadDocProgress {
  /** Callback `(current, total)` per readers che processano elementi in
   *  loop (capitoli EPUB, pagine PDF). Ritornare Promise per yieldare. */
  onUnit?: (current: number, total: number) => void | Promise<void>;
}

async function readDoc(
  sourcePath: string,
  progress?: ReadDocProgress,
): Promise<EbookDoc> {
  const ext = extname(sourcePath).toLowerCase();
  switch (ext) {
    case ".md":
    case ".markdown":
    case ".txt": {
      const src = await readFile(sourcePath, "utf8");
      // Markdown è in-memory veloce: niente granularità intermedia.
      if (progress?.onUnit) await progress.onUnit(1, 1);
      return parseMarkdown(src, sourcePath);
    }
    case ".epub": {
      const buf = await readFile(sourcePath);
      return parseEpub(buf, { onChapter: progress?.onUnit });
    }
    case ".pdf": {
      const buf = await readFile(sourcePath);
      return parsePdf(buf, { onPage: progress?.onUnit });
    }
    default:
      throw new Error(
        `Estensione "${ext}" non supportata. Formati: .md, .markdown, .txt, .epub, .pdf.`,
      );
  }
}

function sanitizeFolder(folder: string): string {
  const cleaned = folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").trim();
  if (cleaned === "" || cleaned.includes("..")) return "books";
  return cleaned;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

async function ensureDir(p: string): Promise<void> {
  if (!existsSync(p)) await mkdir(p, { recursive: true });
}

async function uniquePath(target: string): Promise<string> {
  if (!existsSync(target)) return target;
  const { dir, name, ext } = parsePath(target);
  let i = 1;
  while (existsSync(join(dir, `${name} (${i})${ext}`))) i++;
  return join(dir, `${name} (${i})${ext}`);
}

export async function convertEbook(
  req: EbookConvertRequest,
  emit: EbookProgressEmitter = () => undefined,
): Promise<EbookConvertResponse> {
  try {
    await stat(req.sourcePath); // throws ENOENT con messaggio chiaro.

    // Fase 1: read (parsing sorgente). Per EPUB/PDF granuliamo per capitolo/pagina
    // 0..80% del totale (è la fase dominante: unzip + HTML parse + image dither).
    emit({ phase: "read", percent: 0 });
    const doc = await readDoc(req.sourcePath, {
      onUnit: async (cur, tot) => {
        const percent = tot > 0 ? (cur / tot) * 80 : 0;
        emit({
          phase: "read",
          percent,
          chapterIdx: cur,
          totalChapters: tot,
        });
        await new Promise((r) => setImmediate(r));
      },
    });
    emit({ phase: "read", percent: 80 });

    // Fase 2: reflow paginato. 80..95% del totale.
    const total = doc.chapters.length;
    emit({ phase: "reflow", percent: 80, chapterIdx: 0, totalChapters: total });
    const scala = req.scale ?? 2;
    const { pages, toc } = await reflow(doc, scala, {
      onChapter: async (idx, tot) => {
        const percent = 80 + (idx / Math.max(1, tot)) * 15;
        emit({
          phase: "reflow",
          percent,
          chapterIdx: idx,
          totalChapters: tot,
        });
        await new Promise((r) => setImmediate(r));
      },
    });
    emit({ phase: "reflow", percent: 95, chapterIdx: total, totalChapters: total });

    // Fase 3: write su disco. 95..100%.
    emit({ phase: "write", percent: 96 });
    /* ⚠️ La scala finisce **dentro il file**: il firmware la legge e ne ricava
       margini e interlinea. Senza, un libro impaginato a scala 1 verrebbe reso
       a scala 2 e le righe sfonderebbero la pagina. */
    const buf = buildPdar({ pages, toc, scale: scala });

    const folder = sanitizeFolder(req.folder ?? "books");
    const baseRaw =
      req.outputBaseName ?? basename(req.sourcePath, extname(req.sourcePath));
    const base = sanitizeFilename(baseRaw);

    let outDir: string;
    if (req.mountPath) {
      outDir = join(req.mountPath, folder);
    } else if (req.localOutDir && req.localOutDir.trim().length > 0) {
      outDir = req.localOutDir;
    } else {
      const home =
        process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
      outDir = join(home, "Documents", "Orion", "books-export");
    }
    await ensureDir(outDir);

    const target = await uniquePath(join(outDir, `${base}.pdar`));
    await writeFile(target, buf);

    emit({ phase: "done", percent: 100 });

    return {
      outputPath: target,
      pageCount: pages.length,
      tocLength: toc.length,
      bytes: buf.length,
    };
  } catch (e) {
    emit({ phase: "error", error: (e as Error).message });
    throw e;
  }
}

export async function previewEbook(
  req: EbookPreviewRequest,
): Promise<EbookPreviewResponse> {
  await stat(req.sourcePath);

  const doc = await readDoc(req.sourcePath);
  const scale = req.scale ?? 2;
  const { pages, toc } = await reflow(doc, scale);
  const { cols, rows } = metricsForScale(scale);

  return {
    displayWidth: SHARP_W,
    displayHeight: SHARP_H,
    marginLeft: layoutForScale(scale).left,
    marginRight: layoutForScale(scale).right,
    marginTop: PAGE_MARGIN_TOP,
    marginBottom: PAGE_MARGIN_BOTTOM,
    fontAdvanceW: FONT_ADVANCE_W,
    fontAdvanceH: FONT_ADVANCE_H,
    scale,
    cols,
    rows,
    pages: pages as unknown as EbookPreviewPage[],
    toc,
  };
}
