"""Bake the rare PINK coat: a pink copy of every animal's animation sheets (assets/anim/<sheet>_pink.png).

Usage (run from anywhere):
    python -P tools/pink.py            # (re)make every animal's _pink sheet
    python -P tools/pink.py preview    # also write assets_raw/pink_preview.png (original above, pink below)

How a sheet is recoloured (the art's own light and dark are kept, only the colours change): every colour in the sheet
is ranked from darkest to lightest by how many pixels are darker than it, and the ranking is cut into shares (SHARES):
  * the darkest share (outlines, eyes) -> INK[0], the next (inner lines, deep shadow) -> INK[1]: deep roses, so the
    drawing still reads on a pale coat;
  * the rest in five equal shares -> PINK[0] (shadow) ... PINK[4] (highlight).
Ranking (not fixed brightness cut-offs) means a white unicorn and a black wolf both use the whole ramp, with their
shadows and highlights where they were. Alpha is untouched, and the game reuses the base sheet's frames (<sheet>.json).
A new animal sheet needs this run again (every sheet with a .json except the monsters in NOT_ANIMALS and _shiny sheets).
"""
import sys, os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ANIM = os.path.join(ROOT, 'assets', 'anim')

PINK = ['#e68bbe', '#eea1cd', '#f4b8da', '#f9cee7', '#fde4f2']   # the coat, darkest to lightest (the owner's palette)
INK = ['#5c2343', '#a4507e']                                    # deep roses in the coat's hue (326 deg), for line art
SHARES = [0.09, 0.11] + [0.16] * 5                              # of the animal's pixels: INK[0], INK[1], PINK[0..4]
NOT_ANIMALS = {'bat', 'brute', 'cultist', 'ghost', 'goblin', 'golem', 'imp', 'knight', 'skeleton', 'slime', 'spider', 'warden'}


def animal_sheets():
    out = []
    for f in sorted(os.listdir(ANIM)):
        n, ext = os.path.splitext(f)
        if ext != '.png' or n.endswith('_pink') or n.endswith('_shiny') or n in NOT_ANIMALS: continue   # (a pink shiny uses the pink sheet + the gloss)
        if not os.path.exists(os.path.join(ANIM, n + '.json')): continue
        out.append(n)
    return out


def hexrgb(h): return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))
def lum(c): return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255


def pinkify(im):
    im = im.convert('RGBA'); w, h = im.size; px = im.load()
    counts = {}
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a > 8: counts[(r, g, b)] = counts.get((r, g, b), 0) + 1
    ramp = [hexrgb(p) for p in INK + PINK]
    cuts = [sum(SHARES[:i + 1]) for i in range(len(SHARES))]
    total = sum(counts.values()) or 1; out = {}; acc = 0
    for c in sorted(counts, key=lum):   # each colour lands in the share its middle pixel falls in
        mid = (acc + counts[c] / 2) / total; acc += counts[c]
        out[c] = ramp[next((i for i, e in enumerate(cuts) if mid < e), len(ramp) - 1)]
    res = im.copy(); rp = res.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a > 8: rp[x, y] = out[(r, g, b)] + (a,)
    return res


def preview(pairs):
    S = 2; pad = 6
    rows = [(im, pk) for _, im, pk in pairs]
    cols = 4; cw = max(im.width for im, _ in rows) * S + pad; ch = max(im.height for im, _ in rows) * S * 2 + pad * 2
    n = len(rows); sheet = Image.new('RGBA', (cols * cw, ((n + cols - 1) // cols) * ch), (40, 36, 52, 255))
    for i, (im, pk) in enumerate(rows):
        x, y = (i % cols) * cw, (i // cols) * ch
        sheet.alpha_composite(im.resize((im.width * S, im.height * S), Image.NEAREST), (x, y))
        sheet.alpha_composite(pk.resize((pk.width * S, pk.height * S), Image.NEAREST), (x, y + im.height * S + pad))
    p = os.path.join(ROOT, 'assets_raw', 'pink_preview.png'); sheet.save(p); print('preview ->', p)


if __name__ == '__main__':
    pairs = []
    for n in animal_sheets():
        im = Image.open(os.path.join(ANIM, n + '.png')); pk = pinkify(im)
        pk.save(os.path.join(ANIM, n + '_pink.png'), optimize=True)
        pairs.append((n, im.convert('RGBA'), pk))
    print(len(pairs), 'pink sheets:', ' '.join(n for n, _, _ in pairs))
    if 'preview' in sys.argv[1:]: preview(pairs)
