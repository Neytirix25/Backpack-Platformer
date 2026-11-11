"""Slice ChatGPT animation sheets into clean, consistent pixel-art animation frames for Backpack Sanctuary.

    python -P tools/animate.py <name>      # assets_raw/anim_<name>.png -> assets/anim/<name>.png (+ rebuild anims.js)
    python -P tools/animate.py all         # every sheet listed in SPECS that exists
    python -P tools/animate.py preview <name>   # zoomed check strip in assets_raw/anim_<name>_check.png

Each frame is cut out by connected components, rows are found from the layout, every frame of a
character shares ONE scale and ONE palette (no size pops or colour flicker between frames), and each
frame gets an anchor point (feet for walkers, body centre for flyers) so frames line up without jitter.
"""
import sys, os, json
from PIL import Image, ImageDraw
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pixelate as PXL

ROOT = PXL.ROOT; RAW = PXL.RAW; OUT = os.path.join(PXL.OUT, 'anim')

# rows: (animation name, frames) top to bottom.  height = idle height in art pixels (drawn at 2x in game)
SPECS = {
    'warrior':  dict(rows=[('idle', 4), ('run', 6), ('attack', 4), ('jump', 4), ('death', 4)], height=28),
    'archer':   dict(rows=[('idle', 4), ('run', 6), ('attack', 4), ('jump', 4), ('death', 4)], height=28),
    'rogue':    dict(rows=[('idle', 4), ('run', 6), ('attack', 4), ('jump', 4), ('death', 4)], height=27, bright=1.45),
    'beastmaster': dict(rows=[('idle', 4), ('run', 6), ('attack', 4), ('jump', 4), ('death', 4)], height=28),
    # female heroes (skin choice in the hub)
    'warrior_f':  dict(rows=[('idle', 4), ('run', 6), ('attack', 4), ('jump', 4), ('death', 4)], height=28),
    'archer_f':   dict(rows=[('idle', 4), ('run', 6), ('attack', 4), ('jump', 4), ('death', 4)], height=28),
    'rogue_f':    dict(rows=[('idle', 4), ('run', 6), ('attack', 4), ('jump', 4), ('death', 4)], height=27, bright=1.45),
    'beastmaster_f': dict(rows=[('idle', 4), ('run', 6), ('attack', 4), ('jump', 4), ('death', 4)], height=28),
    'warrior_f_block': dict(rows=[('idle', 4), ('block', 4)], height=28),
    'archer_f_arcane': dict(rows=[('idle', 4), ('arcane', 4)], height=28),
    'slime':    dict(rows=[('idle', 4), ('hop', 4), ('death', 4)], height=12),
    'bat':      dict(rows=[('fly', 6), ('attack', 4), ('death', 4)], height=15, ref='fly', fly=True),
    'skeleton': dict(rows=[('idle', 4), ('walk', 6), ('attack', 4), ('jump', 3), ('death', 4)], height=26),
    'goblin':   dict(rows=[('idle', 4), ('walk', 6), ('attack', 4), ('death', 4)], height=21),
    'ghost':    dict(rows=[('fly', 6), ('attack', 4), ('death', 4)], height=23, ref='fly', fly=True),
    'brute':    dict(rows=[('idle', 4), ('walk', 6), ('attack', 4), ('death', 4)], height=34),
    'warden':   dict(rows=[('idle', 4), ('walk', 6), ('attack', 4), ('leap', 4), ('death', 4)], height=52),
    # ----- Act II -----
    'imp':      dict(rows=[('fly', 6), ('attack', 4), ('death', 4)], height=17, ref='fly', fly=True),
    'golem':    dict(rows=[('idle', 4), ('walk', 6), ('attack', 4), ('death', 4)], height=34),
    'cultist':  dict(rows=[('idle', 4), ('walk', 6), ('attack', 4), ('death', 4)], height=25),
    'spider':   dict(rows=[('idle', 4), ('walk', 6), ('attack', 4), ('death', 4)], height=14),
    'knight':   dict(rows=[('idle', 4), ('walk', 6), ('attack', 4), ('death', 4)], height=28),
    # ----- class abilities (idle row is only there to keep the scale identical to the hero sheets) -----
    'warrior_block': dict(rows=[('idle', 4), ('block', 4)], height=28),
    'archer_arcane': dict(rows=[('idle', 4), ('arcane', 4)], height=28),
    'spiritwolf':    dict(rows=[('run', 6), ('attack', 4)], height=16, ref='run'),
    # ----- pets -----
    'pet_dog':       dict(rows=[('idle', 4), ('run', 6), ('attack', 4), ('ko', 4)], height=17),
    'pet_catgray':   dict(rows=[('idle', 4), ('run', 6), ('attack', 4), ('ko', 4)], height=12),
    'pet_catcalico': dict(rows=[('idle', 4), ('run', 6), ('attack', 4), ('ko', 4)], height=12),
    'pet_cockatiel': dict(rows=[('fly', 6), ('attack', 4), ('ko', 4)], height=14, ref='fly', fly=True),
    'pet_dragon':    dict(rows=[('fly', 6), ('attack', 4), ('ko', 4)], height=19, ref='fly', fly=True),
    'shadowwolf':    dict(rows=[('idle', 4), ('run', 6), ('attack', 4), ('ko', 4)], height=19),        # boss + its pup and shades
    'elderdragon':   dict(rows=[('fly', 6), ('attack', 4), ('ko', 4)], height=22, ref='fly', fly=True),   # floor 20 boss + Elder Drake pet
    'unicorn':       dict(rows=[('idle', 4), ('run', 6), ('attack', 4), ('ko', 4)], height=20),        # first-turn-victory achievement pet
    'pet_fox':       dict(rows=[('idle', 4), ('run', 6), ('attack', 4), ('ko', 4)], height=14),
    'pet_owl':       dict(rows=[('fly', 6), ('attack', 4), ('ko', 4)], height=15, ref='fly', fly=True),
    'pet_ferret':    dict(rows=[('idle', 4), ('run', 6), ('attack', 4), ('ko', 4)], height=9, ref='run'),   # idle stands up tall: size from the run
    'pet_boar':      dict(rows=[('idle', 4), ('run', 6), ('attack', 4), ('ko', 4)], height=17, row_scale={'run': 1.35}),
    'pet_toad':      dict(rows=[('idle', 4), ('run', 6), ('attack', 4), ('ko', 4)], height=12, row_scale={'run': 1.3}),
    # ----- mythical fire beasts (Act II): one sheet each, with the resting pose as the last row -----
    'pet_phoenix':    dict(rows=[('fly', 6), ('attack', 4), ('ko', 4), ('rest', 4)], height=16, ref='fly', fly=True),
    'pet_hellhound':  dict(rows=[('idle', 4), ('run', 6), ('attack', 4), ('ko', 4), ('rest', 4)], height=18),
    'pet_salamander': dict(rows=[('idle', 4), ('run', 6), ('attack', 4), ('ko', 4), ('rest', 4)], height=10),
    'pet_tortoise':   dict(rows=[('idle', 4), ('run', 6), ('attack', 4), ('ko', 4), ('rest', 4)], height=14),
    'pet_qilin':      dict(rows=[('idle', 4), ('run', 6), ('attack', 4), ('ko', 4), ('rest', 4)], height=20),
    'pet_chimera':    dict(rows=[('idle', 4), ('run', 6), ('attack', 4), ('ko', 4), ('rest', 4)], height=19),
    'pet_lion':       dict(rows=[('idle', 4), ('run', 6), ('attack', 4), ('ko', 4), ('rest', 4)], height=18),
    'pet_moth':       dict(rows=[('fly', 6), ('attack', 4), ('ko', 4), ('rest', 4)], height=13, ref='fly', fly=True),
}

# resting / idle-behaviour sheets: the first row repeats the normal idle (or flight) pose only to lock the scale
for _pet in [k for k in list(SPECS) if k.startswith('pet_') and not any(r[0] == 'rest' for r in SPECS[k]['rows'])]:
    _b = SPECS[_pet]; _first = _b['rows'][0]
    _h = _b['height']
    try:   # match the size of the already-processed idle (or flight) frames exactly
        import json as _json
        _m = _json.load(open(os.path.join(PXL.OUT, 'anim', _pet + '.json')))
        _fr = (_m.get(_first[0]) or _m.get('anims', {}).get(_first[0]))
        if _fr: _hs = sorted(f[3] for f in _fr); _h = _hs[len(_hs) // 2]
    except Exception: pass
    _h = {'pet_ferret': 15, 'pet_fox': 20, 'pet_catcalico': 20}.get(_pet, _h)   # the source drew these idle poses differently: tuned by eye
    SPECS[_pet + '_rest'] = dict(rows=[_first, ('rest', 4)], height=_h, ref=_first[0], fly=_b.get('fly', False))


def components(im):
    """(box, cutout image) for every sprite on the sheet, neighbours' pixels removed."""
    boxes, lab, owners = PXL.segment_cc(im, ds=2, grow=3, masks=True, row_tol=1)
    out = []
    for b, own in zip(boxes, owners):
        spr = im.crop(b).copy(); a = spr.getchannel('A'); ap = a.load()
        for y in range(spr.height):
            row = lab[min(len(lab) - 1, (b[1] + y) // 2)]
            for x in range(spr.width):
                if row[min(len(row) - 1, (b[0] + x) // 2)] not in own:
                    ap[x, y] = 0
        spr.putalpha(a)
        out.append([list(b), spr])
    return out


def merge(c1, c2):
    b1, i1 = c1; b2, i2 = c2
    b = [min(b1[0], b2[0]), min(b1[1], b2[1]), max(b1[2], b2[2]), max(b1[3], b2[3])]
    img = Image.new('RGBA', (b[2] - b[0], b[3] - b[1]), (0, 0, 0, 0))
    img.alpha_composite(i1, (b1[0] - b[0], b1[1] - b[1])); img.alpha_composite(i2, (b2[0] - b[0], b2[1] - b[1]))
    return [b, img]


def split(c):
    """Split a component that is really two touching frames at its emptiest middle column."""
    b, img = c; a = img.getchannel('A'); w, h = img.size; px = a.load()
    cols = [sum(1 for y in range(h) if px[x, y] > 40) for x in range(w)]
    lo, hi = int(w * 0.3), int(w * 0.7)
    x = min(range(lo, hi), key=lambda i: cols[i])
    left = img.crop((0, 0, x, h)); right = img.crop((x, 0, w, h))
    lb = left.getbbox(); rb = right.getbbox()
    return [[b[0] + lb[0], b[1] + lb[1], b[0] + lb[2], b[1] + lb[3]], left.crop(lb)], \
           [[b[0] + x + rb[0], b[1] + rb[1], b[0] + x + rb[2], b[1] + rb[3]], right.crop(rb)]


def row_bands(im, k):
    """Find k row bands from empty horizontal strips in the sheet (None if the layout doesn't split cleanly)."""
    a = im.getchannel('A').point(lambda v: 255 if v > 40 else 0)
    W, H = im.size
    filled = [1 if a.crop((0, y, W, y + 1)).getbbox() else 0 for y in range(H)]
    bands, s = [], None
    for y, f in enumerate(filled + [0]):
        if f and s is None: s = y
        if not f and s is not None: bands.append([s, y]); s = None
    while len(bands) > k:  # merge the pair of bands separated by the smallest gap (e.g. a stray spark)
        i = min(range(1, len(bands)), key=lambda i: bands[i][0] - bands[i - 1][1])
        bands[i - 1][1] = bands[i][1]; bands.pop(i)
    if len(bands) == k:
        return bands
    # rows touch (a raised weapon pokes into the gap): cut at the k-1 emptiest horizontal lines instead
    px = a.load()
    cnt = [sum(1 for x in range(0, W, 2) if px[x, y]) for y in range(H)]
    sm = [sum(cnt[max(0, y - 3):y + 4]) for y in range(H)]
    sep, cuts = H / (2 * k), []
    for y in sorted(range(int(H * 0.05), int(H * 0.95)), key=lambda y: sm[y]):
        if all(abs(y - c) > sep for c in cuts):
            cuts.append(y)
            if len(cuts) == k - 1: break
    cuts = sorted(cuts)
    return [[b0, b1] for b0, b1 in zip([0] + cuts, cuts + [H])] if len(cuts) == k - 1 else None


def rows_of(comps, counts, im=None):
    """Group components into len(counts) rows, then fix the frame count of each row."""
    k = len(counts)
    bands = row_bands(im, k) if im is not None else None
    if bands:  # assign by which band holds most of each component
        rows = [[] for _ in range(k)]
        # a piece straddling two rows is really two frames touching (e.g. a raised club): cut it at the row line
        cut_comps = []
        for c in comps:
            (x0, y0, x1, y1), img = c
            for b0, b1 in bands[:-1]:
                if y0 + (y1 - y0) * 0.2 < b1 < y1 - (y1 - y0) * 0.2:
                    top, bot = img.crop((0, 0, img.width, b1 - y0)), img.crop((0, b1 - y0, img.width, img.height))
                    tb, bb = top.getbbox(), bot.getbbox()
                    if tb and bb:
                        cut_comps.append([[x0 + tb[0], y0 + tb[1], x0 + tb[2], y0 + tb[3]], top.crop(tb)])
                        c = [[x0 + bb[0], b1 + bb[1], x0 + bb[2], b1 + bb[3]], bot.crop(bb)]
                        (x0, y0, x1, y1), img = c
            cut_comps.append(c)
        comps = cut_comps
        for c in comps:
            ov = [max(0, min(c[0][3], b1) - max(c[0][1], b0)) for b0, b1 in bands]
            rows[ov.index(max(ov))].append(c)
        rows = [sorted(r, key=lambda c: c[0][0]) for r in rows]
    else:      # fallback: split at the biggest vertical gaps between component centres
        comps = sorted(comps, key=lambda c: (c[0][1] + c[0][3]) / 2)
        cy = [(c[0][1] + c[0][3]) / 2 for c in comps]
        cuts = sorted(sorted(range(1, len(comps)), key=lambda i: cy[i] - cy[i - 1], reverse=True)[:k - 1])
        rows = []; s = 0
        for c in cuts + [len(comps)]:
            rows.append(sorted(comps[s:c], key=lambda c: c[0][0])); s = c
    fixed = []
    for row, n in zip(rows, counts):
        row = list(row)
        while len(row) > n:  # merge the smallest bit into its nearest neighbour
            i = min(range(len(row)), key=lambda j: row[j][1].width * row[j][1].height)
            small = row.pop(i)
            scx = (small[0][0] + small[0][2]) / 2
            j = min(range(len(row)), key=lambda j: abs((row[j][0][0] + row[j][0][2]) / 2 - scx))
            row[j] = merge(row[j], small)
        while len(row) < n:  # split the widest frame
            i = max(range(len(row)), key=lambda j: row[j][1].width)
            a, b = split(row.pop(i)); row[i:i] = [a, b]
        fixed.append(row)
    return fixed


def anchor(img, fly):
    a = img.getchannel('A'); w, h = img.size; px = a.load()
    if fly:
        pts = [(x, y) for y in range(h) for x in range(w) if px[x, y] > 0]
        return round(sum(p[0] for p in pts) / len(pts), 1), round(sum(p[1] for p in pts) / len(pts), 1)
    y0 = int(h * 0.65)  # feet / legs band
    xs = [x for y in range(y0, h) for x in range(w) if px[x, y] > 0] or [w / 2]
    return round(sum(xs) / len(xs), 1), h


# per-row size corrections so every pose of a pet reads as the same-sized animal (measured by on-screen area)
ROW_FIX = {"pet_dog": {"run": 1.274, "attack": 1.039, "ko": 1.073}, "pet_dog_rest": {"rest": 1.166}, "pet_catgray": {"run": 1.095, "ko": 0.903}, "pet_catcalico": {"ko": 1.009}, "pet_catcalico_rest": {"rest": 0.842}, "pet_dragon": {"ko": 0.953}, "pet_fox": {"run": 1.163, "ko": 0.921}, "pet_fox_rest": {"rest": 0.89}, "pet_owl": {"attack": 0.896, "ko": 0.885}, "pet_owl_rest": {"rest": 1.149}, "pet_ferret": {"run": 1.36, "attack": 1.063, "ko": 1.021}, "pet_ferret_rest": {"rest": 1.043}, "pet_boar": {"run": 1.066, "attack": 1.051, "ko": 1.106}, "pet_boar_rest": {"rest": 1.106}, "pet_toad": {"run": 1.208, "attack": 1.065, "ko": 1.063}, "pet_toad_rest": {"rest": 1.069}, "shadowwolf": {"run": 1.35}, "unicorn": {"run": 1.2}, "pet_hellhound": {"run": 1.484, "attack": 1.063, "ko": 1.143, "rest": 1.08}, "pet_salamander": {"run": 1.401, "attack": 1.063, "ko": 1.063, "rest": 1.081}, "pet_tortoise": {"run": 1.304, "ko": 1.114, "rest": 1.087}, "pet_qilin": {"run": 1.357, "ko": 1.07, "rest": 1.102}, "pet_chimera": {"run": 1.28, "ko": 1.046, "rest": 1.063}, "pet_lion": {"run": 1.469, "ko": 1.094, "rest": 1.115}, "pet_moth": {"rest": 0.964}}


def process(name):
    spec = SPECS[name]; fly = spec.get('fly', False); ref = spec.get('ref', 'idle')
    im = Image.open(os.path.join(RAW, f'anim_{name}.png')).convert('RGBA')
    comps = components(im)
    counts = [n for _, n in spec['rows']]
    print(name, 'found', len(comps), 'pieces, expected', sum(counts))
    rows = rows_of(comps, counts, im)
    names = [r for r, _ in spec['rows']]
    ref_frames = rows[names.index(ref)]
    hs = sorted(c[1].height for c in ref_frames)
    s = spec['height'] / hs[len(hs) // 2]
    # 1) shrink every frame by the same factor
    small = []
    for (aname, _), row in zip(spec['rows'], rows):
        rs = s * spec.get('row_scale', {}).get(aname, 1) * ROW_FIX.get(name, {}).get(aname, 1)   # fix rows the source drew at a different size
        small.append([c[1].resize((max(1, round(c[1].width * rs)), max(1, round(c[1].height * rs))), Image.BOX) for c in row])
    if spec.get('bright'):  # lift very dark characters so they read against the dungeon backgrounds
        from PIL import ImageEnhance
        def lift(f):
            a = f.getchannel('A'); rgb = ImageEnhance.Brightness(f.convert('RGB')).enhance(spec['bright'])
            rgb = ImageEnhance.Contrast(rgb).enhance(1.1); out = rgb.convert('RGBA'); out.putalpha(a); return out
        small = [[lift(f) for f in r] for r in small]
    # 2) one shared palette for the whole character
    allf = [f for r in small for f in r]
    strip = Image.new('RGB', (sum(f.width for f in allf), max(f.height for f in allf)), (255, 0, 255))
    x = 0
    for f in allf:
        bg = Image.new('RGB', f.size, (255, 0, 255)); bg.paste(f.convert('RGB'), (0, 0), f.getchannel('A').point(lambda v: 255 if v >= 110 else 0))
        strip.paste(bg, (x, 0)); x += f.width
    # octree keeps small-but-distinct hues (orc/goblin green skin) that median-cut merges into the browns
    from PIL import ImageEnhance
    strip = ImageEnhance.Color(strip).enhance(1.15)
    pal = strip.quantize(64, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
    # 3) clean frames, anchors, pack into one sheet
    frames_out = {}; packed = []
    for (aname, _), row in zip(spec['rows'], small):
        lst = []
        for f in row:
            al = f.getchannel('A').point(lambda v: 255 if v >= 110 else 0)
            q = ImageEnhance.Color(f.convert('RGB')).enhance(1.15).quantize(palette=pal, dither=Image.Dither.NONE).convert('RGBA'); q.putalpha(al)
            bb = q.getbbox()
            if bb: q = q.crop(bb)
            lst.append(q)
        frames_out[aname] = lst
    W = max(sum(f.width + 2 for f in lst) for lst in frames_out.values())
    H = sum(max(f.height for f in lst) + 2 for lst in frames_out.values())
    sheet = Image.new('RGBA', (W, H), (0, 0, 0, 0)); meta = {}; y = 0
    for aname, lst in frames_out.items():
        x = 0; rh = max(f.height for f in lst); meta[aname] = []
        for f in lst:
            sheet.paste(f, (x, y)); ax, ay = anchor(f, fly)
            meta[aname].append([x, y, f.width, f.height, ax, ay]); x += f.width + 2
        y += rh + 2
    os.makedirs(OUT, exist_ok=True)
    sheet.save(os.path.join(OUT, name + '.png'))
    with open(os.path.join(OUT, name + '.json'), 'w') as fh:
        json.dump({'fly': fly, 'anims': meta}, fh)
    print(name, 'sheet', sheet.size, {k: len(v) for k, v in meta.items()})
    return meta


def build_js():
    data = {}
    for n in SPECS:
        p = os.path.join(OUT, n + '.json')
        if os.path.exists(p):
            with open(p) as fh:
                data[n] = json.load(fh)
    with open(os.path.join(OUT, 'anims.js'), 'w') as fh:
        fh.write('// generated by tools/animate.py: frame = [x, y, w, h, anchorX, anchorY] in art pixels\n')
        fh.write('window.ANIMS = ' + json.dumps(data, separators=(',', ':')) + ';\n')
    print('anims.js:', ', '.join(data))


def preview(name):
    """Zoomed strip: every animation row, frames placed on their anchors along a baseline."""
    with open(os.path.join(OUT, name + '.json')) as fh:
        meta = json.load(fh)
    sheet = Image.open(os.path.join(OUT, name + '.png')); S = 4
    rows = list(meta['anims'].items())
    cellw = max(f[2] for _, fr in rows for f in fr) + 8; cellh = max(f[3] for _, fr in rows for f in fr) + 8
    img = Image.new('RGBA', (cellw * S * 6 + 20, (cellh * S + 10) * len(rows) + 10), (34, 34, 44, 255)); d = ImageDraw.Draw(img)
    for r, (an, fr) in enumerate(rows):
        base = 10 + r * (cellh * S + 10) + (cellh - 4) * S
        for i, (x, y, w, h, ax, ay) in enumerate(fr):
            f = sheet.crop((x, y, x + w, y + h)).resize((w * S, h * S), Image.NEAREST)
            cx = 10 + i * cellw * S + cellw * S // 2
            img.alpha_composite(f, (int(cx - ax * S), int(base - ay * S)))
            d.line((cx - 3, base, cx + 3, base), fill=(255, 80, 80, 255))
        d.text((2, 10 + r * (cellh * S + 10)), an, fill=(255, 220, 120, 255))
    img.save(os.path.join(RAW, f'anim_{name}_check.png'))


if __name__ == '__main__':
    if sys.argv[1] == 'preview':
        preview(sys.argv[2])
    elif sys.argv[1] == 'all':
        for n in SPECS:
            if os.path.exists(os.path.join(RAW, f'anim_{n}.png')):
                process(n)
        build_js()
    else:
        process(sys.argv[1]); build_js(); preview(sys.argv[1])
