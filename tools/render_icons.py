#!/usr/bin/env python3
"""Renders the SatWire brand mark to PNG without any image library.

This machine has no rsvg-convert, no ImageMagick, no PIL and no headless browser, so the
mark from frontend/index.html is redrawn here as geometry and encoded with zlib+struct.

The artwork, from index.html:16-25:
  - a 24x24 rounded rect, radius 7, filled with a linear gradient #ffb64d -> #f7931a
    running corner to corner
  - a 1.7-wide polyline stroke in #17130a with round caps and joins:
    M5 12.5 h3.2 l1.6 -4.2 l2.4 7.4 l1.7 -3.2 H19

Everything is drawn at 4x supersampling and box-filtered down, which is what gives the
stroke its antialiasing. Alpha is kept, so the icon has real rounded corners.
"""

import math
import struct
import sys
import zlib

SS = 4  # supersampling factor


# ---------------------------------------------------------------- geometry helpers

def rounded_rect_coverage(x, y, w, h, r):
    """Inside-ness of point (x, y) in a w*h rounded rect with corner radius r."""
    if x < 0 or y < 0 or x > w or y > h:
        return False
    cx = min(max(x, r), w - r)
    cy = min(max(y, r), h - r)
    dx, dy = x - cx, y - cy
    if dx == 0 or dy == 0:
        return True
    return dx * dx + dy * dy <= r * r


def dist_to_segment(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    L2 = vx * vx + vy * vy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / L2))
    qx, qy = ax + t * vx, ay + t * vy
    return math.hypot(px - qx, py - qy)


def lerp(a, b, t):
    return a + (b - a) * t


# ---------------------------------------------------------------- the mark

GRAD_FROM = (0xFF, 0xB6, 0x4D)
GRAD_TO = (0xF7, 0x93, 0x1A)
STROKE = (0x17, 0x13, 0x0A)

# The path, as absolute points in the 24x24 viewBox.
BOLT = [(5, 12.5), (8.2, 12.5), (9.8, 8.3), (12.2, 15.7), (13.9, 12.5), (19, 12.5)]
STROKE_W = 1.7
RADIUS = 7.0


def render_mark(size, pad=0.0):
    """RGBA bytes of the mark at size*size. `pad` is a margin in viewBox units."""
    n = size * SS
    box = 24.0 + 2 * pad
    scale = box / n
    half = STROKE_W / 2.0

    acc = [[[0, 0, 0, 0] for _ in range(size)] for _ in range(size)]

    for sy in range(n):
        vy = (sy + 0.5) * scale - pad
        for sx in range(n):
            vx = (sx + 0.5) * scale - pad
            if not rounded_rect_coverage(vx, vy, 24.0, 24.0, RADIUS):
                continue
            t = (vx + vy) / 48.0                      # corner-to-corner gradient
            r = lerp(GRAD_FROM[0], GRAD_TO[0], t)
            g = lerp(GRAD_FROM[1], GRAD_TO[1], t)
            b = lerp(GRAD_FROM[2], GRAD_TO[2], t)
            d = min(dist_to_segment(vx, vy, *BOLT[i], *BOLT[i + 1]) for i in range(len(BOLT) - 1))
            if d <= half:
                r, g, b = STROKE
            px, py = sx // SS, sy // SS
            cell = acc[py][px]
            cell[0] += r
            cell[1] += g
            cell[2] += b
            cell[3] += 255

    out = bytearray()
    per = SS * SS
    for row in acc:
        out.append(0)  # PNG filter: none
        for cell in row:
            a = cell[3] / per
            if a <= 0.5:
                out += bytes((0, 0, 0, 0))
                continue
            cov = cell[3] / 255.0 or 1
            out += bytes((
                max(0, min(255, round(cell[0] / cov))),
                max(0, min(255, round(cell[1] / cov))),
                max(0, min(255, round(cell[2] / cov))),
                max(0, min(255, round(a))),
            ))
    return bytes(out)


def write_png(path, width, height, raw, color_type=6):
    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack('>IIBBBBB', width, height, 8, color_type, 0, 0, 0)
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', ihdr)
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)


if __name__ == '__main__':
    out_dir = sys.argv[1]
    for size, name, pad in ((32, 'favicon.png', 0.0), (180, 'apple-touch-icon.png', 0.0)):
        raw = render_mark(size, pad)
        write_png(f'{out_dir}/{name}', size, size, raw)
        print(f'{name}: {size}x{size}')
