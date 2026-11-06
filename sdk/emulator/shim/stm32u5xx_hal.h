/* the few HAL definitions the runtime files use */
#ifndef EMU_HAL_H
#define EMU_HAL_H
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
typedef enum { HAL_OK = 0, HAL_ERROR, HAL_BUSY, HAL_TIMEOUT } HAL_StatusTypeDef;
/* peripheral handles, named in some firmware headers, never used */
typedef struct { int nulla; } TIM_HandleTypeDef;
typedef struct { int nulla; } SPI_HandleTypeDef;
typedef struct { int nulla; } I2C_HandleTypeDef;
typedef struct { int nulla; } SD_HandleTypeDef;

typedef struct { int nulla; } SAI_HandleTypeDef;
typedef struct { int nulla; } MDF_HandleTypeDef;
typedef struct { int nulla; } MDF_FilterConfigTypeDef;
typedef struct { int nulla; } OSPI_HandleTypeDef;

/* The Cortex-M cycle counter, used by orion_lua.c for timing. Stays at 0
   on the PC: those measurements only mean something on the device. */
typedef struct { volatile uint32_t CTRL; volatile uint32_t CYCCNT; } DWT_Type;
extern DWT_Type emu_dwt;
#define DWT (&emu_dwt)

#define __DSB()   do { } while (0)
#define __ISB()   do { } while (0)
#define __NOP()   do { } while (0)

uint32_t HAL_GetTick(void);
void     HAL_Delay(uint32_t ms);
#endif
