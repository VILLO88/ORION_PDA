/**
 * Markdown reader → EbookDoc.
 *
 * Usa `marked` per il lexer, poi normalizza in EbookBlock.
 * Supporto: heading, paragraph, code_block, inline strong/em/code.
 * Liste, blockquote, link, immagini: flattenati come paragraphs di testo
 * (no link target, alt-text per le immagini).
 *
 * Capitoli: si crea un nuovo capitolo a ogni heading di livello 1.
 */

import { marked, type Token, type Tokens } from "marked";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { ditherImage } from "../dither";
import type {
  EbookBlock,
  EbookDoc,
  RunStyle,
  TextRun,
} from "../format";

type Chapter = NonNullable<EbookDoc["chapters"][number]>;

function inlineTokenToRuns(tok: Token): TextRun[] {
  switch (tok.type) {
    case "text":
      return [{ type: "text", text: (tok as Tokens.Text).text }];
    case "strong":
      return (tok as Tokens.Strong).tokens.flatMap((t) =>
        inlineTokenToRuns(t).map((r) => ({
          type: r.type === "code_inline" ? r.type : ("bold" as RunStyle),
          text: r.text,
        })),
      );
    case "em":
      return (tok as Tokens.Em).tokens.flatMap((t) =>
        inlineTokenToRuns(t).map((r) => ({
          type: r.type === "code_inline" ? r.type : ("italic" as RunStyle),
          text: r.text,
        })),
      );
    case "codespan":
      return [{ type: "code_inline", text: (tok as Tokens.Codespan).text }];
    case "link": {
      // Renderizza solo l'anchor text (no URL nel pdar).
      const inner = (tok as Tokens.Link).tokens;
      return inner.flatMap(inlineTokenToRuns);
    }
    case "image": {
      // Le immagini inline (in mezzo a un paragrafo) vengono renderizzate
      // come alt-text fra parentesi. Le immagini block-level (su una loro
      // riga) vengono estratte separatamente in tokenToBlocks come image
      // block e processed asincrono in parseMarkdown.
      const im = tok as Tokens.Image;
      return im.text ? [{ type: "italic", text: `[${im.text}]` }] : [];
    }
    case "del":
      return (tok as Tokens.Del).tokens.flatMap(inlineTokenToRuns);
    case "br":
      return [{ type: "text", text: "\n" }];
    case "html":
      // Drop tag, preserva il testo nudo.
      return [
        {
          type: "text",
          text: (tok as Tokens.HTML).text.replace(/<[^>]+>/g, ""),
        },
      ];
    case "escape":
      return [{ type: "text", text: (tok as Tokens.Escape).text }];
    default:
      return [];
  }
}

function flattenInline(tokens: Token[]): TextRun[] {
  // Compatta runs consecutive dello stesso stile per economia.
  const raw = tokens.flatMap(inlineTokenToRuns);
  const out: TextRun[] = [];
  for (const r of raw) {
    if (r.text === "") continue;
    const last = out[out.length - 1];
    if (last && last.type === r.type) last.text += r.text;
    else out.push({ ...r });
  }
  return out;
}

function listToBlocks(list: Tokens.List): EbookBlock[] {
  const out: EbookBlock[] = [];
  list.items.forEach((item, idx) => {
    const startNum =
      typeof list.start === "number" ? list.start : Number(list.start) || 1;
    const prefix = list.ordered ? `${startNum + idx}. ` : "• ";
    const runs: TextRun[] = [{ type: "text", text: prefix }];
    for (const t of item.tokens) {
      if (t.type === "text" || t.type === "paragraph") {
        const child = (t as Tokens.Text | Tokens.Paragraph).tokens ?? [];
        runs.push(...flattenInline(child));
      } else if (t.type === "list") {
        // Sublist: appiattiamo (perderemo indentazione, accettabile per ora).
        out.push({ kind: "paragraph", runs });
        listToBlocks(t as Tokens.List).forEach((b) => out.push(b));
        return;
      }
    }
    out.push({ kind: "paragraph", runs });
  });
  return out;
}

/** Block-level image stub usato internamente prima del dithering async. */
interface ImageRef {
  kind: "image_ref";
  href: string;
  alt?: string;
}

type BlockOrImageRef = EbookBlock | ImageRef;

function tokenToBlocks(tok: Token): BlockOrImageRef[] {
  switch (tok.type) {
    case "heading": {
      const h = tok as Tokens.Heading;
      const level = Math.max(1, Math.min(6, h.depth)) as 1 | 2 | 3 | 4 | 5 | 6;
      return [{ kind: "heading", level, text: h.text }];
    }
    case "paragraph": {
      const p = tok as Tokens.Paragraph;
      // Se il paragrafo è composto da una sola immagine, promotelo a image
      // block (così possiamo ditherare e renderizzare full-size).
      const onlyImage = p.tokens.length === 1 && p.tokens[0].type === "image";
      if (onlyImage) {
        const im = p.tokens[0] as Tokens.Image;
        return [{ kind: "image_ref", href: im.href, alt: im.text }];
      }
      return [{ kind: "paragraph", runs: flattenInline(p.tokens) }];
    }
    case "code": {
      const c = tok as Tokens.Code;
      return [{ kind: "code_block", text: c.text }];
    }
    case "blockquote": {
      const bq = tok as Tokens.Blockquote;
      const inner = bq.tokens.flatMap(tokenToBlocks);
      return inner.map<BlockOrImageRef>((b) => {
        if (b.kind === "paragraph") {
          return {
            kind: "paragraph",
            runs: [{ type: "italic", text: "» " }, ...b.runs],
          };
        }
        return b;
      });
    }
    case "list":
      return listToBlocks(tok as Tokens.List);
    case "hr":
      return [{ kind: "paragraph", runs: [{ type: "text", text: "— — —" }] }];
    case "space":
      return [];
    default:
      return [];
  }
}

function isImageRef(b: BlockOrImageRef): b is ImageRef {
  return (b as { kind: string }).kind === "image_ref";
}

async function resolveImageRef(
  ref: ImageRef,
  basePath: string | undefined,
): Promise<EbookBlock> {
  const alt = ref.alt || "image";
  try {
    if (!ref.href || ref.href.startsWith("http://") || ref.href.startsWith("https://")) {
      // Niente fetch da URL remoti (lentezza/affidabilità). Fallback ad alt.
      return { kind: "paragraph", runs: [{ type: "italic", text: `[${alt}]` }] };
    }
    const baseDir = basePath ? dirname(basePath) : process.cwd();
    const abs = isAbsolute(ref.href) ? ref.href : resolve(baseDir, ref.href);
    const buf = await readFile(abs);
    const dithered = await ditherImage(buf);
    return { kind: "image", data: dithered, alt: ref.alt };
  } catch {
    return { kind: "paragraph", runs: [{ type: "italic", text: `[${alt}]` }] };
  }
}

/**
 * @param source contenuto del file Markdown
 * @param basePath path del file `.md` sorgente — usato per risolvere
 *                 immagini relative (`![alt](img/foo.png)`).
 */
export async function parseMarkdown(
  source: string,
  basePath?: string,
): Promise<EbookDoc> {
  const tokens = marked.lexer(source);
  const chapters: Chapter[] = [];
  let docTitle: string | undefined;

  // Prima passata: lista intermedia con ImageRef ancora da risolvere.
  const intermediateChapters: { title?: string; blocks: BlockOrImageRef[] }[] = [];
  let intermediate: { title?: string; blocks: BlockOrImageRef[] } = { blocks: [] };

  for (const t of tokens) {
    if (t.type === "heading" && (t as Tokens.Heading).depth === 1) {
      const title = (t as Tokens.Heading).text;
      if (!docTitle) docTitle = title;
      if (intermediate.blocks.length > 0) {
        intermediateChapters.push(intermediate);
        intermediate = { blocks: [] };
      }
      intermediate.title = title;
      intermediate.blocks.push(...tokenToBlocks(t));
    } else {
      intermediate.blocks.push(...tokenToBlocks(t));
    }
  }
  if (intermediate.blocks.length > 0 || intermediate.title)
    intermediateChapters.push(intermediate);

  // Seconda passata: risolvi tutti gli ImageRef in parallelo (limit-friendly:
  // jimp è single-threaded ma le letture file sì).
  for (const ich of intermediateChapters) {
    const resolved: EbookBlock[] = [];
    for (const b of ich.blocks) {
      if (isImageRef(b)) {
        resolved.push(await resolveImageRef(b, basePath));
      } else {
        resolved.push(b as EbookBlock);
      }
    }
    chapters.push({ title: ich.title, blocks: resolved });
  }

  return { title: docTitle, chapters };
}
