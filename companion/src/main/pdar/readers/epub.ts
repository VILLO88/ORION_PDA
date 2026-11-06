/**
 * EPUB reader → EbookDoc.
 *
 * Pipeline:
 *  1. Unzip via JSZip.
 *  2. Trova `META-INF/container.xml` → estrai full-path dell'OPF.
 *  3. Parsea l'OPF via DOM (node-html-parser): title + manifest + spine,
 *     robusto a namespace (dc:title, opf:item) e ordine attributi.
 *  4. Per ogni capitolo nello spine, parsea l'XHTML con node-html-parser
 *     e walka il DOM → EbookBlock[].
 *
 * Limitazioni note:
 *  - CSS ignorato: lo styling è quello del firmware (font_6x12).
 *  - Tabelle: rese a righe (celle unite da " | "), niente celle unite/nested.
 *  - Footnote: i marcatori <sup>/<sub> sono preservati nel testo, ma NON
 *    c'è linking nota↔riferimento (il corpo nota resta nel suo documento).
 */

import JSZip from "jszip";
import { parse as parseHtml, type HTMLElement, type Node } from "node-html-parser";
import { posix } from "node:path";
import { ditherImage } from "../dither";
import type { EbookBlock, EbookDoc, RunStyle, TextRun } from "../format";

// ---------------------------------------------------------------------------
//  Entry point
// ---------------------------------------------------------------------------

export interface ParseEpubOptions {
  /** Callback chiamato dopo ogni capitolo XHTML processato. `current` 1-based,
   *  `total` = numero di entries nello spine. Se ritorna una Promise viene
   *  awaitata: utile per yieldare al loop event (e.g. setImmediate) così gli
   *  IPC progress events del caller arrivano al renderer in tempo reale. */
  onChapter?: (current: number, total: number) => void | Promise<void>;
}

export async function parseEpub(
  buffer: Buffer,
  opts: ParseEpubOptions = {},
): Promise<EbookDoc> {
  const zip = await JSZip.loadAsync(buffer);

  const containerXml = await readZip(zip, "META-INF/container.xml");
  if (!containerXml) throw new Error("EPUB malformato: manca META-INF/container.xml");

  const opfPath = extractOpfPath(containerXml);
  const opfXml = await readZip(zip, opfPath);
  if (!opfXml) throw new Error(`EPUB: OPF non trovato a "${opfPath}"`);

  const { title, manifest, spine } = parseOpf(opfXml);
  const opfDir = posix.dirname(opfPath);

  const chapters: EbookDoc["chapters"] = [];
  const total = spine.length;
  for (let i = 0; i < spine.length; i++) {
    const idref = spine[i];
    const href = manifest[idref];
    if (href) {
      const chapterPath = posix.normalize(posix.join(opfDir, href));
      const xhtml = await readZip(zip, chapterPath);
      if (xhtml) {
        const { title: chTitle, blocks } = await parseChapter(
          xhtml,
          zip,
          chapterPath,
        );
        if (blocks.length > 0 || chTitle) {
          chapters.push({ title: chTitle, blocks });
        }
      }
    }
    if (opts.onChapter) await opts.onChapter(i + 1, total);
  }

  return { title, chapters };
}

async function readZipBuffer(
  zip: JSZip,
  path: string,
): Promise<Buffer | null> {
  const f = zip.file(path);
  if (f) return Buffer.from(await f.async("nodebuffer"));
  const lower = path.toLowerCase();
  const found = Object.keys(zip.files).find((k) => k.toLowerCase() === lower);
  return found
    ? Buffer.from(await zip.files[found].async("nodebuffer"))
    : null;
}

// ---------------------------------------------------------------------------
//  Zip read helper (case-insensitive fallback)
// ---------------------------------------------------------------------------

async function readZip(zip: JSZip, path: string): Promise<string | null> {
  const f = zip.file(path);
  if (f) return f.async("text");
  // Alcuni EPUB hanno case mismatch sui path
  const lower = path.toLowerCase();
  const found = Object.keys(zip.files).find((k) => k.toLowerCase() === lower);
  return found ? zip.files[found].async("text") : null;
}

// ---------------------------------------------------------------------------
//  container.xml → OPF path
// ---------------------------------------------------------------------------

function extractOpfPath(containerXml: string): string {
  const m = containerXml.match(/<rootfile\b[^>]*\bfull-path=["']([^"']+)["']/i);
  if (!m) throw new Error("EPUB: rootfile full-path non trovato in container.xml");
  return m[1];
}

// ---------------------------------------------------------------------------
//  OPF → title + manifest + spine
// ---------------------------------------------------------------------------

interface OpfData {
  title?: string;
  manifest: Record<string, string>; // id → href
  spine: string[]; // idref ordering
}

function parseOpf(opfXml: string): OpfData {
  // Parsing via DOM (node-html-parser) invece di regex: robusto a namespace
  // (dc:title, opf:item), ordine attributi e formattazione su più righe.
  // Matchiamo sul "local name" (parte dopo ':') così funziona con qualunque
  // prefisso di namespace.
  const root = parseHtml(opfXml, {
    lowerCaseTagName: true,
    comment: false,
    voidTag: { closingSlash: true, tags: ["item", "itemref", "meta", "link"] },
  });

  let title: string | undefined;
  const manifest: Record<string, string> = {}; // id → href
  const spine: string[] = []; // idref ordering

  for (const el of root.querySelectorAll("*")) {
    const tag = (el.rawTagName ?? "").toLowerCase();
    const local = tag.includes(":") ? tag.slice(tag.indexOf(":") + 1) : tag;
    if (local === "title") {
      if (!title) {
        const t = decodeHtmlEntities(el.text).trim();
        if (t) title = t;
      }
    } else if (local === "item") {
      const id = el.getAttribute("id");
      const href = el.getAttribute("href");
      if (id && href) manifest[id] = href;
    } else if (local === "itemref") {
      const idref = el.getAttribute("idref");
      if (idref) spine.push(idref);
    }
  }

  return { title, manifest, spine };
}

// ---------------------------------------------------------------------------
//  XHTML chapter → blocks
// ---------------------------------------------------------------------------

async function parseChapter(
  xhtml: string,
  zip: JSZip,
  chapterPath: string,
): Promise<{ title?: string; blocks: EbookBlock[] }> {
  const root = parseHtml(xhtml, {
    lowerCaseTagName: true,
    comment: false,
    voidTag: { closingSlash: true, tags: ["br", "hr", "img", "meta", "link"] },
  });

  const body =
    (root.querySelector("body") as HTMLElement | null) ??
    (root as unknown as HTMLElement);

  const chapterDir = posix.dirname(chapterPath);
  const blocks: EbookBlock[] = [];
  await walk(body, blocks, zip, chapterDir);

  const firstHeading = blocks.find((b) => b.kind === "heading");
  const title =
    firstHeading?.kind === "heading" ? firstHeading.text.trim() : undefined;

  return { title, blocks };
}

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const INLINE_PASSTHROUGH = new Set([
  "span", "a", "abbr", "acronym", "small", "sub", "sup", "u", "s", "del", "ins", "mark", "q",
]);

async function resolveImage(
  src: string,
  alt: string,
  zip: JSZip,
  chapterDir: string,
): Promise<EbookBlock> {
  const altText = alt || "image";
  try {
    if (!src || src.startsWith("http://") || src.startsWith("https://")) {
      return { kind: "paragraph", runs: [{ type: "italic", text: `[${altText}]` }] };
    }
    const absInZip = posix.normalize(posix.join(chapterDir, src));
    const buf = await readZipBuffer(zip, absInZip);
    if (!buf) {
      return { kind: "paragraph", runs: [{ type: "italic", text: `[${altText}]` }] };
    }
    const dithered = await ditherImage(buf);
    return { kind: "image", data: dithered, alt };
  } catch {
    return { kind: "paragraph", runs: [{ type: "italic", text: `[${altText}]` }] };
  }
}

async function walk(
  node: HTMLElement,
  blocks: EbookBlock[],
  zip: JSZip,
  chapterDir: string,
): Promise<void> {
  for (const child of node.childNodes) {
    if (!isElement(child)) continue;
    const tag = (child.rawTagName ?? "").toLowerCase();

    if (HEADING_TAGS.has(tag)) {
      const level = Math.max(1, Math.min(6, Number(tag.charAt(1)))) as
        | 1 | 2 | 3 | 4 | 5 | 6;
      const text = textContent(child).trim();
      if (text) blocks.push({ kind: "heading", level, text });
    } else if (tag === "p") {
      const runs = extractRuns(child);
      if (runs.some((r) => r.text.trim() !== "")) {
        blocks.push({ kind: "paragraph", runs });
      }
    } else if (tag === "pre") {
      const text = textContent(child).replace(/\r\n/g, "\n");
      if (text.trim() !== "") blocks.push({ kind: "code_block", text });
    } else if (tag === "blockquote") {
      const inner: EbookBlock[] = [];
      await walk(child, inner, zip, chapterDir);
      for (const b of inner) {
        if (b.kind === "paragraph") {
          blocks.push({
            kind: "paragraph",
            runs: [{ type: "italic", text: "» " }, ...b.runs],
          });
        } else {
          blocks.push(b);
        }
      }
    } else if (tag === "ul" || tag === "ol") {
      const ordered = tag === "ol";
      const items = child.childNodes.filter(
        (c) => isElement(c) && (c.rawTagName ?? "").toLowerCase() === "li",
      ) as HTMLElement[];
      items.forEach((li, idx) => {
        const prefix = ordered ? `${idx + 1}. ` : "• ";
        const runs = extractRuns(li);
        if (runs.some((r) => r.text.trim() !== "")) {
          blocks.push({
            kind: "paragraph",
            runs: [{ type: "text", text: prefix }, ...runs],
          });
        }
      });
    } else if (tag === "hr") {
      blocks.push({ kind: "paragraph", runs: [{ type: "text", text: "— — —" }] });
    } else if (tag === "img") {
      const src = child.getAttribute("src") ?? "";
      const alt = child.getAttribute("alt") ?? "";
      blocks.push(await resolveImage(src, alt, zip, chapterDir));
    } else if (
      tag === "div" ||
      tag === "section" ||
      tag === "article" ||
      tag === "header" ||
      tag === "footer" ||
      tag === "main" ||
      tag === "nav" ||
      tag === "aside" ||
      tag === "figure"
    ) {
      await walk(child, blocks, zip, chapterDir);
    } else if (tag === "table") {
      // Preserva le righe: ogni <tr> su una riga (celle unite da " | "),
      // reso come code_block così le righe restano CONSECUTIVE (un newline
      // implicito ciascuna, senza il gap di paragrafo). Riga separatrice
      // dopo l'header (celle <th>).
      const trs = child.querySelectorAll("tr");
      const lines: string[] = [];
      for (const tr of trs) {
        const cells = tr.querySelectorAll("th, td");
        if (cells.length === 0) continue;
        const texts = cells.map((c) =>
          textContent(c).replace(/\s+/g, " ").trim(),
        );
        if (texts.every((t) => t === "")) continue;
        const rowText = texts.join(" | ");
        lines.push(rowText);
        if (cells.some((c) => (c.rawTagName ?? "").toLowerCase() === "th")) {
          lines.push("—".repeat(Math.min(24, Math.max(3, rowText.length))));
        }
      }
      if (lines.length > 0) {
        blocks.push({ kind: "code_block", text: lines.join("\n") });
      }
    }
  }
}

// ---------------------------------------------------------------------------
//  Inline runs extractor
// ---------------------------------------------------------------------------

function extractRuns(elem: HTMLElement): TextRun[] {
  const raw: TextRun[] = [];

  function recurse(n: Node, style: RunStyle): void {
    if (n.nodeType === 3 /* TEXT */) {
      const text = (n as { text: string }).text;
      if (text) raw.push({ type: style, text });
      return;
    }
    if (!isElement(n)) return;
    const tag = (n.rawTagName ?? "").toLowerCase();

    let next: RunStyle = style;
    if (tag === "strong" || tag === "b") next = "bold";
    else if (tag === "em" || tag === "i" || tag === "cite") next = "italic";
    else if (tag === "code" || tag === "kbd" || tag === "tt" || tag === "samp")
      next = "code_inline";
    else if (tag === "br") {
      raw.push({ type: "text", text: "\n" });
      return;
    } else if (tag === "img") {
      const alt = n.getAttribute("alt");
      if (alt) raw.push({ type: "italic", text: `[${alt}]` });
      return;
    } else if (!INLINE_PASSTHROUGH.has(tag)) {
      // block element non atteso inline: ignora salvo passthrough.
    }
    for (const c of n.childNodes) recurse(c, next);
  }

  for (const c of elem.childNodes) recurse(c, "text");

  // Collapse di runs consecutive dello stesso stile e normalize whitespace.
  const merged: TextRun[] = [];
  for (const r of raw) {
    const text = r.type === "code_inline" ? r.text : r.text.replace(/\s+/g, " ");
    if (text === "") continue;
    const last = merged[merged.length - 1];
    if (last && last.type === r.type) last.text += text;
    else merged.push({ type: r.type, text });
  }
  return merged;
}

// ---------------------------------------------------------------------------
//  Utility
// ---------------------------------------------------------------------------

function isElement(n: Node): n is HTMLElement {
  return n.nodeType === 1;
}

function textContent(n: HTMLElement): string {
  return n.text;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}
