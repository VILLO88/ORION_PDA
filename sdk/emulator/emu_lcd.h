#ifndef EMU_LCD_H
#define EMU_LCD_H
#include <stdint.h>
#include <stdbool.h>
#include "sharp_ls032.h"

#define EMU_W  536
#define EMU_H  336

extern uint8_t  emu_fb[EMU_H][EMU_W];
extern bool     emu_da_ridisegnare;
extern uint32_t emu_frame_interi;
extern uint32_t emu_frame_parziali;
#endif
