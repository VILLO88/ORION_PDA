/**
 * @file    orion_ui.h
 * @brief   The system dialogs: confirm, text input, choice.
 *
 * Every app asks questions the same way. The call opens the dialog and
 * returns; the answer arrives in a callback a few frames later, so the main
 * loop never waits. Lua apps see a blocking call: the binding suspends the
 * coroutine until the answer.
 */
#ifndef ORION_UI_H
#define ORION_UI_H

#include <stdbool.h>
#include "orion_api.h"

#ifdef __cplusplus
extern "C" {
#endif

/** The vtable given to apps. */
extern const orion_ui_t ORION_UI;

/** True while a dialog is on screen: the app neither runs nor draws. */
bool orion_ui_attivo(void);

/**
 * One step of the dialog: reads keys, redraws if needed, calls the callback
 * on an answer. Called by app_host_update() instead of the app's update().
 */
void orion_ui_passo(void);

/**
 * Closes an open dialog without calling the callback, for when the app
 * ends with a dialog on screen.
 */
void orion_ui_annulla(void);

#ifdef __cplusplus
}
#endif
#endif /* ORION_UI_H */
