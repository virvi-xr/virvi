@testable import VirviARKit
import XCTest

private final class Recorder<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [T] = []
    func add(_ t: T) { lock.lock(); items.append(t); lock.unlock() }
    var all: [T] { lock.lock(); defer { lock.unlock() }; return items }
}

final class ArFeedTests: XCTestCase {
    private func feedBody(_ version: String) -> [String: Any] {
        ["v": 1, "version": version, "scene": NSNull(),
         "space": ["id": "s1", "name": "Loft", "place": NSNull(), "published": true, "floors": []]]
    }

    private struct Run {
        var statuses: [FeedStatus]
        var versions: [String]
        var sleeps: [Double]
        var since: [String?]
    }

    private func run(_ t: FakeTransport) async -> Run {
        let statuses = Recorder<FeedStatus>(), versions = Recorder<String>(), sleeps = Recorder<Double>()
        let feed = ArFeed(api: ArApi(baseUrl: URL(string: "https://virvi.test")!, transport: t, appVersion: "1"),
                          onSnapshot: { versions.add($0.version) }, onStatus: { statuses.add($0) },
                          sleep: { sleeps.add($0) })
        feed.start(spaceId: "s1")
        await feed.finished()
        return Run(statuses: statuses.all, versions: versions.all, sleeps: sleeps.all,
                   since: t.requests.map { $0.url?.query.map { String($0.dropFirst("since=".count)) } })
    }

    func testLongPollsWithSinceAndStopsOnNotFound() async {
        let t = FakeTransport()
        t.script("/feed", [(200, feedBody("a")), (200, feedBody("a")), (200, feedBody("b")), (404, ["error": "not_found"])])
        let r = await run(t)
        XCTAssertEqual(r.since, ["", "a", "a", "b"])
        XCTAssertEqual(r.versions, ["a", "b"]) // unchanged version is not re-announced
        XCTAssertEqual(r.statuses, [.connecting, .live, .live, .live, .notFound])
        XCTAssertEqual(r.sleeps, [])
        XCTAssertEqual(t.count("/feed"), 4) // stopped
    }

    func testBacksOffOneTwoFourToThirtyAndResetsOnSuccess() async {
        let t = FakeTransport()
        let n = Counter()
        let script: [Int] = [500, 500, 0 /* offline */, 429, 500, 500, 500, 500, 200, 500, 404]
        t.on("/feed") { _ in
            switch script[min(n.next(), script.count - 1)] {
            case 0: throw URLError(.notConnectedToInternet)
            case 200: return (200, self.feedBody("a"))
            case let s: return (s, nil)
            }
        }
        let r = await run(t)
        XCTAssertEqual(r.sleeps, [1, 2, 4, 8, 16, 30, 30, 30, 1])
        XCTAssertEqual(r.statuses.first, .connecting)
        XCTAssertEqual(r.statuses[1...4], [.failed, .failed, .offline, .rateLimited])
        XCTAssertEqual(r.statuses.suffix(3), [.live, .failed, .notFound])
    }

    func testUnparseableBodyIsBadDataThenFailedThenNotFound() async {
        let t = FakeTransport()
        t.script("/feed", [(200, ["nope": 1]), (500, nil), (404, nil)])
        let r = await run(t)
        XCTAssertEqual(r.statuses, [.connecting, .badData, .failed, .notFound])
        XCTAssertEqual(r.sleeps, [1, 2])
    }

    func testStopEndsTheLoop() async {
        let t = FakeTransport()
        t.on("/feed") { _ in (500, nil) }
        let feed = ArFeed(api: ArApi(baseUrl: URL(string: "https://virvi.test")!, transport: t, appVersion: "1"),
                          onSnapshot: { _ in }, onStatus: { _ in }, sleep: { _ in try? await Task.sleep(nanoseconds: 5_000_000) })
        feed.start(spaceId: "s1")
        try? await Task.sleep(nanoseconds: 50_000_000)
        feed.stop()
        await feed.finished()
        let seen = t.count("/feed")
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(t.count("/feed"), seen)
    }
}
