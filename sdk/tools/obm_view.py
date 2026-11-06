#!/usr/bin/env python3
"""Turns an .obm back into a PNG, to check it before copying it to the card.

    ./obm_view.py background.obm check.png [--zoom 2]

Dithering is judged by eye. Transparent pixels (where the mask is empty)
come out grey.
"""
import argparse, struct, subprocess, sys, shutil

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--zoom", type=int, default=1)
    a = ap.parse_args()

    if shutil.which("ffmpeg") is None:
        sys.exit("needs ffmpeg:  brew install ffmpeg")

    d = open(a.input, "rb").read()
    if d[:4] != b"OBM1":
        sys.exit(f"{a.input}: not an .obm file (no OBM1 magic)")

    w, h, flags, _, _ = struct.unpack("<HHBBH", d[4:12])
    panel = (flags & 2) != 0

    # Panel layout: bytes per logical column, bits reversed in y. If the
    # picture comes out flipped in groups of eight, the conversion is wrong.
    stride = ((h + 7) // 8) if panel else ((w + 7) // 8)
    count = stride * (w if panel else h)
    expected = 12 + count * (2 if (flags & 1) else 1)
    if len(d) < expected:
        sys.exit(f"{a.input}: {len(d)} bytes, {expected} needed")

    px = d[12:12 + count]
    mk = d[12 + count:] if (flags & 1) else None

    def bit(buf, x, y):
        if panel:
            col = (h - 1) - y
            return buf[x * stride + (col >> 3)] & (0x80 >> (col & 7))
        return buf[y * stride + (x >> 3)] & (0x80 >> (x & 7))

    out = bytearray(w * h)
    for y in range(h):
        for x in range(w):
            if mk is not None and not bit(mk, x, y):
                out[y * w + x] = 128
            else:
                out[y * w + x] = 255 if bit(px, x, y) else 0

    vf = f"scale={w*a.zoom}:{h*a.zoom}:flags=neighbor" if a.zoom > 1 else "null"
    # -update 1 (after the input): a single image, not a numbered sequence
    p = subprocess.run(["ffmpeg", "-v", "error", "-y",
                        "-f", "rawvideo", "-pix_fmt", "gray",
                        "-s", f"{w}x{h}", "-i", "-", "-vf", vf,
                        "-update", "1", a.output],
                       input=bytes(out), capture_output=True)
    if p.returncode != 0:
        sys.exit(p.stderr.decode()[:400])

    note = ""
    if mk is not None: note += "  (with mask: transparent is grey)"
    if a.zoom > 1:     note += f"  zoom {a.zoom}x"
    print(f"{a.output}: {w}x{h}{note}")

if __name__ == "__main__":
    main()
