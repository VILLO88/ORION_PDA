/**
 * Writer .pdar — serializza una lista di ReflowedPage in un Buffer binario.
 * Vedi format.ts per il layout esatto.
 */

import {
  PAGE_MARKER,
  PDAR_FLAG_HAS_IMAGES,
  PDAR_HEADER_SIZE,
  PDAR_MAGIC,
  PDAR_VERSION,
  PdarToken,
  type PageItem,
  type ReflowedPage,
} from "./format";

/** Serializza il payload di una singola pagina (sequenza di tokens). */
function encodePagePayload(items: PageItem[]): Buffer {
  const parts: Buffer[] = [];

  for (const it of items) {
    switch (it.t) {
      case PdarToken.TEXT:
      case PdarToken.TEXT_BOLD:
      case PdarToken.TEXT_ITALIC:
      case PdarToken.CODE_INLINE: {
        const utf8 = Buffer.from(it.s, "utf8");
        const head = Buffer.alloc(3);
        head.writeUInt8(it.t, 0);
        head.writeUInt16LE(utf8.length, 1);
        parts.push(head, utf8);
        break;
      }
      case PdarToken.HEADING: {
        const utf8 = Buffer.from(it.s, "utf8");
        const head = Buffer.alloc(4);
        head.writeUInt8(PdarToken.HEADING, 0);
        head.writeUInt8(it.level, 1);
        head.writeUInt16LE(utf8.length, 2);
        parts.push(head, utf8);
        break;
      }
      case PdarToken.NEWLINE:
        parts.push(Buffer.from([PdarToken.NEWLINE]));
        break;
      case PdarToken.PARAGRAPH:
        parts.push(Buffer.from([PdarToken.PARAGRAPH]));
        break;
      case PdarToken.CODE_BLOCK: {
        const utf8 = Buffer.from(it.s, "utf8");
        const head = Buffer.alloc(3);
        head.writeUInt8(PdarToken.CODE_BLOCK, 0);
        head.writeUInt16LE(utf8.length, 1);
        parts.push(head, utf8);
        break;
      }
      case PdarToken.IMAGE: {
        const head = Buffer.alloc(5);
        head.writeUInt8(PdarToken.IMAGE, 0);
        head.writeUInt16LE(it.width, 1);
        head.writeUInt16LE(it.height, 3);
        parts.push(head, it.pixels);
        break;
      }
    }
  }
  // Terminatore esplicito (utile per firmware che vuole leggere fino a EOP).
  parts.push(Buffer.from([PdarToken.END_OF_PAGE]));
  return Buffer.concat(parts);
}

export interface PdarBuildInput {
  pages: ReflowedPage[];
  toc: Array<{ title: string; pageIdx: number }>;
  flags?: number;
  /** La scala del font con cui le pagine sono state impaginate: 1 o 2.
   *  ⚠️ Finisce **dentro il file**: il firmware la legge e ne ricava margini e
   *  interlinea. Senza, un libro impaginato a scala 1 verrebbe reso a scala 2 e
   *  le righe sfonderebbero la pagina. */
  scale?: 1 | 2 | 3;
}

export function buildPdar(input: PdarBuildInput): Buffer {
  // Auto-derive HAS_IMAGES dal contenuto se non specificato.
  const hasImages = input.pages.some((p) =>
    p.items.some((it) => it.t === PdarToken.IMAGE),
  );
  const baseFlags = input.flags ?? 0;
  const flags = hasImages ? baseFlags | PDAR_FLAG_HAS_IMAGES : baseFlags;

  // 1. Serializza ogni pagina (payload + page marker + size header).
  const pageBuffers: Buffer[] = [];
  const pageOffsets: number[] = []; // relativi a body_offset
  let runningBodyOffset = 0;

  for (const p of input.pages) {
    const payload = encodePagePayload(p.items);
    const head = Buffer.alloc(PAGE_MARKER.length + 4);
    PAGE_MARKER.copy(head, 0);
    head.writeUInt32LE(payload.length, PAGE_MARKER.length);

    pageOffsets.push(runningBodyOffset);
    runningBodyOffset += head.length + payload.length;
    pageBuffers.push(head, payload);
  }

  // 2. TOC (preceduto dal header). Calcoliamo le sue dimensioni.
  let tocBuf: Buffer = Buffer.alloc(0);
  let tocOffset = 0;
  if (input.toc.length > 0) {
    tocOffset = PDAR_HEADER_SIZE; // posizionato subito dopo l'header.
    const tocParts: Buffer[] = [];
    const count = Buffer.alloc(2);
    count.writeUInt16LE(input.toc.length, 0);
    tocParts.push(count);

    // body_offset = header + toc, ma toc è quello che stiamo costruendo.
    // Calcoliamo prima i title bytes e la dimensione tot. del TOC.
    let estimatedTocSize = 2; // count
    const entryUtf8: Buffer[] = [];
    for (const t of input.toc) {
      const utf8 = Buffer.from(t.title.slice(0, 255), "utf8");
      entryUtf8.push(utf8);
      estimatedTocSize += 1 + utf8.length + 2 + 4; // title_len + title + page_idx + byte_off
    }
    const bodyOffset = PDAR_HEADER_SIZE + estimatedTocSize;

    for (let i = 0; i < input.toc.length; i++) {
      const t = input.toc[i];
      const utf8 = entryUtf8[i];
      const entry = Buffer.alloc(1 + utf8.length + 2 + 4);
      entry.writeUInt8(utf8.length, 0);
      utf8.copy(entry, 1);
      entry.writeUInt16LE(t.pageIdx, 1 + utf8.length);
      const absByteOff = bodyOffset + pageOffsets[t.pageIdx];
      entry.writeUInt32LE(absByteOff, 1 + utf8.length + 2);
      tocParts.push(entry);
    }
    tocBuf = Buffer.concat(tocParts);
  }

  // 3. Header.
  const bodyOffset = PDAR_HEADER_SIZE + tocBuf.length;
  const body = Buffer.concat(pageBuffers);
  const totalSize = bodyOffset + body.length;

  const header = Buffer.alloc(PDAR_HEADER_SIZE);
  PDAR_MAGIC.copy(header, 0);
  header.writeUInt16LE(PDAR_VERSION, 4);
  header.writeUInt16LE(flags, 6);
  header.writeUInt32LE(input.pages.length, 8);
  header.writeUInt32LE(tocOffset, 12);
  header.writeUInt32LE(bodyOffset, 16);
  header.writeUInt32LE(totalSize, 20);

  /* ⚠️ `reserved[0]` non e' piu' riservato: e' la scala del font.
     Zero vuol dire 2, cosi' i `.pdar` convertiti prima continuano a rendersi
     come prima — e sono la maggior parte di quelli che esistono. Per questo si
     scrive 0 quando la scala e' quella di sempre, invece di scrivere 2: un
     file nuovo a scala 2 resta byte per byte come uno vecchio. */
  header.writeUInt8(input.scale === 1 ? 1 : 0, 24);
  // [25..32] reserved zero.

  return Buffer.concat([header, tocBuf, body]);
}
