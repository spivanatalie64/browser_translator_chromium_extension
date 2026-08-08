#!/usr/bin/env python3
"""Generate the Eilatan Lingo icons (globe-ish glyph) as PNGs.

Renders at 4x then box-downsamples for smooth edges. No deps beyond stdlib.
"""
import math
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
SIZES = [16, 48, 128]

BG = (30, 27, 46, 255)        # #1e1b2e
ACCENT = (192, 132, 252, 255) # #c084fc
LINE = (240, 238, 250, 255)   # near-white


def render_px(x, y, s):
    """Decide the color of pixel (x,y) in a s×s icon, float coords 0..1."""
    cx, cy = 0.5, 0.5
    r = 0.36
    dx, dy = x - cx, y - cy
    d = math.hypot(dx, dy)
    if d > r:
        return BG
    # inside the globe
    if d < r - 0.055:
        base = ACCENT
    else:
        base = tuple(int(ACCENT[i] * 0.75 + LINE[i] * 0.25) for i in range(3)) + (255,)
    # latitude lines
    for lat in (-0.45, -0.15, 0.15, 0.45):
        if abs(dy - lat * r * 2) < 0.028:
            return LINE
    # longitude ellipse
    ex = math.sqrt(max(0.0, r * r - dy * dy))
    if abs(abs(dx) - ex) < 0.028:
        return LINE
    # subtle center dot
    if d < 0.05:
        return LINE
    return base


def build(size, ss=4):
    big = size * ss
    px = []
    for y in range(size):
        for x in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    fx = (x * ss + sx + 0.5) / big
                    fy = (y * ss + sy + 0.5) / big
                    c = render_px(fx, fy, size)
                    acc = [acc[i] + c[i] for i in range(4)]
            n = ss * ss
            px.append(tuple(a // n for a in acc))
    return px


def png_bytes(size, px):
    w = h = size
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))
    raw = bytearray()
    for y in range(h):
        raw.append(0)  # filter: none
        for x in range(w):
            raw.extend(px[y * w + x])
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + chunk(b"IEND", b""))


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for s in SIZES:
        with open(os.path.join(OUT_DIR, f"icon{s}.png"), "wb") as f:
            f.write(png_bytes(s, build(s)))
        print(f"icon{s}.png written")


if __name__ == "__main__":
    main()
