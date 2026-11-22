"""Raster rendering of the plaque face.

The image is round(plaque_side * px_per_mm) pixels square. The marker centre is at the exact image centre
(W/2, W/2 in continuous pixel coordinates, where pixel (i, j) covers [i, i+1) x [j, j+1)); scale is px_per_mm.
`inverted` draws the same layout light-on-dark: the plaque DARK and every mark (finder, code cells, dot, corner
marks) LIGHT.
"""
import math

from PIL import Image, ImageDraw

from .layout import Disc, Rect, Sector, marker_shapes, plaque_side

DARK, LIGHT = 30, 225
SUPERSAMPLE = 4


def _arc(r: float, a0: float, a1: float):
    n = max(2, math.ceil((a1 - a0) / 1.0))
    for i in range(n + 1):
        a = math.radians(a0 + (a1 - a0) * i / n)
        yield r * math.sin(a), r * math.cos(a)


def render(marker_id: int, diameter_mm: float, px_per_mm: float, version: int = 0,
           inverted: bool = False) -> Image.Image:
    w = round(plaque_side(diameter_mm) * px_per_mm)
    ss = SUPERSAMPLE
    ground, ink = (DARK, LIGHT) if inverted else (LIGHT, DARK)
    big = Image.new("L", (w * ss, w * ss), ground)
    d = ImageDraw.Draw(big)
    k = px_per_mm * ss
    c = w * ss / 2

    def pt(p):
        return c + p[0] * k, c - p[1] * k

    for s in marker_shapes(marker_id, diameter_mm, version):
        if isinstance(s, Disc):
            d.ellipse([c - s.r * k, c - s.r * k, c + s.r * k, c + s.r * k], fill=ink)
        elif isinstance(s, Rect):
            x0, y0 = pt((s.x0, s.y1))
            x1, y1 = pt((s.x1, s.y0))
            d.rectangle([x0, y0, x1 - 1e-6, y1 - 1e-6], fill=ink)
        else:
            pts = list(_arc(s.r1, s.a0, s.a1)) + list(_arc(s.r0, s.a0, s.a1))[::-1]
            d.polygon([pt(p) for p in pts], fill=ink)
    return big.resize((w, w), Image.BOX)
