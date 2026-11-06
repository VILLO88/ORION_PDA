/**
 * @file    orion_lua_bind.c
 * @brief   The app API as seen from Lua.
 *
 * Follows orion_api.h and adds no behaviour of its own. The conventions:
 * one global `orion`; output parameters become return values; enums become
 * strings; keys are in `orion.K`; errors are `nil` plus a message.
 */

#include "orion_api.h"
#include "lua.h"
#include "lauxlib.h"
#include <string.h>
#include <math.h>

static const orion_api_t *o;   /* the API vtable, set by orion_lua_bind() */

/* ==========================================================================
 *  Graphics
 * ========================================================================== */

/* Coordinates may have a fraction (a ball moving 3.5 px per frame) and are
   rounded down, not truncated, so -0.5 becomes -1 and not 0. */
static int coord(lua_State *Ls, int i)
{
    const lua_Number v = luaL_checknumber(Ls, i);

    return (int)floor((double)v);
}

static int coord_opt(lua_State *Ls, int i, int dflt)
{
    if (lua_isnoneornil(Ls, i)) return dflt;
    return coord(Ls, i);
}

static int l_clear(lua_State *L)
{
    o->gfx->clear((uint8_t)luaL_optinteger(L, 1, ORION_WHITE));
    return 0;
}

static int l_pixel(lua_State *L)
{
    o->gfx->pixel(coord(L, 1), coord(L, 2),
                  (uint8_t)luaL_optinteger(L, 3, ORION_BLACK));
    return 0;
}

static int l_line(lua_State *L)
{
    o->gfx->line(coord(L, 1), coord(L, 2),
                 coord(L, 3), coord(L, 4),
                 (uint8_t)luaL_optinteger(L, 5, ORION_BLACK));
    return 0;
}

static int l_rect(lua_State *L)
{
    o->gfx->rect(coord(L, 1), coord(L, 2),
                 coord(L, 3), coord(L, 4),
                 (uint8_t)luaL_optinteger(L, 5, ORION_BLACK));
    return 0;
}

static int l_fill_rect(lua_State *L)
{
    o->gfx->fill_rect(coord(L, 1), coord(L, 2),
                      coord(L, 3), coord(L, 4),
                      (uint8_t)luaL_optinteger(L, 5, ORION_BLACK));
    return 0;
}

static int l_text(lua_State *L)
{
    o->gfx->text(coord(L, 1), coord(L, 2),
                 luaL_checkstring(L, 3),
                 (uint8_t)luaL_optinteger(L, 4, ORION_BLACK),
                 coord_opt(L, 5, 1));
    return 0;
}

static int l_text_width(lua_State *L)
{
    lua_pushinteger(L, o->gfx->text_width(luaL_checkstring(L, 1),
                                          (int)luaL_optinteger(L, 2, 1)));
    return 1;
}

/* Fonts reach Lua as light userdata: opaque values that can only be passed
   back to the API. */
static int l_system_font(lua_State *L)
{
    lua_pushlightuserdata(L, (void *)o->gfx->system_font((int)luaL_optinteger(L, 1, 0)));
    return 1;
}

static int l_set_font(lua_State *L)
{
    o->gfx->set_font((const orion_font_t *)lua_touserdata(L, 1));
    return 0;
}

static int l_font_metrics(lua_State *L)
{
    /* zeroed, in case the implementation writes nothing */
    orion_font_metrics_t m = { 0, 0, 0, 0 };

    o->gfx->font_metrics((const orion_font_t *)lua_touserdata(L, 1), &m);

    lua_newtable(L);
    lua_pushinteger(L, m.cell_w);    lua_setfield(L, -2, "cell_w");
    lua_pushinteger(L, m.cell_h);    lua_setfield(L, -2, "cell_h");
    lua_pushinteger(L, m.advance_w); lua_setfield(L, -2, "advance_w");
    lua_pushinteger(L, m.advance_h); lua_setfield(L, -2, "advance_h");
    return 1;
}

/* return the result, like present_area */
static int l_present(lua_State *L)
{
    lua_pushboolean(L, o->gfx->present());
    return 1;
}

static int l_present_area(lua_State *L)
{
    lua_pushboolean(L, o->gfx->present_area(coord(L, 1), coord(L, 2),
                         coord(L, 3), coord(L, 4)));
    return 1;
}

static int l_set_clip(lua_State *L)
{
    o->gfx->set_clip(coord(L, 1), coord(L, 2),
                     coord(L, 3), coord(L, 4));
    return 0;
}

static int l_clear_clip(lua_State *L)   { (void)L; o->gfx->clear_clip(); return 0; }

/* ==========================================================================
 *  Input
 * ========================================================================== */
static void spingi_evento(lua_State *L, const orion_event_t *ev)
{
    lua_newtable(L);
    lua_pushstring(L, (ev->kind == ORION_KEY_DOWN) ? "down" : "up");
    lua_setfield(L, -2, "kind");
    lua_pushinteger(L, ev->key);   lua_setfield(L, -2, "key");

    /* ch is a one-character string, absent when the key produces none. */
    if (ev->ch != 0U)
    {
        const char c = (char)ev->ch;

        lua_pushlstring(L, &c, 1); lua_setfield(L, -2, "ch");
    }
    lua_pushboolean(L, ev->shift); lua_setfield(L, -2, "shift");
    lua_pushboolean(L, ev->fn);    lua_setfield(L, -2, "fn");
    lua_pushinteger(L, ev->ms);    lua_setfield(L, -2, "ms");
}

static int l_read(lua_State *L)
{
    orion_event_t ev;

    if (!o->input->read(&ev)) { lua_pushnil(L); return 1; }
    spingi_evento(L, &ev);
    return 1;
}

/* the iterator for `for ev in orion.input.events() do` */
static int l_events_iter(lua_State *L)  { return l_read(L); }
static int l_events(lua_State *L)       { lua_pushcfunction(L, l_events_iter); return 1; }

static int l_is_down(lua_State *L)
{
    lua_pushboolean(L, o->input->is_down((uint8_t)luaL_checkinteger(L, 1)));
    return 1;
}

/* ==========================================================================
 *  Files
 * ==========================================================================
 * A file is an object with methods (f:read, f:write, f:close). A missing
 * file is not an exception: functions return nil and a reason.
 */
#define MT_FILE   "orion.file"

typedef struct { orion_file_t *h; } file_box_t;

static file_box_t *box(lua_State *L)
{
    return (file_box_t *)luaL_checkudata(L, 1, MT_FILE);
}

static int l_f_read(lua_State *L)
{
    file_box_t *b = box(L);
    /* no argument: read everything that is left */
    const int   quanti = (int)luaL_optinteger(L, 2, 65536);
    char        buf[256];   /* small, it is on the stack */
    luaL_Buffer lb;
    int         tot = 0;

    if (b->h == NULL) { lua_pushnil(L); lua_pushstring(L, "file closed"); return 2; }

    luaL_buffinit(L, &lb);
    while (tot < quanti)
    {
        const int voluti = ((quanti - tot) < (int)sizeof buf) ? (quanti - tot)
                                                              : (int)sizeof buf;
        const int letti  = o->fs->read(b->h, buf, voluti);

        if (letti <= 0) break;
        luaL_addlstring(&lb, buf, (size_t)letti);
        tot += letti;
    }
    luaL_pushresult(&lb);
    if (tot == 0) { lua_pop(L, 1); lua_pushnil(L); }
    return 1;
}

static int l_f_write(lua_State *L)
{
    file_box_t *b = box(L);
    size_t      n = 0U;
    const char *s = luaL_checklstring(L, 2, &n);
    int         fatti;

    if (b->h == NULL) { lua_pushnil(L); lua_pushstring(L, "file closed"); return 2; }

    fatti = o->fs->write(b->h, s, (int)n);
    if (fatti < 0)
    {
        lua_pushnil(L);
        lua_pushstring(L, (fatti == ORION_ERR_NO_SPACE) ? "card full"
                                                        : "write failed");
        return 2;
    }
    lua_pushinteger(L, fatti);
    return 1;
}

static int l_f_close(lua_State *L)
{
    file_box_t *b = box(L);

    if (b->h != NULL) { (void)o->fs->close(b->h); b->h = NULL; }
    return 0;
}

static int l_fs_open(lua_State *L)
{
    const char  *path = luaL_checkstring(L, 1);
    const char  *m    = luaL_optstring(L, 2, "read");
    orion_mode_t modo;
    orion_file_t *h;
    file_box_t   *b;

    /* Lua's short modes are accepted too; an unknown mode is an error here,
       rather than a file opened for reading whose first write fails. */
    if      ((strcmp(m, "read") == 0)   || (strcmp(m, "r") == 0) || (strcmp(m, "rb") == 0)) modo = ORION_READ;
    else if ((strcmp(m, "write") == 0)  || (strcmp(m, "w") == 0) || (strcmp(m, "wb") == 0)) modo = ORION_WRITE;
    else if ((strcmp(m, "append") == 0) || (strcmp(m, "a") == 0) || (strcmp(m, "ab") == 0)) modo = ORION_APPEND;
    else
    {
        lua_pushnil(L);
        lua_pushfstring(L, "unknown mode '%s': use \"read\", \"write\" or \"append\"", m);
        return 2;
    }

    h = o->fs->open(path, modo);
    if (h == NULL)
    {
        lua_pushnil(L);
        lua_pushfstring(L, "cannot open %s", path);
        return 2;
    }

    b = (file_box_t *)lua_newuserdatauv(L, sizeof(file_box_t), 0);
    b->h = h;
    luaL_setmetatable(L, MT_FILE);
    return 1;
}

/* Whole files up to 64 KB, read into a Lua string of the right size.
   Past that the Lua heap (~95 KB) would run out anyway, so say so. */
#define READ_ALL_MAX  (64 * 1024)

static int l_fs_read_all(lua_State *L)
{
    const char *path = luaL_checkstring(L, 1);
    const int   size = o->fs->size(path);
    luaL_Buffer b;
    char       *p;
    int         n;

    if (size < 0) { lua_pushnil(L); lua_pushstring(L, "file not found"); return 2; }
    if (size == 0) { lua_pushliteral(L, ""); return 1; }
    if (size > READ_ALL_MAX)
    {
        lua_pushnil(L);
        lua_pushfstring(L, "file too large for read_all (%d bytes, max %d): "
                           "read it with open or orion.mem", size, READ_ALL_MAX);
        return 2;
    }

    p = luaL_buffinitsize(L, &b, (size_t)size);
    n = o->fs->read_all(path, p, size);
    if (n < 0)
    {
        luaL_pushresultsize(&b, 0U);
        lua_pop(L, 1);
        lua_pushnil(L);
        lua_pushstring(L, "cannot read");
        return 2;
    }
    luaL_pushresultsize(&b, (size_t)n);
    return 1;
}

static int l_fs_write_all(lua_State *L)
{
    size_t      n = 0U;
    const char *s = luaL_checklstring(L, 2, &n);
    const orion_result_t r = o->fs->write_all(luaL_checkstring(L, 1), s, (int)n);

    if (r != ORION_OK)
    {
        lua_pushnil(L);
        lua_pushstring(L, (r == ORION_ERR_NO_SPACE) ? "card full"
                                                    : "cannot write");
        return 2;
    }
    lua_pushboolean(L, 1);
    return 1;
}

static int l_fs_exists(lua_State *L)
{
    lua_pushboolean(L, o->fs->exists(luaL_checkstring(L, 1)));
    return 1;
}

static int l_fs_size(lua_State *L)
{
    const int n = o->fs->size(luaL_checkstring(L, 1));

    if (n < 0) { lua_pushnil(L); return 1; }
    lua_pushinteger(L, n);
    return 1;
}

static int l_fs_remove(lua_State *L)
{
    lua_pushboolean(L, o->fs->remove(luaL_checkstring(L, 1)) == ORION_OK);
    return 1;
}

static int l_fs_rename(lua_State *L)
{
    lua_pushboolean(L, o->fs->rename(luaL_checkstring(L, 1),
                                     luaL_checkstring(L, 2)) == ORION_OK);
    return 1;
}

static int l_fs_make_dir(lua_State *L)
{
    lua_pushboolean(L, o->fs->make_dir(luaL_checkstring(L, 1)) == ORION_OK);
    return 1;
}

static int l_fs_free_space(lua_State *L)
{
    lua_pushinteger(L, (lua_Integer)o->fs->free_space());
    return 1;
}

/* the iterator for `for e in orion.fs.list(dir) do` */
static int l_fs_list_iter(lua_State *L)
{
    const char   *dir = lua_tostring(L, lua_upvalueindex(1));
    const int     i   = (int)lua_tointeger(L, lua_upvalueindex(2));
    orion_entry_t e;

    if (!o->fs->list(dir, i, &e)) { lua_pushnil(L); return 1; }

    lua_pushinteger(L, i + 1);
    lua_replace(L, lua_upvalueindex(2));

    lua_newtable(L);
    lua_pushstring(L, e.name);        lua_setfield(L, -2, "name");
    lua_pushboolean(L, e.is_dir);     lua_setfield(L, -2, "is_dir");
    lua_pushinteger(L, e.size);       lua_setfield(L, -2, "size");
    lua_pushinteger(L, e.modified);   lua_setfield(L, -2, "modified");
    return 1;
}

static int l_fs_list(lua_State *L)
{
    lua_pushvalue(L, 1);
    lua_pushinteger(L, 0);
    lua_pushcclosure(L, l_fs_list_iter, 2);
    return 1;
}

/* ==========================================================================
 *  Preferences
 * ========================================================================== */
static int l_pref_get(lua_State *L)
{
    const char *chiave = luaL_checkstring(L, 1);

    /* One function for numbers and strings: the default decides the type. */
    if (lua_isnumber(L, 2))
    {
        lua_pushinteger(L, o->pref->get_int(chiave, (int)lua_tointeger(L, 2)));
    }
    else
    {
        char s[128];

        (void)o->pref->get_str(chiave, s, sizeof s, luaL_optstring(L, 2, ""));
        lua_pushstring(L, s);
    }
    return 1;
}

static int l_pref_set(lua_State *L)
{
    const char *chiave = luaL_checkstring(L, 1);

    if (lua_isnumber(L, 2)) o->pref->set_int(chiave, (int)lua_tointeger(L, 2));
    else                    o->pref->set_str(chiave, luaL_checkstring(L, 2));
    return 0;
}

/* ==========================================================================
 *  Sound and microphone
 * ==========================================================================
 * generate() from the C API is not available: its callback runs in an
 * interrupt, where Lua cannot be called.
 */
static int l_au_play(lua_State *L)
{
    const orion_result_t r = o->audio->play_file(luaL_checkstring(L, 1));

    if (r != ORION_OK)
    {
        lua_pushnil(L);
        lua_pushstring(L, (r == ORION_ERR_BUSY)
                          ? "audio busy (recording or video?)"
                          : "cannot play that file");
        return 2;
    }
    lua_pushboolean(L, 1);
    return 1;
}

static int l_au_stop(lua_State *L)       { (void)L; (void)o->audio->stop(); return 0; }
static int l_au_playing(lua_State *L)    { lua_pushboolean(L, o->audio->is_playing()); return 1; }
static int l_au_position(lua_State *L)   { lua_pushinteger(L, o->audio->position_ms()); return 1; }
static int l_au_duration(lua_State *L)   { lua_pushinteger(L, o->audio->duration_ms()); return 1; }
static int l_au_bluetooth(lua_State *L)  { lua_pushboolean(L, o->audio->is_bluetooth()); return 1; }

static int l_au_volume(lua_State *L)
{
    lua_pushboolean(L, o->audio->set_volume((int)luaL_checkinteger(L, 1)) == ORION_OK);
    return 1;
}

/* nil plus a reason rather than -1, so the failure shows where the file
   was loaded and not at the first sfx_play. */
static int l_au_sfx_load(lua_State *L)
{
    const int id = o->audio->sfx_load(luaL_checkstring(L, 1));

    if (id < 0)
    {
        lua_pushnil(L);
        lua_pushstring(L, "sound not loaded: missing, not a 48 kHz 16-bit WAV, "
                          "or out of memory");
        return 2;
    }
    lua_pushinteger(L, id);
    return 1;
}

static int l_au_sfx_play(lua_State *L)
{
    const int id  = (int)luaL_checkinteger(L, 1);
    const int vol = (int)luaL_optinteger(L, 2, 255);

    lua_pushboolean(L, o->audio->sfx_play(id, vol));
    return 1;
}

static int l_au_sfx_free(lua_State *L)
{
    o->audio->sfx_free((int)luaL_checkinteger(L, 1));
    return 0;
}

static int l_au_sfx_stop(lua_State *L) { (void)L; o->audio->sfx_stop(); return 0; }

static int l_mi_rec(lua_State *L)
{
    const char *path = luaL_checkstring(L, 1);
    const char *src  = luaL_optstring(L, 2, "internal");
    const orion_result_t r =
        o->mic->rec_file(path, (strcmp(src, "headset") == 0) ? ORION_MIC_HEADSET
                                                             : ORION_MIC_INTERNAL);

    if (r != ORION_OK)
    {
        lua_pushnil(L);
        lua_pushstring(L, "cannot record (busy, or no headset?)");
        return 2;
    }
    lua_pushboolean(L, 1);
    return 1;
}

static int l_mi_stop(lua_State *L)     { (void)L; (void)o->mic->rec_stop(); return 0; }
static int l_mi_recording(lua_State *L){ lua_pushboolean(L, o->mic->is_recording()); return 1; }
static int l_mi_seconds(lua_State *L)  { lua_pushinteger(L, o->mic->rec_seconds()); return 1; }
static int l_mi_gain(lua_State *L)
{
    lua_pushboolean(L, o->mic->set_gain((int)luaL_checkinteger(L, 1)) == ORION_OK);
    return 1;
}

static int l_mi_level(lua_State *L)
{
    const int v = o->mic->level();

    /* -1 means "not listening": nil in Lua */
    if (v < 0) lua_pushnil(L); else lua_pushinteger(L, v);
    return 1;
}

static int l_mi_listen(lua_State *L)
{
    const char *src = luaL_optstring(L, 1, "internal");
    const int   hz  = (int)luaL_optinteger(L, 2, 8000);
    const orion_result_t r =
        o->mic->listen((strcmp(src, "headset") == 0) ? ORION_MIC_HEADSET
                                                     : ORION_MIC_INTERNAL, hz);

    if (r != ORION_OK)
    {
        lua_pushnil(L);
        /* the two usual reasons */
        lua_pushstring(L, "listen refused: hz must divide 48000, "
                          "and the microphone must not be recording");
        return 2;
    }
    lua_pushboolean(L, 1);
    return 1;
}

static int l_mi_listen_stop(lua_State *L) { (void)L; (void)o->mic->listen_stop(); return 0; }

static int l_mi_rate(lua_State *L) { lua_pushinteger(L, o->mic->rate()); return 1; }

/* Samples as a table of numbers, because apps do arithmetic on them.
 * At most 512 per call: 64 ms at 8 kHz, enough for a guitar note. */
static int l_mi_read(lua_State *L)
{
    /* Read in pieces of 64: a 1 KB array on the stack, at the bottom of
       the Lua call chain, is too much. */
    int16_t   pezzo[64];
    const int tetto  = 512;
    int       voluti = (int)luaL_optinteger(L, 1, 256);
    int       tot    = 0;

    if (voluti > tetto) voluti = tetto;
    if (voluti < 0)     voluti = 0;

    lua_createtable(L, voluti, 0);
    while (tot < voluti)
    {
        const int n = ((voluti - tot) < (int)(sizeof pezzo / sizeof pezzo[0]))
                        ? (voluti - tot)
                        : (int)(sizeof pezzo / sizeof pezzo[0]);
        const int letti = o->mic->read_pcm(pezzo, n);

        if (letti <= 0) break;      /* ring empty: return what there is */
        for (int i = 0; i < letti; i++)
        {
            lua_pushinteger(L, pezzo[i]);
            lua_rawseti(L, -2, tot + i + 1);
        }
        tot += letti;
    }
    return 1;
}

/* ==========================================================================
 *  System
 * ========================================================================== */
static int l_ms(lua_State *L)          { lua_pushinteger(L, o->sys->ms()); return 1; }
static int l_battery(lua_State *L)     { lua_pushinteger(L, o->sys->battery()); return 1; }
static int l_is_charging(lua_State *L) { lua_pushboolean(L, o->sys->is_charging()); return 1; }
static int l_version(lua_State *L)     { lua_pushstring(L, o->sys->version()); return 1; }
static int l_exit(lua_State *L)        { (void)L; o->sys->exit(); return 0; }

static int l_date_time(lua_State *L)
{
    int a, me, g, h, mi, s;

    o->sys->date_time(&a, &me, &g, &h, &mi, &s);
    lua_pushinteger(L, a);  lua_pushinteger(L, me); lua_pushinteger(L, g);
    lua_pushinteger(L, h);  lua_pushinteger(L, mi); lua_pushinteger(L, s);
    return 6;
}

static int l_content_area(lua_State *L)
{
    int x, y, w, h;

    o->sys->content_area(&x, &y, &w, &h);
    lua_pushinteger(L, x); lua_pushinteger(L, y);
    lua_pushinteger(L, w); lua_pushinteger(L, h);
    return 4;
}

static int l_log(lua_State *L)
{
    o->sys->log("%s", luaL_checkstring(L, 1));
    return 0;
}

/* ==========================================================================
 *  Registration
 * ========================================================================== */
/* luaL_newlib() needs an array, not a pointer: count the entries here. */
static void tabella(lua_State *L, const char *nome, const luaL_Reg *f)
{
    int n = 0;

    while (f[n].name != NULL) n++;
    lua_createtable(L, 0, n);
    luaL_setfuncs(L, f, 0);
    lua_setfield(L, -2, nome);
}


/* ==========================================================================
 *  Images
 * ========================================================================== */
#define MT_IMG  "orion.image"

typedef struct { orion_bitmap_t *b; } img_box_t;

static img_box_t *ibox(lua_State *Ls)
{
    return (img_box_t *)luaL_checkudata(Ls, 1, MT_IMG);
}

static int l_img_size(lua_State *Ls)
{
    img_box_t *x = ibox(Ls);
    int        w = 0, h = 0;

    if (x->b != NULL) o->gfx->bitmap_size(x->b, &w, &h);
    lua_pushinteger(Ls, w); lua_pushinteger(Ls, h);
    return 2;
}

static int l_img_draw(lua_State *Ls)
{
    img_box_t *x = ibox(Ls);

    if (x->b != NULL)
        o->gfx->bitmap_draw(coord(Ls, 2), coord(Ls, 3), x->b);
    return 0;
}

static int l_img_free(lua_State *Ls)
{
    img_box_t *x = ibox(Ls);

    if (x->b != NULL) { o->gfx->bitmap_free(x->b); x->b = NULL; }
    return 0;
}

static const luaL_Reg IMGMT[] = {
    {"size", l_img_size}, {"draw", l_img_draw}, {"free", l_img_free},
    {NULL, NULL}
};

/* Returns nil and a message on failure, like the other loaders. */
static int l_gfx_image(lua_State *Ls)
{
    const char     *path = luaL_checkstring(Ls, 1);
    orion_bitmap_t *b;
    img_box_t      *x;

    if (o->gfx->bitmap_load == NULL)
    {
        lua_pushnil(Ls);
        lua_pushstring(Ls, "images are not available in this firmware");
        return 2;
    }

    b = o->gfx->bitmap_load(path);
    if (b == NULL)
    {
        lua_pushnil(Ls);
        lua_pushstring(Ls, "not loaded: path outside the sandbox, "
                           "missing file, not an .obm, or out of memory");
        return 2;
    }

    x    = (img_box_t *)lua_newuserdatauv(Ls, sizeof(img_box_t), 0);
    x->b = b;
    luaL_setmetatable(Ls, MT_IMG);
    return 1;
}

/* The common patterns by name: ordered and symmetric, so 50% is a
   checkerboard and not lines. */
static const struct { const char *nome; uint8_t pat[8]; } RETINI[] = {
    /* 1 = white, fewer bits = darker */
    { "black",   { 0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00 } },
    { "dark",    { 0x88,0x00,0x22,0x00,0x88,0x00,0x22,0x00 } },  /* 1 white in 8 */
    { "gray",    { 0xAA,0x55,0xAA,0x55,0xAA,0x55,0xAA,0x55 } },  /* checkerboard */
    { "light",   { 0x77,0xFF,0xDD,0xFF,0x77,0xFF,0xDD,0xFF } },  /* 1 black in 8 */
    { "white",   { 0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF } },
    { "hlines",  { 0xFF,0x00,0xFF,0x00,0xFF,0x00,0xFF,0x00 } },
    { "vlines",  { 0xAA,0xAA,0xAA,0xAA,0xAA,0xAA,0xAA,0xAA } },
    { "grid",    { 0xFF,0xAA,0xFF,0xAA,0xFF,0xAA,0xFF,0xAA } },
};

/* set_pattern(name), set_pattern({8 bytes}) or set_pattern(nil) for solid. */
static int l_set_pattern(lua_State *Ls)
{
    uint8_t pat[8];

    if (lua_isnoneornil(Ls, 1)) { o->gfx->set_pattern(NULL); return 0; }

    if (lua_type(Ls, 1) == LUA_TSTRING)
    {
        const char *n = lua_tostring(Ls, 1);

        for (size_t i = 0; i < (sizeof RETINI / sizeof RETINI[0]); i++)
        {
            if (strcmp(n, RETINI[i].nome) == 0)
            {
                o->gfx->set_pattern(RETINI[i].pat);
                return 0;
            }
        }
        return luaL_error(Ls, "unknown pattern: %s", n);
    }

    luaL_checktype(Ls, 1, LUA_TTABLE);
    for (int i = 0; i < 8; i++)
    {
        lua_rawgeti(Ls, 1, i + 1);
        pat[i] = (uint8_t)luaL_optinteger(Ls, -1, 0xFF);
        lua_pop(Ls, 1);
    }
    o->gfx->set_pattern(pat);
    return 0;
}

static const luaL_Reg GFX[] = {
    {"clear", l_clear}, {"pixel", l_pixel}, {"line", l_line},
    {"rect", l_rect},   {"fill_rect", l_fill_rect},
    {"set_pattern", l_set_pattern},
    {"text", l_text},   {"text_width", l_text_width},
    {"system_font", l_system_font}, {"set_font", l_set_font},
    {"font_metrics", l_font_metrics},
    {"image", l_gfx_image},
    {"present", l_present}, {"present_area", l_present_area},
    {"set_clip", l_set_clip}, {"clear_clip", l_clear_clip},
    {NULL, NULL}
};

static const luaL_Reg INPUT[] = {
    {"read", l_read}, {"events", l_events}, {"is_down", l_is_down},
    {NULL, NULL}
};

static const luaL_Reg FS[] = {
    {"open", l_fs_open}, {"read_all", l_fs_read_all}, {"write_all", l_fs_write_all},
    {"exists", l_fs_exists}, {"size", l_fs_size}, {"remove", l_fs_remove},
    {"rename", l_fs_rename}, {"make_dir", l_fs_make_dir},
    {"list", l_fs_list}, {"free_space", l_fs_free_space},
    {NULL, NULL}
};

static const luaL_Reg PREF[] = {
    {"get", l_pref_get}, {"set", l_pref_set},
    {NULL, NULL}
};

static const luaL_Reg FILEMT[] = {
    {"read", l_f_read}, {"write", l_f_write}, {"close", l_f_close},
    {NULL, NULL}
};

static const luaL_Reg AUDIO[] = {
    {"play_file", l_au_play}, {"stop", l_au_stop}, {"is_playing", l_au_playing},
    {"set_volume", l_au_volume}, {"position_ms", l_au_position},
    {"duration_ms", l_au_duration}, {"is_bluetooth", l_au_bluetooth},
    {"sfx_load", l_au_sfx_load}, {"sfx_play", l_au_sfx_play},
    {"sfx_free", l_au_sfx_free}, {"sfx_stop", l_au_sfx_stop},
    {NULL, NULL}
};

/* ==========================================================================
 *  Maths
 * ==========================================================================
 * Only what the chip does better than Lua's math library.
 */
static int l_mt_sincos(lua_State *L)
{
    float s = 0.0f, c = 0.0f;

    o->math->sincos((float)luaL_checknumber(L, 1), &s, &c);
    /* sine and cosine together, the coprocessor computes both */
    lua_pushnumber(L, (lua_Number)s);
    lua_pushnumber(L, (lua_Number)c);
    return 2;
}

static int l_mt_atan2(lua_State *L)
{
    lua_pushnumber(L, (lua_Number)o->math->atan2((float)luaL_checknumber(L, 1),
                                                 (float)luaL_checknumber(L, 2)));
    return 1;
}

static int l_mt_dist(lua_State *L)
{
    lua_pushnumber(L, (lua_Number)o->math->dist((float)luaL_checknumber(L, 1),
                                                (float)luaL_checknumber(L, 2)));
    return 1;
}

static const luaL_Reg MATH[] = {
    {"sincos", l_mt_sincos}, {"atan2", l_mt_atan2}, {"dist", l_mt_dist},
    {NULL, NULL}
};

static const luaL_Reg MIC[] = {
    {"rec_file", l_mi_rec}, {"rec_stop", l_mi_stop},
    {"is_recording", l_mi_recording}, {"rec_seconds", l_mi_seconds},
    {"set_gain", l_mi_gain}, {"level", l_mi_level},
    {"listen", l_mi_listen}, {"listen_stop", l_mi_listen_stop},
    {"read", l_mi_read}, {"rate", l_mi_rate},
    {NULL, NULL}
};


/* ==========================================================================
 *  Dialogs
 * ==========================================================================
 * orion_ui.c answers with a callback. The Lua function opens the dialog and
 * yields; app_lua.c resumes the coroutine with the answer, so for the app
 * `local ok = orion.ui.confirm("...")` simply returns.
 */
#define SCELTA_MAX_N  16
#define SCELTA_MAX_L  32

static bool ui_pronta = false;
static int  ui_kind   = 0;          /* 1 yes/no, 2 text, 3 choice */
static bool ui_si     = false;
static bool ui_annull = false;
static char ui_testo[64];
static int  ui_indice = -1;

/* copied: the dialog outlives the Lua strings */
static char        scelta_buf[SCELTA_MAX_N][SCELTA_MAX_L];
static const char *scelta_ptr[SCELTA_MAX_N];

static void cb_si(bool yes, void *c)
{
    (void)c; ui_kind = 1; ui_si = yes; ui_pronta = true;
}
static void cb_testo(const char *t, void *c)
{
    (void)c; ui_kind = 2; ui_annull = (t == NULL);
    if (t != NULL) snprintf(ui_testo, sizeof ui_testo, "%s", t);
    ui_pronta = true;
}
static void cb_scelta(int i, void *c)
{
    (void)c; ui_kind = 3; ui_indice = i; ui_pronta = true;
}

bool orion_lua_ui_pronta(void) { return ui_pronta; }

int orion_lua_ui_spingi(lua_State *Ls)
{
    ui_pronta = false;
    switch (ui_kind)
    {
        case 1: lua_pushboolean(Ls, ui_si); break;
        case 2: if (ui_annull) lua_pushnil(Ls);
                else           lua_pushstring(Ls, ui_testo);
                break;
        /* 1-based index for Lua; cancel stays nil. */
        case 3: if (ui_indice < 0) lua_pushnil(Ls);
                else               lua_pushinteger(Ls, ui_indice + 1);
                break;
        default: lua_pushnil(Ls); break;
    }
    return 1;
}

/* continuation: the answer is already on the stack */
static int ui_ripresa(lua_State *Ls, int status, lua_KContext kc)
{
    (void)Ls; (void)status; (void)kc;
    return 1;
}

static int l_ui_confirm(lua_State *Ls)
{
    o->ui->confirm(luaL_checkstring(Ls, 1), cb_si, NULL);
    return lua_yieldk(Ls, 0, 0, ui_ripresa);
}

static int l_ui_ask_text(lua_State *Ls)
{
    o->ui->ask_text(luaL_checkstring(Ls, 1),
                    luaL_optstring(Ls, 2, ""), cb_testo, NULL);
    return lua_yieldk(Ls, 0, 0, ui_ripresa);
}

static int l_ui_choose(lua_State *Ls)
{
    const char *tit = luaL_checkstring(Ls, 1);
    int         n, i;

    luaL_checktype(Ls, 2, LUA_TTABLE);
    n = (int)luaL_len(Ls, 2);
    if (n > SCELTA_MAX_N) n = SCELTA_MAX_N;

    for (i = 0; i < n; i++)
    {
        const char *v;

        lua_rawgeti(Ls, 2, i + 1);
        v = lua_tostring(Ls, -1);
        snprintf(scelta_buf[i], SCELTA_MAX_L, "%s", (v != NULL) ? v : "?");
        lua_pop(Ls, 1);
        scelta_ptr[i] = scelta_buf[i];
    }

    o->ui->choose(tit, scelta_ptr, n, cb_scelta, NULL);
    return lua_yieldk(Ls, 0, 0, ui_ripresa);
}

/* notice() yields too, so the app always redraws after any dialog. */
static int l_ui_notice(lua_State *Ls)
{
    o->ui->notice(luaL_checkstring(Ls, 1));
    return lua_yieldk(Ls, 0, 0, ui_ripresa);
}

static const luaL_Reg UI[] = {
    {"confirm", l_ui_confirm}, {"ask_text", l_ui_ask_text},
    {"choose",  l_ui_choose},  {"notice",   l_ui_notice},
    {NULL, NULL}
};


/* ==========================================================================
 *  Memory blocks
 * ==========================================================================
 * A pointer means nothing in Lua and byte-by-byte access to PSRAM is slow,
 * so a block is an object that moves data in large pieces:
 *
 *     local b = orion.mem.alloc(2 * 1024 * 1024)
 *     b:load("data/track.raw")          -- file to block, without Lua strings
 *     local s = b:read(0, 512)          -- a piece, as a string
 *     b:free()
 */
#define MT_MEM  "orion.mem"

/* Transit buffer between card and block. Static, too big for the stack;
   16 KB pieces, because pieces smaller than a sector make FatFs read,
   modify and write the sector on every call. */
#define TRANSITO  (16U * 1024U)
static uint8_t transito[TRANSITO];

typedef struct { uint8_t *p; uint32_t n; } mem_box_t;

static mem_box_t *mbox(lua_State *Ls)
{
    return (mem_box_t *)luaL_checkudata(Ls, 1, MT_MEM);
}

/* bounds checked here: a wrong offset into PSRAM gives no error */
static bool estremi(lua_State *Ls, const mem_box_t *b, lua_Integer off,
                    lua_Integer n)
{
    if (b->p == NULL)                         { lua_pushnil(Ls); lua_pushstring(Ls, "block freed");   return false; }
    if ((off < 0) || (n < 0))                 { lua_pushnil(Ls); lua_pushstring(Ls, "negative offset");   return false; }
    if (((lua_Integer)b->n - off) < n)        { lua_pushnil(Ls); lua_pushstring(Ls, "outside the block");  return false; }
    return true;
}

static int l_m_size(lua_State *Ls)
{
    lua_pushinteger(Ls, mbox(Ls)->n); return 1;
}

static int l_m_is_fast(lua_State *Ls)
{
    const mem_box_t *b = mbox(Ls);

    lua_pushboolean(Ls, (b->p != NULL) && o->mem->is_fast(b->p));
    return 1;
}

static int l_m_free(lua_State *Ls)
{
    mem_box_t *b = mbox(Ls);

    if (b->p != NULL) { o->mem->free(b->p); b->p = NULL; b->n = 0U; }
    return 0;
}

static int l_m_write(lua_State *Ls)
{
    mem_box_t  *b   = mbox(Ls);
    lua_Integer off = luaL_checkinteger(Ls, 2);
    size_t      n   = 0U;
    const char *s   = luaL_checklstring(Ls, 3, &n);

    if (!estremi(Ls, b, off, (lua_Integer)n)) return 2;
    memcpy(b->p + off, s, n);
    lua_pushinteger(Ls, (lua_Integer)n);
    return 1;
}

static int l_m_read(lua_State *Ls)
{
    mem_box_t  *b   = mbox(Ls);
    lua_Integer off = luaL_checkinteger(Ls, 2);
    lua_Integer n   = luaL_checkinteger(Ls, 3);

    if (!estremi(Ls, b, off, n)) return 2;

    /* At most 4 KB per call: the string goes into the Lua heap. */
    if (n > 4096) n = 4096;
    lua_pushlstring(Ls, (const char *)(b->p + off), (size_t)n);
    return 1;
}

/* b:load(path [, off [, n]]): file into block */
static int l_m_load(lua_State *Ls)
{
    mem_box_t    *b    = mbox(Ls);
    const char   *path = luaL_checkstring(Ls, 2);
    lua_Integer   off  = luaL_optinteger(Ls, 3, 0);
    lua_Integer   max  = luaL_optinteger(Ls, 4, -1);
    orion_file_t *f;
    lua_Integer   tot  = 0;

    if (b->p == NULL) { lua_pushnil(Ls); lua_pushstring(Ls, "block freed"); return 2; }
    if (max < 0) max = (lua_Integer)b->n - off;
    if (!estremi(Ls, b, off, max)) return 2;

    f = o->fs->open(path, ORION_READ);
    if (f == NULL) { lua_pushnil(Ls); lua_pushstring(Ls, "cannot open file"); return 2; }

    while (tot < max)
    {
        const int voluti = ((max - tot) < (lua_Integer)TRANSITO)
                             ? (int)(max - tot) : (int)TRANSITO;
        const int letti  = o->fs->read(f, transito, voluti);

        if (letti <= 0) break;
        memcpy(b->p + off + tot, transito, (size_t)letti);
        tot += letti;
    }
    o->fs->close(f);

    lua_pushinteger(Ls, tot);
    return 1;
}

/* b:save(path [, off [, n]]): block into file */
static int l_m_save(lua_State *Ls)
{
    mem_box_t    *b    = mbox(Ls);
    const char   *path = luaL_checkstring(Ls, 2);
    lua_Integer   off  = luaL_optinteger(Ls, 3, 0);
    lua_Integer   n    = luaL_optinteger(Ls, 4, -1);
    orion_file_t *f;
    lua_Integer   tot  = 0;

    if (b->p == NULL) { lua_pushnil(Ls); lua_pushstring(Ls, "block freed"); return 2; }
    if (n < 0) n = (lua_Integer)b->n - off;
    if (!estremi(Ls, b, off, n)) return 2;

    f = o->fs->open(path, ORION_WRITE);
    if (f == NULL) { lua_pushnil(Ls); lua_pushstring(Ls, "cannot open file"); return 2; }

    while (tot < n)
    {
        const int quanti = ((n - tot) < (lua_Integer)TRANSITO)
                             ? (int)(n - tot) : (int)TRANSITO;
        int       scritti;

        /* Through the transit buffer, so the SDMMC DMA never reads from
           PSRAM. */
        memcpy(transito, b->p + off + tot, (size_t)quanti);
        scritti = o->fs->write(f, transito, quanti);

        if (scritti <= 0) break;
        tot += scritti;
    }
    o->fs->close(f);

    lua_pushinteger(Ls, tot);
    return 1;
}

static const luaL_Reg MEMMT[] = {
    {"size", l_m_size}, {"is_fast", l_m_is_fast}, {"free", l_m_free},
    {"read", l_m_read}, {"write",   l_m_write},
    {"load", l_m_load}, {"save",    l_m_save},
    {NULL, NULL}
};

static int l_mem_alloc(lua_State *Ls)
{
    const lua_Integer  byte = luaL_checkinteger(Ls, 1);
    const char        *dove = luaL_optstring(Ls, 2, "any");
    mem_box_t         *b;
    void              *p;

    if (byte <= 0) { lua_pushnil(Ls); lua_pushstring(Ls, "invalid size"); return 2; }

    p = o->mem->alloc((int)byte, (strcmp(dove, "fast") == 0) ? ORION_MEM_FAST
                                                             : ORION_MEM_ANY);
    if (p == NULL)
    {
        lua_pushnil(Ls);
        lua_pushstring(Ls, "out of memory");
        return 2;
    }

    b    = (mem_box_t *)lua_newuserdatauv(Ls, sizeof(mem_box_t), 0);
    b->p = (uint8_t *)p;
    b->n = (uint32_t)byte;
    luaL_setmetatable(Ls, MT_MEM);
    return 1;
}

static int l_mem_free_fast(lua_State *Ls)
{
    lua_pushinteger(Ls, o->mem->free_fast()); return 1;
}
static int l_mem_free_large(lua_State *Ls)
{
    lua_pushinteger(Ls, o->mem->free_large()); return 1;
}

static const luaL_Reg MEM[] = {
    {"alloc", l_mem_alloc},
    {"free_fast", l_mem_free_fast}, {"free_large", l_mem_free_large},
    {NULL, NULL}
};

static int l_set_fps(lua_State *Ls)
{
    o->sys->set_fps((int)luaL_checkinteger(Ls, 1));
    return 0;
}

static int l_fps(lua_State *Ls)
{
    lua_pushinteger(Ls, o->sys->fps());
    return 1;
}

static const luaL_Reg SYS[] = {
    {"ms", l_ms}, {"set_fps", l_set_fps}, {"fps", l_fps}, {"battery", l_battery}, {"is_charging", l_is_charging},
    {"date_time", l_date_time}, {"content_area", l_content_area},
    {"version", l_version}, {"exit", l_exit}, {"log", l_log},
    {NULL, NULL}
};

/* the keys: orion.K */
static const struct { const char *n; int v; } TASTI[] = {
    {"ESC", ORION_K_ESC}, {"ENTER", ORION_K_ENTER}, {"DEL", ORION_K_DEL},
    {"BACK", ORION_K_BACK}, {"UP", ORION_K_UP}, {"DOWN", ORION_K_DOWN},
    {"LEFT", ORION_K_LEFT}, {"RIGHT", ORION_K_RIGHT}, {"MENU", ORION_K_MENU},
    {"SAVE", ORION_K_SAVE}, {"SEARCH", ORION_K_SEARCH}, {"PLAY", ORION_K_PLAY},
    {"NEXT", ORION_K_NEXT}, {"PREV", ORION_K_PREV},
    {"VOL_UP", ORION_K_VOL_UP}, {"VOL_DOWN", ORION_K_VOL_DOWN},
    {"MUTE", ORION_K_MUTE}, {"SHIFT", ORION_K_SHIFT}, {"FN", ORION_K_FN},
};

/* ==========================================================================
 *  Serial port on J4
 * ==========================================================================
 * Bytes travel as Lua strings; parse them with string.byte / string.unpack.
 */
#define SERIALE_PEZZO  512

static int l_se_open(lua_State *L)
{
    const orion_result_t r = o->serial->open((int)luaL_optinteger(L, 1, 115200));

    if (r == ORION_OK) { lua_pushboolean(L, 1); return 1; }
    lua_pushnil(L);
    lua_pushstring(L, (r == ORION_ERR_BUSY) ? "busy" :
                      (r == ORION_ERR_ARG)  ? "bad baud" : "rail or uart failed");
    return 2;
}

static int l_se_close(lua_State *L)     { (void)L; o->serial->close(); return 0; }
static int l_se_is_open(lua_State *L)   { lua_pushboolean(L, o->serial->is_open()); return 1; }
static int l_se_available(lua_State *L) { lua_pushinteger(L, o->serial->available()); return 1; }
static int l_se_lost(lua_State *L)      { lua_pushinteger(L, o->serial->lost()); return 1; }

static int l_se_write(lua_State *L)
{
    size_t n;
    const char *s = luaL_checklstring(L, 1, &n);

    lua_pushinteger(L, o->serial->write(s, (int)n));
    return 1;
}

/* read([max]): what has arrived, up to max (default 512). Returns "" when
   nothing has, never nil. */
static int l_se_read(lua_State *L)
{
    char buf[SERIALE_PEZZO];
    lua_Integer max = luaL_optinteger(L, 1, SERIALE_PEZZO);
    int n;

    if (max > SERIALE_PEZZO) max = SERIALE_PEZZO;
    if (max < 0) max = 0;
    n = o->serial->read(buf, (int)max);
    lua_pushlstring(L, buf, (n > 0) ? (size_t)n : 0U);
    return 1;
}

static const luaL_Reg SERIAL[] = {
    {"open", l_se_open}, {"close", l_se_close}, {"is_open", l_se_is_open},
    {"write", l_se_write}, {"read", l_se_read},
    {"available", l_se_available}, {"lost", l_se_lost},
    {NULL, NULL}
};

/* shared "nil, reason" for J4 and Bluetooth */
static int esito_errore(lua_State *L, int r)
{
    lua_pushnil(L);
    lua_pushstring(L, (r == ORION_ERR_NOT_FOUND)  ? "no answer" :
                      (r == ORION_ERR_BUSY)       ? "busy" :
                      (r == ORION_ERR_ARG)        ? "bad argument" :
                      (r == ORION_ERR_FILE)       ? "bus error" :
                      (r == ORION_ERR_PERMISSION) ? "not open, or rail failed" :
                                                    "failed");
    return 2;
}

static int esito(lua_State *L, int r)
{
    if (r >= 0) { lua_pushboolean(L, 1); return 1; }
    return esito_errore(L, r);
}

/* ==========================================================================
 *  GPIO on J4
 * ==========================================================================
 * Pins 1..4 (EXT_GPIO1..4); modes are strings; levels read as 0/1 and are
 * written as a boolean or a number.
 */
static int l_gp_mode(lua_State *L)
{
    /* same order as orion_gpio_mode_t */
    static const char *const MODI[] = {
        "off", "in", "in_pullup", "in_pulldown", "out", "out_od", NULL
    };
    const int pin = (int)luaL_checkinteger(L, 1);
    const int m   = luaL_checkoption(L, 2, NULL, MODI);

    return esito(L, o->gpio->mode(pin, (orion_gpio_mode_t)m));
}

static int l_gp_write(lua_State *L)
{
    const int pin = (int)luaL_checkinteger(L, 1);
    bool      alto;

    int       r;

    if (lua_isboolean(L, 2)) alto = lua_toboolean(L, 2);
    else                     alto = (luaL_checkinteger(L, 2) != 0);
    r = o->gpio->write(pin, alto);
    if (r == ORION_ERR_PERMISSION)
    {
        lua_pushnil(L);
        lua_pushstring(L, "pin is not an output");
        return 2;
    }
    return esito(L, r);
}

static int l_gp_read(lua_State *L)
{
    const int v = o->gpio->read((int)luaL_checkinteger(L, 1));

    if (v == ORION_ERR_PERMISSION)
    {
        lua_pushnil(L);
        lua_pushstring(L, "pin is off: set a mode first");
        return 2;
    }
    if (v < 0) return esito_errore(L, v);
    lua_pushinteger(L, v);
    return 1;
}

static int l_gp_close(lua_State *L) { (void)L; o->gpio->close(); return 0; }

static const luaL_Reg GPIO[] = {
    {"mode", l_gp_mode}, {"write", l_gp_write}, {"read", l_gp_read},
    {"close", l_gp_close},
    {NULL, NULL}
};

/* ==========================================================================
 *  I2C on J4
 * ==========================================================================
 * Bytes as strings, at most 255 per call (one transaction).
 */
#define I2C_PEZZO 255

static int l_i2c_open(lua_State *L)
{
    return esito(L, o->i2c->open((int)luaL_optinteger(L, 1, 100)));
}

static int l_i2c_close(lua_State *L)   { (void)L; o->i2c->close(); return 0; }
static int l_i2c_is_open(lua_State *L) { lua_pushboolean(L, o->i2c->is_open()); return 1; }

static int l_i2c_write(lua_State *L)
{
    size_t      n;
    const int   addr = (int)luaL_checkinteger(L, 1);
    const char *s    = luaL_checklstring(L, 2, &n);

    if (n > I2C_PEZZO) return esito_errore(L, ORION_ERR_ARG);
    return esito(L, o->i2c->write(addr, s, (int)n));
}

/* the bytes, or nil and a reason: never a short answer */
static int l_i2c_read(lua_State *L)
{
    char      buf[I2C_PEZZO];
    const int addr = (int)luaL_checkinteger(L, 1);
    const int n    = (int)luaL_checkinteger(L, 2);
    int       r;

    if ((n < 1) || (n > I2C_PEZZO)) return esito_errore(L, ORION_ERR_ARG);
    r = o->i2c->read(addr, buf, n);
    if (r < 0) return esito_errore(L, r);
    lua_pushlstring(L, buf, (size_t)r);
    return 1;
}

static int l_i2c_write_read(lua_State *L)
{
    char        buf[I2C_PEZZO];
    size_t      wn;
    const int   addr = (int)luaL_checkinteger(L, 1);
    const char *w    = luaL_checklstring(L, 2, &wn);
    const int   rn   = (int)luaL_checkinteger(L, 3);
    int         r;

    if ((wn > I2C_PEZZO) || (rn < 1) || (rn > I2C_PEZZO))
        return esito_errore(L, ORION_ERR_ARG);
    r = o->i2c->write_read(addr, w, (int)wn, buf, rn);
    if (r < 0) return esito_errore(L, r);
    lua_pushlstring(L, buf, (size_t)r);
    return 1;
}

static int l_i2c_probe(lua_State *L)
{
    lua_pushboolean(L, o->i2c->probe((int)luaL_checkinteger(L, 1)));
    return 1;
}

/* every 7-bit address that answers */
static int l_i2c_scan(lua_State *L)
{
    int k = 0;

    lua_newtable(L);
    for (int a = 0x08; a <= 0x77; a++)
    {
        if (o->i2c->probe(a))
        {
            lua_pushinteger(L, a);
            lua_rawseti(L, -2, ++k);
        }
    }
    return 1;
}

static const luaL_Reg I2C[] = {
    {"open", l_i2c_open}, {"close", l_i2c_close}, {"is_open", l_i2c_is_open},
    {"write", l_i2c_write}, {"read", l_i2c_read},
    {"write_read", l_i2c_write_read}, {"probe", l_i2c_probe},
    {"scan", l_i2c_scan},
    {NULL, NULL}
};

/* ==========================================================================
 *  Bluetooth data
 * ==========================================================================
 * Messages as strings. receive() returns nil when the queue is empty,
 * unlike serial.read() which returns "": a message is there or it is not.
 */
static int l_bl_open(lua_State *L)         { return esito(L, o->ble->open()); }
static int l_bl_close(lua_State *L)        { (void)L; o->ble->close(); return 0; }
static int l_bl_is_open(lua_State *L)      { lua_pushboolean(L, o->ble->is_open()); return 1; }
static int l_bl_is_connected(lua_State *L) { lua_pushboolean(L, o->ble->is_connected()); return 1; }
static int l_bl_lost(lua_State *L)         { lua_pushinteger(L, o->ble->lost()); return 1; }
static int l_bl_name(lua_State *L)         { lua_pushstring(L, o->ble->name()); return 1; }

static int l_bl_send(lua_State *L)
{
    size_t      n;
    const char *s = luaL_checklstring(L, 1, &n);
    const int   r = o->ble->send(s, (int)n);

    if (r == ORION_ERR_NOT_FOUND)
    {
        lua_pushnil(L);
        lua_pushstring(L, "not connected");
        return 2;
    }
    if (r == ORION_ERR_ARG)
    {
        lua_pushnil(L);
        lua_pushstring(L, "text only (no CR, LF, NUL), 1..492 bytes");
        return 2;
    }
    return esito(L, r);
}

static int l_bl_receive(lua_State *L)
{
    /* The buffer lives on the Lua heap, not on the C stack. */
    luaL_Buffer b;
    char       *p = luaL_buffinitsize(L, &b, ORION_BLE_MSG_MAX);
    const int   n = o->ble->receive(p, ORION_BLE_MSG_MAX);

    if (n <= 0)
    {
        luaL_pushresultsize(&b, 0U);
        lua_pop(L, 1);
        lua_pushnil(L);
        return 1;
    }
    luaL_pushresultsize(&b, (size_t)n);
    return 1;
}

static const luaL_Reg BLE[] = {
    {"open", l_bl_open}, {"close", l_bl_close}, {"is_open", l_bl_is_open},
    {"is_connected", l_bl_is_connected},
    {"send", l_bl_send}, {"receive", l_bl_receive},
    {"lost", l_bl_lost}, {"name", l_bl_name},
    {NULL, NULL}
};

void orion_lua_bind(lua_State *L, const orion_api_t *api)
{
    o = api;

    lua_newtable(L);                       /* orion */

    /* A module the firmware does not have is not exposed, so using it
       gives a normal Lua error with a line number. */
    tabella(L, "gfx",   GFX);
    tabella(L, "input", INPUT);
    tabella(L, "sys",   SYS);
    if (api->ui    != NULL) tabella(L, "ui",    UI);
    if (api->mem   != NULL) tabella(L, "mem",   MEM);
    if (api->fs    != NULL) tabella(L, "fs",    FS);
    if (api->pref  != NULL) tabella(L, "pref",  PREF);
    if (api->audio != NULL) tabella(L, "audio", AUDIO);
    if (api->math  != NULL) tabella(L, "math",  MATH);
    if (api->mic   != NULL) tabella(L, "mic",   MIC);
    if (api->serial != NULL) tabella(L, "serial", SERIAL);
    if (api->gpio   != NULL) tabella(L, "gpio",   GPIO);
    if (api->i2c    != NULL) tabella(L, "i2c",    I2C);
    if (api->ble    != NULL) tabella(L, "ble",    BLE);

    /* File objects: methods in a metatable; __gc closes forgotten files
       (the firmware closes them on exit as well). */
    luaL_newmetatable(L, MT_FILE);
    luaL_newlib(L, FILEMT);
    lua_setfield(L, -2, "__index");
    lua_pushcfunction(L, l_f_close);
    lua_setfield(L, -2, "__gc");
    lua_pop(L, 1);

    /* Memory blocks: same idea, __gc frees forgotten blocks. */
    /* Images: __gc frees forgotten images. */
    luaL_newmetatable(L, MT_IMG);
    lua_createtable(L, 0, 3);
    luaL_setfuncs(L, IMGMT, 0);
    lua_setfield(L, -2, "__index");
    lua_pushcfunction(L, l_img_free);
    lua_setfield(L, -2, "__gc");
    lua_pop(L, 1);

    luaL_newmetatable(L, MT_MEM);
    lua_createtable(L, 0, 7);
    luaL_setfuncs(L, MEMMT, 0);
    lua_setfield(L, -2, "__index");
    lua_pushcfunction(L, l_m_free);
    lua_setfield(L, -2, "__gc");
    lua_pop(L, 1);

    lua_newtable(L);                       /* orion.K */
    for (size_t i = 0U; i < (sizeof TASTI / sizeof TASTI[0]); i++)
    {
        lua_pushinteger(L, TASTI[i].v);
        lua_setfield(L, -2, TASTI[i].n);
    }
    lua_setfield(L, -2, "K");

    lua_pushinteger(L, ORION_WHITE);     lua_setfield(L, -2, "WHITE");
    lua_pushinteger(L, ORION_BLACK);     lua_setfield(L, -2, "BLACK");
    lua_pushinteger(L, ORION_SCREEN_W);  lua_setfield(L, -2, "W");
    lua_pushinteger(L, ORION_SCREEN_H);  lua_setfield(L, -2, "H");

    lua_setglobal(L, "orion");
}
