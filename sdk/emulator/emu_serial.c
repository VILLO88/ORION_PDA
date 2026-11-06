/**
 * @file  emu_serial.c
 * @brief The J4 serial port on the PC, mapped to a real serial port:
 *
 *     ORION_SERIAL=/dev/cu.usbmodem1101 ./orion-emu card/apps/myapp.lua
 *
 * Without the variable open() fails.
 *
 * Windows: not available yet (termios is POSIX only), open() says so and
 * fails like a missing port. Only orion.serial is affected.
 */
#include "orion_api.h"

#ifdef _WIN32

#include <stdio.h>

static orion_result_t se_open(int baud)
{
    (void)baud;
    printf("serial: not available in the Windows build of the emulator\n");
    return ORION_ERR_NOT_FOUND;
}
static void se_close(void)                    { }
static bool se_is_open(void)                  { return false; }
static int  se_write(const void *b, int n)    { (void)b; (void)n; return ORION_ERR_PERMISSION; }
static int  se_read(void *b, int n)           { (void)b; (void)n; return 0; }
static int  se_available(void)                { return 0; }
static int  se_lost(void)                     { return 0; }

#else

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>

static int fd = -1;
static int persi = 0;

static speed_t velocita(int baud)
{
    switch (baud)
    {
    case 9600:   return B9600;
    case 19200:  return B19200;
    case 38400:  return B38400;
    case 57600:  return B57600;
    case 115200: return B115200;
    case 230400: return B230400;
    default:     return 0;
    }
}

static orion_result_t se_open(int baud)
{
    const char *dev = getenv("ORION_SERIAL");
    struct termios t;
    speed_t v;

    if (fd >= 0) return ORION_ERR_BUSY;
    v = velocita(baud);
    if (v == 0) return ORION_ERR_ARG;
    if (dev == NULL)
    {
        printf("serial: ORION_SERIAL not set, no port\n");
        return ORION_ERR_NOT_FOUND;
    }

    fd = open(dev, O_RDWR | O_NOCTTY | O_NONBLOCK);
    if (fd < 0)
    {
        printf("serial: %s: %s\n", dev, strerror(errno));
        return ORION_ERR_NOT_FOUND;
    }

    tcgetattr(fd, &t);
    cfmakeraw(&t);
    cfsetispeed(&t, v);
    cfsetospeed(&t, v);
    t.c_cflag |= (CLOCAL | CREAD);
    t.c_cflag &= ~(tcflag_t)CRTSCTS;
    tcsetattr(fd, TCSANOW, &t);
    tcflush(fd, TCIOFLUSH);

    persi = 0;
    printf("serial: %s open at %d baud\n", dev, baud);
    return ORION_OK;
}

static void se_close(void)
{
    if (fd < 0) return;
    close(fd);
    fd = -1;
    printf("serial: closed\n");
}

static bool se_is_open(void) { return fd >= 0; }

static int se_write(const void *buf, int n)
{
    const char *p = buf;
    int fatti = 0;

    if (fd < 0) return ORION_ERR_PERMISSION;
    while (fatti < n)
    {
        const ssize_t r = write(fd, p + fatti, (size_t)(n - fatti));

        if (r > 0) { fatti += (int)r; continue; }
        if ((r < 0) && (errno == EAGAIN)) { usleep(1000); continue; }
        break;
    }
    return fatti;
}

static int se_read(void *buf, int n)
{
    ssize_t r;

    if ((fd < 0) || (n <= 0)) return 0;
    r = read(fd, buf, (size_t)n);
    return (r > 0) ? (int)r : 0;
}

static int se_available(void)
{
    int n = 0;

    if ((fd < 0) || (ioctl(fd, FIONREAD, &n) < 0)) return 0;
    return n;
}
static int se_lost(void)      { return persi; }

#endif /* _WIN32 */

const orion_serial_t ORION_SERIAL = {
    .open      = se_open,
    .close     = se_close,
    .is_open   = se_is_open,
    .write     = se_write,
    .read      = se_read,
    .available = se_available,
    .lost      = se_lost,
};
