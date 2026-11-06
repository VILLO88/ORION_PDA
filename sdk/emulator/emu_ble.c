/**
 * @file  emu_ble.c
 * @brief Bluetooth data on the PC.
 *
 * By default nobody connects: open() works, is_connected() stays false,
 * send() says "not connected", as on the device before a phone connects.
 *
 *     ORION_BLE=eco ./orion-emu card/apps/myapp.lua
 *
 * simulates a connected phone that sends every message back. The same
 * checks as the firmware apply: text only, 1..492 bytes, a 4 KB queue.
 */
#include "orion_api.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CODA_MSG 16

static char coda[CODA_MSG][ORION_BLE_MSG_MAX];
static int  lung[CODA_MSG];
static int  testa = 0, fondo = 0, quanti = 0, persi = 0;
static bool aperto = false;

static bool eco(void)
{
    const char *v = getenv("ORION_BLE");
    return (v != NULL) && (strcmp(v, "eco") == 0);
}

static orion_result_t bl_open(void)
{
    if (aperto) return ORION_ERR_BUSY;
    aperto = true;
    testa = fondo = quanti = persi = 0;
    printf("ble: data channel open%s\n",
           eco() ? " (ORION_BLE=eco: a simulated phone that echoes)" : "");
    return ORION_OK;
}

static void bl_close(void)        { aperto = false; quanti = 0; }
static bool bl_is_open(void)      { return aperto; }
static bool bl_is_connected(void) { return aperto && eco(); }

static int bl_send(const void *buf, int n)
{
    const char *p = buf;

    if (!aperto) return ORION_ERR_PERMISSION;
    if ((buf == NULL) || (n < 1) || (n > ORION_BLE_MSG_MAX)) return ORION_ERR_ARG;
    for (int i = 0; i < n; i++)
    {
        if ((p[i] == '\r') || (p[i] == '\n') || (p[i] == '\0')) return ORION_ERR_ARG;
    }
    if (!bl_is_connected()) return ORION_ERR_NOT_FOUND;

    printf("ble-> %.*s\n", n, p);
    if (quanti == CODA_MSG) { persi++; return n; }
    memcpy(coda[testa], p, (size_t)n);
    lung[testa] = n;
    testa = (testa + 1) % CODA_MSG;
    quanti++;
    return n;
}

static int bl_receive(void *buf, int max)
{
    int n;

    if ((buf == NULL) || (max < 0) || (quanti == 0)) return 0;
    n = (lung[fondo] < max) ? lung[fondo] : max;
    memcpy(buf, coda[fondo], (size_t)n);
    fondo = (fondo + 1) % CODA_MSG;
    quanti--;
    return n;
}

static int         bl_lost(void) { return persi; }
static const char *bl_name(void) { return "ORION-EMU"; }

const orion_ble_t ORION_BLE = {
    .open = bl_open, .close = bl_close, .is_open = bl_is_open,
    .is_connected = bl_is_connected, .send = bl_send, .receive = bl_receive,
    .lost = bl_lost, .name = bl_name,
};
