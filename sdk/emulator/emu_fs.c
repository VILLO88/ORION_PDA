/**
 * @file  emu_fs.c
 * @brief The microSD on the PC: a folder, with the same sandbox as the
 *        device (data/ and shared/, no absolute paths, no `..`).
 */
#include "orion_api.h"
#include "emu_hw.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <dirent.h>
#include <errno.h>

#ifdef _WIN32
/* Windows' mkdir() has no mode argument. Forward slashes in paths are fine. */
#include <direct.h>
#define mkdir(path, mode) _mkdir(path)
#endif

const char *emu_radice = "./card";
static char dati_nome[32] = "app";

void orion_fs_set_dati(const char *nome)
{
    snprintf(dati_nome, sizeof dati_nome, "%s", (nome != NULL) ? nome : "app");
}

/* Creates the missing folders along a path (like `mkdir -p`). */
static void mkdir_p(const char *path)
{
    char buf[512];
    char *p;

    snprintf(buf, sizeof buf, "%s", path);
    for (p = buf + 1; *p != '\0'; p++)
    {
        if (*p != '/') continue;
        *p = '\0';
        (void)mkdir(buf, 0755);
        *p = '/';
    }
}

/* Turns an app path into a PC path, or fails. The `..` check looks at the
   whole path. */
static bool risolvi(const char *in, char *out, size_t n)
{
    if ((in == NULL) || (strstr(in, "..") != NULL)) return false;

    if (strncmp(in, "data/", 5) == 0)
    {
        char dir[384];

        snprintf(dir, sizeof dir, "%s/apps/data/%s", emu_radice, dati_nome);
        mkdir_p(dir);
        (void)mkdir(dir, 0755);
        snprintf(out, n, "%s/%s", dir, &in[5]);
        return true;
    }
    if (strncmp(in, "shared/", 7) == 0)
    {
        snprintf(out, n, "%s/%s", emu_radice, &in[7]);
        return true;
    }
    return false;     /* no absolute paths */
}

struct orion_file { FILE *f; };
static struct orion_file aperti[8];

static orion_file_t *fs_open(const char *path, orion_mode_t mode)
{
    char pc[512];
    int  i;

    if (!risolvi(path, pc, sizeof pc)) return NULL;
    for (i = 0; i < 8; i++) if (aperti[i].f == NULL) break;
    if (i == 8) return NULL;

    if (mode != ORION_READ) mkdir_p(pc);
    aperti[i].f = fopen(pc, (mode == ORION_WRITE) ? "wb"
                          : (mode == ORION_APPEND) ? "ab" : "rb");
    return (aperti[i].f != NULL) ? &aperti[i] : NULL;
}

static int fs_read(orion_file_t *h, void *b, int n)
{
    return ((h != NULL) && (h->f != NULL)) ? (int)fread(b, 1, (size_t)n, h->f) : -1;
}
static int fs_write(orion_file_t *h, const void *b, int n)
{
    return ((h != NULL) && (h->f != NULL)) ? (int)fwrite(b, 1, (size_t)n, h->f) : -1;
}
static orion_result_t fs_close(orion_file_t *h)
{
    if ((h == NULL) || (h->f == NULL)) return ORION_ERR_ARG;
    fclose(h->f); h->f = NULL;
    return ORION_OK;
}

static bool fs_exists(const char *path)
{
    char        pc[512];
    struct stat st;

    return risolvi(path, pc, sizeof pc) && (stat(pc, &st) == 0);
}

static int fs_size(const char *path)
{
    char        pc[512];
    struct stat st;

    if (!risolvi(path, pc, sizeof pc) || (stat(pc, &st) != 0)) return -1;
    return (int)st.st_size;
}

static orion_result_t fs_remove(const char *path)
{
    char pc[512];

    if (!risolvi(path, pc, sizeof pc)) return ORION_ERR_PERMISSION;
    return (remove(pc) == 0) ? ORION_OK : ORION_ERR_NOT_FOUND;
}

static orion_result_t fs_rename(const char *da, const char *a)
{
    char p1[512], p2[512];

    if (!risolvi(da, p1, sizeof p1) || !risolvi(a, p2, sizeof p2))
        return ORION_ERR_PERMISSION;
    return (rename(p1, p2) == 0) ? ORION_OK : ORION_ERR_FILE;
}

static orion_result_t fs_make_dir(const char *path)
{
    char pc[512];

    if (!risolvi(path, pc, sizeof pc)) return ORION_ERR_PERMISSION;
    mkdir_p(pc);
    (void)mkdir(pc, 0755);
    return ORION_OK;
}

/* list() works by index, as on the device, reopening the folder on each
   call. */
static char nome_ultimo[256];

static bool fs_list(const char *dir, int i, orion_entry_t *out)
{
    char           pc[512];
    DIR           *d;
    struct dirent *e;
    int            n = 0;

    if ((out == NULL) || !risolvi(dir, pc, sizeof pc)) return false;
    d = opendir(pc);
    if (d == NULL) return false;

    while ((e = readdir(d)) != NULL)
    {
        char        full[1024];
        struct stat st;

        if (e->d_name[0] == '.') continue;
        if (n++ != i) continue;

        snprintf(full, sizeof full, "%s/%s", pc, e->d_name);
        snprintf(nome_ultimo, sizeof nome_ultimo, "%s", e->d_name);
        out->name     = nome_ultimo;
        out->is_dir   = (stat(full, &st) == 0) && ((st.st_mode & S_IFDIR) != 0);
        out->size     = (stat(full, &st) == 0) ? (int)st.st_size : 0;
        out->modified = (stat(full, &st) == 0) ? (uint32_t)st.st_mtime : 0u;
        closedir(d);
        return true;
    }
    closedir(d);
    return false;
}

static int fs_read_all(const char *path, void *buf, int n)
{
    orion_file_t *f = fs_open(path, ORION_READ);
    int           letti;

    if (f == NULL) return -1;
    letti = fs_read(f, buf, n);
    (void)fs_close(f);
    return letti;
}

static orion_result_t fs_write_all(const char *path, const void *buf, int n)
{
    orion_file_t *f = fs_open(path, ORION_WRITE);
    int           scritti;

    if (f == NULL) return ORION_ERR_PERMISSION;
    scritti = fs_write(f, buf, n);
    (void)fs_close(f);
    return (scritti == n) ? ORION_OK : ORION_ERR_FILE;
}

static int64_t fs_free_space(void) { return (int64_t)1024 * 1024 * 1024; }

const orion_fs_t ORION_FS = {
    .open = fs_open, .read = fs_read, .write = fs_write, .close = fs_close,
    .remove = fs_remove, .rename = fs_rename,
    .exists = fs_exists, .size = fs_size,
    .list = fs_list, .make_dir = fs_make_dir,
    .read_all = fs_read_all, .write_all = fs_write_all,
    .free_space = fs_free_space,
};


/* ==========================================================================
 *  The three FatFs calls app_lua.c uses to read the script. No sandbox
 *  here: the path comes from the launcher, not from the app.
 * ========================================================================== */
#include "ff.h"

FRESULT f_open(FIL *f, const char *path, unsigned char mode)
{
    char pc[768];

    (void)mode;
    snprintf(pc, sizeof pc, "%s/%s", emu_radice,
             (path[0] == '/') ? &path[1] : path);
    f->fp = fopen(pc, "rb");
    return (f->fp != NULL) ? FR_OK : FR_NO_FILE;
}

FRESULT f_read(FIL *f, void *buf, UINT n, UINT *letti)
{
    if ((f == NULL) || (f->fp == NULL)) return FR_DISK_ERR;
    *letti = (UINT)fread(buf, 1, n, f->fp);
    return FR_OK;
}

FRESULT f_close(FIL *f)
{
    if ((f != NULL) && (f->fp != NULL)) { fclose(f->fp); f->fp = NULL; }
    return FR_OK;
}

/* close files the app left open */
void orion_fs_chiudi_tutto(void)
{
    for (int i = 0; i < 8; i++)
        if (aperti[i].f != NULL) { fclose(aperti[i].f); aperti[i].f = NULL; }
}
