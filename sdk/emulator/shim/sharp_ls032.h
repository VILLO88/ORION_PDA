/**
 * The drawing functions the runtime expects from the platform. On the
 * device the panel driver implements them, here emu_lcd.c. Keep the
 * signatures in step with the firmware.
 */
#ifndef EMU_SHARP_H
#define EMU_SHARP_H
#include <stdint.h>
#include <stdbool.h>
#include "bitmap_font.h"

/* on the panel 1 is white; the app API hides this */
/* the firmware values: 0x00 and 0xFF */
#define SHARP_COLOR_BLACK  0x00u
#define SHARP_COLOR_WHITE  0xFFu

void     sharp_lcd_clear(uint8_t color);
void     sharp_lcd_draw_pixel(uint16_t x, uint16_t y, uint8_t color);
void     sharp_lcd_blit_pannello(int x, int y, const uint8_t *px, const uint8_t *mask,
                                 int passo, int h, int sx0, int sy0, int sx1, int sy1);
void     sharp_lcd_blit_1bpp(int x, int y, const uint8_t *px, const uint8_t *mask,
                             int passo, int sx0, int sy0, int sx1, int sy1);
void     sharp_lcd_fill_rect(uint16_t x, uint16_t y, uint16_t w, uint16_t h,
                             uint8_t color);
void     sharp_lcd_draw_string(uint16_t x, uint16_t y, const char *s,
                               uint8_t color, uint8_t scale);
void     sharp_lcd_draw_string_font(uint16_t x, uint16_t y, const char *s,
                                    uint8_t color, uint8_t scale,
                                    const bitmap_font_t *font);
void     sharp_lcd_fill_pattern(int x, int y, int w, int h, const uint8_t pat[8]);
void     sharp_lcd_draw_char_font(uint16_t x, uint16_t y, char c, uint8_t color,
                                  uint8_t scale, const bitmap_font_t *font);
uint16_t sharp_lcd_text_width(const char *s, uint8_t scale);
uint16_t sharp_lcd_text_width_font(const char *s, uint8_t scale,
                                   const bitmap_font_t *font);
void     sharp_lcd_set_font(const bitmap_font_t *f);
const bitmap_font_t *sharp_lcd_font(void);
bool     sharp_lcd_refresh_async(void);
bool     sharp_lcd_refresh_area(uint16_t x, uint16_t y, uint16_t w, uint16_t h);
uint16_t sharp_lcd_width(void);
uint16_t sharp_lcd_height(void);

#define sharp_lcd_refresh_multiline_dma()   sharp_lcd_refresh_async()

void ui_forza_ridisegno(void);
#endif
