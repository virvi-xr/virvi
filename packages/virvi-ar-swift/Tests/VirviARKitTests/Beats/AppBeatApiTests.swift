@testable import VirviARKit
import XCTest

final class AppBeatApiTests: XCTestCase {
    private let base = URL(string: "https://virvi.test/")!
    private let tokens = AppTokens(accessToken: "tok", refreshToken: "r1", userName: nil)

    private let cardJson: [String: Any] = [
        "beatId": "b1", "name": "Opening Night", "imageUrl": "https://x/i.png", "minMinutes": 5,
        "startsAt": "2026-11-24T10:00:00.000Z", "endsAt": "2026-11-24T20:00:00.000Z",
        "location": ["type": "in_person", "venue": "The Loft"], "claim": NSNull(), "wallets": [String](),
    ]

    private func make(_ t: FakeTransport, signedIn: Bool = true, attester: FakeAttester = FakeAttester()) -> (AppBeatApi, FakeAttester) {
        let session = AppSession(baseUrl: base, transport: t, store: MemoryStore(signedIn ? tokens : nil))
        return (AppBeatApi(baseUrl: base, transport: t, session: session, attest: attester), attester)
    }

    func testSpaceBeatIsAGetWithTheBearer() async {
        let t = FakeTransport()
        t.on("/api/app/spaces/s%201/beat") { _ in (200, ["beat": self.cardJson]) }
        t.on("/beat") { _ in (200, ["beat": self.cardJson]) }
        let (api, _) = make(t)
        let r = await api.spaceBeat("s 1")
        guard case .ok(let card?) = r else { return XCTFail("\(r)") }
        XCTAssertEqual(card.name, "Opening Night")
        XCTAssertEqual(t.requests[0].httpMethod, "GET")
        XCTAssertEqual(t.requests[0].value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        XCTAssertNil(t.requests[0].value(forHTTPHeaderField: "X-Virvi-Attest"))
    }

    func testSpaceWithoutABeatIsOkNil() async {
        let t = FakeTransport()
        t.on("/beat") { _ in (200, ["beat": NSNull()]) }
        let (api, _) = make(t)
        let r = await api.spaceBeat("s1")
        XCTAssertEqual(r, .ok(nil))
    }

    func testSignedOutSendsNothingAndSaysSo() async {
        let t = FakeTransport()
        let (api, _) = make(t, signedIn: false)
        let r = await api.spaceBeat("s1")
        guard case .error(let e) = r else { return XCTFail("\(r)") }
        XCTAssertEqual(e.code, "signed_out")
        XCTAssertTrue(t.requests.isEmpty)
    }

    func testArcBeatAndSpaceVariants() async {
        let t = FakeTransport()
        t.on("/api/app/arcs/AB12") { _ in (200, ["kind": "beat", "beatId": "b1", "name": "Opening Night", "card": self.cardJson]) }
        t.on("/api/app/arcs/CD34") { _ in
            (200, ["kind": "space", "lookup": ["spaceId": "s", "floorId": "f", "markerId": "m", "spaceName": "Loft", "whereText": NSNull()]])
        }
        let (api, _) = make(t)
        guard case .ok(.beat(let id, let name, let card)) = await api.arc("AB12") else { return XCTFail() }
        XCTAssertEqual(id, "b1"); XCTAssertEqual(name, "Opening Night"); XCTAssertEqual(card?.beatId, "b1")
        let r = await api.arc("CD34")
        XCTAssertEqual(r, .ok(.space(MarkerLookup(spaceId: "s", floorId: "f", markerId: "m", spaceName: "Loft", whereText: nil))))
    }

    func testTrackSignsTheExactBodyItSends() async throws {
        let t = FakeTransport()
        t.on("/api/app/beats/b1/track") { _ in (200, ["beat": self.cardJson]) }
        let (api, attester) = make(t)
        let r = await api.track("b1", via: .arc(code: "AB12", location: BeatLocation(lat: 1.5, lng: 2.5, accuracyM: 20)))
        guard case .ok = r else { return XCTFail("\(r)") }
        let req = t.requests[0]
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.value(forHTTPHeaderField: "X-Virvi-Attest"), "key1.assertion1")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(attester.bodies, [req.httpBody!])
        let o = try JSONSerialization.jsonObject(with: req.httpBody!) as! [String: Any]
        XCTAssertEqual(o["consentVersion"] as? Int, 1)
        XCTAssertEqual(o["arcCode"] as? String, "AB12")
        XCTAssertEqual((o["location"] as? [String: Any])?["accuracyM"] as? Double, 20)
    }

    func testTrackFromASpace() async throws {
        let t = FakeTransport()
        t.on("/track") { _ in (200, ["beat": self.cardJson]) }
        let (api, _) = make(t)
        _ = await api.track("b1", via: .space("s1"))
        let o = t.bodies("/track")[0]
        XCTAssertEqual(o["spaceId"] as? String, "s1")
        XCTAssertNil(o["arcCode"])
    }

    func testCheckInClaimAndStopTrack() async throws {
        let t = FakeTransport()
        t.on("/checkin") { _ in (200, ["beat": self.cardJson]) }
        t.on("/claim") { _ in (200, ["beat": self.cardJson]) }
        t.on("/track") { _ in (204, nil) }
        let (api, attester) = make(t)
        _ = await api.checkIn("b1", spaceId: "s1")
        XCTAssertEqual(t.bodies("/checkin")[0]["spaceId"] as? String, "s1")
        _ = await api.claim("b1", wallet: "0xA", location: BeatLocation(lat: 1, lng: 2, accuracyM: 5))
        let c = t.bodies("/claim")[0]
        XCTAssertEqual(c["wallet"] as? String, "0xA")
        XCTAssertNotNil(c["location"])
        _ = await api.claim("b1", wallet: nil, location: nil)
        XCTAssertNil(t.bodies("/claim")[1]["wallet"])
        let d = await api.stopTracking("b1")
        guard case .ok = d else { return XCTFail("\(d)") }
        let del = t.requests.last!
        XCTAssertEqual(del.httpMethod, "DELETE")
        XCTAssertEqual(del.url?.path, "/api/app/beats/b1/track")
        XCTAssertEqual(attester.bodies.last, Data())
        XCTAssertEqual(del.value(forHTTPHeaderField: "X-Virvi-Attest"), "key1.assertion4")
    }

    func testMine() async {
        let t = FakeTransport()
        t.on("/api/app/beats/mine") { _ in (200, ["beats": [self.cardJson]]) }
        let (api, _) = make(t)
        guard case .ok(let beats) = await api.mine() else { return XCTFail() }
        XCTAssertEqual(beats.map(\.beatId), ["b1"])
    }

    func testServerErrorsKeepTheirCodeMessageAndWallets() async {
        let t = FakeTransport()
        t.on("/claim") { _ in (409, ["error": "choose_wallet", "message": "Choose the wallet to send this BEAT to.", "wallets": ["0xA", "0xB"]]) }
        let (api, _) = make(t)
        let r = await api.claim("b1", wallet: nil, location: nil)
        XCTAssertEqual(r, .error(AppBeatError(status: 409, code: "choose_wallet", message: "Choose the wallet to send this BEAT to.", wallets: ["0xA", "0xB"])))
    }

    func testAnUnreachableServerIsOfflineInTheVisitorsWords() async {
        struct Down: HttpTransport { func send(_ r: URLRequest) async throws -> (Data, HTTPURLResponse) { throw URLError(.notConnectedToInternet) } }
        let session = AppSession(baseUrl: base, transport: Down(), store: MemoryStore(tokens))
        let api = AppBeatApi(baseUrl: base, transport: Down(), session: session, attest: FakeAttester())
        let r = await api.mine()
        XCTAssertEqual(r, .error(AppBeatError(status: 0, code: "offline", message: VisitorCopy.OFFLINE)))
    }

    func testA401RefreshesOnceAndSignsAgainOnTheRetry() async {
        let t = FakeTransport()
        t.on("/api/auth/refresh") { _ in (200, ["accessToken": "new"]) }
        t.on("/claim") { req in
            req.value(forHTTPHeaderField: "Authorization") == "Bearer new" ? (200, ["beat": self.cardJson]) : (401, ["error": "Unauthorized"])
        }
        let (api, attester) = make(t)
        let r = await api.claim("b1", wallet: nil, location: nil)
        guard case .ok = r else { return XCTFail("\(r)") }
        XCTAssertEqual(attester.bodies.count, 2)
        XCTAssertEqual(attester.bodies[0], attester.bodies[1])
        let claims = t.requests.filter { $0.url!.path.hasSuffix("/claim") }
        XCTAssertEqual(claims.map { $0.value(forHTTPHeaderField: "X-Virvi-Attest") }, ["key1.assertion1", "key1.assertion2"])
    }

    func testAnAttesterThatThrowsIsAFailureNotACrash() async {
        struct Broken: Attester { func assertion(for body: Data) async throws -> String { throw URLError(.cancelled) } }
        let t = FakeTransport()
        let session = AppSession(baseUrl: base, transport: t, store: MemoryStore(tokens))
        let api = AppBeatApi(baseUrl: base, transport: t, session: session, attest: Broken())
        let r = await api.claim("b1", wallet: nil, location: nil)
        guard case .error(let e) = r else { return XCTFail("\(r)") }
        XCTAssertEqual(e.code, "attest_failed")
        XCTAssertTrue(t.requests.isEmpty)
    }
}
