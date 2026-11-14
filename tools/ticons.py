"""The talent icons: ChatGPT's sheet on magenta -> assets/ui/talent_icons.png (8 to a row, 32 px each, TICON_KINDS order)

    python -P tools/ticons.py      # assets_raw/bg_layers/talent_icons_raw.png

Icons are found as separate blobs, sorted into rows (top to bottom) and then left to right, so the sheet's grid
doesn't have to be exact. It prints how many it found: index.html's TICON_KINDS lists 34.
"""
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'assets_raw', 'bg_layers', 'talent_icons_raw.png')
OUT = os.path.join(ROOT, 'assets', 'ui', 'talent_icons.png')
CELL, COLS, WANT = 32, 8, 34


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
            op[x, y] = (0, 0, 0, 0) if a < 110 else (min(255, r * 255 // a), min(255, g * 255 // a), min(255, b * 255 // a), 255)
    return out


def blobs(im, step=4, pad=2):   # separate pictures: connected blobs on a coarse grid
    a = im.getchannel('A').load(); w, h = im.size; gw, gh = w // step, h // step
    on = [[any(a[x * step + i, y * step + j] > 60 for i in range(0, step, 2) for j in range(0, step, 2)) for x in range(gw)] for y in range(gh)]
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


im = key(Image.open(SRC).convert('RGBA'))
bs = [b for b in blobs(im) if (b[2] - b[0]) * (b[3] - b[1]) > 900]
big = max((b[2] - b[0]) * (b[3] - b[1]) for b in bs)
bs = [b for b in bs if (b[2] - b[0]) * (b[3] - b[1]) > big * 0.08]   # (drop specks)
bs.sort(key=lambda b: (b[1] + b[3]) / 2)
rows, cur = [], []
for b in bs:
    if cur and (b[1] + b[3]) / 2 - sum((c[1] + c[3]) / 2 for c in cur) / len(cur) > (b[3] - b[1]) * 0.55: rows.append(cur); cur = []
    cur.append(b)
rows.append(cur)
bs = [b for r in rows for b in sorted(r, key=lambda b: b[0])]
print('icons found:', len(bs), 'rows:', [len(r) for r in rows])
sheet = Image.new('RGBA', (COLS * CELL, ((max(len(bs), WANT) + COLS - 1) // COLS) * CELL))
for i, b in enumerate(bs):
    pc = im.crop(b); f = (CELL - 2) / max(pc.width, pc.height)
    sm = shrink(pc, (max(1, round(pc.width * f)), max(1, round(pc.height * f))))
    sheet.paste(sm, ((i % COLS) * CELL + (CELL - sm.width) // 2, (i // COLS) * CELL + (CELL - sm.height) // 2), sm)
sheet.save(OUT); print('saved', OUT, sheet.size)
