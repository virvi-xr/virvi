import Foundation

/// One decoded ring marker. (`cx`, `cy`) is the centre dot in continuous pixel coordinates (pixel
/// (i, j) covers [i, i+1) x [j, j+1)); `semiMajor`, `semiMinor` and `angleDeg` (major axis, degrees
/// in [0, 180) from +x toward +y, image y down) describe the finder ring's fitted outer edge;
/// `rotationDeg` is the finder gap's angle clockwise from image-up, in [0, 360). `inverted` is set when the
/// marker was read light-on-dark (the inverted pass, step 9).
public struct RingDetection: Equatable, Sendable {
    public let id: UInt32
    public let version: Int
    public let corrected: Int
    public let cx: Double
    public let cy: Double
    public let semiMajor: Double
    public let semiMinor: Double
    public let angleDeg: Double
    public let rotationDeg: Double
    public let inverted: Bool

    public init(id: UInt32, version: Int, corrected: Int, cx: Double, cy: Double,
                semiMajor: Double, semiMinor: Double, angleDeg: Double, rotationDeg: Double, inverted: Bool = false) {
        self.id = id
        self.version = version
        self.corrected = corrected
        self.cx = cx
        self.cy = cy
        self.semiMajor = semiMajor
        self.semiMinor = semiMinor
        self.angleDeg = angleDeg
        self.rotationDeg = rotationDeg
        self.inverted = inverted
    }
}

/// A ring the detector can see (a dot inside a finder ring) but could not read or decode, typically
/// because it is too small or too oblique. (`cx`, `cy`) is the centre dot, `semiMajor` the finder
/// ring's fitted outer semi-major axis in pixels.
public struct UnreadableRing: Equatable, Sendable {
    public let cx: Double
    public let cy: Double
    public let semiMajor: Double

    public init(cx: Double, cy: Double, semiMajor: Double) {
        self.cx = cx
        self.cy = cy
        self.semiMajor = semiMajor
    }
}

/// Result of one frame: decoded rings plus rings seen but not readable.
public struct RingFrame: Equatable, Sendable {
    public let detections: [RingDetection]
    public let unreadable: [UnreadableRing]

    public init(detections: [RingDetection], unreadable: [UnreadableRing]) {
        self.detections = detections
        self.unreadable = unreadable
    }
}

/// Ring-marker detector: a step-for-step port of apps/quest/.../ring/RingDetector.kt, itself a port
/// of apps/ring-marker/ringmarker/detect.py, whose module docstring is the spec (steps 1-9 below
/// follow its numbering). It reads both polarities: dark marks on a light plaque and light marks on a
/// dark plaque (step 9).
///
/// Not thread-safe: an instance reuses its buffers between calls, since `detectFrame` runs on every
/// camera frame. Use one instance per camera queue.
public final class RingDetector {
    /// A dot candidate (step 3): moments of a blob, `first` = raster index of its first pixel.
    struct Dot {
        let first: Int
        let cx: Double
        let cy: Double
        let a: Double
        let b: Double
        let phi: Double
    }

    /// (rho, beta) -> image: q = rho (sin beta, -cos beta); w = Minv q; p = c + w / (1 + l.w). `m` is
    /// Minv^-1, used by `radiusOf`.
    struct Frame {
        let cx: Double
        let cy: Double
        let i00: Double, i01: Double, i10: Double, i11: Double
        let lx: Double, ly: Double
        let m00: Double, m01: Double, m10: Double, m11: Double

        func toImage(_ rho: Double, _ betaDeg: Double) -> (Double, Double) {
            let b = betaDeg * degToRad
            return fromQ(rho * sin(b), -rho * cos(b))
        }

        /// As `toImage`, from q directly.
        func fromQ(_ qx: Double, _ qy: Double) -> (Double, Double) {
            let wx = i00 * qx + i01 * qy
            let wy = i10 * qx + i11 * qy
            let den = 1 + lx * wx + ly * wy
            return (cx + wx / den, cy + wy / den)
        }

        /// Normalised radius of a point given relative to c: |M d| / |1 - l.d|.
        func radiusOf(_ dx: Double, _ dy: Double) -> Double {
            hypot(m00 * dx + m01 * dy, m10 * dx + m11 * dy) / abs(1 - (dx * lx + dy * ly))
        }

        static func fromDot(_ dot: Dot) -> Frame {
            let c = cos(dot.phi)
            let s = sin(dot.phi)
            let k = finderOuter / dotRef
            // (k R) diag(a, b) R^T, R = [[c, -s], [s, c]]
            let x00 = k * c * dot.a
            let x01 = k * -s * dot.b
            let x10 = k * s * dot.a
            let x11 = k * c * dot.b
            let i00 = x00 * c + x01 * -s
            let i01 = x00 * s + x01 * c
            let i10 = x10 * c + x11 * -s
            let i11 = x10 * s + x11 * c
            let det = i00 * i11 - i01 * i10
            return Frame(cx: dot.cx, cy: dot.cy, i00: i00, i01: i01, i10: i10, i11: i11, lx: 0, ly: 0,
                         m00: i11 / det, m01: -i01 / det, m10: -i10 / det, m11: i00 / det)
        }

        /// The projective map of the unit circle onto the conic (A, B, C, D, E) that keeps c fixed:
        /// l = (D/2, E/2), P = [[A, B/2], [B/2, C]] + l l^T, Minv = P^(-1/2). Nil unless an ellipse
        /// with P positive definite.
        static func fromConic(_ conic: [Double]?, _ cx: Double, _ cy: Double) -> Frame? {
            guard let conic else { return nil }
            let aa = conic[0], bb = conic[1], cc = conic[2], dd = conic[3], ee = conic[4]
            if aa <= 0 || 4 * aa * cc - bb * bb <= 0 { return nil }
            let lx = dd / 2
            let ly = ee / 2
            let e = Sym2(aa + lx * lx, bb / 2 + lx * ly, cc + ly * ly)
            if e.wSmall <= 0 { return nil }
            let si = 1 / sqrt(e.wLarge)
            let ti = 1 / sqrt(e.wSmall)
            let sm = sqrt(e.wLarge)
            let tm = sqrt(e.wSmall)
            return Frame(cx: cx, cy: cy,
                         i00: e.f00(si, ti), i01: e.f01(si, ti), i10: e.f01(si, ti), i11: e.f11(si, ti),
                         lx: lx, ly: ly,
                         m00: e.f00(sm, tm), m01: e.f01(sm, tm), m10: e.f01(sm, tm), m11: e.f11(sm, tm))
        }
    }

    /// Eigen-decomposition of the symmetric [[p, q], [q, r]]: eigenvalues `wLarge` >= `wSmall`, unit
    /// eigenvector (c, s) of wLarge. f.. evaluate f(P) = fL e e^T + fS e' e'^T from fL = f(wLarge),
    /// fS = f(wSmall).
    private struct Sym2 {
        let wLarge: Double
        let wSmall: Double
        let c: Double
        let s: Double

        init(_ p: Double, _ q: Double, _ r: Double) {
            let half = (p + r) / 2
            let d = (p - r) / 2
            let root = sqrt(d * d + q * q)
            wLarge = half + root
            wSmall = half - root
            let th = 0.5 * atan2(2 * q, p - r)
            c = cos(th)
            s = sin(th)
        }

        func f00(_ fl: Double, _ fs: Double) -> Double { fl * c * c + fs * s * s }
        func f01(_ fl: Double, _ fs: Double) -> Double { (fl - fs) * c * s }
        func f11(_ fl: Double, _ fs: Double) -> Double { fl * s * s + fs * c * c }
    }

    /// Steps 4-6 output for one dot.
    private struct Cells {
        let cells: [Bool?]
        let conic: [Double]
        let rotation: Double
    }

    private struct Found {
        let det: RingDetection
        let dotRadius: Double
        let first: Int
    }

    // --- per-frame state and buffers, reused between calls ---
    // The per-pixel buffers are raw allocations so the hot loops stay fast in Debug builds too.
    private var gray: UnsafePointer<UInt8>?
    private var w = 0
    private var h = 0
    private var stride = 0
    /// The pass's polarity (step 9): true reads the masks swapped and grey values as 255 - v.
    private var inv = false
    private var integral = UnsafeMutablePointer<Int32>.allocate(capacity: 1)
    private var integralCap = 1
    private var state = UnsafeMutablePointer<Int8>.allocate(capacity: 1) // dark, light or 0 (undecided)
    private var stateCap = 1
    private var labels = UnsafeMutablePointer<Int32>.allocate(capacity: 1)
    private var labelsCap = 1
    // parent, firstOf and comp are sized for the worst case (one label per pixel), so never regrow mid-pass.
    private var parent = UnsafeMutablePointer<Int32>.allocate(capacity: 1)
    private var firstOf = UnsafeMutablePointer<Int32>.allocate(capacity: 1)
    private var comp = UnsafeMutablePointer<Int32>.allocate(capacity: 1)
    private var unionCap = 1
    /// Per component: count, sx, sy, sxx, syy, sxy (summed in raster order); first pixel in cFirst.
    private var moments = UnsafeMutablePointer<Double>.allocate(capacity: 6)
    private var momentsCap = 1
    private var cFirst: [Int] = []
    private var rho: [Double] = []
    private var edgeX = [Double](repeating: 0, count: rays)
    private var edgeY = [Double](repeating: 0, count: rays)
    private var keptX = [Double](repeating: 0, count: rays)
    private var keptY = [Double](repeating: 0, count: rays)
    private var rad = [Double](repeating: 0, count: rays)
    private var gapX = [Double](repeating: 0, count: gapSamples)
    private var gapY = [Double](repeating: 0, count: gapSamples)
    private var gapState = [Int8](repeating: 0, count: gapSamples)
    private var cellX = [Double](repeating: 0, count: 5)
    private var cellY = [Double](repeating: 0, count: 5)

    /// Conic of the finder ring found by the last `readCells` call, or nil if none was found.
    private var seenConic: [Double]?

    public init() {}

    deinit {
        integral.deallocate()
        state.deallocate()
        labels.deallocate()
        parent.deallocate()
        firstOf.deallocate()
        comp.deallocate()
        moments.deallocate()
    }

    /// Detects ring markers in an 8-bit grey image (row j starts at j * `rowStride`), and reports
    /// candidates whose dot and finder ring were found (step 4) but whose cells could not be read or
    /// decoded. Detections are the normal pass's, ordered by (corrected, first-pixel raster index)
    /// with duplicates of the same marker dropped, then the inverted pass's likewise, less those the
    /// normal pass already read (step 9); unreadable entries within the finder radius of a detection,
    /// or that coincide with each other, are dropped.
    public func detectFrame(gray: UnsafeBufferPointer<UInt8>, width: Int, height: Int, rowStride: Int) -> RingFrame {
        defer { self.gray = nil }
        prepare(gray: gray, width: width, height: height, rowStride: rowStride, win: Self.windowSize(width))
        var unseen: [(Dot, [Double])] = []
        // 9. polarity: the normal pass, then the inverted pass on the same masks
        let normal = detectPass(inverted: false, unseen: &unseen)
        let detections = Self.mergePolarities(normal, detectPass(inverted: true, unseen: &unseen))
        var unreadable: [UnreadableRing] = []
        for (dot, conic) in unseen {
            let x = dot.cx + 0.5
            let y = dot.cy + 0.5
            let r = 0.5 * sqrt(dot.a * dot.b)
            if detections.contains(where: { hypot(x - $0.cx, y - $0.cy) < $0.semiMajor }) { continue }
            if unreadable.contains(where: { hypot(x - $0.cx, y - $0.cy) < r }) { continue }
            unreadable.append(UnreadableRing(cx: x, cy: y, semiMajor: Self.conicEllipse(conic).0))
        }
        return RingFrame(detections: detections, unreadable: unreadable)
    }

    /// Steps 2-8 for one polarity on the thresholded image; candidates seen but not decoded are added
    /// to `unseen`.
    private func detectPass(inverted: Bool, unseen: inout [(Dot, [Double])]) -> [RingDetection] {
        inv = inverted
        var found: [Found] = []
        for dot in candidates() {
            seenConic = nil
            let got = readCells(dot)
            guard let got, let d = RingCodec.decode(got.cells) else {
                if let c = seenConic { unseen.append((dot, c)) }
                continue
            }
            let e = Self.conicEllipse(got.conic)
            let det = RingDetection(id: d.id, version: d.version, corrected: d.corrected,
                                    cx: dot.cx + 0.5, cy: dot.cy + 0.5,
                                    semiMajor: e.0, semiMinor: e.1, angleDeg: e.2, rotationDeg: got.rotation,
                                    inverted: inverted)
            found.append(Found(det: det, dotRadius: sqrt(dot.a * dot.b), first: dot.first))
        }
        // 8. duplicates (first is unique per dot, so this order is total and the sort's stability moot)
        found.sort { ($0.det.corrected, $0.first) < ($1.det.corrected, $1.first) }
        var kept: [Found] = []
        for f in found where kept.allSatisfy({ k in hypot(f.det.cx - k.det.cx, f.det.cy - k.det.cy) >= 0.5 * k.dotRadius }) {
            kept.append(f)
        }
        return kept.map(\.det)
    }

    /// Step 9's merge: the normal pass's detections, then the inverted pass's that no normal one
    /// duplicates (same id, centres closer than the smaller finder radius).
    static func mergePolarities(_ normal: [RingDetection], _ inverted: [RingDetection]) -> [RingDetection] {
        var out = normal
        for d in inverted where !normal.contains(where: {
            $0.id == d.id && hypot($0.cx - d.cx, $0.cy - d.cy) < min($0.semiMajor, d.semiMajor)
        }) {
            out.append(d)
        }
        return out
    }

    /// Test hook: the cells read for the dot candidate nearest (x, y) (pixel-index coordinates).
    func readCellsNear(gray: UnsafeBufferPointer<UInt8>, width: Int, height: Int, rowStride: Int,
                       x: Double, y: Double) -> [Bool?]? {
        defer { self.gray = nil }
        let dots = dotCandidates(gray: gray, width: width, height: height, rowStride: rowStride, win: Self.windowSize(width))
        guard let dot = dots.min(by: { hypot($0.cx - x, $0.cy - y) < hypot($1.cx - x, $1.cy - y) }) else { return nil }
        return readCells(dot)?.cells
    }

    // MARK: - 1-3. threshold, blobs, dot candidates

    /// Thresholds and labels the image, then returns the normal pass's dot candidates in first-pixel
    /// order.
    func dotCandidates(gray: UnsafeBufferPointer<UInt8>, width: Int, height: Int, rowStride: Int, win: Int) -> [Dot] {
        prepare(gray: gray, width: width, height: height, rowStride: rowStride, win: win)
        inv = false
        return candidates()
    }

    /// Takes the frame and thresholds it (step 1), once for both passes.
    private func prepare(gray: UnsafeBufferPointer<UInt8>, width: Int, height: Int, rowStride: Int, win: Int) {
        precondition(width > 0 && height > 0 && rowStride >= width, "bad image size")
        precondition(gray.count >= (height - 1) * rowStride + width, "image buffer too small")
        self.gray = gray.baseAddress!
        w = width
        h = height
        stride = rowStride
        threshold(win)
    }

    /// Steps 2-3 for the current pass: labels its dark, then returns the dot candidates.
    private func candidates() -> [Dot] {
        let n = label()
        var out: [Dot] = []
        for i in 0..<n {
            let m = moments + 6 * i
            let area = m[0]
            if area < Double(Self.minArea) { continue }
            let mx = m[1] / area
            let my = m[2] / area
            let cxx = m[3] / area - mx * mx
            let cyy = m[4] / area - my * my
            let cxy = m[5] / area - mx * my
            let half = (cxx + cyy) / 2
            let root = sqrt(max(0.0, (cxx - cyy) * (cxx - cyy) / 4 + cxy * cxy))
            let l1 = half + root
            let l2 = half - root
            if l2 <= 0 { continue }
            let a = 2 * sqrt(l1)
            let b = 2 * sqrt(l2)
            let fill = area / (Double.pi * a * b)
            if !(fill >= Self.fillMin && fill <= Self.fillMax) || b / a < Self.minAxisRatio { continue }
            out.append(Dot(first: cFirst[i], cx: mx, cy: my, a: a, b: b, phi: 0.5 * atan2(2 * cxy, cxx - cyy)))
        }
        return out // components are numbered in first-pixel order already
    }

    private static func ensure<T: BinaryInteger>(_ p: inout UnsafeMutablePointer<T>, _ cap: inout Int, _ n: Int) {
        if cap >= n { return }
        p.deallocate()
        p = .allocate(capacity: n)
        p.initialize(repeating: 0, count: n)
        cap = n
    }

    /// Step 1. A pixel is dark if v n < S - 7n, light if v n > S + 7n, over the win x win window
    /// clipped to the image. The integral image is Int32 with wrapping adds: it may wrap on huge
    /// images, but window sums (at most win^2 * 255) are exact in two's-complement arithmetic.
    private func threshold(_ win: Int) {
        let iw = w + 1
        Self.ensure(&integral, &integralCap, iw * (h + 1))
        Self.ensure(&state, &stateCap, w * h)
        let ii = integral, st = state, g = gray!
        for x in 0...w { ii[x] = 0 }
        for y in 0..<h {
            var row: Int32 = 0
            let src = y * stride
            let dst = (y + 1) * iw
            ii[dst] = 0
            for x in 0..<w {
                row &+= Int32(g[src + x])
                ii[dst + x + 1] = ii[dst - iw + x + 1] &+ row
            }
        }
        let r = win / 2
        let off = Self.offset
        for y in 0..<h {
            let y0 = max(y - r, 0)
            let y1 = min(y + r + 1, h)
            let ny = y1 - y0
            let top = y0 * iw
            let bot = y1 * iw
            let src = y * stride
            let out = y * w
            for x in 0..<w {
                let x0 = max(x - r, 0)
                let x1 = min(x + r + 1, w)
                let n = ny * (x1 - x0)
                let s = Int(ii[bot + x1] &- ii[top + x1] &- ii[bot + x0] &+ ii[top + x0])
                let vn = Int(g[src + x]) * n
                st[out + x] = vn < s - off * n ? Self.dark : (vn > s + off * n ? Self.light : 0)
            }
        }
    }

    /// Step 2. 8-connected components of dark (light in the inverted pass) by two-pass union-find.
    /// Roots are always the smallest label, so a component's root is the label of its first pixel
    /// and components are numbered in first-pixel raster order. Moments are summed in raster order,
    /// as numpy's bincount does.
    /// Returns the component count; stats are in `moments` and `cFirst`.
    private func label() -> Int {
        Self.ensure(&labels, &labelsCap, w * h)
        if unionCap < w * h + 2 {
            parent.deallocate()
            firstOf.deallocate()
            comp.deallocate()
            unionCap = w * h + 2
            parent = .allocate(capacity: unionCap)
            firstOf = .allocate(capacity: unionCap)
            comp = .allocate(capacity: unionCap)
            parent.initialize(repeating: 0, count: unionCap)
            firstOf.initialize(repeating: 0, count: unionCap)
            comp.initialize(repeating: 0, count: unionCap)
        }
        let lab = labels, st = state, par = parent, fo = firstOf, w = self.w, h = self.h
        let target = inv ? Self.light : Self.dark
        func find(_ x: Int32) -> Int32 {
            var a = Int(x)
            while par[a] != Int32(a) {
                par[a] = par[Int(par[a])]
                a = Int(par[a])
            }
            return Int32(a)
        }
        func union(_ a: Int32, _ b: Int32) -> Int32 {
            let ra = find(a)
            let rb = find(b)
            if ra < rb {
                par[Int(rb)] = ra
                return ra
            }
            par[Int(ra)] = rb
            return rb
        }
        var next: Int32 = 1
        for y in 0..<h {
            let row = y * w
            for x in 0..<w {
                let i = row + x
                if st[i] != target {
                    lab[i] = 0
                    continue
                }
                var l: Int32
                let up = i - w
                if x > 0 && lab[i - 1] != 0 {
                    l = lab[i - 1]
                    // NE touches W only through N
                    if y > 0 && x < w - 1 && lab[up] == 0 && lab[up + 1] != 0 { l = union(l, lab[up + 1]) }
                } else if y > 0 && lab[up] != 0 {
                    l = lab[up]
                } else {
                    let nw: Int32 = (y > 0 && x > 0) ? lab[up - 1] : 0
                    let ne: Int32 = (y > 0 && x < w - 1) ? lab[up + 1] : 0
                    l = (nw != 0 && ne != 0) ? union(nw, ne) : (nw != 0 ? nw : ne)
                }
                if l == 0 {
                    l = next
                    next += 1
                    par[Int(l)] = l
                    fo[Int(l)] = Int32(i)
                }
                lab[i] = l
            }
        }
        // number the roots in label order
        var n = 0
        for l in 1..<Int(next) where find(Int32(l)) == Int32(l) { n += 1 }
        if momentsCap < n {
            moments.deallocate()
            momentsCap = max(n, 2 * momentsCap)
            moments = .allocate(capacity: 6 * momentsCap)
        }
        moments.initialize(repeating: 0, count: 6 * n)
        cFirst.removeAll(keepingCapacity: true)
        let cp = comp
        var k: Int32 = 0
        for l in 1..<Int(next) {
            let root = find(Int32(l))
            if root == Int32(l) {
                cFirst.append(Int(fo[l]))
                cp[l] = k
                k += 1
            } else {
                cp[l] = cp[Int(root)]
            }
        }
        let mom = moments
        for y in 0..<h {
            let row = y * w
            let fy = Double(y)
            for x in 0..<w {
                let l = lab[row + x]
                if l == 0 { continue }
                let m = mom + 6 * Int(cp[Int(l)])
                let fx = Double(x)
                m[0] += 1
                m[1] += fx
                m[2] += fy
                m[3] += fx * fx
                m[4] += fy * fy
                m[5] += fx * fy
            }
        }
        return n
    }

    // MARK: - sampling

    /// Mask state at the nearest pixel, dark and light swapped in the inverted pass; undecided (0) off
    /// the image or at non-finite coordinates.
    private func nearest(_ x: Double, _ y: Double) -> Int8 {
        let i = Self.nearestIndex(x, y, w, h)
        if i < 0 { return 0 }
        return inv ? -state[i] : state[i]
    }

    private func px(_ x: Int, _ y: Int) -> Double { Double(gray![y * stride + x]) }

    /// Bilinear grey value, read as 255 - v in the inverted pass. Only ever called with finite
    /// coordinates (nearest/inside filter the rest).
    private func bilinear(_ xIn: Double, _ yIn: Double) -> Double {
        let x = min(max(xIn, 0.0), Double(w - 1) - 1e-6)
        let y = min(max(yIn, 0.0), Double(h - 1) - 1e-6)
        let x0 = floor(x)
        let y0 = floor(y)
        let fx = x - x0
        let fy = y - y0
        let xi = Int(x0)
        let yi = Int(y0)
        let top = px(xi, yi) * (1 - fx) + px(xi + 1, yi) * fx
        let bottom = px(xi, yi + 1) * (1 - fx) + px(xi + 1, yi + 1) * fx
        let v = top * (1 - fy) + bottom * fy
        return inv ? 255.0 - v : v
    }

    // MARK: - 4. finder ring

    /// Edge points relative to the dot centre into edgeX/edgeY; their count, or -1 if < 60.
    private func rayEdges(_ dot: Dot) -> Int {
        let fr = Frame.fromDot(dot)
        let rho0 = (1 - Self.edgeSlack) * Self.finderInner / Self.finderOuter
        let rho1 = 1 + Self.edgeSlack
        let n = Int(ceil((rho1 - rho0) * Self.finderOuter / Self.dotRef * dot.a / 0.5)) + 1
        if rho.count < n { rho = [Double](repeating: 0, count: n * 2) }
        let step = (rho1 - rho0) / Double(n - 1) // numpy linspace
        for k in 0..<n { rho[k] = Double(k) * step + rho0 }
        rho[n - 1] = rho1
        var count = 0
        for i in 0..<Self.rays {
            if count + (Self.rays - i) < Self.minEdgeRays { return -1 } // can't reach 60 edges any more
            let b = Double(i) * (360.0 / Double(Self.rays)) * degToRad
            let sb = sin(b)
            let cb = cos(b)
            var prev: Int8 = 0
            var prevRho = 0.0
            var edge = Double.nan
            for k in 0..<n {
                let r = rho[k]
                let p = fr.fromQ(r * sb, -r * cb)
                let st = nearest(p.0, p.1)
                if st == 0 { continue }
                if st == Self.light && prev == Self.dark { edge = 0.5 * (prevRho + r) }
                prev = st
                prevRho = r
            }
            if edge.isNaN { continue }
            let p = fr.fromQ(edge * sb, -edge * cb)
            edgeX[count] = p.0 - fr.cx
            edgeY[count] = p.1 - fr.cy
            count += 1
        }
        return count < Self.minEdgeRays ? -1 : count
    }

    /// (frame, conic) of the finder ring's outer edge, or nil.
    private func finder(_ dot: Dot) -> (Frame, [Double])? {
        let n = rayEdges(dot)
        if n < 0 { return nil }
        var conic = Self.fitConic(edgeX, edgeY, n)
        var fr = Frame.fromConic(conic, dot.cx, dot.cy)
        for _ in 0..<Self.trimPasses {
            guard let f = fr else { return nil }
            for k in 0..<n { rad[k] = f.radiusOf(edgeX[k], edgeY[k]) }
            let sorted = rad[0..<n].sorted()
            let med = n % 2 == 1 ? sorted[n / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2
            var m = 0
            for k in 0..<n where abs(rad[k] / med - 1) <= Self.trim {
                keptX[m] = edgeX[k]
                keptY[m] = edgeY[k]
                m += 1
            }
            if m < Self.minEdgeRays { return nil }
            conic = Self.fitConic(keptX, keptY, m)
            fr = Frame.fromConic(conic, dot.cx, dot.cy)
        }
        guard let f = fr, let c = conic else { return nil }
        return (f, c)
    }

    // MARK: - 5, 6. gap and cells

    private func readCells(_ dot: Dot) -> Cells? {
        guard let found = finder(dot) else { return nil }
        let (fr, conic) = found
        seenConic = conic
        let nb = Self.gapSamples
        var anyLight = false
        var allLight = true
        var anyDark = false
        for j in 0..<nb {
            let p = fr.toImage(Self.gapRho, Double(j) * Self.gapStepDeg)
            gapX[j] = p.0
            gapY[j] = p.1
            let st = nearest(p.0, p.1)
            gapState[j] = st
            if st == Self.light { anyLight = true } else { allLight = false }
            if st == Self.dark { anyDark = true }
        }
        if !anyLight || allLight || !anyDark { return nil }

        // circular runs of light, scanning from the first non-light sample; keep the first longest
        var first = 0
        while gapState[first] == Self.light { first += 1 }
        var bestStart = -1
        var bestLen = 0
        var otherMax = 0
        var k = 0
        while k < nb {
            if gapState[(first + k) % nb] == Self.light {
                var j = k
                while j < nb && gapState[(first + j) % nb] == Self.light { j += 1 }
                let len = j - k
                if len > bestLen {
                    otherMax = max(otherMax, bestLen)
                    bestLen = len
                    bestStart = (first + k) % nb
                } else {
                    otherMax = max(otherMax, len)
                }
                k = j
            } else {
                k += 1
            }
        }
        let gapDeg = Double(bestLen) * Self.gapStepDeg
        if gapDeg < Self.gapMinDeg || gapDeg > Self.gapMaxDeg { return nil }
        if Double(otherMax) * Self.gapStepDeg > Self.otherLightMaxDeg { return nil }

        var darkSum = 0.0
        var darkN = 0
        for j in 0..<nb where gapState[j] == Self.dark {
            darkSum += bilinear(gapX[j], gapY[j])
            darkN += 1
        }
        var lightSum = 0.0
        for i in 0..<bestLen {
            let j = (bestStart + i) % nb
            lightSum += bilinear(gapX[j], gapY[j])
        }
        let dark = darkSum / Double(darkN)
        let light = lightSum / Double(bestLen)
        if light - dark < Self.minContrast { return nil }
        let betaG = (Double(bestStart) + Double(bestLen - 1) / 2.0) * Self.gapStepDeg
        let g = fr.toImage(Self.gapRho, betaG)
        let rotation = Self.mod(atan2(g.0 - dot.cx, -(g.1 - dot.cy)) * radToDeg, 360.0)

        var cells = [Bool?](repeating: nil, count: RingCodec.cells)
        for (ring, r) in Self.codeRingsRef.enumerated() {
            let m = (r.0 + r.1) / 2
            let rIn = (m - Self.cellDeltaMm) / Self.finderOuter
            let rMid = m / Self.finderOuter
            let rOut = (m + Self.cellDeltaMm) / Self.finderOuter
            for c in 0..<Self.perRing {
                let mu = betaG + Double(c) * Self.cellDeg + Self.cellDeg / 2
                sample(fr, 0, rMid, mu)
                sample(fr, 1, rMid, mu - Self.cellDeltaDeg)
                sample(fr, 2, rMid, mu + Self.cellDeltaDeg)
                sample(fr, 3, rIn, mu)
                sample(fr, 4, rOut, mu)
                var off = false
                for q in 0..<5 where !Self.inside(cellX[q], cellY[q], w, h) { off = true }
                if off { continue } // can't be judged: erasure
                var v = 0.0
                for q in 0..<5 { v += bilinear(cellX[q], cellY[q]) }
                let t = (v / 5 - dark) / (light - dark)
                cells[ring * Self.perRing + c] = t < Self.tOn ? true : (t > Self.tOff ? false : nil)
            }
        }
        return Cells(cells: cells, conic: conic, rotation: rotation)
    }

    private func sample(_ fr: Frame, _ q: Int, _ rho: Double, _ beta: Double) {
        let p = fr.toImage(rho, beta)
        cellX[q] = p.0
        cellY[q] = p.1
    }

    // MARK: - constants and pure helpers

    /// Index of the pixel nearest (x, y) in a `w` x `h` image, or -1 off the image. NaN or infinite
    /// coordinates are off the image.
    static func nearestIndex(_ x: Double, _ y: Double, _ w: Int, _ h: Int) -> Int {
        if !x.isFinite || !y.isFinite { return -1 }
        let xi = floor(x + 0.5)
        let yi = floor(y + 0.5)
        if xi < 0 || yi < 0 || xi >= Double(w) || yi >= Double(h) { return -1 }
        return Int(yi) * w + Int(xi)
    }

    /// Whether (x, y) lies in [0, w - 1] x [0, h - 1]; NaN or infinite coordinates do not.
    static func inside(_ x: Double, _ y: Double, _ w: Int, _ h: Int) -> Bool {
        x.isFinite && y.isFinite && x >= 0 && x <= Double(w - 1) && y >= 0 && y <= Double(h - 1)
    }

    private static let dark: Int8 = 1
    private static let light: Int8 = -1
    private static let offset = 7
    private static let minArea = 30
    private static let fillMin = 0.85
    private static let fillMax = 1.15
    private static let minAxisRatio = 0.5
    private static let rays = 90
    private static let minEdgeRays = 60
    private static let edgeSlack = 0.20
    private static let trim = 0.10
    private static let trimPasses = 3
    private static let gapRho = 66.0 / 70.0
    private static let gapStepDeg = 0.5
    private static let gapSamples = 720
    private static let gapMinDeg = 10.0
    private static let gapMaxDeg = 22.0
    private static let otherLightMaxDeg = 4.0
    private static let tOn = 0.4
    private static let tOff = 0.6
    private static let cellDeltaDeg = 3.0
    private static let cellDeltaMm = 1.0
    private static let minContrast = Double(2 * offset)
    private static let pivotEps = 1e-9

    // layout.py, in ref mm at the 140 mm reference size
    private static let finderInner = 62.0
    private static let finderOuter = 70.0
    private static let dotRef = 12.0
    private static let perRing = 24
    private static let cellDeg = 360.0 / Double(perRing)
    private static let codeRingsRef: [(Double, Double)] = [(51, 59), (40, 48), (29, 37)] // ring 0 outermost

    static func windowSize(_ width: Int) -> Int { max(51, width / 25) | 1 }

    private static func mod(_ a: Double, _ m: Double) -> Double {
        let r = a.truncatingRemainder(dividingBy: m)
        return r < 0 ? r + m : r
    }

    /// Least squares A x^2 + B xy + C y^2 + D x + E y = 1 over the first `n` points (normal
    /// equations on points scaled by 1/RMS radius), or nil if the normal matrix is singular.
    static func fitConic(_ xs: [Double], _ ys: [Double], _ n: Int) -> [Double]? {
        var ss = 0.0
        for i in 0..<n { ss += xs[i] * xs[i] + ys[i] * ys[i] }
        let l = sqrt(ss / Double(n))
        var ata = [[Double]](repeating: [Double](repeating: 0, count: 6), count: 5)
        var row = [Double](repeating: 0, count: 5)
        for i in 0..<n {
            let u = xs[i] / l
            let v = ys[i] / l
            row[0] = u * u
            row[1] = u * v
            row[2] = v * v
            row[3] = u
            row[4] = v
            for r in 0..<5 {
                for c in 0..<5 { ata[r][c] += row[r] * row[c] }
                ata[r][5] += row[r]
            }
        }
        guard let x = solve(&ata) else { return nil }
        let l2 = l * l
        return [x[0] / l2, x[1] / l2, x[2] / l2, x[3] / l, x[4] / l]
    }

    /// Gaussian elimination with partial pivoting on an augmented n x (n+1) matrix (destroyed).
    private static func solve(_ m: inout [[Double]]) -> [Double]? {
        let n = m.count
        for c in 0..<n {
            var p = c
            for r in (c + 1)..<n where abs(m[r][c]) > abs(m[p][c]) { p = r }
            if abs(m[p][c]) < pivotEps { return nil }
            m.swapAt(c, p)
            for r in (c + 1)..<n {
                let f = m[r][c] / m[c][c]
                for k in c...n { m[r][k] -= f * m[c][k] }
            }
        }
        var x = [Double](repeating: 0, count: n)
        for r in Swift.stride(from: n - 1, through: 0, by: -1) {
            var s = 0.0
            for k in (r + 1)..<n { s += m[r][k] * x[k] }
            x[r] = (m[r][n] - s) / m[r][r]
        }
        return x
    }

    /// Semi-major, semi-minor and major-axis angle (degrees in [0, 180), from +x toward +y) of the
    /// conic's ellipse: Q = [[A, B/2], [B/2, C]], x0 = -Q^-1 (D, E) / 2, kappa = 1 + x0^T Q x0.
    private static func conicEllipse(_ conic: [Double]) -> (Double, Double, Double) {
        let a = conic[0], b = conic[1], c = conic[2], d = conic[3], e = conic[4]
        let hb = b / 2
        let det = a * c - hb * hb
        let x0 = -0.5 * (d * c - hb * e) / det
        let y0 = -0.5 * (a * e - hb * d) / det
        let kappa = 1 + (x0 * (a * x0 + hb * y0) + y0 * (hb * x0 + c * y0))
        let q = Sym2(a, hb, c)
        // the major axis belongs to the small eigenvalue, perpendicular to (c, s)
        let angle = mod(atan2(q.s, q.c) * radToDeg + 90.0, 180.0)
        return (sqrt(kappa / q.wSmall), sqrt(kappa / q.wLarge), angle)
    }
}

// Java's Math.toRadians / toDegrees multiply by these same constants.
private let degToRad = Double.pi / 180
private let radToDeg = 180 / Double.pi
