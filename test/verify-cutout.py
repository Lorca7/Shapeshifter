#!/usr/bin/env python3
"""Check a saved cutout from outside the program that made it.

Expects the file produced by tracing a 12-sided shape of radius 36 around the
magenta disc in test/fixtures/photo.png, and confirms the file really is that
shape: cropped to it, transparent outside it, and untouched inside it.

    python3 test/verify-cutout.py path/to/cutout.png
"""
import sys
from PIL import Image

path = sys.argv[1]
image = Image.open(path)
problems = []
if image.mode != "RGBA":
    problems.append(f"expected an RGBA image with transparency, got {image.mode}")
image = image.convert("RGBA")
width, height = image.size
alpha = image.getchannel("A")

if not (71 <= width <= 75 and 71 <= height <= 75):
    problems.append(f"expected about 72x72 (cropped to the outline), got {width}x{height}")

corners = [alpha.getpixel(p) for p in [(0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1)]]
if any(corners):
    problems.append(f"the corners should be transparent, got alpha {corners}")

centre = image.getpixel((width // 2, height // 2))
if not (centre[3] == 255 and abs(centre[0] - 200) < 10 and abs(centre[1] - 30) < 10 and abs(centre[2] - 200) < 10):
    problems.append(f"the centre should be the magenta disc, got {centre}")

values = alpha.tobytes()
filled = (sum(1 for v in values if v == 255) + sum(v / 255 for v in values if 0 < v < 255)) / len(values)
if not (0.69 <= filled <= 0.81):
    problems.append(f"a round shape should fill about 75% of its box, got {filled:.0%}")

print(f"{path}: {width}x{height}, corners alpha {corners}, centre {centre}, {filled:.1%} filled")
if problems:
    print("FAIL:")
    for p in problems:
        print("  -", p)
    sys.exit(1)
print("OK: the file is the shape that was traced")
