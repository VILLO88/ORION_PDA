/**
 * @file    orion_fs.h
 * @brief   Filesystem hooks for whoever hosts an app.
 */
#ifndef ORION_FS_H
#define ORION_FS_H

#include <stdbool.h>
#include "orion_api.h"

/** The file vtable, implemented by the platform: FatFs on the board,
 *  stdio in the emulator. */
extern const orion_fs_t ORION_FS;

/** Sets the name of the app's data/ folder (for Lua, the script name). */
void orion_fs_set_dati(const char *nome);

/** Closes files the app left open. Call whenever an app ends. */
void orion_fs_chiudi_tutto(void);

/** Turns an app path (data/..., shared/...) into a card path. Audio uses
 *  it too, so playing a file cannot escape the sandbox. */
bool orion_fs_traduci(const char *in, char *out, unsigned n, bool per_scrivere);

#endif /* ORION_FS_H */
