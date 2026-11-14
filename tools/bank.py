"""The pond's bank: ChatGPT's grassy bank on magenta -> assets/bg/pond_bank.png, the same height as the Yard's grass strip.

    python -P tools/bank.py     # assets_raw/bg_layers/pond_bank_raw.png -> assets/bg/pond_bank.png

The picture's left edge is full grass (it joins the yard_grass strip); it slopes down to a muddy waterline on the right.
The row of ground stones ChatGPT drew under it is cut off (the game's ground and water are under it already).
"""
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'assets_raw', 'bg_layers', 'pond_bank_raw.png')
OUT = os.path.join(ROOT, 'assets', 'bg', 'pond_bank.png')
STRIP_H = 36   # assets/bg/yard_grass.png's height

im = Image.open(SRC).convert('RGBA'); px = im.load(); w, h = im.size
for y in range(h):
    for x in range(w):
        r, g, b, a = px[x, y]
        if (r > 150 and b > 150 and g < 120) or (r > 130 and b > 110 and g < r - 60): px[x, y] = (0, 0, 0, 0)
im = im.crop(im.getchannel('A').point(lambda v: 255 if v > 60 else 0).getbbox()); px = im.load(); w, h = im.size
# where the stone row starts: the first row from the bottom up where grey stops outnumbering green
def grey_row(y):
    g = s = 0
    for x in range(0, w, 2):
        r, gg, b, a = px[x, y]
        if not a: continue
        if gg > r + 15 and gg > b: g += 1
        elif abs(r - gg) < 20 and abs(gg - b) < 25: s += 1
    return s > g
cut = h
while cut > h // 2 and grey_row(cut - 1): cut -= 1
im = im.crop((0, 0, w, cut))
f = STRIP_H / im.height
size = (round(im.width * f), STRIP_H)
pm = Image.new('RGBA', im.size); pp, sp = pm.load(), im.load()
for y in range(im.height):
    for x in range(im.width):
        r, g, b, a = sp[x, y]; pp[x, y] = (r * a // 255, g * a // 255, b * a // 255, a)
sm = pm.resize(size, Image.BOX); q = sm.load(); out = Image.new('RGBA', size); op = out.load()
for y in range(size[1]):
    for x in range(size[0]):
        r, g, b, a = q[x, y]
        op[x, y] = (0, 0, 0, 0) if a < 128 else (min(255, r * 255 // a), min(255, g * 255 // a), min(255, b * 255 // a), 255)
out.save(OUT); print('saved', OUT, size, 'stone row cut at', cut)
