"""Turn ChatGPT-generated sheets into crisp, true-resolution pixel-art sprites for Backpack Sanctuary.

Usage (run from anywhere):
    python -P tools/pixelate.py items        # slice items_sheet.png  -> assets/items/*.png
    python -P tools/pixelate.py chars        # slice chars_sheet.png  -> assets/chars/*.png
    python -P tools/pixelate.py props        # slice props_sheet.png  -> assets/props/*.png
    python -P tools/pixelate.py bg <name>    # bg_<name>.png          -> assets/bg/<name>.png
    python -P tools/pixelate.py preview <sheet>  # numbered contact sheet of the detected sprites
"""
import sys, os, json
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'assets_raw')
OUT = os.path.join(ROOT, 'assets')
CELL = 18  # backpack art pixels per grid cell (drawn at 3x = 54px in game)


def segment(im, gap_x=25, gap_y=20, a_min=40):
    """Find sprites on a transparent sheet: split into rows by empty horizontal bands, then columns."""
    a = im.getchannel('A').point(lambda v: 255 if v > a_min else 0)
    W, H = im.size
    px = a.load()

    def bands(proj, gap):
        out, s, last = [], -1, -1
        for i, v in enumerate(proj):
            if v:
                if s < 0:
                    s = i
                elif i - last > gap:
                    out.append((s, last)); s = i
                last = i
        if s >= 0:
            out.append((s, last))
        return out

    row_p = [1 if a.crop((0, y, W, y + 1)).getbbox() else 0 for y in range(H)]
    boxes = []
    for y0, y1 in bands(row_p, gap_y):
        strip = a.crop((0, y0, W, y1 + 1))
        col_p = [1 if strip.crop((x, 0, x + 1, y1 - y0 + 1)).getbbox() else 0 for x in range(W)]
        for x0, x1 in bands(col_p, gap_x):
            bb = a.crop((x0, y0, x1 + 1, y1 + 1)).getbbox()
            boxes.append((x0 + bb[0], y0 + bb[1], x0 + bb[2], y0 + bb[3]))
    return boxes


def cutouts(im, ds=2, grow=3, **kw):
    """Like segment_cc, but returns each sprite as its own image with neighbours' pixels removed."""
    boxes, lab, owners = segment_cc(im, ds=ds, grow=grow, masks=True, **kw)
    out = []
    for b, own in zip(boxes, owners):
        spr = im.crop(b).copy(); a = spr.getchannel('A'); ap = a.load()
        for y in range(spr.height):
            row = lab[min(len(lab) - 1, (b[1] + y) // ds)]
            for x in range(spr.width):
                if row[min(len(row) - 1, (b[0] + x) // ds)] not in own:
                    ap[x, y] = 0
        spr.putalpha(a)
        bb = spr.getbbox()
        out.append(spr.crop(bb))
    return out


def segment_cc(im, a_min=40, ds=4, grow=5, min_frac=0.02, row_tol=150, masks=False):
    """Connected-component sprite finder (handles sprites that overlap in rows/columns).
    Works on a downsampled, slightly dilated alpha mask; tiny bits (sparks, wisps) merge into
    the nearest big sprite. Returns boxes in reading order (rows top->bottom, then left->right)."""
    from PIL import ImageFilter
    from collections import deque
    W, H = im.size
    m = im.getchannel('A').point(lambda v: 255 if v > a_min else 0)
    m = m.resize((W // ds, H // ds), Image.BOX).point(lambda v: 255 if v > 20 else 0).filter(ImageFilter.MaxFilter(grow))
    w, h = m.size; px = m.load(); lab = [[0] * w for _ in range(h)]; comps = []
    for y in range(h):
        for x in range(w):
            if px[x, y] and not lab[y][x]:
                n = len(comps) + 1; q = deque([(x, y)]); lab[y][x] = n
                x0 = x1 = x; y0 = y1 = y; cnt = 0
                while q:
                    cx, cy = q.popleft(); cnt += 1
                    x0, x1, y0, y1 = min(x0, cx), max(x1, cx), min(y0, cy), max(y1, cy)
                    for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                        if 0 <= nx < w and 0 <= ny < h and px[nx, ny] and not lab[ny][nx]:
                            lab[ny][nx] = n; q.append((nx, ny))
                comps.append([x0, y0, x1 + 1, y1 + 1, cnt, {n}])
    big = max(c[4] for c in comps)
    main = [c for c in comps if c[4] >= big * min_frac]
    for c in comps:
        if c in main:
            continue
        cx, cy = (c[0] + c[2]) / 2, (c[1] + c[3]) / 2
        t = min(main, key=lambda k: (max(k[0] - cx, 0, cx - k[2])) ** 2 + (max(k[1] - cy, 0, cy - k[3])) ** 2)
        t[0], t[1], t[2], t[3] = min(t[0], c[0]), min(t[1], c[1]), max(t[2], c[2]), max(t[3], c[3])
        t[5] |= c[5]
    items = []
    for c in main:  # back to full-res, then tighten to real alpha
        bx = (max(0, c[0] * ds - ds), max(0, c[1] * ds - ds), min(W, c[2] * ds + ds), min(H, c[3] * ds + ds))
        bb = im.crop(bx).getchannel('A').point(lambda v: 255 if v > a_min else 0).getbbox()
        items.append(((bx[0] + bb[0], bx[1] + bb[1], bx[0] + bb[2], bx[1] + bb[3]), c[5]))
    items.sort(key=lambda it: (it[0][1] + it[0][3]) / 2)
    rows = []
    for it in items:
        cy = (it[0][1] + it[0][3]) / 2
        if rows and abs(cy - rows[-1][0]) < row_tol:
            rows[-1][1].append(it)
        else:
            rows.append([cy, [it]])
    ordered = [it for _, r in rows for it in sorted(r, key=lambda it: it[0][0])]
    if masks:
        return [it[0] for it in ordered], lab, [it[1] for it in ordered]
    return [it[0] for it in ordered]


def pixelate_scale(sprite, s, colors=28, a_cut=110):
    """Shrink by an exact factor s (so several poses of one character stay the same size)."""
    w, h = sprite.size
    return pixelate(sprite, max(1, round(w * s)), max(1, round(h * s)), colors, a_cut)


CHARS = [  # (name, idle height in art pixels) — sheet order: idle, attack per character
    ('hero', 27), ('slime', 12), ('bat', 15), ('skeleton', 26),
    ('archer', 21), ('ghost', 23), ('brute', 34), ('boss', 52),
]


def do_chars():
    im = Image.open(os.path.join(RAW, 'chars_sheet.png')).convert('RGBA')
    sprites = cutouts(im)
    assert len(sprites) == 2 * len(CHARS), f'found {len(sprites)} sprites, expected {2 * len(CHARS)}'
    os.makedirs(os.path.join(OUT, 'chars'), exist_ok=True)
    for i, (name, ih) in enumerate(CHARS):
        idle, atk = sprites[2 * i], sprites[2 * i + 1]
        s = ih / idle.height
        for pose, src in (('idle', idle), ('attack', atk)):
            spr = pixelate_scale(src, s)
            spr.save(os.path.join(OUT, 'chars', f'{name}_{pose}.png'))
            print(name, pose, spr.size)


PROPS = [  # (name, max art width, max art height, reuse scale of this earlier prop or None)
    ('chest_closed', 22, 99, None), ('chest_open', 0, 0, 'chest_closed'), ('campfire', 26, 99, None), ('torch', 99, 24, None),
    ('gate', 34, 99, None), ('ledge', 99, 12, None), ('tombstone', 99, 20, None), ('arrow', 11, 99, None),
    ('mushrooms', 99, 13, None), ('candle', 99, 12, None), ('bones', 24, 99, None), ('chain', 99, 30, None),
]


def do_props():
    im = Image.open(os.path.join(RAW, 'props_sheet.png')).convert('RGBA')
    sprites = cutouts(im)
    assert len(sprites) == len(PROPS), f'found {len(sprites)} sprites, expected {len(PROPS)}'
    os.makedirs(os.path.join(OUT, 'props'), exist_ok=True)
    scales = {}
    for (name, mw, mh, ref), src in zip(PROPS, sprites):
        s = scales[ref] if ref else min(mw / src.width, mh / src.height)
        scales[name] = s
        spr = pixelate_scale(src, s)
        spr.save(os.path.join(OUT, 'props', name + '.png'))
        print(name, spr.size)


def pixelate(sprite, max_w, max_h, colors=28, a_cut=110):
    """Shrink to fit max_w x max_h (keeping aspect), crisp alpha, reduced palette."""
    w, h = sprite.size
    s = min(max_w / w, max_h / h)
    tw, th = max(1, round(w * s)), max(1, round(h * s))
    small = sprite.resize((tw, th), Image.BOX)
    r, g, b, a = small.split()
    a = a.point(lambda v: 255 if v >= a_cut else 0)
    rgb = Image.merge('RGB', (r, g, b)).quantize(colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert('RGB')
    out = rgb.convert('RGBA'); out.putalpha(a)
    return out


def contact(sheet_path, out_path, boxes):
    im = Image.open(sheet_path).convert('RGBA')
    thumbs = [im.crop(b) for b in boxes]
    T = 140
    cols = 6; rows = (len(thumbs) + cols - 1) // cols
    cs = Image.new('RGBA', (cols * T, rows * (T + 16)), (40, 40, 48, 255))
    d = ImageDraw.Draw(cs)
    for i, t in enumerate(thumbs):
        t = t.copy(); t.thumbnail((T - 8, T - 8))
        x, y = (i % cols) * T, (i // cols) * (T + 16)
        cs.alpha_composite(t, (x + (T - t.width) // 2, y + 16 + (T - t.height) // 2))
        d.text((x + 4, y + 2), str(i), fill=(255, 220, 120, 255))
    cs.save(out_path)


ITEMS = [  # (id, cells wide, cells tall) in sheet order
    ('dagger', 1, 2), ('sword', 1, 3), ('axe', 2, 3), ('spear', 1, 4), ('bow', 2, 3),
    ('gloves', 2, 1), ('shield', 2, 2), ('helm', 2, 1), ('chain', 3, 2), ('spiked', 3, 2),
    ('boots', 2, 2), ('potion', 1, 1), ('bomb', 1, 1), ('bread', 2, 1), ('heart', 1, 1),
    ('whetstone', 1, 1), ('charm', 1, 1), ('fang', 1, 1), ('clover', 3, 3),
]


# Backpack shapes — must match ITEMS[...].shape in index.html (1 = cell used)
SHAPES = {
    'axe': [[1, 1], [0, 1], [0, 1]], 'bow': [[1, 1], [1, 0], [1, 1]], 'chain': [[1, 1, 1], [0, 1, 0]],
    'spiked': [[0, 1, 1], [1, 1, 0]], 'boots': [[1, 0], [1, 1]], 'clover': [[0, 1, 0], [1, 1, 1], [0, 1, 0]],
}


def shape_mask(shape):
    rows, cols = len(shape), len(shape[0])
    m = Image.new('L', (cols * CELL, rows * CELL), 0); d = ImageDraw.Draw(m)
    for r, row in enumerate(shape):
        for c, v in enumerate(row):
            if v:
                d.rectangle((c * CELL, r * CELL, c * CELL + CELL - 1, r * CELL + CELL - 1), fill=255)
    return m


def fit_to_shape(src, shape, max_leak=0.03):
    """Pixelate src as large as possible inside the item's cells: tries shrinking and sliding the art
    until (almost) nothing spills into the empty cells of an L/T/S/C/plus shape.
    Returns a canvas exactly cols*CELL x rows*CELL so the game can draw it straight onto the item."""
    from PIL import ImageChops, ImageStat
    mask = shape_mask(shape); empty = ImageChops.invert(mask)
    cw, ch = mask.size
    base = min((cw - 2) / src.width, (ch - 2) / src.height)
    best = None
    for k in [1.0, 0.94, 0.88, 0.82, 0.76, 0.7, 0.64, 0.58, 0.52]:
        spr = pixelate(src, max(1, round(src.width * base * k)), max(1, round(src.height * base * k)))
        sa = spr.getchannel('A'); total = ImageStat.Stat(sa).sum[0] / 255 or 1
        cand = None
        for dy in range(0, ch - spr.height + 1):
            for dx in range(0, cw - spr.width + 1):
                a = Image.new('L', (cw, ch), 0); a.paste(sa, (dx, dy))
                leak = ImageStat.Stat(ImageChops.multiply(a, empty)).sum[0] / 255 / total
                # prefer low leak, then staying near the centre
                centre = abs(dx - (cw - spr.width) / 2) + abs(dy - (ch - spr.height) / 2)
                key = (round(leak, 3), centre)
                if cand is None or key < cand[0]:
                    cand = (key, dx, dy, leak)
        if best is None or cand[3] < best[3]:
            best = (spr, cand[1], cand[2], cand[3])
        if cand[3] <= max_leak:
            best = (spr, cand[1], cand[2], cand[3]); break
    spr, dx, dy, leak = best
    out = Image.new('RGBA', (cw, ch), (0, 0, 0, 0)); out.paste(spr, (dx, dy))
    return out, leak


def bracers_for_s(src):
    """The bracers art is a side-by-side pair, but the item is an S shape.
    Split the pair, lay each bracer on its side, and put one in each row of the S."""
    parts = cutouts(src, ds=1, grow=1, row_tol=999)
    parts = sorted(parts, key=lambda p: p.width * p.height, reverse=True)[:2]
    shape = SHAPES['spiked']; out = Image.new('RGBA', (3 * CELL, 2 * CELL), (0, 0, 0, 0))
    slots = [(0, CELL), (CELL, 0)]  # bottom row cells 0-1, top row cells 1-2
    for p, (sx, sy) in zip(parts, slots):
        p = p.rotate(90, expand=True)
        spr = pixelate(p, 2 * CELL - 4, CELL - 2)
        out.paste(spr, (sx + (2 * CELL - spr.width) // 2, sy + (CELL - spr.height) // 2), spr)
    return out


def do_items():
    im = Image.open(os.path.join(RAW, 'items_sheet.png')).convert('RGBA')
    boxes = segment(im)
    assert len(boxes) == len(ITEMS), f'found {len(boxes)} sprites, expected {len(ITEMS)}'
    os.makedirs(os.path.join(OUT, 'items'), exist_ok=True)
    for (iid, cw, ch), b in zip(ITEMS, boxes):
        src = im.crop(b)
        if iid == 'spiked':
            spr, leak = bracers_for_s(src), 0
        else:
            shape = SHAPES.get(iid, [[1] * cw for _ in range(ch)])
            spr, leak = fit_to_shape(src, shape)
        spr.save(os.path.join(OUT, 'items', iid + '.png'))
        print(iid, spr.size, f'spill into empty cells: {leak:.1%}')


def do_sheet(kind, names_sizes, gap_x=25, gap_y=20):
    """names_sizes: list of (name, max_w, max_h) in reading order (None name = skip)."""
    im = Image.open(os.path.join(RAW, kind + '_sheet.png')).convert('RGBA')
    boxes = segment(im, gap_x, gap_y)
    print('found', len(boxes), 'sprites')
    assert len(boxes) == len(names_sizes), f'found {len(boxes)}, expected {len(names_sizes)}'
    os.makedirs(os.path.join(OUT, kind), exist_ok=True)
    for (name, mw, mh), b in zip(names_sizes, boxes):
        if not name:
            continue
        spr = pixelate(im.crop(b), mw, mh)
        spr.save(os.path.join(OUT, kind, name + '.png'))
        print(name, spr.size)


def do_bg(name, w=480, h=270, colors=48):
    im = Image.open(os.path.join(RAW, 'bg_' + name + '.png')).convert('RGB')
    W, H = im.size
    # crop to 16:9 from the centre
    tw = min(W, round(H * 16 / 9)); th = round(tw * 9 / 16)
    im = im.crop(((W - tw) // 2, (H - th) // 2, (W - tw) // 2 + tw, (H - th) // 2 + th))
    small = im.resize((w, h), Image.BOX).quantize(colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert('RGB')
    os.makedirs(os.path.join(OUT, 'bg'), exist_ok=True)
    small.save(os.path.join(OUT, 'bg', name + '.png'))
    print(name, small.size)


if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'items':
        do_items()
    elif cmd == 'chars':
        do_chars()
    elif cmd == 'props':
        do_props()
    elif cmd == 'previewcc':
        p = os.path.join(RAW, sys.argv[2] + '_sheet.png')
        bx = segment_cc(Image.open(p).convert('RGBA'))
        print(len(bx), 'sprites:', json.dumps(bx))
        contact(p, os.path.join(RAW, sys.argv[2] + '_preview.png'), bx)
    elif cmd == 'preview':
        p = os.path.join(RAW, sys.argv[2] + '_sheet.png')
        gx = int(sys.argv[3]) if len(sys.argv) > 3 else 25
        gy = int(sys.argv[4]) if len(sys.argv) > 4 else 20
        bx = segment(Image.open(p).convert('RGBA'), gx, gy)
        print(len(bx), 'sprites:', json.dumps(bx))
        contact(p, os.path.join(RAW, sys.argv[2] + '_preview.png'), bx)
    elif cmd == 'bg':
        do_bg(sys.argv[2])
    else:
        print(__doc__)


def floor_line(name):
    """Row (in the 480x270 background) where the floor's top edge is: strongest horizontal edge in the bottom third."""
    im = Image.open(os.path.join(OUT, 'bg', name + '.png')).convert('L')
    w, h = im.size; px = im.load(); best = (0, 0)
    for y in range(int(h * 0.7), h - 4):
        s = sum(abs(px[x, y] - px[x, y - 1]) for x in range(w)) + sum(abs(px[x, y + 1] - px[x, y - 2]) for x in range(w)) * 0.5
        best = max(best, (s, y))
    return best[1]


if __name__ == '__main__' and sys.argv[1] == 'floor':
    print(sys.argv[2], floor_line(sys.argv[2]))


def do_arrows():
    """Arrow Bundle item (archer only): three of ChatGPT's arrows, fanned and tied with a leather strap."""
    props = cutouts(Image.open(os.path.join(RAW, 'props_sheet.png')).convert('RGBA'))
    arrow = props[[p[0] for p in PROPS].index('arrow')].rotate(90, expand=True)  # tip up
    aw, ah = arrow.size
    W, H = int(aw * 2.4), int(ah * 1.08)
    hi = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    for ang, dx in ((6, -aw * 0.45), (0, 0), (-6, aw * 0.45)):
        a = arrow.rotate(ang, expand=True, resample=Image.BICUBIC)
        hi.alpha_composite(a, (int(W / 2 - a.width / 2 + dx), int(H - a.height)))
    d = ImageDraw.Draw(hi)
    sy = int(H * 0.6); sh = max(8, int(ah * 0.1))
    d.rectangle((int(W / 2 - aw * 1.05), sy, int(W / 2 + aw * 1.05), sy + sh), fill=(107, 68, 35, 255), outline=(40, 24, 12, 255), width=max(2, sh // 4))
    spr, leak = fit_to_shape(hi, [[1], [1]])
    spr.save(os.path.join(OUT, 'items', 'arrows.png'))
    print('arrows', spr.size)


if __name__ == '__main__' and sys.argv[1] == 'arrows':
    do_arrows()


# ---------- new item icons (pets & gear) ----------
ITEMS2 = [('pet_dog', [[1, 1], [1, 1]]), ('pet_catgray', [[1, 1]]), ('pet_catcalico', [[1, 1]]), ('pet_cockatiel', [[1]]), ('pet_dragon', [[1, 1], [1, 1]]),
          ('wings', [[1, 1]]), ('phoenix', [[1], [1]]), ('treats', [[1]]), ('hourglass', [[1], [1]]), ('lantern', [[1], [1]])]


def do_items2():
    im = Image.open(os.path.join(RAW, 'items2_sheet.png')).convert('RGBA')
    sprites = cutouts(im)
    assert len(sprites) == len(ITEMS2), f'found {len(sprites)} sprites, expected {len(ITEMS2)}'
    for (iid, shape), src in zip(ITEMS2, sprites):
        spr, leak = fit_to_shape(src, shape)
        spr.save(os.path.join(OUT, 'items', iid + '.png')); print(iid, spr.size)


# ---------- terrain tiles: per theme a plain block and a "top" block, 15x15 art px (30 px in game) ----------
TILE_THEMES = ['hall', 'cave', 'crypt', 'boss', 'camp', 'forge', 'hollow', 'sanctum']


def do_tiles():
    im = Image.open(os.path.join(RAW, 'tiles_sheet.png')).convert('RGBA')
    sprites = cutouts(im)
    assert len(sprites) == 16, f'found {len(sprites)} tiles, expected 16'
    os.makedirs(os.path.join(OUT, 'tiles'), exist_ok=True)
    for i, src in enumerate(sprites):
        th, kind = TILE_THEMES[i // 2], ('block', 'top')[i % 2]
        w, h = src.size; s = min(w, h)
        sq = src.crop(((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s)).convert('RGB')
        t = sq.resize((15, 15), Image.BOX).quantize(20, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE).convert('RGBA')
        t.save(os.path.join(OUT, 'tiles', f'{th}_{kind}.png')); print(th, kind)


# ---------- one-way ledges per theme + hazard props ----------
def do_ledges():
    im = Image.open(os.path.join(RAW, 'ledges_sheet.png')).convert('RGBA')
    sprites = cutouts(im)
    assert len(sprites) == 12, f'found {len(sprites)} pieces, expected 12'
    for th, src in zip(TILE_THEMES, sprites[:8]):
        spr = pixelate_scale(src, 12 / src.height)
        spr.save(os.path.join(OUT, 'tiles', f'{th}_ledge.png')); print(th, 'ledge', spr.size)
    for (name, mw, mh), src in zip([('spikes', 15, 15), ('crumble', 15, 15), ('vent', 15, 8), ('chest_gold', 23, 99)], sprites[8:]):
        spr = pixelate(src, mw, mh) if name != 'chest_gold' else pixelate_scale(src, 23 / src.width)
        spr.save(os.path.join(OUT, 'props', name + '.png')); print(name, spr.size)


if __name__ == '__main__' and sys.argv[1] in ('items2', 'tiles', 'ledges'):
    {'items2': do_items2, 'tiles': do_tiles, 'ledges': do_ledges}[sys.argv[1]]()


# ---------- buff plants + secret stash chest ----------
PLANT_IDS = ['bloodberry', 'ember', 'stone', 'swift', 'catnip', 'mandrake']


def do_plants():
    im = Image.open(os.path.join(RAW, 'plants_sheet.png')).convert('RGBA')
    sprites = cutouts(im)
    sprites = [sp for sp in sprites if sp.width * sp.height > 0.3 * max(q.width * q.height for q in sprites)]  # drop stray sparkles
    assert len(sprites) == 7, f'found {len(sprites)} sprites, expected 7'
    for kind, src in zip(PLANT_IDS, sprites[:6]):
        spr = pixelate(src, 16, 16)
        spr.save(os.path.join(OUT, 'props', 'plant_' + kind + '.png')); print(kind, spr.size)
    spr = pixelate(sprites[6], 23, 18)
    spr.save(os.path.join(OUT, 'props', 'chest_secret.png')); print('chest_secret', spr.size)


if __name__ == '__main__' and sys.argv[1] == 'plants':
    do_plants()


# ---------- class-only item icons: one 5x2 sheet per class (assets_raw/items_<class>_sheet.png) ----------
T1, T2, T3, T4 = [[1]], [[1], [1]], [[1], [1], [1]], [[1], [1], [1], [1]]
W2, W3, SQ = [[1, 1]], [[1, 1, 1]], [[1, 1], [1, 1]]
CLASS_ITEMS = {
    'warrior': [('greatsword', T4), ('warhammer', [[1, 1, 1], [0, 1, 0], [0, 1, 0]]), ('towershield', [[1, 1], [1, 1], [1, 1]]), ('torc', W2), ('banner', T3),
                ('breastplate', SQ), ('bgauntlet', T1), ('giantbelt', W3), ('lionheart', T1), ('dragonslayer', T4)],
    'archer': [('longbow', T4), ('bodkin', T2), ('twinquiver', SQ), ('frostarrows', T2), ('blastarrows', W2),
               ('hawkeye', T1), ('bracer', W2), ('rangercloak', SQ), ('fletching', T1), ('starfall', [[1, 1], [1, 0], [1, 1]])],
    'rogue': [('venom', T1), ('kris', T2), ('shadowcloak', SQ), ('knives', W2), ('lockpicks', T1),
              ('duelist', W2), ('shadowstep', [[1, 0], [1, 1]]), ('bloodring', T1), ('rmask', W2), ('nightfang', SQ)],
    # Backpack Sanctuary pet items: three sheets (assets_raw/items_pets1_sheet.png ...), read left to right, top to bottom
    'pets1': [('collar', T1), ('chewbone', W2), ('clawfile', T1), ('vest', SQ), ('blanket', W3),
              ('incubator', SQ), ('harness', SQ), ('bell', T1), ('huntmark', T1), ('squeaky', W2)],
    'pets2': [('catnip', T1), ('cuttlebone', T2), ('heatrock', W2), ('bogmoss', T1), ('truffle', T1),
              ('nightshade', T1), ('hexcharm', T1), ('healbell', T2), ('dragonheart', SQ), ('alphafang', T1)],
    'pets3': [('salve', T1), ('herb', T1), ('salts', T1), ('brew', T1), ('smoke', T1), ('net', W2),
              ('egg_cockatiel', T1), ('egg_owl', T2), ('egg_toad', T1), ('egg_dragon', SQ), ('egg_elder', SQ)],
    # awkward-shape items (assets_raw/items_pets4_sheet.png): the new batch
    'pets4': [('horseshoe', [[1, 0, 1], [1, 1, 1]]), ('glownectar', [[1, 0], [1, 1]]), ('embertotem', [[1, 1, 1], [0, 1, 0]]), ('boneflute', [[1, 1, 1, 1]]),
              ('serpenttorc', [[0, 1, 1], [1, 1, 0]]), ('antlercrown', [[1, 1, 0], [0, 1, 1]]), ('saddlebag', [[1, 1], [1, 1], [1, 0]]),
              ('buckler', [[0, 1, 0], [1, 1, 1], [1, 1, 1]]), ('windchimes', [[1, 0, 1], [1, 1, 1], [1, 0, 1]]), ('huntinghorn', [[1, 0, 0], [1, 1, 1]]),
              ('emberring', [[1, 1, 1], [1, 0, 1], [1, 1, 1]]), ('wishbone', [[1, 0, 1], [0, 1, 0]])],
    # old 1-block items redrawn for their new awkward shapes (items_pets5_sheet.png)
    'pets5': [('collar', [[1, 1], [1, 0], [1, 1]]), ('clawfile', T3), ('treats', [[1, 0], [1, 1]]), ('spikes', [[1, 1, 1], [1, 0, 1]]),
              ('whistle', [[1, 1, 1], [0, 0, 1]]), ('bell', [[0, 1, 0], [1, 1, 1]]), ('huntmark', [[0, 1], [1, 1], [1, 0]]), ('nightshade', T2),
              ('hexcharm', [[1, 0, 1], [0, 1, 0], [1, 0, 1]]), ('alphafang', [[1, 1], [1, 0], [1, 0]]), ('bogmoss', [[1, 1, 0], [0, 1, 1]]), ('truffle', [[1, 1], [1, 0]])],
    # the fire beasts' eggs (items_pets6_sheet.png)
    'pets6': [('egg_phoenix', T2), ('egg_salamander', W3), ('egg_tortoise', SQ), ('egg_moth', T3)],
    'beastmaster': [('barbwhip', W3), ('alphahorn', W2), ('collar', T1), ('totem', T2), ('poultice', T1),
                    ('falconglove', W2), ('whistle', T1), ('wolfcloak', SQ), ('bearclaw', T1), ('crown', W3)],
}


def do_classitems(cls):
    im = Image.open(os.path.join(RAW, f'items_{cls}_sheet.png')).convert('RGBA')
    sprites = cutouts(im)
    sprites = [sp for sp in sprites if sp.width * sp.height > 0.06 * max(q.width * q.height for q in sprites)]  # drop stray sparkles
    want = CLASS_ITEMS[cls]
    assert len(sprites) == len(want), f'found {len(sprites)} sprites, expected {len(want)}'
    for (iid, shape), src in zip(want, sprites):
        spr, leak = fit_to_shape(src, shape)
        spr.save(os.path.join(OUT, 'items', iid + '.png')); print(iid, spr.size)


if __name__ == '__main__' and sys.argv[1] == 'classitems':
    do_classitems(sys.argv[2])


# ---------- new pet icons + rescue cages (4x2 sheet: 5 pet icons, cage, broken cage) ----------
def do_petcages():
    im = Image.open(os.path.join(RAW, 'petcages_sheet.png')).convert('RGBA')
    sprites = cutouts(im)
    sprites = [sp for sp in sprites if sp.width * sp.height > 0.15 * max(q.width * q.height for q in sprites)]
    assert len(sprites) == 7, f'found {len(sprites)} sprites, expected 7'
    for iid, src in zip(['pet_fox', 'pet_owl', 'pet_ferret', 'pet_boar', 'pet_toad'], sprites[:5]):
        spr, leak = fit_to_shape(src, [[1, 1], [1, 1]])
        spr.save(os.path.join(OUT, 'items', iid + '.png')); print(iid, spr.size)
    for name, src in zip(['cage', 'cage_open'], sprites[5:]):
        spr = pixelate(src, 24, 24)
        spr.save(os.path.join(OUT, 'props', name + '.png')); print(name, spr.size)


if __name__ == '__main__' and sys.argv[1] == 'petcages':
    do_petcages()


# ---- Sanctuary hub props: 4 class banners, standing mirror, records board, pet bed (in that reading order) ----
def do_hubprops():
    im = Image.open(os.path.join(RAW, 'hubprops_sheet.png')).convert('RGBA')
    sprites = cutouts(im)
    sprites = [sp for sp in sprites if sp.width * sp.height > 0.04 * max(q.width * q.height for q in sprites)]
    assert len(sprites) == 7, f'found {len(sprites)} sprites, expected 7'
    names = [('hub_banner_warrior', 26, 50), ('hub_banner_archer', 26, 50), ('hub_banner_rogue', 26, 50), ('hub_banner_beastmaster', 26, 50),
             ('hub_mirror', 24, 38), ('hub_board', 38, 34), ('hub_petbed', 22, 9)]
    for (name, mw, mh), src in zip(names, sprites):
        spr = pixelate(src, mw, mh)
        spr.save(os.path.join(OUT, 'props', name + '.png')); print(name, spr.size)


if __name__ == '__main__' and sys.argv[1] == 'hubprops':
    do_hubprops()


# ---------- the menu UI kit: one sheet (assets_raw/ui_kit_sheet.png) -> assets/ui/*.png, used 9-sliced at 2x ----------
UI_KIT = [('panel_leather', 64, 64), ('panel_parch', 64, 60), ('btn', 64, 22), ('btn_hover', 64, 22), ('btn_off', 64, 22),
          ('slot', 24, 24), ('banner', 128, 26), ('seal', 22, 22)]


def do_uikit():
    im = Image.open(os.path.join(RAW, 'ui_kit_sheet.png')).convert('RGBA')
    sprites = cutouts(im)
    sprites = [sp for sp in sprites if sp.width * sp.height > 0.02 * max(q.width * q.height for q in sprites)]
    assert len(sprites) == len(UI_KIT), f'found {len(sprites)} pieces, expected {len(UI_KIT)}'
    os.makedirs(os.path.join(OUT, 'ui'), exist_ok=True)
    for (name, w, h), src in zip(UI_KIT, sprites):
        out = src.resize((w, h), Image.LANCZOS)                     # exact size: 9-slice needs it
        px = out.load()
        for y in range(h):                                           # hard pixel edges, no soft alpha
            for x in range(w):
                r, g, b, a = px[x, y]
                px[x, y] = (r, g, b, 255 if a >= 110 else 0)
        out.save(os.path.join(OUT, 'ui', name + '.png')); print(name, out.size)


if __name__ == '__main__' and sys.argv[1] == 'uikit':
    do_uikit()
