"""The fish bag's fish (and the creel): ChatGPT's sheet on magenta -> item icons at 18 art-px per bag cell.

    python -P tools/fish.py     # assets_raw/bg_layers/fish_sheet_raw.png -> assets/items/fish_*.png, assets/props/creel.png

Each fish is fitted into its rectangle (BOX, in bag cells) and its bag SHAPE is read off the picture: a cell counts when
enough of the fish covers it. Prints the shapes for FISH in index.html.
"""
import os, sys, json
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SRC = os.path.join(ROOT, 'assets_raw', 'bg_layers', 'fish_sheet_raw.png')
ORDER = ['minnow', 'bluegill', 'crawdad', 'perch', 'sunfish', 'carp', 'pike', 'catfish', 'pufferfish', 'eel', 'sturgeon', 'goldkoi', 'creel']
BOX = {'minnow': (1, 1), 'bluegill': (2, 1), 'crawdad': (2, 2), 'perch': (3, 1), 'sunfish': (2, 2), 'carp': (3, 2), 'pike': (4, 1),
       'catfish': (3, 2), 'pufferfish': (3, 3), 'eel': (4, 2), 'sturgeon': (5, 1), 'goldkoi': (4, 3)}
CELL = 18
COVER = 0.22   # how much of a cell the fish must cover for it to count


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


im = key(Image.open(SRC).convert('RGBA'))
def blobs(im, step=4, pad=3):   # separate pictures: connected blobs on a coarse grid (a few cells of slack join a fish's fins and whiskers)
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


boxes = [b for b in blobs(im) if (b[2] - b[0]) * (b[3] - b[1]) > 6000]   # (drops the koi's loose sparkle)
# reading order: rows (by centre y, grouped), then left to right
boxes.sort(key=lambda b: (b[1] + b[3]) / 2)
rows, cur = [], []
for b in boxes:
    if cur and (b[1] + b[3]) / 2 - (cur[-1][1] + cur[-1][3]) / 2 > (b[3] - b[1]) * 0.6: rows.append(cur); cur = []
    cur.append(b)
rows.append(cur)
boxes = [b for r in rows for b in sorted(r, key=lambda b: b[0])]
assert len(boxes) == len(ORDER), (len(boxes), boxes)
shapes = {}
for name, b in zip(ORDER, boxes):
    pc = im.crop(b)
    if name == 'creel':
        f = 24 / max(pc.size); shrink(pc, (round(pc.width * f), round(pc.height * f))).save(os.path.join(ROOT, 'assets', 'props', 'creel.png')); continue
    cw, ch = BOX[name]; W, H = cw * CELL, ch * CELL
    f = min(W / pc.width, H / pc.height)
    sm = shrink(pc, (max(1, round(pc.width * f)), max(1, round(pc.height * f))))
    out = Image.new('RGBA', (W, H)); out.paste(sm, ((W - sm.width) // 2, (H - sm.height) // 2)); out.save(os.path.join(ROOT, 'assets', 'items', f'fish_{name}.png'))
    a = out.getchannel('A').load()
    sh = [[1 if sum(1 for yy in range(r * CELL, (r + 1) * CELL) for xx in range(c * CELL, (c + 1) * CELL) if a[xx, yy]) >= COVER * CELL * CELL else 0 for c in range(cw)] for r in range(ch)]
    shapes[name] = sh
for k, v in shapes.items(): print(k, json.dumps(v))
