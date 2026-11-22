package io.virvi.ar.ring

import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * One decoded ring marker. ([cx], [cy]) is the centre dot in continuous pixel coordinates
 * (pixel (i, j) covers [i, i+1) x [j, j+1)); [semiMajor], [semiMinor] and [angleDeg] (major axis,
 * degrees in [0, 180) from +x toward +y, image y down) describe the finder ring's fitted outer
 * edge; [rotationDeg] is the finder gap's angle clockwise from image-up, in [0, 360). [inverted] is
 * set when the marker was read light-on-dark (the inverted pass, step 9).
 */
data class RingDetection(
    val id: Long,
    val version: Int,
    val corrected: Int,
    val cx: Double,
    val cy: Double,
    val semiMajor: Double,
    val semiMinor: Double,
    val angleDeg: Double,
    val rotationDeg: Double,
    val inverted: Boolean = false,
)

/**
 * A ring the detector can see (a dot inside a finder ring) but could not read or decode, typically
 * because it is too small or too oblique. ([cx], [cy]) is the centre dot, [semiMajor] the finder
 * ring's fitted outer semi-major axis in pixels.
 */
data class UnreadableRing(val cx: Double, val cy: Double, val semiMajor: Double)

/** Result of one frame: decoded rings plus rings seen but not readable. */
data class RingFrame(val detections: List<RingDetection>, val unreadable: List<UnreadableRing>)

/**
 * Ring-marker detector: a step-for-step port of apps/ring-marker/ringmarker/detect.py, whose module
 * docstring is the spec (steps 1-9 below follow its numbering). Results on the synthetic test set
 * match the Python (same ids and corrected counts, centres to well under 0.1 px). It reads both
 * polarities: dark marks on a light plaque and light marks on a dark plaque (step 9).
 *
 * Not thread-safe: an instance reuses its buffers between calls, since [detect] runs on every
 * camera frame. Use one instance per camera thread.
 */
class RingDetector {
  /** A dot candidate (step 3): moments of a blob, [first] = raster index of its first pixel. */
  internal class Dot(
      val first: Int,
      val cx: Double,
      val cy: Double,
      val a: Double,
      val b: Double,
      val phi: Double,
  )

  /**
   * (rho, beta) -> image: q = rho (sin beta, -cos beta); w = Minv q; p = c + w / (1 + l.w). [m] is
   * Minv^-1, used by [radiusOf]. [toImage] writes its result to [px], [py].
   */
  internal class Frame(
      val cx: Double,
      val cy: Double,
      private val i00: Double,
      private val i01: Double,
      private val i10: Double,
      private val i11: Double,
      private val lx: Double,
      private val ly: Double,
      private val m00: Double,
      private val m01: Double,
      private val m10: Double,
      private val m11: Double,
  ) {
    var px = 0.0
    var py = 0.0

    fun toImage(rho: Double, betaDeg: Double) {
      val b = Math.toRadians(betaDeg)
      fromQ(rho * sin(b), -rho * cos(b))
    }

    /** As [toImage], from q directly. */
    fun fromQ(qx: Double, qy: Double) {
      val wx = i00 * qx + i01 * qy
      val wy = i10 * qx + i11 * qy
      val den = 1 + lx * wx + ly * wy
      px = cx + wx / den
      py = cy + wy / den
    }

    /** Normalised radius of a point given relative to c: |M d| / |1 - l.d|. */
    fun radiusOf(dx: Double, dy: Double): Double =
        hypot(m00 * dx + m01 * dy, m10 * dx + m11 * dy) / abs(1 - (dx * lx + dy * ly))

    companion object {
      fun fromDot(dot: Dot): Frame {
        val c = cos(dot.phi)
        val s = sin(dot.phi)
        val k = FINDER_OUTER / DOT_REF
        // (k R) diag(a, b) R^T, R = [[c, -s], [s, c]]
        val x00 = k * c * dot.a
        val x01 = k * -s * dot.b
        val x10 = k * s * dot.a
        val x11 = k * c * dot.b
        val i00 = x00 * c + x01 * -s
        val i01 = x00 * s + x01 * c
        val i10 = x10 * c + x11 * -s
        val i11 = x10 * s + x11 * c
        val det = i00 * i11 - i01 * i10
        return Frame(
            dot.cx, dot.cy, i00, i01, i10, i11, 0.0, 0.0,
            i11 / det, -i01 / det, -i10 / det, i00 / det,
        )
      }

      /**
       * The projective map of the unit circle onto the conic (A, B, C, D, E) that keeps c fixed:
       * l = (D/2, E/2), P = [[A, B/2], [B/2, C]] + l l^T, Minv = P^(-1/2). Null unless an ellipse
       * with P positive definite.
       */
      fun fromConic(conic: DoubleArray?, cx: Double, cy: Double): Frame? {
        if (conic == null) return null
        val (aa, bb, cc, dd, ee) = conic
        if (aa <= 0 || 4 * aa * cc - bb * bb <= 0) return null
        val lx = dd / 2
        val ly = ee / 2
        val e = Sym2(aa + lx * lx, bb / 2 + lx * ly, cc + ly * ly)
        if (e.wSmall <= 0) return null
        val si = 1 / sqrt(e.wLarge)
        val ti = 1 / sqrt(e.wSmall)
        val sm = sqrt(e.wLarge)
        val tm = sqrt(e.wSmall)
        return Frame(
            cx, cy, e.f00(si, ti), e.f01(si, ti), e.f01(si, ti), e.f11(si, ti), lx, ly,
            e.f00(sm, tm), e.f01(sm, tm), e.f01(sm, tm), e.f11(sm, tm),
        )
      }
    }
  }

  /**
   * Eigen-decomposition of the symmetric [[p, q], [q, r]]: eigenvalues [wLarge] >= [wSmall], unit
   * eigenvector (c, s) of wLarge. f.. evaluate f(P) = fL e e^T + fS e' e'^T from fL = f(wLarge),
   * fS = f(wSmall).
   */
  private class Sym2(p: Double, q: Double, r: Double) {
    val wLarge: Double
    val wSmall: Double
    val c: Double
    val s: Double

    init {
      val half = (p + r) / 2
      val d = (p - r) / 2
      val root = sqrt(d * d + q * q)
      wLarge = half + root
      wSmall = half - root
      val th = 0.5 * atan2(2 * q, p - r)
      c = cos(th)
      s = sin(th)
    }

    fun f00(fl: Double, fs: Double) = fl * c * c + fs * s * s

    fun f01(fl: Double, fs: Double) = (fl - fs) * c * s

    fun f11(fl: Double, fs: Double) = fl * s * s + fs * c * c
  }

  /** Steps 4-6 output for one dot. */
  private class Cells(val cells: Array<Boolean?>, val conic: DoubleArray, val rotation: Double)

  private class Found(val det: RingDetection, val dotRadius: Double, val first: Int)

  // --- per-frame state and buffers, reused between calls ---
  private var gray = ByteArray(0)
  private var w = 0
  private var h = 0
  private var stride = 0
  /** The pass's polarity (step 9): true reads the masks swapped and grey values as 255 - v. */
  private var inv = false
  private var integral = IntArray(0)
  private var state = ByteArray(0) // DARK, LIGHT or 0 (undecided)
  private var labels = IntArray(0)
  private var parent = IntArray(1024)
  private var firstOf = IntArray(1024)
  private var comp = IntArray(1024)
  private var cnt = IntArray(256)
  private var cFirst = IntArray(256)
  private var sx = DoubleArray(256)
  private var sy = DoubleArray(256)
  private var sxx = DoubleArray(256)
  private var syy = DoubleArray(256)
  private var sxy = DoubleArray(256)
  private var rho = DoubleArray(256)
  private val edgeX = DoubleArray(RAYS)
  private val edgeY = DoubleArray(RAYS)
  private val keptX = DoubleArray(RAYS)
  private val keptY = DoubleArray(RAYS)
  private val rad = DoubleArray(RAYS)
  private val radSorted = DoubleArray(RAYS)
  private val gapX = DoubleArray(GAP_SAMPLES)
  private val gapY = DoubleArray(GAP_SAMPLES)
  private val gapState = ByteArray(GAP_SAMPLES)
  private val cellX = DoubleArray(5)
  private val cellY = DoubleArray(5)

  /** Conic of the finder ring found by the last [readCells] call, or null if none was found. */
  private var seenConic: DoubleArray? = null

  /**
   * Detects ring markers in an 8-bit grey image (row j starts at j * [rowStride]). Detections are
   * ordered by (corrected, first-pixel raster index), with duplicates of the same marker dropped.
   */
  fun detect(
      gray: ByteArray,
      width: Int,
      height: Int,
      rowStride: Int = width,
  ): List<RingDetection> = detectFrame(gray, width, height, rowStride).detections

  /**
   * As [detect], also reporting candidates whose dot and finder ring were found (step 4) but whose
   * cells could not be read or decoded. Unreadable entries within the finder radius of a detection,
   * or that coincide with each other, are dropped.
   */
  fun detectFrame(
      gray: ByteArray,
      width: Int,
      height: Int,
      rowStride: Int = width,
  ): RingFrame {
    prepare(gray, width, height, rowStride, windowSize(width))
    val unseen = ArrayList<Pair<Dot, DoubleArray>>()
    // 9. polarity: the normal pass, then the inverted pass on the same masks
    val detections = mergePolarities(detectPass(false, unseen), detectPass(true, unseen))
    val unreadable = ArrayList<UnreadableRing>()
    for ((dot, conic) in unseen) {
      val x = dot.cx + 0.5
      val y = dot.cy + 0.5
      val r = 0.5 * sqrt(dot.a * dot.b)
      if (detections.any { hypot(x - it.cx, y - it.cy) < it.semiMajor }) continue
      if (unreadable.any { hypot(x - it.cx, y - it.cy) < r }) continue
      unreadable.add(UnreadableRing(x, y, conicEllipse(conic)[0]))
    }
    return RingFrame(detections, unreadable)
  }

  /**
   * Steps 2-8 for one polarity on the thresholded image; candidates seen but not decoded are added
   * to [unseen].
   */
  private fun detectPass(
      inverted: Boolean,
      unseen: MutableList<Pair<Dot, DoubleArray>>,
  ): List<RingDetection> {
    inv = inverted
    val found = ArrayList<Found>()
    for (dot in candidates()) {
      seenConic = null
      val got = readCells(dot)
      val d = got?.let { RingCodec.decode(it.cells) }
      if (got == null || d == null) {
        seenConic?.let { unseen.add(dot to it) }
        continue
      }
      val e = conicEllipse(got.conic)
      val det =
          RingDetection(
              d.id,
              d.version,
              d.corrected,
              dot.cx + 0.5,
              dot.cy + 0.5,
              e[0],
              e[1],
              e[2],
              got.rotation,
              inverted,
          )
      found.add(Found(det, sqrt(dot.a * dot.b), dot.first))
    }
    // 8. duplicates
    found.sortWith(compareBy<Found>({ it.det.corrected }, { it.first }))
    val kept = ArrayList<Found>()
    for (f in found) {
      if (kept.all { k -> hypot(f.det.cx - k.det.cx, f.det.cy - k.det.cy) >= 0.5 * k.dotRadius }) {
        kept.add(f)
      }
    }
    return kept.map { it.det }
  }

  /** Test hook: the cells read for the dot candidate nearest (x, y) (pixel-index coordinates). */
  internal fun readCellsNear(
      gray: ByteArray,
      width: Int,
      height: Int,
      rowStride: Int,
      x: Double,
      y: Double,
  ): Array<Boolean?>? {
    val dots = dotCandidates(gray, width, height, rowStride, windowSize(width))
    val dot = dots.minByOrNull { hypot(it.cx - x, it.cy - y) } ?: return null
    return readCells(dot)?.cells
  }

  // ---- 1-3. threshold, blobs, dot candidates ----------------------------------------------------

  /**
   * Thresholds and labels the image, then returns the normal pass's dot candidates in first-pixel
   * order.
   */
  internal fun dotCandidates(
      gray: ByteArray,
      width: Int,
      height: Int,
      rowStride: Int,
      win: Int,
  ): List<Dot> {
    prepare(gray, width, height, rowStride, win)
    inv = false
    return candidates()
  }

  /** Takes the frame and thresholds it (step 1), once for both passes. */
  private fun prepare(gray: ByteArray, width: Int, height: Int, rowStride: Int, win: Int) {
    require(width > 0 && height > 0 && rowStride >= width) { "bad image size" }
    require(gray.size >= (height - 1) * rowStride + width) { "image buffer too small" }
    this.gray = gray
    w = width
    h = height
    stride = rowStride
    threshold(win)
  }

  /** Steps 2-3 for the current pass: labels its DARK, then returns the dot candidates. */
  private fun candidates(): List<Dot> {
    val n = label()
    val out = ArrayList<Dot>()
    for (i in 0 until n) {
      val area = cnt[i].toDouble()
      if (cnt[i] < MIN_AREA) continue
      val mx = sx[i] / area
      val my = sy[i] / area
      val cxx = sxx[i] / area - mx * mx
      val cyy = syy[i] / area - my * my
      val cxy = sxy[i] / area - mx * my
      val half = (cxx + cyy) / 2
      val root = sqrt(max(0.0, (cxx - cyy) * (cxx - cyy) / 4 + cxy * cxy))
      val l1 = half + root
      val l2 = half - root
      if (l2 <= 0) continue
      val a = 2 * sqrt(l1)
      val b = 2 * sqrt(l2)
      val fill = area / (Math.PI * a * b)
      if (!(fill >= FILL_MIN && fill <= FILL_MAX) || b / a < MIN_AXIS_RATIO) continue
      out.add(Dot(cFirst[i], mx, my, a, b, 0.5 * atan2(2 * cxy, cxx - cyy)))
    }
    return out // components are numbered in first-pixel order already
  }

  /**
   * Step 1. A pixel is DARK if v n < S - 7n, LIGHT if v n > S + 7n, over the win x win window
   * clipped to the image. The integral image is Int: it may wrap on huge images, but window sums
   * (at most win^2 * 255) are exact in two's-complement arithmetic.
   */
  private fun threshold(win: Int) {
    val iw = w + 1
    if (integral.size < iw * (h + 1)) integral = IntArray(iw * (h + 1))
    if (state.size < w * h) state = ByteArray(w * h)
    val ii = integral
    for (x in 0..w) ii[x] = 0
    for (y in 0 until h) {
      var row = 0
      val src = y * stride
      val dst = (y + 1) * iw
      ii[dst] = 0
      for (x in 0 until w) {
        row += gray[src + x].toInt() and 0xFF
        ii[dst + x + 1] = ii[dst - iw + x + 1] + row
      }
    }
    val r = win / 2
    for (y in 0 until h) {
      val y0 = max(y - r, 0)
      val y1 = min(y + r + 1, h)
      val ny = y1 - y0
      val top = y0 * iw
      val bot = y1 * iw
      val src = y * stride
      val out = y * w
      for (x in 0 until w) {
        val x0 = max(x - r, 0)
        val x1 = min(x + r + 1, w)
        val n = ny * (x1 - x0)
        val s = ii[bot + x1] - ii[top + x1] - ii[bot + x0] + ii[top + x0]
        val vn = (gray[src + x].toInt() and 0xFF) * n
        state[out + x] = if (vn < s - OFFSET * n) DARK else if (vn > s + OFFSET * n) LIGHT else 0
      }
    }
  }

  /**
   * Step 2. 8-connected components of DARK (LIGHT in the inverted pass) by two-pass union-find.
   * Roots are always the smallest label, so a component's root is the label of its first pixel and
   * components are numbered in first-pixel raster order. Moments are summed in raster order, as
   * numpy's bincount does.
   * Returns the component count; stats are in cnt, cFirst, sx.. sxy.
   */
  private fun label(): Int {
    if (labels.size < w * h) labels = IntArray(w * h)
    val lab = labels
    val target = if (inv) LIGHT else DARK
    var next = 1
    for (y in 0 until h) {
      val row = y * w
      for (x in 0 until w) {
        val i = row + x
        if (state[i] != target) {
          lab[i] = 0
          continue
        }
        var l: Int
        val up = i - w
        if (x > 0 && lab[i - 1] != 0) {
          l = lab[i - 1]
          // NE touches W only through N
          if (y > 0 && x < w - 1 && lab[up] == 0 && lab[up + 1] != 0) l = union(l, lab[up + 1])
        } else if (y > 0 && lab[up] != 0) {
          l = lab[up]
        } else {
          val nw = if (y > 0 && x > 0) lab[up - 1] else 0
          val ne = if (y > 0 && x < w - 1) lab[up + 1] else 0
          l = if (nw != 0 && ne != 0) union(nw, ne) else if (nw != 0) nw else ne
        }
        if (l == 0) {
          if (next == parent.size) {
            parent = parent.copyOf(next * 2)
            firstOf = firstOf.copyOf(next * 2)
          }
          l = next++
          parent[l] = l
          firstOf[l] = i
        }
        lab[i] = l
      }
    }
    if (comp.size < next) comp = IntArray(parent.size)
    var n = 0
    for (l in 1 until next) {
      val root = find(l)
      if (root == l) {
        if (n == cnt.size) growStats()
        cnt[n] = 0
        cFirst[n] = firstOf[l]
        sx[n] = 0.0
        sy[n] = 0.0
        sxx[n] = 0.0
        syy[n] = 0.0
        sxy[n] = 0.0
        comp[l] = n++
      } else {
        comp[l] = comp[root]
      }
    }
    for (y in 0 until h) {
      val row = y * w
      val fy = y.toDouble()
      for (x in 0 until w) {
        val l = lab[row + x]
        if (l == 0) continue
        val c = comp[l]
        val fx = x.toDouble()
        cnt[c]++
        sx[c] += fx
        sy[c] += fy
        sxx[c] += fx * fx
        syy[c] += fy * fy
        sxy[c] += fx * fy
      }
    }
    return n
  }

  private fun find(x: Int): Int {
    var a = x
    while (parent[a] != a) {
      parent[a] = parent[parent[a]]
      a = parent[a]
    }
    return a
  }

  private fun union(a: Int, b: Int): Int {
    val ra = find(a)
    val rb = find(b)
    return if (ra < rb) {
      parent[rb] = ra
      ra
    } else {
      parent[ra] = rb
      rb
    }
  }

  private fun growStats() {
    val n = cnt.size * 2
    cnt = cnt.copyOf(n)
    cFirst = cFirst.copyOf(n)
    sx = sx.copyOf(n)
    sy = sy.copyOf(n)
    sxx = sxx.copyOf(n)
    syy = syy.copyOf(n)
    sxy = sxy.copyOf(n)
  }

  // ---- sampling ---------------------------------------------------------------------------------

  /**
   * Mask state at the nearest pixel, DARK and LIGHT swapped in the inverted pass; undecided (0) off
   * the image or at non-finite coordinates.
   */
  private fun nearest(x: Double, y: Double): Byte {
    val i = nearestIndex(x, y, w, h)
    if (i < 0) return 0
    return if (inv) (-state[i]).toByte() else state[i]
  }

  private fun px(x: Int, y: Int): Double = (gray[y * stride + x].toInt() and 0xFF).toDouble()

  /** Bilinear grey value, read as 255 - v in the inverted pass. */
  private fun bilinear(xIn: Double, yIn: Double): Double {
    val x = min(max(xIn, 0.0), w - 1 - 1e-6)
    val y = min(max(yIn, 0.0), h - 1 - 1e-6)
    val x0 = floor(x)
    val y0 = floor(y)
    val fx = x - x0
    val fy = y - y0
    val xi = x0.toInt()
    val yi = y0.toInt()
    val top = px(xi, yi) * (1 - fx) + px(xi + 1, yi) * fx
    val bottom = px(xi, yi + 1) * (1 - fx) + px(xi + 1, yi + 1) * fx
    val v = top * (1 - fy) + bottom * fy
    return if (inv) 255.0 - v else v
  }

  // ---- 4. finder ring ---------------------------------------------------------------------------

  /** Edge points relative to the dot centre into edgeX/edgeY; their count, or -1 if < 60. */
  private fun rayEdges(dot: Dot): Int {
    val fr = Frame.fromDot(dot)
    val rho0 = (1 - EDGE_SLACK) * FINDER_INNER / FINDER_OUTER
    val rho1 = 1 + EDGE_SLACK
    val n = ceil((rho1 - rho0) * FINDER_OUTER / DOT_REF * dot.a / 0.5).toInt() + 1
    if (rho.size < n) rho = DoubleArray(n * 2)
    val step = (rho1 - rho0) / (n - 1) // numpy linspace
    for (k in 0 until n) rho[k] = k * step + rho0
    rho[n - 1] = rho1
    var count = 0
    for (i in 0 until RAYS) {
      if (count + (RAYS - i) < MIN_EDGE_RAYS) return -1 // can't reach 60 edges any more
      val b = Math.toRadians(i * (360.0 / RAYS))
      val sb = sin(b)
      val cb = cos(b)
      var prev: Byte = 0
      var prevRho = 0.0
      var edge = Double.NaN
      for (k in 0 until n) {
        val r = rho[k]
        fr.fromQ(r * sb, -r * cb)
        val st = nearest(fr.px, fr.py)
        if (st == 0.toByte()) continue
        if (st == LIGHT && prev == DARK) edge = 0.5 * (prevRho + r)
        prev = st
        prevRho = r
      }
      if (edge.isNaN()) continue
      fr.fromQ(edge * sb, -edge * cb)
      edgeX[count] = fr.px - fr.cx
      edgeY[count] = fr.py - fr.cy
      count++
    }
    return if (count < MIN_EDGE_RAYS) -1 else count
  }

  /** (frame, conic) of the finder ring's outer edge, or null. */
  private fun finder(dot: Dot): Pair<Frame, DoubleArray>? {
    val n = rayEdges(dot)
    if (n < 0) return null
    var conic = fitConic(edgeX, edgeY, n)
    var fr = Frame.fromConic(conic, dot.cx, dot.cy)
    repeat(TRIM_PASSES) {
      if (fr == null) return null
      for (k in 0 until n) rad[k] = fr!!.radiusOf(edgeX[k], edgeY[k])
      System.arraycopy(rad, 0, radSorted, 0, n)
      radSorted.sort(0, n)
      val med =
          if (n % 2 == 1) radSorted[n / 2] else (radSorted[n / 2 - 1] + radSorted[n / 2]) / 2
      var m = 0
      for (k in 0 until n) {
        if (abs(rad[k] / med - 1) <= TRIM) {
          keptX[m] = edgeX[k]
          keptY[m] = edgeY[k]
          m++
        }
      }
      if (m < MIN_EDGE_RAYS) return null
      conic = fitConic(keptX, keptY, m)
      fr = Frame.fromConic(conic, dot.cx, dot.cy)
    }
    val f = fr ?: return null
    return f to conic!!
  }

  // ---- 5, 6. gap and cells ----------------------------------------------------------------------

  private fun readCells(dot: Dot): Cells? {
    val (fr, conic) = finder(dot) ?: return null
    seenConic = conic
    val nb = GAP_SAMPLES
    var anyLight = false
    var allLight = true
    var anyDark = false
    for (j in 0 until nb) {
      fr.toImage(GAP_RHO, j * GAP_STEP_DEG)
      gapX[j] = fr.px
      gapY[j] = fr.py
      val st = nearest(fr.px, fr.py)
      gapState[j] = st
      if (st == LIGHT) anyLight = true else allLight = false
      if (st == DARK) anyDark = true
    }
    if (!anyLight || allLight || !anyDark) return null

    // circular runs of LIGHT, scanning from the first non-LIGHT sample; keep the first longest
    var first = 0
    while (gapState[first] == LIGHT) first++
    var bestStart = -1
    var bestLen = 0
    var otherMax = 0
    var k = 0
    while (k < nb) {
      if (gapState[(first + k) % nb] == LIGHT) {
        var j = k
        while (j < nb && gapState[(first + j) % nb] == LIGHT) j++
        val len = j - k
        if (len > bestLen) {
          otherMax = max(otherMax, bestLen)
          bestLen = len
          bestStart = (first + k) % nb
        } else {
          otherMax = max(otherMax, len)
        }
        k = j
      } else {
        k++
      }
    }
    val gapDeg = bestLen * GAP_STEP_DEG
    if (gapDeg < GAP_MIN_DEG || gapDeg > GAP_MAX_DEG) return null
    if (otherMax * GAP_STEP_DEG > OTHER_LIGHT_MAX_DEG) return null

    var darkSum = 0.0
    var darkN = 0
    for (j in 0 until nb) {
      if (gapState[j] == DARK) {
        darkSum += bilinear(gapX[j], gapY[j])
        darkN++
      }
    }
    var lightSum = 0.0
    for (i in 0 until bestLen) {
      val j = (bestStart + i) % nb
      lightSum += bilinear(gapX[j], gapY[j])
    }
    val dark = darkSum / darkN
    val light = lightSum / bestLen
    if (light - dark < MIN_CONTRAST) return null
    val betaG = (bestStart + (bestLen - 1) / 2.0) * GAP_STEP_DEG
    fr.toImage(GAP_RHO, betaG)
    val rotation = mod(Math.toDegrees(atan2(fr.px - dot.cx, -(fr.py - dot.cy))), 360.0)

    val cells = arrayOfNulls<Boolean>(RingCodec.CELLS)
    for ((ring, r) in CODE_RINGS_REF.withIndex()) {
      val m = (r[0] + r[1]) / 2
      val rIn = (m - CELL_DELTA_MM) / FINDER_OUTER
      val rMid = m / FINDER_OUTER
      val rOut = (m + CELL_DELTA_MM) / FINDER_OUTER
      for (c in 0 until PER_RING) {
        val mu = betaG + c * CELL_DEG + CELL_DEG / 2
        sample(fr, 0, rMid, mu)
        sample(fr, 1, rMid, mu - CELL_DELTA_DEG)
        sample(fr, 2, rMid, mu + CELL_DELTA_DEG)
        sample(fr, 3, rIn, mu)
        sample(fr, 4, rOut, mu)
        var off = false
        for (q in 0 until 5) if (!inside(cellX[q], cellY[q], w, h)) off = true
        if (off) continue // can't be judged: erasure
        var v = 0.0
        for (q in 0 until 5) v += bilinear(cellX[q], cellY[q])
        val t = (v / 5 - dark) / (light - dark)
        cells[ring * PER_RING + c] = if (t < T_ON) true else if (t > T_OFF) false else null
      }
    }
    return Cells(cells, conic, rotation)
  }

  private fun sample(fr: Frame, q: Int, rho: Double, beta: Double) {
    fr.toImage(rho, beta)
    cellX[q] = fr.px
    cellY[q] = fr.py
  }

  internal companion object {
    /**
     * Index of the pixel nearest (x, y) in a [w] x [h] image, or -1 off the image. NaN or infinite
     * coordinates are off the image (NaN.toInt() would otherwise be pixel 0).
     */
    fun nearestIndex(x: Double, y: Double, w: Int, h: Int): Int {
      if (!x.isFinite() || !y.isFinite()) return -1
      val xi = floor(x + 0.5)
      val yi = floor(y + 0.5)
      if (xi < 0 || yi < 0 || xi >= w || yi >= h) return -1
      return yi.toInt() * w + xi.toInt()
    }

    /** Whether (x, y) lies in [0, w - 1] x [0, h - 1]; NaN or infinite coordinates do not. */
    fun inside(x: Double, y: Double, w: Int, h: Int): Boolean =
        x.isFinite() && y.isFinite() && x >= 0 && x <= w - 1 && y >= 0 && y <= h - 1

    private const val DARK: Byte = 1
    private const val LIGHT: Byte = -1
    private const val OFFSET = 7
    private const val MIN_AREA = 30
    private const val FILL_MIN = 0.85
    private const val FILL_MAX = 1.15
    private const val MIN_AXIS_RATIO = 0.5
    private const val RAYS = 90
    private const val MIN_EDGE_RAYS = 60
    private const val EDGE_SLACK = 0.20
    private const val TRIM = 0.10
    private const val TRIM_PASSES = 3
    private const val GAP_RHO = 66.0 / 70.0
    private const val GAP_STEP_DEG = 0.5
    private const val GAP_SAMPLES = 720
    private const val GAP_MIN_DEG = 10.0
    private const val GAP_MAX_DEG = 22.0
    private const val OTHER_LIGHT_MAX_DEG = 4.0
    private const val T_ON = 0.4
    private const val T_OFF = 0.6
    private const val CELL_DELTA_DEG = 3.0
    private const val CELL_DELTA_MM = 1.0
    private const val MIN_CONTRAST = 2 * OFFSET
    private const val PIVOT_EPS = 1e-9

    // layout.py, in ref mm at the 140 mm reference size
    private const val FINDER_INNER = 62.0
    private const val FINDER_OUTER = 70.0
    private const val DOT_REF = 12.0
    private const val PER_RING = 24
    private const val CELL_DEG = 360.0 / PER_RING
    private val CODE_RINGS_REF = // ring 0 outermost
        arrayOf(doubleArrayOf(51.0, 59.0), doubleArrayOf(40.0, 48.0), doubleArrayOf(29.0, 37.0))

    fun windowSize(width: Int): Int = max(51, width / 25) or 1

    /**
     * Step 9's merge: the normal pass's detections, then the inverted pass's that no normal one
     * duplicates (same id, centres closer than the smaller finder radius).
     */
    fun mergePolarities(
        normal: List<RingDetection>,
        inverted: List<RingDetection>,
    ): List<RingDetection> {
      val out = ArrayList(normal)
      for (d in inverted) {
        val dup =
            normal.any {
              it.id == d.id && hypot(it.cx - d.cx, it.cy - d.cy) < min(it.semiMajor, d.semiMajor)
            }
        if (!dup) out.add(d)
      }
      return out
    }

    private fun mod(a: Double, m: Double): Double {
      val r = a % m
      return if (r < 0) r + m else r
    }

    /**
     * Least squares A x^2 + B xy + C y^2 + D x + E y = 1 over the first [n] points (normal
     * equations on points scaled by 1/RMS radius), or null if the normal matrix is singular.
     */
    fun fitConic(xs: DoubleArray, ys: DoubleArray, n: Int): DoubleArray? {
      var ss = 0.0
      for (i in 0 until n) ss += xs[i] * xs[i] + ys[i] * ys[i]
      val l = sqrt(ss / n)
      val ata = Array(5) { DoubleArray(6) }
      val row = DoubleArray(5)
      for (i in 0 until n) {
        val u = xs[i] / l
        val v = ys[i] / l
        row[0] = u * u
        row[1] = u * v
        row[2] = v * v
        row[3] = u
        row[4] = v
        for (r in 0 until 5) {
          val ar = ata[r]
          for (c in 0 until 5) ar[c] += row[r] * row[c]
          ar[5] += row[r]
        }
      }
      val x = solve(ata) ?: return null
      val l2 = l * l
      return doubleArrayOf(x[0] / l2, x[1] / l2, x[2] / l2, x[3] / l, x[4] / l)
    }

    /** Gaussian elimination with partial pivoting on an augmented n x (n+1) matrix (destroyed). */
    private fun solve(m: Array<DoubleArray>): DoubleArray? {
      val n = m.size
      for (c in 0 until n) {
        var p = c
        for (r in c + 1 until n) if (abs(m[r][c]) > abs(m[p][c])) p = r
        if (abs(m[p][c]) < PIVOT_EPS) return null
        val t = m[c]
        m[c] = m[p]
        m[p] = t
        for (r in c + 1 until n) {
          val f = m[r][c] / m[c][c]
          for (k in c..n) m[r][k] -= f * m[c][k]
        }
      }
      val x = DoubleArray(n)
      for (r in n - 1 downTo 0) {
        var s = 0.0
        for (k in r + 1 until n) s += m[r][k] * x[k]
        x[r] = (m[r][n] - s) / m[r][r]
      }
      return x
    }

    /**
     * Semi-major, semi-minor and major-axis angle (degrees in [0, 180), from +x toward +y) of the
     * conic's ellipse: Q = [[A, B/2], [B/2, C]], x0 = -Q^-1 (D, E) / 2, kappa = 1 + x0^T Q x0.
     */
    private fun conicEllipse(conic: DoubleArray): DoubleArray {
      val (a, b, c, d, e) = conic
      val hb = b / 2
      val det = a * c - hb * hb
      val x0 = -0.5 * (d * c - hb * e) / det
      val y0 = -0.5 * (a * e - hb * d) / det
      val kappa = 1 + (x0 * (a * x0 + hb * y0) + y0 * (hb * x0 + c * y0))
      val q = Sym2(a, hb, c)
      // the major axis belongs to the small eigenvalue, perpendicular to (c, s)
      val angle = mod(Math.toDegrees(atan2(q.s, q.c)) + 90.0, 180.0)
      return doubleArrayOf(sqrt(kappa / q.wSmall), sqrt(kappa / q.wLarge), angle)
    }
  }
}
