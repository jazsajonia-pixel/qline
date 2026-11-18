#!/usr/bin/env python3
"""Generate Qline's Android launcher icons from the in-app QMark geometry.

The mark is drawn with exactly the same maths as `_QMarkPainter` in lib/ui/core_painter.dart,
so the launcher icon and the in-app mark always match:
  ring  centre (.46, .46) of the unit square, radius .36, stroke .10, arc from .9 rad sweeping 5.6 rad
  tail  from centre + (r*.35, r*.35) to (.92, .92), round caps
Palette: "Citrine Signal on Spruce Ink" (lib/ui/theme.dart). Run from apps/mobile:
  python3 tool/make_icons.py
Writes every mipmap density (legacy, round, adaptive foreground, monochrome), the adaptive
background colour, a 512 px store icon and the SVG source in tool/brand/.
"""
import math
import os
from PIL import Image, ImageDraw, ImageFilter

CITRINE = (245, 196, 81)      # QColors.dark.halo  #F5C451
INK = (5, 12, 11)             # QColors.liveInk    #050C0B
SPRUCE = (16, 34, 31)         # lifted centre of the background gradient
RES = os.path.join(os.path.dirname(__file__), '..', 'android', 'app', 'src', 'main', 'res')
BRAND = os.path.join(os.path.dirname(__file__), 'brand')
DENSITIES = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
SS = 4  # supersampling factor

# The mark's bounding circle is centred on the tail diagonal at (.5625, .5625) with radius .555
# of the unit square (ring far side .17 → tail tip .955). Keeping that circle inside the 66 dp
# adaptive safe zone means U * .555 <= 33 dp, so U = 56 dp leaves a small margin.
ANCHOR = .5625
ADAPTIVE_UNIT_DP = 56
LEGACY_UNIT_FRACTION = .62    # of the 48 dp legacy square


def mark_layer(size, unit_px, color, glow=False):
    big = Image.new('RGBA', (size * SS, size * SS), (0, 0, 0, 0))
    draw_mark_true(big, unit_px * SS, size * SS / 2, size * SS / 2, color)
    out = big.resize((size, size), Image.LANCZOS)
    if glow:
        halo = out.copy().filter(ImageFilter.GaussianBlur(size * .045))
        alpha = halo.getchannel('A').point(lambda v: int(v * .55))
        halo.putalpha(alpha)
        base = Image.new('RGBA', out.size, (0, 0, 0, 0))
        base.alpha_composite(halo)
        base.alpha_composite(out)
        out = base
    return out


def draw_mark_true(img, unit_px, cx, cy, color):
    """Stroke the mark by stamping round dots along each path, which gives exact round caps and a
    stroke centred on the path, like Flutter's StrokeCap.round."""
    d = ImageDraw.Draw(img)
    ox, oy = cx - ANCHOR * unit_px, cy - ANCHOR * unit_px
    r, w = .36 * unit_px, .10 * unit_px
    ctr = (ox + .46 * unit_px, oy + .46 * unit_px)
    start, sweep = .9, 5.6

    def dot(x, y):
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=color)

    steps = max(2, int(r * sweep / .5))
    for i in range(steps + 1):
        ang = start + sweep * i / steps
        dot(ctr[0] + r * math.cos(ang), ctr[1] + r * math.sin(ang))
    a = (ctr[0] + r * .35, ctr[1] + r * .35)
    b = (ox + .92 * unit_px, oy + .92 * unit_px)
    n = max(2, int(math.dist(a, b) / .5))
    for i in range(n + 1):
        dot(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n)


def background(size):
    """Spruce ink, lifted slightly at the centre (static version of the in-app core glow)."""
    img = Image.new('RGBA', (size, size), INK + (255,))
    px = img.load()
    c = (size - 1) / 2
    for y in range(size):
        for x in range(size):
            t = min(1, math.hypot(x - c, y - c) / (size * .62))
            k = (1 - t) ** 1.6
            px[x, y] = tuple(round(INK[i] + (SPRUCE[i] - INK[i]) * k) for i in range(3)) + (255,)
    return img


def rounded(img, radius_fraction):
    mask = Image.new('L', (img.width * SS, img.height * SS), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, mask.width - 1, mask.height - 1], radius=mask.width * radius_fraction, fill=255)
    out = img.copy()
    out.putalpha(mask.resize(img.size, Image.LANCZOS))
    return out


def legacy(size):
    img = background(size)
    img.alpha_composite(mark_layer(size, size * LEGACY_UNIT_FRACTION, CITRINE + (255,), glow=True))
    return img


def write():
    for name, k in DENSITIES.items():
        folder = os.path.join(RES, f'mipmap-{name}')
        os.makedirs(folder, exist_ok=True)
        adaptive = round(108 * k)
        fg = mark_layer(adaptive, ADAPTIVE_UNIT_DP * k, CITRINE + (255,), glow=True)
        fg.save(os.path.join(folder, 'ic_launcher_foreground.png'), optimize=True)
        mono = mark_layer(adaptive, ADAPTIVE_UNIT_DP * k, (255, 255, 255, 255))
        mono.save(os.path.join(folder, 'ic_launcher_monochrome.png'), optimize=True)
        bg = background(adaptive)
        bg.save(os.path.join(folder, 'ic_launcher_background.png'), optimize=True)
        size = round(48 * k)
        rounded(legacy(size), .22).save(os.path.join(folder, 'ic_launcher.png'), optimize=True)
        rounded(legacy(size), .5).save(os.path.join(folder, 'ic_launcher_round.png'), optimize=True)
    os.makedirs(BRAND, exist_ok=True)
    legacy(512).save(os.path.join(BRAND, 'qline-icon-512.png'), optimize=True)
    write_svg()


def write_svg():
    s = 100
    r, w = 36, 10
    cx = cy = 46
    a0, a1 = .9, .9 + 5.6
    p0 = (cx + r * math.cos(a0), cy + r * math.sin(a0))
    p1 = (cx + r * math.cos(a1), cy + r * math.sin(a1))
    t0 = (cx + r * .35, cy + r * .35)
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {s} {s}" width="512" height="512">
  <!-- QMark source: same geometry as _QMarkPainter (lib/ui/core_painter.dart). Generated by tool/make_icons.py. -->
  <g fill="none" stroke="#F5C451" stroke-width="{w}" stroke-linecap="round">
    <path d="M {p0[0]:.3f} {p0[1]:.3f} A {r} {r} 0 1 1 {p1[0]:.3f} {p1[1]:.3f}"/>
    <line x1="{t0[0]:.3f}" y1="{t0[1]:.3f}" x2="92" y2="92"/>
  </g>
</svg>
'''
    open(os.path.join(BRAND, 'qmark.svg'), 'w').write(svg)


if __name__ == '__main__':
    write()
