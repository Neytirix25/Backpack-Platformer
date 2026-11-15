"""Paper-doll heroes: ChatGPT base bodies, and the pieces ChatGPT draws onto them, as layers that stack exactly.

    python -P tools/paperdoll.py base m            # assets_raw/doll/base_m.png -> assets/doll/base_m.png (+ _skin) + base_m.json
    python -P tools/paperdoll.py piece m hat_cap   # assets_raw/doll/hat_cap_m.png -> assets/doll/hat_cap_m.png
    python -P tools/paperdoll.py check m hat_cap top_tunic ...   # assets_raw/doll/check_m.png: the base with those pieces on, every frame

Every sheet (base and piece) has the same 8 rows: idle 4, run 6, jump 4, death 4, sword 4, bow 4, dagger 4, whip 4.
A piece sheet is ChatGPT's edit of the base sheet with the piece drawn on. For every frame the edited figure is lined up
with the base figure (a small search over scale and offset that best matches the skin, which mostly stays the same), and
the piece is what's left: pixels unlike anything near them in the base. It then goes through exactly the same scaling as
the base frame, so in the game the layers stack pixel for pixel. Hair pieces are stored in grey (the game tints them);
the base's skin goes to its own grey layer (the game tints it to the skin tone).
"""
import sys, os, json
from PIL import Image, ImageChops, ImageFilter, ImageStat
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import animate as A
from bglayers import keyed

ROOT = A.ROOT
RAW = os.path.join(ROOT, 'assets_raw', 'doll')
OUT = os.path.join(ROOT, 'assets', 'doll')
ROWS = [('idle', 4), ('run', 6), ('jump', 4), ('death', 4), ('sword', 4), ('bow', 4), ('dagger', 4), ('whip', 4)]
COUNTS = [n for _, n in ROWS]
HEIGHT = 28                      # the idle body's height in art px (drawn at 2x), like the old heroes
CW, CH, AX, AY = 96, 56, 48, 48  # every frame lives in a 96x56 cell, feet at (48, 48) (room for a whip lash or an overhead swing)
COLS = 8
os.makedirs(OUT, exist_ok=True)


def is_skin(r, g, b):
    mx, mn = max(r, g, b), min(r, g, b)
    return r >= g >= b - 10 and r - b > 38 and mx > 90 and (mx - mn) / max(1, mx) > 0.22


def skin_mask(im):
    m = Image.new('L', im.size, 0); mp = m.load(); px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            if a >= 128 and is_skin(r, g, b): mp[x, y] = 255
    return m


def frames_of(path):
    """The sheet's frames: [(box, isolated crop, feet anchor in sheet coords)] in row order."""
    im = keyed(Image.open(path))
    comps = A.components(im)
    rows = A.rows_of(comps, COUNTS, im)
    out = []
    for row in rows:
        for box, spr in row:
            ax, ah = A.anchor(spr, False)
            out.append((box, spr, (box[0] + ax, box[1] + ah)))
    return out, im


def shrink(win, size, cut=110):   # premultiplied box-downscale with a hard alpha edge
    pm = Image.new('RGBA', win.size); pp, sp = pm.load(), win.load()
    for y in range(win.height):
        for x in range(win.width):
            r, g, b, a = sp[x, y]; pp[x, y] = (r * a // 255, g * a // 255, b * a // 255, a)
    sm = pm.resize(size, Image.BOX); q = sm.load(); out = Image.new('RGBA', size); op = out.load()
    for y in range(size[1]):
        for x in range(size[0]):
            r, g, b, a = q[x, y]
            op[x, y] = (0, 0, 0, 0) if a < cut else (min(255, r * 255 // a), min(255, g * 255 // a), min(255, b * 255 // a), 255)
    return out


def window(meta, i):
    """Frame i's window in the base sheet's raw coordinates (the area that becomes its cell)."""
    s = meta['scale']; fx, fy = meta['frames'][i]['anchor']
    x0, y0 = fx - AX / s, fy - AY / s
    return x0, y0, round(CW / s), round(CH / s)


def place(spr, box, meta, i):
    """The isolated base sprite drawn into frame i's window."""
    x0, y0, w, h = window(meta, i)
    win = Image.new('RGBA', (w, h)); win.paste(spr, (round(box[0] - x0), round(box[1] - y0)), spr)
    return win


def warp(spr, box, anc_e, meta, i, k, dx, dy, w, h):
    """The edited sprite resampled into frame i's window: base raw = window + (u, v); edit raw = k (base - base anchor) + edit anchor + d."""
    x0, y0, _, _ = window(meta, i); bax, bay = meta['frames'][i]['anchor']
    ox = k * (x0 - bax) + anc_e[0] + dx - box[0]; oy = k * (y0 - bay) + anc_e[1] + dy - box[1]
    return spr.transform((w, h), Image.AFFINE, (k, 0, ox, 0, k, oy), Image.NEAREST)


def cell_pos(i):
    return (i % COLS) * CW, (i // COLS) * CH


def sheet_json(name, extra=None):
    frames, i = {}, 0
    for row, n in ROWS:
        frames[row] = [[*cell_pos(i + j), CW, CH, AX, AY] for j in range(n)]; i += n
    d = {'fly': False, 'anims': frames}
    if extra: d.update(extra)
    return d


def do_base(sex):
    fr, im = frames_of(os.path.join(RAW, f'base_{sex}.png'))
    idle_h = sorted(f[1].height for f in fr[:4])[2]
    meta = {'scale': HEIGHT / idle_h, 'frames': [{'box': list(b), 'anchor': [a[0], a[1]]} for b, _, a in fr]}
    n = len(fr); rows = (n + COLS - 1) // COLS
    sheet = Image.new('RGBA', (COLS * CW, rows * CH)); skin = Image.new('RGBA', sheet.size)
    for i, (box, spr, anc) in enumerate(fr):
        win = place(spr, box, meta, i); cell = shrink(win, (CW, CH))
        sk = Image.new('RGBA', cell.size); sp, cp = sk.load(), cell.load(); rest = cell.copy(); rp = rest.load()
        for y in range(CH):
            for x in range(CW):
                r, g, b, a = cp[x, y]
                if a and is_skin(r, g, b):   # skin: its own grey layer (lightest skin = white), tinted in the game
                    sp[x, y] = (r, g, b, 255); rp[x, y] = (0, 0, 0, 0)
        lum = [0.3 * p[0] + 0.59 * p[1] + 0.11 * p[2] for p in sk.getdata() if p[3]]
        top = sorted(lum)[int(len(lum) * 0.97)] if lum else 255
        for y in range(CH):
            for x in range(CW):
                r, g, b, a = sp[x, y]
                if a: v = min(255, round((0.3 * r + 0.59 * g + 0.11 * b) * 255 / max(1, top))); sp[x, y] = (v, v, v, 255)
        cx, cy = cell_pos(i); sheet.paste(rest, (cx, cy)); skin.paste(sk, (cx, cy))
    sheet.save(os.path.join(OUT, f'base_{sex}.png')); skin.save(os.path.join(OUT, f'base_{sex}_skin.png'))
    json.dump(meta, open(os.path.join(RAW, f'base_{sex}.meta.json'), 'w'))
    json.dump(sheet_json(f'base_{sex}'), open(os.path.join(OUT, f'base_{sex}.json'), 'w'))
    print('base', sex, 'frames', n, 'scale', round(meta['scale'], 4), 'sheet', sheet.size)


_LAB = None
def lab(im):   # CIE Lab (L, a, b in 0-255): olive leather and tan skin are far apart here, unlike in RGB
    global _LAB
    if _LAB is None:
        from PIL import ImageCms
        _LAB = ImageCms.buildTransformFromOpenProfiles(ImageCms.createProfile('sRGB'), ImageCms.createProfile('LAB'), 'RGB', 'LAB')
    from PIL import ImageCms
    return ImageCms.applyTransform(im.convert('RGB'), _LAB)


def mindist(e, b, r=2):
    """Per pixel: how unlike the base the edit is (Lab: the lightness gap plus the colour gaps), allowing the base
    to be off by up to r px (0-255)."""
    best = None; el = lab(e); bl = lab(b)
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            sh = ImageChops.offset(b, dx, dy); shl = ImageChops.offset(bl, dx, dy)
            d3 = ImageChops.difference(el, shl)
            d = ImageChops.add(ImageChops.add(d3.getchannel(0), d3.getchannel(1)), d3.getchannel(2))   # (full lightness: brown cloth over tan skin differs mostly in lightness)
            gone = sh.getchannel('A').point(lambda a: 255 if a < 128 else 0)   # no base there: everything counts as new
            d = ImageChops.lighter(d, gone)
            best = d if best is None else ImageChops.darker(best, d)
    return best


def grow(seed, allowed):
    """The parts of `allowed` connected to `seed` (8-neighbour flood from every seed pixel)."""
    w, h = seed.size; sp, ap = seed.load(), allowed.load(); out = Image.new('L', seed.size, 0); op = out.load()
    st = [(x, y) for y in range(h) for x in range(w) if sp[x, y]]
    for x, y in st: op[x, y] = 255
    while st:
        cx, cy = st.pop()
        for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1), (cx + 1, cy + 1), (cx - 1, cy - 1), (cx + 1, cy - 1), (cx - 1, cy + 1)):
            if 0 <= nx < w and 0 <= ny < h and ap[nx, ny] and not op[nx, ny]: op[nx, ny] = 255; st.append((nx, ny))
    return out


def fill_holes(m):
    """The mask with everything it encloses filled in."""
    from PIL import ImageDraw
    inv = m.point(lambda v: 0 if v else 255); w, h = inv.size
    for c in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        if inv.getpixel(c) == 255: ImageDraw.floodfill(inv, c, 128)
    return ImageChops.lighter(m, inv.point(lambda v: 255 if v == 255 else 0))


def region_of(ewin, bwin, thresh=30, weak_t=12, skin_t=30, close=15):
    """Where the piece is in this frame. The clearly changed pixels mark it out; the gaps between them and everything they
    enclose belong to it too (a dark fold of a jerkin can look like the body's dark outline right next to it, so pixel by
    pixel those would be lost and the body would show through). Bare skin that matches the body is left out, so it takes
    the skin tone like the rest of the body."""
    solid = ewin.getchannel('A').point(lambda a: 255 if a >= 128 else 0)
    d = mindist(ewin, bwin, r=1)
    strong = ImageChops.multiply(d.point(lambda v: 255 if v > thresh else 0), solid)
    strong = strong.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))   # (specks don't bridge gaps)
    # grow from the clear changes into touching pixels that changed a little (dark leather over the dark shorts)
    same_skin = ImageChops.multiply(ImageChops.multiply(skin_mask(ewin), skin_mask(bwin)), d.point(lambda v: 255 if v <= skin_t else 0))
    weak = ImageChops.subtract(ImageChops.multiply(d.point(lambda v: 255 if v > weak_t else 0), solid), same_skin)
    strong = grow(strong, ImageChops.lighter(weak, strong))
    reg = strong.filter(ImageFilter.MaxFilter(close)).filter(ImageFilter.MinFilter(close))   # close the gaps (about 3 px in the game)
    reg = ImageChops.multiply(fill_holes(reg), solid)
    return ImageChops.lighter(ImageChops.subtract(reg, same_skin), strong)


def keep_big(m, frac=0.08, floor=60):
    """Only the connected parts of the mask that are a decent size next to the biggest (the piece, not stray specks)."""
    w, h = m.size; px = m.load(); seen = bytearray(w * h); comps = []
    for y in range(h):
        for x in range(w):
            if px[x, y] and not seen[y * w + x]:
                st = [(x, y)]; seen[y * w + x] = 1; pts = []
                while st:
                    cx, cy = st.pop(); pts.append((cx, cy))
                    for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1), (cx + 1, cy + 1), (cx - 1, cy - 1), (cx + 1, cy - 1), (cx - 1, cy + 1)):
                        if 0 <= nx < w and 0 <= ny < h and px[nx, ny] and not seen[ny * w + nx]: seen[ny * w + nx] = 1; st.append((nx, ny))
                comps.append(pts)
    if not comps: return m
    big = max(len(c) for c in comps); out = Image.new('L', m.size, 0); op = out.load()
    for c in comps:
        if len(c) >= max(floor, big * frac):
            for x, y in c: op[x, y] = 255
    return out


def do_piece(sex, name, grey=False, allow_skin=True, thresh=30):
    meta = json.load(open(os.path.join(RAW, f'base_{sex}.meta.json')))
    bfr, bim = frames_of(os.path.join(RAW, f'base_{sex}.png'))
    efr, eim = frames_of(os.path.join(RAW, f'{name}_{sex}.png'))
    n = len(bfr); rows = (n + COLS - 1) // COLS
    sheet = Image.new('RGBA', (COLS * CW, rows * CH)); report = []
    for i in range(n):
        bbox, bspr, _ = bfr[i]; ebox, espr, eanc = efr[i]
        bwin = place(bspr, bbox, meta, i); w, h = bwin.size
        bsk = skin_mask(bwin).resize((w // 3, h // 3), Image.BOX).point(lambda v: 255 if v > 100 else 0)
        esk_full = skin_mask(espr)
        best = (-1, 1, 0, 0)
        for k in [0.94, 0.97, 1.0, 1.03, 1.06]:   # coarse, then fine
            for dy in range(-12, 13, 3):
                for dx in range(-12, 13, 3):
                    m = warp(esk_full, ebox, eanc, meta, i, k, dx, dy, w, h).resize((w // 3, h // 3), Image.BOX).point(lambda v: 255 if v > 100 else 0)
                    inter = ImageStat.Stat(ImageChops.multiply(m, bsk)).sum[0] / 255
                    tot = (ImageStat.Stat(m).sum[0] + ImageStat.Stat(bsk).sum[0]) / 255
                    sc = 2 * inter / max(1, tot)
                    if sc > best[0]: best = (sc, k, dx, dy)
        _, k0, dx0, dy0 = best
        for k in [k0 - 0.015, k0, k0 + 0.015]:
            for dy in range(dy0 - 2, dy0 + 3):
                for dx in range(dx0 - 2, dx0 + 3):
                    m = warp(esk_full, ebox, eanc, meta, i, k, dx, dy, w, h).resize((w // 3, h // 3), Image.BOX).point(lambda v: 255 if v > 100 else 0)
                    inter = ImageStat.Stat(ImageChops.multiply(m, bsk)).sum[0] / 255
                    tot = (ImageStat.Stat(m).sum[0] + ImageStat.Stat(bsk).sum[0]) / 255
                    sc = 2 * inter / max(1, tot)
                    if sc > best[0]: best = (sc, k, dx, dy)
        sc, k, dx, dy = best
        ewin = warp(espr, ebox, eanc, meta, i, k, dx, dy, w, h)
        new = region_of(ewin, bwin, thresh)
        if not allow_skin: new = ImageChops.subtract(new, skin_mask(ewin))
        if name.split('_')[0] in ('top', 'cape', 'head', 'wep'):   # no bare skin in these: a hand or face ChatGPT moved a little stays the body's (tinted)
            new = ImageChops.subtract(new, ImageChops.multiply(skin_mask(ewin), skin_mask(bwin).filter(ImageFilter.MaxFilter(11))))
        new = keep_big(new.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3)))   # drop specks, slivers and stray bits
        piece = ewin.copy(); piece.putalpha(new)
        cell = shrink(piece, (CW, CH), cut=56)   # (a lower cut than the body's: thin hair and straps survive the shrink)
        if grey:   # hair: grey, lightest = white (tinted in the game)
            cp = cell.load(); lum = [0.3 * p[0] + 0.59 * p[1] + 0.11 * p[2] for p in cell.getdata() if p[3]]
            top = sorted(lum)[int(len(lum) * 0.97)] if lum else 255
            for y in range(CH):
                for x in range(CW):
                    r, g, b, a = cp[x, y]
                    if a: v = min(255, round((0.3 * r + 0.59 * g + 0.11 * b) * 255 / max(1, top))); cp[x, y] = (v, v, v, 255)
        sheet.paste(cell, cell_pos(i)); report.append(round(sc, 2))
    sheet.save(os.path.join(OUT, f'{name}_{sex}.png'))
    weak = [i for i, s in enumerate(report) if s < 0.55]
    print('piece', name, sex, 'fit (skin match per frame):', report, '| weak frames:', weak or 'none')


def do_check(sex, names, z=4):
    base = Image.open(os.path.join(OUT, f'base_{sex}.png')).convert('RGBA'); skin = Image.open(os.path.join(OUT, f'base_{sex}_skin.png')).convert('RGBA')
    tone = (234, 192, 159)
    sk = Image.new('RGBA', skin.size); sp, kp = sk.load(), skin.load()
    for y in range(skin.height):
        for x in range(skin.width):
            v, _, _, a = kp[x, y]
            if a: sp[x, y] = (tone[0] * v // 255, tone[1] * v // 255, tone[2] * v // 255, 255)
    back = []; front = names   # (in the game the cape goes right over the body, under everything else)
    out = Image.new('RGBA', base.size, (70, 80, 96, 255))
    for n in back: out.alpha_composite(Image.open(os.path.join(OUT, f'{n}_{sex}.png')).convert('RGBA'))
    out.alpha_composite(sk); out.alpha_composite(base)
    for n in front:
        im = Image.open(os.path.join(OUT, f'{n}_{sex}.png')).convert('RGBA')
        if n.startswith('hair'):   # tint the grey hair brown, as the game would
            px = im.load()
            for y in range(im.height):
                for x in range(im.width):
                    v, _, _, a = px[x, y]
                    if a: px[x, y] = (94 * v // 255, 60 * v // 255, 37 * v // 255, 255)
        out.alpha_composite(im)
    out = out.resize((out.width * z, out.height * z), Image.NEAREST)
    p = os.path.join(RAW, f'check_{sex}.png'); out.save(p); print('check ->', p)


if __name__ == '__main__':
    cmd, sex = sys.argv[1], sys.argv[2]
    if cmd == 'base': do_base(sex)
    elif cmd == 'piece': do_piece(sex, sys.argv[3], grey=sys.argv[3].startswith('hair'))
    elif cmd == 'check': do_check(sex, sys.argv[3:])
