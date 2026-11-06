/**
 * @file  shim/app_power.h
 * @brief Power management on the PC: nothing to do.
 *
 * On the device these reset the inactivity timer that blanks the panel and
 * powers the device off. The runtime calls them itself (app_host,
 * gfx_present), so apps do not have to.
 */
#ifndef APP_POWER_H
#define APP_POWER_H

#include <stdbool.h>

static inline bool app_power_activity(void)     { return false; }
static inline void app_power_attivita_muta(void) { }

#endif /* APP_POWER_H */
