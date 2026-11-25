@testable import VirviARKit
import XCTest

final class ArApiTests: XCTestCase {
    private let base = URL(string: "https://virvi.test/")!

    private func api(_ t: FakeTransport) -> ArApi { ArApi(baseUrl: base, transport: t, appVersion: "7") }

    private let lookupBody: [String: Any] = ["spaceId": "s", "floorId": "f", "markerId": "m", "spaceName": "Loft", "whereText": NSNull()]

    private let feedBody: [String: Any] = [
        "v": 1, "version": "abc",
        "space": [
            "id": "s1", "name": "Loft", "place": NSNull(), "lat": 1.5, "lng": 2.5, "published": true,
            "floors": [[
                "id": "f1", "name": "Ground", "heightM": 0, "sortOrder": 0,
                "markers": [
                    ["id": "m1", "ringId": 775769179, "code": "ABCD", "diameterMm": 150, "whereText": "By the door",
                     "pose": ["x": 1, "y": 1.5, "z": -2, "headingDeg": 90]],
                    ["id": "m2", "ringId": 5, "code": "EFGH", "diameterMm": 150, "whereText": NSNull(), "pose": NSNull()],
                ],
            ]],
        ],
        "scene": ["images": [], "videos": [], "models": [], "sounds": []],
        "showings": [["elementId": "tv", "showings": [["showingId": "s1", "startsAt": 1_800_000_000_000,
                                                      "items": [["url": "https://x/f.mp4", "duration": 60]]]]]],
        "serverTime": 1_800_000_000_500,
    ]

    func testLookupRequestAndResult() async {
        let t = FakeTransport()
        t.on("/by-code/AB+CD") { _ in (200, self.lookupBody) }
        let r = await api(t).lookup(code: "AB CD")
        XCTAssertEqual(r, .ok(MarkerLookup(spaceId: "s", floorId: "f", markerId: "m", spaceName: "Loft", whereText: nil)))
        let req = t.requests[0]
        XCTAssertEqual(req.url?.absoluteString, "https://virvi.test/api/ar/markers/by-code/AB+CD")
        XCTAssertEqual(req.httpMethod, "GET")
        XCTAssertEqual(req.value(forHTTPHeaderField: "X-Virvi-App-Version"), "7")
        XCTAssertNil(req.value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(req.timeoutInterval, 15)
    }

    func testStatusesMapToResults() async {
        let t = FakeTransport()
        t.script("/by-code/X", [(404, ["error": "not_found"]), (429, ["error": "rate_limited"]), (500, nil), (200, ["nope": 1])])
        let a = api(t)
        let results = [await a.lookup(code: "X"), await a.lookup(code: "X"), await a.lookup(code: "X"), await a.lookup(code: "X")]
        XCTAssertEqual(results, [.notFound, .rateLimited, .failed(500), .failed(200)])
    }

    func testOfflineWhenTheTransportThrows() async {
        let t = FakeTransport()
        t.on("/by-code/X") { _ in throw URLError(.notConnectedToInternet) }
        t.on("/feed") { _ in throw URLError(.timedOut) }
        let a = api(t)
        let lookup = await a.lookup(code: "X")
        XCTAssertEqual(lookup, .offline)
        let feed = await a.feed(spaceId: "s", since: nil)
        if case .offline = feed {} else { XCTFail("feed should be offline, got \(feed)") }
    }

    func testFeedRequestParsesFullBody() async throws {
        let t = FakeTransport()
        t.on("/feed") { _ in (200, self.feedBody) }
        let r = await api(t).feed(spaceId: "s 1", since: "v1")
        guard case .ok(let snap) = r else { return XCTFail("\(r)") }
        let req = t.requests[0]
        XCTAssertEqual(req.url?.absoluteString, "https://virvi.test/api/ar/spaces/s+1/feed?since=v1")
        XCTAssertEqual(req.timeoutInterval, 40)
        XCTAssertEqual(req.value(forHTTPHeaderField: "X-Virvi-App-Version"), "7")
        XCTAssertEqual(snap.version, "abc")
        XCTAssertNotNil(snap.scene)
        XCTAssertEqual(planScene(snap.scene).count, 0)
        let (floor, marker) = try XCTUnwrap(snap.space.markerByRing(0x2E3D4C5B))
        XCTAssertEqual(floor.id, "f1")
        XCTAssertEqual(marker.id, "m1")
        XCTAssertEqual(marker.pose, MarkerPose(x: 1, y: 1.5, z: -2, headingDeg: 90))
        XCTAssertEqual(marker.whereText, "By the door")
        XCTAssertTrue(snap.space.published)
        XCTAssertNil(snap.space.place)
        XCTAssertEqual(snap.showings["tv"]?.count, 1)
        XCTAssertEqual(snap.serverTime, 1_800_000_000_500)
    }

    func testMarkerWithoutPoseParsesWithNilPose() async throws {
        let t = FakeTransport()
        t.on("/feed") { _ in (200, self.feedBody) }
        guard case .ok(let snap) = await api(t).feed(spaceId: "s1", since: nil) else { return XCTFail() }
        let m = try XCTUnwrap(snap.space.markerByRing(5)).1
        XCTAssertNil(m.pose)
        XCTAssertNil(m.whereText)
        XCTAssertNil(snap.space.markerByRing(99))
        XCTAssertEqual(t.requests[0].url?.query, "since=")
    }

    func testFeedWithoutSceneAndRefusedBodies() async {
        var noScene = feedBody
        noScene["scene"] = NSNull()
        noScene["showings"] = nil
        noScene["serverTime"] = nil
        var v2 = feedBody
        v2["v"] = 2
        let t = FakeTransport()
        t.script("/feed", [(200, noScene), (200, v2), (200, ["v": 1, "version": "a"])])
        let a = api(t)
        guard case .ok(let snap) = await a.feed(spaceId: "s", since: nil) else { return XCTFail() }
        XCTAssertNil(snap.scene)
        XCTAssertTrue(snap.showings.isEmpty)
        XCTAssertNil(snap.serverTime)
        let second = await a.feed(spaceId: "s", since: nil)
        let third = await a.feed(spaceId: "s", since: nil)
        if case .failed(200) = second {} else { XCTFail("\(second)") }
        if case .failed(200) = third {} else { XCTFail("\(third)") }
    }

    func testReportPostsReasonAndPlatform() async throws {
        let t = FakeTransport()
        t.script("/report", [(201, ["ok": true]), (429, nil), (404, nil), (400, nil), (500, nil)])
        let a = api(t)
        let sent = await a.report(spaceId: "s1", reason: .unsafe)
        XCTAssertEqual(sent, .sent)
        let req = t.requests[0]
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.url?.path, "/api/ar/spaces/s1/report")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(req.value(forHTTPHeaderField: "X-Virvi-App-Version"), "7")
        XCTAssertNil(req.value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(req.timeoutInterval, 15)
        let body = t.bodies("/report")[0]
        XCTAssertEqual(body as NSDictionary, ["reason": "unsafe", "platform": "ar-ios"] as NSDictionary)
        let limited = await a.report(spaceId: "s1", reason: .spam)
        XCTAssertEqual(limited, .rateLimited)
        for _ in 0..<3 {
            let failed = await a.report(spaceId: "s1", reason: .other)
            XCTAssertEqual(failed, .failed)
        }
    }

    func testReportOfflineFailed() async {
        let t = FakeTransport()
        t.on("/report") { _ in throw URLError(.timedOut) }
        let r = await api(t).report(spaceId: "s1", reason: .spam)
        XCTAssertEqual(r, .failed)
    }

    func testAnalyticsPostBodyAndResults() async throws {
        let t = FakeTransport()
        t.script("/analytics", [(200, nil), (400, nil), (408, nil), (429, nil), (503, nil)])
        let a = api(t)
        let events = [VisitEvent(type: "enter", playerId: "p", t: 1_700_000_000_000),
                      VisitEvent(type: "pos", playerId: "p", t: 1_700_000_006_000, x: 1, y: 1.5, z: 2)]
        let first = await a.sendAnalytics(spaceId: "s1", events: events)
        XCTAssertEqual(first, .sent)
        let req = t.requests[0]
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.url?.path, "/api/ar/spaces/s1/analytics")
        XCTAssertEqual(req.value(forHTTPHeaderField: "X-Virvi-App-Version"), "7")
        let body = t.bodies("/analytics")[0]
        XCTAssertEqual(body["v"] as? Int, 1)
        XCTAssertEqual(body["platform"] as? String, "ar-ios")
        let evs = try XCTUnwrap(body["events"] as? [[String: Any]])
        XCTAssertEqual(evs.map { $0["type"] as? String }, ["enter", "pos"])
        XCTAssertEqual(evs[0]["t"] as? Int64, 1_700_000_000_000)
        XCTAssertNil(evs[0]["x"])
        XCTAssertEqual(evs[1]["x"] as? Double, 1)
        XCTAssertEqual(evs[1]["y"] as? Double, 1.5)
        var rest: [AnalyticsResult] = []
        for _ in 0..<4 { rest.append(await a.sendAnalytics(spaceId: "s1", events: events)) }
        XCTAssertEqual(rest, [.drop, .retry, .retry, .retry])
    }

    func testAnalyticsOfflineRetries() async {
        let t = FakeTransport()
        t.on("/analytics") { _ in throw URLError(.notConnectedToInternet) }
        let r = await api(t).sendAnalytics(spaceId: "s1", events: [])
        XCTAssertEqual(r, .retry)
    }

    func testAnalyticsStatusDecision() {
        XCTAssertEqual(analyticsResultFor(status: 204), .sent)
        for s in [400, 404, 413] { XCTAssertEqual(analyticsResultFor(status: s), .drop) }
        for s in [408, 429, 500, 503] { XCTAssertEqual(analyticsResultFor(status: s), .retry) }
    }

    // MARK: signed-in feed

    private func signedInApi(_ t: FakeTransport, signedIn: Bool = true) -> ArApi {
        let store = MemoryStore(signedIn ? AppTokens(accessToken: "tok", refreshToken: "r1", userName: nil) : nil)
        return ArApi(baseUrl: base, transport: t, appVersion: "7", session: AppSession(baseUrl: base, transport: t, store: store))
    }

    func testFeedCarriesTheBearerOnlyWhenSignedIn() async {
        let t = FakeTransport()
        t.on("/feed") { _ in (200, self.feedBody) }
        _ = await signedInApi(t).feed(spaceId: "s", since: nil)
        XCTAssertEqual(t.requests[0].value(forHTTPHeaderField: "Authorization"), "Bearer tok")

        let t2 = FakeTransport()
        t2.on("/feed") { _ in (200, self.feedBody) }
        _ = await signedInApi(t2, signedIn: false).feed(spaceId: "s", since: nil)
        XCTAssertNil(t2.requests[0].value(forHTTPHeaderField: "Authorization"))
        _ = await api(t2).feed(spaceId: "s", since: nil)
        XCTAssertNil(t2.requests[1].value(forHTTPHeaderField: "Authorization"))
    }

    func testOtherRequestsStayAnonymousEvenSignedIn() async {
        let t = FakeTransport()
        t.on("/by-code/AB") { _ in (200, self.lookupBody) }
        _ = await signedInApi(t).lookup(code: "AB")
        XCTAssertNil(t.requests[0].value(forHTTPHeaderField: "Authorization"))
    }

    func testFeedRefreshesOnceOn401ThenKeepsGoing() async {
        let t = FakeTransport()
        t.on("/api/auth/refresh") { _ in (200, ["accessToken": "new"]) }
        t.on("/feed") { req in req.value(forHTTPHeaderField: "Authorization") == "Bearer new" ? (200, self.feedBody) : (401, nil) }
        let r = await signedInApi(t).feed(spaceId: "s", since: nil)
        guard case .ok = r else { return XCTFail("\(r)") }
        XCTAssertEqual(t.count("/api/auth/refresh"), 1)
    }

    func testFeedFallsBackToAnonymousWhenSignInIsBroken() async {
        let t = FakeTransport()
        t.on("/api/auth/refresh") { _ in (401, ["error": "Invalid or expired refresh token"]) }
        t.on("/feed") { req in req.value(forHTTPHeaderField: "Authorization") == nil ? (200, self.feedBody) : (401, nil) }
        let a = signedInApi(t)
        let r = await a.feed(spaceId: "s", since: nil)
        guard case .ok = r else { return XCTFail("\(r)") }
        XCTAssertEqual(t.count("/feed"), 2)
        XCTAssertNil(t.requests.last!.value(forHTTPHeaderField: "Authorization"))
    }
}
