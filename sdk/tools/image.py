#!/usr/bin/env python3
"""Converts an image to ORION's .obm format.

    ./image.py background.png background.obm --width 536 --height 336
    ./image.py ship.png ship.obm --mask

The dithering algorithms and the brightness/contrast/gamma formula are the
same as the Companion app's, so a picture looks the same in an ebook and in
an app. ffmpeg decodes the image and computes the grey (BT.601 luma).

Needs ffmpeg.
"""
import argparse, struct, subprocess, sys, shutil

MAGIC = b"OBM1"

BAYER4 = [v / 16 for v in [
    0, 8, 2, 10,
    12, 4, 14, 6,
    3, 11, 1, 9,
    15, 7, 13, 5,
]]
BAYER8 = [v / 64 for v in [
    0, 32, 8, 40, 2, 34, 10, 42,
    48, 16, 56, 24, 50, 18, 58, 26,
    12, 44, 4, 36, 14, 46, 6, 38,
    60, 28, 52, 20, 62, 30, 54, 22,
    3, 35, 11, 43, 1, 33, 9, 41,
    51, 19, 59, 27, 49, 17, 57, 25,
    15, 47, 7, 39, 13, 45, 5, 37,
    63, 31, 55, 23, 61, 29, 53, 21,
]]


def read_gray(path, w, h, alpha=False):
    """Decodes the image with ffmpeg and returns w*h grey bytes."""
    vf = f"scale={w}:{h}:flags=lanczos"
    if alpha:
        vf += ",format=rgba,alphaextract"   # alphaextract needs an alpha format first
    vf += ",format=gray"

    cmd = ["ffmpeg", "-v", "error", "-i", path, "-vf", vf,
           "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"]
    p = subprocess.run(cmd, capture_output=True)
    if p.returncode != 0 or len(p.stdout) < w * h:
        return None
    return bytearray(p.stdout[:w * h])


def adjust(gray, brightness, contrast, gamma, invert):
    if (brightness == 0 and contrast == 1.0 and gamma == 1.0 and not invert):
        return gray
    gamma_inv = 1.0 / max(gamma, 1e-3)
    use_gamma = abs(gamma - 1) > 1e-3
    out = bytearray(len(gray))
    for i, g in enumerate(gray):
        v = (g - 128) * contrast + 128 + brightness
        v = 0.0 if v < 0 else (255.0 if v > 255 else v)
        if use_gamma:
            v = 255 * ((v / 255) ** gamma_inv)
            v = 0.0 if v < 0 else (255.0 if v > 255 else v)
        out[i] = int(255 - v) if invert else int(v)
    return out


def dither(gray, w, h, mode, threshold):
    """Returns one byte per pixel: 1 = white, 0 = black."""
    bw = bytearray(w * h)

    if mode == "threshold":
        for i, g in enumerate(gray):
            bw[i] = 1 if g >= threshold else 0

    elif mode in ("bayer4", "bayer8"):
        mat, n = (BAYER4, 4) if mode == "bayer4" else (BAYER8, 8)
        for y in range(h):
            my = (y % n) * n
            base = y * w
            for x in range(w):
                bw[base + x] = 1 if gray[base + x] / 255 > mat[my + (x % n)] else 0

    elif mode == "atkinson":
        work = [float(v) for v in gray]
        for y in range(h):
            for x in range(w):
                i = y * w + x
                old = work[i]
                white = old >= 128
                bw[i] = 1 if white else 0
                err = (old - (255 if white else 0)) / 8
                if x + 1 < w: work[i + 1] += err
                if x + 2 < w: work[i + 2] += err
                if y + 1 < h:
                    if x > 0:     work[i + w - 1] += err
                    work[i + w] += err
                    if x + 1 < w: work[i + w + 1] += err
                if y + 2 < h:     work[i + 2 * w] += err

    else:   # Floyd-Steinberg, the default
        work = [float(v) for v in gray]
        for y in range(h):
            base = y * w
            for x in range(w):
                i = base + x
                old = work[i]
                white = old >= 128
                bw[i] = 1 if white else 0
                err = old - (255 if white else 0)
                if x + 1 < w: work[i + 1] += err * 7 / 16
                if y + 1 < h:
                    if x > 0:     work[i + w - 1] += err * 3 / 16
                    work[i + w] += err * 5 / 16
                    if x + 1 < w: work[i + w + 1] += err * 1 / 16
    return bw


def pack(bw, w, h):
    """1 bit per pixel, most significant bit = leftmost pixel, rows padded
    to a whole byte."""
    stride = (w + 7) // 8
    out = bytearray(stride * h)
    for y in range(h):
        rb, ob = y * w, y * stride
        for x in range(w):
            if bw[rb + x]:
                out[ob + (x >> 3)] |= 0x80 >> (x & 7)
    return out, stride


def pack_panel(bw, w, h):
    """Like pack(), but in the panel's layout, so the device copies bytes
    instead of transposing bits while drawing.

    The panel is rotated 270 degrees: the physical column is 335 - y, so the
    data is stored by logical column and the bits are reversed in y (the
    first byte holds the last row). If an image comes out flipped in groups
    of eight, this is where to look.
    """
    stride = (h + 7) // 8          # bytes per logical column
    out = bytearray(stride * w)
    for x in range(w):
        ob = x * stride
        for y in range(h):
            if bw[y * w + x]:
                col = (h - 1) - y
                out[ob + (col >> 3)] |= 0x80 >> (col & 7)
    return out, stride


def main():
    ap = argparse.ArgumentParser(description="image -> .obm for ORION")
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--width",  type=int, default=0)
    ap.add_argument("--height", type=int, default=0)
    ap.add_argument("--dither", default="fs",
                    choices=["fs", "atkinson", "bayer4", "bayer8", "threshold"],
                    help="default fs (Floyd-Steinberg)")
    ap.add_argument("--threshold",  type=int,   default=128,
                    help="cut level for --dither threshold, 0..255")
    ap.add_argument("--brightness", type=float, default=0.0)
    ap.add_argument("--contrast",   type=float, default=1.0)
    ap.add_argument("--gamma",      type=float, default=1.0)
    ap.add_argument("--invert",     action="store_true")
    ap.add_argument("--panel", action="store_true",
                    help="store the data in the panel's layout: drawing becomes "
                         "a copy instead of a transposition (much faster). Needs "
                         "a height that is a multiple of 8")
    ap.add_argument("--mask", action="store_true",
                    help="use the alpha channel as transparency")
    a = ap.parse_args()

    if shutil.which("ffmpeg") is None:
        sys.exit("needs ffmpeg:  brew install ffmpeg")

    w, h = a.width, a.height
    if w <= 0 or h <= 0:
        p = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                            "-show_entries", "stream=width,height",
                            "-of", "csv=p=0:s=x", a.input], capture_output=True)
        try:
            sw, sh = p.stdout.decode().strip().split("x")[:2]
            w, h = int(sw), int(sh)
        except Exception:
            sys.exit("cannot read the size: pass --width and --height")

    gray = read_gray(a.input, w, h)
    if gray is None:
        sys.exit(f"ffmpeg could not read {a.input}")

    if a.panel and (h % 8) != 0:
        # A half-filled last byte would draw differently depending on y.
        sys.exit(f"--panel needs a height that is a multiple of 8 (here {h}): "
                 f"use --height {((h + 7) // 8) * 8}")

    gray = adjust(gray, a.brightness, a.contrast, a.gamma, a.invert)
    bw   = dither(gray, w, h, a.dither, a.threshold)
    px, _ = pack_panel(bw, w, h) if a.panel else pack(bw, w, h)

    mask = b""
    if a.mask:
        alpha = read_gray(a.input, w, h, alpha=True)
        if alpha is None:
            print("  (no alpha channel: no mask written)")
        else:
            # a hard cut on alpha: a dithered mask would punch holes in the sprite
            mbw = bytearray(1 if v >= 128 else 0 for v in alpha)
            m, _ = pack_panel(mbw, w, h) if a.panel else pack(mbw, w, h)
            mask = bytes(m)

    with open(a.output, "wb") as f:
        f.write(MAGIC)
        # flags: bit 0 = has a mask, bit 1 = panel layout
        f.write(struct.pack("<HHBBH", w, h,
                            (1 if mask else 0) | (2 if a.panel else 0),
                            0, 0))
        f.write(px)
        f.write(mask)

    print(f"{a.output}: {w}x{h}, {a.dither}"
          f"{', with mask' if mask else ''}"
          f"{', panel layout' if a.panel else ''}, "
          f"{12 + len(px) + len(mask)} bytes")


if __name__ == "__main__":
    main()
