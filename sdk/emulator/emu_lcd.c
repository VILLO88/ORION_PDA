/**
 * @file  emu_lcd.c
 * @brief The panel on the PC: a 536x336 framebuffer.
 *
 * No rotation: apps already see logical coordinates. Text drawing is a copy
 * of the device driver and uses the same font data, so text that fits here
 * fits there. If text ever wraps differently, compare the two.
 */
#include "emu_lcd.h"
#include "bitmap_font.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* explicit alignment, or clang aligns it to 32 KB and the linker warns */
uint8_t  emu_fb[EMU_H][EMU_W] __attribute__((aligned(16)));
bool     emu_da_ridisegnare = true;

static const bitmap_font_t *cur_font = NULL;

void sharp_lcd_set_font(const bitmap_font_t *f) { if (f != NULL) cur_font = f; }

const bitmap_font_t *sharp_lcd_font(void)
{
    if (cur_font == NULL) cur_font = &font_5x7;
    return cur_font;
}

void sharp_lcd_clear(uint8_t color)
{
    memset(emu_fb, (color != 0u) ? 0 : 1, sizeof emu_fb);
    emu_da_ridisegnare = true;
}

/* `color` follows the panel convention: 1 = white, 0 = black. */
void sharp_lcd_draw_pixel(uint16_t x, uint16_t y, uint8_t color)
{
    if ((x >= EMU_W) || (y >= EMU_H)) return;
    emu_fb[y][x] = (color != 0u) ? 0u : 1u;
}

void sharp_lcd_fill_rect(uint16_t x, uint16_t y, uint16_t w, uint16_t h,
                         uint8_t color)
{
    const uint8_t v = (color != 0u) ? 0u : 1u;
    uint16_t      i, j;

    for (j = y; (j < (uint16_t)(y + h)) && (j < EMU_H); j++)
        for (i = x; (i < (uint16_t)(x + w)) && (i < EMU_W); i++)
            emu_fb[j][i] = v;

    emu_da_ridisegnare = true;
}

static void glifo_disegna(uint16_t x, uint16_t y, const uint8_t *glyph,
                          uint8_t color, uint8_t scale,
                          const bitmap_font_t *font)
{
    if (glyph == NULL) return;
    for (uint8_t col = 0u; col < font->cell_w; col++) {
        for (uint8_t row = 0u; row < font->cell_h; row++) {
            if (bitmap_font_pixel(font, glyph, col, row) == 0) continue;
            for (uint8_t sy = 0u; sy < scale; sy++)
                for (uint8_t sx = 0u; sx < scale; sx++)
                    sharp_lcd_draw_pixel((uint16_t)(x + (col * scale) + sx),
                                         (uint16_t)(y + (row * scale) + sy),
                                         color);
        }
    }
}

void sharp_lcd_draw_char_font(uint16_t x, uint16_t y, char c, uint8_t color,
                              uint8_t scale, const bitmap_font_t *font)
{
    const uint8_t *glyph;

    if (font == NULL)  font = sharp_lcd_font();
    if (scale == 0u)   scale = 1u;

    glyph = bitmap_font_glyph(font, (uint8_t)c);
    if (glyph == NULL) glyph = bitmap_font_glyph(font, (uint8_t)'?');
    glifo_disegna(x, y, glyph, color, scale, font);
}

void sharp_lcd_draw_string_font(uint16_t x, uint16_t y, const char *s,
                                uint8_t color, uint8_t scale,
                                const bitmap_font_t *font)
{
    if (s == NULL) return;
    if (font == NULL) font = sharp_lcd_font();
    if (scale == 0u)  scale = 1u;

    /* decodes UTF-8 like the driver (bitmap_font_passo) */
    while (*s != '\0') {
        int            quanti;
        const uint32_t cp = bitmap_font_passo(s, &quanti);
        const uint8_t *glyph = bitmap_font_glyph_passo(font, cp);

        if (glyph == NULL) glyph = bitmap_font_glyph(font, (uint8_t)'?');
        glifo_disegna(x, y, glyph, color, scale, font);
        x = (uint16_t)(x + ((uint16_t)font->advance_w * scale));
        s += quanti;
    }
    emu_da_ridisegnare = true;
}


uint16_t sharp_lcd_text_width_font(const char *s, uint8_t scale,
                                   const bitmap_font_t *font)
{
    uint16_t n = 0u;

    if (s == NULL) return 0u;
    if (font == NULL) font = sharp_lcd_font();
    if (scale == 0u)  scale = 1u;

    while (*s != '\0') {          /* characters, not bytes */
        int quanti;

        (void)bitmap_font_passo(s, &quanti);
        s += quanti;
        n++;
    }
    return (uint16_t)(n * font->advance_w * scale);
}

void sharp_lcd_draw_string(uint16_t x, uint16_t y, const char *s,
                           uint8_t color, uint8_t scale)
{
    sharp_lcd_draw_string_font(x, y, s, color, scale, sharp_lcd_font());
}

uint16_t sharp_lcd_text_width(const char *s, uint8_t scale)
{
    return sharp_lcd_text_width_font(s, scale, sharp_lcd_font());
}

/* On the device a full frame takes ~75 ms; here nothing. The window title
   counts full frames so it is not forgotten. */
uint32_t emu_frame_interi = 0U;
uint32_t emu_frame_parziali = 0U;

/* With ORION_SNAPSHOTS=/path/prefix every present() writes a PGM,
   so frames can be compared with cmp. */
static void istantanea(void)
{
    static int      n = 0;
    const char     *dove = getenv("ORION_SNAPSHOTS");
    char            path[512];
    FILE           *f;

    if (dove == NULL) return;

    snprintf(path, sizeof path, "%s%03d.pgm", dove, n++);
    f = fopen(path, "wb");
    if (f == NULL) return;

    fprintf(f, "P5\n%d %d\n255\n", EMU_W, EMU_H);
    for (int y = 0; y < EMU_H; y++)
        for (int x = 0; x < EMU_W; x++)
        {
            /* in the buffer 1 = black, the opposite of the panel */
            const unsigned char v = emu_fb[y][x] ? 0u : 255u;
            fwrite(&v, 1, 1, f);
        }
    fclose(f);
}

bool sharp_lcd_refresh_async(void)
{
    emu_frame_interi++;
    emu_da_ridisegnare = true;
    istantanea();
    return true;
}

bool sharp_lcd_refresh_area(uint16_t x, uint16_t y, uint16_t w, uint16_t h)
{
    (void)x; (void)y; (void)w; (void)h;
    emu_frame_parziali++;
    emu_da_ridisegnare = true;
    istantanea();
    return true;
}

/* Same signature and meaning as the driver's blit, without rotation. */
/* Here only for parity: a wrong transposition would show up on the PC
   too. */
void sharp_lcd_blit_pannello(int x, int y, const uint8_t *px, const uint8_t *mask,
                             int passo, int h, int sx0, int sy0, int sx1, int sy1)
{
    if (px == NULL) return;

    for (int sy = sy0; sy < sy1; sy++)
    {
        const int ly  = y + sy;
        const int col = (h - 1) - sy;          /* bits are reversed in y */

        if ((ly < 0) || (ly >= EMU_H)) continue;

        for (int sx = sx0; sx < sx1; sx++)
        {
            const uint32_t i   = ((uint32_t)sx * (uint32_t)passo) + (uint32_t)(col >> 3);
            const uint8_t  bit = (uint8_t)(0x80u >> (col & 7));
            const int      lx  = x + sx;

            if ((lx < 0) || (lx >= EMU_W)) continue;
            if ((mask != NULL) && ((mask[i] & bit) == 0u)) continue;

            emu_fb[ly][lx] = ((px[i] & bit) != 0u) ? 0u : 1u;
        }
    }
    emu_da_ridisegnare = true;
}

void sharp_lcd_blit_1bpp(int x, int y, const uint8_t *px, const uint8_t *mask,
                         int passo, int sx0, int sy0, int sx1, int sy1)
{
    if (px == NULL) return;

    for (int sy = sy0; sy < sy1; sy++)
    {
        const uint32_t riga = (uint32_t)sy * (uint32_t)passo;
        const int      ly   = y + sy;

        if ((ly < 0) || (ly >= EMU_H)) continue;

        for (int sx = sx0; sx < sx1; sx++)
        {
            const uint8_t  bit = (uint8_t)(0x80u >> (sx & 7));
            const uint32_t i   = riga + (uint32_t)(sx >> 3);
            const int      lx  = x + sx;

            if ((lx < 0) || (lx >= EMU_W)) continue;
            if ((mask != NULL) && ((mask[i] & bit) == 0u)) continue;

            emu_fb[ly][lx] = ((px[i] & bit) != 0u) ? 0u : 1u;
        }
    }
    emu_da_ridisegnare = true;
}

/* the pattern is anchored to the screen, as in the driver */
void sharp_lcd_fill_pattern(int x, int y, int w, int h, const uint8_t pat[8])
{
    if ((pat == NULL) || (w <= 0) || (h <= 0)) return;

    for (int ly = y; ly < (y + h); ly++)
    {
        uint8_t riga;

        if ((ly < 0) || (ly >= EMU_H)) continue;
        riga = pat[(unsigned)ly & 7u];

        for (int lx = x; lx < (x + w); lx++)
        {
            if ((lx < 0) || (lx >= EMU_W)) continue;
            emu_fb[ly][lx] = ((riga & (uint8_t)(0x80u >> ((unsigned)lx & 7u))) != 0u)
                               ? 0u : 1u;
        }
    }
    emu_da_ridisegnare = true;
}

uint16_t sharp_lcd_width(void)  { return EMU_W; }
uint16_t sharp_lcd_height(void) { return EMU_H; }

/* the device redraws its UI here; the emulator has none */
void ui_forza_ridisegno(void) { }
