#ifndef BITMAP_FONT_H
#define BITMAP_FONT_H

#include <stdint.h>
#include <stddef.h>

/* Fixed-width bitmap fonts.
 *
 * Byte layouts:
 *   COL_MAJOR_LSB_TOP   one byte per column, bit 0 = row 0 (the 5x7 font)
 *   ROW_MAJOR_MSB_LEFT  one byte per row,    bit 7 = column 0
 *   ROW_MAJOR_LSB_LEFT  one byte per row,    bit 0 = column 0 (IBM PC 8x8)
 *
 * Stride per glyph:
 *   COL_MAJOR_LSB_TOP   = cell_w * ((cell_h + 7) / 8)
 *   ROW_MAJOR_*         = cell_h * ((cell_w + 7) / 8)
 *
 * Glyphs 0x20..0x7E, plus an optional accents[] table for the rest. */
typedef enum {
    FONT_LAYOUT_COL_MAJOR_LSB_TOP  = 0,
    FONT_LAYOUT_ROW_MAJOR_MSB_LEFT = 1,
    FONT_LAYOUT_ROW_MAJOR_LSB_LEFT = 2,
} bitmap_font_layout_t;

/* Maps a Unicode codepoint to an index in `accents`. Sorted by codepoint. */
typedef struct {
    uint32_t codepoint;
    uint16_t glyph_index;
} bitmap_font_cp_map_t;

typedef struct {
    const char *name;
    uint8_t  cell_w;
    uint8_t  cell_h;
    uint8_t  advance_w;
    uint8_t  advance_h;
    uint8_t  glyph_first;
    uint8_t  glyph_last;
    bitmap_font_layout_t layout;
    uint16_t glyph_stride;
    const uint8_t *glyphs;
    const uint8_t *accents;
    /* UTF-8 extension: codepoint to accents[] index, sorted. NULL/0 if the
     * font has none. */
    const bitmap_font_cp_map_t *cp_map;
    uint16_t cp_map_count;
} bitmap_font_t;

/* System fonts:
 *   font_5x7:  cell 5x7,  advance 6x8.
 *   font_8x8:  cell 8x8,  advance 8x8,  the IBM PC CGA font.
 *   font_6x12: cell 6x12, advance 6x12, Spleen (BSD-2-Clause), with
 *              descenders. */
extern const bitmap_font_t font_5x7;
extern const bitmap_font_t font_8x8;
extern const bitmap_font_t font_6x12;

/* Pixel test: returns 1 if bit (col,row) of the glyph is set, else 0.
 * (col,row) are in glyph-internal coordinates (0..cell_w-1, 0..cell_h-1). */
static inline int bitmap_font_pixel(const bitmap_font_t *f,
                                    const uint8_t *glyph_bytes,
                                    uint8_t col, uint8_t row)
{
    if (f->layout == FONT_LAYOUT_COL_MAJOR_LSB_TOP) {
        uint8_t bytes_per_col = (f->cell_h + 7u) / 8u;
        const uint8_t *colp = glyph_bytes + (uint32_t)col * bytes_per_col;
        return (colp[row >> 3] >> (row & 7u)) & 1u;
    } else if (f->layout == FONT_LAYOUT_ROW_MAJOR_LSB_LEFT) {
        uint8_t bytes_per_row = (f->cell_w + 7u) / 8u;
        const uint8_t *rowp = glyph_bytes + (uint32_t)row * bytes_per_row;
        return (rowp[col >> 3] >> (col & 7u)) & 1u;
    } else {
        /* ROW_MAJOR_MSB_LEFT */
        uint8_t bytes_per_row = (f->cell_w + 7u) / 8u;
        const uint8_t *rowp = glyph_bytes + (uint32_t)row * bytes_per_row;
        return (rowp[col >> 3] >> (7u - (col & 7u))) & 1u;
    }
}

/* Glyph by codepoint: ASCII directly, above 0x7E through cp_map. NULL if
 * the font has no glyph (the caller draws '?'). */
static inline const uint8_t *bitmap_font_glyph_cp(const bitmap_font_t *f, uint32_t cp)
{
    if (cp <= 0x7Eu && cp >= f->glyph_first && cp <= f->glyph_last) {
        return f->glyphs + (uint32_t)((uint8_t)cp - f->glyph_first) * f->glyph_stride;
    }
    if (f->cp_map == NULL || f->cp_map_count == 0u || f->accents == NULL) return NULL;
    int lo = 0;
    int hi = (int)f->cp_map_count - 1;
    while (lo <= hi) {
        int mid = (lo + hi) >> 1;
        uint32_t mcp = f->cp_map[mid].codepoint;
        if (mcp == cp) {
            return f->accents + (uint32_t)f->cp_map[mid].glyph_index * f->glyph_stride;
        }
        if (mcp < cp) lo = mid + 1; else hi = mid - 1;
    }
    return NULL;
}

/* Glyph bytes for byte `c`, or NULL. 0x80..0x87 is the keyboard's private
 * encoding (à è ì ò ù é £ €), mapped through the codepoint because each font
 * stores these glyphs at different indices. */
static inline const uint8_t *bitmap_font_glyph(const bitmap_font_t *f, uint8_t c)
{
    static const uint16_t privati[8] = {
        0x00E0u, 0x00E8u, 0x00ECu, 0x00F2u, 0x00F9u,   /* à è ì ò ù */
        0x00E9u,                                       /* é         */
        0x00A3u, 0x20ACu                               /* £ €       */
    };

    if (c >= f->glyph_first && c <= f->glyph_last)
        return f->glyphs + (uint32_t)(c - f->glyph_first) * f->glyph_stride;
    if (c >= 0x80u && c <= 0x87u)
        return bitmap_font_glyph_cp(f, privati[c - 0x80u]);
    return NULL;
}

/* One step of text: which character, and how many bytes it takes.
 *   0x00..0x7F  ASCII
 *   0x80..0x87  the keyboard's private encoding (these are UTF-8
 *               continuation bytes, so never the start of a sequence)
 *   0xC2..0xF4  start of a UTF-8 sequence, decoded
 * `*quanti` is the number of bytes to advance. */
static inline uint32_t bitmap_font_passo(const char *s, int *quanti)
{
    const uint8_t *p = (const uint8_t *)s;
    const uint8_t  c = p[0];

    *quanti = 1;
    if (c < 0x80u) return c;
    if (c <= 0x87u) return c;                     /* private encoding */

    if ((c >= 0xC2u) && (c <= 0xDFu) && ((p[1] & 0xC0u) == 0x80u))
    {
        *quanti = 2;
        return (uint32_t)(((c & 0x1Fu) << 6) | (p[1] & 0x3Fu));
    }
    if ((c >= 0xE0u) && (c <= 0xEFu) &&
        ((p[1] & 0xC0u) == 0x80u) && ((p[2] & 0xC0u) == 0x80u))
    {
        *quanti = 3;
        return (uint32_t)(((c & 0x0Fu) << 12) | ((p[1] & 0x3Fu) << 6) |
                          (p[2] & 0x3Fu));
    }
    return (uint32_t)'?';                          /* invalid byte */
}

/* Glyph of a codepoint: ASCII and the private range by number, the rest
   through the font's UTF-8 table. */
static inline const uint8_t *bitmap_font_glyph_passo(const bitmap_font_t *f,
                                                     uint32_t cp)
{
    if (cp < 0x88u) return bitmap_font_glyph(f, (uint8_t)cp);
    return bitmap_font_glyph_cp(f, cp);
}

#endif /* BITMAP_FONT_H */
