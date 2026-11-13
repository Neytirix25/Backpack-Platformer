"""Status icons for battles: slices ChatGPT's 4x4 sheet (assets_raw/bg_layers/raw/status_icons.png, badges on magenta) into
assets/ui/st_<status>.png, in the STATUS order below. Each is keyed, trimmed to its badge and scaled to 40x40 (drawn at 20).

    python tools/status_icons.py
"""
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'assets_raw', 'bg_layers', 'raw', 'status_icons.png')
OUT = os.path.join(ROOT, 'assets', 'ui')
ORDER = ['burn', 'poison', 'bleed', 'stun', 'blind', 'weak', 'mark', 'shield', 'regen', 'str', 'guard', 'taunt', 'evade', 'lucky', 'undying', 'charging']
SIZE = 40


def is_key(r, g, b):
    return r > 110 and b > 100 and g < 0.6 * min(r, b) and min(r, b) - g > 60


def main():
    im = Image.open(SRC).convert('RGBA'); px = im.load(); W, H = im.size
    # only the magenta joined to the sheet's edge: purple and pink art inside the frames stays
    seen = set(); stack = [(x, 0) for x in range(W)] + [(x, H - 1) for x in range(W)] + [(0, y) for y in range(H)] + [(W - 1, y) for y in range(H)]
    while stack:
        x, y = stack.pop()
        if (x, y) in seen or not (0 <= x < W and 0 <= y < H): continue
        seen.add((x, y)); r, g, b, a = px[x, y]
        if not is_key(r, g, b): continue
        px[x, y] = (0, 0, 0, 0); stack += [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]
    # the badges: runs of columns / rows that hold art
    cols = [any(px[x, y][3] for y in range(0, H, 2)) for x in range(W)]
    rows = [any(px[x, y][3] for x in range(0, W, 2)) for y in range(H)]
    def runs(v):
        out, s = [], None
        for i, on in enumerate(v + [False]):
            if on and s is None: s = i
            if not on and s is not None:
                if i - s > 20: out.append((s, i))
                s = None
        return out
    cx, ry = runs(cols), runs(rows)
    assert len(cx) == 4 and len(ry) == 4, (cx, ry)
    os.makedirs(OUT, exist_ok=True)
    for i, k in enumerate(ORDER):
        (x0, x1), (y0, y1) = cx[i % 4], ry[i // 4]
        cell = im.crop((x0, y0, x1, y1)); cell = cell.crop(cell.getbbox())
        side = max(cell.size); sq = Image.new('RGBA', (side, side)); sq.alpha_composite(cell, ((side - cell.width) // 2, (side - cell.height) // 2))
        sq.resize((SIZE, SIZE), Image.LANCZOS).save(os.path.join(OUT, f'st_{k}.png'))
    print('status icons:', len(ORDER))


if __name__ == '__main__':
    main()
