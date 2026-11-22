import XCTest
@testable import VirviARKit

/// Mirrors apps/quest/app/src/test/java/io/virvi/ar/ring/RingTrackerTest.kt.
final class RingTrackerTests: XCTestCase {
    private func det(_ id: UInt32, version: Int = 0) -> RingDetection {
        RingDetection(id: id, version: version, corrected: 0, cx: 640, cy: 480,
                      semiMajor: 50, semiMinor: 45, angleDeg: 0, rotationDeg: 0)
    }

    func testNeedsThreeFrames() {
        let t = RingTracker(registered: [7])
        XCTAssertTrue(t.update([det(7)]).isEmpty)
        XCTAssertTrue(t.update([det(7)]).isEmpty)
        XCTAssertEqual(t.update([det(7)]).map(\.id), [7])
        XCTAssertEqual(t.update([det(7)]).map(\.id), [7])
    }

    func testMissResets() {
        let t = RingTracker(registered: [7])
        for _ in 0..<3 { _ = t.update([det(7)]) }
        XCTAssertTrue(t.update([]).isEmpty)
        XCTAssertTrue(t.update([det(7)]).isEmpty)
        XCTAssertTrue(t.update([det(7)]).isEmpty)
        XCTAssertEqual(t.update([det(7)]).map(\.id), [7])
    }

    func testUnregisteredIgnored() {
        let t = RingTracker(registered: [7])
        for _ in 0..<10 { XCTAssertTrue(t.update([det(9)]).isEmpty) }
        for _ in 0..<2 { _ = t.update([det(7), det(9)]) }
        XCTAssertEqual(t.update([det(7), det(9)]).map(\.id), [7])
    }

    func testResetForgetsStreaks() {
        let t = RingTracker(registered: [7])
        for _ in 0..<2 { _ = t.update([det(7)]) }
        t.reset()
        XCTAssertTrue(t.update([det(7)]).isEmpty)
        XCTAssertTrue(t.update([det(7)]).isEmpty)
        XCTAssertEqual(t.update([det(7)]).map(\.id), [7])
    }

    func testSameIdTwiceInOneFrameCountsOnce() {
        let t = RingTracker(registered: [7])
        XCTAssertTrue(t.update([det(7), det(7)]).isEmpty)
        XCTAssertTrue(t.update([det(7)]).isEmpty)
        XCTAssertEqual(t.update([det(7), det(7)]).map(\.id), [7])
    }

    func testUnsupportedVersionIgnored() {
        let t = RingTracker(registered: [7])
        for _ in 0..<10 { XCTAssertTrue(t.update([det(7, version: 1)]).isEmpty) }
        for _ in 0..<2 { _ = t.update([det(7, version: 3), det(7)]) }
        XCTAssertEqual(t.update([det(7, version: 15), det(7)]).map(\.version), [0])
    }

    func testNearestToCentrePicksTheMiddleMarker() {
        func at(_ id: UInt32, _ x: Double, _ y: Double) -> RingDetection {
            RingDetection(id: id, version: 0, corrected: 0, cx: x, cy: y,
                          semiMajor: 50, semiMinor: 45, angleDeg: 0, rotationDeg: 0)
        }
        let picked = nearestToCentre([at(1, 100, 100), at(2, 650, 470), at(3, 1200, 900)], width: 1280, height: 960)
        XCTAssertEqual(picked?.id, 2)
        XCTAssertNil(nearestToCentre([], width: 1280, height: 960))
    }

    func testNilAcceptsAnyRing() {
        let t = RingTracker(registered: nil)
        for _ in 0..<2 { _ = t.update([det(9)]) }
        XCTAssertEqual(t.update([det(9)]).map(\.id), [9])
    }

    func testRegisteredCanChange() {
        let t = RingTracker(registered: nil)
        for _ in 0..<3 { _ = t.update([det(9), det(7)]) }
        t.registered = [7]
        XCTAssertEqual(t.update([det(9), det(7)]).map(\.id), [7])
        t.registered = nil
        for _ in 0..<2 { _ = t.update([det(9)]) }
        XCTAssertEqual(t.update([det(9)]).map(\.id), [9])
    }
}
