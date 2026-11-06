#ifndef EMU_RK817_RTC_H
#define EMU_RK817_RTC_H
#include <stdint.h>
#include <stdbool.h>

typedef struct {
  uint16_t anno;      /* 2000..2099                                      */
  uint8_t  mese;      /* 1..12                                           */
  uint8_t  giorno;    /* 1..31                                           */
  uint8_t  ora;       /* 0..23                                           */
  uint8_t  minuto;    /* 0..59                                           */
  uint8_t  secondo;   /* 0..59                                           */
  uint8_t  settimana; /* 0..6                                            */
} rk817_time_t;

bool rk817_rtc_cached(rk817_time_t *t);
void rk817_rtc_service(void);
#endif
