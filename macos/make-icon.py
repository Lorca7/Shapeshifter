#!/usr/bin/env python3
"""Regenerate the app icon. Run from the repository root; needs Pillow."""
from PIL import Image, ImageDraw
import os

S = 1024
OUT = "macos/AppIcon.iconset"
os.makedirs(OUT, exist_ok=True)

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

r = int(S * 0.2237)
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=(22, 26, 34, 255))
d.rounded_rectangle([0, 0, S - 1, int(S * 0.5)], radius=r, fill=(28, 34, 44, 255))
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=r, outline=(46, 54, 68, 255), width=max(2, S // 180))

pts = [(0.14, 0.70), (0.33, 0.26), (0.52, 0.52), (0.70, 0.30), (0.87, 0.76)]
poly = [(x * S, y * S) for x, y in pts]
d.polygon(poly, fill=(94, 234, 212, 32))


def dashed(a, b, dash=S * 0.042, gap=S * 0.030, width=max(6, int(S * 0.030))):
    (x0, y0), (x1, y1) = a, b
    length = ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5
    if length == 0:
        return
    ux, uy = (x1 - x0) / length, (y1 - y0) / length
    pos = 0.0
    while pos < length:
        end = min(pos + dash, length)
        d.line([x0 + ux * pos, y0 + uy * pos, x0 + ux * end, y0 + uy * end],
               fill=(94, 234, 212, 255), width=width)
        pos = end + gap


closed = poly + [poly[0]]
for i in range(len(closed) - 1):
    dashed(closed[i], closed[i + 1])

for x, y in poly:
    rr = S * 0.026
    d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=(255, 255, 255, 255))

img.save("macos/AppIcon.png")
for size in (16, 32, 128, 256, 512):
    img.resize((size, size), Image.LANCZOS).save(f"{OUT}/icon_{size}x{size}.png")
    img.resize((size * 2, size * 2), Image.LANCZOS).save(f"{OUT}/icon_{size}x{size}@2x.png")
print("wrote", OUT)
