"""The smash walls (dash through them to break them): ChatGPT's four columns on magenta -> assets/props/dashwall_*.png

    python -P tools/dashwalls.py     # assets_raw/bg_layers/dashwalls_raw.png

Left to right: the Act I wooden barricade, Act II fire, Act III thorns, Act IV coral and runes. Each is 15 art-px wide
(drawn one tile wide at 2x) and repeats top to bottom in the game.
"""
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'assets_raw', 'bg_layers', 'dashwalls_raw.png')
NAMES = ['wood', 'fire', 'thorn', 'coral']
WIDTH = 15

im = Image.open(SRC).convert('RGBA'); px = im.load(); w, h = im.size
for y in range(h):
    for x in range(w):
        r, g, b, a = px[x, y]
        if (r > 150 and b > 150 and g < 120) or (r > 130 and b > 110 and g < r - 60): px[x, y] = (0, 0, 0, 0)
cols = [sum(1 for y in range(0, h, 3) if px[x, y][3]) > 6 for x in range(w)]
runs, start = [], None
for x, c in enumerate(cols + [False]):
    if c and start is None: start = x
    elif not c and start is not None:
        if x - start > 20: runs.append((start, x))
        start = None
assert len(runs) == 4, runs
for name, (x0, x1) in zip(NAMES, runs):
    pc = im.crop((x0, 0, x1, h)); pc = pc.crop(pc.getchannel('A').point(lambda v: 255 if v > 60 else 0).getbbox())
    # trim the rounded ends so it repeats cleanly: keep the middle 90%
    t = round(pc.height * 0.05); pc = pc.crop((0, t, pc.width, pc.height - t))
    size = (WIDTH, round(pc.height * WIDTH / pc.width))
    pm = Image.new('RGBA', pc.size); pp, sp = pm.load(), pc.load()
    for y in range(pc.height):
        for x in range(pc.width):
            r, g, b, a = sp[x, y]; pp[x, y] = (r * a // 255, g * a // 255, b * a // 255, a)
    sm = pm.resize(size, Image.BOX); q = sm.load(); out = Image.new('RGBA', size); op = out.load()
    for y in range(size[1]):
        for x in range(size[0]):
            r, g, b, a = q[x, y]
            op[x, y] = (0, 0, 0, 0) if a < 110 else (min(255, r * 255 // a), min(255, g * 255 // a), min(255, b * 255 // a), 255)
    out.save(os.path.join(ROOT, 'assets', 'props', f'dashwall_{name}.png')); print(name, size)
