/**
 * @file  emu_j4.c
 * @brief GPIO and I2C of J4 on the PC.
 *
 * Same rules as the device: an output must be set before it is written, a
 * parked pin cannot be read, I2C must be opened, addresses outside
 * 0x08..0x77 are refused. The bus is empty (every address: "no answer").
 * Outputs are printed when they change; an input reads its pull (1 with
 * pull-up, else 0).
 */
#include "orion_api.h"

#include <stdio.h>

static orion_gpio_mode_t modo[ORION_GPIO_PINS];
static int               livello[ORION_GPIO_PINS];

static orion_result_t gp_mode(int pin, orion_gpio_mode_t m)
{
    if ((pin < 1) || (pin > ORION_GPIO_PINS)) return ORION_ERR_ARG;
    if (((int)m < (int)ORION_GPIO_OFF) || ((int)m > (int)ORION_GPIO_OUT_OD))
        return ORION_ERR_ARG;
    modo[pin - 1]    = m;
    livello[pin - 1] = (m == ORION_GPIO_IN_PULLUP) ? 1 : 0;
    return ORION_OK;
}

static orion_result_t gp_write(int pin, bool alto)
{
    if ((pin < 1) || (pin > ORION_GPIO_PINS)) return ORION_ERR_ARG;
    if ((modo[pin - 1] != ORION_GPIO_OUT) && (modo[pin - 1] != ORION_GPIO_OUT_OD))
        return ORION_ERR_PERMISSION;
    if (livello[pin - 1] != (alto ? 1 : 0))
        printf("gpio: EXT_GPIO%d -> %d\n", pin, alto ? 1 : 0);
    livello[pin - 1] = alto ? 1 : 0;
    return ORION_OK;
}

static int gp_read(int pin)
{
    if ((pin < 1) || (pin > ORION_GPIO_PINS)) return ORION_ERR_ARG;
    if (modo[pin - 1] == ORION_GPIO_OFF) return ORION_ERR_PERMISSION;
    return livello[pin - 1];
}

static void gp_close(void)
{
    for (int i = 0; i < ORION_GPIO_PINS; i++) { modo[i] = ORION_GPIO_OFF; livello[i] = 0; }
}

const orion_gpio_t ORION_GPIO = {
    .mode = gp_mode, .write = gp_write, .read = gp_read, .close = gp_close,
};

static bool i2c_aperto = false;

static orion_result_t i2c_open(int khz)
{
    if (i2c_aperto) return ORION_ERR_BUSY;
    if ((khz != 10) && (khz != 100) && (khz != 400)) return ORION_ERR_ARG;
    i2c_aperto = true;
    printf("i2c: open at %d kHz (emulated bus, empty)\n", khz);
    return ORION_OK;
}

static void i2c_close(void)   { i2c_aperto = false; }
static bool i2c_is_open(void) { return i2c_aperto; }

static int i2c_check(int addr, int wn, int rn)
{
    if (!i2c_aperto) return ORION_ERR_PERMISSION;
    if ((addr < 0x08) || (addr > 0x77)) return ORION_ERR_ARG;
    if ((wn < 0) || (rn < 0) || (wn > 255) || (rn > 255)) return ORION_ERR_ARG;
    return ORION_ERR_NOT_FOUND;              /* nobody on the bus */
}

static int i2c_write(int addr, const void *b, int n)
{
    (void)b;
    return (n == 0) ? 0 : i2c_check(addr, n, 0);
}

static int i2c_read(int addr, void *b, int n)
{
    (void)b;
    return (n == 0) ? 0 : i2c_check(addr, 0, n);
}

static int i2c_write_read(int addr, const void *w, int wn, void *r, int rn)
{
    (void)w; (void)r;
    return i2c_check(addr, wn, rn);
}

static bool i2c_probe(int addr) { (void)addr; return false; }

const orion_i2c_t ORION_I2C = {
    .open = i2c_open, .close = i2c_close, .is_open = i2c_is_open,
    .write = i2c_write, .read = i2c_read, .write_read = i2c_write_read,
    .probe = i2c_probe,
};
