"""The Yard's pond scene: ChatGPT's picture on magenta -> a cut-out, true-size pixel-art strip.

    python -P tools/pond.py          # assets_raw/bg_layers/yard_pond_raw.png -> assets/bg/yard_pond.png

It's drawn at 3x in the game (like the Yard's fields and fence), world-anchored at the left end of the Yard.
Prints where the water band and the dock are (image pixels), for POND in index.html.
"""
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'assets_raw', 'bg_layers', 'yard_pond_raw.png')
OUT = os.path.join(ROOT, 'assets', 'bg', 'yard_pond.png')
W_OUT = 350   # 350 x 3 = 1050 world px: the pond section (35 tiles of 30)


def magenta(r, g, b):
    return r > 150 and b > 150 and g < 110 and abs(r - b) < 90


im = Image.open(SRC).convert('RGBA')
px = im.load()
w, h = im.size
for y in range(h):
    for x in range(w):
        r, g, b, a = px[x, y]
        if magenta(r, g, b): px[x, y] = (0, 0, 0, 0)
        elif r > 120 and b > 120 and g < r - 50 and g < b - 50:   # pink fringe next to the cut: pull it toward the neighbours' green
            px[x, y] = (int(r * 0.55), max(g, int((r + b) * 0.28)), int(b * 0.5), a)
H_OUT = round(h * W_OUT / w)
# premultiplied box-downscale so cut edges don't pick up dark halos, then hard alpha
pm = Image.new('RGBA', im.size)
pp = pm.load()
for y in range(h):
    for x in range(w):
        r, g, b, a = px[x, y]
        pp[x, y] = (r * a // 255, g * a // 255, b * a // 255, a)
sm = pm.resize((W_OUT, H_OUT), Image.BOX)
sp = sm.load()
out = Image.new('RGBA', sm.size)
op = out.load()
for y in range(H_OUT):
    for x in range(W_OUT):
        r, g, b, a = sp[x, y]
        if a < 140: op[x, y] = (0, 0, 0, 0)
        else: op[x, y] = (min(255, r * 255 // a), min(255, g * 255 // a), min(255, b * 255 // a), 255)
# the pixel art's own palette: quantize lightly so it reads as pixels, not a photo
rgb = out.convert('RGB').quantize(colors=64, method=Image.MEDIANCUT, dither=Image.NONE).convert('RGB')
alpha = out.getchannel('A')
out = rgb.convert('RGBA'); out.putalpha(alpha)
# the big bush at the right end was cut flat by the picture's edge: round its right side off
op = out.load()
for y in range(H_OUT):
    for x in range(W_OUT - 46, W_OUT):
        cx, cy, rx, ry = W_OUT - 36, H_OUT - 30, 34, 52
        if x > cx and ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 > 1 and y < H_OUT - 8: op[x, y] = (0, 0, 0, 0)
out.save(OUT)
print('saved', OUT, out.size)
# where's the water? rows where blue dominates across the middle
op = out.load()
rows = []
for y in range(H_OUT):
    n = sum(1 for x in range(W_OUT // 5, W_OUT * 4 // 5) if op[x, y][3] and op[x, y][2] > op[x, y][0] + 30 and op[x, y][2] > op[x, y][1])
    rows.append(n)
water = [y for y, n in enumerate(rows) if n > W_OUT * 0.25]
print('water rows', water[:1], water[-1:] if water else None)
# the dock: brown planks in the lower half
cols = [x for x in range(W_OUT) if sum(1 for y in range(H_OUT // 2, H_OUT) if op[x, y][3] and 90 < op[x, y][0] < 200 and op[x, y][1] < op[x, y][0] - 15 and op[x, y][2] < op[x, y][1]) > 6]
print('brown columns', cols[:1], cols[-1:], len(cols))
