/**
 * @file    app_host.c
 * @brief   Starts, runs and closes apps. See app_host.h.
 */

#include "app_host.h"
#include "orion_ui.h"
#include "orion_mem.h"
#include "audio_sfx.h"
#include "app_power.h"
#include "orion_api.h"
#include "sistema.h"
#include "sharp_ls032.h"
#include "usb_cdc.h"
#include "ui.h"
#include <string.h>

#define APP_MAX        8U
#define CODA_EVENTI    8U

static const app_iface_t *elenco[APP_MAX];
static uint8_t            n_app = 0U;

static const app_iface_t *corrente   = NULL;
static uint32_t           avvio_ms   = 0U;
static bool               uscita_chiesta = false;

/* MENU held to quit: when it went down, and whether it is still held */
static uint32_t menu_giu_ms = 0U;
static bool     menu_giu    = false;

/* the app's event queue, after the MENU filter */
static key_event_t coda[CODA_EVENTI];
static uint8_t     coda_testa = 0U, coda_n = 0U;

/* Argument from the launching app. Copied: that app is closed before the
   new one reads it. */
static char arg_corrente[96] = {0};

/* ==========================================================================
 *  update() pace
 * ==========================================================================
 * A ceiling: if update() takes longer, frames are just longer. The time left
 * over goes to the main loop (audio, recorder, panel).
 */
static uint32_t fps_periodo = 0U;    /* 0 = as fast as possible */
static uint32_t fps_prossimo = 0U;
static uint32_t fps_conteggio = 0U, fps_finestra = 0U, fps_misurato = 0U;

void app_host_set_fps(int f)
{
  if (f <= 0)      { fps_periodo = 0U; return; }
  if (f > 60)      f = 60;
  fps_periodo  = 1000U / (uint32_t)f;
  fps_prossimo = HAL_GetTick();
}

int app_host_fps(void) { return (int)fps_misurato; }


/* ==========================================================================
 *  Registry
 * ========================================================================== */
bool app_host_registra(const app_iface_t *app)
{
  if ((app == NULL) || (app->id == NULL) || (n_app >= APP_MAX)) return false;
  elenco[n_app++] = app;
  return true;
}

uint8_t            app_host_quante(void)       { return n_app; }
const app_iface_t *app_host_n(uint8_t i)       { return (i < n_app) ? elenco[i] : NULL; }
bool               app_host_attiva(void)       { return (corrente != NULL); }
const app_iface_t *app_host_corrente(void)     { return corrente; }

const app_iface_t *app_host_per_id(const char *id)
{
  if (id == NULL) return NULL;
  for (uint8_t i = 0U; i < n_app; i++)
  {
    if (strcmp(elenco[i]->id, id) == 0) return elenco[i];
  }
  return NULL;
}

/* ==========================================================================
 *  Start and exit
 * ========================================================================== */
static void coda_svuota(void) { coda_testa = 0U; coda_n = 0U; }

const char *app_host_argomento(void)
{
  return (arg_corrente[0] != '\0') ? arg_corrente : NULL;
}

bool app_host_avvia(const char *id) { return app_host_avvia_arg(id, NULL); }

bool app_host_avvia_arg(const char *id, const char *arg)
{
  const app_iface_t *app = app_host_per_id(id);

  if (app == NULL) return false;

  /* one at a time: close the current one first */
  if (corrente != NULL) { if (corrente->close != NULL) corrente->close(); corrente = NULL; }

  /* Empty the queue before init(): the keys that launched the app are not
     meant for it. */
  coda_svuota();
  menu_giu = false;

  /* copy before closing the caller, `arg` usually points into it */
  if (arg != NULL) { (void)strncpy(arg_corrente, arg, sizeof arg_corrente - 1U);
                     arg_corrente[sizeof arg_corrente - 1U] = '\0'; }
  else             { arg_corrente[0] = '\0'; }

  if ((app->init != NULL) && !app->init(orion_api())) return false;

  corrente       = app;
  avvio_ms       = HAL_GetTick();
  uscita_chiesta = false;

  usb_cdc_printf("app: \"%s\" started\r\n", app->nome);
  return true;
}

void app_host_esci(void)
{
  /* Called from inside update(): just raise a flag and close on return. */
  uscita_chiesta = true;
}

static void chiudi(const char *perche)
{
  if (corrente == NULL) return;

  usb_cdc_printf("app: \"%s\" closed (%s)\r\n", corrente->nome, perche);
  /* Drop an open dialog first, its callback would resume a dead
     coroutine. */
  orion_ui_annulla();

  if (corrente->close != NULL) corrente->close();

  /* Stop short sounds before freeing memory: the DMA interrupt reads
     their samples from the app reserve. */
  audio_sfx_reset();

  /* Switch off J4 too, or a radio left on by the app drains the battery. */
  if (orion_api()->serial != NULL) orion_api()->serial->close();
  if (orion_api()->i2c    != NULL) orion_api()->i2c->close();
  if (orion_api()->gpio   != NULL) orion_api()->gpio->close();
  /* Give the Bluetooth data channel back to the Companion. */
  if (orion_api()->ble    != NULL) orion_api()->ble->close();

  /* Free the app's memory here, whatever the app did. */
  orion_mem_reset();

  /* the next app starts with the default pace */
  fps_periodo = 0U;
  corrente = NULL;
  coda_svuota();

  /* bring the home screen back */
  ui_forza_ridisegno();
}

/* ==========================================================================
 *  The turn
 * ========================================================================== */
static void accoda(const key_event_t *ev)
{
  if (coda_n >= CODA_EVENTI)
  {
    /* drop the oldest event */
    coda_testa = (uint8_t)((coda_testa + 1U) % CODA_EVENTI);
    coda_n--;
  }
  coda[(coda_testa + coda_n) % CODA_EVENTI] = *ev;
  coda_n++;
}

bool app_host_evento(key_event_t *ev)
{
  if ((ev == NULL) || (coda_n == 0U)) return false;
  *ev        = coda[coda_testa];
  coda_testa = (uint8_t)((coda_testa + 1U) % CODA_EVENTI);
  coda_n--;
  return true;
}

void app_host_update(void)
{
  key_event_t ev;

  if (corrente == NULL) return;

  /* --- keys: the MENU check sees them first --- */
  while (keyboard_poll(&ev))
  {
    /* A key counts as activity, so the panel does not switch off while an
       app runs. A key that only woke the panel stops here. */
    if (app_power_activity()) continue;

    if (ev.code == KEY_MENU)
    {
      if (ev.pressed)
      {
        /* Ignore the press that launched the app for the first APP_ARMA_MS,
           or an app opened with MENU would close at once. */
        if ((HAL_GetTick() - avvio_ms) >= APP_ARMA_MS)
        {
          menu_giu    = true;
          menu_giu_ms = HAL_GetTick();
        }
      }
      else
      {
        menu_giu = false;
      }
    }

    /* A short MENU still reaches the app; only a long press quits. */
    accoda(&ev);
  }

  if (menu_giu && ((HAL_GetTick() - menu_giu_ms) >= APP_FUGA_MS))
  {
    menu_giu = false;
    chiudi("MENU held");
    return;
  }

  /* --- a dialog is open: the app does not run --- */
  /* Keys were queued above, so MENU held still quits. */
  if (orion_ui_attivo())
  {
    orion_ui_passo();
    if (uscita_chiesta) chiudi("requested by the app");
    return;
  }

  /* --- pace --- */
  {
    const uint32_t ora = HAL_GetTick();

    /* the real rate, returned by orion.sys.fps() */
    if ((ora - fps_finestra) >= 1000U)
    {
      fps_misurato  = fps_conteggio;
      fps_conteggio = 0U;
      fps_finestra  = ora;
    }

    if (fps_periodo != 0U)
    {
      if ((int32_t)(ora - fps_prossimo) < 0) return;   /* not yet */

      /* Advance by one period so a late frame does not shift the rest; if
         more than a period behind, realign. */
      fps_prossimo += fps_periodo;
      if ((int32_t)(ora - fps_prossimo) > (int32_t)fps_periodo)
        fps_prossimo = ora + fps_periodo;
    }
    fps_conteggio++;
  }

  /* --- the app --- */
  if (corrente->update != NULL) corrente->update();

  if (uscita_chiesta) chiudi("requested by the app");
}
