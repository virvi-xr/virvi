"""Reference ring-marker detector. The Kotlin and Swift ports copy this step for step.

It reads both polarities: dark marks on a light plaque (the normal pass) and light marks on a dark plaque (the
inverted pass, step 9). Steps 1-8 describe the normal pass.

Coordinates. Internally a pixel (i, j) (column i, row j) sits at (x, y) = (i, j); x right, y down. Outputs
(`center_px`, the ellipse centre) are in the test-set manifest's continuous convention, where pixel (i, j) covers
[i, i+1) x [j, j+1), so they are the internal values + 0.5. Marker angles are degrees clockwise from the top of the
marker; 1 "ref mm" is a millimetre at the 140 mm reference size (layout.py), so normalised radii are r / 70.

1. Threshold. Integral image of the grey image; for each pixel the window is `win` x `win` centred on it, clipped
   to the image, with n pixels and sum S. The pixel is DARK if v*n < S - 7n and LIGHT if v*n > S + 7n, otherwise
   undecided. `win = max(51, W // 25) | 1` (51 at 1280 wide) -- see Tuning. Blobs (step 2) use DARK only; ray
   edges (step 4) and the gap (step 5) use DARK / LIGHT / undecided.
2. Label blobs: 8-connected components of DARK (cv2.connectedComponentsWithStats; the port uses union-find).
   Blobs are then ordered by the raster index (y * W + x) of their first pixel in row-major scan, independent of
   the labelling algorithm; this order is the tie-break in step 8.
3. Dot candidates. Blobs with n >= 30 pixels. Moments over the blob's pixel coordinates: mean (mx, my) and
   population covariance cxx, cyy, cxy (divide by n). Eigenvalues l1 >= l2 = (cxx+cyy)/2 +- sqrt((cxx-cyy)^2/4 +
   cxy^2); semi-axes a = 2 sqrt(l1), b = 2 sqrt(l2) (a filled ellipse has variance a^2/4 along its axis); angle
   phi = atan2(2 cxy, cxx - cyy) / 2. Keep if 0.85 <= n / (pi a b) <= 1.15 and b / a >= 0.5.
4. Finder ring.
   - Frame. A frame maps (rho, beta) -- normalised radius, angle clockwise from the marker top -- to the image:
     q = rho (sin beta, -cos beta); w = Minv q; p = c + w / (1 + l.w). c is the dot centre (mx, my) throughout.
     The dot frame is affine: Minv = (70/12) R(phi) diag(a, b) R(phi)^T, l = 0, so rho = 1 is the finder's
     predicted outer edge (70/12 dot radii) and rho = 62/70 its inner edge.
   - Rays. 90 rays, beta_i = 4 i degrees. Along each, n = ceil((rho1 - rho0) * 70/12 * a / 0.5) + 1 evenly spaced
     rho from rho0 = 0.8 * 62/70 to rho1 = 1.2 (the +-20% search), each read from the masks at the nearest pixel
     (floor(x + 0.5), floor(y + 0.5); off-image counts as undecided). Drop the undecided samples; the edge is the
     last DARK sample directly followed by a LIGHT one, at rho_e = (rho_dark + rho_light) / 2, and the edge point is
     frame(rho_e, beta_i) - c. A ray with no such pair has no edge.
   - Conic. With fewer than 60 edges, reject. Scale the points by 1/L (L = RMS distance of the points from c),
     solve the 5x5 normal equations (M^T M) x = M^T 1 for u^2, uv, v^2, u, v by Gaussian elimination with
     partial pivoting -- if a pivot's magnitude is below 1e-9 the matrix is singular and the candidate is rejected
     (no exception) -- then A = A'/L^2, B = B'/L^2, C = C'/L^2,
     D = D'/L, E = E'/L: A x^2 + B xy + C y^2 + D x + E y = 1 with (x, y) relative to c. It is an ellipse iff
     A > 0 and 4AC - B^2 > 0.
   - Fitted frame (the projective map of the unit circle onto the fitted ellipse that keeps c fixed):
     l = (D/2, E/2), P = [[A, B/2], [B/2, C]] + l l^T, P = V diag(w1, w2) V^T; reject if min w <= 0;
     Minv = V diag(1/sqrt(w1), 1/sqrt(w2)) V^T. It is exact for a planar circle seen in perspective whose centre
     images to c (any other such map differs by a rotation, which the gap fixes). The inverse is
     rho(d) = |M d| / |1 - l.d| for a point d relative to c, with M = Minv^-1.
   - Trim, 3 passes. Each pass: rho_k = rho(edge_k) for ALL the edges under the current frame; keep the edges with
     |rho_k / median(rho) - 1| <= 0.10 (median of an even count = mean of the middle two); with fewer than 60 kept,
     reject; refit the conic and the frame from the kept edges (same rejections). The final frame is used below.
   - `ellipse` from the final conic: Q = [[A, B/2], [B/2, C]], centre x0 = -1/2 Q^-1 (D, E) (relative to c),
     kappa = 1 + x0^T Q x0, Q = V diag(w1, w2) V^T with w1 <= w2; semi-major = sqrt(kappa / w1), semi-minor =
     sqrt(kappa / w2); angle = atan2(v1y, v1x) in degrees mod 180 for the eigenvector v1 of w1 (from +x toward +y,
     image y down); centre reported as c + x0 + 0.5.
5. Gap. 720 samples at rho = 66/70, beta_j = 0.5 j degrees, read nearest-pixel from the masks and bilinearly from
   the grey image (step 6). Reject if no sample is LIGHT, if every sample is LIGHT (no ring at all), or if no sample
   is DARK. Circular runs of LIGHT samples, scanning from the first non-LIGHT sample: the longest
   (the first one found, on a tie) must be 10-22 degrees (count * 0.5) and every other run must be <= 4 degrees.
   Gap centre beta_g = (start + (count - 1) / 2) * 0.5 degrees, and with (gx, gy) = frame(66/70, beta_g),
   rotation_deg = atan2(gx - cx, -(gy - cy)) in degrees, normalised to [0, 360).
6. Cells. dark = mean grey of the DARK gap-ring samples, light = mean grey of the gap run's samples; reject if
   light - dark < 14 (2 x the threshold offset). Ring i (CODE_RINGS_REF, 0 outermost) has mid radius m = (r0 + r1) / 2;
   cell k is centred at mu = beta_g + 15 k + 7.5. v = mean of 5 bilinear samples at (m/70, mu), (m/70, mu - 3),
   (m/70, mu + 3), ((m - 1)/70, mu), ((m + 1)/70, mu). If any of the 5 sample points lies outside
   [0, W - 1] x [0, H - 1] (or is NaN / infinite), the cell can't be judged and is erased (None) without reading it. Bilinear: clamp x to [0, W - 1 - 1e-6] (y likewise),
   x0 = floor(x), fx = x - x0, the usual 4-pixel blend. t = (v - dark) / (light - dark): on if t < 0.4, off if
   t > 0.6, else erased (None). Cell index = ring * 24 + k.
7. Decode with codec.decode; drop the candidate unless it decodes.
8. Duplicates. Sort the detections by (`corrected`, first-pixel raster index from step 2) and keep one unless its
   centre is within 0.5 sqrt(a b) of an already kept detection, sqrt(a b) being that kept detection's dot radius.
9. Polarity. Steps 2-8 run twice on the masks of step 1: the normal pass as above (dark marks on a light plaque),
   then the inverted pass (light marks on a dark plaque), which is exactly the normal pass on the negative image
   v' = 255 - v. The negative needs no new threshold: its window sum is S' = 255n - S, so
   v'n < S' - 7n  <=>  255n - vn < 255n - S - 7n  <=>  vn > S + 7n, i.e. DARK of the negative is LIGHT of the image,
   and likewise LIGHT of the negative is DARK (the offset is symmetric; integer arithmetic, so exact). The inverted
   pass therefore uses (LIGHT, DARK) wherever the normal pass uses (DARK, LIGHT) -- blobs in step 2, ray edges in
   step 4, the gap in step 5 -- and reads every grey value as 255 - v (bilinear in steps 5-6, applied to the
   sampled value; the frame is not copied). Its detections carry `inverted = True`.
   Merge: all the normal pass's detections in their step-8 order, then each inverted-pass detection (in its step-8
   order) unless a normal-pass detection has the same id and a centre closer than the smaller of the two finder
   radii (the `ellipse` semi-majors); the normal pass's detection is kept. (The ports' unreadable rings -- a dot
   and finder found in step 4 but no decode -- are collected from both passes; one is dropped if its centre lies
   within the finder radius of any merged detection, or within half its own dot radius of an unreadable ring
   already kept.)

Tuning (brief step 3), in the brief's order:
- Threshold window: changed from max(15, W // 40) | 1 to max(51, W // 25) | 1. With 15 px, the noise-free
  test_clean_render (300 px image, dot 48 px across) thresholds the dot's uniform interior as not dark, so the
  blob is a hollow ring and fails the fill check. The window must exceed the dot's diameter at the closest range;
  51 px covers the clean render and the test set's largest dot (RING170 at 0.6 m, ~37 px). Every test-set image
  passes for any window from 33 to 129.
- Edge search +-20%: unchanged.
- t thresholds 0.4 / 0.6: unchanged.
Implementation choices beyond the brief's wording (needed at every range, not only 1.8 m):
- Three-level threshold (LIGHT needs v > mean + 7). With "light = not dark", the flat background just outside the
  plaque (which sits inside the +-20% search, only 7% past the finder edge) flickers between dark and not-dark in
  the noise and gives spurious "outermost" transitions; demanding a real LIGHT sample removes them.
- Trimmed refits (10% of the median radius, 3 passes) remove the remaining stray edges (the gap's rays,
  background). One pass is enough for the test set; a marker cut by the image border needs 3 (a cluster of inner
  edges on the cut side drags the first fit, and the frame was then up to 11 px off; with 3 passes <= 0.5 px).
- Rays that leave the image are kept; off-image samples are undecided, and so are non-finite ones (NaN or
  infinite coordinates, as from a degenerate frame). Cells with any sample off the image are
  erasures (step 6).
- Rejections: a singular normal matrix (step 4), an all-LIGHT / no-LIGHT / no-DARK gap ring (step 5) and
  light - dark < 14 (step 6) reject the candidate; nothing raises.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import cv2
import numpy as np

from .codec import decode
from .layout import CELL_DEG, CODE_RINGS_REF, DOT_REF, FINDER_REF, PER_RING

OFFSET = 7
MIN_AREA = 30
FILL_RANGE = (0.85, 1.15)
MIN_AXIS_RATIO = 0.5
RAYS = 90
MIN_EDGE_RAYS = 60
EDGE_SLACK = 0.20
TRIM = 0.10
TRIM_PASSES = 3
GAP_RHO = 66.0 / 70.0
GAP_STEP_DEG = 0.5
GAP_DEG = (10.0, 22.0)
OTHER_LIGHT_MAX_DEG = 4.0
T_ON, T_OFF = 0.4, 0.6
CELL_DELTA_DEG = 3.0
CELL_DELTA_MM = 1.0
MIN_CONTRAST = 2 * OFFSET
PIVOT_EPS = 1e-9


@dataclass
class Detection:
    marker_id: int
    version: int
    corrected: int
    center_px: tuple[float, float]
    ellipse: tuple[float, float, float, float, float]  # finder outer edge: cx, cy, semi-major, semi-minor, angle deg
    rotation_deg: float
    inverted: bool = False  # found by the inverted pass (step 9): light marks on a dark plaque


def window_size(width: int) -> int:
    return max(51, width // 25) | 1


# ---- 1. threshold ----------------------------------------------------------------------------------------------

def threshold(gray: np.ndarray, win: int) -> tuple[np.ndarray, np.ndarray]:
    """(DARK, LIGHT) masks as uint8 0/1."""
    h, w = gray.shape
    g = gray.astype(np.int64)
    ii = np.zeros((h + 1, w + 1), np.int64)
    ii[1:, 1:] = g.cumsum(0).cumsum(1)
    r = win // 2
    ys, xs = np.arange(h), np.arange(w)
    y0, y1 = np.clip(ys - r, 0, h), np.clip(ys + r + 1, 0, h)
    x0, x1 = np.clip(xs - r, 0, w), np.clip(xs + r + 1, 0, w)
    s = ii[y1][:, x1] - ii[y0][:, x1] - ii[y1][:, x0] + ii[y0][:, x0]
    n = (y1 - y0)[:, None] * (x1 - x0)[None, :]
    dark = (g * n < s - OFFSET * n).astype(np.uint8)
    light = (g * n > s + OFFSET * n).astype(np.uint8)
    return dark, light


# ---- 2, 3. blobs and dot candidates ----------------------------------------------------------------------------

def dot_candidates(dark: np.ndarray, with_order: bool = False):
    """(mx, my, a, b, phi) for every blob that passes the dot test, ordered by the raster index (y * W + x) of
    each blob's first pixel, so the order does not depend on the labelling algorithm. With `with_order`, items are
    (first_pixel_index, dot)."""
    n, labels, _, _ = cv2.connectedComponentsWithStats(dark, connectivity=8)
    h, w = dark.shape
    lab = labels.ravel()
    yy, xx = np.indices((h, w))
    x, y = xx.ravel().astype(np.float64), yy.ravel().astype(np.float64)
    cnt = np.bincount(lab, minlength=n).astype(np.float64)
    first = np.full(n, lab.size, np.int64)
    np.minimum.at(first, lab, np.arange(lab.size))
    sx, sy = np.bincount(lab, x, n), np.bincount(lab, y, n)
    sxx, syy, sxy = np.bincount(lab, x * x, n), np.bincount(lab, y * y, n), np.bincount(lab, x * y, n)
    out = []
    for i in range(1, n):
        area = cnt[i]
        if area < MIN_AREA:
            continue
        mx, my = sx[i] / area, sy[i] / area
        cxx = sxx[i] / area - mx * mx
        cyy = syy[i] / area - my * my
        cxy = sxy[i] / area - mx * my
        half = (cxx + cyy) / 2
        root = math.sqrt(max(0.0, (cxx - cyy) ** 2 / 4 + cxy * cxy))
        l1, l2 = half + root, half - root
        if l2 <= 0:
            continue
        a, b = 2 * math.sqrt(l1), 2 * math.sqrt(l2)
        fill = area / (math.pi * a * b)
        if not (FILL_RANGE[0] <= fill <= FILL_RANGE[1]) or b / a < MIN_AXIS_RATIO:
            continue
        out.append((int(first[i]), (mx, my, a, b, 0.5 * math.atan2(2 * cxy, cxx - cyy))))
    out.sort(key=lambda o: o[0])
    return out if with_order else [d for _, d in out]


# ---- sampling --------------------------------------------------------------------------------------------------

def _nearest(mask: np.ndarray, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    """Mask value at the nearest pixel; 0 off the image (non-finite coordinates are off the image)."""
    h, w = mask.shape
    finite = np.isfinite(xs) & np.isfinite(ys)
    xs, ys = np.where(finite, xs, -1.0), np.where(finite, ys, -1.0)
    xi, yi = np.floor(xs + 0.5).astype(np.int64), np.floor(ys + 0.5).astype(np.int64)
    inside = finite & (xi >= 0) & (xi < w) & (yi >= 0) & (yi < h)
    out = np.zeros(xs.shape, np.int8)
    out[inside] = mask[yi[inside], xi[inside]]
    return out


def _inside(xs: np.ndarray, ys: np.ndarray, w: int, h: int) -> np.ndarray:
    """Sample points within [0, W - 1] x [0, H - 1]; non-finite coordinates are outside."""
    return np.isfinite(xs) & np.isfinite(ys) & (xs >= 0) & (xs <= w - 1) & (ys >= 0) & (ys <= h - 1)


def _grey(gray: np.ndarray, xs: np.ndarray, ys: np.ndarray, inverted: bool) -> np.ndarray:
    """Bilinear grey value, read as 255 - v in the inverted pass (step 9)."""
    v = _bilinear(gray, xs, ys)
    return 255.0 - v if inverted else v


def _bilinear(gray: np.ndarray, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    h, w = gray.shape
    xs = np.clip(xs, 0, w - 1 - 1e-6)
    ys = np.clip(ys, 0, h - 1 - 1e-6)
    x0, y0 = np.floor(xs).astype(np.int64), np.floor(ys).astype(np.int64)
    fx, fy = xs - x0, ys - y0
    g = gray.astype(np.float64)
    top = g[y0, x0] * (1 - fx) + g[y0, x0 + 1] * fx
    bottom = g[y0 + 1, x0] * (1 - fx) + g[y0 + 1, x0 + 1] * fx
    return top * (1 - fy) + bottom * fy


# ---- 4. finder ring --------------------------------------------------------------------------------------------

class Frame:
    """(rho, beta) -> image: q = rho (sin beta, -cos beta); w = Minv q; p = c + w / (1 + l.w)."""

    def __init__(self, cx: float, cy: float, minv: np.ndarray, l: tuple[float, float]):
        self.cx, self.cy = cx, cy
        self.minv = np.asarray(minv, float)
        self.l = np.asarray(l, float)

    @staticmethod
    def from_dot(dot) -> "Frame":
        cx, cy, a, b, phi = dot
        rot = np.array([[math.cos(phi), -math.sin(phi)], [math.sin(phi), math.cos(phi)]])
        k = FINDER_REF[1] / DOT_REF
        return Frame(cx, cy, k * rot @ np.diag([a, b]) @ rot.T, (0.0, 0.0))

    @staticmethod
    def from_conic(conic, cx: float, cy: float) -> "Frame | None":
        if conic is None:
            return None
        A, B, C, D, E = conic
        if A <= 0 or 4 * A * C - B * B <= 0:
            return None
        lx, ly = D / 2, E / 2
        p = np.array([[A + lx * lx, B / 2 + lx * ly], [B / 2 + lx * ly, C + ly * ly]])
        w, v = np.linalg.eigh(p)
        if w[0] <= 0:
            return None
        return Frame(cx, cy, v @ np.diag(1 / np.sqrt(w)) @ v.T, (lx, ly))

    def to_image(self, rho, beta_deg):
        rho, b = np.broadcast_arrays(np.asarray(rho, float), np.radians(beta_deg))
        qx, qy = rho * np.sin(b), -rho * np.cos(b)
        wx = self.minv[0, 0] * qx + self.minv[0, 1] * qy
        wy = self.minv[1, 0] * qx + self.minv[1, 1] * qy
        den = 1 + self.l[0] * wx + self.l[1] * wy
        return self.cx + wx / den, self.cy + wy / den

    def radius_of(self, pts: np.ndarray) -> np.ndarray:
        """Normalised radius of points given relative to c: |M d| / |1 - l.d|."""
        q = pts @ np.linalg.inv(self.minv).T
        return np.hypot(q[:, 0], q[:, 1]) / np.abs(1 - pts @ self.l)


def ray_edges(masks, dot) -> np.ndarray:
    """Edge points (relative to the dot centre), one per ray that has an edge."""
    dark, light = masks
    fr = Frame.from_dot(dot)
    rho0, rho1 = (1 - EDGE_SLACK) * FINDER_REF[0] / FINDER_REF[1], 1 + EDGE_SLACK
    n = int(math.ceil((rho1 - rho0) * FINDER_REF[1] / DOT_REF * dot[2] / 0.5)) + 1
    rho = np.linspace(rho0, rho1, n)
    beta = np.arange(RAYS) * (360.0 / RAYS)
    xs, ys = fr.to_image(rho[None, :], beta[:, None])
    state = _nearest(dark, xs, ys) - _nearest(light, xs, ys)  # 1 DARK, -1 LIGHT, 0 undecided / off-image
    pts = []
    for i in range(RAYS):
        idx = np.nonzero(state[i])[0]
        st = state[i, idx]
        pairs = np.nonzero((st[:-1] == 1) & (st[1:] == -1))[0]
        if len(pairs) == 0:
            continue
        k = pairs[-1]
        ex, ey = fr.to_image(0.5 * (rho[idx[k]] + rho[idx[k + 1]]), beta[i])
        pts.append((float(ex) - fr.cx, float(ey) - fr.cy))
    return np.array(pts, float).reshape(-1, 2)


def fit_conic(pts: np.ndarray) -> tuple[float, float, float, float, float]:
    """Least squares A x^2 + B xy + C y^2 + D x + E y = 1 (normal equations on points scaled by 1/RMS radius)."""
    L = float(np.sqrt((pts ** 2).sum(1).mean()))
    u, v = pts[:, 0] / L, pts[:, 1] / L
    m = np.stack([u * u, u * v, v * v, u, v], 1)
    sol = _solve(m.T @ m, m.sum(0))
    if sol is None:
        return None
    a_, b_, c_, d_, e_ = sol
    return a_ / L ** 2, b_ / L ** 2, c_ / L ** 2, d_ / L, e_ / L


def _solve(a: np.ndarray, b: np.ndarray):
    """Gaussian elimination with partial pivoting; None if a pivot's magnitude is below PIVOT_EPS."""
    n = len(b)
    m = np.hstack([np.asarray(a, float), np.asarray(b, float)[:, None]])
    for c in range(n):
        p = c + int(np.argmax(np.abs(m[c:, c])))
        if abs(m[p, c]) < PIVOT_EPS:
            return None
        m[[c, p]] = m[[p, c]]
        for r in range(c + 1, n):
            m[r, c:] -= (m[r, c] / m[c, c]) * m[c, c:]
    x = np.zeros(n)
    for r in range(n - 1, -1, -1):
        x[r] = (m[r, n] - m[r, r + 1:n] @ x[r + 1:]) / m[r, r]
    return x


def conic_ellipse(conic, cx: float, cy: float) -> tuple[float, float, float, float, float]:
    """Centre (continuous coordinates), semi-major, semi-minor, major-axis angle in degrees [0, 180) from +x toward +y."""
    A, B, C, D, E = conic
    q = np.array([[A, B / 2], [B / 2, C]])
    x0 = -0.5 * np.linalg.solve(q, np.array([D, E]))
    kappa = 1 + x0 @ q @ x0
    w, v = np.linalg.eigh(q)  # w[0] <= w[1]: w[0] belongs to the major axis
    return (float(cx + x0[0] + 0.5), float(cy + x0[1] + 0.5), math.sqrt(kappa / w[0]), math.sqrt(kappa / w[1]),
            math.degrees(math.atan2(v[1, 0], v[0, 0])) % 180.0)


def finder(masks, dot):
    """(frame, conic) of the finder ring's outer edge, or (None, None)."""
    pts = ray_edges(masks, dot)
    if len(pts) < MIN_EDGE_RAYS:
        return None, None
    conic = fit_conic(pts)
    fr = Frame.from_conic(conic, dot[0], dot[1])
    for _ in range(TRIM_PASSES):
        if fr is None:
            return None, None
        rad = fr.radius_of(pts)
        kept = pts[np.abs(rad / np.median(rad) - 1) <= TRIM]
        if len(kept) < MIN_EDGE_RAYS:
            return None, None
        conic = fit_conic(kept)
        fr = Frame.from_conic(conic, dot[0], dot[1])
    return (fr, conic) if fr is not None else (None, None)


# ---- 5. gap ----------------------------------------------------------------------------------------------------

def light_runs(light: np.ndarray) -> list[tuple[int, int]]:
    """Circular runs of True as (start, length), scanning from the first False."""
    n = len(light)
    if light.all():
        return [(0, n)]
    first = int(np.nonzero(~light)[0][0])
    runs, k = [], 0
    while k < n:
        if light[(first + k) % n]:
            j = k
            while j < n and light[(first + j) % n]:
                j += 1
            runs.append(((first + k) % n, j - k))
            k = j
        else:
            k += 1
    return runs


# ---- per candidate ---------------------------------------------------------------------------------------------

def read_cells(gray, masks, dot, inverted=False):
    """Steps 4-6 for one dot: (cells, conic, rotation_deg), or None if the candidate is rejected. `masks` is
    (DARK, LIGHT) as the pass sees them: swapped, with `inverted`, for the inverted pass (step 9)."""
    fr, conic = finder(masks, dot)
    if fr is None:
        return None
    nb = int(round(360 / GAP_STEP_DEG))
    xs, ys = fr.to_image(GAP_RHO, np.arange(nb) * GAP_STEP_DEG)
    is_dark = _nearest(masks[0], xs, ys) == 1
    is_light = _nearest(masks[1], xs, ys) == 1
    if not is_light.any() or is_light.all() or not is_dark.any():
        return None
    runs = light_runs(is_light)
    best = max(range(len(runs)), key=lambda i: runs[i][1])  # first of the longest
    start, length = runs[best]
    if not (GAP_DEG[0] <= length * GAP_STEP_DEG <= GAP_DEG[1]):
        return None
    if any(r[1] * GAP_STEP_DEG > OTHER_LIGHT_MAX_DEG for i, r in enumerate(runs) if i != best):
        return None
    vals = _grey(gray, xs, ys, inverted)
    dark = vals[is_dark].mean()
    light = vals[(start + np.arange(length)) % nb].mean()
    if light - dark < MIN_CONTRAST:
        return None
    beta_g = (start + (length - 1) / 2) * GAP_STEP_DEG
    gx, gy = fr.to_image(GAP_RHO, beta_g)
    rotation = math.degrees(math.atan2(float(gx) - dot[0], -(float(gy) - dot[1]))) % 360.0

    h, w = gray.shape
    cells: list[bool | None] = []
    for r0, r1 in CODE_RINGS_REF:
        m = (r0 + r1) / 2
        rho = np.array([m, m, m, m - CELL_DELTA_MM, m + CELL_DELTA_MM]) / FINDER_REF[1]
        for k in range(PER_RING):
            mu = beta_g + k * CELL_DEG + CELL_DEG / 2
            beta = np.array([mu, mu - CELL_DELTA_DEG, mu + CELL_DELTA_DEG, mu, mu])
            sx, sy = fr.to_image(rho, beta)
            if not _inside(sx, sy, w, h).all():
                cells.append(None)  # can't be judged: erasure
                continue
            t = (_grey(gray, sx, sy, inverted).mean() - dark) / (light - dark)
            cells.append(True if t < T_ON else False if t > T_OFF else None)
    return cells, conic, rotation


def read_candidate(gray, masks, dot, inverted=False) -> Detection | None:
    got = read_cells(gray, masks, dot, inverted)
    if got is None:
        return None
    cells, conic, rotation = got
    d = decode(cells)
    if d is None:
        return None
    return Detection(d.marker_id, d.version, d.corrected, (dot[0] + 0.5, dot[1] + 0.5),
                     conic_ellipse(conic, dot[0], dot[1]), rotation, inverted)


def detect(gray: np.ndarray) -> list[Detection]:
    gray = np.asarray(gray)
    if gray.ndim != 2 or gray.dtype != np.uint8:
        raise ValueError("detect expects a 2-D uint8 grey image")
    dark, light = threshold(gray, window_size(gray.shape[1]))
    return merge_polarities(detect_pass(gray, (dark, light), False), detect_pass(gray, (light, dark), True))


def detect_pass(gray: np.ndarray, masks, inverted: bool) -> list[Detection]:
    """Steps 2-8 for one polarity; `masks` is (DARK, LIGHT) as this pass sees them (step 9)."""
    found = []
    for first, dot in dot_candidates(masks[0], with_order=True):
        det = read_candidate(gray, masks, dot, inverted)
        if det is not None:
            found.append((det, math.sqrt(dot[2] * dot[3]), first))
    found.sort(key=lambda f: (f[0].corrected, f[2]))
    kept: list[tuple[Detection, float]] = []
    for det, r, _ in found:
        if all(math.dist(det.center_px, k.center_px) >= 0.5 * kr for k, kr in kept):
            kept.append((det, r))
    return [k for k, _ in kept]


def merge_polarities(normal: list[Detection], inverted: list[Detection]) -> list[Detection]:
    """Step 9's merge: the normal pass's detections, then the inverted pass's that no normal one duplicates (same id,
    centres closer than the smaller finder radius)."""
    out = list(normal)
    for d in inverted:
        if not any(n.marker_id == d.marker_id
                   and math.dist(n.center_px, d.center_px) < min(n.ellipse[2], d.ellipse[2]) for n in normal):
            out.append(d)
    return out
