/**
 * @file    app_iface.h
 * @brief   The interface every app implements, built-in or Lua.
 *
 * Three functions, the same a Lua app defines (init, update, close). Keys
 * are read inside update() with app_host_evento(). An app has no loop of its
 * own and does not call the firmware services; the main loop does.
 */
#ifndef APP_IFACE_H
#define APP_IFACE_H

#include "main.h"
#include "orion_api.h"
#include <stdbool.h>

typedef struct {
    const char *id;      /**< short unique id, used by the `app <id>` console command */
    const char *nome;    /**< name shown in the launcher */

    /** Setup, with the API vtable. Return false to give up. */
    bool (*init)(const orion_api_t *api);

    /** Once per main loop turn; aim for ~25 ms. */
    void (*update)(void);

    /** Before the app is unloaded. May never be called (battery removed,
     *  fault): save data when it changes. */
    void (*close)(void);
} app_iface_t;

#endif /* APP_IFACE_H */
