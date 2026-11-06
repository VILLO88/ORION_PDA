/**
 * @file    app_lua.c
 * @brief   Runs a Lua app from the microSD with the same init/update/close
 *          cycle and the same API as native apps.
 */

#include "app_iface.h"
#include "app_host.h"
#include "orion_ui.h"
#include "orion_lua.h"
#include "orion_fs.h"
#include "sd_card.h"
#include "sharp_ls032.h"
#include "keyboard.h"
#include "usb_cdc.h"
#include "ff.h"
#include "lua.h"
#include "lauxlib.h"
#include <string.h>
#include <stdio.h>

#define SCRIPT_MAX   (32U * 1024U)   /* source size limit */

static char       script[SCRIPT_MAX];
static char       path_corrente[80];
static bool       ha_update = false;
static bool       ha_close  = false;

/* Errors are shown on the panel too: the author usually has no console
   attached. */
static char errore[160] = {0};
static bool mostra_errore = false;

/* ==========================================================================
 *  The coroutine init() and update() run on
 * ==========================================================================
 * orion.ui dialogs look blocking to the app, but the main loop cannot wait:
 * the function yields, the firmware keeps running with the dialog on screen,
 * and the coroutine resumes with the answer.
 *
 * The thread is created after lua_sethook(): lua_newthread copies the hook,
 * which keeps the USB console alive during long calls.
 */
bool orion_lua_ui_pronta(void);
int  orion_lua_ui_spingi(lua_State *Ls);

static lua_State *co       = NULL;
static int        co_ref   = LUA_NOREF;   /* anchor against the GC */
static bool       sospesa  = false;       /* stopped on a dialog */

static void co_crea(void)
{
    lua_State *L = orion_lua_stato();

    co      = lua_newthread(L);
    co_ref  = luaL_ref(L, LUA_REGISTRYINDEX);
    sospesa = false;
}

static void co_butta(void)
{
    lua_State *L = orion_lua_stato();

    if ((L != NULL) && (co_ref != LUA_NOREF)) luaL_unref(L, LUA_REGISTRYINDEX, co_ref);
    co = NULL; co_ref = LUA_NOREF; sospesa = false;
}

/* Runs the coroutine. `nargs` values are already pushed (a dialog's
   answer). */
static bool co_corri(const char *nome, int nargs)
{
    int nres = 0;
    int st;

    if (co == NULL) return false;

    st = lua_resume(co, orion_lua_stato(), nargs, &nres);

    if (st == LUA_YIELD)
    {
        sospesa = true;        /* waiting on a dialog */
        return true;
    }

    sospesa = false;
    if (st != LUA_OK)
    {
        const char *msg = lua_tostring(co, -1);

        usb_cdc_printf("app lua: error in %s(): %s\r\n", nome, msg);
        (void)snprintf(errore, sizeof errore, "%s", (msg != NULL) ? msg : "?");

        /* A coroutine that died with an error cannot be resumed and would hide
           the real message; one that returned is reused. */
        (void)lua_closethread(co, orion_lua_stato());
        lua_settop(co, 0);
        return false;
    }
    lua_settop(co, 0);
    return true;
}

static bool chiama_co(const char *nome, bool obbligatoria)
{
    if (co == NULL) return false;

    /* Suspended on a dialog: resume it with the answer instead of calling
       update() again. */
    if (sospesa)
    {
        if (!orion_lua_ui_pronta())
        {
            if (orion_ui_attivo()) return true;    /* dialog still open */

            /* Closed without an answer (a notice): resume with nil, or the app
               would wait forever. */
            lua_pushnil(co);
            return co_corri(nome, 1);
        }
        return co_corri(nome, orion_lua_ui_spingi(co));
    }

    lua_getglobal(co, nome);
    if (!lua_isfunction(co, -1))
    {
        lua_pop(co, 1);
        if (obbligatoria)
        {
            usb_cdc_printf("app lua: missing function %s()\r\n", nome);
            return false;
        }
        return true;
    }
    return co_corri(nome, 0);
}

/* Calls a global function of the script, if present. An error closes the
   app, never the device. */
static bool chiama(const char *nome, bool obbligatoria)
{
    lua_State *L = orion_lua_stato();

    if (L == NULL) return false;

    lua_getglobal(L, nome);
    if (!lua_isfunction(L, -1))
    {
        lua_pop(L, 1);
        if (obbligatoria)
        {
            usb_cdc_printf("app lua: missing function %s()\r\n", nome);
            return false;
        }
        return true;
    }

    if (lua_pcall(L, 0, 0, 0) != LUA_OK)
    {
        const char *msg = lua_tostring(L, -1);

        usb_cdc_printf("app lua: error in %s(): %s\r\n", nome, msg);
        (void)snprintf(errore, sizeof errore, "%s", (msg != NULL) ? msg : "?");
        lua_pop(L, 1);
        return false;
    }
    return true;
}

/* Error screen, until a key is pressed. The message is wrapped, not
   truncated: it starts with file:line. */
static void disegna_errore(void)
{
    const uint16_t W = sharp_lcd_width();
    uint16_t       y = 40U;
    const char    *p = errore;

    sharp_lcd_clear(SHARP_COLOR_WHITE);
    sharp_lcd_fill_rect(0, 0, W, 26, SHARP_COLOR_BLACK);
    sharp_lcd_draw_string_font(8, 5, "SCRIPT ERROR", SHARP_COLOR_WHITE,
                               2, &font_5x7);

    sharp_lcd_draw_string_font(8, y, path_corrente, SHARP_COLOR_BLACK, 1,
                               &font_5x7);
    y = (uint16_t)(y + 18U);

    while ((*p != '\0') && (y < (sharp_lcd_height() - 40U)))
    {
        char riga[46];
        uint8_t i = 0U;

        while ((i < (sizeof riga - 1U)) && (*p != '\0') && (*p != '\n'))
        {
            riga[i++] = *p++;
        }
        riga[i] = '\0';
        if (*p == '\n') p++;

        sharp_lcd_draw_string_font(8, y, riga, SHARP_COLOR_BLACK, 2, &font_5x7);
        y = (uint16_t)(y + 22U);
    }

    sharp_lcd_draw_string_font(8, (uint16_t)(sharp_lcd_height() - 24U),
                               "press a key to go home",
                               SHARP_COLOR_BLACK, 1, &font_5x7);
    (void)sharp_lcd_refresh_multiline_dma();
}

static bool carica(const char *path)
{
    FIL   f;
    UINT  letti = 0U;
    FRESULT fr;

    if (!sd_card_mounted())
    {
        usb_cdc_printf("app lua: no microSD card\r\n");
        return false;
    }

    fr = f_open(&f, path, FA_READ);
    if (fr != FR_OK)
    {
        usb_cdc_printf("app lua: cannot find %s (error %d)\r\n", path, (int)fr);
        return false;
    }

    fr = f_read(&f, script, SCRIPT_MAX - 1U, &letti);
    f_close(&f);

    if ((fr != FR_OK) || (letti == 0U))
    {
        usb_cdc_printf("app lua: %s is unreadable or empty\r\n", path);
        return false;
    }
    if (letti >= (SCRIPT_MAX - 1U))
    {
        /* refuse a truncated script rather than run half of it */
        usb_cdc_printf("app lua: %s is larger than %lu KB\r\n", path,
                       (unsigned long)(SCRIPT_MAX / 1024U));
        return false;
    }
    script[letti] = '\0';
    return true;
}

static bool lua_app_init(const orion_api_t *api)
{
    lua_State  *L;
    const char *arg = app_host_argomento();

    snprintf(path_corrente, sizeof path_corrente, "%s",
             (arg != NULL) ? arg : "/apps/demo.lua");

    /* The data folder is named after the script, so each script has its own
       data/ and prefs.txt. */
    {
        const char *base = strrchr(path_corrente, '/');
        char        nome[32];
        char       *punto;

        {
            const char *src = (base != NULL) ? (base + 1) : path_corrente;
            size_t      n   = strlen(src);

            if (n > (sizeof nome - 1U)) n = sizeof nome - 1U;
            memcpy(nome, src, n);
            nome[n] = '\0';
        }
        punto = strrchr(nome, '.');
        if (punto != NULL) *punto = '\0';
        orion_fs_set_dati(nome);
    }

    if (!carica(path_corrente))                 return false;
    if (!orion_lua_apri(ORION_LUA_SRAM))        return false;

    L = orion_lua_stato();

    /* Each step is logged before it runs, so a hang shows where it stopped. */
    usb_cdc_printf("  loading the API...\r\n");
    for (uint8_t i = 0U; i < 30U; i++) { usb_cdc_task(); HAL_Delay(1); }

    orion_lua_bind(L, api);

    usb_cdc_printf("  API loaded. Compiling %u bytes...\r\n",
                   (unsigned)strlen(script));
    for (uint8_t i = 0U; i < 30U; i++) { usb_cdc_task(); HAL_Delay(1); }

    mostra_errore = false;
    errore[0]     = '\0';

    /* A syntax error still opens the app, to show the error. */
    if (luaL_loadbuffer(L, script, strlen(script), path_corrente) != LUA_OK)
    {
        usb_cdc_printf("app lua: %s\r\n", lua_tostring(L, -1));
        (void)snprintf(errore, sizeof errore, "%s", lua_tostring(L, -1));
        mostra_errore = true;
        disegna_errore();
        return true;
    }
    if (lua_pcall(L, 0, 0, 0) != LUA_OK)
    {
        usb_cdc_printf("app lua: %s\r\n", lua_tostring(L, -1));
        (void)snprintf(errore, sizeof errore, "%s", lua_tostring(L, -1));
        mostra_errore = true;
        disegna_errore();
        return true;
    }

    usb_cdc_printf("  compiled and run. Looking for init/update...\r\n");
    for (uint8_t i = 0U; i < 30U; i++) { usb_cdc_task(); HAL_Delay(1); }

    lua_getglobal(L, "update"); ha_update = lua_isfunction(L, -1); lua_pop(L, 1);
    lua_getglobal(L, "close");  ha_close  = lua_isfunction(L, -1); lua_pop(L, 1);

    if (mostra_errore) return true;

    if (!ha_update)
    {
        /* Without update() the app could not do anything: refuse it. */
        usb_cdc_printf("app lua: %s has no update() function\r\n",
                       path_corrente);
        orion_lua_chiudi();
        return false;
    }

    co_crea();

    if (!chiama_co("init", false))
    {
        mostra_errore = true;
        disegna_errore();
        return true;
    }

    usb_cdc_printf("app lua: %s started\r\n", path_corrente);
    for (uint8_t i = 0U; i < 30U; i++) { usb_cdc_task(); HAL_Delay(1); }
    return true;
}

static void lua_app_update(void)
{
    if (mostra_errore)
    {
        key_event_t ev;

        while (app_host_evento(&ev))
        {
            if (ev.pressed) { app_host_esci(); return; }
        }
        return;
    }

    if (!chiama_co("update", true))
    {
        /* show the error first, then quit */
        mostra_errore = true;
        disegna_errore();
    }
}

static void lua_app_close(void)
{
    /* close() runs on the main state, not on the coroutine: a dialog opened
       there could never be answered. */
    if (ha_close) (void)chiama("close", false);
    co_butta();
    orion_lua_chiudi();

    /* Close files the script left open: an unclosed FatFs file loses its
       last sector. */
    orion_fs_chiudi_tutto();
}

const app_iface_t app_lua = {
    .id     = "lua",
    .nome   = "Lua script",
    .init   = lua_app_init,
    .update = lua_app_update,
    .close  = lua_app_close,
};
