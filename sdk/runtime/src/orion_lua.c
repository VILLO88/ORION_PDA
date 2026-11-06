/**
 * @file    orion_lua.c
 * @brief   The Lua interpreter on the device: arena, allocator, hook.
 */

#include "orion_lua.h"
#include "psram.h"
#include "usb_cdc.h"
#include "sistema.h"
#include "rk817_rtc.h"
#include "lua.h"
#include "lauxlib.h"
#include "lualib.h"
#include <stdlib.h>
#include "lua.h"
#include "lauxlib.h"
#include <string.h>

/* ==========================================================================
 *  The arena and its allocator
 * ==========================================================================
 * Lua gets its own arena instead of malloc(), so the heap can be placed
 * anywhere and its use measured. First fit, neighbours merged on free.
 */
/* 128 KB: real apps with a few hundred tables and strings need most of it. */
/* On a 64-bit host every Lua object is bigger (8-byte pointers), so the
   emulator gets a larger arena. 168 KB is a little stricter than the board
   for tables and strings; it is an estimate, not a measurement. */
#if UINTPTR_MAX > 0xFFFFFFFFu
#define ARENA_SRAM_BYTE   (168U * 1024U)
#else
#define ARENA_SRAM_BYTE   (128U * 1024U)
#endif
#define ARENA_PSRAM_BYTE  (512U * 1024U)
#define PSRAM_BASE        0x90000000U
/* offset 0, the base of the chip */
#define PSRAM_ARENA_OFF   0U

#if UINTPTR_MAX > 0xFFFFFFFFu
/* ORION_LUA_KB (emulator only) raises the arena for apps made mostly of
   code, where the 64-bit host costs about 1.7 times the board. */
#define ARENA_SRAM_MAX    (1024U * 1024U)
static uint8_t arena_sram[ARENA_SRAM_MAX] __attribute__((aligned(8)));
static uint32_t arena_sram_byte(void)
{
    const char *e = getenv("ORION_LUA_KB");
    long        kb = (e != NULL) ? strtol(e, NULL, 10) : 0;

    if ((kb < 64) || (kb > (long)(ARENA_SRAM_MAX / 1024U))) return ARENA_SRAM_BYTE;
    return (uint32_t)kb * 1024U;
}
#else
static uint8_t arena_sram[ARENA_SRAM_BYTE] __attribute__((aligned(8)));
static uint32_t arena_sram_byte(void) { return ARENA_SRAM_BYTE; }
#endif

/* The header is padded to 16 bytes so returned blocks are 8-aligned. */
typedef struct blocco {
    uint32_t       byte;      /* usable size, without header */
    uint32_t       libero;    /* 0/1, 32 bits for alignment */
    struct blocco *next;
    uint32_t       pad;
} blocco_t;

static uint8_t  *arena_base = NULL;
static uint32_t  arena_byte = 0U;
static blocco_t *primo      = NULL;
static uint32_t  in_uso     = 0U;

static void arena_init(uint8_t *base, uint32_t byte)
{
    arena_base = base;
    arena_byte = byte;
    primo      = (blocco_t *)base;
    primo->byte   = byte - sizeof(blocco_t);
    primo->libero = 1U;
    primo->next   = NULL;
    in_uso        = 0U;
}

static void *arena_alloc(uint32_t byte)
{
    blocco_t *b = primo;

    byte = (byte + 7U) & ~7U;   /* aligned to 8 */

    while (b != NULL)
    {
        if ((b->libero != 0U) && (b->byte >= byte))
        {
            /* split if a whole block is left over */
            if (b->byte >= (byte + sizeof(blocco_t) + 16U))
            {
                blocco_t *n = (blocco_t *)((uint8_t *)b + sizeof(blocco_t) + byte);

                n->byte   = b->byte - byte - sizeof(blocco_t);
                n->libero = 1U;
                n->next   = b->next;
                b->byte   = byte;
                b->next   = n;
            }
            b->libero = 0U;
            in_uso   += b->byte;
            return (uint8_t *)b + sizeof(blocco_t);
        }
        b = b->next;
    }
    return NULL;
}

static void arena_free(void *p)
{
    blocco_t *b;

    if (p == NULL) return;

    b = (blocco_t *)((uint8_t *)p - sizeof(blocco_t));
    b->libero = 1U;
    in_uso   -= b->byte;

    /* merge with free neighbours so the arena does not fragment */
    {
        blocco_t *c = primo;

        while (c != NULL)
        {
            if ((c->libero != 0U) && (c->next != NULL) && (c->next->libero != 0U))
            {
                c->byte += sizeof(blocco_t) + c->next->byte;
                c->next  = c->next->next;
                continue;           /* check the same block again, it may merge further */
            }
            c = c->next;
        }
    }
}

/* The lua_Alloc function. If an allocation fails it returns NULL and the
 * old block must stay valid: Lua keeps using it. */
static void *lua_alloc(void *ud, void *ptr, size_t osize, size_t nsize)
{
    void *nuovo;

    (void)ud;

    /* Keep USB alive: during lua_newstate() the hook is not installed yet. */
    {
        static uint32_t n = 0U;

        if ((++n & 0x3FFU) == 0U) usb_cdc_task();
    }

    if (nsize == 0U) { arena_free(ptr); return NULL; }

    nuovo = arena_alloc((uint32_t)nsize);
    if (nuovo == NULL) return NULL;

    if (ptr != NULL)
    {
        memcpy(nuovo, ptr, (osize < nsize) ? osize : nsize);
        arena_free(ptr);
    }
    return nuovo;
}

/* ==========================================================================
 *  The state
 * ========================================================================== */
static lua_State        *L    = NULL;
static orion_lua_arena_t dove_ora = ORION_LUA_SRAM;

unsigned int orion_lua_seed(void)
{
    rk817_time_t t;
    unsigned int s = (unsigned int)HAL_GetTick();

    /* the real time, so two power-ups give different seeds */
    if (rk817_rtc_cached(&t))
    {
        s ^= ((unsigned int)t.anno << 20) ^ ((unsigned int)t.mese << 16) ^
             ((unsigned int)t.giorno << 12) ^ ((unsigned int)t.ora << 8) ^
             ((unsigned int)t.minuto << 4) ^ (unsigned int)t.secondo;
    }

    /* and the cycle counter, in case the clock was never set */
    s ^= DWT->CYCCNT;
    return s;
}

void orion_lua_scrivi(const char *s, size_t n)
{
    char buf[128];
    size_t k = (n < (sizeof buf - 1U)) ? n : (sizeof buf - 1U);

    memcpy(buf, s, k);
    buf[k] = '\0';
    usb_cdc_printf("%s", buf);
}

/* Lua's panic and warning messages go to the console. */
void orion_lua_errore(const char *fmt, const char *arg)
{
    usb_cdc_printf(fmt, (arg != NULL) ? arg : "?");
}

/* ==========================================================================
 *  The hook
 * ==========================================================================
 * Every PASSI VM instructions the firmware takes control back, so audio,
 * recording and the USB console keep running even in `while true do end`.
 * It calls sistema_respira() and USB, not sistema_servizi(): that one can
 * run a console command, which must not happen inside a script.
 */
#define HOOK_PASSI   2000

static void hook(lua_State *Ls, lua_Debug *ar)
{
    (void)Ls; (void)ar;
    sistema_respira();
    usb_cdc_task();
}

void orion_lua_chiudi(void)
{
    if (L != NULL) { lua_close(L); L = NULL; }
}

bool orion_lua_apri(orion_lua_arena_t dove)
{
    orion_lua_chiudi();

    if (dove == ORION_LUA_PSRAM)
    {
        /* Experimental: a Lua heap in PSRAM hangs the board inside
           lua_newstate() (scattered small accesses). Only `lua psram` gets
           here. */
        usb_cdc_printf("  warning: a Lua heap in PSRAM hangs the board inside"
                       " lua_newstate().\r\n");
        for (uint8_t i = 0U; i < 60U; i++) { usb_cdc_task(); HAL_Delay(1); }
        volatile uint32_t *prova = (volatile uint32_t *)(PSRAM_BASE + PSRAM_ARENA_OFF);
        uint32_t           letto;

        /* Each step is logged and flushed before it runs, so a hang shows
           where it stopped. */
        usb_cdc_printf("  psram: checking...\r\n");
        for (uint8_t i = 0U; i < 40U; i++) { usb_cdc_task(); HAL_Delay(1); }

        /* the chip must be initialised, or writing to it is a bus fault */
        if (!psram_ready())
        {
            usb_cdc_printf("lua: PSRAM not ready (%s)\r\n", psram_status());
            return false;
        }

        usb_cdc_printf("  psram: ready (%s). Memory-mapped: %s\r\n",
                       psram_status(), psram_mmap() ? "on" : "off");
        for (uint8_t i = 0U; i < 40U; i++) { usb_cdc_task(); HAL_Delay(1); }

        if (!psram_mmap() && !psram_set_mmap(true))
        {
            usb_cdc_printf("lua: cannot enable PSRAM"
                           " memory-mapped mode\r\n");
            return false;
        }

        usb_cdc_printf("  psram: memory-mapped on. Reading %08lX...\r\n",
                       (unsigned long)(PSRAM_BASE + PSRAM_ARENA_OFF));
        for (uint8_t i = 0U; i < 40U; i++) { usb_cdc_task(); HAL_Delay(1); }

        letto = *prova;
        usb_cdc_printf("  psram: read %08lX. Writing...\r\n",
                       (unsigned long)letto);
        for (uint8_t i = 0U; i < 40U; i++) { usb_cdc_task(); HAL_Delay(1); }

        *prova = 0xA5C3F00DU;
        __DSB();
        usb_cdc_printf("  psram: written. Reading back...\r\n");
        for (uint8_t i = 0U; i < 40U; i++) { usb_cdc_task(); HAL_Delay(1); }

        letto = *prova;
        if (letto != 0xA5C3F00DU)
        {
            usb_cdc_printf("lua: PSRAM does not hold data "
                           "(wrote A5C3F00D, read %08lX)\r\n",
                           (unsigned long)letto);
            return false;
        }
        usb_cdc_printf("  psram: read back fine. %lu KB arena at %08lX.\r\n",
                       (unsigned long)(ARENA_PSRAM_BYTE / 1024U),
                       (unsigned long)(PSRAM_BASE + PSRAM_ARENA_OFF));
        for (uint8_t i = 0U; i < 40U; i++) { usb_cdc_task(); HAL_Delay(1); }
        arena_init((uint8_t *)(PSRAM_BASE + PSRAM_ARENA_OFF), ARENA_PSRAM_BYTE);
    }
    else
    {
        arena_init(arena_sram, arena_sram_byte());
    }
    dove_ora = dove;

    /* Opening the state means thousands of small allocations: both times
       are printed so SRAM and PSRAM can be compared. */
    {
        uint32_t t0 = HAL_GetTick();
        uint32_t t_stato, t_libs;

        L = lua_newstate(lua_alloc, NULL);
        t_stato = HAL_GetTick() - t0;

        if (L == NULL)
        {
            usb_cdc_printf("lua: no memory for the state\r\n");
            return false;
        }

        t0 = HAL_GetTick();
        luaL_openlibs(L);
        t_libs = HAL_GetTick() - t0;

        usb_cdc_printf("  open: state %lu ms, libraries %lu ms\r\n",
                       (unsigned long)t_stato, (unsigned long)t_libs);
        for (uint8_t i = 0U; i < 40U; i++) { usb_cdc_task(); HAL_Delay(1); }
    }

    /* Installed before the app runs; the debug library is not loaded, so
       no script can remove it. */
    lua_sethook(L, hook, LUA_MASKCOUNT, HOOK_PASSI);
    return true;
}

int orion_lua_memoria(void) { return (int)in_uso; }

struct lua_State *orion_lua_stato(void) { return L; }

bool orion_lua_esegui(const char *codice)
{
    if (L == NULL) return false;

    if (luaL_dostring(L, codice) != LUA_OK)
    {
        usb_cdc_printf("lua: %s\r\n", lua_tostring(L, -1));
        lua_pop(L, 1);
        return false;
    }
    return true;
}

/* ==========================================================================
 *  Benchmark
 * ==========================================================================
 * Floating point, tables and strings: what an app actually does.
 */
static const char *const BENCH =
    "local t = {}\n"
    "for i = 1, 300 do t[i] = { x = i * 1.5, s = 'v' .. i } end\n"
    "local s = 0.0\n"
    "for k = 1, 120 do\n"
    "  for i = 1, 300 do s = s + t[i].x * 0.5 end\n"
    "end\n"
    "local n = 0\n"
    "for i = 1, 300 do if #t[i].s > 2 then n = n + 1 end end\n"
    "return s + n\n";

void orion_lua_bench_una(void)
{
    /* the same program on a state that is already open */
    const uint32_t t0 = HAL_GetTick();

    if (orion_lua_esegui(BENCH))
    {
        usb_cdc_printf("lua: %lu ms\r\n", (unsigned long)(HAL_GetTick() - t0));
    }
}

static uint32_t bench_una(orion_lua_arena_t dove, int *kb)
{
    uint32_t t0;

    if (!orion_lua_apri(dove)) return 0U;

    t0 = HAL_GetTick();
    if (!orion_lua_esegui(BENCH))
    {
        /* say how much was in use when memory ran out */
        usb_cdc_printf("  (arena %lu KB, %d KB in use"
                       " at the error)\r\n",
                       (unsigned long)(arena_byte / 1024U),
                       orion_lua_memoria() / 1024);
        orion_lua_chiudi();
        return 0U;
    }
    {
        const uint32_t dt = HAL_GetTick() - t0;

        *kb = orion_lua_memoria() / 1024;
        orion_lua_chiudi();
        return dt;
    }
}

void orion_lua_bench(void)
{
    int ks = 0, kp = 0;
    uint32_t ts, tp;

    usb_cdc_printf("lua: benchmark running (twice, do not touch anything)...\r\n");
    sistema_respira();

    ts = bench_una(ORION_LUA_SRAM, &ks);
    sistema_respira();

    /* PSRAM is not tested here: it hangs the board (see `lua psram`). */
    tp = 0U; kp = 0;

    usb_cdc_printf("\r\n  arena      time     memory\r\n");
    usb_cdc_printf("  SRAM     %5lu ms   %3d KB\r\n", (unsigned long)ts, ks);
    if (tp != 0U)
    {
        usb_cdc_printf("  PSRAM    %5lu ms   %3d KB\r\n", (unsigned long)tp, kp);
        if (ts != 0U)
        {
            usb_cdc_printf("\r\n  PSRAM costs %lu.%lu times SRAM\r\n",
                           (unsigned long)(tp / ts),
                           (unsigned long)(((tp * 10U) / ts) % 10U));
        }
    }
    else
    {
        usb_cdc_printf("  PSRAM    not tested: it hangs the board inside\r\n"
                       "           lua_newstate().\r\n");
    }
    usb_cdc_printf("\r\n  The program builds tables and strings: it measures"
                   " the heap.\r\n");
}
