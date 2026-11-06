/**
 * @file    orion_pref.c
 * @brief   App preferences: key=value lines in the app's data/prefs.txt.
 *
 * Not in internal flash: that is a single 8 KB page that belongs to the
 * system settings. A text file can also be opened and fixed on a PC.
 * Every write rewrites the whole file, which is fine for a few keys.
 */

#include "orion_api.h"
#include "orion_fs.h"
#include <string.h>
#include <stdio.h>
#include <stdlib.h>

#define PREF_FILE   "data/prefs.txt"
#define PREF_MAX    1024U     /* the whole file, in memory */


static char buf[PREF_MAX];

static int carica(void)
{
    const int n = ORION_FS.read_all(PREF_FILE, buf, (int)(PREF_MAX - 1U));

    if (n <= 0) { buf[0] = '\0'; return 0; }
    buf[n] = '\0';
    return n;
}

/* Returns the value of the key inside `buf` (not terminated) and its
   length, or NULL. */
static const char *trova(const char *chiave, size_t *len)
{
    const size_t lk = strlen(chiave);
    const char  *p  = buf;

    while (*p != '\0')
    {
        const char *fine = strchr(p, '\n');
        const char *uguale = strchr(p, '=');

        if (fine == NULL) fine = p + strlen(p);

        if ((uguale != NULL) && (uguale < fine) &&
            ((size_t)(uguale - p) == lk) && (strncmp(p, chiave, lk) == 0))
        {
            *len = (size_t)(fine - (uguale + 1));
            return uguale + 1;
        }
        p = (*fine == '\0') ? fine : (fine + 1);
    }
    return NULL;
}

static void scrivi(const char *chiave, const char *valore)
{
    char        nuovo[PREF_MAX];
    size_t      n = 0U;
    const char *p;
    const size_t lk = strlen(chiave);

    (void)carica();

    p = buf;
    while ((*p != '\0') && (n < (PREF_MAX - 128U)))
    {
        const char *fine   = strchr(p, '\n');
        const char *uguale = strchr(p, '=');
        const size_t lriga = (fine != NULL) ? (size_t)(fine - p) : strlen(p);
        const bool   e_mia = (uguale != NULL) && ((size_t)(uguale - p) == lk) &&
                             (strncmp(p, chiave, lk) == 0);

        if (!e_mia && (lriga > 0U))
        {
            (void)memcpy(&nuovo[n], p, lriga);
            n += lriga;
            nuovo[n++] = '\n';
        }
        p = (fine == NULL) ? (p + lriga) : (fine + 1);
    }

    n += (size_t)snprintf(&nuovo[n], PREF_MAX - n, "%s=%s\n", chiave, valore);
    (void)ORION_FS.write_all(PREF_FILE, nuovo, (int)n);
}

/* ==========================================================================
 *  API
 * ========================================================================== */
static int pref_get_int(const char *chiave, int fallback)
{
    size_t      len = 0U;
    const char *v;

    (void)carica();
    v = trova(chiave, &len);
    if ((v == NULL) || (len == 0U)) return fallback;
    return (int)strtol(v, NULL, 10);
}

static void pref_set_int(const char *chiave, int valore)
{
    char t[16];

    (void)snprintf(t, sizeof t, "%d", valore);
    scrivi(chiave, t);
}

static int pref_get_str(const char *chiave, char *out, int n, const char *fallback)
{
    size_t      len = 0U;
    const char *v;

    if ((out == NULL) || (n <= 0)) return 0;

    (void)carica();
    v = trova(chiave, &len);

    if (v == NULL)
    {
        (void)snprintf(out, (size_t)n, "%s", (fallback != NULL) ? fallback : "");
        return (int)strlen(out);
    }
    if (len > (size_t)(n - 1)) len = (size_t)(n - 1);
    (void)memcpy(out, v, len);
    out[len] = '\0';
    return (int)len;
}

static void pref_set_str(const char *chiave, const char *valore)
{
    /* A newline in the value would break the file: cut there. */
    char pulito[128];
    char *nl;

    (void)snprintf(pulito, sizeof pulito, "%s", (valore != NULL) ? valore : "");
    nl = strchr(pulito, '\n');
    if (nl != NULL) *nl = '\0';

    scrivi(chiave, pulito);
}

const orion_pref_t ORION_PREF = {
    .get_int  = pref_get_int,
    .set_int  = pref_set_int,
    .get_str  = pref_get_str,
    .set_str  = pref_set_str,
};
