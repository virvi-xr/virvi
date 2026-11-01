import RealityKit
import XCTest

final class Sleeps: @unchecked Sendable {
    private let lock = NSLock()
    private var log: [Double] = []
    var values: [Double] { lock.lock(); defer { lock.unlock() }; return log }
    func add(_ s: Double) { lock.lock(); log.append(s); lock.unlock() }
}

@MainActor
final class SceneFeedTests: XCTestCase {
    private let base = URL(string: "https://test.virvi.io")!

    private func makeFeed(_ t: HttpTransport, sleep: @escaping @Sendable (Double) async -> Void = { _ in try? await Task.sleep(for: .seconds(60)) }) -> SceneFeed {
        let store = MemoryStore()
        store.save(SecretKey.deviceId, "dev1"); store.save(SecretKey.headsetSecret, "s")
        let passes = PassProvider(baseUrl: base, transport: t, secrets: store, onRevoked: {})
        return SceneFeed(api: VirviApi(baseUrl: base, transport: t, passes: passes), sleep: sleep)
    }

    private func mint(_ t: FakeTransport) {
        t.on("/pass") { _ in (200, ["pass": "p", "passExpiresAt": iso(Date().addingTimeInterval(600)), "sceneId": "s1"]) }
    }

    private nonisolated func feedBody(_ version: String) -> [String: Any] {
        ["v": 1, "version": version, "scene": ["models": [["sk": "m", "modelSrc": "https://x/m.glb", "instances": [["sk": "1"]]]]]]
    }

    private func waitUntil(_ what: String = "", timeout: Double = 5, _ cond: () -> Bool) async {
        let end = Date().addingTimeInterval(timeout)
        while !cond() && Date() < end { await Task.yield() }
        XCTAssertTrue(cond(), "timed out waiting for \(what)")
    }

    func testParseReadsVersionAndScene() throws {
        let data = try JSONSerialization.data(withJSONObject: feedBody("abc123"))
        let r = try XCTUnwrap(SceneFeed.parse(data))
        XCTAssertEqual(r.version, "abc123")
        XCTAssertNotNil(r.scene?["models"])
        let none = try JSONSerialization.data(withJSONObject: ["v": 1, "version": "z", "scene": NSNull()])
        let r2 = try XCTUnwrap(SceneFeed.parse(none))
        XCTAssertEqual(r2.version, "z")
        XCTAssertNil(r2.scene)
        XCTAssertNil(SceneFeed.parse(Data("nope".utf8)))
        XCTAssertNil(SceneFeed.parse(try JSONSerialization.data(withJSONObject: ["v": 2, "version": "z", "scene": NSNull()])))
    }

    func testFeedPassesSinceOnNextPoll() async {
        let t = FakeTransport(); mint(t)
        t.script("/feed", [(200, feedBody("v1")), (200, feedBody("v2"))])
        let feed = makeFeed(t)
        feed.start(sceneId: "s1")
        await waitUntil("three polls") { t.count("/feed") >= 3 }
        let status = feed.status
        feed.stop()
        let feeds = t.requests.filter { $0.url!.path.hasSuffix("/feed") }
        XCTAssertNil(URLComponents(url: feeds[0].url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "since" })
        let since = feeds.dropFirst().map { URLComponents(url: $0.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "since" }?.value }
        XCTAssertEqual(Array(since.prefix(2)), ["v1", "v2"])
        XCTAssertEqual(feeds[0].url!.path, "/api/ar/scenes/s1/feed")
        XCTAssertEqual(feeds[0].timeoutInterval, 35)
        XCTAssertEqual(feeds[0].value(forHTTPHeaderField: "Authorization"), "Bearer p")
        XCTAssertEqual(feed.version, "v2")
        XCTAssertNotNil(feed.scene)
        XCTAssertEqual(status, .live)
    }

    func testOfflineKeepsLastScene() async {
        let t = FakeTransport(); mint(t)
        let c = Counter()
        t.on("/feed") { _ in
            if c.next() == 0 { return (200, self.feedBody("v1")) }
            throw URLError(.notConnectedToInternet)
        }
        let feed = makeFeed(t)
        feed.start(sceneId: "s1")
        await waitUntil("offline") { feed.status == .offline }
        feed.stop()
        XCTAssertNotNil(feed.scene)
        XCTAssertEqual(feed.version, "v1")
    }

    func testBackoffCapsAt8s() async {
        let t = FakeTransport(); mint(t)
        t.script("/feed", [(500, ["error": "boom"])])
        let sleeps = Sleeps()
        let feed = makeFeed(t, sleep: { sleeps.add($0); await Task.yield() })
        feed.start(sceneId: "s1")
        await waitUntil("six sleeps") { sleeps.values.count >= 6 }
        feed.stop()
        XCTAssertEqual(Array(sleeps.values.prefix(6)), [1, 2, 4, 8, 8, 8])
    }

    // MARK: - Renderer

    private func item(_ key: String, x: Double, src: String = "https://x/m.obj") -> RenderItem {
        RenderItem(key: key, name: "n", kind: .model, src: src, loop: false, volume: 0, width: 1, height: 1,
                   transform: MappedTransform(position: SIMD3(x, 0, 0), rotation: SIMD3(0, 0, 0), scale: SIMD3(1, 1, 1)),
                   clickUrl: nil, elementId: String(key.split(separator: ":")[0]), instanceSk: String(key.split(separator: ":")[1]))
    }

    func testHeldKeysAreNotRepositioned() {
        let r = SceneRenderer()
        r.apply([item("a:1", x: 1), item("b:1", x: 1)], holding: [])
        r.entity(for: "a:1")!.position = [5, 0, 0] // a local drag
        r.apply([item("a:1", x: 2), item("b:1", x: 2)], holding: ["a:1"])
        XCTAssertEqual(r.entity(for: "a:1")!.position.x, 5, accuracy: 0.0001)
        XCTAssertEqual(r.entity(for: "b:1")!.position.x, 2, accuracy: 0.0001)
        r.apply([item("a:1", x: 3), item("b:1", x: 3)], holding: [])
        XCTAssertEqual(r.entity(for: "a:1")!.position.x, 3, accuracy: 0.0001)
    }

    func testPlaceholderIsPickable() throws {
        let r = SceneRenderer()
        r.apply([item("el:sk1", x: 0, src: "https://x/thing.fbx")], holding: [])
        let e = try XCTUnwrap(r.entity(for: "el:sk1"))
        XCTAssertNotNil(e.components[EditableItemComponent.self])
        XCTAssertNotNil(e.components[CollisionComponent.self])
        let child = try XCTUnwrap(e.children.first?.children.first)
        let key = try XCTUnwrap(r.instanceKey(child))
        XCTAssertEqual(key.elementId, "el")
        XCTAssertEqual(key.sk, "sk1")
        XCTAssertNil(r.instanceKey(Entity()))
    }
}
