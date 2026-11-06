/* The three FatFs calls app_lua.c uses to read the script, on top of
   stdio, so the runtime file compiles unchanged. */
#ifndef EMU_FF_H
#define EMU_FF_H
#include <stdio.h>
typedef unsigned int UINT;
typedef enum { FR_OK = 0, FR_NO_FILE, FR_DISK_ERR } FRESULT;
typedef struct { FILE *fp; } FIL;
#define FA_READ   0x01
#define FA_WRITE  0x02
FRESULT f_open (FIL *f, const char *path, unsigned char mode);
FRESULT f_read (FIL *f, void *buf, UINT n, UINT *letti);
FRESULT f_close(FIL *f);
#endif
