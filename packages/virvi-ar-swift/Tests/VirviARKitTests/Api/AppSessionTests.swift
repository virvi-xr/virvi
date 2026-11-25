@testable import VirviARKit
import XCTest

final class MemoryStore: SessionStore, @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: AppTokens?
    init(_ t: AppTokens? = nil) { tokens = t }
    func load() -> AppTokens? { lock.lock(); defer { lock.unlock() }; return tokens }
    func save(_ t: AppTokens?) { lock.lock(); tokens = t; lock.unlock() }
}

final class FakeAttester: Attester, @unchecked Sendable {
    private let lock = NSLock()
    private var seen: [Data] = []
    var bodies: [Data] { lock.lock(); defer { lock.unlock() }; return seen }
    func assertion(for body: Data) async throws -> String {
        lock.lock(); seen.append(body); let n = seen.count; lock.unlock()
        return "key1.assertion\(n)"
    }
}

final class AppSessionTests: XCTestCase {
    private let base = URL(string: "https://virvi.test/")!
    private let signedInTokens = AppTokens(accessToken: "old", refreshToken: "r1", userName: "Ana")

    private func session(_ t: FakeTransport, _ store: MemoryStore) -> AppSession {
        AppSession(baseUrl: base, transport: t, store: store)
    }

    func testStartsSignedInFromTheStore() {
        let s = session(FakeTransport(), MemoryStore(signedInTokens))
        XCTAssertTrue(s.signedIn)
        XCTAssertEqual(s.userName, "Ana")
    }

    func testSignInExchangesTheCodeAndStoresTheTokens() async {
        let t = FakeTransport()
        t.on("/api/auth/handoff/exchange") { _ in
            (200, ["user": ["id": "u", "displayName": "Ana"], "accessToken": "a1", "refreshToken": "r1"])
        }
        let store = MemoryStore()
        let s = session(t, store)
        let ok = await s.signIn(exchanging: "ABCD1234")
        XCTAssertTrue(ok)
        XCTAssertTrue(s.signedIn)
        XCTAssertEqual(store.load(), AppTokens(accessToken: "a1", refreshToken: "r1", userName: "Ana"))
        XCTAssertEqual(t.bodies("/exchange")[0]["code"] as? String, "ABCD1234")
        let bearer = await s.bearer()
        XCTAssertEqual(bearer, "a1")
    }

    func testAnExpiredCodeLeavesYouSignedOut() async {
        let t = FakeTransport()
        t.on("/exchange") { _ in (410, ["error": "expired"]) }
        let s = session(t, MemoryStore())
        let ok = await s.signIn(exchanging: "X")
        XCTAssertFalse(ok)
        XCTAssertFalse(s.signedIn)
    }

    func testSignOutClearsTheStore() {
        let store = MemoryStore(signedInTokens)
        let s = session(FakeTransport(), store)
        s.signOut()
        XCTAssertFalse(s.signedIn)
        XCTAssertNil(store.load())
    }

    func testRefreshesOnceOn401ThenRetriesWithTheNewToken() async throws {
        let t = FakeTransport()
        t.on("/api/auth/refresh") { req in
            XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer r1")
            return (200, ["accessToken": "new"])
        }
        t.on("/api/x") { req in req.value(forHTTPHeaderField: "Authorization") == "Bearer new" ? (200, ["ok": true]) : (401, nil) }
        let store = MemoryStore(signedInTokens)
        let s = session(t, store)
        let r = try await s.authorized { token in
            var q = URLRequest(url: URL(string: "https://virvi.test/api/x")!)
            q.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            return try await t.send(q)
        }
        XCTAssertEqual(r?.1.statusCode, 200)
        XCTAssertEqual(t.count("/api/auth/refresh"), 1)
        XCTAssertEqual(t.count("/api/x"), 2)
        XCTAssertEqual(store.load()?.accessToken, "new")
        XCTAssertEqual(store.load()?.refreshToken, "r1")
        XCTAssertTrue(s.signedIn)
    }

    func testAStillRefusedRetryIsNotRefreshedAgain() async throws {
        let t = FakeTransport()
        t.on("/api/auth/refresh") { _ in (200, ["accessToken": "new"]) }
        t.on("/api/x") { _ in (401, nil) }
        let s = session(t, MemoryStore(signedInTokens))
        let r = try await s.authorized { token in
            var q = URLRequest(url: URL(string: "https://virvi.test/api/x")!)
            q.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            return try await t.send(q)
        }
        XCTAssertEqual(r?.1.statusCode, 401)
        XCTAssertEqual(t.count("/api/auth/refresh"), 1)
        XCTAssertEqual(t.count("/api/x"), 2)
    }

    func testAFailedRefreshSignsOut() async throws {
        let t = FakeTransport()
        t.on("/api/auth/refresh") { _ in (401, ["error": "Invalid or expired refresh token"]) }
        t.on("/api/x") { _ in (401, nil) }
        let store = MemoryStore(signedInTokens)
        let s = session(t, store)
        let r = try await s.authorized { token in
            var q = URLRequest(url: URL(string: "https://virvi.test/api/x")!)
            q.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            return try await t.send(q)
        }
        XCTAssertEqual(r?.1.statusCode, 401)
        XCTAssertEqual(t.count("/api/x"), 1)
        XCTAssertFalse(s.signedIn)
        XCTAssertNil(store.load())
    }

    func testAnUnreachableRefreshKeepsYouSignedIn() async throws {
        let t = FakeTransport()
        t.on("/api/auth/refresh") { _ in (503, nil) }
        t.on("/api/x") { _ in (401, nil) }
        let s = session(t, MemoryStore(signedInTokens))
        _ = try await s.authorized { token in
            var q = URLRequest(url: URL(string: "https://virvi.test/api/x")!)
            q.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            return try await t.send(q)
        }
        XCTAssertTrue(s.signedIn)
    }

    func testSignedOutSendsNothing() async throws {
        let t = FakeTransport()
        let s = session(t, MemoryStore())
        let r = try await s.authorized { _ in try await t.send(URLRequest(url: URL(string: "https://virvi.test/api/x")!)) }
        XCTAssertNil(r)
        XCTAssertTrue(t.requests.isEmpty)
    }
}
