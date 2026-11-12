"""Hero looks (Wardrobe): skin masks, head positions and hairstyle pieces.

    python -P tools/looks.py          # every hero sheet + the hair pieces -> assets/anim/*_skin.png, hair_*.png, looks.js

Every hero sheet gets a skin mask (assets/anim/<sheet>_skin.png): the skin pixels in grey shades, which the game tints
with the chosen skin tone. The outfit sheets were drawn bald with magenta key skin (so the mask is exact); this tool
also paints that magenta over with a natural default tone, so the sheet looks right even before it is tinted.
For those bald sheets it also records where the head is in every frame (looks.js), so the hairstyle pieces
(assets_raw/hair_sheet.png: 12 hairstyles on a magenta head, in grey) can be placed on it.
"""
import os, json, sys, colorsys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RAW, OUT = os.path.join(ROOT, 'assets_raw'), os.path.join(ROOT, 'assets', 'anim')
sys.path.insert(0, HERE)
from animate import SPECS, OUTFITS  # noqa: E402

CLASSES = ['warrior', 'archer', 'rogue', 'beastmaster']
CLASSIC = [c + sx for c in CLASSES for sx in ('', '_f')] + ['warrior_block', 'warrior_f_block', 'archer_arcane', 'archer_f_arcane']
KEYED = [n for n in SPECS if any(n.startswith(c) and n.split('_')[-1] in OUTFITS[c] for c in CLASSES)]
HAIRS = ['crop', 'long', 'bob', 'ponytail', 'bun', 'braids', 'mohawk', 'spiky', 'undercut', 'curly', 'afro', 'locs']
HEAD_ROWS = 8   # a hero is 28 px tall: the head is in the top 8 rows (classic outfits)
DEFAULT_SKIN = [(242, 200, 168), (214, 164, 128), (170, 118, 86), (110, 70, 50)]   # light -> dark, the stand-in before tinting


def is_key(p):   # magenta key skin (any shade)
    r, g, b, a = p
    if a < 128: return False
    h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    return s > 0.16 and v > 0.25 and 0.76 < h < 0.93 and r > g * 1.12 and b > g * 1.08   # magenta to pale pink (rogue sheets are brightened); never reds


def is_skin(p):   # natural skin on the classic sheets (faces, a few hands)
    r, g, b, a = p
    if a < 128: return False
    h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    return 0.02 <= h <= 0.11 and 0.22 <= s <= 0.62 and v >= 0.58 and r > g > b


def lum(p): return 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]


def frames_of(name):
    with open(os.path.join(OUT, name + '.json')) as fh:
        return json.load(fh)['anims']


def make_mask(name, keyed):
    path = os.path.join(OUT, name + '.png'); mpath = os.path.join(OUT, name + '_skin.png')
    if not os.path.exists(path): return None
    im = Image.open(path).convert('RGBA'); px = im.load(); W, H = im.size
    test = is_key if keyed else is_skin
    if keyed: cells = [(x, y) for y in range(H) for x in range(W) if test(px[x, y])]
    else:   # classic outfits: leather and fur share skin colours, so only look at the face, in the head area of each frame
        cells = []
        for anim, frs in frames_of(name).items():
            for i, (fx, fy, fw, fh, ax, ay) in enumerate(frs):
                if anim == 'death' and i >= 1: continue   # lying down: no head area to speak of
                top = next((y for y in range(fh) if any(px[fx + x, fy + y][3] > 128 for x in range(fw))), 0)
                row = [x for y in range(top, min(fh, top + HEAD_ROWS)) for x in range(fw) if px[fx + x, fy + y][3] > 128]
                if not row: continue
                mid = (min(row) + max(row)) / 2   # faces look right: the face is the front half of the head
                cells += [(fx + x, fy + y) for y in range(top + 2, min(fh, top + HEAD_ROWS)) for x in range(int(mid), fw) if test(px[fx + x, fy + y])]
    if keyed and not cells and os.path.exists(mpath): return Image.open(mpath)   # already painted over: keep its mask
    mask = Image.new('RGBA', (W, H), (0, 0, 0, 0)); mp = mask.load()
    if cells:
        ls = [lum(px[c]) for c in cells]; lo, hi = min(ls), max(ls)
        for (x, y), l in zip(cells, ls):
            t = (l - lo) / (hi - lo) if hi > lo else 1
            g = round(150 + 105 * t)   # 150..255: tinting keeps the shading, never goes muddy
            mp[x, y] = (g, g, g, 255)
            if keyed: px[x, y] = DEFAULT_SKIN[min(3, int((1 - t) * 3.999))] + (255,)
        if keyed: im.save(path)
    mask.save(mpath)
    return mask


def heads(name, mask):
    """The head in every frame: the top-most blob of skin. [x, y, w, h] inside the frame, or None."""
    mp = mask.load(); out = {}
    for anim, frs in frames_of(name).items():
        out[anim] = []
        for fx, fy, fw, fh, ax, ay in frs:
            pts = {(x, y) for y in range(fh) for x in range(fw) if mp[fx + x, fy + y][3] > 0}
            if not pts: out[anim].append(None); continue
            blobs, left = [], set(pts)
            while left:   # every separate patch of skin (the head, and bare hands on some outfits)
                b, todo = set(), [next(iter(left))]
                while todo:
                    p = todo.pop()
                    if p in b or p not in left: continue
                    b.add(p); x, y = p; todo += [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1), (x + 1, y + 1), (x - 1, y - 1), (x + 1, y - 1), (x - 1, y + 1)]
                left -= b; blobs.append(b)
            top = min(min(p[1] for p in b) for b in blobs)
            # the head: the biggest patch near the top (a raised hand can be higher, but it is smaller)
            blob = max([b for b in blobs if min(p[1] for p in b) <= top + 4], key=len)
            xs, ys = [p[0] for p in blob], [p[1] for p in blob]
            out[anim].append([min(xs), min(ys), max(xs) - min(xs) + 1, max(ys) - min(ys) + 1])
    # keep every upright frame's head near this outfit's usual head width (a raised arm can merge into the head blob);
    # the face looks right, so keep the right edge and the top
    ws = sorted(h[2] for h in out.get('idle', []) if h)
    if ws:
        med = ws[len(ws) // 2]
        for anim, fr in out.items():
            for i, h in enumerate(fr):
                if not h or (anim == 'death' and i >= 2): continue
                if abs(h[2] - med) > 1: fr[i] = [h[0] + h[2] - med, h[1], med, min(h[3], med + 3)]
    return out


def hair_pieces(widths):
    """Cut the 12 hairstyles into pieces for every head width the outfits use. Each piece is the style's hair PLUS a solid
    cap over the scalp (top and back of the head), so only the face shows skin; the face lines of the practice head are dropped."""
    src = os.path.join(RAW, 'hair_sheet.png')
    if not os.path.exists(src): print('no hair sheet yet'); return {}
    from PIL import ImageFilter
    im = Image.open(src).convert('RGBA'); W, H = im.size
    a = im.getchannel('A').point(lambda v: 255 if v > 60 else 0)
    def spans(profile, n):   # columns / rows of tiles from the empty gaps between them
        runs, cur = [], None
        for i, v in enumerate(profile):
            if v and cur is None: cur = i
            if not v and cur is not None: runs.append([cur, i]); cur = None
        if cur is not None: runs.append([cur, len(profile)])
        while len(runs) > n:   # merge the closest neighbours (a tile split by a thin gap)
            k = min(range(len(runs) - 1), key=lambda j: runs[j + 1][0] - runs[j][1]); runs[k][1] = runs[k + 1][1]; del runs[k + 1]
        return runs
    colp = [any(a.getpixel((x, y)) for y in range(0, H, 2)) for x in range(W)]
    rowp = [any(a.getpixel((x, y)) for x in range(0, W, 2)) for y in range(H)]
    cols, rows = spans(colp, 4), spans(rowp, 3)
    for f in os.listdir(OUT):
        if f.startswith('hair_') and f.endswith('.png'): os.remove(os.path.join(OUT, f))
    meta = {}
    for i, hid in enumerate(HAIRS):
        (x0, x1), (y0, y1) = cols[i % 4], rows[i // 4]
        tile = im.crop((x0, y0, x1, y1)); tp = tile.load()
        keys = [(x, y) for y in range(tile.height) for x in range(tile.width) if is_key(tp[x, y])]
        kx0, kx1 = min(k[0] for k in keys), max(k[0] for k in keys)
        ky0, ky1 = min(k[1] for k in keys), max(k[1] for k in keys)
        kw, kh = kx1 - kx0 + 1, ky1 - ky0 + 1
        keymask = Image.new('L', tile.size, 0); kmp = keymask.load()
        for k in keys: kmp[k] = 255
        # the head's whole area (the key plus the face lines inside it)
        filled = keymask.filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.MinFilter(9)).load()
        near = keymask.filter(ImageFilter.MaxFilter(2 * max(3, round(kw * 0.05)) + 1)).load()
        def cap(x, y):   # the scalp the style covers (heads face right: the back is on the left)
            fx, fy = (x - kx0) / kw, (y - ky0) / kh
            if hid == 'mohawk': return fy < 0.24 and 0.22 < fx < 0.78
            if hid == 'undercut': return fy < 0.30 or (fx < 0.30 and fy < 0.42)
            return fy < 0.40 or (fx < 0.45 and fy < 0.74)
        hair_l = sorted(lum(tp[x, y]) for y in range(tile.height) for x in range(tile.width) if tp[x, y][3] >= 120 and not near[x, y])
        mid = hair_l[len(hair_l) // 2] if hair_l else 128
        clean = Image.new('RGBA', tile.size, (0, 0, 0, 0)); cp = clean.load()
        for y in range(tile.height):
            for x in range(tile.width):
                r, g, b, al = tp[x, y]
                inhead = kmp[x, y] or filled[x, y]
                if inhead and cap(x, y): cp[x, y] = (round(mid),) * 3 + (255,); continue      # solid hair over the scalp
                if al < 120 or inhead or (near[x, y] and lum((r, g, b)) < 95): continue        # the face, and its lines
                cp[x, y] = (r, g, b, 255)
        meta[hid] = {}
        for hw in widths:
            s = hw / kw
            sw, sh = max(1, round(tile.width * s)), max(1, round(tile.height * s))
            small = clean.resize((sw, sh), Image.BOX); sp = small.load()
            out = Image.new('RGBA', (sw, sh), (0, 0, 0, 0)); op = out.load()
            vals = [lum(sp[x, y]) for y in range(sh) for x in range(sw) if sp[x, y][3] >= 100]
            lo, hi = (min(vals), max(vals)) if vals else (0, 255)
            for y in range(sh):
                for x in range(sw):
                    r, g, b, al = sp[x, y]
                    if al < 100: continue
                    l = round(70 + 185 * (lum((r, g, b)) - lo) / max(1, hi - lo))   # grey ramp the game tints with the hair colour
                    op[x, y] = (l, l, l, 255)
            bb = out.getbbox()
            if not bb: continue
            out = out.crop(bb)
            out.save(os.path.join(OUT, f'hair_{hid}_{hw}.png'))
            meta[hid][hw] = {'w': out.width, 'h': out.height, 'hx': round(kx0 * s) - bb[0], 'hy': round(ky0 * s) - bb[1]}
        print('hair', hid, 'sizes', sorted(meta[hid]))
    return meta


def main():
    L = {'masks': [], 'heads': {}, 'hair': {}}
    widths = []
    for n in CLASSIC:
        if make_mask(n, False) is not None: L['masks'].append(n)
    for n in KEYED:
        m = make_mask(n, True)
        if m is None: continue
        L['masks'].append(n); L['heads'][n] = heads(n, m)
        widths += [h[2] for h in L['heads'][n].get('idle', []) if h]
        print(n, 'heads', {k: [h for h in v][:2] for k, v in L['heads'][n].items() if k == 'idle'})
    allw = sorted({h[2] for n in L['heads'] for fr in L['heads'][n].values() for h in fr if h})
    if allw: L['hair'] = hair_pieces(allw)
    with open(os.path.join(OUT, 'looks.js'), 'w') as fh:
        fh.write('// generated by tools/looks.py: skin masks, head boxes [x, y, w, h] per frame, hairstyle pieces\n')
        fh.write('window.LOOKS = ' + json.dumps(L, separators=(',', ':')) + ';\n')
    print('masks:', len(L['masks']), 'keyed:', len(L['heads']), 'hair:', len(L['hair']))


if __name__ == '__main__':
    main()
