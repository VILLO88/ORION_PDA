/**
 * @file    orion_api.c
 * @brief   The app API on top of the firmware drivers. Mostly translation
 *          of names and units; line drawing and clipping live here because
 *          the display driver has neither.
 */

#include "orion_api.h"
#include "orion_ui.h"
#include "app_power.h"
#include "orion_mem.h"
#include "orion_fs.h"
#include "app_host.h"
#include "sharp_ls032.h"
#include "bitmap_font.h"
#include "keyboard.h"
#include "batteria.h"
#include "rk817_rtc.h"
#include "usb_cdc.h"
#include "version.h"
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

/* ==========================================================================
 *  Colours
 * ==========================================================================
 * The driver and the API use opposite values for white; translated here
 * only.
 */
static uint8_t col(uint8_t c)
{
  return (c == ORION_WHITE) ? SHARP_COLOR_WHITE : SHARP_COLOR_BLACK;
}

/* ==========================================================================
 *  Clipping
 * ==========================================================================
 * Rectangles are clipped to the pixel, text to the character: a glyph that
 * crosses the edge is drawn whole.
 */
static int clip_x = 0, clip_y = 0, clip_w = ORION_SCREEN_W, clip_h = ORION_SCREEN_H;

static void gfx_set_clip(int x, int y, int w, int h)
{
  clip_x = x; clip_y = y; clip_w = w; clip_h = h;
}

static void gfx_clear_clip(void)
{
  clip_x = 0; clip_y = 0; clip_w = ORION_SCREEN_W; clip_h = ORION_SCREEN_H;
}

static bool dentro(int x, int y)
{
  return (x >= clip_x) && (y >= clip_y) &&
         (x < (clip_x + clip_w)) && (y < (clip_y + clip_h));
}

/* ==========================================================================
 *  Graphics
 * ========================================================================== */
static void gfx_clear(uint8_t c)              { sharp_lcd_clear(col(c)); }

static void gfx_pixel(int x, int y, uint8_t c)
{
  if (dentro(x, y)) sharp_lcd_draw_pixel((uint16_t)x, (uint16_t)y, col(c));
}

/* The current pattern, or NULL. A copy: the Lua table may be collected. */
static uint8_t retino[8];
static bool    retino_attivo = false;

static void gfx_set_pattern(const uint8_t *pat)
{
  if (pat == NULL) { retino_attivo = false; return; }
  for (int i = 0; i < 8; i++) retino[i] = pat[i];
  retino_attivo = true;
}

static void gfx_fill_rect(int x, int y, int w, int h, uint8_t c)
{
  /* Intersect with the clip; this also drops negative coordinates, which
     the uint16_t driver would turn into 65535. */
  int x1 = x + w, y1 = y + h;

  if (x  < clip_x)            x  = clip_x;
  if (y  < clip_y)            y  = clip_y;
  if (x1 > (clip_x + clip_w)) x1 = clip_x + clip_w;
  if (y1 > (clip_y + clip_h)) y1 = clip_y + clip_h;
  if ((x1 <= x) || (y1 <= y)) return;

  if (retino_attivo)
  {
    sharp_lcd_fill_pattern(x, y, x1 - x, y1 - y, retino);
    return;
  }
  sharp_lcd_fill_rect((uint16_t)x, (uint16_t)y,
                      (uint16_t)(x1 - x), (uint16_t)(y1 - y), col(c));
}

static void gfx_rect(int x, int y, int w, int h, uint8_t c)
{
  if ((w <= 0) || (h <= 0)) return;
  gfx_fill_rect(x,         y,         w, 1, c);
  gfx_fill_rect(x,         y + h - 1, w, 1, c);
  gfx_fill_rect(x,         y,         1, h, c);
  gfx_fill_rect(x + w - 1, y,         1, h, c);
}

/* Bresenham: the driver has no diagonal lines. */
static void gfx_line(int x0, int y0, int x1, int y1, uint8_t c)
{
  int dx = (x1 > x0) ? (x1 - x0) : (x0 - x1);
  int dy = (y1 > y0) ? (y1 - y0) : (y0 - y1);
  int sx = (x0 < x1) ? 1 : -1;
  int sy = (y0 < y1) ? 1 : -1;
  int err = dx - dy;

  for (;;)
  {
    gfx_pixel(x0, y0, c);
    if ((x0 == x1) && (y0 == y1)) break;
    {
      const int e2 = err * 2;

      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 <  dx) { err += dx; y0 += sy; }
    }
  }
}

static const orion_font_t *gfx_system_font(int n)
{
  switch (n)
  {
    case 1:  return (const orion_font_t *)&font_8x8;
    case 2:  return (const orion_font_t *)&font_6x12;
    default: return (const orion_font_t *)&font_5x7;
  }
}

static void gfx_set_font(const orion_font_t *f)
{
  sharp_lcd_set_font((const bitmap_font_t *)f);
}

static void gfx_font_metrics(const orion_font_t *f, orion_font_metrics_t *out)
{
  /* No font given: use the current one (and always fill `out`). */
  const bitmap_font_t *bf = (const bitmap_font_t *)f;

  if (out == NULL) return;
  if (bf == NULL)  bf = sharp_lcd_font();
  if (bf == NULL)  return;
  out->cell_w    = bf->cell_w;
  out->cell_h    = bf->cell_h;
  out->advance_w = bf->advance_w;
  out->advance_h = bf->advance_h;
}

static void gfx_text(int x, int y, const char *s, uint8_t c, int scale)
{
  const bitmap_font_t *f = sharp_lcd_font();
  const int h = (int)f->cell_h * scale;

  /* clip by whole lines only, see above */
  if (((y + h) <= clip_y) || (y >= (clip_y + clip_h))) return;

  sharp_lcd_draw_string((uint16_t)x, (uint16_t)y, s, col(c), (uint8_t)scale);
}

static int  gfx_text_width(const char *s, int scale)
{
  return (int)sharp_lcd_text_width(s, (uint8_t)scale);
}


/* ==========================================================================
 *  .obm images
 * ==========================================================================
 * Format in the guide (orionpda.org/sdk, image format): a 12-byte header, 1-bit pixels, an
 * optional mask. MSB first and 1 = white, like the framebuffer.
 */
struct orion_bitmap {
  uint16_t w, h;
  uint16_t passo;          /* bytes per row, or per column if `pannello` */
  bool     pannello;       /* data already laid out as in the framebuffer */
  const uint8_t *px;
  const uint8_t *mask;     /* NULL if the image is opaque */
  void    *blocco;         /* what must be returned to `mem` */
};

/* Kept outside the pixel block, which may live in PSRAM where scattered
   reads are slow. */
#define BITMAP_MAX  16
static struct orion_bitmap bm_pool[BITMAP_MAX];

static orion_bitmap_t *gfx_bitmap_load(const char *path)
{
  uint8_t          hdr[12];
  orion_file_t    *f;
  struct orion_bitmap *b = NULL;
  uint16_t         w, h, passo;
  uint32_t         byte_px;
  uint8_t          flag;
  int              i;

  if ((path == NULL) || (ORION_FS.open == NULL)) return NULL;

  f = ORION_FS.open(path, ORION_READ);
  if (f == NULL) return NULL;

  if (ORION_FS.read(f, hdr, 12) != 12) { (void)ORION_FS.close(f); return NULL; }
  if ((hdr[0] != 'O') || (hdr[1] != 'B') || (hdr[2] != 'M') || (hdr[3] != '1'))
  {
    /* no magic number: refuse, rather than read garbage as a size */
    (void)ORION_FS.close(f);
    return NULL;
  }

  w    = (uint16_t)(hdr[4] | ((uint16_t)hdr[5] << 8));
  h    = (uint16_t)(hdr[6] | ((uint16_t)hdr[7] << 8));
  flag = hdr[8];

  if ((w == 0U) || (h == 0U) || (w > 4096U) || (h > 4096U))
  {
    (void)ORION_FS.close(f);
    return NULL;
  }

  /* In panel format the stride is per column and the size is passo * w. */
  if ((flag & 2U) != 0U)
  {
    passo   = (uint16_t)((h + 7U) / 8U);
    byte_px = (uint32_t)passo * w;
  }
  else
  {
    passo   = (uint16_t)((w + 7U) / 8U);
    byte_px = (uint32_t)passo * h;
  }
  if ((flag & 1U) != 0U) byte_px *= 2U;

  for (i = 0; i < BITMAP_MAX; i++) if (bm_pool[i].blocco == NULL) break;
  if (i == BITMAP_MAX) { (void)ORION_FS.close(f); return NULL; }
  b = &bm_pool[i];

  b->blocco = ORION_MEM.alloc((int)byte_px, ORION_MEM_ANY);
  if (b->blocco == NULL) { (void)ORION_FS.close(f); return NULL; }

  /* Read in 4 KB pieces, so the microSD DMA never writes straight into
     PSRAM. */
  {
    uint8_t *dst = (uint8_t *)b->blocco;
    uint32_t tot = 0U;

    while (tot < byte_px)
    {
      const uint32_t q = ((byte_px - tot) < 4096U) ? (byte_px - tot) : 4096U;
      const int      n = ORION_FS.read(f, &dst[tot], (int)q);

      if (n <= 0) break;
      tot += (uint32_t)n;
    }
    (void)ORION_FS.close(f);

    if (tot != byte_px)
    {
      ORION_MEM.free(b->blocco);
      b->blocco = NULL;
      return NULL;
    }
  }

  b->w        = w;
  b->h        = h;
  b->passo    = passo;
  b->pannello = ((flag & 2U) != 0U);
  b->px       = (const uint8_t *)b->blocco;
  b->mask     = ((flag & 1U) != 0U)
                  ? (b->px + ((uint32_t)passo * (b->pannello ? w : h))) : NULL;
  return (orion_bitmap_t *)b;
}

static void gfx_bitmap_free(orion_bitmap_t *bb)
{
  struct orion_bitmap *b = (struct orion_bitmap *)bb;

  if ((b == NULL) || (b->blocco == NULL)) return;
  ORION_MEM.free(b->blocco);
  b->blocco = NULL;
  b->px = NULL; b->mask = NULL; b->w = 0U; b->h = 0U; b->pannello = false;
}

static void gfx_bitmap_size(const orion_bitmap_t *bb, int *w, int *h)
{
  const struct orion_bitmap *b = (const struct orion_bitmap *)bb;

  if (w != NULL) *w = (b != NULL) ? (int)b->w : 0;
  if (h != NULL) *h = (b != NULL) ? (int)b->h : 0;
}

static void gfx_bitmap_draw(int x, int y, const orion_bitmap_t *bb)
{
  const struct orion_bitmap *b = (const struct orion_bitmap *)bb;
  int sx0, sy0, sx1, sy1;

  if ((b == NULL) || (b->px == NULL)) return;

  /* clip once here, not per pixel */
  sx0 = (x < clip_x) ? (clip_x - x) : 0;
  sy0 = (y < clip_y) ? (clip_y - y) : 0;
  sx1 = ((x + (int)b->w) > (clip_x + clip_w)) ? (clip_x + clip_w - x) : (int)b->w;
  sy1 = ((y + (int)b->h) > (clip_y + clip_h)) ? (clip_y + clip_h - y) : (int)b->h;
  if ((sx0 >= sx1) || (sy0 >= sy1)) return;

  /* The loop is in the driver (sharp_lcd_blit_1bpp), which knows the
     rotation and can work a byte at a time. */
  if (b->pannello)
  {
    sharp_lcd_blit_pannello(x, y, b->px, b->mask, (int)b->passo, (int)b->h,
                            sx0, sy0, sx1, sy1);
    return;
  }

  sharp_lcd_blit_1bpp(x, y, b->px, b->mask, (int)b->passo, sx0, sy0, sx1, sy1);
}

/* Drawing counts as activity for the screen timeout (not for power-off
   by keys). Done here and not in the driver, which the status bar clock
   also calls every second. */
static bool gfx_present(void)
{
  app_power_attivita_muta();
  return sharp_lcd_refresh_async();
}

static bool gfx_present_area(int x, int y, int w, int h)
{
  /* Return the result: false means the previous transfer is still
     running and nothing was sent. */
  app_power_attivita_muta();
  return sharp_lcd_refresh_area((uint16_t)x, (uint16_t)y,
                                (uint16_t)w, (uint16_t)h);
}

static const orion_gfx_t GFX = {
  .clear        = gfx_clear,
  .pixel        = gfx_pixel,
  .line         = gfx_line,
  .rect         = gfx_rect,
  .fill_rect    = gfx_fill_rect,
  .set_pattern  = gfx_set_pattern,
  .system_font  = gfx_system_font,
  .set_font     = gfx_set_font,
  .font_metrics = gfx_font_metrics,
  .text         = gfx_text,
  .text_width   = gfx_text_width,
  .bitmap_load  = gfx_bitmap_load,
  .bitmap_free  = gfx_bitmap_free,
  .bitmap_draw  = gfx_bitmap_draw,
  .bitmap_size  = gfx_bitmap_size,
  .present      = gfx_present,
  .present_area = gfx_present_area,
  .set_clip     = gfx_set_clip,
  .clear_clip   = gfx_clear_clip,
};

/* ==========================================================================
 *  Input
 * ==========================================================================
 * Firmware key codes (KEY_*) and API codes (ORION_K_*) differ; the table is
 * here.
 */
static uint8_t traduci_tasto(uint8_t k)
{
  switch (k)
  {
    case KEY_ESC:    return ORION_K_ESC;
    case KEY_ENTER:  return ORION_K_ENTER;
    case KEY_DEL:    return ORION_K_DEL;
    case KEY_BACK:   return ORION_K_BACK;
    case KEY_UP:     return ORION_K_UP;
    case KEY_DOWN:   return ORION_K_DOWN;
    case KEY_LEFT:   return ORION_K_LEFT;
    case KEY_RIGHT:  return ORION_K_RIGHT;
    case KEY_MENU:   return ORION_K_MENU;
    case KEY_SAVE:   return ORION_K_SAVE;
    case KEY_SEARCH: return ORION_K_SEARCH;
    case KEY_PLAY:   return ORION_K_PLAY;
    case KEY_FW:     return ORION_K_NEXT;
    case KEY_RW:     return ORION_K_PREV;
    case KEY_VOLUP:  return ORION_K_VOL_UP;
    case KEY_VOLDN:  return ORION_K_VOL_DOWN;
    case KEY_MUTE:   return ORION_K_MUTE;
    case KEY_SHIFT:  return ORION_K_SHIFT;
    case KEY_FN:     return ORION_K_FN;
    default:         return ORION_K_NONE;
  }
}

static bool input_read(orion_event_t *out)
{
  key_event_t ev;

  if ((out == NULL) || !app_host_evento(&ev)) return false;

  out->kind  = ev.pressed ? ORION_KEY_DOWN : ORION_KEY_UP;
  out->ch    = ((ev.code >= 0x20U) && (ev.code < 0x7FU)) ? ev.code
             : (((ev.code >= 0x80U) && (ev.code <= 0x87U)) ? ev.code : 0U);
  out->key   = (out->ch != 0U) ? ORION_K_NONE : traduci_tasto(ev.code);
  out->shift = keyboard_shift();
  out->fn    = keyboard_fn();
  out->ms    = HAL_GetTick();
  return true;
}

/* the reverse of traduci_tasto() */
static uint8_t detraduci_tasto(uint8_t k)
{
  switch (k)
  {
    case ORION_K_ESC:     return KEY_ESC;
    case ORION_K_ENTER:   return KEY_ENTER;
    case ORION_K_DEL:     return KEY_DEL;
    case ORION_K_BACK:    return KEY_BACK;
    case ORION_K_UP:      return KEY_UP;
    case ORION_K_DOWN:    return KEY_DOWN;
    case ORION_K_LEFT:    return KEY_LEFT;
    case ORION_K_RIGHT:   return KEY_RIGHT;
    case ORION_K_MENU:    return KEY_MENU;
    case ORION_K_SAVE:    return KEY_SAVE;
    case ORION_K_SEARCH:  return KEY_SEARCH;
    case ORION_K_PLAY:    return KEY_PLAY;
    case ORION_K_NEXT:    return KEY_FW;
    case ORION_K_PREV:    return KEY_RW;
    case ORION_K_VOL_UP:  return KEY_VOLUP;
    case ORION_K_VOL_DOWN:return KEY_VOLDN;
    case ORION_K_MUTE:    return KEY_MUTE;
    default: break;
  }
  /* an ASCII character passes as is: is_down(string.byte("a")) */
  return k;
}

static bool input_is_down(uint8_t tasto)
{
  if (tasto == ORION_K_SHIFT) return keyboard_shift();
  if (tasto == ORION_K_FN)    return keyboard_fn();
  return keyboard_is_down(detraduci_tasto(tasto));
}

static const orion_input_t INPUT = {
  .read    = input_read,
  .is_down = input_is_down,
};

/* ==========================================================================
 *  System
 * ========================================================================== */
static uint32_t sys_ms(void) { return HAL_GetTick(); }

static void sys_date_time(int *anno, int *mese, int *giorno,
                          int *ora, int *min, int *sec)
{
  rk817_time_t t;

  /* The RAM copy refreshed once a second by rk817_rtc_service(), not an
     I2C read on every call. */
  if (!rk817_rtc_cached(&t)) return;

  if (anno)   *anno   = (int)t.anno;   /* already 2000..2099 */
  if (mese)   *mese   = (int)t.mese;
  if (giorno) *giorno = (int)t.giorno;
  if (ora)    *ora    = (int)t.ora;
  if (min)    *min    = (int)t.minuto;
  if (sec)    *sec    = (int)t.secondo;
}

static int  sys_battery(void)
{
  const batteria_t *b = batteria_ultima();

  return (b->valido) ? (int)batteria_soc() : -1;
}

static bool sys_is_charging(void)
{
  const batteria_t *b = batteria_ultima();

  return b->valido && (b->ma > 5);
}

static const char *sys_version(void) { return FW_VERSION_STRING; }

static void sys_exit(void) { app_host_esci(); }

static void sys_launch(const char *app_id, const char *arg)
{
  (void)app_host_avvia_arg(app_id, arg);
}

static const char *sys_argument(void) { return app_host_argomento(); }

static void sys_set_fps(int f) { app_host_set_fps(f); }
static int  sys_fps(void)      { return app_host_fps(); }

static void sys_status_bar(bool show)
{
  /* Does nothing yet; content_area() already tells apps where they may
     draw. */
  (void)show;
}

static void sys_content_area(int *x, int *y, int *w, int *h)
{
  if (x) *x = 0;
  if (y) *y = 0;
  if (w) *w = ORION_SCREEN_W;
  if (h) *h = ORION_SCREEN_H;
}

static void sys_log(const char *fmt, ...)
{
  char    buf[128];
  va_list ap;

  va_start(ap, fmt);
  (void)vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  usb_cdc_printf("[app] %s\r\n", buf);

  /* Flush at once: what is left in the USB FIFO is lost if the board
     hangs, and those are the lines that matter. */
  for (uint8_t i = 0U; i < 8U; i++) usb_cdc_task();
}

static const orion_sys_t SYS = {
  .ms           = sys_ms,
  .date_time    = sys_date_time,
  .battery      = sys_battery,
  .is_charging  = sys_is_charging,
  .version      = sys_version,
  .exit         = sys_exit,
  .launch       = sys_launch,
  .argument     = sys_argument,
  .status_bar   = sys_status_bar,
  .content_area = sys_content_area,
  .log          = sys_log,
  .set_fps      = sys_set_fps,
  .fps          = sys_fps,
};

/* ==========================================================================
 *  The vtable
 * ==========================================================================
 * Missing modules are NULL, so a call fails at once instead of a stub
 * quietly doing nothing.
 */
extern const orion_audio_t ORION_AUDIO; /* orion_audio.c */
extern const orion_mic_t   ORION_MIC;   /* orion_audio.c */
extern const orion_fs_t   ORION_FS;    /* orion_fs.c   */
extern const orion_pref_t ORION_PREF;  /* orion_pref.c */
extern const orion_math_t ORION_MATH;  /* orion_math.c / emu_math.c */
extern const orion_serial_t ORION_SERIAL; /* orion_serial.c / emu_serial.c */
extern const orion_gpio_t   ORION_GPIO;   /* orion_j4.c / emu_j4.c */
extern const orion_i2c_t    ORION_I2C;    /* orion_j4.c / emu_j4.c */
extern const orion_ble_t    ORION_BLE;    /* orion_ble.c / emu_ble.c */

static const orion_api_t API = {
  .version = ORION_API_VERSION,
  .gfx     = &GFX,
  .input   = &INPUT,
  .fs      = &ORION_FS,
  .pref    = &ORION_PREF,
  .audio   = &ORION_AUDIO,
  .mic     = &ORION_MIC,
  .mem     = &ORION_MEM,
  .sys     = &SYS,
  .ui      = &ORION_UI,
  .math    = &ORION_MATH,
  .serial  = &ORION_SERIAL,
  .gpio    = &ORION_GPIO,
  .i2c     = &ORION_I2C,
  .ble     = &ORION_BLE,
};

const orion_api_t *orion_api(void) { return &API; }
