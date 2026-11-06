#ifndef EMU_PSRAM_H
#define EMU_PSRAM_H
#include <stdint.h>
#include <stdbool.h>
/* On the PC the 8 MB of PSRAM are ordinary memory. The emulator does not
   reproduce their cost: 488 ns per scattered access on the device. */
extern uint8_t *emu_psram;
/* uintptr_t: on the PC the address is a 64-bit pointer. */
#define PSRAM_MMAP_BASE  ((uintptr_t)emu_psram)
bool psram_ready(void);
bool psram_mmap(void);
bool psram_set_mmap(bool acceso);
const char *psram_status(void);
#endif
