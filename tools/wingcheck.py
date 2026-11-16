"""Checks a wings sheet (assets/doll/cape_wing<kind>_<sex>.png) frame by frame and draws a preview of it on the body.

    python -P tools/wingcheck.py m cape_wingdemon [more names...]

Per animation row it prints every frame's VISIBLE wing area (the pixels the body doesn't cover; the game draws the cape
layer behind the body) and its bounding box, and flags:
  EMPTY   a frame with (almost) no wing showing            JUMP    the area jumps >35% against BOTH neighbours
  EDGE    a pixel within 1 px of the cell's edge            COLOURS more colours than the snapped palette holds
  LOOSE   the wings sit more than 3 px from the torso/arms (they came off the back)
  IDLE    the idle frames differ (the body stands still there, so the loop would blink) unless it is a clean flap
The preview (assets_raw/doll/preview_wing<kind>_<sex>.png) is every frame at 4x: wings, then the tinted skin and the body.
"""
import sys, os
from PIL import Image, ImageFilter, ImageChops
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paperdoll as P

CW, CH, COLS = P.CW, P.CH, P.COLS
MIN_AREA = 30


def cells_of(im):
    return [im.crop((*P.cell_pos(i), P.cell_pos(i)[0] + CW, P.cell_pos(i)[1] + CH)) for i in range(sum(P.COUNTS))]


def check(sex, name):
    wing = Image.open(os.path.join(P.OUT, f'{name}_{sex}.png')).convert('RGBA')
    base = Image.open(os.path.join(P.OUT, f'base_{sex}.png')).convert('RGBA'); skin = Image.open(os.path.join(P.OUT, f'base_{sex}_skin.png')).convert('RGBA')
    body = Image.new('RGBA', base.size); body.alpha_composite(skin); body.alpha_composite(base)
    wc, bc = cells_of(wing), cells_of(body); flags = []; info = []
    cols = set(p[:3] for p in wing.getdata() if p[3])
    if len(cols) > 24: flags.append(f'COLOURS {len(cols)} > 24')
    if any(0 < p[3] < 255 for p in wing.getdata()): flags.append('COLOURS half-transparent pixels')
    for i, (w, b) in enumerate(zip(wc, bc)):
        a = w.getchannel('A').point(lambda v: 255 if v else 0); vis = ImageChops.subtract(a, b.getchannel('A').point(lambda v: 255 if v else 0))
        area = sum(1 for v in vis.getdata() if v); bb = vis.getbbox(); full = a.getbbox()
        if full and (full[0] < 1 or full[1] < 1 or full[2] > CW - 1 or full[3] > CH - 1): flags.append(f'EDGE frame {i} box {full}')
        # how far the wings are from the back: the torso and arms zones, shrunk to the cell
        Z = P.zones_of(sex, i); gap = None
        if Z and area:
            home = P.union([Z['torso'], Z['arms']], Z['torso'].size).resize((CW, CH), Image.BOX).point(lambda v: 255 if v > 60 else 0)
            for d in range(0, 12):
                near = home.filter(ImageFilter.MaxFilter(2 * d + 1)) if d else home
                if ImageChops.multiply(near, a).getbbox(): gap = d; break
            if gap is None or gap > 3: flags.append(f'LOOSE frame {i}: {gap if gap is not None else ">11"} px from the torso')
        info.append((area, bb, gap))
    i0 = 0
    for row, n in P.ROWS:
        ar = [info[i][0] for i in range(i0, i0 + n)]; loop = row in ('idle', 'run')
        for j in range(n):
            if ar[j] < MIN_AREA: flags.append(f'EMPTY {row} frame {j} (sheet frame {i0 + j}): {ar[j]} px'); continue
            nb = [ar[(j - 1) % n], ar[(j + 1) % n]] if loop else [ar[k] for k in (j - 1, j + 1) if 0 <= k < n]
            if len(nb) == 2 and all(abs(ar[j] - v) > 0.35 * max(ar[j], v) for v in nb) and row != 'death':
                flags.append(f'JUMP {row} frame {j} (sheet frame {i0 + j}): {ar[j]} px next to {nb}')
        sizes = [f'{b[2] - b[0]}x{b[3] - b[1]}' if b else '-' for _, b, _ in info[i0:i0 + n]]
        print(f'  {row:6} area {ar}  box {sizes}  gap {[g for _, _, g in info[i0:i0 + n]]}')
        if row == 'idle' and len(set(wc[i].tobytes() for i in range(i0, i0 + n))) > 1:
            diff = [sum(1 for p, q in zip(wc[i0].getdata(), wc[i].getdata()) if (p[3] > 0) != (q[3] > 0)) for i in range(i0 + 1, i0 + n)]
            print(f'  idle frames differ from frame 0 by {diff} px (a flap)')
        i0 += n
    print(f'{name}_{sex}: {len(cols)} colours;', 'FLAGS: ' + '; '.join(flags) if flags else 'no flags')
    # the preview: wings behind the body, every frame, 4x
    tone = (234, 192, 159); sk = Image.new('RGBA', skin.size); sp, kp = sk.load(), skin.load()
    for y in range(skin.height):
        for x in range(skin.width):
            v, _, _, al = kp[x, y]
            if al: sp[x, y] = (tone[0] * v // 255, tone[1] * v // 255, tone[2] * v // 255, 255)
    out = Image.new('RGBA', base.size, (70, 80, 96, 255)); out.alpha_composite(wing); out.alpha_composite(sk); out.alpha_composite(base)
    out = out.resize((out.width * 4, out.height * 4), Image.NEAREST)
    p = os.path.join(P.RAW, f'preview_{name.replace("cape_", "")}_{sex}.png'); out.save(p); print('preview ->', p)
    return flags


if __name__ == '__main__':
    bad = 0
    for nm in sys.argv[2:]: bad += len(check(sys.argv[1], nm))
    sys.exit(1 if bad else 0)
