import Foundation
import XCTest
import VirviARKit
@testable import VirviAR

@MainActor
final class CodeSignInTests: XCTestCase {
    private let base = URL(string: "https://virvi.test")!
    private var transport: FakeTransport!
    private var sleeper: FakeSleeper!
    private var session: AppSession!
    private var wallMs: Int64 = 1_795_514_400_000
    private let claim = Box<(Int, [String: Any])>((200, ["status": "pending"]))

    override func setUp() async throws {
        transport = FakeTransport()
        let expires = ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: Double(wallMs) / 1000 + 600))
        transport.on("/api/ar/pair") { _ in (200, ["code": "ABCD2345", "approveUrl": "https://virvi.test/pair/headset/ABCD2345", "codeExpiresAt": expires]) }
        let claim = self.claim
        transport.on("/claim") { _ in claim.value }
        sleeper = FakeSleeper()
        session = AppSession(baseUrl: base, transport: transport, store: MemorySessionStore(nil))
    }

    override func tearDown() async throws { sleeper.release() }

    private func model() -> CodeSignInModel {
        let sleeper = self.sleeper!
        return CodeSignInModel(session: session, baseUrl: base, transport: transport, wallClock: { [unowned self] in self.wallMs },
                               sleep: { await sleeper.sleep($0) })
    }

    private func until(_ what: String, _ condition: () -> Bool) async {
        let end = Date().addingTimeInterval(5)
        while !condition() && Date() < end { try? await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertTrue(condition(), "timed out waiting for \(what)")
    }

    private func body(_ suffix: String) -> [String: Any] {
        let r = transport.requests.first { $0.url!.path.hasSuffix(suffix) }
        return (r?.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
    }

    func testTheCodeIsShownThenTheApprovedSessionSignsThePhoneIn() async {
        let m = model()
        m.start()
        await until("the code") { m.phase == .showing(code: "ABCD2345") }
        XCTAssertEqual(CodeSignInModel.INSTRUCTION, "Go to virvi.io/pair on a computer and enter this code:")
        let start = body("/api/ar/pair")
        XCTAssertEqual(start["purpose"] as? String, "visitor")
        XCTAssertEqual((start["secretHash"] as? String)?.count, 64)

        // Still waiting for the computer
        await until("the first poll") { sleeper.waiting == 1 }
        XCTAssertEqual(sleeper.durations, [2])
        sleeper.release()
        await until("a pending answer") { transport.count("/claim") == 1 }
        await until("the next poll") { sleeper.waiting == 1 }
        XCTAssertEqual(m.phase, .showing(code: "ABCD2345"))
        XCTAssertFalse(session.signedIn)

        claim.value = (200, ["status": "approved", "purpose": "visitor", "deviceId": "d1",
                             "session": ["user": ["id": "u1", "displayName": "Ana", "email": NSNull(), "role": "user"],
                                         "accessToken": "a1", "refreshToken": "r1"]])
        sleeper.release()
        await until("signed in") { m.phase == .signedIn }
        XCTAssertTrue(session.signedIn)
        XCTAssertEqual(session.userName, "Ana")
        let bearer = await session.bearer()
        XCTAssertEqual(bearer, "a1")
        // The claim proves the secret whose hash started the pairing
        let secret = body("/claim")["secret"] as? String
        XCTAssertEqual(secret?.count, 64)
        XCTAssertEqual(transport.requests.last { $0.url!.path.hasSuffix("/claim") }?.url?.path, "/api/ar/pair/ABCD2345/claim")
    }

    func testACodeThatRunsOutGoesBackToSignedOut() async {
        let m = model()
        m.start()
        await until("the code") { m.phase == .showing(code: "ABCD2345") }
        await until("the first poll") { sleeper.waiting == 1 }
        wallMs += 601_000
        sleeper.release()
        await until("signed out") { m.phase == .signedOut(note: CodeSignInModel.EXPIRED) }
        XCTAssertFalse(session.signedIn)
    }

    func testARefusedOrSpentCodeGoesBackToSignedOut() async {
        let cases: [((Int, [String: Any]), String)] = [((200, ["status": "refused"]), CodeSignInModel.REFUSED),
                                                       ((404, ["error": "not_found"]), CodeSignInModel.EXPIRED)]
        for (answer, note) in cases {
            claim.value = answer
            let m = model()
            m.start()
            await until("the first poll") { sleeper.waiting == 1 }
            sleeper.release()
            await until("signed out") { m.phase == .signedOut(note: note) }
            XCTAssertFalse(session.signedIn)
        }
    }

    func testAnOfflineOrBusyPollKeepsWaiting() async {
        claim.value = (429, ["error": "rate_limited"])
        let m = model()
        m.start()
        await until("the first poll") { sleeper.waiting == 1 }
        sleeper.release()
        await until("the next poll") { transport.count("/claim") == 1 && sleeper.waiting == 1 }
        XCTAssertEqual(m.phase, .showing(code: "ABCD2345"))
        m.cancel()
        XCTAssertEqual(m.phase, .signedOut(note: nil))
    }
}
