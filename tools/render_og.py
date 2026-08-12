"""The 1200x630 link-preview image. Background and logo drawn here; text added by ffmpeg,
which is the only thing on this machine that can rasterise a font."""
import sys, math
sys.path.insert(0, sys.argv[1])   # directory holding render_icons.py
from render_icons import render_mark, write_png

W, H = 1200, 630
BG = (0x08, 0x09, 0x0B)
ACCENT = (0xF7, 0x93, 0x1A)

px = [[list(BG) for _ in range(W)] for _ in range(H)]

# A warm glow behind where the logo sits, so the card is not a flat rectangle.
gx, gy, gr = 150, 150, 620
for y in range(H):
    for x in range(W):
        d = math.hypot(x - gx, y - gy) / gr
        if d < 1:
            k = (1 - d) ** 2 * 0.20
            c = px[y][x]
            c[0] = min(255, int(c[0] + ACCENT[0] * k))
            c[1] = min(255, int(c[1] + ACCENT[1] * k))
            c[2] = min(255, int(c[2] + ACCENT[2] * k))

# The accent rule along the bottom.
for y in range(H - 8, H):
    for x in range(W):
        px[y][x] = list(ACCENT)

# The mark, alpha-composited at 108px.
S = 108
raw = render_mark(S)
ox, oy = 96, 92
i = 0
for row in range(S):
    i += 1  # the per-row filter byte
    for col in range(S):
        r, g, b, a = raw[i], raw[i+1], raw[i+2], raw[i+3]
        i += 4
        if not a:
            continue
        t = a / 255.0
        d = px[oy + row][ox + col]
        d[0] = int(d[0] * (1 - t) + r * t)
        d[1] = int(d[1] * (1 - t) + g * t)
        d[2] = int(d[2] * (1 - t) + b * t)

out = bytearray()
for row in px:
    out.append(0)
    for c in row:
        out += bytes(c)
write_png(sys.argv[2], W, H, bytes(out), color_type=2)
print('Hintergrund + Logo fertig')
