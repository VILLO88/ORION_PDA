/**
 * @file  emu_audio.c
 * @brief Sound through SDL2. The microphone is not emulated.
 *
 * Implemented: play_file() for WAV, stop, is_playing, position_ms,
 * duration_ms, set_volume and the short sounds sfx_*.
 *
 * It refuses whatever the device refuses, so an app that plays here plays
 * there too:
 *   - play_file: 16-bit PCM WAV, mono or stereo, up to 48 kHz. MP3 is not
 *     supported here and answers "not found";
 *   - sfx_load: WAV at exactly 48 kHz, 16-bit, at most 5 s; 16 slots, 4
 *     voices, the fifth replaces the one closest to its end;
 *   - one volume for music and effects.
 *
 * Differences that remain: upsampling is linear here and cubic on the
 * device; the ~15 ms of the first sound on the device does not exist here;
 * there is no Bluetooth (is_bluetooth() is always false); files are read
 * whole into memory, while the device streams them.
 *
 * Without an audio device (or with ORION_AUDIO=0) every call answers
 * "not found".
 */
#include "orion_api.h"
#include "orion_fs.h"
#include <SDL.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define OUT_RATE    48000
#define SFX_SLOT    16
#define SFX_VOCI    4
#define SFX_MAX_S   5
#define WAV_MAX_MB  64                  /* a safety limit, not a device limit */

typedef struct {
    int16_t *pcm;                       /* stereo, interleaved */
    size_t   frames;
    unsigned rate;
} suono_t;

/* everything the audio thread reads is changed under SDL_LockAudioDevice */
static SDL_AudioDeviceID dev = 0;
static bool   provato = false, ok = false;

static suono_t musica;
static bool    musica_suona = false;
static double  musica_pos   = 0.0;     /* in source frames */

static suono_t sfx[SFX_SLOT];
static struct { int id; size_t pos; int vol; bool attiva; } voce[SFX_VOCI];

static float volume = 0.2239f;         /* -13 dB */

static void callback(void *ud, Uint8 *flusso, int byte)
{
    int16_t *out = (int16_t *)flusso;
    const size_t n = (size_t)byte / 4u;
    size_t i;
    int v;

    (void)ud;
    for (i = 0; i < n; i++)
    {
        float l = 0.0f, r = 0.0f;

        if (musica_suona)
        {
            const size_t k = (size_t)musica_pos;

            if (k + 1u >= musica.frames) musica_suona = false;
            else
            {
                const float f = (float)(musica_pos - (double)k);
                const int16_t *p = &musica.pcm[k * 2u];

                l = (float)p[0] + ((float)p[2] - (float)p[0]) * f;
                r = (float)p[1] + ((float)p[3] - (float)p[1]) * f;
                musica_pos += (double)musica.rate / (double)OUT_RATE;
            }
        }

        for (v = 0; v < SFX_VOCI; v++)
        {
            if (voce[v].attiva)
            {
                const suono_t *s = &sfx[voce[v].id];
                const float g = (float)voce[v].vol / 255.0f;

                l += (float)s->pcm[voce[v].pos * 2u]      * g;
                r += (float)s->pcm[voce[v].pos * 2u + 1u] * g;
                if (++voce[v].pos >= s->frames) voce[v].attiva = false;
            }
        }

        /* saturates like the device mixer */
        l *= volume; r *= volume;
        out[i * 2u]      = (int16_t)((l >  32767.0f) ?  32767.0f : (l < -32768.0f) ? -32768.0f : l);
        out[i * 2u + 1u] = (int16_t)((r >  32767.0f) ?  32767.0f : (r < -32768.0f) ? -32768.0f : r);
    }
}

static bool apri(void)
{
    SDL_AudioSpec voluto, avuto;
    const char *e;

    if (provato) return ok;
    provato = true;

    e = getenv("ORION_AUDIO");
    if ((e != NULL) && (e[0] == '0')) return false;

    if (SDL_InitSubSystem(SDL_INIT_AUDIO) != 0)
    {
        fprintf(stderr, "audio: %s (calls answer \"not found\")\n", SDL_GetError());
        return false;
    }
    SDL_zero(voluto);
    voluto.freq = OUT_RATE; voluto.format = AUDIO_S16SYS;
    voluto.channels = 2;    voluto.samples = 1024; voluto.callback = callback;

    /* allowed_changes = 0: SDL converts, so the callback always gets 48 kHz
       stereo S16, like the SAI. */
    dev = SDL_OpenAudioDevice(NULL, 0, &voluto, &avuto, 0);
    if (dev == 0)
    {
        fprintf(stderr, "audio: %s (calls answer \"not found\")\n", SDL_GetError());
        return false;
    }
    SDL_PauseAudioDevice(dev, 0);
    ok = true;
    return true;
}

static unsigned le32(const unsigned char *p)
{
    return (unsigned)p[0] | ((unsigned)p[1] << 8) |
           ((unsigned)p[2] << 16) | ((unsigned)p[3] << 24);
}
static unsigned le16(const unsigned char *p) { return (unsigned)p[0] | ((unsigned)p[1] << 8); }

/* Reads a whole file through the emulated file system, so the sandbox
   applies. Caller frees. */
static unsigned char *leggi_tutto(const char *path, size_t *n_out)
{
    orion_file_t *f = ORION_FS.open(path, ORION_READ);
    unsigned char *b = NULL;
    size_t cap = 0, n = 0;

    if (f == NULL) return NULL;
    for (;;)
    {
        int letti;

        if ((n + 65536u) > cap)
        {
            unsigned char *nb;

            cap = (cap == 0u) ? 262144u : cap * 2u;
            if (cap > ((size_t)WAV_MAX_MB << 20)) { free(b); (void)ORION_FS.close(f); return NULL; }
            nb = (unsigned char *)realloc(b, cap);
            if (nb == NULL) { free(b); (void)ORION_FS.close(f); return NULL; }
            b = nb;
        }
        letti = ORION_FS.read(f, b + n, 65536);
        if (letti <= 0) break;
        n += (size_t)letti;
    }
    (void)ORION_FS.close(f);
    *n_out = n;
    return b;
}

/* Parses a WAV into 16-bit stereo. Music accepts rates up to 48000,
   effects exactly 48000. On failure returns false and says why on stderr. */
static bool carica_wav(const char *path, bool effetto, suono_t *out)
{
    size_t n = 0, i;
    unsigned char *b = leggi_tutto(path, &n);
    unsigned rate = 0, canali = 0, bps = 0, fmt = 0;
    const unsigned char *dati = NULL;
    size_t dati_n = 0;
    size_t frames, k;

    if (b == NULL) return false;
    if ((n < 44u) || (memcmp(b, "RIFF", 4) != 0) || (memcmp(&b[8], "WAVE", 4) != 0))
    { free(b); return false; }

    /* walk the chunks: ffmpeg puts a LIST before `fmt ` */
    for (i = 12u; (i + 8u) <= n; )
    {
        const unsigned size = le32(&b[i + 4u]);

        if (memcmp(&b[i], "fmt ", 4) == 0 && (i + 24u) <= n)
        {
            fmt = le16(&b[i + 8u]); canali = le16(&b[i + 10u]);
            rate = le32(&b[i + 12u]); bps = le16(&b[i + 22u]);
        }
        else if (memcmp(&b[i], "data", 4) == 0)
        {
            dati = &b[i + 8u];
            dati_n = ((i + 8u + size) > n) ? (n - i - 8u) : size;   /* a cut file plays what is there */
            break;
        }
        i += 8u + size + (size & 1u);
    }
    if ((dati == NULL) || (fmt != 1u) || (bps != 16u) || (canali < 1u) || (canali > 2u) || (rate == 0u))
    { free(b); return false; }

    if (effetto)
    {
        /* no resampling: on the device the mixer runs in an interrupt */
        if (rate != 48000u) { free(b); return false; }
    }
    else if (rate > 48000u)
    {
        fprintf(stderr, "audio: %s is %u Hz: the firmware refuses anything above 48000\n", path, rate);
        free(b); return false;
    }

    frames = dati_n / (canali * 2u);
    if (effetto && (frames > (size_t)SFX_MAX_S * 48000u)) { free(b); return false; }

    out->pcm = (int16_t *)malloc(frames * 4u + 4u);
    if (out->pcm == NULL) { free(b); return false; }
    for (k = 0; k < frames; k++)
    {
        const int16_t l = (int16_t)le16(&dati[k * canali * 2u]);
        const int16_t r = (canali == 2u) ? (int16_t)le16(&dati[k * 4u + 2u]) : l;   /* mono is doubled */

        out->pcm[k * 2u] = l; out->pcm[k * 2u + 1u] = r;
    }
    out->frames = frames; out->rate = rate;
    free(b);
    return true;
}

/* --------------------------------------------------------------- music -- */
static orion_result_t au_play(const char *p)
{
    suono_t nuovo;
    size_t len;

    if (!apri()) return ORION_ERR_NOT_FOUND;

    /* MP3 is not supported here */
    len = strlen(p);
    if ((len >= 4u) && (strcmp(&p[len - 4u], ".wav") != 0) && (strcmp(&p[len - 4u], ".WAV") != 0))
    {
        fprintf(stderr, "audio: only WAV in the emulator (%s)\n", p);
        return ORION_ERR_NOT_FOUND;
    }
    if (!carica_wav(p, false, &nuovo)) return ORION_ERR_NOT_FOUND;

    SDL_LockAudioDevice(dev);
    musica_suona = false;
    free(musica.pcm);
    musica = nuovo; musica_pos = 0.0; musica_suona = true;
    SDL_UnlockAudioDevice(dev);
    return ORION_OK;
}

static orion_result_t au_stop(void)
{
    if (!ok) return ORION_OK;
    SDL_LockAudioDevice(dev);
    musica_suona = false;
    SDL_UnlockAudioDevice(dev);
    return ORION_OK;
}

static bool au_playing(void)
{
    bool r;

    if (!ok) return false;
    SDL_LockAudioDevice(dev); r = musica_suona; SDL_UnlockAudioDevice(dev);
    return r;
}

/* one volume, -95..0 dB */
static orion_result_t au_volume(int v)
{
    if (v < -95) v = -95;
    if (v > 0) v = 0;
    volume = powf(10.0f, (float)v / 20.0f);
    return ORION_OK;
}

static int au_position(void)
{
    int ms = 0;

    if (!ok) return 0;
    SDL_LockAudioDevice(dev);
    if (musica.rate != 0u) ms = (int)(musica_pos * 1000.0 / (double)musica.rate);
    SDL_UnlockAudioDevice(dev);
    return ms;
}

static int au_duration(void)
{
    int ms = 0;

    if (!ok) return 0;
    SDL_LockAudioDevice(dev);
    if (musica.rate != 0u) ms = (int)((double)musica.frames * 1000.0 / (double)musica.rate);
    SDL_UnlockAudioDevice(dev);
    return ms;
}

static orion_result_t au_seek(int ms)         { (void)ms; return ORION_ERR_NOT_FOUND; }
static bool           au_bluetooth(void)      { return false; }

/* -------------------------------------------------------- short sounds -- */
static int au_sfx_load(const char *path)
{
    int slot;

    if (!apri()) return -1;
    for (slot = 0; slot < SFX_SLOT; slot++) if (sfx[slot].pcm == NULL) break;
    if (slot == SFX_SLOT) return -1;
    return carica_wav(path, true, &sfx[slot]) ? slot : -1;
}

static void au_sfx_free(int id)
{
    int v;

    if (!ok || (id < 0) || (id >= SFX_SLOT)) return;
    SDL_LockAudioDevice(dev);
    for (v = 0; v < SFX_VOCI; v++) if (voce[v].attiva && (voce[v].id == id)) voce[v].attiva = false;
    free(sfx[id].pcm); sfx[id].pcm = NULL; sfx[id].frames = 0u;
    SDL_UnlockAudioDevice(dev);
}

static bool au_sfx_play(int id, int vol)
{
    int v, scelta = -1;
    size_t meglio = (size_t)-1;

    if (!ok || (id < 0) || (id >= SFX_SLOT) || (sfx[id].pcm == NULL)) return false;
    if (vol < 0) vol = 0;
    if (vol > 255) vol = 255;

    SDL_LockAudioDevice(dev);
    for (v = 0; v < SFX_VOCI; v++) if (!voce[v].attiva) { scelta = v; break; }
    if (scelta < 0)
    {
        /* the fifth voice replaces the one closest to its end */
        for (v = 0; v < SFX_VOCI; v++)
        {
            const size_t resta = sfx[voce[v].id].frames - voce[v].pos;

            if (resta < meglio) { meglio = resta; scelta = v; }
        }
    }
    voce[scelta].id = id; voce[scelta].pos = 0u; voce[scelta].vol = vol; voce[scelta].attiva = true;
    SDL_UnlockAudioDevice(dev);
    return true;
}

static void au_sfx_stop(void)
{
    int v;

    if (!ok) return;
    SDL_LockAudioDevice(dev);
    for (v = 0; v < SFX_VOCI; v++) voce[v].attiva = false;
    SDL_UnlockAudioDevice(dev);
}

const orion_audio_t ORION_AUDIO = {
    .play_file = au_play, .stop = au_stop, .is_playing = au_playing,
    .set_volume = au_volume, .generate = NULL,
    .position_ms = au_position, .duration_ms = au_duration,
    .seek_ms = au_seek, .is_bluetooth = au_bluetooth,
    .sfx_load = au_sfx_load, .sfx_free = au_sfx_free,
    .sfx_play = au_sfx_play, .sfx_stop = au_sfx_stop,
};

static orion_result_t mi_rec(const char *p, orion_mic_src_t s) { (void)p; (void)s; return ORION_ERR_NOT_FOUND; }
static orion_result_t mi_stop(void)                 { return ORION_OK; }
static bool           mi_recording(void)            { return false; }
static int            mi_seconds(void)              { return 0; }
static orion_result_t mi_gain(int g)                { (void)g; return ORION_OK; }
static orion_result_t mi_listen(orion_mic_src_t s, int hz) { (void)s; (void)hz; return ORION_ERR_NOT_FOUND; }
static orion_result_t mi_listen_stop(void)          { return ORION_OK; }
static int            mi_rate(void)                 { return 0; }
static int            mi_level(void)                { return -1; }
static int            mi_read(int16_t *b, int n)    { (void)b; (void)n; return 0; }

const orion_mic_t ORION_MIC = {
    .rec_file = mi_rec, .rec_stop = mi_stop, .is_recording = mi_recording,
    .rec_seconds = mi_seconds, .set_gain = mi_gain,
    .listen = mi_listen, .listen_stop = mi_listen_stop, .rate = mi_rate,
    .level = mi_level, .read_pcm = mi_read,
};
