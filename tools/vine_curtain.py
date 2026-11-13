"""The Act III battle transition's vine curtain: ChatGPT's left curtain on magenta (assets_raw/bg_layers/raw/vine_curtain.png:
a solid wall of vines on the left breaking up into hanging strands on the right) -> assets/props/vine_curtain.png.

It is keyed (soft-edged magenta removed, pink spill cleaned), trimmed, and scaled to 270 px tall: the game draws it at 2x
with no smoothing, so it lands on the same 2-pixel grid as the rest of the transition. It prints SOLID, the column where
the solid wall ends (the game's VINE_SOLID): left of it every column is covered from top to bottom.

    python tools/vine_curtain.py
"""
import os, sys
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
from bglayers import keyed   # magenta key with despill

SRC = os.path.join(ROOT, 'assets_raw', 'bg_layers', 'raw', 'vine_curtain.png')
OUT = os.path.join(ROOT, 'assets', 'props', 'vine_curtain.png')
HEIGHT = 270
HEM = 14   # the game's VINE_HEM


def main():
    im = keyed(Image.open(SRC))
    bb = im.getbbox(); im = im.crop((0, 0, bb[2], im.height))   # keep the full height; trim magenta off the right
    w = round(im.width * HEIGHT / im.height)
    small = im.resize((w, HEIGHT), Image.LANCZOS)
    # hard alpha, like pixel art
    px = small.load()
    for y in range(HEIGHT):
        for x in range(w):
            r, g, b, a = px[x, y]
            px[x, y] = (r, g, b, 255) if a >= 128 else (0, 0, 0, 0)
    # the solid wall: from the left, columns that are covered apart from a few stray specks (filled in below)
    solid = 0
    for x in range(w):
        holes = sum(1 for y in range(HEIGHT) if px[x, y][3] == 0)
        if holes > HEIGHT * 0.06: break
        solid = x + 1
    # fill any stray holes inside the wall with the dark foliage colour around them
    for x in range(solid):
        for y in range(HEIGHT):
            if px[x, y][3] == 0: px[x, y] = (16, 40, 20, 255)
    # a ragged leafy hem below the picture (HEM rows: the bottom rows mirrored, then torn off unevenly), so the drape's
    # leading edge isn't a straight line while it comes down; when closed it sits below the screen
    import math
    out = Image.new('RGBA', (w, HEIGHT + HEM)); out.alpha_composite(small, (0, 0)); op = out.load()
    for r in range(HEM):
        for x in range(w): op[x, HEIGHT + r] = px[x, HEIGHT - 1 - r]
    for x in range(w):
        cut = HEIGHT + int(round(3 + 4 * abs(math.sin(x * 0.21)) + 3 * math.sin(x * 0.57 + 1.3) + 2 * math.sin(x * 1.3)))
        for y in range(max(HEIGHT, cut), HEIGHT + HEM): op[x, y] = (0, 0, 0, 0)
    out.save(OUT)
    print('vine curtain', out.size, 'SOLID', solid, 'HEM', HEM)


if __name__ == '__main__':
    main()
