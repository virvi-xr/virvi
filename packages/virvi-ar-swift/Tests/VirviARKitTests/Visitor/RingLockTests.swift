import XCTest
@testable import VirviARKit

/// Mirrors apps/quest/app/src/test/java/io/virvi/ar/visitor/RingLockTest.kt, plus `lockHeading` on its own.
final class RingLockTests: XCTestCase {
    private let head = Vec3(x: 0, y: 1.6, z: 0)
    private let near = Vec3(x: 0, y: 1.6, z: 1)
    private let far = Vec3(x: 0, y: 1.6, z: 3)
    private let wobble = Vec3(x: 0.1, y: 1.6, z: 1)

    func testGathersUntilEnoughFramesThenStepsSteadyOnce() {
        let l = RingLock()
        for _ in 0..<(VisitorTuning.MIN_FRAMES - 1) { XCTAssertEqual(l.step(near, 180, head: head, nowMs: 0).gate, .gathering) }
        let s = l.step(near, 180, head: head, nowMs: 0)
        XCTAssertEqual(s.gate, .steady)
        XCTAssertTrue(s.becameSteady)
        XCTAssertEqual(s.world, near)
        XCTAssertEqual(s.headingDeg!, 180, accuracy: 1e-9)
        let again = l.step(near, 180, head: head, nowMs: 0)
        XCTAssertEqual(again.gate, .steady)
        XCTAssertFalse(again.becameSteady)
    }

    func testTooFarWithAWallHeading() {
        let l = RingLock()
        for _ in 0..<VisitorTuning.MIN_FRAMES { _ = l.step(far, 180, head: head, nowMs: 0) }
        XCTAssertEqual(l.step(far, 180, head: head, nowMs: 0).gate, .tooFar)
    }

    func testNoWallHeadingIsGatheringNeverTooFarOrSteady() {
        let l = RingLock()
        for _ in 0..<20 { XCTAssertEqual(l.step(far, nil, head: head, nowMs: 0).gate, .gathering) }
        let n = RingLock()
        for _ in 0..<20 {
            let s = n.step(near, nil, head: head, nowMs: 0)
            XCTAssertEqual(s.gate, .gathering)
            XCTAssertFalse(s.becameSteady)
        }
    }

    func testAFrameWithoutAWallInTheWindowHoldsItGathering() {
        let l = RingLock()
        for _ in 0..<VisitorTuning.MIN_FRAMES { _ = l.step(near, 180, head: head, nowMs: 0) }
        XCTAssertEqual(l.step(near, nil, head: head, nowMs: 0).gate, .gathering)
    }

    func testLeavingSteadyAndComingBackIsANewEdge() {
        let l = RingLock()
        for _ in 0..<VisitorTuning.MIN_FRAMES { _ = l.step(near, 180, head: head, nowMs: 0) }
        // a wobble pushes the spread over the limit
        XCTAssertEqual(l.step(wobble, 180, head: head, nowMs: 0).gate, .gathering)
        l.clear()
        for _ in 0..<(VisitorTuning.MIN_FRAMES - 1) { _ = l.step(near, 180, head: head, nowMs: 0) }
        XCTAssertTrue(l.step(near, 180, head: head, nowMs: 0).becameSteady)
    }

    func testDroppingOutOfSteadyAndSettlingAgainWithoutClearIsANewEdge() {
        let l = RingLock()
        var edges = 0
        for _ in 0..<VisitorTuning.MIN_FRAMES { if l.step(near, 180, head: head, nowMs: 0).becameSteady { edges += 1 } }
        XCTAssertEqual(edges, 1)
        // a wobble leaves the gate, and stays in the window until enough steady frames push it out
        XCTAssertEqual(l.step(wobble, 180, head: head, nowMs: 0).gate, .gathering)
        var back = 0
        for _ in 0..<(VisitorTuning.AVERAGE_FRAMES + VisitorTuning.MIN_FRAMES) {
            if l.step(near, 180, head: head, nowMs: 0).becameSteady { back += 1 }
        }
        XCTAssertEqual(back, 1)
        XCTAssertEqual(l.step(near, 180, head: head, nowMs: 0).gate, .steady)
    }

    func testAStillRingWithNoWallHeadingSaysSoOnlyAfterTheWait() {
        let l = RingLock()
        var t: Int64 = 0
        for _ in 0..<VisitorTuning.MIN_FRAMES { XCTAssertFalse(l.step(near, nil, head: head, nowMs: t).wallMissing) }
        // still since the MIN_FRAMES-th frame (t = 0); 3 s later it is not yet over the wait
        t = VisitorTuning.NO_WALL_HINT_MS
        XCTAssertFalse(l.step(near, nil, head: head, nowMs: t).wallMissing)
        t += 1
        let s = l.step(near, nil, head: head, nowMs: t)
        XCTAssertTrue(s.wallMissing)
        XCTAssertEqual(s.gate, .gathering)
    }

    func testMovingOrAWallHeadingRestartsTheNoWallWait() {
        let l = RingLock()
        for _ in 0..<VisitorTuning.MIN_FRAMES { _ = l.step(near, nil, head: head, nowMs: 0) }
        // a wobble: no longer still
        XCTAssertFalse(l.step(wobble, nil, head: head, nowMs: 1_000).wallMissing)
        l.clear()
        for _ in 0..<VisitorTuning.MIN_FRAMES { _ = l.step(near, nil, head: head, nowMs: 2_000) }
        XCTAssertFalse(l.step(near, nil, head: head, nowMs: 4_000).wallMissing) // 2 s since it settled again
        XCTAssertTrue(l.step(near, nil, head: head, nowMs: 5_001).wallMissing)
        // with a wall heading it is never missing, however long
        let w = RingLock()
        for _ in 0..<VisitorTuning.MIN_FRAMES { _ = w.step(near, 180, head: head, nowMs: 0) }
        XCTAssertFalse(w.step(near, 180, head: head, nowMs: 10_000).wallMissing)
    }

    private func step(_ gate: Gate, wallMissing: Bool = false) -> LockStep {
        LockStep(gate: gate, becameSteady: false, world: near, headingDeg: nil, wallMissing: wallMissing)
    }

    func testGatherStatusForEveryCase() {
        XCTAssertEqual(gatherStatus([], unreadableSeen: false), .noneInView)
        XCTAssertEqual(gatherStatus([], unreadableSeen: true), .unreadable)
        XCTAssertEqual(gatherStatus([step(.gathering)], unreadableSeen: false), .gathering)
        XCTAssertEqual(gatherStatus([step(.steady)], unreadableSeen: false), .gathering)
        XCTAssertEqual(gatherStatus([step(.tooFar)], unreadableSeen: false), .tooFar)
        // a readable ring beats an unreadable one
        XCTAssertEqual(gatherStatus([step(.tooFar)], unreadableSeen: true), .tooFar)
        // one steady ring beats a far one
        XCTAssertEqual(gatherStatus([step(.tooFar), step(.steady)], unreadableSeen: false), .gathering)
        XCTAssertEqual(gatherStatus([step(.gathering, wallMissing: true)], unreadableSeen: false), .noWall)
        // another ring still settling, with its wall, isn't stuck
        XCTAssertEqual(gatherStatus([step(.gathering, wallMissing: true), step(.gathering)], unreadableSeen: false), .gathering)
    }

    func testAFarRingWithNoWallHeadingSaysStepCloser() {
        let l = RingLock()
        var s = l.step(far, nil, head: head, nowMs: 0)
        for i in 0..<20 { s = l.step(far, nil, head: head, nowMs: Int64(i) * 300) }
        XCTAssertEqual(s.gate, .gathering)
        XCTAssertEqual(s.distanceM, 3.0, accuracy: 1e-9)
        XCTAssertEqual(gatherStatus([s], unreadableSeen: false), .tooFar)
        // even once it has held still long enough to say the wall is missing: step closer first
        XCTAssertTrue(s.wallMissing)
        XCTAssertEqual(gatherStatus([s], unreadableSeen: false), .tooFar)
        // a near ring with no heading is still gathering
        let n = RingLock()
        XCTAssertEqual(gatherStatus([n.step(near, nil, head: head, nowMs: 0)], unreadableSeen: false), .gathering)
    }

    func testAStillRingSeenTooSteeplySaysStandInFrontNeverThatTheWallIsMissing() {
        let l = RingLock()
        var s = l.step(near, nil, head: head, nowMs: 0, steep: true)
        XCTAssertFalse(s.tooSteep) // not still yet
        for i in 0..<40 { s = l.step(near, nil, head: head, nowMs: Int64(i) * 300, steep: true) }
        XCTAssertTrue(s.tooSteep)
        XCTAssertFalse(s.wallMissing)
        XCTAssertEqual(s.gate, .gathering)
        XCTAssertEqual(gatherStatus([s], unreadableSeen: false), .tooSteep)
        // stepping round to head-on: the heading counts again
        for _ in 0..<VisitorTuning.AVERAGE_FRAMES { s = l.step(near, 180, head: head, nowMs: 20_000) }
        XCTAssertFalse(s.tooSteep)
        XCTAssertEqual(s.gate, .steady)
    }

    func testGatherStatusWithSteepRings() {
        let steep = LockStep(gate: .gathering, becameSteady: false, world: near, headingDeg: nil, tooSteep: true)
        XCTAssertEqual(gatherStatus([steep], unreadableSeen: false), .tooSteep)
        XCTAssertEqual(gatherStatus([steep, steep], unreadableSeen: true), .tooSteep)
        // too far comes first; another ring still gathering isn't stuck
        XCTAssertEqual(gatherStatus([steep, step(.tooFar)], unreadableSeen: false), .tooFar)
        XCTAssertEqual(gatherStatus([steep, step(.gathering)], unreadableSeen: false), .gathering)
        XCTAssertEqual(gatherStatus([steep, step(.steady)], unreadableSeen: false), .gathering)
    }

    // MARK: - lockHeading (RingLock.kt; the geometric cases are in RingPoseTests)

    func testLockHeadingTakesTheWallWithinHeadOn() {
        let h = lockHeading(fix: WallFix(headingDeg: 180, viewAngleDeg: 20), tiltDeg: 20)
        XCTAssertEqual(h, LockHeading(headingDeg: 180, steep: false))
        XCTAssertEqual(lockHeading(fix: WallFix(headingDeg: 180, viewAngleDeg: 30), tiltDeg: 30).headingDeg, 180)
    }

    func testLockHeadingIsSteepByTheWallOrByTheTilt() {
        XCTAssertEqual(lockHeading(fix: WallFix(headingDeg: 180, viewAngleDeg: 31), tiltDeg: 0), LockHeading(headingDeg: nil, steep: true))
        XCTAssertEqual(lockHeading(fix: WallFix(headingDeg: 180, viewAngleDeg: 10), tiltDeg: 31), LockHeading(headingDeg: nil, steep: true))
        // an ambiguous fix (no heading) seen steeply is still steep
        XCTAssertTrue(lockHeading(fix: WallFix(headingDeg: nil, viewAngleDeg: 45), tiltDeg: 45).steep)
    }

    func testLockHeadingWithNoFixIsNeitherHeadingNorSteep() {
        XCTAssertEqual(lockHeading(fix: nil, tiltDeg: 60), LockHeading(headingDeg: nil, steep: false))
    }
}
