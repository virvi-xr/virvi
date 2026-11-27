import Foundation
import XCTest
import VirviARKit
@testable import VirviAR

@MainActor
final class DeleteAccountTests: XCTestCase {
    private let base = URL(string: "https://virvi.test")!
    private var transport: FakeTransport!
    private var session: AppSession!
    private let answers = Box<[(Int, [String: Any]?)]>([])

    override func setUp() async throws {
        transport = FakeTransport()
        let answers = self.answers
        transport.on("/api/auth/account") { _ in answers.value.isEmpty ? (500, nil) : answers.value.removeFirst() }
        session = AppSession(baseUrl: base, transport: transport, store: MemorySessionStore(AppTokens(accessToken: "a1", refreshToken: "r1", userName: "Sam")))
    }

    private func model() -> DeleteAccountModel { DeleteAccountModel(session: session, baseUrl: base, transport: transport) }

    private func sent(_ i: Int) -> (URLRequest, [String: Any]) {
        let r = transport.requests.filter { $0.url!.path == "/api/auth/account" }[i]
        return (r, (try? JSONSerialization.jsonObject(with: r.httpBody ?? Data())) as? [String: Any] ?? [:])
    }

    func testOnlyTypingDeleteLetsTheVisitorGoOn() {
        let m = model()
        XCTAssertFalse(m.canDelete)
        m.typed = "delete "
        XCTAssertTrue(m.canDelete, "case and spaces don't matter")
        m.typed = "remove"
        XCTAssertFalse(m.canDelete)
    }

    func testAnAccountWithoutAPasswordIsDeletedWithTheConfirmationAndSignedOut() async {
        answers.value = [(204, nil)]
        let m = model()
        m.typed = "DELETE"
        await m.delete()
        let (r, body) = sent(0)
        XCTAssertEqual(r.httpMethod, "DELETE")
        XCTAssertEqual(r.value(forHTTPHeaderField: "Authorization"), "Bearer a1")
        XCTAssertEqual(body["confirm"] as? String, "DELETE")
        XCTAssertNil(body["password"])
        XCTAssertEqual(m.phase, .deleted)
        XCTAssertFalse(session.signedIn)
    }

    func testAnAccountWithAPasswordAsksForItThenDeletes() async {
        answers.value = [(400, ["error": "Password is required to delete account"]), (401, ["error": "Incorrect password"]), (204, nil)]
        let m = model()
        m.typed = "DELETE"
        await m.delete()
        XCTAssertTrue(m.needsPassword)
        XCTAssertEqual(m.note, DeleteAccountModel.ENTER_PASSWORD)
        XCTAssertTrue(session.signedIn)
        XCTAssertFalse(m.canDelete, "no password typed yet")
        m.password = "wrong"
        await m.delete()
        XCTAssertEqual(m.note, DeleteAccountModel.WRONG_PASSWORD)
        m.password = "right"
        await m.delete()
        XCTAssertEqual(sent(2).1["password"] as? String, "right")
        XCTAssertEqual(m.phase, .deleted)
        XCTAssertFalse(session.signedIn)
    }

    func testARefusalShowsTheServersReasonAndKeepsTheAccount() async {
        answers.value = [(409, ["error": "hosted_worlds", "message": "Delete your hosted worlds first."])]
        let m = model()
        m.typed = "DELETE"
        await m.delete()
        XCTAssertEqual(m.note, "Delete your hosted worlds first.")
        XCTAssertEqual(m.phase, .confirming)
        XCTAssertTrue(session.signedIn)
    }
}
