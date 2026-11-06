#!/usr/bin/env python3
"""
obm_panel.py: converts an existing .obm to the panel layout, or back, without
going through the original image again.

    ./obm_panel.py background.obm background_pan.obm
    ./obm_panel.py background_pan.obm background.obm --logical

Running image.py --panel on the PNG again would dither a second time and give
different pixels. This moves the existing bits, mask included, so converting
there and back returns the same file. The format is described in the
image format page of the guide (orionpda.org/sdk).
"""
import argparse
import struct
import sys


def read_obm(path):
    d = open(path, "rb").read()
    if d[:4] != b"OBM1":
        sys.exit(f"{path}: not an .obm file (no OBM1 magic)")
    w, h, flags, _, _ = struct.unpack("<HHBBH", d[4:12])
    panel = (flags & 2) != 0
    stride = ((h + 7) // 8) if panel else ((w + 7) // 8)
    count = stride * (w if panel else h)
    if len(d) < 12 + count * (2 if (flags & 1) else 1):
        sys.exit(f"{path}: truncated file")
    px = d[12:12 + count]
    mk = d[12 + count:12 + count * 2] if (flags & 1) else None
    return w, h, panel, stride, px, mk


def to_panel(w, h, stride, buf):
    s2 = (h + 7) // 8
    out = bytearray(s2 * w)
    for y in range(h):
        col = (h - 1) - y                 # bits reversed: 335 - y
        for x in range(w):
            if buf[y * stride + (x >> 3)] & (0x80 >> (x & 7)):
                out[x * s2 + (col >> 3)] |= 0x80 >> (col & 7)
    return out, s2


def to_logical(w, h, stride, buf):
    s2 = (w + 7) // 8
    out = bytearray(s2 * h)
    for x in range(w):
        for y in range(h):
            col = (h - 1) - y
            if buf[x * stride + (col >> 3)] & (0x80 >> (col & 7)):
                out[y * s2 + (x >> 3)] |= 0x80 >> (x & 7)
    return out, s2


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--logical", action="store_true",
                    help="the reverse: from the panel layout back to rows")
    a = ap.parse_args()

    w, h, panel, stride, px, mk = read_obm(a.input)
    want_panel = not a.logical

    if panel == want_panel:
        sys.exit(f"{a.input} is already in {'panel' if panel else 'logical'} layout")
    if want_panel and (h % 8) != 0:
        sys.exit(f"the panel layout needs a height that is a multiple of 8 (here {h})")

    conv = to_panel if want_panel else to_logical
    npx, _ = conv(w, h, stride, px)
    nmk = conv(w, h, stride, mk)[0] if mk is not None else b""

    with open(a.output, "wb") as f:
        f.write(b"OBM1")
        f.write(struct.pack("<HHBBH", w, h,
                            (1 if mk is not None else 0) |
                            (2 if want_panel else 0), 0, 0))
        f.write(npx)
        f.write(nmk)

    print(f"{a.output}: {w}x{h}, {'panel' if want_panel else 'logical'} layout"
          f"{', with mask' if mk is not None else ''}, "
          f"{12 + len(npx) + len(nmk)} bytes")


if __name__ == "__main__":
    main()
