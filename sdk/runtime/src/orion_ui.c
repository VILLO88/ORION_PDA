/**
 * @file    orion_ui.c
 * @brief   The system dialogs: confirm, text input, choice, notice.
 */
#include "orion_ui.h"
#include "app_host.h"
#include "keyboard.h"
#include "sharp_ls032.h"
#include "bitmap_font.h"
#include "stm32u5xx_hal.h"

#include <string.h>
#include <stdio.h>

/* Dialogs use their own font, so an app's settings cannot change them. */
#define FONT        (&font_6x12)
#define SCALA       2
#define CELLA_W     (6 * SCALA)
#define CELLA_H     (12 * SCALA)

#define PANNELLO_X  40
#define PANNELLO_W  (ORION_SCREEN_W - (2 * PANNELLO_X))
#define BORDO       3

#define TESTO_MAX   64
#define AVVISO_MS   2000U

typedef enum { NESSUNO = 0, CONFERMA, TESTO, SCELTA, AVVISO } tipo_t;

static tipo_t   tipo      = NESSUNO;
static bool     sporco    = false;   /* to be redrawn */
static uint32_t avviso_da = 0U;

static char titolo[48];
static char corpo[96];

/* confirm */
static bool               risposta_si = false;
static orion_yesno_cb_t   cb_si       = NULL;

/* text */
static char               buf[TESTO_MAX];
static int                len         = 0;
static orion_text_cb_t    cb_testo    = NULL;

/* choice */
static const char *const *voci        = NULL;
static int                n_voci      = 0;
static int                sel         = 0;
static int                primo       = 0;   /* scrolling */
static orion_choice_cb_t  cb_scelta   = NULL;

static void              *ctx         = NULL;

/* ==========================================================================
 *  Opening
 * ========================================================================== */

/* One dialog at a time: a new one replaces the old, whose callback is not
   called. From Lua this cannot happen, the coroutine waits for the answer. */
static void apri(tipo_t t, void *c)
{
    tipo   = t;
    ctx    = c;
    sporco = true;

    cb_si = NULL; cb_testo = NULL; cb_scelta = NULL;
}

static void ui_confirm(const char *domanda, orion_yesno_cb_t cb, void *c)
{
    apri(CONFERMA, c);
    snprintf(titolo, sizeof titolo, "%s", "CONFERMA");
    snprintf(corpo,  sizeof corpo,  "%s", (domanda != NULL) ? domanda : "?");
    risposta_si = false;    /* starts on NO */
    cb_si       = cb;
}

static void ui_ask_text(const char *tit, const char *iniziale,
                        orion_text_cb_t cb, void *c)
{
    apri(TESTO, c);
    snprintf(titolo, sizeof titolo, "%s", (tit != NULL) ? tit : "TESTO");
    snprintf(buf, sizeof buf, "%s", (iniziale != NULL) ? iniziale : "");
    len      = (int)strlen(buf);
    cb_testo = cb;
}

static void ui_choose(const char *tit, const char *const *items, int n,
                      orion_choice_cb_t cb, void *c)
{
    apri(SCELTA, c);
    snprintf(titolo, sizeof titolo, "%s", (tit != NULL) ? tit : "SCEGLI");
    voci      = items;
    n_voci    = (items != NULL) ? n : 0;
    sel       = 0;
    primo     = 0;
    cb_scelta = cb;
}

static void ui_notice(const char *t)
{
    apri(AVVISO, NULL);
    snprintf(corpo, sizeof corpo, "%s", (t != NULL) ? t : "");
    avviso_da = HAL_GetTick();
}

const orion_ui_t ORION_UI = {
    .confirm  = ui_confirm,
    .ask_text = ui_ask_text,
    .choose   = ui_choose,
    .notice   = ui_notice,
};

bool orion_ui_attivo(void) { return (tipo != NESSUNO); }

void orion_ui_annulla(void)
{
    tipo   = NESSUNO;
    cb_si  = NULL; cb_testo = NULL; cb_scelta = NULL;
    voci   = NULL; n_voci = 0;
}

/* ==========================================================================
 *  Closing
 * ==========================================================================
 * Close first, then call the callback: a Lua callback may open the next
 * dialog straight away. */
static void chiudi_e_rispondi_si(bool valore)
{
    const orion_yesno_cb_t cb = cb_si;
    void *const            c  = ctx;

    orion_ui_annulla();
    if (cb != NULL) cb(valore, c);
}

static void chiudi_e_rispondi_testo(const char *s)
{
    const orion_text_cb_t cb = cb_testo;
    void *const           c  = ctx;

    orion_ui_annulla();
    if (cb != NULL) cb(s, c);
}

static void chiudi_e_rispondi_scelta(int i)
{
    const orion_choice_cb_t cb = cb_scelta;
    void *const             c  = ctx;

    orion_ui_annulla();
    if (cb != NULL) cb(i, c);
}

/* ==========================================================================
 *  Drawing
 * ========================================================================== */

static void riga(int x, int y, const char *s)
{
    sharp_lcd_draw_string_font((uint16_t)x, (uint16_t)y, s, 0, SCALA, FONT);
}

/* white panel with a black border, h = panel height */
static void cornice(int y, int h)
{
    sharp_lcd_fill_rect((uint16_t)PANNELLO_X, (uint16_t)y,
                        (uint16_t)PANNELLO_W, (uint16_t)h, 0);
    sharp_lcd_fill_rect((uint16_t)(PANNELLO_X + BORDO), (uint16_t)(y + BORDO),
                        (uint16_t)(PANNELLO_W - (2 * BORDO)),
                        (uint16_t)(h - (2 * BORDO)), 1);

    if (titolo[0] != '\0')
    {
        sharp_lcd_fill_rect((uint16_t)(PANNELLO_X + BORDO),
                            (uint16_t)(y + BORDO),
                            (uint16_t)(PANNELLO_W - (2 * BORDO)),
                            (uint16_t)(CELLA_H + 8), 0);
        sharp_lcd_draw_string_font((uint16_t)(PANNELLO_X + BORDO + 8),
                                   (uint16_t)(y + BORDO + 4), titolo, 1,
                                   SCALA, FONT);
    }
}

/* selected item, inverted */
static void voce(int x, int y, int w, const char *s, bool attiva)
{
    if (attiva)
    {
        sharp_lcd_fill_rect((uint16_t)x, (uint16_t)(y - 3),
                            (uint16_t)w, (uint16_t)(CELLA_H + 6), 0);
        sharp_lcd_draw_string_font((uint16_t)(x + 6), (uint16_t)y, s, 1,
                                   SCALA, FONT);
    }
    else
    {
        riga(x + 6, y, s);
    }
}

#define VISIBILI  6

/* Returns false if the panel refused the frame; the caller keeps
   `sporco` and tries again. */
static bool disegna(void)
{
    const int cx = ORION_SCREEN_W / 2;

    switch (tipo)
    {
        case CONFERMA:
        {
            const int h = (CELLA_H * 4) + 40;
            const int y = (ORION_SCREEN_H - h) / 2;
            const int yb = y + h - CELLA_H - 22;

            cornice(y, h);
            riga(PANNELLO_X + 16, y + CELLA_H + 24, corpo);

            voce(cx - 150, yb, 120, "YES", risposta_si);
            voce(cx + 30,  yb, 120, "NO", !risposta_si);
            break;
        }

        case TESTO:
        {
            const int h = (CELLA_H * 4) + 40;
            const int y = (ORION_SCREEN_H - h) / 2;
            const int yc = y + CELLA_H + 26;
            char      vista[40];

            cornice(y, h);

            /* Show the end of the text, where the cursor is. */
            {
                const int max = (int)(sizeof vista) - 1;
                const int da  = (len > max) ? (len - max) : 0;
                const int n   = len - da;

                memcpy(vista, &buf[da], (size_t)n);
                vista[n] = '\0';
            }

            sharp_lcd_fill_rect((uint16_t)(PANNELLO_X + 14),
                                (uint16_t)(yc - 4),
                                (uint16_t)(PANNELLO_W - 28),
                                (uint16_t)(CELLA_H + 8), 0);
            sharp_lcd_fill_rect((uint16_t)(PANNELLO_X + 16),
                                (uint16_t)(yc - 2),
                                (uint16_t)(PANNELLO_W - 32),
                                (uint16_t)(CELLA_H + 4), 1);
            riga(PANNELLO_X + 20, yc, vista);
            sharp_lcd_fill_rect(
                (uint16_t)(PANNELLO_X + 20 +
                           (int)sharp_lcd_text_width_font(vista, SCALA, FONT)),
                (uint16_t)yc, 2, (uint16_t)CELLA_H, 0);

            riga(PANNELLO_X + 16, y + h - CELLA_H - 10, "ENTER ok   ESC cancel");
            break;
        }

        case SCELTA:
        {
            const int quante = (n_voci < VISIBILI) ? n_voci : VISIBILI;
            const int h = (CELLA_H * (quante + 2)) + 40;
            const int y = (ORION_SCREEN_H - h) / 2;
            int       i;

            cornice(y, h);
            for (i = 0; i < quante; i++)
            {
                const int idx = primo + i;

                if (idx >= n_voci) break;
                voce(PANNELLO_X + 12,
                     y + CELLA_H + 26 + (i * (CELLA_H + 6)),
                     PANNELLO_W - 24, voci[idx], (idx == sel));
            }
            break;
        }

        case AVVISO:
        {
            const int h = (CELLA_H * 2) + 30;
            const int y = (ORION_SCREEN_H - h) / 2;

            titolo[0] = '\0';
            cornice(y, h);
            riga(PANNELLO_X + 16, y + 18, corpo);
            break;
        }

        default: return true;
    }

    return sharp_lcd_refresh_async();
}

/* ==========================================================================
 *  One step
 * ========================================================================== */
void orion_ui_passo(void)
{
    key_event_t ev;

    if (tipo == NESSUNO) return;

    while (app_host_evento(&ev))
    {
        if (!ev.pressed) continue;

        switch (tipo)
        {
            case CONFERMA:
                if ((ev.code == KEY_LEFT) || (ev.code == KEY_RIGHT) ||
                    (ev.code == KEY_UP)   || (ev.code == KEY_DOWN))
                {
                    risposta_si = !risposta_si;
                    sporco      = true;
                }
                else if (ev.code == KEY_ENTER) { chiudi_e_rispondi_si(risposta_si); return; }
                else if (ev.code == KEY_ESC)   { chiudi_e_rispondi_si(false);       return; }
                break;

            case TESTO:
                if (ev.code == KEY_ENTER)      { chiudi_e_rispondi_testo(buf);  return; }
                else if (ev.code == KEY_ESC)   { chiudi_e_rispondi_testo(NULL); return; }
                else if (ev.code == KEY_BACK)
                {
                    if (len > 0) { buf[--len] = '\0'; sporco = true; }
                }
                /* Printable ASCII only: arrow keys and the like are 0xA0 and up. */
                else if ((ev.code >= 0x20) && (ev.code < 0x7F))
                {
                    if (len < (int)(sizeof buf) - 1)
                    {
                        buf[len++] = (char)ev.code;
                        buf[len]   = '\0';
                        sporco     = true;
                    }
                }
                break;

            case SCELTA:
                if (ev.code == KEY_UP)
                {
                    if (sel > 0) sel--;
                    if (sel < primo) primo = sel;
                    sporco = true;
                }
                else if (ev.code == KEY_DOWN)
                {
                    if (sel < (n_voci - 1)) sel++;
                    if (sel >= (primo + VISIBILI)) primo = sel - VISIBILI + 1;
                    sporco = true;
                }
                else if (ev.code == KEY_ENTER) { chiudi_e_rispondi_scelta(sel); return; }
                else if (ev.code == KEY_ESC)   { chiudi_e_rispondi_scelta(-1);  return; }
                break;

            case AVVISO:
                tipo = NESSUNO;    /* a key closes it early */
                return;

            default: break;
        }
    }

    if ((tipo == AVVISO) && ((HAL_GetTick() - avviso_da) >= AVVISO_MS))
    {
        tipo = NESSUNO;
        return;
    }

    /* Redraw only when something changed, and clear `sporco` only if the
       panel took the frame. An app that presents every frame leaves a
       transfer running when it opens a dialog; ignoring the refusal left the
       dialog open but invisible. */
    if (sporco) sporco = !disegna();
}
