/**
 * @file    orion_api.h
 * @brief   The API of ORION apps.
 *
 * - The app receives a `const orion_api_t *` and links no firmware symbol.
 *   New functions are only ever added at the end of a struct.
 * - No globals, so the emulator can pass its own vtable.
 * - Coordinates in pixels, origin top left, logical screen 536x336.
 * - 1 bit per pixel: ORION_WHITE = 0, ORION_BLACK = 1.
 * - Strings are zero-terminated `const char *`.
 *
 * The firmware owns the main loop and calls the app's update(); the app has
 * no loop of its own. Keep update() around 25 ms, never above ~150 ms. A
 * full screen update takes 75 ms.
 */
#ifndef ORION_API_H
#define ORION_API_H

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

#define ORION_API_VERSION   0x000200u    /* 0.2.0 added gpio, i2c and ble */

#define ORION_SCREEN_W     536
#define ORION_SCREEN_H     336

#define ORION_WHITE        0u
#define ORION_BLACK          1u

/** Result codes. Negative means error, so `if (r < 0)` is enough. */
typedef enum {
    ORION_OK            =  0,
    ORION_ERR_ARG       = -1,
    ORION_ERR_MEMORY   = -2,
    ORION_ERR_FILE      = -3,
    ORION_ERR_NO_SPACE    = -4,
    ORION_ERR_PERMISSION  = -5,
    ORION_ERR_BUSY  = -6,   /* someone else owns the resource */
    ORION_ERR_NOT_FOUND   = -7
} orion_result_t;

/* ==========================================================================
 *  Graphics
 * ==========================================================================
 * The panel is mounted rotated: a vertical strip of the logical screen is a
 * set of whole physical rows. Updating a narrow vertical strip is cheap; a
 * horizontal one costs as much as the whole screen.
 */
typedef struct orion_bitmap orion_bitmap_t;
typedef struct orion_font   orion_font_t;

typedef struct {
    uint8_t  cell_w;      /* glyph width                         */
    uint8_t  cell_h;      /* glyph height                        */
    uint8_t  advance_w;     /* horizontal step between characters  */
    uint8_t  advance_h;     /* step between two lines              */
} orion_font_metrics_t;

typedef struct {
    /* --- drawing --- */
    void (*clear)(uint8_t color);
    void (*pixel)(int x, int y, uint8_t color);
    void (*line)(int x0, int y0, int x1, int y1, uint8_t color);
    void (*rect)(int x, int y, int w, int h, uint8_t color);
    void (*fill_rect)(int x, int y, int w, int h, uint8_t color);

    /**
     * @brief Pattern used by fill_rect() instead of the colour.
     * @param pat 8 bytes (an 8x8 tile, 1 = white), or NULL for solid colour.
     *
     * Patterns are the greys of a 1-bit screen. They are anchored to the
     * screen, not to the shape. A fine checkerboard that scrolls by one
     * pixel flickers: scroll by two.
     */
    void (*set_pattern)(const uint8_t *pat);

    /* --- text --- */
    /** System font: 0 = 5x7, 1 = 8x8, 2 = 6x12. */
    const orion_font_t *(*system_font)(int n);
    void (*set_font)(const orion_font_t *f);
    void (*font_metrics)(const orion_font_t *f, orion_font_metrics_t *out);

    /** `scale` multiplies the glyph pixels. */
    void (*text)(int x, int y, const char *s, uint8_t color, int scale);
    int  (*text_width)(const char *s, int scale);

    /* --- images --- */
    orion_bitmap_t *(*bitmap_load)(const char *path);
    void            (*bitmap_free)(orion_bitmap_t *b);
    void            (*bitmap_draw)(int x, int y, const orion_bitmap_t *b);
    void            (*bitmap_size)(const orion_bitmap_t *b, int *w, int *h);

    /* --- to the screen --- */
    /** Sends the frame to the screen over DMA, without waiting.
     *  @return false if refused because the previous transfer is still
     *          running. Do not ignore it. */
    bool (*present)(void);
    /** Sends only the vertical strip that contains the rectangle (y and h
     *  are ignored). The way to go faster than ~13 full frames a second. */
    bool (*present_area)(int x, int y, int w, int h);

    /** Clipping rectangle for everything drawn from now on. */
    void (*set_clip)(int x, int y, int w, int h);
    void (*clear_clip)(void);
} orion_gfx_t;

/* ==========================================================================
 *  Input
 * ==========================================================================
 * Events, kept in a 32-event queue, so fast typing between two frames is not
 * lost. update() should drain it.
 */
typedef enum {
    ORION_KEY_DOWN = 0,
    ORION_KEY_UP,
} orion_event_kind_t;

/* keys without a character; the others arrive in `ch` */
enum {
    ORION_K_NONE = 0,
    ORION_K_ESC = 0xA0, ORION_K_ENTER, ORION_K_DEL, ORION_K_BACK,
    ORION_K_UP, ORION_K_DOWN, ORION_K_LEFT, ORION_K_RIGHT,
    ORION_K_MENU, ORION_K_SAVE, ORION_K_SEARCH,
    ORION_K_PLAY, ORION_K_NEXT, ORION_K_PREV,
    ORION_K_VOL_UP, ORION_K_VOL_DOWN, ORION_K_MUTE,
    ORION_K_SHIFT, ORION_K_FN
};

typedef struct {
    orion_event_kind_t kind;
    uint8_t  key;        /* one of ORION_K_*, or 0 if it is a character  */
    uint8_t  ch;    /* ASCII, or 0x80..0x87 (accents, £, €)          */
    bool     shift;
    bool     fn;
    uint32_t ms;           /* when it happened, in ms                       */
} orion_event_t;

typedef struct {
    /** @return false when the queue is empty. */
    bool (*read)(orion_event_t *out);
    /** Current state of a key, for polling. */
    bool (*is_down)(uint8_t key);
} orion_input_t;

/* ==========================================================================
 *  Files
 * ==========================================================================
 * Paths are relative to two roots:
 *   data/    the app's own folder, read and write;
 *   shared/  the whole microSD (music, notes, books, recordings).
 * Absolute paths and `..` are refused. This protects against mistakes, it
 * is not a security boundary.
 */
typedef struct orion_file orion_file_t;

typedef enum {
    ORION_READ  = 0,
    ORION_WRITE = 1,      /* truncates if it exists, creates if not */
    ORION_APPEND = 2
} orion_mode_t;

/** A folder entry, with size and date so a listing needs no extra
 *  card accesses. */
typedef struct {
    const char *name;      /**< valid until the next call           */
    bool        is_dir;
    int         size;
    uint32_t    modified;  /**< seconds since 1/1/2000, 0 if unknown */
} orion_entry_t;

typedef struct {
    orion_file_t *(*open)(const char *path, orion_mode_t mode);
    int           (*read)(orion_file_t *f, void *buf, int n);
    int           (*write)(orion_file_t *f, const void *buf, int n);
    orion_result_t   (*close)(orion_file_t *f);
    orion_result_t   (*remove)(const char *path);
    orion_result_t   (*rename)(const char *da, const char *a);
    bool          (*exists)(const char *path);
    int           (*size)(const char *path);

    /** `i` from 0 up; false at the end of the folder. */
    bool (*list)(const char *dir, int i, orion_entry_t *out);

    orion_result_t (*make_dir)(const char *path);

    int         (*read_all)(const char *path, void *buf, int n);
    orion_result_t (*write_all)(const char *path, const void *buf, int n);

    /** Free bytes on the card: check before writing something large. */
    int64_t (*free_space)(void);
} orion_fs_t;

/* ==========================================================================
 *  App preferences
 * ==========================================================================
 * Key-value pairs that survive power-off, stored in the app's data/ folder.
 */
typedef struct {
    int  (*get_int)(const char *key, int fallback);
    void (*set_int)(const char *key, int value);
    int  (*get_str)(const char *key, char *buf, int n, const char *fallback);
    void (*set_str)(const char *key, const char *value);
} orion_pref_t;

/* ==========================================================================
 *  Audio
 * ==========================================================================
 * The audio chain has one owner at a time. If it is busy the functions
 * return ORION_ERR_BUSY: tell the user.
 */
typedef struct {
    orion_result_t (*play_file)(const char *path);   /* WAV or MP3, up to 48 kHz */
    orion_result_t (*stop)(void);
    bool        (*is_playing)(void);
    orion_result_t (*set_volume)(int db);                 /* -95..0 dB */

    /** 16-bit PCM generated by the app. `fill` is called from an interrupt:
     *  nothing slow and no I/O inside it. */
    orion_result_t (*generate)(int freq_hz, bool stereo,
                          void (*fill)(int16_t *buf, int frame, void *ctx),
                          void *ctx);

    /** Position and length of the current track, in ms. */
    int (*position_ms)(void);
    int (*duration_ms)(void);
    orion_result_t (*seek_ms)(int ms);

    /** True if the output is a Bluetooth device instead of the jack. */
    bool (*is_bluetooth)(void);

    /* ----------------------------------------------------------------------
     * Short sounds
     * ----------------------------------------------------------------------
     * Mixed in the last stage before the output, so they play with or
     * without music, up to four at once. WAV 48 kHz 16 bit, mono or stereo,
     * at most 5 seconds; tools/sound.py converts. One second of sound uses
     * 192 kB of the app's memory.
     */

    /** Loads a short WAV. Returns its id, or -1. */
    int  (*sfx_load)(const char *path);

    /** Frees it; voices playing it stop. */
    void (*sfx_free)(int id);

    /** Plays it, `vol` 0..255. With four voices busy, the one closest to
     *  its end is replaced. */
    bool (*sfx_play)(int id, int vol);

    /** Stops all voices; the sounds stay loaded. */
    void (*sfx_stop)(void);

    /* MP3 decoding and the codec belong to the firmware. The codec runs at
       48 kHz: lower rates are resampled, higher ones refused. */
} orion_audio_t;

/* ==========================================================================
 *  System
 * ========================================================================== */
typedef struct {
    uint32_t (*ms)(void);              /* since power-on                     */
    void     (*date_time)(int *anno, int *mese, int *giorno,
                         int *ora, int *min, int *sec);
    int      (*battery)(void);        /* 0..100, -1 if unknown             */
    bool     (*is_charging)(void);
    const char *(*version)(void);     /* firmware version                  */

    /** Closes the app and returns to the launcher. Does not return. */
    void (*exit)(void);

    /** Closes this app and starts another, passing `arg` (or NULL). Does
     *  not return. */
    void (*launch)(const char *app_id, const char *arg);

    /** The `arg` this app was launched with, or NULL. */
    const char *(*argument)(void);

    /** Shows or hides the system status bar. */
    void (*status_bar)(bool show);

    /** The area the app can draw in, below the status bar. */
    void (*content_area)(int *x, int *y, int *w, int *h);

    /** Writes a line to the USB console (the terminal in the emulator). */
    void (*log)(const char *fmt, ...);

    /**
     * @brief How many times a second update() is called.
     * @param fps 1..60, or 0 = as often as possible (the default).
     *
     * A ceiling: if update() takes longer, frames get longer. The time left
     * over goes to the firmware's own work (audio, recording, panel).
     */
    void (*set_fps)(int fps);

    /** How many times a second update() actually runs. */
    int  (*fps)(void);
} orion_sys_t;

/* ==========================================================================
 *  Microphone and recording
 * ==========================================================================
 * Two sources: the internal microphone and the headset's. Asking for the
 * headset when none is plugged in returns ORION_ERR_NOT_FOUND.
 * rec_file() writes a WAV; level() returns a ready-made level; read_pcm()
 * gives the samples in blocks at the rate chosen with listen().
 */
typedef enum {
    ORION_MIC_INTERNAL = 0,
    ORION_MIC_HEADSET  = 1
} orion_mic_src_t;

typedef struct {
    /** Records a 48 kHz mono WAV file. */
    orion_result_t (*rec_file)(const char *path, orion_mic_src_t src);
    orion_result_t (*rec_stop)(void);
    bool           (*is_recording)(void);
    int            (*rec_seconds)(void);

    /** Sensitivity 0..4. */
    orion_result_t (*set_gain)(int step);

    /** Starts listening without writing a file, at `rate_hz` samples per
     *  second. The rate must be 48000 divided by an integer (48000, 24000,
     *  16000, 12000, 9600, 8000, ...); others return ORION_ERR_ARG. The
     *  firmware averages the samples it merges, a simple low-pass filter. */
    orion_result_t (*listen)(orion_mic_src_t src, int rate_hz);
    orion_result_t (*listen_stop)(void);
    int            (*rate)(void);   /**< the rate actually in use */

    /** Input level 0..1000. */
    int (*level)(void);

    /** Samples at the listen() rate, in blocks.
     *  @return frames stored, 0 if none were ready. */
    int (*read_pcm)(int16_t *buf, int frames);
} orion_mic_t;

/* ==========================================================================
 *  Memory
 * ==========================================================================
 * For large contiguous blocks (an image, an audio buffer, a table). PSRAM is
 * fast in blocks (30 MB/s with memcpy) and slow for scattered reads (488 ns
 * each); data read at random belongs in the small internal SRAM, so alloc()
 * tells where the block went.
 */
typedef enum {
    ORION_MEM_ANY  = 0,   /* usually PSRAM                      */
    ORION_MEM_FAST = 1    /* internal SRAM, small              */
} orion_mem_kind_t;

typedef struct {
    void  *(*alloc)(int bytes, orion_mem_kind_t kind);
    void   (*free)(void *p);
    bool   (*is_fast)(const void *p);   /**< true = SRAM, false = PSRAM */

    /** Free space, largest block. */
    int    (*free_fast)(void);
    int    (*free_large)(void);
} orion_mem_t;

/* ==========================================================================
 *  Maths
 * ==========================================================================
 * The FPU has square root but no trigonometry. The CORDIC coprocessor does
 * sine and cosine together in a few cycles; the conversions it needs (q1.31,
 * angle / pi) are done here.
 */
typedef struct {
    /** Sine and cosine of an angle in radians, any value (wrapped into
     *  [-pi, pi]). */
    void  (*sincos)(float rad, float *sin, float *cos);

    /** The angle of a vector, like atan2(y, x). */
    float (*atan2)(float y, float x);

    /** sqrt(dx*dx + dy*dy), with the FPU's VSQRT instruction. */
    float (*dist)(float dx, float dy);
} orion_math_t;

/* ==========================================================================
 *  Dialogs
 * ==========================================================================
 * Drawn by the firmware, so they look the same in every app. The call opens
 * the dialog and returns; the answer arrives in the callback. While a dialog
 * is open the app gets no update(). In Lua a coroutine makes them look
 * blocking.
 */
typedef void (*orion_text_cb_t)(const char *testo, void *ctx);  /* NULL = cancelled */
typedef void (*orion_yesno_cb_t)(bool yes, void *ctx);
typedef void (*orion_choice_cb_t)(int index, void *ctx);        /* <0 = cancelled */

typedef struct {
    void (*confirm)(const char *question, orion_yesno_cb_t cb, void *ctx);
    void (*ask_text)(const char *title, const char *initial,
                         orion_text_cb_t cb, void *ctx);
    void (*choose)(const char *title, const char *const *items, int n,
                   orion_choice_cb_t cb, void *ctx);

    /** A message that closes by itself after a few seconds. */
    void (*notice)(const char *testo);
} orion_ui_t;


/* ==========================================================================
 *  Serial port on J4
 * ==========================================================================
 * USART1 on the expansion connector (pin numbers per board revision in
 * the reference at orionpda.org/sdk).
 *
 * open() powers +3V3_EXT (shared with gpio and i2c) first, then enables the
 * pins: a pin driven into an unpowered module would feed it through its
 * protection diode. close() does the reverse, and the firmware calls it when
 * the app exits.
 *
 * Reception is buffered (4 KB, by interrupt): reading once per update()
 * loses nothing while a frame stays under ~350 ms at 115200 baud. Dropped
 * bytes are counted by lost(). write() blocks until sent: 512 bytes at
 * 115200 take 44 ms.
 */
typedef struct {
    /** @param baud 1200..921600. @return ORION_ERR_BUSY if already open. */
    orion_result_t (*open)(int baud);
    void           (*close)(void);
    bool           (*is_open)(void);
    /** @return bytes written, <0 on error. */
    int            (*write)(const void *buf, int n);
    /** Never waits. @return bytes copied, 0 if nothing arrived. */
    int            (*read)(void *buf, int n);
    int            (*available)(void);
    /** Bytes dropped because the buffer was full, since open(). */
    int            (*lost)(void);
} orion_serial_t;

/* ==========================================================================
 *  GPIO on J4
 * ==========================================================================
 * The four free lines, numbered 1..4 by signal name (EXT_GPIO1..4), which
 * does not change between board revisions. +3V3_EXT comes up with the first
 * pin in use. Outputs start low. 3.3 V logic, a few mA per pin. Timing is
 * the app's frame rate: not for bit-banging protocols.
 */
typedef enum {
    ORION_GPIO_OFF         = 0,  /* parked, draws nothing             */
    ORION_GPIO_IN          = 1,
    ORION_GPIO_IN_PULLUP   = 2,  /* internal, ~40 kOhm                */
    ORION_GPIO_IN_PULLDOWN = 3,
    ORION_GPIO_OUT         = 4,  /* push-pull, starts low             */
    ORION_GPIO_OUT_OD      = 5   /* open drain: low or released       */
} orion_gpio_mode_t;

#define ORION_GPIO_PINS 4

typedef struct {
    /** @param pin 1..ORION_GPIO_PINS.
     *  @return ORION_ERR_PERMISSION if the supply did not come up. */
    orion_result_t (*mode)(int pin, orion_gpio_mode_t m);
    /** @return ORION_ERR_PERMISSION if the pin is not an output. */
    orion_result_t (*write)(int pin, bool high);
    /** Pin level, 0 or 1; <0 for a bad or parked pin. */
    int            (*read)(int pin);
    /** All pins off. The firmware calls it when the app exits. */
    void           (*close)(void);
} orion_gpio_t;

/* ==========================================================================
 *  I2C on J4
 * ==========================================================================
 * I2C4, master only, 7-bit addresses, 2.2 kOhm pull-ups on the board. Each
 * call is a complete transaction and blocks: 16 bytes at 100 kHz take
 * ~1.6 ms, nothing waits more than ~25 ms. No answer = ORION_ERR_NOT_FOUND.
 */
typedef struct {
    /** @param khz 10, 100 or 400. Powers +3V3_EXT.
     *  @return ORION_ERR_BUSY if already open, ORION_ERR_ARG on speed. */
    orion_result_t (*open)(int khz);
    void           (*close)(void);
    bool           (*is_open)(void);
    /** @return bytes written, or <0: NOT_FOUND = no ACK, FILE = bus error. */
    int            (*write)(int addr, const void *buf, int n);
    /** @return bytes read, or <0 as above. */
    int            (*read)(int addr, void *buf, int n);
    /** Write then read with a repeated start: the usual register read.
     *  @return bytes read, or <0. */
    int            (*write_read)(int addr, const void *w, int wn,
                                 void *r, int rn);
    /** true if a device ACKs `addr`. */
    bool           (*probe)(int addr);
} orion_i2c_t;

/* ==========================================================================
 *  Bluetooth data
 * ==========================================================================
 * A phone or PC connects to ORION over BLE (Feasycom transparent service
 * 0xFFF0, write 0xFFF2, notify 0xFFF1) or classic SPP, then the two exchange
 * text messages. Each send() is one notification, each write from the other
 * side one receive(). CR, LF and NUL are not allowed; send binary data as
 * base64 or hex. Up to 492 bytes, but a write longer than the link MTU is
 * cut on the phone side: 180 bytes is safe (macOS negotiates 185).
 * While an app holds the channel the Companion cannot transfer files.
 */
#define ORION_BLE_MSG_MAX 492

typedef struct {
    /** Powers the module if needed and routes incoming messages to the app.
     *  @return ORION_ERR_BUSY if a Companion transfer is running,
     *          ORION_ERR_NOT_FOUND if the module does not answer. */
    orion_result_t (*open)(void);
    /** Releases the channel; powers the module off only if open() powered
     *  it and no speaker is connected. */
    void           (*close)(void);
    bool           (*is_open)(void);
    /** A phone or PC is connected. */
    bool           (*is_connected)(void);
    /** Sends one message. @return n; ORION_ERR_ARG on CR/LF/NUL or size,
     *  ORION_ERR_NOT_FOUND if nobody is connected. */
    int            (*send)(const void *buf, int n);
    /** The oldest message, at most `max` bytes (the rest is dropped).
     *  @return its length, 0 if none. */
    int            (*receive)(void *buf, int max);
    /** Messages dropped because the 4 KB queue was full. */
    int            (*lost)(void);
    /** The name the module advertises. */
    const char    *(*name)(void);
} orion_ble_t;

/* ==========================================================================
 *  The vtable
 * ========================================================================== */
typedef struct {
    uint32_t             version;     /* ORION_API_VERSION of the firmware */
    const orion_gfx_t   *gfx;
    const orion_input_t *input;
    const orion_fs_t    *fs;
    const orion_pref_t  *pref;
    const orion_audio_t *audio;
    const orion_mic_t   *mic;
    const orion_mem_t   *mem;
    const orion_sys_t   *sys;
    const orion_ui_t    *ui;
    const orion_math_t  *math;
    const orion_serial_t *serial;   /* NULL without J4 */
    /* since 0.2.0: check `version` before using them */
    const orion_gpio_t   *gpio;     /* NULL without J4 */
    const orion_i2c_t    *i2c;      /* NULL without J4 */
    const orion_ble_t    *ble;      /* NULL without the module */
} orion_api_t;

/* ==========================================================================
 *  The app contract
 * ==========================================================================
 * In C; in Lua they are three global functions with the same names.
 *
 *   orion_init()     once, at the start. Return < 0 to give up.
 *   orion_update()   every frame.
 *   orion_close()    before the app is unloaded.
 *
 * orion_close() may never be called (battery removed, fault): save data
 * when it changes.
 */
int  orion_init(const orion_api_t *api);
void orion_update(void);
void orion_close(void);

/* ==========================================================================
 *  Firmware side: how the firmware gets the vtable. Not part of the app API.
 * ========================================================================== */
const orion_api_t *orion_api(void);

#endif /* ORION_API_H */
