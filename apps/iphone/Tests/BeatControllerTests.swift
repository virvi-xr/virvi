import CoreLocation
import CryptoKit
import DeviceCheck
import Foundation
import simd
import XCTest
import VirviARKit
@testable import VirviAR

// MARK: - Fakes

final class MemorySessionStore: SessionStore, @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: AppTokens?
    init(_ t: AppTokens?) { tokens = t }
    func load() -> AppTokens? { lock.lock(); defer { lock.unlock() }; return tokens }
    func save(_ t: AppTokens?) { lock.lock(); tokens = t; lock.unlock() }
}

/// An access token with an `id` claim, as the server's are (unsigned: the app only reads the claim).
func fakeAccessToken(id: String) -> String {
    let payload = try! JSONSerialization.data(withJSONObject: ["id": id])
    let b64 = payload.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
    return "e30.\(b64).sig"
}

/// Signs nothing; records the exact bodies it was asked to sign.
final class RecordingAttester: Attester, @unchecked Sendable {
    private let lock = NSLock()
    private var seen: [Data] = []
    var failWith: Error?
    var bodies: [Data] { lock.lock(); defer { lock.unlock() }; return seen }
    func assertion(for body: Data) async throws -> String {
        if let failWith { throw failWith }
        lock.lock(); seen.append(body); let n = seen.count; lock.unlock()
        return "key1.assertion\(n)"
    }
}

@MainActor
final class FakeLocation: LocationProvider {
    var outcome: LocationOutcome = .fix(BeatLocation(lat: 51.5, lng: -0.1, accuracyM: 12))
    private(set) var asked = 0
    func fix() async -> LocationOutcome { asked += 1; return outcome }
}

@MainActor
final class FakeNotifier: ClaimNotifier {
    private(set) var permissionRequests = 0
    private(set) var scheduled: [(beatId: String, name: String, atMs: Int64)] = []
    private(set) var cancelled: [String] = []
    func requestPermission() async { permissionRequests += 1 }
    func schedule(beatId: String, name: String, atMs: Int64) { scheduled.append((beatId, name, atMs)) }
    func cancel(beatId: String) { cancelled.append(beatId) }
}

/// A sleep the test releases by hand: the check-in timer's 30 s.
final class FakeSleeper: @unchecked Sendable {
    private let lock = NSLock()
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var asked: [Double] = []
    var waiting: Int { lock.lock(); defer { lock.unlock() }; return waiters.count }
    var durations: [Double] { lock.lock(); defer { lock.unlock() }; return asked }

    func sleep(_ seconds: Double) async {
        await withCheckedContinuation { c in
            lock.lock(); waiters.append(c); asked.append(seconds); lock.unlock()
        }
    }

    func release() {
        lock.lock(); let all = waiters; waiters = []; lock.unlock()
        all.forEach { $0.resume() }
    }
}

/// A response the test can change between requests.
final class Box<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var v: T
    init(_ v: T) { self.v = v }
    var value: T { get { lock.lock(); defer { lock.unlock() }; return v } set { lock.lock(); v = newValue; lock.unlock() } }
}

// MARK: - The BEAT card in the visitor flow

@MainActor
final class BeatControllerTests: XCTestCase {
    private let code = VisitorControllerTests.code
    private let eventCode = "3F4E5D6"
    private let base = URL(string: "https://virvi.test")!

    private var transport: FakeTransport!
    private var view: FakeSceneView!
    private var attester: RecordingAttester!
    private var location: FakeLocation!
    private var notifier: FakeNotifier!
    private var sleeper: FakeSleeper!
    private var session: AppSession!
    private var beats: BeatModel!
    private var controller: VisitorController!
    private var nowMs: Int64 = 1_000
    private var wallMs: Int64 = 1_700_000_000_000
    /// The BEAT's start in the cards below (2026-11-24T10:00Z).
    private let startsMs: Int64 = 1_795_514_400_000

    /// What each BEAT route answers, changed per test.
    private let spaceCard = Box<[String: Any]?>(nil)
    private let trackAnswer = Box<(Int, [String: Any])>((200, [:]))
    private let claimAnswers = Box<[(Int, [String: Any])]>([])
    private let mineCards = Box<[[String: Any]]>([])

    private func cardJson(claim: [String: Any]? = nil, minMinutes: Int = 5, type: String = "in_person", venue: String? = "The Loft",
                          wallets: [String] = [], pinned: Bool? = nil) -> [String: Any] {
        var location: [String: Any] = ["type": type]
        if let venue { location["venue"] = venue }
        return ["beatId": "b1", "name": "Opening Night", "imageUrl": "", "minMinutes": minMinutes,
                "startsAt": "2026-11-24T10:00:00.000Z", "endsAt": "2099-11-24T20:00:00.000Z",
                "location": location, "pinned": pinned ?? (type == "in_person"), "claim": claim ?? NSNull(), "wallets": wallets]
    }

    private func claim(_ status: String, seconds: Int = 0) -> [String: Any] {
        ["status": status, "secondsPresent": seconds, "wallet": NSNull(), "checkedInAt": "2026-11-24T10:00:00.000Z"]
    }

    override func setUp() async throws {
        transport = FakeTransport()
        let code = self.code, eventCode = self.eventCode
        transport.on("/api/app/arcs/\(code)") { _ in
            (200, ["kind": "space", "lookup": ["spaceId": "s1", "floorId": "f1", "markerId": "m1", "spaceName": "Loft", "whereText": NSNull()]])
        }
        let eventCard = Box<[String: Any]?>(nil)
        self.eventCardBox = eventCard
        transport.on("/api/app/arcs/\(eventCode)") { _ in
            var body: [String: Any] = ["kind": "beat", "beatId": "b1", "name": "Opening Night"]
            if let c = eventCard.value { body["card"] = c }
            return (200, body)
        }
        transport.on("/feed") { req in
            if req.url!.query?.contains("since=1") == true { try await Task.sleep(nanoseconds: 3_600 * 1_000_000_000) }
            return (200, VisitorControllerTests.feedBody())
        }
        let spaceCard = self.spaceCard, trackAnswer = self.trackAnswer, claimAnswers = self.claimAnswers, mineCards = self.mineCards
        transport.on("/api/app/beats/mine") { _ in (200, ["beats": mineCards.value]) }
        transport.on("/api/app/spaces/s1/beat") { _ in (200, ["beat": spaceCard.value ?? NSNull()]) }
        transport.on("/api/app/beats/b1/track") { req in
            req.httpMethod == "DELETE" ? (204, nil) : (trackAnswer.value.0, trackAnswer.value.1)
        }
        transport.on("/api/app/beats/b1/checkin") { _ in (200, ["beat": spaceCard.value ?? NSNull()]) }
        transport.on("/api/app/beats/b1/claim") { _ in
            var all = claimAnswers.value
            let next = all.count > 1 ? all.removeFirst() : (all.first ?? (500, [:]))
            claimAnswers.value = all
            return next
        }
        view = FakeSceneView()
        attester = RecordingAttester()
        location = FakeLocation()
        notifier = FakeNotifier()
        sleeper = FakeSleeper()
        session = AppSession(baseUrl: base, transport: transport,
                             store: MemorySessionStore(AppTokens(accessToken: fakeAccessToken(id: "u1"), refreshToken: "r", userName: "Ana")))
        let beatApi = AppBeatApi(baseUrl: base, transport: transport, session: session, attest: attester)
        let sleeper = self.sleeper!
        self.beatApi = beatApi
        beats = BeatModel(api: beatApi, session: session, location: location, notifier: notifier,
                          wallClock: { [unowned self] in self.wallMs }, sleep: { await sleeper.sleep($0) })
        let api = ArApi(baseUrl: base, transport: transport, appVersion: "test", session: session)
        controller = VisitorController(api: api, view: view, outline: FakeOutline(), analytics: VisitAnalytics(send: { _, _ in .sent }),
                                       beats: beats, clock: { [unowned self] in self.nowMs }, flushIntervalS: 3_600)
    }

    private var eventCardBox: Box<[String: Any]?>!
    private var beatApi: AppBeatApi!

    override func tearDown() async throws {
        controller.stop()
        sleeper.release()
        controller = nil
        beats = nil
    }

    // MARK: helpers

    private func frame(ring: UInt32, distanceM: Double) -> PipelineResult {
        let k = VisitorControllerTests.k
        let semiMajor = k.fx * 0.07 / distanceM
        let d = RingDetection(id: ring, version: 0, corrected: 0, cx: 640, cy: 480,
                              semiMajor: semiMajor, semiMinor: semiMajor, angleDeg: 0, rotationDeg: 0)
        return PipelineResult(frame: RingFrame(detections: [d], unreadable: []), intrinsics: k, cameraTransform: matrix_identity_float4x4)
    }

    private func seeRing(_ ring: UInt32, frames count: Int, distanceM: Double = 0.8) async throws {
        for _ in 0..<count {
            nowMs += 125
            controller.onCameraPose(matrix_identity_float4x4)
            controller.onCameraFrame(frame(ring: ring, distanceM: distanceM), walls: [VisitorControllerTests.wall])
            try await Task.sleep(nanoseconds: 50_000_000)
        }
    }

    private func showSpace() async throws {
        try await seeRing(VisitorControllerTests.ring, frames: 15)
        XCTAssertTrue(controller.sceneShown)
    }

    private func until(_ what: String, timeout: Double = 5, _ condition: () -> Bool) async {
        let end = Date().addingTimeInterval(timeout)
        while !condition() && Date() < end { try? await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertTrue(condition(), "timed out waiting for \(what)")
    }

    private func body(_ r: URLRequest) -> [String: Any] {
        (r.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
    }

    private func requests(_ suffix: String) -> [URLRequest] { transport.requests.filter { $0.url!.path.hasSuffix(suffix) } }

    /// Track my attendance, and agree to the consent text it shows first (every time).
    private func trackAgreeing() async {
        beats.primaryAction()
        await until("the consent text") { beats.consentText != nil }
        beats.acceptConsent()
    }

    /// One tick of the check-in timer: waits for it to be asleep, lets it go, and waits for the check-in to land.
    private func tick(expectingCheckIns n: Int) async {
        await until("the timer to sleep") { sleeper.waiting == 1 }
        sleeper.release()
        await until("check-in \(n)") { transport.count("/checkin") == n }
    }

    // MARK: check-ins

    func testNoCheckInsBeforeTheSpaceIsShownOrOnceItIsHidden() async throws {
        spaceCard.value = cardJson(claim: claim("present", seconds: 60), type: "scene")
        try await seeRing(VisitorControllerTests.ring, frames: 2)
        XCTAssertFalse(controller.sceneShown)
        XCTAssertEqual(sleeper.waiting, 0, "no timer before the space is shown")

        try await seeRing(VisitorControllerTests.ring, frames: 15)
        await tick(expectingCheckIns: 1)

        controller.sessionInterrupted()
        // Locking the same space again: the timer keeps going but doesn't check in
        await until("the timer to sleep") { sleeper.waiting == 1 }
        sleeper.release()
        await until("the timer to sleep again") { sleeper.waiting == 1 }
        XCTAssertEqual(transport.count("/checkin"), 1, "a hidden space doesn't check in")

        // Leaving the space stops it: its sleep ends and it neither checks in nor sleeps again
        controller.lookAgain()
        sleeper.release()
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(transport.count("/checkin"), 1)
        XCTAssertEqual(sleeper.waiting, 0)
    }

    func testOneCheckInEvery30SecondsWhileTheSpaceIsShown() async throws {
        spaceCard.value = cardJson(claim: claim("present", seconds: 60), type: "scene")
        try await showSpace()
        await tick(expectingCheckIns: 1)
        await tick(expectingCheckIns: 2)
        await tick(expectingCheckIns: 3)
        XCTAssertEqual(Set(sleeper.durations), [30])
        // The feed is asked as the signed-in visitor: the server credits check-ins only for presence on the feed
        let feed = try XCTUnwrap(requests("/feed").first)
        XCTAssertEqual(feed.value(forHTTPHeaderField: "Authorization")?.hasPrefix("Bearer "), true)
        let first = try XCTUnwrap(requests("/checkin").first)
        XCTAssertEqual(body(first)["spaceId"] as? String, "s1")
        XCTAssertEqual(first.value(forHTTPHeaderField: "X-Virvi-Attest"), "key1.assertion1")
        XCTAssertEqual(attester.bodies.first, first.httpBody, "the signed bytes are the sent bytes")
    }

    func testTheReminderIsSetForTheFirstCheckInPlusTheMinimumMinutesAndPermissionIsAskedOnce() async throws {
        spaceCard.value = cardJson(claim: claim("present", seconds: 60), type: "scene")
        try await showSpace()
        wallMs = 1_700_000_100_000
        await tick(expectingCheckIns: 1)
        await until("the reminder") { notifier.scheduled.count == 1 }
        XCTAssertEqual(notifier.scheduled[0].beatId, "b1")
        XCTAssertEqual(notifier.scheduled[0].name, "Opening Night")
        XCTAssertEqual(notifier.scheduled[0].atMs, 1_700_000_100_000 + 4 * 60_000, "the minutes still left: 5 less the 1 already counted")
        wallMs += 30_000
        await tick(expectingCheckIns: 2)
        XCTAssertEqual(notifier.permissionRequests, 1)
        XCTAssertEqual(notifier.scheduled.count, 1, "set once, at the first check-in")
    }

    func testACheckInThatFailsToAttestIsShownAndStopsTheTimer() async throws {
        spaceCard.value = cardJson(claim: claim("present", seconds: 60), type: "scene")
        attester.failWith = URLError(.cancelled)
        try await showSpace()
        await until("the timer to sleep") { sleeper.waiting == 1 }
        sleeper.release()
        await until("the refusal") { beats.card.state == .failed(message: "This app couldn't be verified. Update the Virvi app and try again.") }
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(sleeper.waiting, 0, "the loop ended: no silent key registration every 30 s")
        XCTAssertEqual(transport.count("/checkin"), 0)
    }

    func testSignedOutASharedSpacesBeatAsksToSignIn() async throws {
        spaceCard.value = cardJson(type: "scene")
        session.signOut()
        try await showSpace()
        await until("the sign-in card") { beats.card.state == .signInToEarn(name: "Opening Night", minutes: 5) }
        XCTAssertEqual(beats.card.buttonTitle, "Sign in to earn this BEAT")
        XCTAssertNil(requests("/api/app/spaces/s1/beat").first?.value(forHTTPHeaderField: "Authorization"))
    }

    func testPreciseLocationOffSendsToSettings() async throws {
        eventCardBox.value = cardJson()
        location.outcome = .reduced
        try await seeRing(RingCodec.parseCode(eventCode)!, frames: 15)
        await until("the card") { beats.card.state != .hidden }
        await trackAgreeing()
        await until("the refusal") { beats.card.state == .failed(message: BeatModel.NEEDS_PRECISE) }
        XCTAssertTrue(beats.locationDenied)
        XCTAssertEqual(transport.count("/track"), 0)
    }

    // MARK: event ARCs

    func testAnEventARCOpensTheBeatCardAndNeverStartsTheFeedOrLoadsASpace() async throws {
        eventCardBox.value = cardJson()
        try await seeRing(RingCodec.parseCode(eventCode)!, frames: 15)

        await until("the card") { beats.card.state != .hidden }
        XCTAssertEqual(beats.card.state, .track(name: "Opening Night", minutes: 5))
        XCTAssertEqual(beats.card.text, "Attend for 5 minutes to earn the Opening Night BEAT.")
        XCTAssertEqual(transport.count("/feed"), 0, "no feed")
        XCTAssertEqual(transport.count("/by-code/\(eventCode)"), 0)
        XCTAssertTrue(view.roots.isEmpty)
        XCTAssertFalse(controller.sceneShown)
        XCTAssertEqual(transport.count("/api/app/arcs/\(eventCode)"), 1, "one scan only: it isn't looked up again while in view")
        guard case .hint = controller.state else { return XCTFail("\(controller.state)") }
    }

    func testSignedOutAnEventARCShowsTheNameAndSignIn() async throws {
        session.signOut()
        try await seeRing(RingCodec.parseCode(eventCode)!, frames: 15)
        await until("the prompt") { beats.signInName != nil }
        XCTAssertEqual(beats.signInName, "Opening Night")
        XCTAssertNil(requests("/api/app/arcs/\(eventCode)").first?.value(forHTTPHeaderField: "Authorization"))
    }

    func testTrackingAnEventShowsTheConsentEveryTimeThenSendsItsVersionAndTheFixAndSchedulesFromTheStart() async throws {
        eventCardBox.value = cardJson()
        trackAnswer.value = (200, ["beat": cardJson(claim: claim("present", seconds: 0))])
        try await seeRing(RingCodec.parseCode(eventCode)!, frames: 15)
        await until("the card") { beats.card.state != .hidden }

        beats.primaryAction()
        await until("the consent text") { beats.consentText != nil }
        XCTAssertEqual(beats.consentText, beatAppConsentText("Opening Night"))
        XCTAssertEqual(transport.count("/track"), 0, "nothing is sent before the visitor agrees")

        wallMs = 1_700_000_500_000
        beats.acceptConsent()
        await until("the track") { transport.count("/track") == 1 }
        let sent = body(requests("/track")[0])
        XCTAssertEqual(sent["consentVersion"] as? Int, 1)
        XCTAssertEqual(sent["arcCode"] as? String, eventCode)
        XCTAssertEqual((sent["location"] as? [String: Any])?["accuracyM"] as? Double, 12)
        await until("the reminder") { notifier.scheduled.count == 1 }
        XCTAssertEqual(notifier.scheduled[0].atMs, startsMs + 5 * 60_000, "tracked before the start: the minutes count from the start")
        XCTAssertEqual(notifier.permissionRequests, 1)
        XCTAssertEqual(beats.card.state, .counting(name: "Opening Night", minutesLeft: 5))

        // Stopping and tracking again: the consent text is shown again, as in-world
        beats.stopTracking()
        await until("stopped") { beats.card.state == .track(name: "Opening Night", minutes: 5) }
        XCTAssertEqual(notifier.cancelled, ["b1"])
        beats.primaryAction()
        await until("the consent text again") { beats.consentText != nil }
        XCTAssertEqual(transport.count("/track"), 2, "POST, DELETE: nothing more before the visitor agrees")
        beats.acceptConsent()
        await until("the second track") { transport.count("/track") == 3 }
    }

    func testNoLocationIsAskedForAnOnlineBeat() async throws {
        eventCardBox.value = cardJson(type: "online", venue: nil)
        trackAnswer.value = (200, ["beat": cardJson(claim: claim("present"), type: "online", venue: nil)])
        try await seeRing(RingCodec.parseCode(eventCode)!, frames: 15)
        await until("the card") { beats.card.state != .hidden }
        await trackAgreeing()
        await until("the track") { transport.count("/track") == 1 }
        XCTAssertEqual(location.asked, 0)
        XCTAssertNil(body(requests("/track")[0])["location"])
    }

    func testDeniedLocationSaysToAllowItInSettingsAndSendsNothing() async throws {
        eventCardBox.value = cardJson()
        location.outcome = .denied
        try await seeRing(RingCodec.parseCode(eventCode)!, frames: 15)
        await until("the card") { beats.card.state != .hidden }
        await trackAgreeing()
        await until("the refusal") { beats.card.state == .failed(message: BeatModel.NO_LOCATION) }
        XCTAssertTrue(beats.locationDenied)
        XCTAssertEqual(transport.count("/track"), 0, "no request without a fix")
        XCTAssertTrue(BeatModel.NO_LOCATION.contains("Settings"))
    }

    func testNoFixInTimeSaysSoAndSendsNothing() async throws {
        eventCardBox.value = cardJson()
        location.outcome = .unavailable
        try await seeRing(RingCodec.parseCode(eventCode)!, frames: 15)
        await until("the card") { beats.card.state != .hidden }
        await trackAgreeing()
        await until("the refusal") { beats.card.state == .poorFix }
        XCTAssertEqual(beats.card.text, VisitorCopy.BEAT_POOR_FIX)
        XCTAssertEqual(transport.count("/track"), 0)
    }

    // MARK: claiming

    private func openClaimableEvent(wallets: [String] = []) async throws {
        eventCardBox.value = cardJson(claim: claim("present", seconds: 600), wallets: wallets)
        try await seeRing(RingCodec.parseCode(eventCode)!, frames: 15)
        await until("the claim button") { beats.card.state == .claimable(name: "Opening Night") }
    }

    func testClaimingWithTwoWalletsPresentsTheChoiceAndSendsTheChosenOne() async throws {
        let a = "0x1234567890abcdef1234567890abcdef12345678", b = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"
        try await openClaimableEvent(wallets: [a, b])
        claimAnswers.value = [(409, ["error": "choose_wallet", "message": "Which wallet?", "wallets": [a, b]]),
                              (200, ["beat": cardJson(claim: claim("claimed", seconds: 600))])]

        beats.primaryAction()
        await until("the choice") { beats.card.state == .chooseWallet(name: "Opening Night", wallets: [a, b]) }
        XCTAssertNil(body(requests("/claim")[0])["wallet"])
        XCTAssertEqual(shortWallet(a), "0x1234…5678")

        beats.claim(wallet: b)
        await until("the second claim") { transport.count("/claim") == 2 }
        XCTAssertEqual(body(requests("/claim")[1])["wallet"] as? String, b)
        await until("sent") { beats.card.state == .sent(name: "Opening Night") }
        XCTAssertEqual(beats.card.text, "Your Opening Night BEAT is in your wallet")
        XCTAssertEqual(notifier.cancelled, ["b1"], "the reminder is cancelled once the claim is done")
    }

    func testClaimingOutsideTheVenueShowsTheExactCopyAndSendsTheFix() async throws {
        try await openClaimableEvent()
        claimAnswers.value = [(403, ["error": "outside", "message": "x"])]
        beats.primaryAction()
        await until("the refusal") { beats.card.state == .outside(venue: "The Loft") }
        XCTAssertEqual(beats.card.text, "Come back to The Loft to claim this BEAT.")
        XCTAssertEqual((body(requests("/claim")[0])["location"] as? [String: Any])?["lat"] as? Double, 51.5)
        XCTAssertTrue(beats.canRetry)
    }

    func testAClaimWithNoWalletIsSavedForTheVisitor() async throws {
        try await openClaimableEvent()
        claimAnswers.value = [(200, ["beat": cardJson(claim: claim("waiting", seconds: 600))])]
        beats.primaryAction()
        await until("waiting") { beats.card.state == .waitingForWallet(name: "Opening Night") }
        XCTAssertEqual(beats.card.text, "Saved for you. Link a wallet at virvi.io and it'll be sent.")
    }

    func testAPhoneThatCantAttestShowsItsOwnWordsOnTheCard() async throws {
        struct Unsupported: Attester { func assertion(for body: Data) async throws -> String { throw AttestUnsupported() } }
        let api = AppBeatApi(baseUrl: base, transport: transport, session: session, attest: Unsupported())
        let model = BeatModel(api: api, session: session, location: location, notifier: notifier)
        let card = parseAppBeatCard(cardJson(claim: claim("present", seconds: 600)))
        model.openEvent(code: eventCode, name: "Opening Night", card: card)
        model.primaryAction()
        await until("the refusal") { model.card.state == .failed(message: "This phone can't earn BEATs.") }
        XCTAssertEqual(transport.count("/claim"), 0)
    }

    // MARK: one scan only: claiming in person when the time is up

    func testACountingEventCardOffersTheClaimWhenItsTimeIsUpWithoutAnotherScan() async throws {
        wallMs = startsMs + 3_600_000
        // Two of five minutes already earned (in Decentraland, say): three are left
        eventCardBox.value = cardJson(claim: claim("present", seconds: 120))
        try await seeRing(RingCodec.parseCode(eventCode)!, frames: 15)
        await until("the card") { beats.card.state == .counting(name: "Opening Night", minutesLeft: 3) }
        await until("the wait for the time left") { sleeper.durations.contains(180) }

        wallMs += 180_000
        mineCards.value = [cardJson(claim: claim("present", seconds: 300))]
        sleeper.release()
        await until("the claim button") { beats.card.state == .claimable(name: "Opening Night") }
        XCTAssertEqual(beats.card.buttonTitle, "Claim your BEAT")
        XCTAssertEqual(transport.count("/api/app/arcs/\(eventCode)"), 1, "never scanned again")

        claimAnswers.value = [(200, ["beat": cardJson(claim: claim("claimed", seconds: 300))])]
        beats.primaryAction()
        await until("sent") { beats.card.state == .sent(name: "Opening Night") }
        XCTAssertNotNil(body(requests("/claim")[0])["location"], "a pinned BEAT is checked at the venue")
    }

    func testComingBackToTheAppAsksForAnEventCardAgain() async throws {
        wallMs = startsMs + 3_600_000
        eventCardBox.value = cardJson(claim: claim("present", seconds: 120))
        try await seeRing(RingCodec.parseCode(eventCode)!, frames: 15)
        await until("the card") { beats.card.state == .counting(name: "Opening Night", minutesLeft: 3) }
        mineCards.value = [cardJson(claim: claim("present", seconds: 310))]
        beats.appBecameActive()
        await until("the claim button") { beats.card.state == .claimable(name: "Opening Night") }
        XCTAssertEqual(transport.count("/api/app/arcs/\(eventCode)"), 1)
    }

    func testAMyBeatsRowInProgressOrClaimableOpensItsCardAndClaimsWithTheIdAndAFix() async throws {
        var sent = cardJson(claim: claim("claimed", seconds: 300))
        sent["beatId"] = "b2"
        mineCards.value = [cardJson(claim: claim("present", seconds: 300)), sent]
        let myBeats = MyBeatsModel(api: beatApi, wallClock: { [unowned self] in self.wallMs })
        myBeats.openCard = { [unowned self] in self.beats.openBeat($0) }
        await myBeats.load()
        guard case .loaded(let rows) = myBeats.phase else { return XCTFail("\(myBeats.phase)") }
        XCTAssertEqual(rows.map(\.opens), [true, false], "only a BEAT in progress or ready to claim opens")
        myBeats.open(rows[1])
        XCTAssertFalse(beats.visible)

        myBeats.open(rows[0])
        XCTAssertEqual(beats.card.state, .claimable(name: "Opening Night"))
        XCTAssertEqual(beats.origin, .beat("b1"))
        claimAnswers.value = [(200, ["beat": cardJson(claim: claim("claimed", seconds: 300))])]
        beats.primaryAction()
        await until("sent") { beats.card.state == .sent(name: "Opening Night") }
        XCTAssertEqual(location.asked, 1)
        XCTAssertEqual(requests("/claim").first?.url?.path, "/api/app/beats/b1/claim")
        XCTAssertTrue(transport.requests.allSatisfy { !$0.url!.path.contains("/api/app/arcs/") }, "no scan at all")
        beats.closeEvent()
        XCTAssertFalse(beats.visible)
    }

    func testATappedReminderOpensItsBeatsCard() async {
        mineCards.value = [cardJson(claim: claim("present", seconds: 300))]
        await beats.openBeat(id: "b1")
        XCTAssertEqual(beats.card.state, .claimable(name: "Opening Night"))
        XCTAssertEqual(beatId(fromNotification: ["beatId": "b1"]), "b1")
        XCTAssertNil(beatId(fromNotification: [:]))
        XCTAssertNil(beatId(fromNotification: ["beatId": ""]))
    }

    // MARK: a BEAT with no pin

    func testAnInPersonBeatWithNoPinTracksAndClaimsWithoutAskingForTheLocation() async throws {
        eventCardBox.value = cardJson(pinned: false)
        trackAnswer.value = (200, ["beat": cardJson(claim: claim("present", seconds: 300), pinned: false)])
        claimAnswers.value = [(200, ["beat": cardJson(claim: claim("claimed", seconds: 300), pinned: false)])]
        try await seeRing(RingCodec.parseCode(eventCode)!, frames: 15)
        await until("the card") { beats.card.state != .hidden }
        await trackAgreeing()
        await until("the claim button") { beats.card.state == .claimable(name: "Opening Night") }
        beats.primaryAction()
        await until("sent") { beats.card.state == .sent(name: "Opening Night") }
        XCTAssertEqual(location.asked, 0, "no pin, no location prompt")
        XCTAssertNil(body(requests("/track")[0])["location"])
        XCTAssertNil(body(requests("/claim")[0])["location"])
    }

    // MARK: a moment's loss of tracking

    func testLosingTheRingForAMomentKeepsTheCardAndItsTimer() async throws {
        spaceCard.value = cardJson(claim: claim("present", seconds: 60), type: "scene")
        try await showSpace()
        await until("the card") { beats.card.state == .counting(name: "Opening Night", minutesLeft: 4) }
        await tick(expectingCheckIns: 1)
        await until("the reminder") { notifier.scheduled.count == 1 }

        controller.trackingChanged(normal: false)
        guard case .locking = controller.state else { return XCTFail("\(controller.state)") }
        XCTAssertEqual(beats.card.state, .counting(name: "Opening Night", minutesLeft: 4), "the card stays")
        XCTAssertEqual(notifier.cancelled, ["b1"], "no time counts while the space isn't in view: its reminder waits")
        // The timer keeps its count, but checks in only while the space is in view
        await until("the timer to sleep") { sleeper.waiting == 1 }
        sleeper.release()
        await until("the timer to sleep again") { sleeper.waiting == 1 }
        XCTAssertEqual(transport.count("/checkin"), 1)

        controller.trackingChanged(normal: true)
        try await showSpace()
        XCTAssertEqual(beats.card.state, .counting(name: "Opening Night", minutesLeft: 4))
        XCTAssertEqual(requests("/api/app/spaces/s1/beat").count, 1, "the same card, not asked for again")
        await tick(expectingCheckIns: 2)
        await until("the reminder set again") { notifier.scheduled.count == 2 }
    }

    func testLookingAgainClearsTheSpacesCard() async throws {
        spaceCard.value = cardJson(claim: claim("present", seconds: 60), type: "scene")
        try await showSpace()
        await until("the card") { beats.card.state != .hidden }
        controller.lookAgain()
        XCTAssertEqual(beats.card.state, .hidden)
    }
}

// MARK: - App Attest

private final class FakeAttestService: AttestService, @unchecked Sendable {
    private let lock = NSLock()
    var supported = true
    private(set) var generated = 0
    private(set) var attested: [(keyId: String, hash: Data)] = []
    private(set) var asserted: [(keyId: String, hash: Data)] = []
    var failAttest = false
    var invalidKeys: Set<String> = []
    var isSupported: Bool { supported }

    func generateKey() async throws -> String {
        lock.lock(); defer { lock.unlock() }
        generated += 1
        return "key-\(generated)"
    }
    func attestKey(_ keyId: String, clientDataHash: Data) async throws -> Data {
        lock.lock(); defer { lock.unlock() }
        attested.append((keyId, clientDataHash))
        if failAttest { throw URLError(.cancelled) }
        return Data("attestation-\(keyId)".utf8)
    }
    func generateAssertion(_ keyId: String, clientDataHash: Data) async throws -> Data {
        lock.lock(); defer { lock.unlock() }
        asserted.append((keyId, clientDataHash))
        if invalidKeys.contains(keyId) { throw DCError(.invalidKey) }
        return Data("assertion".utf8)
    }
}

private final class MemoryKeyStore: AttestKeyStore, @unchecked Sendable {
    private let lock = NSLock()
    private var id: String?
    func load() -> String? { lock.lock(); defer { lock.unlock() }; return id }
    func save(_ keyId: String?) { lock.lock(); id = keyId; lock.unlock() }
}

final class AppAttesterTests: XCTestCase {
    private let base = URL(string: "https://virvi.test")!
    private let challenge = "dGhpcyBpcyBhIGNoYWxsZW5nZQ"
    private var transport: FakeTransport!
    private var service: FakeAttestService!
    private var store: MemoryKeyStore!
    private var session: AppSession!
    private let registerStatus = Box<Int>(201)

    override func setUp() {
        transport = FakeTransport()
        let challenge = self.challenge, registerStatus = self.registerStatus
        transport.on("/api/app/attest/challenge") { _ in (200, ["challenge": challenge]) }
        transport.on("/api/app/attest/register") { _ in (registerStatus.value, registerStatus.value == 201 ? ["keyId": "x"] : ["error": "bad_attestation"]) }
        service = FakeAttestService()
        store = MemoryKeyStore()
        session = AppSession(baseUrl: base, transport: transport,
                             store: MemorySessionStore(AppTokens(accessToken: "tok", refreshToken: "r", userName: nil)))
    }

    private func attester() -> AppAttester {
        AppAttester(service: service, store: store, baseUrl: base, transport: transport, session: session)
    }

    private func sha(_ d: Data) -> Data { Data(SHA256.hash(data: d)) }

    func testItRegistersOnceWithTheHashOfTheChallengeTextAndAssertsOverTheBodysHash() async throws {
        let a = attester()
        let body = Data(#"{"consentVersion":1}"#.utf8)
        let header = try await a.assertion(for: body)
        XCTAssertEqual(header, "key-1.\(Data("assertion".utf8).base64EncodedString())")
        XCTAssertEqual(service.attested.first?.hash, sha(Data(challenge.utf8)), "the hash of the challenge's text, not of its decoded bytes")
        XCTAssertEqual(service.asserted.first?.hash, sha(body))
        XCTAssertEqual(store.load(), "key-1")

        let registerBody = try XCTUnwrap(transport.requests.first { $0.url!.path.hasSuffix("/register") }?.httpBody)
        let o = try XCTUnwrap(JSONSerialization.jsonObject(with: registerBody) as? [String: Any])
        XCTAssertEqual(o["keyId"] as? String, "key-1")
        XCTAssertEqual(o["challenge"] as? String, challenge)
        XCTAssertEqual(o["attestation"] as? String, Data("attestation-key-1".utf8).base64EncodedString())

        _ = try await a.assertion(for: Data())
        XCTAssertEqual(service.generated, 1, "one key, registered once")
        XCTAssertEqual(transport.count("/register"), 1)
        XCTAssertEqual(service.asserted.last?.hash, sha(Data()), "a DELETE signs the empty body")
    }

    func testTheKeepKeyIsUsedAfterARestartWithoutRegisteringAgain() async throws {
        store.save("key-kept")
        let header = try await attester().assertion(for: Data("{}".utf8))
        XCTAssertTrue(header.hasPrefix("key-kept."))
        XCTAssertEqual(service.generated, 0)
        XCTAssertEqual(transport.count("/register"), 0)
    }

    func testAFailedRegistrationKeepsNothingAndTheNextWriteTriesAgainWithANewKey() async throws {
        registerStatus.value = 400
        let a = attester()
        do { _ = try await a.assertion(for: Data()); XCTFail("should throw") } catch {}
        XCTAssertNil(store.load())

        registerStatus.value = 201
        let header = try await a.assertion(for: Data())
        XCTAssertTrue(header.hasPrefix("key-2."), header)
        XCTAssertEqual(store.load(), "key-2")
    }

    func testRenewingTheKeyMakesAndRegistersANewOne() async throws {
        let a = attester()
        _ = try await a.assertion(for: Data())
        await a.renewKey()
        XCTAssertNil(store.load())
        let header = try await a.assertion(for: Data())
        XCTAssertTrue(header.hasPrefix("key-2."), header)
        XCTAssertEqual(transport.count("/register"), 2)
    }

    func testAfterAReinstallTheKeptKeyIsInvalidAndANewOneIsRegisteredAndTheWriteSucceeds() async throws {
        store.save("key-from-before-the-reinstall")
        service.invalidKeys = ["key-from-before-the-reinstall"]
        let header = try await attester().assertion(for: Data("{}".utf8))
        XCTAssertTrue(header.hasPrefix("key-1."), header)
        XCTAssertEqual(store.load(), "key-1")
        XCTAssertEqual(transport.count("/register"), 1)
        XCTAssertEqual(service.asserted.map(\.keyId), ["key-from-before-the-reinstall", "key-1"])
    }

    func testAPhoneWithoutAppAttestThrowsUnsupportedAndTouchesNothing() async {
        service.supported = false
        do { _ = try await attester().assertion(for: Data()); XCTFail("should throw") } catch is AttestUnsupported {} catch { XCTFail("\(error)") }
        XCTAssertTrue(transport.requests.isEmpty)
        XCTAssertEqual(service.generated, 0)
    }

    func testTheKeychainKeyStoreRoundTripsAndClears() {
        let keys = KeychainAttestKeyStore(service: "io.virvi.app.tests.\(UUID().uuidString)")
        defer { keys.save(nil) }
        XCTAssertNil(keys.load())
        keys.save("abc")
        XCTAssertEqual(keys.load(), "abc")
        keys.save("def")
        XCTAssertEqual(keys.load(), "def")
        keys.save(nil)
        XCTAssertNil(keys.load())
    }
}

// MARK: - The location fix

@MainActor
private final class FakeLocationManager: LocationManaging {
    var authorization: LocationAuthorization
    var onAuthorizationChange: (() -> Void)?
    var onLocation: ((CLLocation) -> Void)?
    var onError: ((Error) -> Void)?
    private(set) var permissionRequests = 0
    private(set) var fixRequests = 0
    init(_ a: LocationAuthorization) { authorization = a }
    func requestPermission() { permissionRequests += 1 }
    func requestOne() { fixRequests += 1 }
}

@MainActor
final class VenueLocationTests: XCTestCase {
    private func settle(_ n: Int = 5) async { for _ in 0..<n { await Task.yield(); try? await Task.sleep(nanoseconds: 10_000_000) } }

    func testTheTenSecondsStartOnlyOnceTheVisitorHasAllowedAndAreNotSpentOnThePrompt() async throws {
        let manager = FakeLocationManager(.notDetermined)
        let sleeper = FakeSleeper()
        let vl = VenueLocation(manager: manager, sleep: { await sleeper.sleep($0) })
        let result = Task { await vl.fix() }
        await settle()
        XCTAssertEqual(manager.permissionRequests, 1)
        XCTAssertEqual(manager.fixRequests, 0)
        XCTAssertEqual(sleeper.waiting, 0, "no deadline while the prompt is open")

        // A late Allow still gets its fix
        manager.authorization = .full
        manager.onAuthorizationChange?()
        await settle()
        XCTAssertEqual(manager.fixRequests, 1)
        XCTAssertEqual(sleeper.waiting, 1, "the deadline starts when the fix is asked for")
        XCTAssertEqual(sleeper.durations, [10])
        manager.onLocation?(CLLocation(coordinate: CLLocationCoordinate2D(latitude: 1.5, longitude: 2.5), altitude: 0,
                                       horizontalAccuracy: 8, verticalAccuracy: 0, timestamp: Date()))
        let outcome = await result.value
        XCTAssertEqual(outcome, .fix(BeatLocation(lat: 1.5, lng: 2.5, accuracyM: 8)))
        sleeper.release()
    }

    func testNoFixWithinTheDeadlineIsUnavailable() async {
        let manager = FakeLocationManager(.full)
        let sleeper = FakeSleeper()
        let vl = VenueLocation(manager: manager, sleep: { await sleeper.sleep($0) })
        let result = Task { await vl.fix() }
        await settle()
        XCTAssertEqual(manager.fixRequests, 1)
        sleeper.release()
        let outcome = await result.value
        XCTAssertEqual(outcome, .unavailable)
    }

    func testDeniedAndReducedAccuracyAreAnsweredAtOnceWithoutAskingForAFix() async {
        for (auth, want) in [(LocationAuthorization.denied, LocationOutcome.denied), (.reduced, .reduced)] {
            let manager = FakeLocationManager(auth)
            let vl = VenueLocation(manager: manager, sleep: { _ in })
            let outcome = await vl.fix()
            XCTAssertEqual(outcome, want)
            XCTAssertEqual(manager.fixRequests, 0)
            XCTAssertEqual(manager.permissionRequests, 0)
        }
    }

    func testRefusingThePromptIsDenied() async {
        let manager = FakeLocationManager(.notDetermined)
        let vl = VenueLocation(manager: manager, sleep: { _ in })
        let result = Task { await vl.fix() }
        await settle()
        manager.authorization = .denied
        manager.onAuthorizationChange?()
        let outcome = await result.value
        XCTAssertEqual(outcome, .denied)
    }
}
