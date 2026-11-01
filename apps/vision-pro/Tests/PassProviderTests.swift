import XCTest

final class PassProviderTests: XCTestCase {
    private let base = URL(string: "https://test.virvi.io")!

    private func store() -> MemoryStore {
        let s = MemoryStore(); s.save("headsetSecret", "sec"); s.save("deviceId", "dev1"); return s
    }

    private func mintResponse(_ n: Int, ttl: TimeInterval) -> (Int, [String: Any]?) {
        (200, ["pass": "pass\(n)", "passExpiresAt": iso(Date().addingTimeInterval(ttl)), "sceneId": "s1"])
    }

    func testPassIsReusedUntil30sBeforeExpiry() async throws {
        let t = FakeTransport()
        let c = Counter()
        t.on("/pass") { [self] _ in mintResponse(c.next(), ttl: 120) }
        let clock = Clock(Date())
        let p = PassProvider(baseUrl: base, transport: t, secrets: store(), onRevoked: {}, now: { clock.now })
        let a = try await p.pass(for: "s1")
        let b = try await p.pass(for: "s1")
        XCTAssertEqual(a, b)
        XCTAssertEqual(t.count("/pass"), 1)
        clock.now = clock.now.addingTimeInterval(95) // 25 s left
        let c2 = try await p.pass(for: "s1")
        XCTAssertNotEqual(c2, a)
        XCTAssertEqual(t.count("/pass"), 2)
        let body = t.bodies("/pass").first
        XCTAssertEqual(body?["sceneId"] as? String, "s1")
        XCTAssertEqual(body?["secret"] as? String, "sec")
    }

    func testRetriesOnceWithFreshPassAfter401() async throws {
        let t = FakeTransport()
        let c = Counter()
        t.on("/pass") { [self] _ in mintResponse(c.next(), ttl: 600) }
        let seen = Counter()
        t.on("/api/thing") { req in
            if seen.next() == 0 { return (401, ["error": "bad_token"]) }
            XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer pass1")
            return (200, ["ok": true])
        }
        let p = PassProvider(baseUrl: base, transport: t, secrets: store(), onRevoked: {})
        let api = VirviApi(baseUrl: base, transport: t, passes: p)
        struct R: Decodable { let ok: Bool }
        let r: R = try await api.scene("s1", "GET", "/api/thing", body: nil)
        XCTAssertTrue(r.ok)
        XCTAssertEqual(t.count("/pass"), 2)
        XCTAssertEqual(t.count("/api/thing"), 2)
    }

    func testUrlErrorIsOffline() async {
        let t = FakeTransport()
        t.on("/api/thing") { _ in throw URLError(.notConnectedToInternet) }
        let api = VirviApi(baseUrl: base, transport: t, passes: nil)
        do {
            let _: EmptyResponse = try await api.device("POST", "/api/thing", body: [:])
            XCTFail("expected throw")
        } catch {
            XCTAssertEqual(error as? ApiError, .offline)
        }
    }
}

final class Clock: @unchecked Sendable {
    var now: Date
    init(_ d: Date) { now = d }
}
