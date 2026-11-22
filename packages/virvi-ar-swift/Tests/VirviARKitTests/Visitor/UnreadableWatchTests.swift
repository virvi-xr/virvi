import XCTest
@testable import VirviARKit

/// Mirrors apps/quest/app/src/test/java/io/virvi/ar/visitor/UnreadableWatchTest.kt. `VisitorEvent` isn't Equatable
/// (a feed snapshot carries raw JSON), so the events are matched by case.
final class UnreadableWatchTests: XCTestCase {
    private func seenSince(_ e: VisitorEvent?) -> Int64? {
        if case .unreadableSeen(let since)? = e { return since }
        return nil
    }

    private func isGone(_ e: VisitorEvent?) -> Bool {
        if case .unreadableGone? = e { return true }
        return false
    }

    func testReportsWhenTheCandidateWasFirstSeenAcrossShortGaps() {
        let w = UnreadableWatch()
        XCTAssertEqual(seenSince(w.onFrame(seen: true, nowMs: 100)), 100)
        XCTAssertNil(w.onFrame(seen: false, nowMs: 200))
        XCTAssertEqual(seenSince(w.onFrame(seen: true, nowMs: 900)), 100)
    }

    func testSaysGoneOnceAfterTheHintTimeWithNoCandidate() {
        let w = UnreadableWatch()
        _ = w.onFrame(seen: true, nowMs: 0)
        XCTAssertNil(w.onFrame(seen: false, nowMs: VisitorTuning.UNREADABLE_HINT_MS - 1))
        XCTAssertTrue(isGone(w.onFrame(seen: false, nowMs: VisitorTuning.UNREADABLE_HINT_MS)))
        XCTAssertNil(w.onFrame(seen: false, nowMs: VisitorTuning.UNREADABLE_HINT_MS + 100))
        // a new sighting starts a new run
        XCTAssertEqual(seenSince(w.onFrame(seen: true, nowMs: 5000)), 5000)
    }

    func testNothingSeenNothingSaid() {
        let w = UnreadableWatch()
        XCTAssertNil(w.onFrame(seen: false, nowMs: 0))
        XCTAssertNil(w.onFrame(seen: false, nowMs: 10_000))
    }

    func testResetForgetsTheRun() {
        let w = UnreadableWatch()
        _ = w.onFrame(seen: true, nowMs: 0)
        w.reset()
        XCTAssertNil(w.onFrame(seen: false, nowMs: 10_000))
    }
}
