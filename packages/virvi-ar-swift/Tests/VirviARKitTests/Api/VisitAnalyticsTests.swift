@testable import VirviARKit
import XCTest

private final class Box: @unchecked Sendable {
    private let lock = NSLock()
    private var _now: Int64 = 1_700_000_000_000
    private var _answer: AnalyticsResult = .sent
    private var _attempts = 0
    private var _posts: [(String, [VisitEvent])] = []
    var now: Int64 { get { lock.lock(); defer { lock.unlock() }; return _now } set { lock.lock(); _now = newValue; lock.unlock() } }
    var answer: AnalyticsResult { get { lock.lock(); defer { lock.unlock() }; return _answer } set { lock.lock(); _answer = newValue; lock.unlock() } }
    var attempts: Int { lock.lock(); defer { lock.unlock() }; return _attempts }
    var posts: [(String, [VisitEvent])] { lock.lock(); defer { lock.unlock() }; return _posts }
    func attempt(_ id: String, _ e: [VisitEvent]) -> AnalyticsResult {
        lock.lock(); defer { lock.unlock() }
        _attempts += 1
        if _answer == .sent { _posts.append((id, e)) }
        return _answer
    }
}

final class VisitAnalyticsTests: XCTestCase {
    private let box = Box()
    private lazy var analytics = VisitAnalytics(send: { [box] in box.attempt($0, $1) }, clock: { [box] in box.now })

    private func types(_ e: [VisitEvent]) -> [String] { e.map(\.type) }

    func testEnterTwoPositionsLeaveIsOneBatch() async {
        analytics.shown(spaceId: "s1")
        analytics.position(Vec3(x: 1, y: 1.5, z: 2))
        box.now += 6_000
        analytics.position(Vec3(x: 1.5, y: 1.5, z: 2))
        box.now += 1_000
        analytics.end()
        await analytics.flush()
        XCTAssertEqual(box.posts.count, 1)
        let (id, e) = box.posts[0]
        XCTAssertEqual(id, "s1")
        XCTAssertEqual(types(e), ["enter", "pos", "pos", "leave"])
        XCTAssertEqual(e[0].t, 1_700_000_000_000)
        XCTAssertEqual(e[2].x, 1.5)
        XCTAssertNil(e[0].x)
        XCTAssertNil(e[3].x)
        XCTAssertEqual(Set(e.map(\.playerId)).count, 1)
        XCTAssertNotNil(UUID(uuidString: e[0].playerId))
    }

    func testPositionsWithinFiveSecondsCollapse() async {
        analytics.shown(spaceId: "s1")
        analytics.position(Vec3(x: 0, y: 0, z: 0))
        box.now += 2_000
        analytics.position(Vec3(x: 1, y: 0, z: 0))
        box.now += 2_900
        analytics.position(Vec3(x: 2, y: 0, z: 0))
        await analytics.flush()
        XCTAssertEqual(types(box.posts[0].1), ["enter", "pos"])
    }

    func testHiddenPausesAndReshowContinues() async {
        analytics.shown(spaceId: "s1")
        analytics.hidden()
        box.now += 1_000
        analytics.position(Vec3(x: 9, y: 9, z: 9))
        analytics.shown(spaceId: "s1")
        analytics.end()
        await analytics.flush()
        XCTAssertEqual(types(box.posts[0].1), ["enter", "leave"])
    }

    func testFailedPostRetriedAndQueueCapsAt200() async {
        box.answer = .retry
        analytics.shown(spaceId: "s1")
        for i in 0..<300 {
            box.now += 5_000
            analytics.position(Vec3(x: Double(i), y: 0, z: 0))
        }
        await analytics.flush()
        XCTAssertTrue(box.posts.isEmpty)
        box.answer = .sent
        await analytics.flush()
        XCTAssertEqual(box.posts.count, 1)
        let e = box.posts[0].1
        XCTAssertEqual(e.count, 200)
        XCTAssertEqual(e.last?.x, 299)
        await analytics.flush()
        XCTAssertEqual(box.posts.count, 1)
    }

    func testNewVisitGetsNewPlayerId() async {
        analytics.shown(spaceId: "s1"); analytics.end()
        analytics.shown(spaceId: "s1"); analytics.end()
        await analytics.flush()
        XCTAssertEqual(Set(box.posts.flatMap { $0.1 }.map(\.playerId)).count, 2)
    }

    func testDifferentSpaceStartsNewVisitAndPostsSeparately() async {
        analytics.shown(spaceId: "s1")
        analytics.shown(spaceId: "s2")
        analytics.end()
        await analytics.flush()
        XCTAssertEqual(box.posts.map(\.0), ["s1", "s2"])
        XCTAssertNotEqual(box.posts[0].1[0].playerId, box.posts[1].1[0].playerId)
    }

    func testRefusedBatchIsDroppedNotRetried() async {
        box.answer = .drop
        analytics.shown(spaceId: "gone")
        analytics.end()
        await analytics.flush()
        XCTAssertEqual(box.attempts, 1)
        box.answer = .sent
        await analytics.flush()
        XCTAssertEqual(box.attempts, 1)
        XCTAssertTrue(box.posts.isEmpty)
    }

    func testDropOnlyDropsThatSpacesBatch() async {
        let calls = Counter()
        let a = VisitAnalytics(send: { id, _ in _ = calls.next(); return id == "gone" ? .drop : .retry }, clock: { 1 })
        a.shown(spaceId: "gone")
        a.shown(spaceId: "s2")
        a.end()
        await a.flush()
        XCTAssertEqual(calls.next(), 2) // Counter starts at -1, so 2 means two sends so far
        await a.flush()
        XCTAssertEqual(calls.next(), 4) // only s2 was tried again
    }

    func testConcurrentFlushesDoNotOverlap() async {
        let inFlight = Counter()
        let a = VisitAnalytics(send: { _, _ in
            _ = inFlight.next()
            try? await Task.sleep(nanoseconds: 10_000_000)
            return .sent
        }, clock: { 1 })
        a.shown(spaceId: "s1")
        a.end()
        async let f1: Void = a.flush()
        async let f2: Void = a.flush()
        _ = await (f1, f2)
        XCTAssertEqual(inFlight.next(), 1) // one send: the second flush found the queue already empty
    }
}
