"""Paper-doll heroes: ChatGPT base bodies, and the pieces ChatGPT draws onto them, as layers that stack exactly.

    python -P tools/paperdoll.py base m            # assets_raw/doll/base_m.png -> assets/doll/base_m.png (+ _skin) + base_m.json
    python -P tools/paperdoll.py piece m hat_cap   # assets_raw/doll/hat_cap_m.png -> assets/doll/hat_cap_m.png
    python -P tools/paperdoll.py seg m             # assets_raw/doll/seg_m.png (ChatGPT's body-part colour map) -> zones per frame
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
    sheet = Image.new('RGBA', (COLS * CW, rows * CH)); skin = Image.new('RGBA', sheet.size); cells = []
    for i, (box, spr, anc) in enumerate(fr):
        win = place(spr, box, meta, i); cell = shrink(win, (CW, CH))
        sk = Image.new('RGBA', cell.size); sp, cp = sk.load(), cell.load(); rest = cell.copy(); rp = rest.load()
        for y in range(CH):
            for x in range(CW):
                r, g, b, a = cp[x, y]
                if a and is_skin(r, g, b):   # skin: its own grey layer (lightest skin = white), tinted in the game
                    sp[x, y] = (r, g, b, 255); rp[x, y] = (0, 0, 0, 0)
        cells.append((i, rest, sk))
    to_grey([c[2] for c in cells])   # (one brightness scale for the whole sheet, so the skin doesn't pulse from frame to frame)
    for i, rest, sk in cells:
        cx, cy = cell_pos(i); sheet.paste(rest, (cx, cy)); skin.paste(sk, (cx, cy))
    sheet.save(os.path.join(OUT, f'base_{sex}.png')); skin.save(os.path.join(OUT, f'base_{sex}_skin.png'))
    json.dump(meta, open(os.path.join(RAW, f'base_{sex}.meta.json'), 'w'))
    json.dump(sheet_json(f'base_{sex}'), open(os.path.join(OUT, f'base_{sex}.json'), 'w'))
    print('base', sex, 'frames', n, 'scale', round(meta['scale'], 4), 'sheet', sheet.size)


def steady_idle(cells):
    """The idle loop: the body stands still in it (its frames match), so the piece should too. A pixel the piece has in
    all but one of the frames is real, and the odd frame borrows it from its neighbour; one it has in fewer (a stray bit,
    or a lock of hair ChatGPT drew on every other frame) goes from all of them. (Otherwise bits blink on and off while the
    hero stands there.)"""
    n = len(cells); px = [c.load() for c in cells]; w, h = cells[0].size
    for y in range(h):
        for x in range(w):
            have = [j for j in range(n) if px[j][x, y][3]]
            if 0 < len(have) < n - 1:
                for j in have: px[j][x, y] = (0, 0, 0, 0)
            elif len(have) == n - 1:
                j = next(j for j in range(n) if j not in have); src = min(have, key=lambda k: min(abs(k - j), n - abs(k - j)))
                px[j][x, y] = px[src][x, y]


def to_grey(cells):
    """Grey versions of these cells (skin or hair, tinted in the game), all on ONE brightness scale (the sheet's lightest
    3% = white): scaled frame by frame instead, their brightness would flicker as the animation plays."""
    lum = sorted(0.3 * p[0] + 0.59 * p[1] + 0.11 * p[2] for c in cells for p in c.getdata() if p[3])
    top = lum[int(len(lum) * 0.97)] if lum else 255
    for c in cells:
        px = c.load()
        for y in range(c.height):
            for x in range(c.width):
                r, g, b, a = px[x, y]
                if a: v = min(255, round((0.3 * r + 0.59 * g + 0.11 * b) * 255 / max(1, top))); px[x, y] = (v, v, v, 255)


# ---------- body zones (from ChatGPT's colour map of the body: tools/paperdoll.py seg <sex>) ----------
ZONES = {1: ('head', (255, 0, 0)), 2: ('torso', (0, 255, 0)), 3: ('arms', (0, 0, 255)), 4: ('hands', (255, 255, 0)),
         5: ('hips', (255, 128, 0)), 6: ('legs', (0, 255, 255)), 7: ('feet', (255, 255, 255))}
# per slot: home = where the piece grows from (only parts of it connected to these are kept); ban = body parts it never
# covers; bare = body parts where it never brings bare skin along (that skin is the body's, tinted to the skin tone)
SLOT_RULES = {
    'hair': dict(home=['head'], ban=['arms', 'hands', 'hips', 'legs', 'feet'], bare=[], reach=3),   # (hair and hats grow from the head itself)
    'head': dict(home=['head'], ban=['arms', 'hands', 'hips', 'legs', 'feet'], bare=['head', 'torso'], reach=3),
    'top': dict(home=['torso', 'arms'], ban=['legs', 'feet'], bare=['head', 'hands', 'arms', 'torso']),
    'cape': dict(home=['torso', 'arms', 'hips', 'legs'], ban=['hands', 'legs', 'feet'], bare=['head', 'arms', 'torso']),   # (it hangs behind: what shows is next to any of these)
    'bottom': dict(home=['hips', 'legs'], ban=['head', 'torso', 'arms', 'hands'], bare=['feet']),
    'shoe': dict(home=['feet'], ban=['head', 'torso', 'arms', 'hands', 'hips'], bare=[]),
    'wep': dict(home=['hands'], ban=[], bare=['head', 'torso', 'arms', 'hands', 'hips', 'legs', 'feet']),
}


def align(emask, ebox, eanc, meta, i, bmask, ks=(0.94, 0.97, 1.0, 1.03, 1.06), r=12):
    """Best (score, k, dx, dy) lining up a full-size mask of an edited frame with the base window's mask (Dice, a third
    of full size; coarse then fine)."""
    w, h = bmask.size; bs = bmask.resize((w // 3, h // 3), Image.BOX).point(lambda v: 255 if v > 100 else 0)
    def score(k, dx, dy):
        m = warp(emask, ebox, eanc, meta, i, k, dx, dy, w, h).resize((w // 3, h // 3), Image.BOX).point(lambda v: 255 if v > 100 else 0)
        inter = ImageStat.Stat(ImageChops.multiply(m, bs)).sum[0] / 255; tot = (ImageStat.Stat(m).sum[0] + ImageStat.Stat(bs).sum[0]) / 255
        return 2 * inter / max(1, tot)
    best = (-1, 1, 0, 0)
    for k in ks:
        for dy in range(-r, r + 1, 3):
            for dx in range(-r, r + 1, 3):
                sc = score(k, dx, dy)
                if sc > best[0]: best = (sc, k, dx, dy)
    _, k0, dx0, dy0 = best
    for k in ([k0 - 0.015, k0, k0 + 0.015] if len(ks) > 1 else [k0]):
        for dy in range(dy0 - 2, dy0 + 3):
            for dx in range(dx0 - 2, dx0 + 3):
                sc = score(k, dx, dy)
                if sc > best[0]: best = (sc, k, dx, dy)
    return best


def alpha_of(im): return im.getchannel('A').point(lambda a: 255 if a >= 128 else 0)


def do_seg(sex):
    """Body zones for every frame, at the base window's raw size: assets_raw/doll/seg_<sex>/<frame>.png (0 = no body,
    1..7 = ZONES). The colour map is lined up with the base by silhouette; body pixels it doesn't cover take the nearest zone."""
    meta = json.load(open(os.path.join(RAW, f'base_{sex}.meta.json')))
    bfr, _ = frames_of(os.path.join(RAW, f'base_{sex}.png')); sfr, _ = frames_of(os.path.join(RAW, f'seg_{sex}.png'))
    d = os.path.join(RAW, f'seg_{sex}'); os.makedirs(d, exist_ok=True); report = []
    for i in range(len(bfr)):
        bbox, bspr, _ = bfr[i]; sbox, sspr, sanc = sfr[i]
        bwin = place(bspr, bbox, meta, i); w, h = bwin.size; body = alpha_of(bwin)
        sc, k, dx, dy = align(alpha_of(sspr), sbox, sanc, meta, i, body)
        swin = warp(sspr, sbox, sanc, meta, i, k, dx, dy, w, h); sp = swin.load(); bp = body.load()
        lab = Image.new('L', (w, h), 0); lp = lab.load()
        for y in range(h):
            for x in range(w):
                if not bp[x, y]: continue
                r, g, b, a = sp[x, y]
                if a < 128: continue
                lp[x, y] = min(ZONES, key=lambda z: sum((u - v) ** 2 for u, v in zip((r, g, b), ZONES[z][1])))
        for _ in range(40):   # body pixels the map missed: the nearest zone (grown in from the neighbours)
            gaps = [(x, y) for y in range(h) for x in range(w) if bp[x, y] and not lp[x, y]]
            if not gaps: break
            grown = lab.filter(ImageFilter.MaxFilter(3)); gp = grown.load()
            for x, y in gaps: lp[x, y] = gp[x, y]
        lab.save(os.path.join(d, f'{i}.png')); report.append(round(sc, 2))
    print('seg', sex, 'fit (silhouette match per frame):', report)


def arms_over_head(Z):
    """True when the arms or hands are up over the head (an overhead swing): more than a fifth of the head's area of
    arm/hand above the middle of the head and no further out to the sides than the head is wide."""
    hb = Z['head'].getbbox()
    if not hb: return False
    x0, y0, x1, y1 = hb; w = x1 - x0; ym = (y0 + y1) // 2
    box = (max(0, x0 - w // 2), 0, x1 + w // 2, ym)
    up = union([Z['arms'], Z['hands']], Z['head'].size).crop(box)
    return ImageStat.Stat(up).sum[0] > 0.2 * ImageStat.Stat(Z['head']).sum[0]


def zones_of(sex, i):
    p = os.path.join(RAW, f'seg_{sex}', f'{i}.png')
    if not os.path.exists(p): return None
    lab = Image.open(p)
    return {nm: lab.point(lambda v, z=z: 255 if v == z else 0) for z, (nm, _) in ZONES.items()}


def union(masks, size):
    out = Image.new('L', size, 0)
    for m in masks: out = ImageChops.lighter(out, m)
    return out


def touching(m, home, reach=15, floor=20):
    """Only the connected parts of the mask that touch the home zone (grown by `reach` px), and none smaller than `floor`."""
    near = home.filter(ImageFilter.MaxFilter(reach)); np_ = near.load()
    w, h = m.size; px = m.load(); seen = bytearray(w * h); out = Image.new('L', m.size, 0); op = out.load()
    for y in range(h):
        for x in range(w):
            if px[x, y] and not seen[y * w + x]:
                st = [(x, y)]; seen[y * w + x] = 1; pts = []; hit = False
                while st:
                    cx, cy = st.pop(); pts.append((cx, cy)); hit = hit or bool(np_[cx, cy])
                    for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1), (cx + 1, cy + 1), (cx - 1, cy - 1), (cx + 1, cy - 1), (cx - 1, cy + 1)):
                        if 0 <= nx < w and 0 <= ny < h and px[nx, ny] and not seen[ny * w + nx]: seen[ny * w + nx] = 1; st.append((nx, ny))
                if hit and len(pts) >= floor:
                    for x2, y2 in pts: op[x2, y2] = 255
    return out


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
    sheet = Image.new('RGBA', (COLS * CW, rows * CH)); report = []; cells = []
    slot = name.split('_')[0]; rule = SLOT_RULES.get(slot)
    # 1) line every frame up with the body (by the skin, which mostly stays put)
    fits = []
    for i in range(n):
        bbox, bspr, _ = bfr[i]; ebox, espr, eanc = efr[i]
        fits.append(align(skin_mask(espr), ebox, eanc, meta, i, skin_mask(place(bspr, bbox, meta, i))))
    # 2) one scale per row (ChatGPT draws a row at one size): frame by frame, the piece would grow and shrink as it animates
    i0 = 0
    for _, cnt in ROWS:
        ks = sorted(f[1] for f in fits[i0:i0 + cnt]); km = ks[len(ks) // 2]
        for i in range(i0, i0 + cnt):
            if abs(fits[i][1] - km) > 0.005:
                bbox, bspr, _ = bfr[i]; ebox, espr, eanc = efr[i]
                fits[i] = align(skin_mask(espr), ebox, eanc, meta, i, skin_mask(place(bspr, bbox, meta, i)), ks=(km,))
        i0 += cnt
    # 3) cut the piece out of every frame
    for i in range(n):
        bbox, bspr, _ = bfr[i]; ebox, espr, eanc = efr[i]
        bwin = place(bspr, bbox, meta, i); w, h = bwin.size
        sc, k, dx, dy = fits[i]
        ewin = warp(espr, ebox, eanc, meta, i, k, dx, dy, w, h)
        new = region_of(ewin, bwin, thresh)
        if not allow_skin: new = ImageChops.subtract(new, skin_mask(ewin))
        Z = zones_of(sex, i) if rule else None
        if Z:   # only where this kind of piece goes, grown from its home on the body, never bringing that body's bare skin along
            new = ImageChops.subtract(new, union([Z[z] for z in rule['ban']], new.size))
            new = ImageChops.subtract(new, ImageChops.multiply(skin_mask(ewin), union([Z[z] for z in rule['bare']], new.size)))
            home = union([Z[z] for z in rule['home']], new.size); reach = rule.get('reach', 15)
            if reach < 15:   # hair and hats: from the head itself, or anything near it ABOVE its bottom (a plume or twin tail the
                hb = Z['head'].getbbox()   # raised arms cut off in an overhead swing), but never body bits below it (chest, shoulders)
                if hb:
                    band = Z["head"].filter(ImageFilter.MaxFilter(41)); band.paste(0, (0, (hb[1] + hb[3]) // 2, band.width, band.height)); home = ImageChops.lighter(home, band)   # (above the middle of the head)
            new = touching(new.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3)), home, reach=reach)
        else:
            if slot in ('top', 'cape', 'head', 'wep'):   # no bare skin in these: a hand or face ChatGPT moved a little stays the body's (tinted)
                new = ImageChops.subtract(new, ImageChops.multiply(skin_mask(ewin), skin_mask(bwin).filter(ImageFilter.MaxFilter(11))))
            new = keep_big(new.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3)))   # drop specks, slivers and stray bits
        piece = ewin.copy(); piece.putalpha(new)
        cells.append(shrink(piece, (CW, CH), cut=56))   # (a lower cut than the body's: thin hair and straps survive the shrink)
        report.append(round(sc, 2))
    steady_idle(cells[:4])
    if grey: to_grey(cells)   # hair: grey on one scale for the whole sheet (tinted in the game)
    for i, cell in enumerate(cells): sheet.paste(cell, cell_pos(i))
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
    elif cmd == 'seg': do_seg(sex)
    elif cmd == 'check': do_check(sex, sys.argv[3:])
