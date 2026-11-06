/**
 * @file  emu_hw.c
 * @brief The hardware calls the shared runtime files expect: PMIC, panel,
 *        keyboard, PSRAM, answered on the PC.
 */
#include <stdio.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <SDL.h>

#include "stm32u5xx_hal.h"
#include "emu_lcd.h"
#include "keyboard.h"
#include "batteria.h"
#include "rk817_rtc.h"
#include "psram.h"

/* --- time --- */
uint32_t HAL_GetTick(void) { return (uint32_t)SDL_GetTicks(); }
void     HAL_Delay(uint32_t ms) { SDL_Delay(ms); }

/* --- console --- */
void usb_cdc_printf(const char *fmt, ...)
{
    va_list ap;

    va_start(ap, fmt);
    vprintf(fmt, ap);
    va_end(ap);
    fflush(stdout);
}
void usb_cdc_task(void) { }

/* --- services --- */
/* On the device these keep audio, recorder, keyboard and panel running
   while Lua works. Nothing has deadlines on the PC. */
void sistema_servizi(void) { }
void sistema_respira(void) { }

/* --- battery --- */
static batteria_t finta = { 0 };

const batteria_t *batteria_ultima(void) { return &finta; }
uint8_t batteria_soc(void) { return 72u; }   /* a fixed value */

/* --- RTC --- */
bool rk817_rtc_cached(rk817_time_t *t)
{
    const time_t    ora = time(NULL);
    const struct tm *tm = localtime(&ora);

    if ((t == NULL) || (tm == NULL)) return false;
    t->anno    = (uint16_t)(tm->tm_year + 1900);
    t->mese    = (uint8_t)(tm->tm_mon + 1);
    t->giorno  = (uint8_t)tm->tm_mday;
    t->ora       = (uint8_t)tm->tm_hour;
    t->minuto    = (uint8_t)tm->tm_min;
    t->secondo   = (uint8_t)tm->tm_sec;
    t->settimana = (uint8_t)tm->tm_wday;
    return true;
}
void rk817_rtc_service(void) { }

/* --- PSRAM --- */
uint8_t  *emu_psram = NULL;
DWT_Type  emu_dwt    = { 0, 0 };

bool psram_ready(void)
{
    if (emu_psram == NULL) emu_psram = (uint8_t *)calloc(8u * 1024u * 1024u, 1u);
    return (emu_psram != NULL);
}
bool psram_mmap(void) { return psram_ready(); }
bool psram_set_mmap(bool acceso) { (void)acceso; return psram_ready(); }
const char *psram_status(void) { return "emulata (RAM del PC)"; }

/* --- keyboard --- */
/* emu_main.c fills the queue from the PC keyboard */
bool emu_shift = false, emu_fn = false;

bool keyboard_shift(void) { return emu_shift; }
bool keyboard_fn(void)    { return emu_fn; }

/* Key state, indexed by translated code (the PC has no key matrix). */
static bool giu[256];

bool keyboard_is_down(uint8_t code)
{
    return (code != 0u) && giu[code];
}

#define CODA_N 32
static key_event_t coda[CODA_N];
static int         testa = 0, quanti = 0;

void emu_accoda(uint8_t code, bool premuto)
{
    giu[code] = premuto;
    if (quanti >= CODA_N) return;
    coda[(testa + quanti) % CODA_N].code    = code;
    coda[(testa + quanti) % CODA_N].raw     = 0u;
    coda[(testa + quanti) % CODA_N].pressed = premuto;
    quanti++;
}

bool keyboard_poll(key_event_t *ev)
{
    if ((ev == NULL) || (quanti == 0)) return false;
    *ev   = coda[testa];
    testa = (testa + 1) % CODA_N;
    quanti--;
    return true;
}

/* --- microSD --- */
bool sd_card_mounted(void) { return true; }
