/**
 * Formato .pdar — container per ebook paginati lato PC e renderizzati
 * direttamente dal firmware Orion senza re-layout on-device.
 *
 * Layout binario (little-endian):
 *
 *   [Header 32 B]
 *     [0..4]   magic         "PDAR" (0x50 0x44 0x41 0x52)
 *     [4..6]   version       u16 (1)
 *     [6..8]   flags         u16  (bit0=compressed bit1=has_images bit2..15 reserved)
 *     [8..12]  page_count    u32
 *     [12..16] toc_offset    u32  (0 se no TOC)
 *     [16..20] body_offset   u32
 *     [20..24] total_size    u32
 *     [24..32] reserved      (zero)
 *
 *   [TOC opzionale, presente se toc_offset != 0]
 *     toc_count: u16
 *     toc_entries[toc_count]:
 *       title_len: u8
 *       title:     utf8 (title_len byte)
 *       page_idx:  u16
 *       byte_off:  u32  (offset assoluto della PAGE_MARKER)
 *
 *   [Body — sequence di pagine]
 *     per ogni pagina:
 *       PAGE_MARKER  0xFF 0xFE  (2 byte)
 *       page_size    u32         (bytes del payload)
 *       payload      stream di token tagged
 *
 *   [Token nel payload]
 *     0x00              END_OF_PAGE (opzionale, payload può terminare implicito)
 *     0x01 u16 utf8     TEXT (normale)
 *     0x02 u16 utf8     TEXT_BOLD
 *     0x03 u16 utf8     TEXT_ITALIC
 *     0x04 u8 u16 utf8  HEADING(level, text)   level=1..6
 *     0x05              NEWLINE         (line break, niente gap extra)
 *     0x06              PARAGRAPH       (gap maggiore di una linea)
 *     0x07 u16 utf8     CODE_INLINE
 *     0x08 u16 utf8     CODE_BLOCK
 *     0x10 u16 u16 ...  IMAGE(w, h, bitmap_1bpp)   ceil(w/8) * h byte
 */

export const PDAR_MAGIC = Buffer.from([0x50, 0x44, 0x41, 0x52]); // "PDAR"
export const PDAR_VERSION = 1;
export const PDAR_HEADER_SIZE = 32;
export const PAGE_MARKER = Buffer.from([0xff, 0xfe]);

/** Bit-flags nel header. */
export const PDAR_FLAG_COMPRESSED = 1 << 0;
export const PDAR_FLAG_HAS_IMAGES = 1 << 1;

/** Token type byte. */
export enum PdarToken {
  END_OF_PAGE = 0x00,
  TEXT = 0x01,
  TEXT_BOLD = 0x02,
  TEXT_ITALIC = 0x03,
  HEADING = 0x04,
  NEWLINE = 0x05,
  PARAGRAPH = 0x06,
  CODE_INLINE = 0x07,
  CODE_BLOCK = 0x08,
  IMAGE = 0x10,
}

// ---------------------------------------------------------------------------
//  AST intermedio (output dei readers EPUB/PDF/MD)
// ---------------------------------------------------------------------------

export type RunStyle = "text" | "bold" | "italic" | "code_inline";

export interface TextRun {
  type: RunStyle;
  text: string;
}

export interface DitheredImage {
  /** Larghezza in pixel (multipla di 1, non necessariamente di 8). */
  width: number;
  /** Altezza in pixel. */
  height: number;
  /** Bitmap 1bpp MSB-first, ceil(width/8) * height byte. Bit 1 = pixel chiaro
   *  (Sharp Memory LCD è normally-white, il bit "alto" lascia il LC OFF). */
  pixels: Buffer;
}

export type EbookBlock =
  | { kind: "paragraph"; runs: TextRun[] }
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: "code_block"; text: string }
  | { kind: "image"; data: DitheredImage; alt?: string };

export interface EbookDoc {
  /** Titolo opzionale (es. dal frontmatter MD o `<title>` EPUB). */
  title?: string;
  /** Lista di capitoli; ogni capitolo è una flat list di blocchi. */
  chapters: Array<{ title?: string; blocks: EbookBlock[] }>;
}

// ---------------------------------------------------------------------------
//  Output del reflow (immediata input per il writer)
// ---------------------------------------------------------------------------

export type PageItem =
  | { t: PdarToken.TEXT | PdarToken.TEXT_BOLD | PdarToken.TEXT_ITALIC | PdarToken.CODE_INLINE; s: string }
  | { t: PdarToken.HEADING; level: number; s: string }
  | { t: PdarToken.NEWLINE }
  | { t: PdarToken.PARAGRAPH }
  | { t: PdarToken.CODE_BLOCK; s: string }
  | { t: PdarToken.IMAGE; width: number; height: number; pixels: Buffer };

export interface ReflowedPage {
  items: PageItem[];
  /** Titolo capitolo associato (se è la prima pagina di un capitolo). */
  chapterTitle?: string;
}

// ---------------------------------------------------------------------------
//  Display constants (firmware Orion, Sharp LS032 + font_6x12)
//
//  Il firmware usa il display in ROT_90: dal punto di vista applicativo il
//  frame è 536 wide × 336 tall. La paginazione qui sotto è calcolata sulle
//  dimensioni "logiche" così che il firmware non debba mai re-impaginare.
//  Le immagini sono limitate a IMAGE_MAX_W multiplo di 8 per consentire al
//  firmware un blit byte-aligned senza shift bit-wise.
//  L'ebook reader del firmware usa font_6x12 (advance 6×12 px) — vedi ui.c
//  eb_reader_draw, sharp_lcd_set_font(&font_6x12), e adv_h = 12*scale.
//  FONT_ADVANCE_W/H QUI DEVONO combaciare col font del firmware: se non
//  combaciano, le righe wrappano alla colonna sbagliata e/o le pagine vanno
//  in overflow verticale. I .pdar generati col vecchio 8x8 vanno ri-convertiti.
// ---------------------------------------------------------------------------

export const SHARP_W = 536; // larghezza logica (ROT_90)
export const SHARP_H = 336; // altezza logica (ROT_90)
export const FONT_ADVANCE_W = 6;  // font_6x12 advance width
export const FONT_ADVANCE_H = 12; // font_6x12 advance height
export const PAGE_MARGIN_TOP = 34;     // sotto la status bar (30 px + 4)
export const PAGE_MARGIN_BOTTOM = 8;   // niente footer (contatore pagina nello status bar)

/**
 * Margini laterali e interlinea, **in funzione della scala**.
 *
 * ⚠️ Questa tabella e' `eb_metriche()` di `ui.c` scritta in TypeScript. Sono
 * due programmi diversi e il codice non si puo' condividere, ma il numero deve
 * stare in un posto solo per ciascuno — e la **scala** viaggia dentro il file
 * (`reserved[0]` dell'header) proprio per non doverne allineare due.
 *
 * ⚠️ A scala 1 i margini sono larghi apposta: senza, la riga sarebbe di 85
 * caratteri, e una riga cosi' lunga si perde con l'occhio tornando a capo. I
 * libri stampati stanno fra 60 e 65 per la stessa ragione. Cosi' sono 70.
 *
 * ⚠️ E a scala 1 l'interlinea e' 14 e non 12: il font usa tutte e 12 le righe
 * della sua cella — discendenti di `p` e `q` compresi — quindi a 12 le righe si
 * toccherebbero. A scala 2 non serve, perche' il raddoppio porta la cella a 24.
 */
export function layoutForScale(scale: 1 | 2 | 3): {
  left: number;
  right: number;
  lineHeight: number;
} {
  if (scale === 1) return { left: 58, right: 58, lineHeight: 14 };
  return { left: 16, right: 8, lineHeight: FONT_ADVANCE_H * scale };
}

/** @deprecated usa `layoutForScale()`: i margini dipendono dalla scala. */
export const PAGE_MARGIN_LEFT = 16;
/** @deprecated usa `layoutForScale()`. */
export const PAGE_MARGIN_RIGHT = 8;

/** Larghezza massima per le immagini, multipla di 8 (vincolo del blit
 *  byte-aligned del firmware). 528 = 66 byte/riga. */
export const IMAGE_MAX_W = 528;
/** Altezza massima per le immagini: lascia ~80 px verticali al testo
 *  intorno. Display alto 336, ~256 disponibili per l'immagine in pagina. */
export const IMAGE_MAX_H = 256;

export interface PageMetrics {
  cols: number;
  rows: number;
}

export function metricsForScale(scale: 1 | 2 | 3): PageMetrics {
  const { left, right, lineHeight } = layoutForScale(scale);
  const cw = FONT_ADVANCE_W * scale;
  const cols = Math.floor((SHARP_W - left - right) / cw);
  const rows = Math.floor(
    (SHARP_H - PAGE_MARGIN_TOP - PAGE_MARGIN_BOTTOM) / lineHeight,
  );
  return { cols: Math.max(1, cols), rows: Math.max(1, rows) };
}
