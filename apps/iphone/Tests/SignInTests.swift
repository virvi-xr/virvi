import VirviARKit
import XCTest
@testable import VirviAR

final class SignInTests: XCTestCase {
    private let code = String(repeating: "A", count: 43)
    private func handoff(_ s: String) -> String? { handoffCode(fromCallback: URL(string: s)!, host: "virvi.io") }

    private let site = "https://virvi.io/app-signed-in"

    func testTheWebsitesHandOffGivesItsCode() {
        XCTAssertEqual(handoff("\(site)?code=\(code)"), code)
        let real = "aB3-_xYz0123456789aB3-_xYz0123456789aB3-_xY"
        XCTAssertEqual(real.count, 43)
        XCTAssertEqual(handoff("\(site)?code=\(real)"), real)
        XCTAssertEqual(handoff("HTTPS://VIRVI.IO/app-signed-in?code=\(code)"), code)
        XCTAssertEqual(handoffCode(fromCallback: URL(string: "https://staging.virvi.io/app-signed-in?code=\(code)")!, host: "staging.virvi.io"), code,
                       "the configured site's own host")
    }

    func testAnyOtherCallbackIsRefused() {
        XCTAssertNil(handoff("virvi://signed-in?code=\(code)"), "the old custom scheme")
        XCTAssertNil(handoff("http://virvi.io/app-signed-in?code=\(code)"))
        XCTAssertNil(handoff("https://evil.example/app-signed-in?code=\(code)"))
        XCTAssertNil(handoff("https://virvi.io.evil.example/app-signed-in?code=\(code)"))
        XCTAssertNil(handoff("https://virvi.io:8443/app-signed-in?code=\(code)"))
        XCTAssertNil(handoff("https://user@virvi.io/app-signed-in?code=\(code)"))
        XCTAssertNil(handoff("https://virvi.io/elsewhere?code=\(code)"))
        XCTAssertNil(handoff("https://virvi.io/app-signed-in/extra?code=\(code)"))
        XCTAssertNil(handoff("https://virvi.io/app-signed-in#code=\(code)"))
        XCTAssertNil(handoff("https://virvi.io/app-signed-in?code=\(code)#x"))
        XCTAssertNil(handoff(site))
        XCTAssertNil(handoff("\(site)?code="))
        XCTAssertNil(handoff("\(site)?other=\(code)"))
        XCTAssertNil(handoff("\(site)?code=\(code)&code=\(code)"), "a duplicated code")
        XCTAssertNil(handoff("\(site)?code=\(code)&next=%2F"), "anything extra")
        XCTAssertNil(handoffCode(fromCallback: URL(string: "\(site)?code=\(code)")!, host: "staging.virvi.io"))
    }

    func testAShortLongOrMalformedCodeIsRefused() {
        XCTAssertNil(handoff("\(site)?code=\(String(code.dropLast()))"))
        XCTAssertNil(handoff("\(site)?code=\(code)A"))
        XCTAssertNil(handoff("\(site)?code=\(String(code.dropLast()))%2B"))
        XCTAssertNil(handoff("\(site)?code=\(String(code.dropLast()))="))
    }

    func testTheKeychainStoreRoundTripsAndClears() {
        let store = KeychainSessionStore(service: "io.virvi.app.tests.\(UUID().uuidString)")
        defer { store.save(nil) }
        XCTAssertNil(store.load())
        let t = AppTokens(accessToken: "a1", refreshToken: "r1", userName: "Ada")
        store.save(t)
        XCTAssertEqual(store.load(), t)
        let u = AppTokens(accessToken: "a2", refreshToken: "r2", userName: nil)
        store.save(u)
        XCTAssertEqual(store.load(), u)
        store.save(nil)
        XCTAssertNil(store.load())
    }

    func testSavingTwiceKeepsTheSecondAndClearingRemovesIt() {
        let store = KeychainSessionStore(service: "io.virvi.app.tests.\(UUID().uuidString)")
        defer { store.save(nil) }
        XCTAssertEqual(store.write(AppTokens(accessToken: "a1", refreshToken: "r1")), errSecSuccess)
        let second = AppTokens(accessToken: "a2", refreshToken: "r2", userName: "Ada")
        XCTAssertEqual(store.write(second), errSecSuccess)
        XCTAssertEqual(store.load(), second)
        XCTAssertEqual(store.write(nil), errSecSuccess)
        XCTAssertNil(store.load())
        XCTAssertEqual(store.write(nil), errSecSuccess)
    }
}

@MainActor
final class SignInModelTests: XCTestCase {
    func testTheMenuIsToldWhenTheServerSignsTheVisitorOut() async throws {
        let t = FakeTransport()
        t.on("/api/auth/refresh") { _ in (401, ["error": "Invalid or expired refresh token"]) }
        t.on("/api/x") { _ in (401, nil) }
        let session = AppSession(baseUrl: URL(string: "https://virvi.test")!, transport: t,
                                 store: MemorySessionStore(AppTokens(accessToken: "a", refreshToken: "r", userName: "Ana")))
        let model = SignInModel(session: session)
        var told = 0
        model.onChange = { told += 1 }
        XCTAssertTrue(model.signedIn)
        _ = try await session.authorized { token in
            var q = URLRequest(url: URL(string: "https://virvi.test/api/x")!)
            q.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            return try await t.send(q)
        }
        let end = Date().addingTimeInterval(5)
        while model.changes == 0 && Date() < end { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertEqual(model.changes, 1)
        XCTAssertFalse(model.signedIn)
        XCTAssertEqual(told, 1, "the BEAT card is asked for again as signed out")
    }
}
