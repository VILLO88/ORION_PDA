/**
 * @file  emu_math.c
 * @brief orion.math on the PC, with libm. Same results; the speed says
 *        nothing about the device.
 */
#include "orion_api.h"
#include <math.h>

static void ma_sincos(float rad, float *s, float *c)
{
    if (s != NULL) *s = sinf(rad);
    if (c != NULL) *c = cosf(rad);
}

static float ma_atan2(float y, float x) { return atan2f(y, x); }
static float ma_dist(float dx, float dy) { return sqrtf((dx * dx) + (dy * dy)); }

const orion_math_t ORION_MATH = {
    .sincos = ma_sincos,
    .atan2  = ma_atan2,
    .dist   = ma_dist,
};
