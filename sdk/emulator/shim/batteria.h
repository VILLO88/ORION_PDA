#ifndef EMU_BATTERIA_H
#define EMU_BATTERIA_H
#include <stdint.h>
#include <stdbool.h>
typedef struct { bool valido; uint16_t mv; int16_t ma; bool in_carica; } batteria_t;
const batteria_t *batteria_ultima(void);
uint8_t           batteria_soc(void);
#endif
