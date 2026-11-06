/**
 * @file  emu_main.c
 * @brief The ORION emulator: a window, the PC keyboard, and the same app
 *        code as the device.
 *
 * Usage:   ./orion-emu [card-folder] [app.lua]
 *
 * What it cannot show: timing (on the device a full frame takes ~75 ms and
 * the main loop has real deadlines), the cost of scattered PSRAM reads, and
 * MP3, Bluetooth and the microphone. Drawing, keys, files, dialogs, memory
 * and Lua run the same code as the device.
 */
#include <SDL.h>
#include <stdio.h>
#include <string.h>

#include "emu_lcd.h"
#include "emu_hw.h"
#include "keyboard.h"
#include "app_iface.h"
#include "app_host.h"

#define SCALA        2
#define FINESTRA_W   (EMU_W * SCALA)
#define BARRA_H      28
#define FINESTRA_H   ((EMU_H * SCALA) + BARRA_H)

extern const app_iface_t app_lua;      /* from app_lua.c */
void orion_fs_set_dati(const char *nome);

#ifdef _WIN32
#include <stdlib.h>
#include <windows.h>

/* Started from Explorer (double click, or a .lua dropped on the exe) the
   console is ours alone and closes with the process: without a pause an
   error message would vanish before anyone reads it. From a terminal the
   console is shared and there is nothing to wait for. */
static bool console_nostra(void)
{
    DWORD lista[2];

    return GetConsoleProcessList(lista, 2) == 1;
}

static void pausa_se_serve(void)
{
    if (!console_nostra()) return;
    printf("\n  press Enter to close\n");
    (void)getchar();
}

/* A dropped file arrives as C:\...\card\apps\x.lua: the rest of the code
   (and the device) speaks forward slashes. */
static char *barre_avanti(const char *in)
{
    static char buf[1024];
    char       *p;

    snprintf(buf, sizeof buf, "%s", in);
    for (p = buf; *p != '\0'; p++)
    {
        if (*p == '\\') *p = '/';
    }
    return buf;
}
#endif

/* The keys a PC does not have are on the function keys. */
static uint8_t traduci(SDL_Keycode k, bool *stampabile)
{
    *stampabile = false;
    switch (k)
    {
        case SDLK_ESCAPE:    return KEY_ESC;
        case SDLK_RETURN:    return KEY_ENTER;
        case SDLK_BACKSPACE: return KEY_BACK;
        case SDLK_DELETE:    return KEY_DEL;
        case SDLK_UP:        return KEY_UP;
        case SDLK_DOWN:      return KEY_DOWN;
        case SDLK_LEFT:      return KEY_LEFT;
        case SDLK_RIGHT:     return KEY_RIGHT;
        case SDLK_F1:        return KEY_MENU;
        case SDLK_F2:        return KEY_SAVE;
        case SDLK_F3:        return KEY_SEARCH;
        case SDLK_F4:        return KEY_PLAY;
        case SDLK_F5:        return KEY_RW;
        case SDLK_F6:        return KEY_FW;
        default: break;
    }
    if ((k >= 32) && (k < 127)) { *stampabile = true; return (uint8_t)k; }
    return KEY_NONE;
}

/* ==========================================================================
 *  Printable keys: the character, not the key
 * ==========================================================================
 * The keycode is the unshifted symbol of the host layout (Shift+7 on an
 * Italian keyboard is still SDLK_7), so the typed character is taken from
 * SDL_TEXTINPUT, which follows the KEYDOWN, and remembered per key for the
 * KEYUP. With Alt (= Fn) held the raw key is used.
 */
static SDL_Keycode in_attesa = 0;     /* printable KEYDOWN waiting for its text */
static uint8_t     emesso[128];       /* code queued for each key, for KEYUP */

/* First character of a UTF-8 string as a device code: ASCII, or the
   private range 0x80..0x87 for à è ì ò ù é £ €. */
static uint8_t da_testo(const char *t)
{
    const uint8_t *u = (const uint8_t *)t;
    uint32_t cp;

    if (u[0] < 0x80U) cp = u[0];
    else if ((u[0] & 0xE0U) == 0xC0U) cp = ((u[0] & 0x1FU) << 6) | (u[1] & 0x3FU);
    else if ((u[0] & 0xF0U) == 0xE0U)
        cp = ((u[0] & 0x0FU) << 12) | ((u[1] & 0x3FU) << 6) | (u[2] & 0x3FU);
    else return 0U;

    if ((cp >= 0x20U) && (cp < 0x7FU)) return (uint8_t)cp;
    switch (cp)
    {
        case 0xE0: return 0x80; case 0xE8: return 0x81; case 0xEC: return 0x82;
        case 0xF2: return 0x83; case 0xF9: return 0x84; case 0xE9: return 0x85;
        case 0xA3: return 0x86; case 0x20AC: return 0x87;
        default:   return 0U;
    }
}

static void premi_in_attesa(uint8_t c)
{
    emesso[in_attesa] = c;
    emu_accoda(c, true);
    in_attesa = 0;
}

static void disegna_barra(SDL_Renderer *r, const char *nota)
{
    SDL_Rect b = { 0, EMU_H * SCALA, FINESTRA_W, BARRA_H };

    SDL_SetRenderDrawColor(r, 30, 30, 34, 255);
    SDL_RenderFillRect(r, &b);
    (void)nota;   /* the bar text is printed in the window title */
}

int main(int argc, char **argv)
{
    /* Two forms:
     *
     *     ./orion-emu card/apps/bricks.lua   one path: the card is the
     *                                        folder containing apps/
     *     ./orion-emu ./card apps/bricks.lua card and app separately
     */
    char        radice_buf[512];
    const char *radice = "./card";
    const char *app    = "apps/bricks.lua";

#ifdef _WIN32
    static char base_card[512];
    char       *base = SDL_GetBasePath();

    SetConsoleOutputCP(CP_UTF8);        /* the banner and Lua text are UTF-8 */
    /* Into a pipe or a file the Windows CRT buffers everything (it has no
       line buffering): log lines would appear only at exit. */
    setvbuf(stdout, NULL, _IONBF, 0);
    /* Double click: the working folder is not guaranteed to be the exe's,
       so the default card is looked up next to the exe. */
    if (base != NULL)
    {
        snprintf(base_card, sizeof base_card, "%scard", base);
        SDL_free(base);
        radice = barre_avanti(base_card);
        snprintf(base_card, sizeof base_card, "%s", radice);
        radice = base_card;
    }
    if (argc >= 2) argv[1] = strdup(barre_avanti(argv[1]));
    if (argc >= 3) argv[2] = strdup(barre_avanti(argv[2]));
#endif

    if (argc == 2)
    {
        const char *p   = argv[1];
        const size_t n  = strlen(p);
        /* the last "/apps/" (or a leading "apps/"), so that a folder named
           e.g. "myapps" higher up the path is not taken for the card */
        const char  *ap = (strncmp(p, "apps/", 5) == 0) ? p : NULL;
        const char  *q;

        for (q = strstr(p, "/apps/"); q != NULL; q = strstr(q + 1, "/apps/"))
        {
            ap = q + 1;
        }

        if ((n > 4u) && (strcmp(&p[n - 4], ".lua") == 0) && (ap != NULL))
        {
            const size_t quanto = (size_t)(ap - p);

            snprintf(radice_buf, sizeof radice_buf, "%.*s",
                     (int)((quanto > 0u) ? (quanto - 1u) : 1u),
                     (quanto > 0u) ? p : ".");
            radice = (quanto > 0u) ? radice_buf : ".";
            app    = ap;
        }
        else
        {
            radice = argv[1];       /* card only: default app */
        }
    }
    else if (argc > 2)
    {
        radice = argv[1];
        app    = argv[2];
    }
    char        titolo[256];
    SDL_Window   *win;
    SDL_Renderer *ren;
    SDL_Texture  *tex;
    bool          vivo = true;
    uint32_t      ultimo_titolo = 0U;

    emu_radice = radice;

    if (SDL_Init(SDL_INIT_VIDEO) != 0)
    {
        fprintf(stderr, "SDL: %s\n", SDL_GetError());
#ifdef _WIN32
        pausa_se_serve();
#endif
        return 1;
    }

    win = SDL_CreateWindow("ORION", SDL_WINDOWPOS_CENTERED,
                           SDL_WINDOWPOS_CENTERED, FINESTRA_W, FINESTRA_H, 0);
    ren = SDL_CreateRenderer(win, -1, SDL_RENDERER_ACCELERATED);
    tex = SDL_CreateTexture(ren, SDL_PIXELFORMAT_ARGB8888,
                            SDL_TEXTUREACCESS_STREAMING, EMU_W, EMU_H);

    printf("\n  ORION emulator\n"
           "  card \"%s\"   app \"%s\"\n\n"
           "  same code as the device: gfx  input  fs  pref  ui  mem  sys  Lua\n"
           "  audio: WAV and short sounds only (no MP3, Bluetooth, microphone)\n\n"
           "  Nothing here has deadlines. On the device a full frame takes ~75 ms\n"
           "  and the main loop has real ones (audio, recorder, panel): an app\n"
           "  that is smooth here can break the audio there. The window title\n"
           "  counts full frames for this reason.\n\n"
           "  F1 MENU · F2 SAVE · F3 SEARCH · F4 PLAY · Alt = Fn\n\n",
           radice, app);

    SDL_StartTextInput();
    app_host_registra(&app_lua);
    if (!app_host_avvia_arg("lua", app))
    {
        fprintf(stderr, "\n  could not open \"%s/%s\".\n"
                        "  usage:  ./orion-emu <app.lua>\n"
                        "          ./orion-emu <card-folder> <app.lua>\n",
                radice, app);
#ifdef _WIN32
        pausa_se_serve();
#endif
        return 2;
    }

    while (vivo)
    {
        SDL_Event e;

        while (SDL_PollEvent(&e))
        {
            bool stampabile;

            if (e.type == SDL_QUIT) { vivo = false; break; }
            if (e.type == SDL_TEXTINPUT)
            {
                const uint8_t c = da_testo(e.text.text);

                if (in_attesa != 0)
                    premi_in_attesa((c != 0U) ? c : (uint8_t)in_attesa);
                else if (c != 0U)
                {
                    emu_accoda(c, true);      /* no key behind it: a tap */
                    emu_accoda(c, false);
                }
                continue;
            }
            if ((e.type != SDL_KEYDOWN) && (e.type != SDL_KEYUP)) continue;
            if (e.key.repeat != 0) continue;

            emu_shift = ((SDL_GetModState() & KMOD_SHIFT) != 0);
            emu_fn    = ((SDL_GetModState() & KMOD_ALT)   != 0);

            {
                const SDL_Keycode k    = e.key.keysym.sym;
                const uint8_t     code = traduci(k, &stampabile);

                if (stampabile && !emu_fn)
                {
                    if (e.type == SDL_KEYDOWN)
                    {
                        if (in_attesa != 0) premi_in_attesa((uint8_t)in_attesa);
                        in_attesa = k;
                    }
                    else
                    {
                        /* no text came (dead key, Cmd held): use the key */
                        if (in_attesa == k) premi_in_attesa((uint8_t)k);
                        if (emesso[k] != 0U) { emu_accoda(emesso[k], false); emesso[k] = 0U; }
                    }
                    continue;
                }

                if (code != KEY_NONE)
                    emu_accoda(code, (e.type == SDL_KEYDOWN));
            }
        }

        /* same as the device: app_host_update() runs the app or a dialog */
        app_host_update();
        if (!app_host_attiva()) vivo = false;   /* the app called exit() */

        if (emu_da_ridisegnare)
        {
            uint32_t *px    = NULL;
            int       pitch = 0;

            emu_da_ridisegnare = false;

            /* With SDL_VIDEODRIVER=dummy (no window, as in `make prova`) the lock
               fails and `px` stays NULL. */
            if ((SDL_LockTexture(tex, NULL, (void **)&px, &pitch) == 0) &&
                (px != NULL))
            {
                for (int y = 0; y < EMU_H; y++)
                    for (int x = 0; x < EMU_W; x++)
                        px[(y * (pitch / 4)) + x] =
                            emu_fb[y][x] ? 0xFF101010u : 0xFFE8E8E0u;
                SDL_UnlockTexture(tex);
            }
        }

        {
            SDL_Rect dst = { 0, 0, FINESTRA_W, EMU_H * SCALA };

            SDL_SetRenderDrawColor(ren, 0, 0, 0, 255);
            SDL_RenderClear(ren);
            SDL_RenderCopy(ren, tex, NULL, &dst);
            disegna_barra(ren, NULL);
            SDL_RenderPresent(ren);
        }

        /* the title shows how many full frames the app sent */
        if ((SDL_GetTicks() - ultimo_titolo) > 500U)
        {
            ultimo_titolo = SDL_GetTicks();
            snprintf(titolo, sizeof titolo,
                     "ORION — %s — full frames %u, partial %u   "
                     "[F1 MENU · F2 SAVE · F3 SEARCH · Alt=Fn]",
                     app, emu_frame_interi, emu_frame_parziali);
            SDL_SetWindowTitle(win, titolo);
        }

        SDL_Delay(10);
    }

    app_host_esci();
    SDL_DestroyTexture(tex);
    SDL_DestroyRenderer(ren);
    SDL_DestroyWindow(win);
    SDL_Quit();
    return 0;
}
