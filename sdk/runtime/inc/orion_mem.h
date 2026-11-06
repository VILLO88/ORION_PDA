/**
 * @file    orion_mem.h
 * @brief   Memory blocks for apps: fast SRAM, large PSRAM.
 *
 * Apps do not use malloc: they get two reserves of their own, emptied when
 * the app closes, so a leak only affects the app that has it.
 */
#ifndef ORION_MEM_H
#define ORION_MEM_H

#include "orion_api.h"

#ifdef __cplusplus
extern "C" {
#endif

extern const orion_mem_t ORION_MEM;

/**
 * Frees everything. app_host calls it when an app closes.
 */
void orion_mem_reset(void);

/** Bytes in use and number of pieces, for the console. */
void orion_mem_stato(uint32_t *sram_uso, uint32_t *sram_tot,
                     uint32_t *psram_uso, uint32_t *psram_tot);

#ifdef __cplusplus
}
#endif
#endif /* ORION_MEM_H */
