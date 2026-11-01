#!/usr/bin/env python3
"""Regenerate the disk-image window background. Run from the repo root; needs Pillow."""
from PIL import Image, ImageDraw, ImageFont

W, H = 660, 400


def font(size, bold=False):
    names = (["Helvetica-Bold", "Arial Bold", "DejaVuSans-Bold"] if bold
             else ["Helvetica", "Arial", "DejaVuSans"])
    for name in names:
        for path in (f"/System/Library/Fonts/{name}.ttc", f"/Library/Fonts/{name}.ttf",
                     f"/usr/share/fonts/truetype/dejavu/{name}.ttf"):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def render(scale):
    img = Image.new("RGB", (W * scale, H * scale), (246, 248, 250))
    d = ImageDraw.Draw(img)
    s = lambda v: int(v * scale)

    # Headline.
    title = "Drag Shapeshifter into Applications"
    f = font(s(22), bold=True)
    tw = d.textlength(title, font=f)
    d.text(((W * scale - tw) / 2, s(34)), title, fill=(24, 30, 40), font=f)

    # Arrow from the app slot (165, 200) to the Applications slot (495, 200).
    teal = (20, 184, 166)
    y = s(200)
    d.line([s(250), y, s(398), y], fill=teal, width=s(6))
    d.polygon([(s(412), y), (s(390), y - s(14)), (s(390), y + s(14))], fill=teal)

    # First-launch hint, since the app is not notarized.
    hint = "First time opening it? Right-click Shapeshifter and choose Open."
    f2 = font(s(13))
    hw = d.textlength(hint, font=f2)
    d.rounded_rectangle([(W * scale - hw) / 2 - s(14), s(330), (W * scale + hw) / 2 + s(14), s(362)],
                        radius=s(8), fill=(230, 247, 244))
    d.text(((W * scale - hw) / 2, s(337)), hint, fill=(15, 92, 84), font=f2)
    return img


render(1).save("macos/dmg-background.png")
render(2).save("macos/dmg-background@2x.png")
print("wrote macos/dmg-background.png and @2x")
