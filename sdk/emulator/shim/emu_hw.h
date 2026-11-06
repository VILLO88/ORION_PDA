#ifndef EMU_HW_H
#define EMU_HW_H
#include <stdbool.h>
#include <stdint.h>
void emu_accoda(uint8_t code, bool premuto);
extern bool emu_shift, emu_fn;
/* the folder that stands in for the microSD */
extern const char *emu_radice;
#endif
