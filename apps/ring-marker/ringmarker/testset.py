"""Synthetic test set: pinhole-camera views of rendered plaques, decoys and damage, with exact ground truth.

Usage: python3 -m ringmarker.testset <out_dir>

Conventions in the manifest:
  center_px     projected marker centre (dot centre) in continuous image coordinates (pixel (i, j) covers
                [i, i+1) x [j, j+1); the principal point is (640, 480)), computed with the same homography as the warp.
  rotation_deg  in-plane rotation, clockwise as seen in the image: angle of the finder gap's centre clockwise from
                image-up, in [0, 360).
  angle_deg     the plaque is turned about the vertical axis by this much (rotation is applied in the plaque's plane first).

Case "inverted" (names "inverted-..."): light-on-dark plaques (render(..., inverted=True)) mirroring a spread of the
normal cases, plus a light-on-dark decoy.
"""
import json
import math
import sys
import zlib
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw

from .codec import TEST_MARKERS
from .layout import RING_RADII, finder_radii, plaque_side
from .render import DARK, LIGHT, render

FOCAL_PX = 867.0
IMAGE = (1280, 960)
MIN_PPM, MAX_PPM = 0.6, 6.0


def _seed(name: str) -> int:
    return zlib.crc32(name.encode())


def _ppm(distance_m: float) -> float:
    """Plaque raster density: 2x the projected density (px per mm) so the warp sets the detail."""
    return min(MAX_PPM, max(MIN_PPM, 2.0 * FOCAL_PX / (distance_m * 1000.0)))


def _homography(side_mm, w_px, distance_m, angle_deg, rotation_deg, x_mm=0.0):
    """Homography from raster coordinates (cv convention, pixel centres at integers) to image coordinates (same)."""
    k = w_px / side_mm
    th, ph = math.radians(rotation_deg), math.radians(angle_deg)
    d = distance_m * 1000.0
    src, dst = [], []
    for sx, sy in [(0, 0), (w_px, 0), (w_px, w_px), (0, w_px)]:  # continuous raster coords
        x, y = (sx - w_px / 2) / k, -(sy - w_px / 2) / k  # plaque mm, +y up
        xr, yr = x * math.cos(th) + y * math.sin(th), -x * math.sin(th) + y * math.cos(th)  # clockwise by th
        X, Y, Z = xr * math.cos(ph) + x_mm, yr, d + xr * math.sin(ph)
        src.append((sx - 0.5, sy - 0.5))
        dst.append((IMAGE[0] / 2 + FOCAL_PX * X / Z - 0.5, IMAGE[1] / 2 - FOCAL_PX * Y / Z - 0.5))
    H = cv2.getPerspectiveTransform(np.float32(src), np.float32(dst))
    c = H @ np.array([w_px / 2 - 0.5, w_px / 2 - 0.5, 1.0])
    return H, ((c[0] / c[2]) + 0.5, (c[1] / c[2]) + 0.5)


def _background(rng):
    n = rng.standard_normal((IMAGE[1], IMAGE[0])).astype(np.float32)
    n = cv2.GaussianBlur(n, (0, 0), 6.0)
    n = (n - n.mean()) / n.std()
    return 140.0 + 25.0 * n


def _finish(img, rng):
    img = cv2.GaussianBlur(img, (0, 0), 1.0)
    img = img + rng.normal(0, 4.0, img.shape).astype(np.float32)
    return np.clip(np.rint(img), 0, 255).astype(np.uint8)


class Plaque:
    """A raster plus its placement; `rotation` is clockwise in the plaque plane."""

    def __init__(self, image, diameter_mm, distance_m, angle_deg=0.0, rotation_deg=0.0, x_mm=0.0):
        self.image, self.diameter_mm = image, diameter_mm
        self.distance_m, self.angle_deg, self.rotation_deg, self.x_mm = distance_m, angle_deg, rotation_deg, x_mm


def compose(name, plaques):
    rng = np.random.default_rng(_seed(name))
    img = _background(rng)
    centers = []
    for p in plaques:
        w = p.image.size[0]
        H, c = _homography(plaque_side(p.diameter_mm), w, p.distance_m, p.angle_deg, p.rotation_deg, p.x_mm)
        src = np.asarray(p.image, dtype=np.float32)
        warped = cv2.warpPerspective(src, H, IMAGE, flags=cv2.INTER_LINEAR)
        mask = cv2.warpPerspective(np.ones_like(src), H, IMAGE, flags=cv2.INTER_LINEAR)
        img = img * (1 - mask) + warped * mask
        centers.append(c)
    return _finish(img, rng), centers


# ---- damage / decoy drawing, in plaque coordinates (mm, +y up, angles clockwise from top) ----

def _canvas(image):
    w = image.size[0]
    return ImageDraw.Draw(image), w, w / 2


def _sector(image, px_per_mm, r0, r1, a0, a1, fill):
    d, w, c = _canvas(image)
    pts = []
    n = max(2, int(abs(a1 - a0)))
    for r, seq in ((r1, range(n + 1)), (r0, range(n, -1, -1))):
        for i in seq:
            a = math.radians(a0 + (a1 - a0) * i / n)
            pts.append((c + r * math.sin(a) * px_per_mm, c - r * math.cos(a) * px_per_mm))
    d.polygon(pts, fill=fill)


def _darken(image, px_per_mm, r0, r1, a0, a1, factor):
    mask = Image.new("L", image.size, 0)
    _sector(mask, px_per_mm, r0, r1, a0, a1, 255)
    arr = np.asarray(image, dtype=np.float32)
    m = np.asarray(mask, dtype=np.float32) / 255.0
    return Image.fromarray(np.clip(arr * (1 - m * (1 - factor)), 0, 255).astype(np.uint8))


def _disc(image, px_per_mm, r, fill, cx=0.0, cy=0.0):
    d, w, c = _canvas(image)
    x, y = c + cx * px_per_mm, c - cy * px_per_mm
    d.ellipse([x - r * px_per_mm, y - r * px_per_mm, x + r * px_per_mm, y + r * px_per_mm], fill=fill)


def _plain_plaque(diameter_mm, ppm, fill=LIGHT):
    w = round(plaque_side(diameter_mm) * ppm)
    return Image.new("L", (w, w), fill)


def generate(out_dir) -> list[dict]:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    manifest: list[dict] = []

    def emit(name, case, plaques, expect, markers_meta):
        img, centers = compose(name, plaques)
        Image.fromarray(img).save(out / f"{name}.png")
        markers = [
            {"id": mid, "center_px": [round(centers[i][0], 3), round(centers[i][1], 3)],
             "rotation_deg": rot % 360, "distance_m": dist, "angle_deg": ang, "diameter_mm": dia}
            for (i, (mid, dist, ang, rot, dia)) in enumerate(markers_meta)
        ]
        manifest.append({"file": f"{name}.png", "name": name, "case": case, "markers": markers, "expect": expect,
                         "focal_px": FOCAL_PX})

    def marker_case(name, case, label, d, angle=0.0, rot=0.0, damage=None, expect="ids", inverted=False):
        mid, dia = TEST_MARKERS[label]
        ppm = _ppm(d)
        im = render(mid, dia, ppm, inverted=inverted)
        if damage:
            im = damage(im, ppm, dia)
        emit(name, case, [Plaque(im, dia, d, angle, rot)], expect, [(mid, d, angle, rot, dia)])

    for label in TEST_MARKERS:
        for d in (0.6, 1.2, 1.8):
            for a in (0, 30, 45):
                marker_case(f"range-{label}-{d}-{a}", "range", label, d, a)
    marker_case("rotated_73", "rotated_73", "RING140", 1.2, rot=73)
    marker_case("rotated_180", "rotated_180", "RING140", 1.2, rot=180)

    def glare(im, ppm, dia, cell=6):  # one cell-sized white blob over the code rings (ring 1, `cell`)
        s = dia / 140.0
        r = 0.5 * (RING_RADII(dia)[1][0] + RING_RADII(dia)[1][1])
        a = math.radians(cell * 15 + 7.5)
        big = im.copy()
        _disc(big, ppm, 6.0 * s, 255, r * math.sin(a), r * math.cos(a))
        return big

    def wedge(im, ppm, dia):  # 40 degree sector darkened by 35%
        s = dia / 140.0
        return _darken(im, ppm, 25 * s, 75 * s, 200, 240, 0.65)

    def heavy(im, ppm, dia):  # light patch over 120 degrees of all three code rings
        r0, r1 = RING_RADII(dia)[2][0], RING_RADII(dia)[0][1]
        im = im.copy()
        _sector(im, ppm, r0 - 1.0 * dia / 140, r1 + 1.0 * dia / 140, 40, 160, LIGHT)
        return im

    marker_case("glare", "glare", "RING140", 1.2, damage=glare)
    marker_case("shadow_wedge", "shadow_wedge", "RING140", 1.2, damage=wedge)
    marker_case("heavy_damage", "heavy_damage", "RING140", 1.2, damage=heavy, expect="none")

    # two markers side by side
    (id_a, dia_a), (id_b, dia_b) = TEST_MARKERS["RING120"], TEST_MARKERS["RING170"]
    ppm = _ppm(1.2)
    emit("two_markers", "two_markers",
         [Plaque(render(id_a, dia_a, ppm), dia_a, 1.2, x_mm=-120.0), Plaque(render(id_b, dia_b, ppm), dia_b, 1.2, x_mm=120.0)],
         "ids", [(id_a, 1.2, 0.0, 0.0, dia_a), (id_b, 1.2, 0.0, 0.0, dia_b)])

    # decoys: round things that are not markers, at 1.2 m
    ppm, dia = _ppm(1.2), 140.0

    def decoy(name, draw):
        im = _plain_plaque(dia, ppm)
        draw(im)
        emit(name, "decoys", [Plaque(im, dia, 1.2)], "none", [])

    def plate(im):
        _disc(im, ppm, 70, DARK)
        _disc(im, ppm, 65, LIGHT)

    def clock(im):
        _disc(im, ppm, 70, DARK)
        _disc(im, ppm, 66, LIGHT)
        for h in range(12):
            _sector(im, ppm, 52, 63, h * 30 - 2.5, h * 30 + 2.5, DARK)

    def disc_in_ring(im):
        f0, f1 = finder_radii(dia)
        _disc(im, ppm, f1, DARK)
        _disc(im, ppm, f0, LIGHT)
        _disc(im, ppm, 12, DARK)

    decoy("decoy_plate", plate)
    decoy("decoy_clock", clock)
    decoy("decoy_disc_in_ring", disc_in_ring)
    emit("decoy_plain", "decoys", [], "none", [])

    marker_case("too_far", "too_far", "RING120", 4.0, expect="none")

    # light-on-dark plaques: each test marker head-on at 1.2 m, steep, rotated, far and small, glare, one beside a
    # dark-on-light marker; and a decoy
    for label in TEST_MARKERS:
        marker_case(f"inverted-{label}-1.2-0", "inverted", label, 1.2, inverted=True)
    marker_case("inverted-RING140-1.2-45", "inverted", "RING140", 1.2, 45, inverted=True)
    marker_case("inverted-rotated_73", "inverted", "RING140", 1.2, rot=73, inverted=True)
    marker_case("inverted-RING120-1.8-30", "inverted", "RING120", 1.8, 30, inverted=True)
    # on a light-on-dark ARC the glare must land on an "off" (dark) cell to do harm: RING140's ring 1 cell 7
    marker_case("inverted-glare", "inverted", "RING140", 1.2, damage=lambda im, ppm, dia: glare(im, ppm, dia, cell=7),
                inverted=True)
    ppm = _ppm(1.2)
    emit("inverted-two_markers", "inverted",
         [Plaque(render(id_a, dia_a, ppm), dia_a, 1.2, x_mm=-120.0),
          Plaque(render(id_b, dia_b, ppm, inverted=True), dia_b, 1.2, x_mm=120.0)],
         "ids", [(id_a, 1.2, 0.0, 0.0, dia_a), (id_b, 1.2, 0.0, 0.0, dia_b)])
    ppm, dia = _ppm(1.2), 140.0

    def inverted_disc_in_ring(im):  # a light disc inside a light ring on dark, no code
        f0, f1 = finder_radii(dia)
        _disc(im, ppm, f1, LIGHT)
        _disc(im, ppm, f0, DARK)
        _disc(im, ppm, 12, LIGHT)

    im = _plain_plaque(dia, ppm, DARK)
    inverted_disc_in_ring(im)
    emit("inverted-decoy_disc_in_ring", "inverted", [Plaque(im, dia, 1.2)], "none", [])

    (out / "manifest.json").write_text(json.dumps(manifest, indent=1))
    return manifest


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: python3 -m ringmarker.testset <out_dir>")
    m = generate(sys.argv[1])
    print(f"wrote {len(m)} images to {sys.argv[1]}")
