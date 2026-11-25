import VirviARKit
import XCTest
@testable import VirviAR

final class SignInTests: XCTestCase {
    private let code = String(repeating: "A", count: 43)
    private func handoff(_ s: String) -> String? { handoffCode(fromCallback: URL(string: s)!) }

    func testTheWebsitesHandOffGivesItsCode() {
        XCTAssertEqual(handoff("virvi://signed-in?code=\(code)"), code)
        let real = "aB3-_xYz0123456789aB3-_xYz0123456789aB3-_xY"
        XCTAssertEqual(real.count, 43)
        XCTAssertEqual(handoff("virvi://signed-in?code=\(real)"), real)
    }

    func testAnyOtherCallbackIsRefused() {
        XCTAssertNil(handoff("https://signed-in?code=\(code)"))
        XCTAssertNil(handoff("other://signed-in?code=\(code)"))
        XCTAssertNil(handoff("virvi://elsewhere?code=\(code)"))
        XCTAssertNil(handoff("virvi://signed-in"))
        XCTAssertNil(handoff("virvi://signed-in?code="))
        XCTAssertNil(handoff("virvi://signed-in?other=\(code)"))
    }

    func testAShortLongOrMalformedCodeIsRefused() {
        XCTAssertNil(handoff("virvi://signed-in?code=\(String(code.dropLast()))"))
        XCTAssertNil(handoff("virvi://signed-in?code=\(code)A"))
        XCTAssertNil(handoff("virvi://signed-in?code=\(String(code.dropLast()))%2B"))
        XCTAssertNil(handoff("virvi://signed-in?code=\(String(code.dropLast()))="))
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
}
