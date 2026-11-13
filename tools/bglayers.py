"""Depth layers for the parallax backgrounds.

ChatGPT makes three edits of each background (assets_raw/bg_layers/raw/<key>_far|_mid|_near.png): a complete far layer, and the
middle and near pieces on flat magenta. This scales them back to the background's size (480x270), keys out the magenta, and
writes assets/bg/<key>_far|_mid|_near.png. With --preview it also writes assets_raw/bg_layers/preview_<key>.png: the original,
the three layers, the layers stacked (should look like the original) and the scene at both ends of a level, to check the cut.

    python tools/bglayers.py <key> [--preview]
"""
import os, sys
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'assets_raw', 'bg_layers', 'raw')
OUT = os.path.join(ROOT, 'assets', 'bg')
CROP = {'hall': 236, 'cave': 236, 'crypt': 236, 'camp': 236, 'boss': 236}   # BG_CROP in index.html: rows the game shows
DEPTH = {'default': [0.35, 0.65, 1.0], 'hall': [0.35, 0.42, 1.0], 'crypt': [0.35, 0.55, 1.0], 'boss': [0.35, 0.45, 1.0]}   # BG_DEPTH in index.html
HAZE = {'thornwood': 0.25}   # middle layers that sit in fog: blended this much toward the far layer's average colour
NO_NEAR = set()   # backgrounds whose near layer is empty
MIST = {'crypt': 236}   # near layers whose pieces above this row are mist: made soft and see-through (the ledge below stays solid)
GREEN_KEY = {'crypt', 'sanctum', 'glade', 'boss'}   # purple / pink art: these layers are made on flat green #00FF00 instead of magenta


def is_key(r, g, b, green=False):   # the flat key colour (magenta, or green for purple art), never the art's own colours
    if green: return g > 110 and g > 1.7 * max(r, b) and g - max(r, b) > 60
    return r > 110 and b > 100 and g < 0.6 * min(r, b) and abs(r - b) < 100 and min(r, b) - g > 60   # incl. darker magenta blends


def is_fringe(r, g, b, green=False):   # a pixel blended with the key, right next to it
    return (g > r + 35 and g > b + 35) if green else (r > g + 35 and b > g + 35)


def keyed(im, green=False):
    """Full-size RGBA with the magenta gone; a 1px rim of pinkish pixels around the cut is dropped too."""
    im = im.convert('RGBA'); px = im.load(); W, H = im.size
    mask = Image.new('L', im.size, 255); mp = mask.load()
    for y in range(H):
        for x in range(W):
            r, g, b, a = px[x, y]
            if a < 10 or is_key(r, g, b, green): mp[x, y] = 0
    # despill: a pixel that is partly key colour (anti-aliased edges, thin strands) gets the key taken back out, and the
    # share of key it held becomes its transparency, so thin webs and hair stay soft and continuous, edges stay clean
    for y in range(H):
        for x in range(W):
            if not mp[x, y]: continue
            r, g, b, a = px[x, y]
            sp = max(0, g - max(r, b)) if green else max(0, min(r, b) - g)
            if sp <= 12: continue
            k = min(0.95, sp / 255)
            if green: r, g, b = r / (1 - k), (g - 255 * k) / (1 - k), b / (1 - k)
            else: r, g, b = (r - 255 * k) / (1 - k), g / (1 - k), (b - 255 * k) / (1 - k)
            px[x, y] = tuple(max(0, min(255, round(c))) for c in (r, g, b)) + (255,)
            mp[x, y] = round(mp[x, y] * (1 - k))
    im.putalpha(mask)
    return im


def edge_clean(im, green=False, passes=2):
    """After shrinking: pixels on the cut edge that are tinted toward the key (magenta mixed into a dark outline) go."""
    px = im.load(); W, H = im.size
    tint = (lambda r, g, b: g - max(r, b) > 15 and g > 40) if green else (lambda r, g, b: r - g > 20 and b - g > 10 and b > 0.45 * r)
    for _ in range(passes):
        drop = []
        for y in range(H):
            for x in range(W):
                r, g, b, a = px[x, y]
                if not a or not tint(r, g, b): continue
                if any(not (0 <= x + dx < W and 0 <= y + dy < H) or px[x + dx, y + dy][3] == 0 for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))): drop.append((x, y))
        for q in drop: px[q] = (0, 0, 0, 0)
    return im


def mist(im, ledge, green=False):
    """Turn a solid band of mist into soft see-through mist: fades in from its top edge, at most ~60% strong."""
    px = im.load(); W, H = im.size
    for x in range(W):
        top = next((y for y in range(min(ledge, H)) if px[x, y][3]), None)
        if top is None: continue
        for y in range(top, min(ledge, H)):
            r, g, b, a = px[x, y]
            if not a: continue
            if green: g = min(g, (r + b) // 2)          # no green tint from the key
            px[x, y] = (r, g, b, round(150 * min(1, (y - top + 1) / 10)))
    return im


def despeckle(im, most=3):
    """Drop tiny islands of opaque pixels (key leftovers) after shrinking."""
    px = im.load(); W, H = im.size; seen = set()
    for y in range(H):
        for x in range(W):
            if (x, y) in seen or px[x, y][3] == 0: continue
            blob, todo = [], [(x, y)]; seen.add((x, y))
            while todo:
                q = todo.pop(); blob.append(q)
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    n = (q[0] + dx, q[1] + dy)
                    if 0 <= n[0] < W and 0 <= n[1] < H and n not in seen and px[n][3]: seen.add(n); todo.append(n)
            if len(blob) <= most:
                for q in blob: px[q] = (0, 0, 0, 0)
    return im


def shrink(im, size):
    """Down to the game's size; alpha is snapped to on/off so the pixel-art edges stay crisp."""
    im = im.convert('RGBA')
    # premultiply so transparent (key) colour can't bleed into the edges
    r, g, b, a = im.split()
    pm = Image.merge('RGBA', [Image.composite(c, Image.new('L', im.size, 0), a) for c in (r, g, b)] + [a])
    sm = pm.resize(size, Image.BOX); px = sm.load()
    for y in range(size[1]):
        for x in range(size[0]):
            R, G, B, A = px[x, y]
            if A < 40: px[x, y] = (0, 0, 0, 0)
            else: px[x, y] = (min(255, R * 255 // A), min(255, G * 255 // A), min(255, B * 255 // A), 255 if A > 215 else A)
    return sm


def build(key):
    orig = Image.open(os.path.join(OUT, key + '.png')).convert('RGB'); size = orig.size
    layers = []
    for n in ('far', 'mid', 'near'):
        if n == 'near' and key in NO_NEAR:
            im = Image.new('RGBA', size); im.save(os.path.join(OUT, f'{key}_{n}.png')); layers.append(im); continue
        src = Image.open(os.path.join(RAW, f'{key}_{n}.png'))
        im = src.convert('RGB').resize(size, Image.BOX).convert('RGBA') if n == 'far' else despeckle(shrink(keyed(src, key in GREEN_KEY), size))
        if n == 'mid' and key in HAZE:   # a little of the fog's colour, as distance looks in the original
            fr, fg, fb = [round(sum(i * c for i, c in enumerate(layers[0].getchannel(ch).histogram())) / (size[0] * size[1])) for ch in 'RGB']
            px = im.load(); k = HAZE[key]
            for y in range(size[1]):
                for x in range(size[0]):
                    r, g, b, a = px[x, y]
                    if a: px[x, y] = (round(r + (fr - r) * k), round(g + (fg - g) * k), round(b + (fb - b) * k), a)
        if n == 'near' and key in MIST: im = mist(im, MIST[key], key in GREEN_KEY)
        im.save(os.path.join(OUT, f'{key}_{n}.png')); layers.append(im)
        print(key, n, 'covers', round(100 * sum(im.getchannel('A').histogram()[1:]) / (size[0] * size[1])), '%')
    return orig, layers


def scene(key, layers, size, fx, crop):
    """What the game shows (480x270 worth) at camera position fx (0 = level start, 1 = end), like drawParallax."""
    W, H = 320, 180   # the screen in background pixels (the game draws the background at 3x on a 960x540 screen)
    bw, bh = size[0], crop
    out = Image.new('RGBA', (W, H))
    for k, L in zip(DEPTH.get(key, DEPTH['default']), layers):
        ox = (bw - W) * (0.5 + k * (fx - 0.5)); oy = (bh - H)   # rooms that don't scroll up and down sit at the bottom
        out.alpha_composite(L.crop((0, 0, size[0], crop)), (-round(ox), -round(oy)))
    return out


def preview(key, orig, layers):
    size = orig.size; crop = CROP.get(key, size[1]); S = 2
    stack = Image.new('RGBA', size); [stack.alpha_composite(L) for L in layers]
    check = Image.new('RGBA', size, (255, 0, 255, 255))
    tiles = [('original', orig.convert('RGBA')), ('far', layers[0])]
    for n, L in (('mid', layers[1]), ('near', layers[2])):
        t = check.copy(); t.alpha_composite(L); tiles.append((n + ' (magenta = empty)', t))
    tiles.append(('stacked', stack))
    ends = [('level start', scene(key, layers, size, 0, crop)), ('middle', scene(key, layers, size, 0.5, crop)), ('level end', scene(key, layers, size, 1, crop))]
    tw, th = size[0] * S, size[1] * S
    out = Image.new('RGBA', (tw * 2 + 30, th * 3 + 24 + 3 * 22 + 200 * S // 1), (24, 24, 30, 255))
    from PIL import ImageDraw
    d = ImageDraw.Draw(out)
    for i, (n, t) in enumerate(tiles):
        x, y = (i % 2) * (tw + 30), (i // 2) * (th + 22) + 18
        out.alpha_composite(t.resize((tw, th), Image.NEAREST), (x, y)); d.text((x + 4, y - 15), n, fill=(255, 230, 120, 255))
    y0 = 3 * (th + 22) + 18; sw = (tw * 2 + 30 - 40) // 3; sh = sw * 180 // 320
    for i, (n, t) in enumerate(ends):
        x = i * (sw + 20); out.alpha_composite(t.resize((sw, sh), Image.NEAREST), (x, y0)); d.text((x + 4, y0 - 15), n, fill=(255, 230, 120, 255))
    out = out.crop((0, 0, out.width, y0 + sh + 4))
    p = os.path.join(ROOT, 'assets_raw', 'bg_layers', f'preview_{key}.png'); out.save(p); print('preview', p)


def seamless(im, o):
    """Make a strip tile: the last o columns are cross-faded into the first o, so tile N's right edge runs straight into
    tile N+1's left edge. Where only one side has something (a grass blade, a post) it is kept as it is."""
    W, H = im.size; src = im.load(); out = Image.new('RGBA', (W - o, H)); px = out.load()
    for y in range(H):
        for x in range(W - o):
            if x >= o: px[x, y] = src[x, y]; continue
            a, b = src[W - o + x, y], src[x, y]; t = (x + 0.5) / o      # a: the end it continues from, b: its own start
            if a[3] and b[3]: px[x, y] = tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(4))
            else: px[x, y] = b if b[3] else a
    return out


def strip(name, width, overlap, fill_base=0):
    """A seamless strip for the Yard (raw/<name>.png, art on magenta) -> assets/bg/<name>.png, its pixels matching the
    backgrounds (width = background pixels), cropped to the art, seamless; fill_base rows at the bottom are made solid."""
    src = keyed(Image.open(os.path.join(RAW, name + '.png')))
    im = despeckle(shrink(src, (width, round(src.height * width / src.width))))
    bb = im.getbbox(); im = im.crop((0, bb[1], width, bb[3]))
    if overlap == 'posts':   # a fence: cut from the middle of the first post to the middle of the last, so posts repeat evenly
        ap = im.load(); row = 2
        cols = [x for x in range(im.width) if ap[x, row][3] > 128]
        runs, cur = [], None
        for x in range(im.width + 1):
            on = x < im.width and ap[x, row][3] > 128
            if on and cur is None: cur = x
            if not on and cur is not None: runs.append((cur + x - 1) / 2); cur = None
        c0, c1 = round(runs[0]), round(runs[-1]); print('posts at', [round(r) for r in runs])
        tile = im.crop((c0, 0, c1, im.height))
    else: tile = seamless(im, overlap)
    px = tile.load(); W, H = tile.size
    for y in range(H - fill_base, H):
        for x in range(W):
            if px[x, y][3] < 255: px[x, y] = px[x, y - 1][:3] + (255,)
    tile.save(os.path.join(OUT, name + '.png')); print(name, tile.size)
    prev = Image.new('RGBA', (W * 3, H + 20), (124, 196, 244, 255))
    for i in range(3): prev.alpha_composite(tile, (i * W, 20))
    prev.resize((prev.width * 2, prev.height * 2), Image.NEAREST).save(os.path.join(ROOT, 'assets_raw', 'bg_layers', f'preview_{name}.png'))


def yard():
    """The Sanctuary Yard: castle far layer (yard2_far, full picture) + the fields, fence and front-grass strips."""
    Image.open(os.path.join(RAW, 'yard2_far.png')).convert('RGB').resize((480, 270), Image.BOX).save(os.path.join(OUT, 'yard_far.png'))
    for name, w, o, base in (('yard_fields', 360, 40, 3), ('yard_fence', 320, 'posts', 0), ('yard_grass', 360, 40, 4)):
        if os.path.exists(os.path.join(RAW, name + '.png')): strip(name, w, o, base)


if __name__ == '__main__':
    if sys.argv[1] == '--yard': yard(); sys.exit()
    key = sys.argv[1]; o, L = build(key)
    if '--preview' in sys.argv: preview(key, o, L)
