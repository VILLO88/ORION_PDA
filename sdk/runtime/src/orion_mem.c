/**
 * @file    orion_mem.c
 * @brief   Partition allocator for apps. See `orion_mem.h`.
 */
#include "orion_mem.h"
#include "psram.h"

#include <stdint.h>
#include <string.h>

/* The fast reserve is small on purpose: it shares the internal SRAM with
   the audio ring, the framebuffer and the Lua heap. */
#define SRAM_BYTE     (32U * 1024U)
#define PSRAM_BYTE    (8U * 1024U * 1024U)

/* A fixed number of pieces per reserve, with the descriptors in SRAM, so a
   search never reads the PSRAM. */
#define PEZZI_MAX     32U

#define ALLINEA       8U    /* blocks start aligned to 8: memcpy and DMA */

typedef struct {
    uint32_t off;
    uint32_t len;
    bool     usato;
} pezzo_t;

typedef struct {
    uint8_t  *base;
    uint32_t  byte;
    pezzo_t   pezzi[PEZZI_MAX];
    uint32_t  n;
} riserva_t;

static uint8_t   sram_pool[SRAM_BYTE] __attribute__((aligned(8)));
static riserva_t sram;
static riserva_t psram;
static bool      pronta = false;

/* ==========================================================================
 *  The reserve
 * ========================================================================== */

static void riserva_azzera(riserva_t *r, uint8_t *base, uint32_t byte)
{
    r->base = base;
    r->byte = byte;
    r->n    = (base != NULL) ? 1U : 0U;
    if (base != NULL)
    {
        r->pezzi[0].off   = 0U;
        r->pezzi[0].len   = byte;
        r->pezzi[0].usato = false;
    }
}

static void prepara(void)
{
    if (pronta) return;
    pronta = true;

    riserva_azzera(&sram, sram_pool, SRAM_BYTE);

    /* Pointers into the PSRAM need memory-mapped mode, enabled here on first
       use. Without the chip the large reserve stays empty and free_large()
       returns 0. */
    if (psram_ready() && (psram_mmap() || psram_set_mmap(true)))
        riserva_azzera(&psram, (uint8_t *)PSRAM_MMAP_BASE, PSRAM_BYTE);
    else
        riserva_azzera(&psram, NULL, 0U);
}

/* Splits piece `i`, leaving `quanto` used and the rest free. */
static void spezza(riserva_t *r, uint32_t i, uint32_t quanto)
{
    if ((r->pezzi[i].len == quanto) || (r->n >= PEZZI_MAX))
    {
        /* No room for a remainder: hand over the whole piece. */
        r->pezzi[i].usato = true;
        return;
    }

    memmove(&r->pezzi[i + 1U], &r->pezzi[i],
            (size_t)(r->n - i) * sizeof(pezzo_t));
    r->n++;

    r->pezzi[i].len       = quanto;
    r->pezzi[i].usato     = true;
    r->pezzi[i + 1U].off  = r->pezzi[i].off + quanto;
    r->pezzi[i + 1U].len -= quanto;
    r->pezzi[i + 1U].usato = false;
}

static void *prendi(riserva_t *r, uint32_t byte)
{
    uint32_t i;

    if ((r->base == NULL) || (byte == 0U)) return NULL;
    byte = (byte + (ALLINEA - 1U)) & ~(ALLINEA - 1U);

    for (i = 0U; i < r->n; i++)
    {
        if (!r->pezzi[i].usato && (r->pezzi[i].len >= byte))
        {
            spezza(r, i, byte);
            return r->base + r->pezzi[i].off;
        }
    }
    return NULL;
}

/* Merges adjacent free pieces, so the reserve does not fill with holes. */
static void ricuci(riserva_t *r)
{
    uint32_t i = 0U;

    while ((i + 1U) < r->n)
    {
        if (!r->pezzi[i].usato && !r->pezzi[i + 1U].usato)
        {
            r->pezzi[i].len += r->pezzi[i + 1U].len;
            memmove(&r->pezzi[i + 1U], &r->pezzi[i + 2U],
                    (size_t)(r->n - i - 2U) * sizeof(pezzo_t));
            r->n--;
        }
        else i++;
    }
}

static bool rilascia(riserva_t *r, const void *p)
{
    uint32_t i;
    uint32_t off;

    if ((r->base == NULL) || (p == NULL)) return false;
    if (((const uint8_t *)p < r->base) ||
        ((const uint8_t *)p >= (r->base + r->byte))) return false;

    off = (uint32_t)((const uint8_t *)p - r->base);
    for (i = 0U; i < r->n; i++)
    {
        if (r->pezzi[i].off == off)
        {
            r->pezzi[i].usato = false;
            ricuci(r);
            return true;
        }
    }
    return false;   /* a pointer that is the start of no block */
}

/* The largest free piece, not the total: that is what tells whether an
   allocation will fit. */
static uint32_t piu_grande(const riserva_t *r)
{
    uint32_t i, max = 0U;

    for (i = 0U; i < r->n; i++)
        if (!r->pezzi[i].usato && (r->pezzi[i].len > max)) max = r->pezzi[i].len;
    return max;
}

/* ==========================================================================
 *  The vtable
 * ========================================================================== */

static void *mem_alloc(int bytes, orion_mem_kind_t kind)
{
    prepara();
    if (bytes <= 0) return NULL;

    if (kind == ORION_MEM_FAST) return prendi(&sram, (uint32_t)bytes);

    /* ANY tries the large reserve first, since SRAM is the scarce one, and
       falls back on the fast one for boards without PSRAM. */
    {
        void *p = prendi(&psram, (uint32_t)bytes);

        return (p != NULL) ? p : prendi(&sram, (uint32_t)bytes);
    }
}

static void mem_free(void *p)
{
    prepara();
    if (rilascia(&sram, p)) return;
    (void)rilascia(&psram, p);
}

static bool mem_is_fast(const void *p)
{
    prepara();
    return ((const uint8_t *)p >= sram_pool) &&
           ((const uint8_t *)p <  (sram_pool + SRAM_BYTE));
}

static int mem_free_fast(void)  { prepara(); return (int)piu_grande(&sram);  }
static int mem_free_large(void) { prepara(); return (int)piu_grande(&psram); }

const orion_mem_t ORION_MEM = {
    .alloc      = mem_alloc,
    .free       = mem_free,
    .is_fast    = mem_is_fast,
    .free_fast  = mem_free_fast,
    .free_large = mem_free_large,
};

void orion_mem_reset(void)
{
    if (!pronta) return;
    riserva_azzera(&sram, sram.base, sram.byte);
    riserva_azzera(&psram, psram.base, psram.byte);
}

void orion_mem_stato(uint32_t *su, uint32_t *st, uint32_t *pu, uint32_t *pt)
{
    uint32_t i, a = 0U, b = 0U;

    prepara();
    for (i = 0U; i < sram.n;  i++) if (sram.pezzi[i].usato)  a += sram.pezzi[i].len;
    for (i = 0U; i < psram.n; i++) if (psram.pezzi[i].usato) b += psram.pezzi[i].len;

    if (su != NULL) *su = a;
    if (st != NULL) *st = sram.byte;
    if (pu != NULL) *pu = b;
    if (pt != NULL) *pt = psram.byte;
}
