"""Print files for a ring marker: reference PNG, paper PDF, STLs and a two-colour 3MF.

The mesh writers are copied from apps/ar-spike/tools/make_markers.py (kept unchanged there).
"""
import math
import struct
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from .codec import code_of
from .layout import Disc, Rect, Sector, corner_grids, marker_shapes, plaque_side
from .render import render

BASE_MM = 4.0
RAISED_MM = 0.6
DPI = 600
REFERENCE_PX_PER_MM = 10.0
LETTER_MM = (215.9, 279.4)


class Mesh:
    def __init__(self):
        self.verts: list[tuple[float, float, float]] = []
        self.index: dict[tuple[float, float, float], int] = {}
        self.tris: list[tuple[int, int, int]] = []
        self.tag = 0  # vertices are only shared within one tag, so parts that merely touch stay separate shells

    def v(self, p):
        p = tuple(round(c, 4) for c in p)
        key = (p, self.tag)
        if key not in self.index:
            self.index[key] = len(self.verts)
            self.verts.append(p)
        return self.index[key]

    def quad(self, a, b, c, d):  # counter-clockwise seen from outside
        ia, ib, ic, id_ = (self.v(p) for p in (a, b, c, d))
        self.tris += [(ia, ib, ic), (ia, ic, id_)]

    def box(self, x0, y0, x1, y1, z0, z1):
        self.quad((x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1))
        self.quad((x0, y0, z0), (x0, y1, z0), (x1, y1, z0), (x1, y0, z0))
        self.quad((x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1))
        self.quad((x1, y1, z0), (x0, y1, z0), (x0, y1, z1), (x1, y1, z1))
        self.quad((x0, y1, z0), (x0, y0, z0), (x0, y0, z1), (x0, y1, z1))
        self.quad((x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1))

    def grid(self, cells, x0, y0, step, z0, z1):
        """Extrudes dark cells of a boolean grid (row 0 at the top, +y up) as one surface with walls only on edges."""
        n = len(cells)
        dark = lambda gx, gy: 0 <= gx < n and 0 <= gy < n and cells[gy][gx]
        for gy in range(n):
            for gx in range(n):
                if not dark(gx, gy):
                    continue
                xa, xb = x0 + gx * step, x0 + (gx + 1) * step
                ya, yb = y0 - (gy + 1) * step, y0 - gy * step
                self.quad((xa, ya, z1), (xb, ya, z1), (xb, yb, z1), (xa, yb, z1))
                self.quad((xa, ya, z0), (xa, yb, z0), (xb, yb, z0), (xb, ya, z0))
                if not dark(gx, gy + 1):  # below in the image = -y
                    self.quad((xa, ya, z0), (xb, ya, z0), (xb, ya, z1), (xa, ya, z1))
                if not dark(gx, gy - 1):
                    self.quad((xb, yb, z0), (xa, yb, z0), (xa, yb, z1), (xb, yb, z1))
                if not dark(gx - 1, gy):
                    self.quad((xa, yb, z0), (xa, ya, z0), (xa, ya, z1), (xa, yb, z1))
                if not dark(gx + 1, gy):
                    self.quad((xb, ya, z0), (xb, yb, z0), (xb, yb, z1), (xb, ya, z1))

    def tri(self, a, b, c):
        self.tris.append((self.v(a), self.v(b), self.v(c)))

    def sector(self, s, z0, z1):
        """Extrudes an annular sector (angles clockwise from +y) as a strip; a 360 degree span closes into a ring."""
        full = s.a1 - s.a0 >= 360 - 1e-9
        n = max(1, math.ceil((s.a1 - s.a0) / 2.0 - 1e-9))
        p = lambda r, i, z: (r * math.sin(math.radians(s.a0 + (s.a1 - s.a0) * i / n)), r * math.cos(math.radians(s.a0 + (s.a1 - s.a0) * i / n)), z)
        for i in range(n):
            j = i + 1
            self.quad(p(s.r0, i, z1), p(s.r0, j, z1), p(s.r1, j, z1), p(s.r1, i, z1))  # top
            self.quad(p(s.r0, j, z0), p(s.r0, i, z0), p(s.r1, i, z0), p(s.r1, j, z0))  # bottom
            self.quad(p(s.r1, j, z0), p(s.r1, i, z0), p(s.r1, i, z1), p(s.r1, j, z1))  # outer wall
            self.quad(p(s.r0, i, z0), p(s.r0, j, z0), p(s.r0, j, z1), p(s.r0, i, z1))  # inner wall
        if not full:
            self.quad(p(s.r0, n, z0), p(s.r1, n, z0), p(s.r1, n, z1), p(s.r0, n, z1))  # end cap (clockwise side)
            self.quad(p(s.r1, 0, z0), p(s.r0, 0, z0), p(s.r0, 0, z1), p(s.r1, 0, z1))  # start cap

    def disc(self, r, z0, z1):
        n = max(8, math.ceil(360 / 2.0))
        p = lambda i, z: (r * math.sin(2 * math.pi * i / n), r * math.cos(2 * math.pi * i / n), z)
        for i in range(n):
            j = i + 1
            self.tri((0, 0, z1), p(j, z1), p(i, z1))
            self.tri((0, 0, z0), p(i, z0), p(j, z0))
            self.quad(p(j, z0), p(i, z0), p(i, z1), p(j, z1))


def write_stl(mesh: Mesh, path: Path, name: str) -> None:
    with open(path, "wb") as f:
        f.write(name.encode()[:80].ljust(80, b" "))
        f.write(struct.pack("<I", len(mesh.tris)))
        for a, b, c in mesh.tris:
            pa, pb, pc = mesh.verts[a], mesh.verts[b], mesh.verts[c]
            u = [pb[k] - pa[k] for k in range(3)]
            w = [pc[k] - pa[k] for k in range(3)]
            nrm = (u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0])
            ln = sum(x * x for x in nrm) ** 0.5 or 1
            f.write(struct.pack("<12fH", *(x / ln for x in nrm), *pa, *pb, *pc, 0))


def write_3mf(parts: list[tuple[str, Mesh, str]], path: Path) -> None:
    mats = "".join(f'<base name="{n}" displaycolor="{c}"/>' for n, _, c in parts)
    objs, items = [], []
    for i, (name, m, _) in enumerate(parts):
        vs = "".join(f'<vertex x="{x}" y="{y}" z="{z}"/>' for x, y, z in m.verts)
        ts = "".join(f'<triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in m.tris)
        objs.append(f'<object id="{i + 2}" name="{name}" type="model" pid="1" pindex="{i}"><mesh><vertices>{vs}</vertices><triangles>{ts}</triangles></mesh></object>')
    comps = "".join(f'<component objectid="{i + 2}"/>' for i in range(len(parts)))
    pid = len(parts) + 2
    objs.append(f'<object id="{pid}" name="ARC" type="model"><components>{comps}</components></object>')
    items.append(f'<item objectid="{pid}"/>')
    model = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
        f'<resources><basematerials id="1">{mats}</basematerials>{"".join(objs)}</resources>'
        f'<build>{"".join(items)}</build></model>'
    )
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
        )
        z.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
        )
        z.writestr("3D/3dmodel.model", model)


def _components(cells):
    """Splits a boolean grid into its 4-connected components, each as a grid of the same size."""
    seen, parts = set(), []
    for r in range(len(cells)):
        for c in range(len(cells)):
            if cells[r][c] and (r, c) not in seen:
                stack, comp = [(r, c)], set()
                while stack:
                    y, x = stack.pop()
                    if (y, x) in comp or not (0 <= y < len(cells) and 0 <= x < len(cells)) or not cells[y][x]:
                        continue
                    comp.add((y, x))
                    stack += [(y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)]
                seen |= comp
                parts.append([[(y, x) in comp for x in range(len(cells))] for y in range(len(cells))])
    return parts


def build_meshes(marker_id: int, diameter_mm: float, version: int = 0) -> tuple[Mesh, Mesh]:
    """(base, raised): a light box from z=0 to 4.0 and the dark parts from z=4.0 to 4.6, same origin."""
    half = plaque_side(diameter_mm) / 2
    base = Mesh()
    base.box(-half, -half, half, half, 0, BASE_MM)
    raised = Mesh()
    z0, z1 = BASE_MM, BASE_MM + RAISED_MM
    for s in marker_shapes(marker_id, diameter_mm, version):
        if isinstance(s, Sector):
            raised.sector(s, z0, z1)
        elif isinstance(s, Disc):
            raised.disc(s.r, z0, z1)
    for x0, y_top, step, cells in corner_grids(marker_id, diameter_mm):
        for part in _components(cells):  # squares touching only at a corner become separate shells (manifold mesh)
            raised.tag += 1
            raised.grid(part, x0, y_top, step, z0, z1)
    return base, raised


def _font(size: int):
    for f in ("/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/SFNS.ttf"):
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            pass
    return ImageFont.load_default()


def paper_pdf(marker_id: int, diameter_mm: float, name: str, path: Path) -> None:
    mm = lambda v: round(v / 25.4 * DPI)
    page = Image.new("L", (mm(LETTER_MM[0]), mm(LETTER_MM[1])), 255)
    side = plaque_side(diameter_mm)
    plaque = render(marker_id, diameter_mm, DPI / 25.4)
    left, top = (page.width - plaque.width) // 2, mm(25)
    page.paste(plaque, (left, top))
    d = ImageDraw.Draw(page)
    d.rectangle([left - 1, top - 1, left + plaque.width, top + plaque.height], outline=0, width=2)
    big, small = _font(mm(5)), _font(mm(3.5))
    d.text((mm(15), mm(10)), f"{name}  -  code {code_of(marker_id)}", font=big, fill=0)
    y = top + plaque.height + mm(10)
    d.text((mm(15), y), f"Plaque {side:.0f} mm square, ARC {diameter_mm:.0f} mm. Print at 100% / Actual size (no 'fit to page').", font=small, fill=0)
    d.text((mm(15), y + mm(5)), "The bar below must measure 100 mm; if it doesn't, the ARC is the wrong size.", font=small, fill=0)
    bar_y = y + mm(14)
    d.rectangle([mm(15), bar_y, mm(15) + mm(100) - 1, bar_y + mm(3)], fill=0)
    for t in range(0, 101, 10):
        d.rectangle([mm(15) + round(t / 25.4 * DPI) - (2 if t else 0), bar_y - mm(2), mm(15) + round(t / 25.4 * DPI) + 1, bar_y], fill=0)
    d.text((mm(118), bar_y - mm(1)), "100 mm", font=small, fill=0)
    d.text((mm(15), bar_y + mm(8)), f"{name}   {code_of(marker_id)}   virvi.io/s/{code_of(marker_id)}", font=small, fill=0)
    page.convert("1", dither=Image.NONE).save(path, "PDF", resolution=DPI)  # 1-bit: lossless (CCITT/flate), no JPEG


def write_print_files(marker_id: int, diameter_mm: float, out_dir: Path, name: str) -> list[Path]:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    ref, pdf = out_dir / f"{name}-reference.png", out_dir / f"{name}-paper.pdf"
    base_p, raised_p, mf = out_dir / f"{name}-base.stl", out_dir / f"{name}-raised.stl", out_dir / f"{name}.3mf"
    render(marker_id, diameter_mm, REFERENCE_PX_PER_MM).save(ref)
    paper_pdf(marker_id, diameter_mm, name, pdf)
    base, raised = build_meshes(marker_id, diameter_mm)
    write_stl(base, base_p, f"Virvi ARC {name} base")
    write_stl(raised, raised_p, f"Virvi ARC {name} raised")
    write_3mf([("base (light)", base, "#F2F2F2"), ("raised (dark)", raised, "#1A1A1A")], mf)
    return [ref, pdf, base_p, raised_p, mf]
