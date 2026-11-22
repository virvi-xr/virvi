import XCTest
@testable import VirviARKit

/// Mirrors apps/quest/app/src/test/java/io/virvi/ar/visitor/LockGateTest.kt.
final class LockGateTests: XCTestCase {
    func testTooFewFramesIsGathering() {
        XCTAssertEqual(LockGate.evaluate(count: 4, spreadM: 0.004, headingSpreadDeg: 0.5, distanceM: 1.2), .gathering)
    }

    func testFarAwayIsTooFar() {
        XCTAssertEqual(LockGate.evaluate(count: 5, spreadM: 0.004, headingSpreadDeg: 0.5, distanceM: 1.6), .tooFar)
    }

    func testCloseAndStillIsSteady() {
        XCTAssertEqual(LockGate.evaluate(count: 5, spreadM: 0.004, headingSpreadDeg: 0.5, distanceM: 1.2), .steady)
    }

    func testWidePositionSpreadIsGathering() {
        XCTAssertEqual(LockGate.evaluate(count: 5, spreadM: 0.02, headingSpreadDeg: 0.5, distanceM: 1.2), .gathering)
    }

    func testWideHeadingSpreadIsGathering() {
        XCTAssertEqual(LockGate.evaluate(count: 5, spreadM: 0.004, headingSpreadDeg: 2.0, distanceM: 1.2), .gathering)
    }

    func testNonFiniteInputsAreGathering() {
        XCTAssertEqual(LockGate.evaluate(count: 5, spreadM: .nan, headingSpreadDeg: 0.5, distanceM: 1.2), .gathering)
        XCTAssertEqual(LockGate.evaluate(count: 5, spreadM: 0.004, headingSpreadDeg: .nan, distanceM: 1.2), .gathering)
        XCTAssertEqual(LockGate.evaluate(count: 5, spreadM: 0.004, headingSpreadDeg: 0.5, distanceM: .nan), .gathering)
        XCTAssertEqual(LockGate.evaluate(count: 5, spreadM: 0.004, headingSpreadDeg: 0.5, distanceM: .infinity), .gathering)
    }

    func testTheTuningIsTheQuests() {
        XCTAssertEqual(VisitorTuning.MAX_LOCK_DISTANCE_M, 1.5)
        XCTAssertEqual(VisitorTuning.MIN_FRAMES, 5)
        XCTAssertEqual(VisitorTuning.AVERAGE_FRAMES, 15)
        XCTAssertEqual(VisitorTuning.MAX_SPREAD_M, 0.01)
        XCTAssertEqual(VisitorTuning.MAX_HEADING_SPREAD_DEG, 1.0)
        XCTAssertEqual(VisitorTuning.MAX_VIEW_ANGLE_DEG, 30.0)
        XCTAssertEqual(VisitorTuning.JUMP_DISTANCE_M, 0.25)
        XCTAssertEqual(VisitorTuning.JUMP_YAW_DEG, 25.0)
        XCTAssertEqual(VisitorTuning.MAX_WALK_SPEED_M_S, 2.5)
        XCTAssertEqual(VisitorTuning.MAX_TURN_DEG_S, 300.0)
        XCTAssertEqual(VisitorTuning.MAX_TICK_GAP_S, 0.5)
        XCTAssertEqual(VisitorTuning.NOT_FOUND_RETRY_MS, 600_000)
        XCTAssertEqual(VisitorTuning.NO_WALL_HINT_MS, 3_000)
        XCTAssertEqual(VisitorTuning.UNREADABLE_HINT_MS, 1_500)
        XCTAssertEqual(VisitorTuning.LOOKUP_RETRY_MIN_MS, 2_000)
        XCTAssertEqual(VisitorTuning.LOOKUP_RETRY_MAX_MS, 30_000)
    }
}
