"""Cooking art: the stone oven and the 12 cooked fish dishes.

    python -P tools/cook.py     # assets_raw/bg_layers/oven_raw.png -> assets/props/oven.png (and doghouse_raw.png -> doghouse.png)
                                # assets_raw/bg_layers/dish_sheet_raw.png -> assets/items/dish_*.png

Dishes are cut exactly like the fish (tools/fish.py: same order and boxes, 18 art-px per bag cell), so each dish keeps its
fish's shape in the bag. For the oven it prints where its mouth and the top of its chimney are (for OVEN_ART in index.html).
"""
import os, sys
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'assets_raw', 'bg_layers')
ORDER = ['minnow', 'bluegill', 'crawdad', 'perch', 'sunfish', 'carp', 'pike', 'catfish', 'pufferfish', 'eel', 'sturgeon', 'goldkoi']
BOX = {'minnow': (1, 1), 'bluegill': (2, 1), 'crawdad': (2, 2), 'perch': (3, 1), 'sunfish': (2, 2), 'carp': (3, 2), 'pike': (4, 1),
       'catfish': (3, 2), 'pufferfish': (3, 3), 'eel': (4, 2), 'sturgeon': (5, 1), 'goldkoi': (4, 3)}
CELL = 18
OVEN_H = 70   # the oven's height in art px (drawn at 2x)


def key(im):
    px = im.load(); w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if (r > 150 and b > 150 and g < 120) or (r > 130 and b > 110 and g < r - 60): px[x, y] = (0, 0, 0, 0)
    return im


def shrink(pc, size):   # premultiplied box-downscale, hard alpha
    pm = Image.new('RGBA', pc.size); pp, sp = pm.load(), pc.load()
    for y in range(pc.height):
        for x in range(pc.width):
            r, g, b, a = sp[x, y]; pp[x, y] = (r * a // 255, g * a // 255, b * a // 255, a)
    sm = pm.resize(size, Image.BOX); q = sm.load(); out = Image.new('RGBA', size); op = out.load()
    for y in range(size[1]):
        for x in range(size[0]):
            r, g, b, a = q[x, y]
            op[x, y] = (0, 0, 0, 0) if a < 128 else (min(255, r * 255 // a), min(255, g * 255 // a), min(255, b * 255 // a), 255)
    return out


def blobs(im, step=4, pad=3):   # separate pictures: connected blobs on a coarse grid
    a = im.getchannel('A').load(); w, h = im.size; gw, gh = w // step, h // step
    on = [[any(a[x * step + i, y * step + j] for i in range(0, step, 2) for j in range(0, step, 2)) for x in range(gw)] for y in range(gh)]
    seen = [[False] * gw for _ in range(gh)]; out = []
    for y in range(gh):
        for x in range(gw):
            if not on[y][x] or seen[y][x]: continue
            st = [(x, y)]; seen[y][x] = True; x0 = x1 = x; y0 = y1 = y
            while st:
                cx, cy = st.pop(); x0, x1, y0, y1 = min(x0, cx), max(x1, cx), min(y0, cy), max(y1, cy)
                for dx in range(-pad, pad + 1):
                    for dy in range(-pad, pad + 1):
                        nx, ny = cx + dx, cy + dy
                        if 0 <= nx < gw and 0 <= ny < gh and on[ny][nx] and not seen[ny][nx]: seen[ny][nx] = True; st.append((nx, ny))
            out.append((x0 * step, y0 * step, min(w, (x1 + 1) * step), min(h, (y1 + 1) * step)))
    return out


# ---- the dishes ----
im = key(Image.open(os.path.join(RAW, 'dish_sheet_raw.png')).convert('RGBA'))
boxes = [b for b in blobs(im) if (b[2] - b[0]) * (b[3] - b[1]) > 6000]
boxes.sort(key=lambda b: (b[1] + b[3]) / 2)
rows, cur = [], []
for b in boxes:
    if cur and (b[1] + b[3]) / 2 - (cur[-1][1] + cur[-1][3]) / 2 > (b[3] - b[1]) * 0.6: rows.append(cur); cur = []
    cur.append(b)
rows.append(cur)
boxes = [b for r in rows for b in sorted(r, key=lambda b: b[0])]
assert len(boxes) == len(ORDER), (len(boxes), boxes)
for name, b in zip(ORDER, boxes):
    pc = im.crop(b); cw, ch = BOX[name]; W, H = cw * CELL, ch * CELL
    f = min(W / pc.width, H / pc.height)
    sm = shrink(pc, (max(1, round(pc.width * f)), max(1, round(pc.height * f))))
    out = Image.new('RGBA', (W, H)); out.paste(sm, ((W - sm.width) // 2, (H - sm.height) // 2)); out.save(os.path.join(ROOT, 'assets', 'items', f'dish_{name}.png'))
print('dishes', len(boxes))

# ---- the oven ----
ov = key(Image.open(os.path.join(RAW, 'oven_raw.png')).convert('RGBA'))
ov = ov.crop(ov.getchannel('A').point(lambda v: 255 if v > 60 else 0).getbbox())
f = OVEN_H / ov.height
small = shrink(ov, (round(ov.width * f), OVEN_H)); small.save(os.path.join(ROOT, 'assets', 'props', 'oven.png'))
px = small.load(); w, h = small.size
glow = [(x, y) for y in range(h) for x in range(w) if px[x, y][3] and px[x, y][0] > 200 and 60 < px[x, y][1] < 190 and px[x, y][2] < 90 and y > h * 0.45]
mx = sum(x for x, _ in glow) / max(1, len(glow)) / w; my = sum(y for _, y in glow) / max(1, len(glow)) / h
top = next(y for y in range(h) if any(px[x, y][3] for x in range(w)))
tx = [x for x in range(w) if px[x, top][3]]; cx = (min(tx) + max(tx)) / 2 / w
print('oven', small.size, 'mouth', round(mx, 3), round(my, 3), 'chimney', round(cx, 3), round(top / h, 3))

# ---- the doghouse (where you choose the Yard's animals) ----
DOGHOUSE_H = 42
dh = key(Image.open(os.path.join(RAW, 'doghouse_raw.png')).convert('RGBA'))
dh = dh.crop(dh.getchannel('A').point(lambda v: 255 if v > 60 else 0).getbbox())
f = DOGHOUSE_H / dh.height
shrink(dh, (round(dh.width * f), DOGHOUSE_H)).save(os.path.join(ROOT, 'assets', 'props', 'doghouse.png'))
print('doghouse', round(dh.width * f), DOGHOUSE_H)
