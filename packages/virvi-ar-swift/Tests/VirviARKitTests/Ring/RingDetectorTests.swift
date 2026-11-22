import Foundation
import ImageIO
import XCTest
@testable import VirviARKit

/// An 8-bit grey image, row-major, no padding.
struct TestsetImage {
    var gray: [UInt8]
    var width: Int
    var height: Int
}

/// Mirrors apps/quest/app/src/test/java/io/virvi/ar/ring/RingDetectorTest.kt (itself mirroring
/// apps/ring-marker/tests/test_detect.py) on the synthetic test set in apps/ring-marker/testset.
final class RingDetectorTests: XCTestCase {
    struct Marker {
        var id: UInt32
        var center: (Double, Double)
        var rotationDeg: Double
    }

    struct Entry {
        var name: String
        var kind: String
        var expectNone: Bool
        var markers: [Marker]
        var image: TestsetImage
    }

    // MARK: - fixture

    /// .../packages/virvi-ar-swift/Tests/VirviARKitTests/Ring/RingDetectorTests.swift -> repo root
    static let testsetDir: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { url.deleteLastPathComponent() }
        return url.appendingPathComponent("apps/ring-marker/testset")
    }()

    static let missingMessage =
        "Ring test set not found at \(testsetDir.path). Generate it first: " +
        "cd apps/ring-marker && python3 -m ringmarker.testset testset"

    private static var cachedManifest: [Entry]?
    private static var cachedFocal: Double = 0
    private static var cachedDetections: [String: [RingDetection]] = [:]

    private func manifest() throws -> [Entry] {
        if let m = Self.cachedManifest { return m }
        let url = Self.testsetDir.appendingPathComponent("manifest.json")
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw NSError(domain: "RingDetectorTests", code: 2, userInfo: [NSLocalizedDescriptionKey: Self.missingMessage])
        }
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [[String: Any]])
        XCTAssertEqual(root.count, 38)
        var focals = Set<Double>()
        let entries: [Entry] = try root.map { o in
            focals.insert((o["focal_px"] as! NSNumber).doubleValue)
            let markers = (o["markers"] as! [[String: Any]]).map { m -> Marker in
                let c = m["center_px"] as! [NSNumber]
                return Marker(id: (m["id"] as! NSNumber).uint32Value,
                              center: (c[0].doubleValue, c[1].doubleValue),
                              rotationDeg: (m["rotation_deg"] as! NSNumber).doubleValue)
            }
            return Entry(name: o["name"] as! String, kind: o["case"] as! String,
                         expectNone: (o["expect"] as! String) == "none", markers: markers,
                         image: try Self.loadImage(Self.testsetDir.appendingPathComponent(o["file"] as! String)))
        }
        XCTAssertEqual(focals.count, 1, "test set mixes focal lengths: \(focals)")
        Self.cachedFocal = focals.first ?? 0
        Self.cachedManifest = entries
        let d = RingDetector()
        for e in entries { Self.cachedDetections[e.name] = detect(d, e.image) }
        return entries
    }

    private func detections(_ name: String) throws -> [RingDetection] {
        _ = try manifest()
        return try XCTUnwrap(Self.cachedDetections[name], name)
    }

    private func entry(_ name: String) throws -> Entry {
        try XCTUnwrap(try manifest().first { $0.name == name }, name)
    }

    /// Reads an 8-bit grey PNG's samples as stored (no colour conversion).
    static func loadImage(_ url: URL) throws -> TestsetImage {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
            throw NSError(domain: "RingDetectorTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "can't read \(url.path)"])
        }
        XCTAssertEqual(img.bitsPerPixel, 8, "\(url.lastPathComponent) is not 8-bit grey")
        XCTAssertEqual(img.colorSpace?.model, .monochrome, "\(url.lastPathComponent) is not grey")
        let w = img.width, h = img.height, bpr = img.bytesPerRow
        let data = try XCTUnwrap(img.dataProvider?.data) as Data
        var out = [UInt8](repeating: 0, count: w * h)
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            out.withUnsafeMutableBytes { dst in
                for y in 0..<h { dst.baseAddress!.advanced(by: y * w).copyMemory(from: raw.baseAddress!.advanced(by: y * bpr), byteCount: w) }
            }
        }
        return TestsetImage(gray: out, width: w, height: h)
    }

    // MARK: - helpers

    private func detect(_ d: RingDetector, _ im: TestsetImage, stride: Int? = nil) -> [RingDetection] {
        frame(d, im, stride: stride).detections
    }

    private func frame(_ d: RingDetector, _ im: TestsetImage, stride: Int? = nil) -> RingFrame {
        im.gray.withUnsafeBufferPointer { d.detectFrame(gray: $0, width: im.width, height: im.height, rowStride: stride ?? im.width) }
    }

    private func hex(_ found: [RingDetection]) -> [String] { found.map { "0x" + String($0.id, radix: 16) } }

    private func angleDiff(_ a: Double, _ b: Double) -> Double {
        let r = (a - b + 180).truncatingRemainder(dividingBy: 360)
        return (r < 0 ? r + 360 : r) - 180
    }

    // MARK: - tests

    func testTestsetCases() throws {
        var failures: [String] = []
        for e in try manifest() {
            let found = try detections(e.name)
            if e.expectNone {
                if !found.isEmpty { failures.append("\(e.name): expected none, got \(hex(found))") }
                continue
            }
            let want = Set(e.markers.map(\.id))
            if Set(found.map(\.id)) != want || found.count != want.count {
                failures.append("\(e.name): ids \(hex(found)), want \(want.map { "0x" + String($0, radix: 16) })")
                continue
            }
            for m in e.markers {
                let d = found.first { $0.id == m.id }!
                let err = hypot(d.cx - m.center.0, d.cy - m.center.1)
                if err > 3 { failures.append("\(e.name): centre error \(err)") }
                let rot = abs(angleDiff(d.rotationDeg, m.rotationDeg))
                if rot > 2 { failures.append("\(e.name): rotation \(d.rotationDeg), want \(m.rotationDeg)") }
            }
        }
        XCTAssertTrue(failures.isEmpty, failures.joined(separator: "\n"))
    }

    func testNeverWrongId() throws {
        for e in try manifest() {
            let drawn = Set(e.markers.map(\.id))
            for d in try detections(e.name) {
                XCTAssertTrue(drawn.contains(d.id), "\(e.name): 0x\(String(d.id, radix: 16))")
            }
        }
    }

    /// The farthest, most oblique small marker: allowed to be missed, never misread.
    func testFarObliqueReportsNothingItShouldNot() throws {
        let e = try entry("range-RING120-1.8-45")
        let f = frame(RingDetector(), e.image)
        XCTAssertTrue(f.detections.allSatisfy { $0.id == e.markers[0].id }, "\(hex(f.detections))")
        XCTAssertLessThanOrEqual(f.detections.count, 1)
        XCTAssertLessThanOrEqual(f.unreadable.count, 1)
    }

    func testRotationReported() throws {
        for (name, want) in [("rotated_73", 73.0), ("rotated_180", 180.0)] {
            let found = try detections(name)
            XCTAssertEqual(found.count, 1, name)
            guard let d = found.first else { continue }
            XCTAssertLessThanOrEqual(abs(angleDiff(d.rotationDeg, want)), 2, "\(name): \(d.rotationDeg)")
        }
    }

    func testDetectFrameTiming() throws {
        let range = try manifest().filter { $0.kind == "range" }
        XCTAssertEqual(range.count, 27)
        let detector = RingDetector()
        for e in range { _ = frame(detector, e.image) }
        var times: [Double] = []
        for e in range {
            let t0 = DispatchTime.now().uptimeNanoseconds
            _ = frame(detector, e.image)
            times.append(Double(DispatchTime.now().uptimeNanoseconds - t0) / 1e6)
        }
        times.sort()
        print(String(format: "RingDetector median over %d range images: %.2f ms", times.count, times[times.count / 2]))
        let one = try entry("range-RING140-1.2-0").image
        measure { _ = frame(detector, one) }
    }

    /// A marker partly out of frame decodes to its own id or not at all; cells sampled off the image
    /// are erasures. The frontal 0.6 m RING140 view is cropped so its centre ends 20-80 px from an edge.
    func testCroppedMarkerErasesOffImageCells() throws {
        let src = try entry("range-RING140-0.6-0")
        let id = src.markers[0].id
        let ppm = Self.cachedFocal / 600.0 // px per mm, frontal at 0.6 m
        let detector = RingDetector()
        var checked = 0
        var foundAny = 0
        for cut in Swift.stride(from: 560, to: 620, by: 6) {
            for side in ["left", "right", "top", "bottom"] {
                let im = crop(src.image, side, cut)
                let found = detect(detector, im)
                XCTAssertTrue(found.allSatisfy { $0.id == id }, "\(side) \(cut): \(hex(found))")
                if found.isEmpty { continue }
                foundAny += 1
                let cx = 639.5 - (side == "left" ? Double(cut) : 0)
                let cy = 479.5 - (side == "top" ? Double(cut - 160) : 0)
                let cells = try XCTUnwrap(im.gray.withUnsafeBufferPointer {
                    detector.readCellsNear(gray: $0, width: im.width, height: im.height, rowStride: im.width, x: cx, y: cy)
                })
                let rings: [(Double, Double)] = [(51, 59), (40, 48), (29, 37)]
                for (ring, r) in rings.enumerated() {
                    let m = (r.0 + r.1) / 2
                    for k in 0..<24 {
                        let mu = Double(k) * 15 + 7.5
                        let pts: [(Double, Double)] = [(m, mu), (m, mu - 3), (m, mu + 3), (m - 1, mu), (m + 1, mu)]
                        let farOut = pts.contains { rr, a in
                            let x = cx + ppm * rr * sin(a * .pi / 180)
                            let y = cy - ppm * rr * cos(a * .pi / 180)
                            return x < -2 || x > Double(im.width) + 1 || y < -2 || y > Double(im.height) + 1
                        }
                        if farOut {
                            XCTAssertNil(cells[ring * 24 + k], "\(side) \(cut) ring \(ring) cell \(k)")
                            checked += 1
                        }
                    }
                }
            }
        }
        XCTAssertGreaterThan(foundAny, 0)
        XCTAssertGreaterThan(checked, 0)
    }

    func testDegenerateInputsRejectWithoutRaising() {
        let xs = [Double](repeating: 1, count: 70) // all edges at one point: singular normal matrix
        let ys = [Double](repeating: 2, count: 70)
        XCTAssertNil(RingDetector.fitConic(xs, ys, 70))
        XCTAssertNil(RingDetector.Frame.fromConic(nil, 0, 0))
        let detector = RingDetector()
        let grey = TestsetImage(gray: [UInt8](repeating: 128, count: 120 * 160), width: 160, height: 120)
        XCTAssertEqual(detect(detector, grey), [])
        let black = TestsetImage(gray: [UInt8](repeating: 0, count: 120 * 160), width: 160, height: 120)
        XCTAssertEqual(detect(detector, black), [])
    }

    func testNonFiniteSamplesAreOffImage() {
        let nan = Double.nan
        let inf = Double.infinity
        XCTAssertEqual(RingDetector.nearestIndex(1, 1, 5, 4), 6)
        for (x, y) in [(nan, 1.0), (1.0, nan), (inf, 1.0), (-inf, 1.0), (1.0, inf)] {
            XCTAssertEqual(RingDetector.nearestIndex(x, y, 5, 4), -1, "nearest (\(x), \(y))")
            XCTAssertFalse(RingDetector.inside(x, y, 5, 4), "inside (\(x), \(y))")
        }
        XCTAssertEqual(RingDetector.nearestIndex(4.6, 1, 5, 4), -1)
        XCTAssertTrue(RingDetector.inside(0, 3, 5, 4) && RingDetector.inside(4, 0, 5, 4))
        XCTAssertFalse(RingDetector.inside(4.01, 0, 5, 4))
    }

    func testBlobOrderIsRasterOrder() {
        let w = 60
        var img = [UInt8](repeating: 200, count: w * 60)
        for y in 40..<50 { for x in 5..<15 { img[y * w + x] = 0 } } // lower blob, left
        for y in 5..<15 { for x in 40..<50 { img[y * w + x] = 0 } } // upper blob, right: first
        let order = img.withUnsafeBufferPointer {
            RingDetector().dotCandidates(gray: $0, width: w, height: 60, rowStride: w, win: 15)
        }
        XCTAssertEqual(order.map(\.first), order.map(\.first).sorted())
        XCTAssertFalse(order.isEmpty)
        XCTAssertLessThan(order.first?.cy ?? 99, 30)
    }

    func testRowStrideIsHonoured() throws {
        let e = try entry("two_markers")
        let stride = e.image.width + 13
        var padded = [UInt8](repeating: 77, count: stride * e.image.height)
        for y in 0..<e.image.height {
            for x in 0..<e.image.width { padded[y * stride + x] = e.image.gray[y * e.image.width + x] }
        }
        let im = TestsetImage(gray: padded, width: e.image.width, height: e.image.height)
        XCTAssertEqual(detect(RingDetector(), im, stride: stride), try detections("two_markers"))
    }

    /// RING170 at 0.6 m downscaled by 0.5 has the dot and finder ring but not the code.
    func testARingTooSmallToReadIsReportedUnreadable() throws {
        let e = try entry("range-RING170-0.6-0")
        let c = e.markers[0].center
        let s = 0.5
        let im = downscale(e.image, s)
        let f = frame(RingDetector(), im)
        XCTAssertTrue(f.detections.isEmpty, "detections \(hex(f.detections))")
        XCTAssertEqual(f.unreadable.count, 1)
        guard let u = f.unreadable.first else { return }
        let err = hypot(u.cx - c.0 * s, u.cy - c.1 * s)
        XCTAssertLessThanOrEqual(err, 10, "centre error \(err)")
        XCTAssertGreaterThan(u.semiMajor, 0)
    }

    func testAReadableRingIsNotAlsoUnreadable() throws {
        let e = try entry("range-RING170-0.6-0")
        let f = frame(RingDetector(), e.image)
        XCTAssertEqual(f.detections.count, 1)
        XCTAssertTrue(f.unreadable.isEmpty)
    }

    func testABlankFrameAndTheDecoysReportNothing() throws {
        let detector = RingDetector()
        let blank = frame(detector, TestsetImage(gray: [UInt8](repeating: 128, count: 120 * 160), width: 160, height: 120))
        XCTAssertTrue(blank.detections.isEmpty && blank.unreadable.isEmpty)
        // decoy_disc_in_ring yields an unreadable candidate (a finder ring round a dot with no code):
        // that only shows "Step closer", so it is not asserted here.
        let decoys = try manifest().filter { $0.name.hasPrefix("decoy") && $0.name != "decoy_disc_in_ring" }
        XCTAssertEqual(decoys.count, 3)
        for e in decoys {
            let f = frame(detector, e.image)
            XCTAssertTrue(f.unreadable.isEmpty, "\(e.name): \(f.unreadable)")
        }
    }

    // MARK: - image helpers

    /// Nearest-neighbour downscale by `factor`.
    private func downscale(_ img: TestsetImage, _ factor: Double) -> TestsetImage {
        let w = Int(Double(img.width) * factor)
        let h = Int(Double(img.height) * factor)
        var out = [UInt8](repeating: 0, count: w * h)
        for y in 0..<h {
            let sy = min(Int(Double(y) / factor), img.height - 1)
            for x in 0..<w { out[y * w + x] = img.gray[sy * img.width + min(Int(Double(x) / factor), img.width - 1)] }
        }
        return TestsetImage(gray: out, width: w, height: h)
    }

    private func crop(_ img: TestsetImage, _ side: String, _ cut: Int) -> TestsetImage {
        let (x0, y0, x1, y1): (Int, Int, Int, Int)
        switch side {
        case "left": (x0, y0, x1, y1) = (cut, 0, img.width, img.height)
        case "right": (x0, y0, x1, y1) = (0, 0, img.width - cut, img.height)
        case "top": (x0, y0, x1, y1) = (0, cut - 160, img.width, img.height)
        default: (x0, y0, x1, y1) = (0, 0, img.width, img.height - cut + 160)
        }
        let w = x1 - x0
        var out = [UInt8](repeating: 0, count: w * (y1 - y0))
        for y in y0..<y1 { for x in 0..<w { out[(y - y0) * w + x] = img.gray[y * img.width + x0 + x] } }
        return TestsetImage(gray: out, width: w, height: y1 - y0)
    }
}
