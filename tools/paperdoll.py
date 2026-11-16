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


def frames_of(path, counts=None):
    """The sheet's frames: [(box, isolated crop, feet anchor in sheet coords)] in row order."""
    im = wing_keyed(Image.open(path)) if counts else keyed(Image.open(path))
    comps = A.components(im)
    rows = A.rows_of(comps, counts or COUNTS, im)
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


# ---------- one design in every frame ----------
# ChatGPT draws every frame of a piece on its own, so left as drawn a garment changes from frame to frame (a sleeve there
# and gone, a pelt a different shape). So each piece is made the same in every frame:
#  - hats and hair (RIGID): one drawing (from the first idle frame), placed on the head of every frame with the head's own
#    position and tilt (found by fitting the first frame's head onto that frame's head zone);
#  - tops, bottoms and shoes (WORN): the same coverage of the body in every frame (learned from the idle frames: which
#    parts, and how far along each arm or leg); ChatGPT's pixels where they fall inside it, and where they're missing the
#    body's own shading recoloured with the garment's colours; stray bits outside it go;
#  - everything: snapped to one palette, so colours can't drift between frames.
# Capes and weapons swing and move, so they keep ChatGPT's frames (palette-snapped).
RIGID = ('hair', 'head')
WORN = {'top': dict(full=['torso'], limb=('arms', 'torso'), maybe=['hips']),
        'bottom': dict(full=['hips'], limb=('legs', 'hips'), maybe=[]),
        'shoe': dict(full=['feet'], limb=('legs', 'feet'), maybe=[])}


def limb_t(zone, prox):
    """How far along the limb each pixel of the zone is, 0 at the body part it joins (prox) .. 255 at its far end, per
    limb (each connected part of the zone measured on its own). Returns an 'L' image."""
    from collections import deque
    w, h = zone.size; zp, pp = zone.load(), prox.load(); out = Image.new('L', zone.size, 0); op = out.load()
    seen = bytearray(w * h)
    nb = ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1))
    pb = prox.getbbox(); pc = ((pb[0] + pb[2]) / 2, (pb[1] + pb[3]) / 2) if pb else (w / 2, h / 2)
    for y in range(h):
        for x in range(w):
            if not zp[x, y] or seen[y * w + x]: continue
            comp = []; st = [(x, y)]; seen[y * w + x] = 1
            while st:
                cx, cy = st.pop(); comp.append((cx, cy))
                for dx, dy in nb:
                    nx, ny = cx + dx, cy + dy
                    if 0 <= nx < w and 0 <= ny < h and zp[nx, ny] and not seen[ny * w + nx]: seen[ny * w + nx] = 1; st.append((nx, ny))
            seeds = [(cx, cy) for cx, cy in comp if any(0 <= cx + dx < w and 0 <= cy + dy < h and pp[cx + dx, cy + dy] for dx, dy in nb)]
            if not seeds: seeds = [min(comp, key=lambda q: (q[0] - pc[0]) ** 2 + (q[1] - pc[1]) ** 2)]
            dist = {q: 0 for q in seeds}; dq = deque(seeds); cs = set(comp)
            while dq:
                q = dq.popleft()
                for dx, dy in nb:
                    r = (q[0] + dx, q[1] + dy)
                    if r in cs and r not in dist: dist[r] = dist[q] + 1; dq.append(r)
            mx = max(dist.values()) or 1
            for q, dd in dist.items(): op[q] = min(255, round(255 * dd / mx))
    return out


def worn_target(Z, cfg, T, hips_on):
    """The body this garment covers in a frame: its full zones, its limb up to T (0..255 along it), the hips if it covers them."""
    size = Z['head'].size; tgt = union([Z[z] for z in cfg['full']] + ([Z['hips']] if hips_on else []), size)
    lz, pz = cfg['limb']
    if T > 0:
        t = limb_t(Z[lz], Z[pz]); lim = ImageChops.multiply(Z[lz], t.point(lambda v: 255 if v <= T else 0))
        tgt = ImageChops.lighter(tgt, lim)
    return tgt


def lumi(px): return 0.3 * px[0] + 0.59 * px[1] + 0.11 * px[2]


def make_worn(slot, frames):
    """frames: [(ewin, mask, bwin, Z)] at raw size. The same coverage in every frame (see above); returns the new pieces."""
    cfg = WORN[slot]; lz, pz = cfg['limb']
    # learn the coverage from the idle frames (the steadiest drawing): how far along the limb, and whether the hips
    ts, hips_cov = [], []
    for ewin, m, bwin, Z in frames[:4]:
        t = limb_t(Z[lz], Z[pz]); mp, tp, lp = m.load(), t.load(), Z[lz].load()
        ts += [tp[x, y] for y in range(m.height) for x in range(m.width) if lp[x, y] and mp[x, y]]
        if 'hips' in cfg['maybe']:
            hz = ImageStat.Stat(Z['hips']).sum[0] / 255; hc = ImageStat.Stat(ImageChops.multiply(Z['hips'], m)).sum[0] / 255
            hips_cov.append(hc / max(1, hz))
    ts.sort()
    covered = len(ts) / max(1, sum(ImageStat.Stat(f[3][lz]).sum[0] / 255 for f in frames[:4]))
    T = ts[int(len(ts) * 0.9)] if ts and covered > 0.08 else 0
    hips_on = bool(hips_cov) and sorted(hips_cov)[len(hips_cov) // 2] > 0.5
    # the garment's colour for the body's shading in each zone (learned from all frames where it was drawn)
    lut, glob = {}, {}
    zid = {nm: z for z, (nm, _) in ZONES.items()}
    tgts = [worn_target(Z, cfg, T, hips_on) for _, _, _, Z in frames]
    for (ewin, m, bwin, Z), tgt in zip(frames, tgts):
        ep, mp, bp, tp = ewin.load(), m.load(), bwin.load(), tgt.load()
        zl = {nm: Z[nm].load() for nm in zid}
        for y in range(m.height):
            for x in range(m.width):
                if mp[x, y] and tp[x, y] and bp[x, y][3] >= 128:
                    zn = next((nm for nm in zid if zl[nm][x, y]), None); b = int(lumi(bp[x, y]) // 16)
                    lut.setdefault((zn, b), []).append(ep[x, y][:3]); glob.setdefault(b, []).append(ep[x, y][:3])
    med = lambda cs: tuple(sorted(c[k] for c in cs)[len(cs) // 2] for k in range(3))
    lut = {k: med(v) for k, v in lut.items()}; glob = {k: med(v) for k, v in glob.items()}
    def colour(zn, b):
        if (zn, b) in lut: return lut[(zn, b)]
        if b in glob: return glob[b]
        near = min(glob, key=lambda k: abs(k - b)) if glob else None
        return glob[near] if near is not None else (90, 90, 90)
    out = []
    for (ewin, m, bwin, Z), tgt in zip(frames, tgts):
        body = alpha_of(bwin); w, h = m.size
        keep = ImageChops.lighter(ImageChops.multiply(m, tgt), ImageChops.subtract(m, body))   # inside: only on its coverage; outside the body: as drawn
        keep = touching(keep, tgt, reach=15, floor=8)
        piece = Image.new('RGBA', (w, h)); pp, ep, kp, tp, bp = piece.load(), ewin.load(), keep.load(), tgt.load(), bwin.load()
        zl = {nm: Z[nm].load() for nm in zid}
        for y in range(h):
            for x in range(w):
                if kp[x, y]: pp[x, y] = ep[x, y][:3] + (255,)
                elif tp[x, y] and bp[x, y][3] >= 128:   # covered here but ChatGPT's drawing left it out: the body's shading, in the garment's colours
                    zn = next((nm for nm in zid if zl[nm][x, y]), None); pp[x, y] = colour(zn, int(lumi(bp[x, y]) // 16)) + (255,)
        out.append(piece)
    print(f'  {slot}: covers', cfg['full'] + (['hips'] if hips_on else []), f'+ {lz} to {round(T / 2.55)}% along')
    return out


def head_fit(H0, c0, Hi):
    """The tilt (degrees) that best lays the first frame's head onto this frame's head zone, and the head's centre here."""
    hb = Hi.getbbox()
    if not hb: return 0, c0
    xs = [x for y in range(Hi.height) for x in range(Hi.width) if Hi.getpixel((x, y))]
    ys = [y for y in range(Hi.height) for x in range(Hi.width) if Hi.getpixel((x, y))]
    ci = (sum(xs) / len(xs), sum(ys) / len(ys))
    small = lambda im: im.resize((im.width // 2, im.height // 2), Image.BOX).point(lambda v: 255 if v > 100 else 0)
    hs = small(Hi)
    def score(a):
        r = H0.rotate(a, resample=Image.NEAREST, center=c0, translate=(ci[0] - c0[0], ci[1] - c0[1]))
        rs = small(r); inter = ImageStat.Stat(ImageChops.multiply(rs, hs)).sum[0]; tot = ImageStat.Stat(rs).sum[0] + ImageStat.Stat(hs).sum[0]
        return 2 * inter / max(1, tot)
    best = max(range(-100, 101, 10), key=score)
    best = max(range(best - 8, best + 9, 2), key=score)
    return best, ci


def make_rigid(frames, Zs):
    """frames: [(ewin, mask)]; the first idle frame's drawing placed on every frame's head (see above)."""
    ewin0, m0 = frames[0]; tpl = ewin0.copy(); tpl.putalpha(m0)
    H0 = Zs[0]['head']; xs = [x for y in range(H0.height) for x in range(H0.width) if H0.getpixel((x, y))]
    ys = [y for y in range(H0.height) for x in range(H0.width) if H0.getpixel((x, y))]
    c0 = (sum(xs) / len(xs), sum(ys) / len(ys)); out, tilts = [], []
    for i, Z in enumerate(Zs):
        a, ci = head_fit(H0, c0, Z['head']) if i else (0, c0)
        out.append(tpl.rotate(a, resample=Image.BICUBIC, center=c0, translate=(ci[0] - c0[0], ci[1] - c0[1]))); tilts.append(a)
    print('  head tilt per frame:', tilts)
    return out


def own_colours(slot, rule, frames, scores, thr=30, weak=0.6):
    """Capes and weapons keep ChatGPT's frame-by-frame drawing (they swing). Where ChatGPT drew a frame's body in a
    different pose (the frames that line up badly), the cut can carry a ghost of that body along; on those frames only
    the piece's OWN colours (learned from its well-fitting frames) stay, so the ghost (skin, shorts) goes."""
    if all(sc >= weak for sc in scores): return [(e, m) for e, m, _, _ in frames]
    pix = []
    for (ewin, m, bwin, Z), sc in zip(frames, scores):
        if sc < weak: continue
        ep, mp = ewin.load(), m.load()
        pix += [ep[x, y][:3] for y in range(0, m.height, 2) for x in range(0, m.width, 2) if mp[x, y]]
    if len(pix) < 40: return [(e, m) for e, m, _, _ in frames]
    sample = Image.new('RGB', (len(pix), 1)); sample.putdata(pix)
    pal = sample.quantize(colors=48, method=Image.Quantize.MEDIANCUT).convert('RGB')
    cols = sorted(set(pal.getdata())); labs = list(lab(Image.new('RGB', (len(cols), 1))).getdata()) if False else None
    lp = Image.new('RGB', (len(cols), 1)); lp.putdata(cols); labs = list(lab(lp).getdata())
    out = []
    for (ewin, m, bwin, Z), sc in zip(frames, scores):
        if sc >= weak: out.append((ewin, m)); continue
        el = lab(ewin).load(); mp = m.load(); keep = Image.new('L', m.size, 0); kp = keep.load()
        for y in range(m.height):
            for x in range(m.width):
                if not mp[x, y]: continue
                L, a, b = el[x, y]
                if min(abs(L - c[0]) + abs(a - c[1]) + abs(b - c[2]) for c in labs) <= thr: kp[x, y] = 255
        keep = keep.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))
        if Z and rule: keep = touching(keep, union([Z[z] for z in rule['home']], keep.size), reach=rule.get('reach', 15), floor=12)
        out.append((ewin, keep))
    return out


def fill_gaps(cells, sex, floor=6):
    """A weapon or cape that ChatGPT left out of a frame (hidden behind the body, or just missing) would blink out of the
    hand: the empty frame borrows the nearest frame of the same animation, moved along with the hands."""
    def hand(i):
        Z = zones_of(sex, i)
        if not Z: return None
        hm = union([Z['hands'], Z['arms']], Z['hands'].size) if not Z['hands'].getbbox() else Z['hands']
        st = ImageStat.Stat(hm); tot = st.sum[0] / 255
        if not tot: return None
        xs = sum(x for y in range(hm.height) for x in range(hm.width) if hm.getpixel((x, y))) / tot
        ys = sum(y for y in range(hm.height) for x in range(hm.width) if hm.getpixel((x, y))) / tot
        k = CW / hm.width
        return xs * k, ys * k
    count = lambda c: sum(1 for a in c.getchannel('A').getdata() if a)
    i0, filled = 0, []
    for row, n in ROWS:
        for i in range(i0, i0 + n):
            if row == 'death' or count(cells[i]) >= floor: continue
            src = sorted((j for j in range(i0, i0 + n) if count(cells[j]) >= floor), key=lambda j: abs(j - i))
            if not src: continue
            j = src[0]; hi, hj = hand(i), hand(j)
            dx, dy = (round(hi[0] - hj[0]), round(hi[1] - hj[1])) if hi and hj else (0, 0)
            moved = Image.new('RGBA', cells[j].size); moved.paste(cells[j], (dx, dy)); cells[i] = moved; filled.append((i, j))
        i0 += n
    if filled: print('  filled empty frames from neighbours:', filled)


def snap_palette(cells, n=24):
    """Every frame's pixels mapped to ONE palette (the piece's commonest colours over the whole sheet)."""
    strip = Image.new('RGB', (sum(c.width for c in cells), cells[0].height)); x = 0; mask = Image.new('L', strip.size, 0)
    for c in cells: strip.paste(c.convert('RGB'), (x, 0)); mask.paste(c.getchannel('A'), (x, 0)); x += c.width
    pix = [p for p, a in zip(strip.getdata(), mask.getdata()) if a]
    if len(pix) < n: return
    sample = Image.new('RGB', (len(pix), 1)); sample.putdata(pix)
    pal = sample.quantize(colors=n, method=Image.Quantize.MEDIANCUT)
    for c in cells:
        q = c.convert('RGB').quantize(palette=pal, dither=Image.Dither.NONE).convert('RGB'); a = c.getchannel('A')
        c.paste(q); c.putalpha(a)


def do_piece(sex, name, grey=False, allow_skin=True, thresh=30):
    meta = json.load(open(os.path.join(RAW, f'base_{sex}.meta.json')))
    bfr, bim = frames_of(os.path.join(RAW, f'base_{sex}.png'))
    wings = name in WINGS
    efr, eim = frames_of(os.path.join(RAW, f'{name}_{sex}.png'), WING_COUNTS if wings else None)
    n = len(bfr); rows = (n + COLS - 1) // COLS
    sheet = Image.new('RGBA', (COLS * CW, rows * CH)); report = []; cells = []; raws = []
    slot = name.split('_')[0]; rule = SLOT_RULES.get(slot)
    # 1) line every frame up with the body (by the skin, which mostly stays put)
    fits = []
    if wings: efr, k0 = wing_anchors(bfr, efr, eim)
    for i in range(n):
        bbox, bspr, _ = bfr[i]; ebox, espr, eanc = efr[i]
        if wings: fits.append(align(body_skin(espr), ebox, eanc, meta, i, skin_mask(place(bspr, bbox, meta, i)), ks=tuple(k0 * f for f in (0.94, 0.97, 1.0, 1.03, 1.06)))); continue
        fits.append(align(skin_mask(espr), ebox, eanc, meta, i, skin_mask(place(bspr, bbox, meta, i))))
    # 2) one scale per row (ChatGPT draws a row at one size): frame by frame, the piece would grow and shrink as it animates
    i0 = 0
    for _, cnt in ROWS:
        ks = sorted(f[1] for f in fits[i0:i0 + cnt]); km = ks[len(ks) // 2]
        for i in range(i0, i0 + cnt):
            if abs(fits[i][1] - km) > 0.005:
                bbox, bspr, _ = bfr[i]; ebox, espr, eanc = efr[i]
                fits[i] = align(body_skin(espr) if wings else skin_mask(espr), ebox, eanc, meta, i, skin_mask(place(bspr, bbox, meta, i)), ks=(km,))
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
        raws.append((ewin, new, bwin, Z)); report.append(round(sc, 2))
    # 4) one design in every frame (see make_worn / make_rigid)
    if slot in RIGID and all(r[3] for r in raws): pieces = make_rigid([(r[0], r[1]) for r in raws], [r[3] for r in raws])
    elif slot in WORN and all(r[3] for r in raws): pieces = make_worn(slot, raws)
    else:
        pairs = wing_colours(rule, raws) if wings else own_colours(slot, rule, raws, report) if slot in ('cape', 'wep') else [(r[0], r[1]) for r in raws]
        pieces = []
        for ewin, new in pairs: pc = ewin.copy(); pc.putalpha(new); pieces.append(pc)
    cells = [shrink(pc, (CW, CH), cut=56) for pc in pieces]   # (a lower cut than the body's: thin hair and straps survive the shrink)
    if wings: wing_specks(cells, [shrink(r[2], (CW, CH)) for r in raws])
    if slot in ('wep', 'cape'): fill_gaps(cells, sex)
    if not grey: snap_palette(cells)
    steady_idle(cells[:4])
    for j in range(1, 4): cells[j] = cells[0].copy()   # (the body stands exactly still in the idle loop: so does every piece, drawing and all)
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


# ---------- wings (worn in the cape slot) ----------
# Wings reach much further out than a cape, and on the body sheet the frames stand too close together for them (ChatGPT
# would draw one frame's wing into its neighbour). So wings are drawn on a ROOMIER copy of the body sheet
# (`wingbase <sex>` -> assets_raw/doll/base_wings_<sex>.png: the same 34 frames in the same order, on a 2:3 canvas, the
# 4-frame rows spread wide and the run row split into two rows of 3), and `piece` reads a wings raw with that layout.
WINGS = ('cape_wingdemon', 'cape_wingangel', 'cape_wingdragon', 'cape_wingfairy')
WING_COUNTS = [4, 3, 3, 4, 4, 4, 4, 4, 4]   # (rows of the roomy sheet: idle, run 1-3, run 4-6, jump, death, sword, bow, dagger, whip)
WING_SHEET = (1206, 1808)                   # (ChatGPT returns 1024x1536: the figures come back at about 0.85 of the base's size)


def wing_keyed(im, rim=2):
    """The magenta gone, like bglayers.keyed, but the key colour is only taken back out of pixels right at the cut
    (within `rim` px of it). keyed does that everywhere, which turns a wing's own purplish reds (a demon's membrane)
    into pale half-clear specks."""
    from bglayers import is_key
    im = im.convert('RGBA'); px = im.load(); W, H = im.size; mask = Image.new('L', im.size, 255); mp = mask.load()
    for y in range(H):
        for x in range(W):
            r, g, b, a = px[x, y]
            if a < 10 or is_key(r, g, b, False): mp[x, y] = 0
    inner = mask.filter(ImageFilter.MinFilter(2 * rim + 1)).load()
    for y in range(H):
        for x in range(W):
            if not mp[x, y] or inner[x, y]: continue
            r, g, b, a = px[x, y]; sp = max(0, min(r, b) - g)
            if sp <= 12: continue
            k = min(0.95, sp / 255)
            if k > 0.35: mp[x, y] = 0; continue   # (mostly key: it goes, rather than staying as a pale speck)
            px[x, y] = tuple(max(0, min(255, round(c))) for c in ((r - 255 * k) / (1 - k), g / (1 - k), (b - 255 * k) / (1 - k))) + (255,)
            mp[x, y] = round(mp[x, y] * (1 - k))
    im.putalpha(mask)
    return im


def body_skin(im):
    """The body's skin in a wings frame: skin colours, but not the strong reds a wing may have (a demon's veins)."""
    m = Image.new('L', im.size, 0); mp = m.load(); px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            if a >= 128 and is_skin(r, g, b) and 2 * g > r: mp[x, y] = 255
    return m


def median_xy(m):
    w, h = m.size; px = m.load()
    xs = sorted(x for y in range(h) for x in range(w) if px[x, y]); ys = sorted(y for y in range(h) for x in range(w) if px[x, y])
    return (xs[len(xs) // 2], ys[len(ys) // 2]) if xs else None


def wing_anchors(bfr, efr, eim):
    """A wings frame's box is the body plus its wings, so its feet anchor (worked out from the box) isn't the body's.
    Here each frame gets the anchor that puts the middle of its skin on the middle of the base frame's skin; the usual
    search (align) then refines it. Returns the frames with those anchors, and the sheet's scale next to the base's."""
    k0 = eim.width / WING_SHEET[0]; out = []
    for (bbox, bspr, banc), (ebox, espr, eanc) in zip(bfr, efr):
        cb, ce = median_xy(skin_mask(bspr)), median_xy(body_skin(espr))
        if cb and ce: eanc = (ebox[0] + ce[0] - k0 * (bbox[0] + cb[0] - banc[0]), ebox[1] + ce[1] - k0 * (bbox[1] + cb[1] - banc[1]))
        out.append((ebox, espr, eanc))
    return out, k0


def wing_colours(rule, frames, far=21, thr=34):
    """Wings keep ChatGPT's frame-by-frame drawing (they beat), but in EVERY frame only in the wings' own colours: the
    colours of what was cut well clear of the body (that can only be wing), so no re-drawn bit of body (skin, shirt,
    shorts) comes along at the body's edge. Then thin leftovers go and only what still hangs on the body stays."""
    pix = []
    for ewin, m, bwin, Z in frames:
        clear = ImageChops.subtract(m, alpha_of(bwin).filter(ImageFilter.MaxFilter(far))); ep, cp = ewin.load(), clear.load()
        pix += [ep[x, y][:3] for y in range(0, m.height, 2) for x in range(0, m.width, 2) if cp[x, y]]
    if len(pix) < 200: print('  wings: too little clear of the body to learn the colours from'); return [(e, m) for e, m, _, _ in frames]
    sample = Image.new('RGB', (len(pix), 1)); sample.putdata(pix)
    cols = sorted(set(sample.quantize(colors=40, method=Image.Quantize.MEDIANCUT).convert('RGB').getdata()))
    lp = Image.new('RGB', (len(cols), 1)); lp.putdata(cols); labs = list(lab(lp).getdata()); out = []; cache = {}
    for ewin, m, bwin, Z in frames:
        el = lab(ewin).load(); mp = m.load(); skin = body_skin(ewin).load(); keep = Image.new('L', m.size, 0); kp = keep.load()
        for y in range(m.height):
            for x in range(m.width):
                if not mp[x, y] or skin[x, y]: continue
                c = el[x, y]; ok = cache.get(c)
                if ok is None: ok = cache[c] = min(abs(c[0] - q[0]) + abs(c[1] - q[1]) + abs(c[2] - q[2]) for q in labs) <= thr
                if ok: kp[x, y] = 255
        keep = keep.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))
        if Z and rule: keep = touching(keep, union([Z[z] for z in rule['home']], keep.size), reach=rule.get('reach', 15), floor=40)
        out.append((ewin, keep))
    return out


def wing_specks(cells, bodies, floor=8):
    """The game draws the wings behind the body, so what counts is what shows around it. Here every loose bit that
    shows (not joined to the biggest showing part) and is under `floor` px goes: a pixel or two of re-drawn body outline
    in a wing's dark colour, left at the body's edge, would blink as the animation plays."""
    gone = 0
    for cell, body in zip(cells, bodies):
        w, h = cell.size; cp, bp = cell.load(), body.load(); seen = set(); comps = []
        for y in range(h):
            for x in range(w):
                if cp[x, y][3] and not bp[x, y][3] and (x, y) not in seen:
                    st = [(x, y)]; seen.add((x, y)); pts = []
                    while st:
                        cx, cy = st.pop(); pts.append((cx, cy))
                        for q in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1), (cx + 1, cy + 1), (cx - 1, cy - 1), (cx + 1, cy - 1), (cx - 1, cy + 1)):
                            if 0 <= q[0] < w and 0 <= q[1] < h and cp[q][3] and not bp[q][3] and q not in seen: seen.add(q); st.append(q)
                    comps.append(pts)
        comps.sort(key=len, reverse=True)
        for c in comps[1:]:
            if len(c) < floor:
                gone += len(c)
                for q in c: cp[q] = (0, 0, 0, 0)
    if gone: print('  wings: dropped', gone, 'px of loose specks at the edge of the body')


def do_wingbase(sex):
    fr, _ = frames_of(os.path.join(RAW, f'base_{sex}.png'))
    W, H = WING_SHEET; rh = H / len(WING_COUNTS); out = Image.new('RGBA', (W, H), (255, 0, 255, 255)); i = 0
    for r, n in enumerate(WING_COUNTS):
        for c in range(n):
            box, spr, anc = fr[i]; i += 1
            wide = spr.width > 150   # (lying flat: in the middle of its cell; everyone else stands a little forward, the room is behind the back)
            fx = (c + 0.5) * W / n + (0 if wide else 24); fy = (r + 1) * rh - 26
            out.alpha_composite(spr, (round(fx - (anc[0] - box[0])), round(fy - (anc[1] - box[1]))))
    p = os.path.join(RAW, f'base_wings_{sex}.png'); out.convert('RGB').save(p); print('wingbase ->', p)


if __name__ == '__main__':
    cmd, sex = sys.argv[1], sys.argv[2]
    if cmd == 'wingbase': do_wingbase(sex); sys.exit()
    if cmd == 'base': do_base(sex)
    elif cmd == 'piece': do_piece(sex, sys.argv[3], grey=sys.argv[3].startswith('hair'))
    elif cmd == 'seg': do_seg(sex)
    elif cmd == 'check': do_check(sex, sys.argv[3:])
