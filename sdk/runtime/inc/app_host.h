/**
 * @file    app_host.h
 * @brief   Starts, runs and closes apps.
 *
 * One app at a time; leaving an app goes back to the home screen. Holding
 * MENU always closes the running app, so a hung app or one that uses ESC
 * cannot trap the user. The check arms half a second after start, so the
 * press that launched the app does not close it.
 */
#ifndef APP_HOST_H
#define APP_HOST_H

#include "app_iface.h"
#include "keyboard.h"

/** How long MENU must be held, and when the check arms. */
#define APP_FUGA_MS     1000U
#define APP_ARMA_MS      500U

/** Registers an app. Call at boot. */
bool app_host_registra(const app_iface_t *app);

/** Number of registered apps, and the n-th one. */
uint8_t             app_host_quante(void);
const app_iface_t  *app_host_n(uint8_t i);
const app_iface_t  *app_host_per_id(const char *id);

/** Starts an app, closing the running one.
 *  @return false if the id does not exist or init() gave up. */
bool app_host_avvia(const char *id);

/** The same, passing an argument to the new app (sys.launch). */
bool app_host_avvia_arg(const char *id, const char *arg);

/** The argument the running app was launched with, or NULL. */
const char *app_host_argomento(void);

/** Closes the running app. Safe from inside update(): the app closes
 *  when update() returns. */
void app_host_esci(void);

/** True if an app is running. */
bool app_host_attiva(void);

/** The running app, or NULL. */
const app_iface_t *app_host_corrente(void);

/** One frame: filters keys, calls update(), closes if asked. */
void app_host_update(void);

/** update() calls per second; 0 = as fast as possible. */
void app_host_set_fps(int fps);

/** update() calls per second, measured. */
int  app_host_fps(void);

/** The next event for the app (behind orion.input.events()). The MENU
 *  check filters this queue. */
bool app_host_evento(key_event_t *ev);

#endif /* APP_HOST_H */
