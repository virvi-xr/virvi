import XCTest
@testable import VirviARKit

/// Mirrors apps/quest/app/src/test/java/io/virvi/ar/visitor/TrackingWatchTest.kt.
final class TrackingWatchTests: XCTestCase {
    /// One 72 Hz frame (the Quest's; the watch only cares about the time between calls).
    private let tick = 1.0 / 72

    private func at(_ x: Double) -> Vec3 { Vec3(x: x, y: 1.6, z: 0) }

    func testSteadyWalkingIsNotAJump() {
        let w = TrackingWatch()
        for i in 0...20 { XCTAssertFalse(w.onHead(at(Double(i) * 0.02), yawDeg: Double(i), dtS: tick)) }
    }

    func testA0_4mStepInOneFrameIsAJump() {
        let w = TrackingWatch()
        _ = w.onHead(at(0), yawDeg: 0, dtS: tick)
        XCTAssertTrue(w.onHead(at(0.4), yawDeg: 0, dtS: tick))
    }

    func testA30DegreeYawSnapInOneFrameIsAJumpAlsoAcrossTheWrap() {
        let w = TrackingWatch()
        _ = w.onHead(at(0), yawDeg: 350, dtS: tick)
        XCTAssertTrue(w.onHead(at(0), yawDeg: 20, dtS: tick))
    }

    func testASmallTurnAcrossTheWrapIsNotAJump() {
        let w = TrackingWatch()
        _ = w.onHead(at(0), yawDeg: 355, dtS: tick)
        XCTAssertFalse(w.onHead(at(0), yawDeg: 5, dtS: tick))
    }

    func testTheFirstCallAfterResetIsNotAJump() {
        let w = TrackingWatch()
        _ = w.onHead(at(0), yawDeg: 0, dtS: tick)
        w.reset()
        XCTAssertFalse(w.onHead(at(5), yawDeg: 90, dtS: tick))
    }

    func testAfterAJumpTheNewPlaceIsTheBaseline() {
        let w = TrackingWatch()
        _ = w.onHead(at(0), yawDeg: 0, dtS: tick)
        _ = w.onHead(at(3), yawDeg: 0, dtS: tick)
        XCTAssertFalse(w.onHead(at(3.02), yawDeg: 0, dtS: tick))
    }

    func testAStalledTickWhileWalkingBrisklyIsNotAJump() {
        // 0.3 s stalled at 2 m/s: 0.6 m, under the 0.75 m that 0.3 s allows.
        let w = TrackingWatch()
        _ = w.onHead(at(0), yawDeg: 0, dtS: tick)
        XCTAssertFalse(w.onHead(at(0.6), yawDeg: 0, dtS: 0.3))
        // and turning at 200°/s through the same stall: 60°, under 90°
        XCTAssertFalse(w.onHead(at(0.6), yawDeg: 60, dtS: 0.3))
    }

    func testAMoveFasterThanWalkingOverAStalledTickIsAJump() {
        let w = TrackingWatch()
        _ = w.onHead(at(0), yawDeg: 0, dtS: tick)
        XCTAssertTrue(w.onHead(at(1), yawDeg: 0, dtS: 0.3)) // 3.3 m/s
        XCTAssertTrue(w.onHead(at(1), yawDeg: 100, dtS: 0.3)) // 333°/s
    }

    func testALongGapAllowsNoMoreThanHalfASecond() {
        let w = TrackingWatch()
        _ = w.onHead(at(0), yawDeg: 0, dtS: tick)
        // 2 s gap: the allowance stays at 0.5 s (1.25 m, 150°)
        XCTAssertFalse(w.onHead(at(1.2), yawDeg: 0, dtS: 2))
        XCTAssertTrue(w.onHead(at(2.6), yawDeg: 0, dtS: 2))
        XCTAssertFalse(w.onHead(at(2.6), yawDeg: 140, dtS: 2))
        XCTAssertTrue(w.onHead(at(2.6), yawDeg: 300, dtS: 2)) // a 160° turn
    }
}
