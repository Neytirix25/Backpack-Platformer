"""The pond's dock: ChatGPT's three pieces on magenta -> cut-out, true-size pixel art.

    python -P tools/dock.py     # assets_raw/bg_layers/dock_pieces_raw.png -> assets/props/dock_deck.png, dock_post.png, dock_end.png

Left to right on the sheet: the deck (tiles left-right), the post (tiles top-bottom), the deck's end with a mooring post.
They're drawn at 2x like the ground tiles; the deck is sized to 3 tiles wide and the others keep the same pixel scale.
"""
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'assets_raw', 'bg_layers', 'dock_pieces_raw.png')
OUT = os.path.join(ROOT, 'assets', 'props')
DECK_W = 45   # 45 px at 2x = 90 = 3 tiles

im = Image.open(SRC).convert('RGBA')
px = im.load(); w, h = im.size
for y in range(h):
    for x in range(w):
        r, g, b, a = px[x, y]
        if r > 150 and b > 150 and g < 120: px[x, y] = (0, 0, 0, 0)
        elif r > 130 and b > 110 and g < r - 60: px[x, y] = (0, 0, 0, 0)   # pink fringe
# the pieces: runs of columns that have anything in them
cols = [any(px[x, y][3] for y in range(0, h, 2)) for x in range(w)]
runs, start = [], None
for x, c in enumerate(cols + [False]):
    if c and start is None: start = x
    elif not c and start is not None:
        if x - start > 8: runs.append((start, x))
        start = None
assert len(runs) == 3, runs
pieces = []
for x0, x1 in runs:
    sub = im.crop((x0, 0, x1, h)); bb = sub.getchannel('A').point(lambda v: 255 if v > 60 else 0).getbbox()
    pieces.append(sub.crop(bb))
f = DECK_W / pieces[0].width
for name, pc in zip(['dock_deck', 'dock_post', 'dock_end'], pieces):
    sz = (max(1, round(pc.width * f)), max(1, round(pc.height * f)))
    # premultiplied box-downscale, then hard alpha (crisp pixels, no dark fringe)
    pm = Image.new('RGBA', pc.size); pp, sp = pm.load(), pc.load()
    for y in range(pc.height):
        for x in range(pc.width):
            r, g, b, a = sp[x, y]; pp[x, y] = (r * a // 255, g * a // 255, b * a // 255, a)
    sm = pm.resize(sz, Image.BOX); q = sm.load(); out = Image.new('RGBA', sz); op = out.load()
    for y in range(sz[1]):
        for x in range(sz[0]):
            r, g, b, a = q[x, y]
            op[x, y] = (0, 0, 0, 0) if a < 128 else (min(255, r * 255 // a), min(255, g * 255 // a), min(255, b * 255 // a), 255)
    out.save(os.path.join(OUT, name + '.png')); print(name, sz)
