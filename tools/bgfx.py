"""Background animation strips (lava falls, waterfalls, flags, banners, fog, clouds...).

ChatGPT draws each effect as N frames in one row of equal cells on flat magenta (or green): assets_raw/bg_layers/raw/fx_<name>.png.
This keys the background out (with the same despill as tools/bglayers.py), cuts the N cells, aligns every frame to one shared
box (so nothing jitters), scales the frames to the game's background pixel size (height in background pixels) and writes
assets/bgfx/<name>.png: the frames side by side, each frame img.width / N wide. A preview strip goes to
assets_raw/bg_layers/preview_fx_<name>.png.

    python tools/bgfx.py <name> <frames> <height> [--green] [--keep-bg]
"""
import os, sys
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bglayers import keyed, shrink, despeckle, seamless, RAW, ROOT

OUT = os.path.join(ROOT, 'assets', 'bgfx')


def seamless_v(im, o):
    """seamless() top to bottom: the last o rows cross-fade into the first o."""
    return seamless(im.transpose(Image.Transpose.TRANSPOSE), o).transpose(Image.Transpose.TRANSPOSE)


def build(name, n, height, green=False, keep_bg=False, body=None, out_name=None, row=None, loop=0, tile=False):
    src = Image.open(os.path.join(RAW, f'fx_{name}.png'))
    im = src.convert('RGBA') if keep_bg else keyed(src, green)
    if row:   # one row of a sheet with several rows: row = (index, rows)
        H0 = im.height; im = im.crop((0, round(H0 * row[0] / row[1]), im.width, round(H0 * (row[0] + 1) / row[1])))
    W, H = im.size; cw = W / n
    cells = [im.crop((round(i * cw), 0, round((i + 1) * cw), H)) for i in range(n)]
    boxes = [c.getbbox() for c in cells]
    if any(b is None for b in boxes): raise SystemExit(f'{name}: an empty frame')
    x0 = min(b[0] for b in boxes); y0 = min(b[1] for b in boxes); x1 = max(b[2] for b in boxes); y1 = max(b[3] for b in boxes)
    if body:   # use only the middle of each frame (e.g. the flowing body of a waterfall, as a texture)
        bw, bh = x1 - x0, y1 - y0; x0, x1 = x0 + round(bw * body[0]), x0 + round(bw * body[1]); y0, y1 = y0 + round(bh * body[2]), y0 + round(bh * body[3])
    fw, fh = x1 - x0, y1 - y0
    tw = max(1, round(fw * height / fh))
    frames = [despeckle(shrink(c.crop((x0, y0, x1, y1)), (tw, height)), 1) for c in cells]
    if tile:   # a texture that is tiled: seamless left-right and top-bottom, so copies show no lines
        frames = [seamless_v(seamless(f, max(2, f.width // 4)), max(4, f.height // 5)) for f in frames]; tw = frames[0].width; height = frames[0].height
    if loop:   # a single strip that scrolls forever: cross-fade its ends so copies join with no seam
        frames = [seamless(f, loop) for f in frames]; tw = frames[0].width
    sheet = Image.new('RGBA', (tw * n, height))
    for i, f in enumerate(frames): sheet.alpha_composite(f, (i * tw, 0))
    name = out_name or name
    os.makedirs(OUT, exist_ok=True); sheet.save(os.path.join(OUT, name + '.png'))
    prev = Image.new('RGBA', (sheet.width + 2 * n, height), (40, 40, 52, 255))
    for i, f in enumerate(frames): prev.alpha_composite(f, (i * (tw + 2), 0))
    k = max(1, 300 // height)
    prev.resize((prev.width * k, prev.height * k), Image.NEAREST).save(os.path.join(ROOT, 'assets_raw', 'bg_layers', f'preview_fx_{name}.png'))
    print(name, 'frames', n, 'each', (tw, height)); return n


# ---------------------------------------------------------------------------------------------------------------------
# What moves in each area. Coordinates are background pixels (480x270), L = layer (0 far, 1 mid, 2 near, 3 in front of
# all three). Kinds: flow (an animated texture tiled inside the art's own pixels: lava, waterfalls, moonlight, runes; the
# mask is made here from the layer's colours inside the rect), sprite (frames at a spot; cut = where the still art is
# erased so the moving one replaces it), drift (particles that float about), scroll (a seamless strip sliding sideways),
# glow (a soft light that breathes), ripple (rows y0..y1 of the layer itself redrawn with a small moving sideways wave:
# water and its reflections waver; amp in background pixels, bigger toward y1), sway (pixels matching rule in rect are lifted
# out of the layer and swing sideways, still at the top and most at the bottom: hanging willow strands).
# ---------------------------------------------------------------------------------------------------------------------
RULES = {
    'lava': lambda r, g, b: r > 175 and g > 60 and b < 110 and r - b > 100,
    'water': lambda r, g, b: (r + g + b) / 3 > 120 and b >= r + 5 and b >= g - 12,
    'cavewater': lambda r, g, b: g > 118 and b > r + 12 and g >= b,   # the cave's muted teal falls
    'moon': lambda r, g, b: (r + g + b) / 3 > 150,
    'rune': lambda r, g, b: r > 130 and b > 165 and g < 170 and b - g > 40,
    'leaf': lambda r, g, b: (r + g + b) / 3 > 150 and b >= r + 5,   # the lake willows' pale hanging strands
    'all': lambda r, g, b: True,
}
STRIPS = {   # sheet name: (raw strip fx_<name>.png, frames, height in background pixels, options)
    'lavaflow': ('lavafall', 6, 48, dict(body=(0.3, 0.7, 0.2, 0.78), tile=True)),
    'waterflow': ('waterfall', 6, 48, dict(body=(0.3, 0.7, 0.2, 0.78), tile=True)),
    'moonflow': ('moonwater', 6, 32, {}),
    'runeflow': ('runes', 6, 48, dict(green=True)),
    'ember': ('particles', 4, 5, dict(row=(1, 4))),
    'firefly': ('particles', 4, 7, dict(row=(0, 4))),
    'dust': ('particles', 4, 4, dict(row=(2, 4))),
    'butterfly': ('particles', 4, 8, dict(row=(3, 4))),
    'fog': ('fog', 1, 40, dict(loop=60)),
    'cloud': ('clouds', 4, 22, {}),
    'banner_hall': ('banner_hall', 6, 112, {}),
    'banner_boss': ('banner_boss', 6, 118, dict(green=True)),
}
W_ = lambda rect: dict(k='flow', s='waterflow', fps=10, rule='water', rect=rect, a=0.8)
LAVA = lambda L, rect: dict(k='flow', L=L, s='lavaflow', fps=9, rule='lava', rect=rect, a=0.8)
DUST = dict(k='drift', L=3, s='dust', fps=3, count=14, area=[0, 10, 480, 220], vx=3, vy=-1.5, wob=4, a=0.55)
FX = {
    'hall': [dict(k='sprite', L=1, s='banner_hall', fps=6, cx=146, top=42, cut=[124, 42, 46, 120]),
             dict(k='sprite', L=1, s='banner_hall', fps=6, cx=335, top=42, cut=[313, 42, 46, 120], t0=0.4), DUST],
    'cave': [dict(W_([131, 90, 26, 60]), L=1, rule='cavewater'), dict(W_([155, 150, 24, 70]), L=1, rule='cavewater'), dict(W_([284, 115, 22, 78]), L=1, rule='cavewater'),
             dict(k='drift', L=2, s='firefly', fps=6, count=10, area=[20, 40, 440, 170], vx=2, vy=-1, wob=6, a=0.28, add=1, sc=0.5, tint='hue-rotate(60deg)')],   # faint little spores
    'crypt': [dict(k='scroll', L=2, s='fog', y=184, speed=6, a=0.45, tint='hue-rotate(250deg) saturate(0.8)'), DUST],
    'forge': [LAVA(1, [186, 52, 36, 120]), LAVA(1, [290, 148, 44, 120]), LAVA(1, [298, 112, 44, 44]), LAVA(1, [355, 165, 80, 95]), LAVA(1, [112, 195, 50, 70]),
              LAVA(0, [194, 68, 30, 80]), LAVA(0, [242, 102, 20, 40]),
              dict(k='drift', L=3, s='ember', fps=8, count=34, area=[0, 60, 480, 210], vx=2, vy=-14, wob=5, a=0.9, add=1)],
    'hollow': [dict(k='scroll', L=0, s='fog', y=140, speed=4, a=0.5), dict(k='scroll', L=1, s='fog', y=200, speed=9, a=0.4),
               dict(k='drift', L=2, s='firefly', fps=5, count=8, area=[30, 60, 420, 160], vx=1, vy=-1, wob=8, a=0.25, add=1, sc=0.5, tint='saturate(0.2) brightness(1.2)')],   # faint little ghost-lights
    'sanctum': [dict(k='flow', L=0, s='runeflow', fps=8, rule='rune', rect=[278, 32, 116, 116], add=1),
                dict(k='scroll', L=1, s='fog', y=205, speed=5, a=0.4, tint='hue-rotate(240deg) saturate(1.3)'),
                dict(k='drift', L=2, s='firefly', fps=6, count=10, area=[20, 30, 440, 190], vx=1, vy=-3, wob=5, a=0.25, add=1, sc=0.5, tint='hue-rotate(220deg) saturate(1.4)')],   # faint little motes
    'thornwood': [dict(k='scroll', L=0, s='fog', y=165, speed=4, a=0.35, tint='hue-rotate(70deg)'),
                  dict(k='drift', L=2, s='firefly', fps=6, count=12, area=[20, 50, 440, 180], vx=2, vy=-1, wob=7, a=0.25, add=1, sc=0.5)],   # faint little fireflies
    'glade': [dict(W_([236, 134, 30, 52]), L=1), dict(W_([292, 104, 28, 76]), L=1), dict(W_([344, 98, 26, 56]), L=1), dict(W_([291, 180, 26, 44]), L=1),
              dict(k='drift', L=2, s='firefly', fps=6, count=12, area=[20, 40, 440, 190], vx=2, vy=-1, wob=7, a=0.25, add=1, sc=0.5, tint='hue-rotate(280deg) saturate(1.2)'),   # faint little fireflies
              dict(k='drift', L=3, s='butterfly', fps=10, count=4, area=[40, 90, 400, 130], vx=8, vy=0, wob=10, a=1)],
    'lake': [dict(k='ripple', L=0, y0=150, y1=270, amp=1.2, freq=0.45, speed=2.0),   # the lake surface (and its reflections) waver gently
             dict(k='sway', L=2, rule='all', rect=[100, 0, 140, 112], amp=2.2, speed=1.3),   # the big willow's hanging curtain (right of the trunk)
             dict(k='sway', L=0, rule='leaf', rect=[55, 78, 112, 64], amp=0.7, speed=1.1, ph=1),   # the far willow islands, gently
             dict(k='sway', L=0, rule='leaf', rect=[200, 66, 78, 48], amp=0.6, speed=1.2, ph=2),
             dict(k='sway', L=0, rule='leaf', rect=[428, 30, 52, 80], amp=0.6, speed=1.0, ph=3),
             dict(W_([192, 116, 36, 42]), L=0), dict(W_([386, 96, 42, 62]), L=0),
             dict(k='flow', L=0, s='moonflow', fps=6, rule='moon', rect=[282, 148, 72, 122], a=0.55, add=1),   # sparkles added as light over the moon path
             dict(k='drift', L=0, s='cloud', fps=0, count=4, area=[0, 6, 480, 60], vx=2.5, vy=0, wob=0, a=0.9),
             dict(k='drift', L=1, s='firefly', fps=5, count=10, area=[60, 140, 360, 60], vx=1, vy=-0.5, wob=4, a=0.25, add=1, sc=0.5, tint='hue-rotate(160deg) saturate(0.6)')],   # faint little lights over the water
    'camp': [DUST, dict(k='glow', L=1, x=110, y=190, r=70, c='255,170,90', a=0.18, period=3.2)],
    'boss': [dict(k='sprite', L=1, s='banner_boss', fps=6, cx=140, top=42, cut=[118, 42, 46, 125]),
             dict(k='sprite', L=1, s='banner_boss', fps=6, cx=340, top=42, cut=[318, 42, 46, 125], t0=0.4),
             dict(k='scroll', L=0, s='fog', y=200, speed=7, a=0.5, tint='hue-rotate(320deg) saturate(1.6) brightness(0.8)'),
             dict(k='drift', L=3, s='ember', fps=8, count=12, area=[0, 60, 480, 180], vx=1, vy=-8, wob=5, a=0.7, add=1, tint='saturate(0.6) brightness(0.8)')],
    'yard': [dict(k='drift', L=0, s='cloud', fps=0, count=5, area=[0, 6, 480, 70], vx=3, vy=0, wob=0, a=0.95),
             dict(k='drift', L=3, s='butterfly', fps=10, count=9, area=[0, 120, 960, 90], vx=10, vy=0, wob=12, a=1)],   # spread over the whole Yard (it is 1800 px wide)
}


def mask(area, layer, rect, rule):
    """White pixels where the layer's art matches the rule inside rect; returns (name, [x, y, w, h]) cropped to them."""
    names = ['far', 'mid', 'near']
    im = Image.open(os.path.join(ROOT, 'assets', 'bg', f'{area}_{names[layer]}.png')).convert('RGBA'); px = im.load()
    x, y, w, h = rect; m = Image.new('RGBA', (w, h)); mp = m.load(); test = RULES[rule]
    for j in range(h):
        for i in range(w):
            if 0 <= x + i < im.width and 0 <= y + j < im.height:
                r, g, b, a = px[x + i, y + j]
                if a > 100 and test(r, g, b): mp[i, j] = (255, 255, 255, 255)
    bb = m.getbbox()
    if not bb: raise SystemExit(f'empty mask {area} {rect} {rule}')
    m = m.crop(bb); n = f'mask_{area}_{len(os.listdir(OUT)) if os.path.isdir(OUT) else 0}'
    k = sum(1 for f in os.listdir(OUT) if f.startswith(f'mask_{area}_')) if os.path.isdir(OUT) else 0
    n = f'mask_{area}_{k}'; m.save(os.path.join(OUT, n + '.png'))
    return n, [x + bb[0], y + bb[1], bb[2] - bb[0], bb[3] - bb[1]]


PRISTINE = os.path.join(ROOT, 'assets_raw', 'bg_layers', 'pristine')


def layer_path(area, layer):
    """The layer file; the first time a layer is edited here an untouched copy is kept, and every build starts from it."""
    names = ['far', 'mid', 'near']; p = os.path.join(ROOT, 'assets', 'bg', f'{area}_{names[layer]}.png')
    keep = os.path.join(PRISTINE, f'{area}_{names[layer]}.png'); os.makedirs(PRISTINE, exist_ok=True)
    if not os.path.exists(keep): Image.open(p).save(keep)
    return p, keep


def sway_cut(area, layer, rect, rule):
    """Lift the pixels matching rule inside rect out of the layer into their own image (bgfx/sway_<area>_<k>), so the
    game can sway them without the still copy showing underneath."""
    p, _ = layer_path(area, layer); im = Image.open(p).convert('RGBA'); px = im.load()
    x, y, w, h = rect; part = Image.new('RGBA', (w, h)); pp = part.load(); test = RULES[rule]; gone = set()
    for j in range(h):
        for i in range(w):
            X, Y = x + i, y + j
            if 0 <= X < im.width and 0 <= Y < im.height:
                r, g, b, a = px[X, Y]
                if a > (0 if rule == 'all' else 60) and test(r, g, b): pp[i, j] = (r, g, b, a); px[X, Y] = (0, 0, 0, 0); gone.add((X, Y))
    # fill the gaps they leave from the darker leaves and sky around them, so nothing shows through as they swing
    for _ in range(12 if rule != 'all' else 0):   # (a see-through layer just keeps its gaps: what's behind shows, as it should)
        filled = {}
        for X, Y in gone:
            near = [px[X + dx, Y + dy] for dx in (-1, 0, 1) for dy in (-1, 0, 1) if (dx or dy) and 0 <= X + dx < im.width and 0 <= Y + dy < im.height
                    and (X + dx, Y + dy) not in gone and px[X + dx, Y + dy][3] > 200]
            if len(near) >= 2: filled[(X, Y)] = tuple(sum(c[k] for c in near) // len(near) for k in range(3)) + (255,)
        if not filled: break
        for q, c in filled.items(): px[q] = c; gone.discard(q)
    bb = part.getbbox()
    if not bb: raise SystemExit(f'nothing to sway {area} {rect}')
    k = sum(1 for f in os.listdir(OUT) if f.startswith(f'sway_{area}_'))
    n = f'sway_{area}_{k}'; part.crop(bb).save(os.path.join(OUT, n + '.png')); im.save(p)
    return n, [x + bb[0], y + bb[1], bb[2] - bb[0], bb[3] - bb[1]]


def cut(area, layer, rect, keep_top=0):
    """Erase the still art inside rect (below keep_top rows) so a moving version can replace it."""
    p, _ = layer_path(area, layer)
    im = Image.open(p).convert('RGBA'); px = im.load(); x, y, w, h = rect
    for j in range(keep_top, h):
        for i in range(w):
            if 0 <= x + i < im.width and 0 <= y + j < im.height: px[x + i, y + j] = (0, 0, 0, 0)
    im.save(p)


def write_js():
    import json
    for f in os.listdir(OUT):
        if f.startswith('mask_') or f.startswith('sway_'): os.remove(os.path.join(OUT, f))
    if os.path.isdir(PRISTINE):   # every cut starts again from the untouched layers
        for f in os.listdir(PRISTINE): Image.open(os.path.join(PRISTINE, f)).save(os.path.join(ROOT, 'assets', 'bg', f))
    frames = {}
    for name, (src, n, h, opt) in STRIPS.items():
        if os.path.exists(os.path.join(RAW, f'fx_{src}.png')): frames[name] = build(src, n, h, out_name=name, **opt)
    out = {}
    for area, effects in FX.items():
        out[area] = []
        for e in effects:
            e = dict(e)
            if e.get('s') and e['s'] not in frames: continue          # its strip isn't made yet
            if e['k'] == 'flow': e['m'], e['r'] = mask(area, e['L'], e.pop('rect'), e.pop('rule'))
            if e.get('cut'): cut(area, e['L'], e['cut'], e.pop('keepTop', 0)); e.pop('cut')
            if e['k'] == 'sway': e['m'], e['r'] = sway_cut(area, e['L'], e.pop('rect'), e.pop('rule'))
            if e.get('s'): e['n'] = frames[e['s']]
            out[area].append(e)
    with open(os.path.join(OUT, 'bgfx.js'), 'w') as fh:
        fh.write('// generated by tools/bgfx.py: what moves in each background (see FX there)\n')
        fh.write('window.BGFX = ' + json.dumps(out, separators=(',', ':')) + ';\n')
    print('bgfx.js:', {a: len(v) for a, v in out.items()})


if __name__ == '__main__':
    if sys.argv[1] == '--all': write_js(); sys.exit()
    a = sys.argv
    build(a[1], int(a[2]), int(a[3]), '--green' in a, '--keep-bg' in a)
