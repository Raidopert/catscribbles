#!/usr/bin/env python3
"""Генерация брендинг-ассетов CatScribbles из icon-512.png.

Создаёт:
  android/res/mipmap-*/ic_launcher.png        (48..192, квадратный)
  android/res/mipmap-*/ic_launcher_round.png  (48..192, круглый)
  desktop/app-electron/icon.ico               (16..256, Windows)
  branding/nsis-welcome.bmp (164x314) и branding/nsis-header.bmp (150x57)
"""
from PIL import Image, ImageDraw, ImageFont, ImageOps
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'icon-512.png')
BG = (10, 13, 18, 255)        # #0A0D12
CYAN = (0, 229, 255)
PINK = (255, 43, 214)

os.makedirs(os.path.join(ROOT, 'branding'), exist_ok=True)

img = Image.open(SRC).convert('RGBA')

# ---------- Android mipmaps ----------
def rounded_square(im, size):
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    mask = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(mask)
    r = max(4, size // 5)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=255)
    out.paste(im.resize((size, size), Image.LANCZOS), (0, 0), mask)
    return out

def circle(im, size):
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    mask = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.ellipse([0, 0, size - 1, size - 1], fill=255)
    out.paste(im.resize((size, size), Image.LANCZOS), (0, 0), mask)
    return out

MIP = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
for dpi, size in MIP.items():
    d = os.path.join(ROOT, 'android', 'res', 'mipmap-' + dpi)
    os.makedirs(d, exist_ok=True)
    rounded_square(img, size).save(os.path.join(d, 'ic_launcher.png'))
    circle(img, size).save(os.path.join(d, 'ic_launcher_round.png'))
    print('mipmap-' + dpi, size)

# ---------- Windows .ico ----------
ICO_SIZES = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)]
ico_path = os.path.join(ROOT, 'desktop', 'app-electron', 'icon.ico')
img.resize((256, 256), Image.LANCZOS).save(ico_path, format='ICO', sizes=ICO_SIZES)
print('icon.ico ok')

# ---------- NSIS bitmaps ----------
DEJAVU = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
DEJAVU_R = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'

def accent_scribble(d, x0, y0, x1, y1, width=4):
    """Декоративная неоновая закорючка-спираль."""
    import math
    steps = 90
    for i in range(steps - 1):
        t0 = i / steps
        t1 = (i + 1) / steps
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        rx, ry = (x1 - x0) / 2, (y1 - y0) / 2
        a0 = math.pi * 0.6 + t0 * math.pi * 4.4
        a1 = math.pi * 0.6 + t1 * math.pi * 4.4
        shrink0 = 1 - t0 * 0.62
        shrink1 = 1 - t1 * 0.62
        p0 = (cx + rx * shrink0 * math.cos(a0), cy + ry * shrink0 * math.sin(a0))
        p1 = (cx + rx * shrink1 * math.cos(a1), cy + ry * shrink1 * math.sin(a1))
        d.line([p0, p1], fill=CYAN, width=width)

# welcome 164x314
w, h = 164, 314
wm = Image.new('RGB', (w, h), BG)
d = ImageDraw.Draw(wm)
d.rectangle([0, 0, w - 1, h - 1], outline=(28, 37, 51), width=1)
d.line([0, 0, 0, h], fill=CYAN, width=3)
accent_scribble(d, 28, 150, 140, 260, width=4)
d.ellipse([126, 148, 142, 164], fill=PINK)
f_big = ImageFont.truetype(DEJAVU, 21)
f_mid = ImageFont.truetype(DEJAVU, 12)
f_sm = ImageFont.truetype(DEJAVU_R, 9)
d.text((16, 40), 'CatScribbles', font=f_big, fill=CYAN)
d.text((16, 68), 'КошачьиЗакорючки', font=f_mid, fill=(242, 227, 207))
d.text((16, 92), 'P2P доска для рисования', font=f_sm, fill=(160, 172, 190))
d.text((16, 106), 'Raido Pert Studio', font=f_sm, fill=(160, 172, 190))
wm.save(os.path.join(ROOT, 'branding', 'nsis-welcome.bmp'))
print('nsis-welcome.bmp ok')

# header 150x57
w, h = 150, 57
hd = Image.new('RGB', (w, h), BG)
d = ImageDraw.Draw(hd)
d.line([0, h - 2, w, h - 2], fill=CYAN, width=2)
f_h = ImageFont.truetype(DEJAVU, 15)
f_h2 = ImageFont.truetype(DEJAVU_R, 8)
d.text((10, 10), 'CatScribbles', font=f_h, fill=CYAN)
d.text((10, 34), 'Raido Pert Studio', font=f_h2, fill=(160, 172, 190))
accent_scribble(d, 88, 6, 142, 44, width=3)
hd.save(os.path.join(ROOT, 'branding', 'nsis-header.bmp'))
print('nsis-header.bmp ok')
