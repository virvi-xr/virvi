import XCTest
@testable import VirviARKit

/// Mirrors apps/quest/app/src/test/java/io/virvi/ar/visitor/VisitorFlowTest.kt (`HeadsetOff`/`HeadsetOn` are
/// `sessionInterrupted`/`sessionResumed`; the builder-only `Adopt` case isn't ported), then the iPhone plan's Review
/// Focus 3, 4 and 5 cases.
final class VisitorFlowTests: XCTestCase {
    private let ringA: UInt32 = 0x1D2C_3B4A
    private let ringA2: UInt32 = 0x1D2C_3B4B
    private let ringOther: UInt32 = 0x2E3D_4C5B
    private let pose = MarkerPose(x: 1, y: 1.5, z: 2, headingDeg: 90)
    private let t0: Int64 = 1_000_000

    private func marker(_ id: String, _ ring: UInt32, _ p: MarkerPose?? = .none) -> ArMarker {
        ArMarker(id: id, ringId: ring, code: RingCodec.codeOf(ring), diameterMm: 140, whereText: nil, pose: p ?? pose)
    }

    private func space(_ id: String = "sp-a", rings: [ArMarker]? = nil, published: Bool = true) -> ArSpace {
        ArSpace(id: id, name: "Cafe \(id)", place: nil, published: published,
                floors: [ArFloor(id: "f1", name: "Ground", heightM: 0, sortOrder: 0,
                                 markers: rings ?? [marker("m1", ringA), marker("m2", ringA2)])])
    }

    private func snap(_ s: ArSpace? = nil, _ v: String = "1") -> ArFeedSnapshot {
        ArFeedSnapshot(version: v, space: s ?? space())
    }

    private func lookupOk(_ spaceId: String = "sp-a") -> ApiResult<MarkerLookup> {
        .ok(MarkerLookup(spaceId: spaceId, floorId: "f1", markerId: "m1", spaceName: "Cafe \(spaceId)", whereText: nil))
    }

    private var flow = VisitorFlow()
    private var now: Int64 = 0

    override func setUp() {
        flow = VisitorFlow()
        now = t0
    }

    @discardableResult
    private func on(_ e: VisitorEvent) -> [VisitorEffect] { flow.on(e, nowMs: now) }

    private func code(_ ring: UInt32) -> String { RingCodec.codeOf(ring) }

    private func toLocking(_ s: ArSpace? = nil) {
        let s = s ?? space()
        on(.ringAgreed(ringId: ringA))
        on(.lookup(code: code(ringA), result: lookupOk(s.id)))
        on(.feed(snap(s)))
    }

    private func toShown(_ s: ArSpace? = nil) {
        toLocking(s)
        on(.steady(ringId: ringA, world: Vec3(x: 0, y: 1.5, z: 0), headingDeg: 10))
    }

    private var shownSpace: ArSpace? {
        if case .shown(let s, _) = flow.state { return s }
        return nil
    }

    private var shownRoot: RootPose? {
        if case .shown(_, let r) = flow.state { return r }
        return nil
    }

    private var isLocking: Bool {
        if case .locking = flow.state { return true }
        return false
    }

    private func isShowScene(_ e: VisitorEffect) -> Bool {
        if case .showScene = e { return true }
        return false
    }

    private func isShowSpacePage(_ e: VisitorEffect) -> Bool {
        if case .showSpacePage = e { return true }
        return false
    }

    func testStartsOnTheHint() { XCTAssertEqual(flow.state, .hint) }

    func testAnAgreedRingWhileSearchingLooksTheSpaceUpByItsCode() {
        let fx = on(.ringAgreed(ringId: ringA))
        XCTAssertEqual(fx, [.lookup(code: code(ringA))])
        XCTAssertEqual(flow.state, .loading(code: code(ringA), spaceName: nil))
    }

    func testASecondAgreementWhileLoadingDoesNotLookUpAgain() {
        on(.ringAgreed(ringId: ringA))
        XCTAssertTrue(on(.ringAgreed(ringId: ringA)).isEmpty)
    }

    func testAFoundLookupStartsTheFeedAndNamesTheSpace() {
        on(.ringAgreed(ringId: ringA))
        let fx = on(.lookup(code: code(ringA), result: lookupOk()))
        XCTAssertEqual(fx, [.startFeed(spaceId: "sp-a")])
        XCTAssertEqual(flow.state, .loading(code: code(ringA), spaceName: "Cafe sp-a"))
    }

    func testANotFoundRingIsNotAskedAgainUntilTheRetryTimePasses() {
        on(.ringAgreed(ringId: ringOther))
        on(.lookup(code: code(ringOther), result: .notFound))
        XCTAssertEqual(flow.state, .failed(message: VisitorCopy.NOT_OPEN))
        now += VisitorTuning.NOT_FOUND_RETRY_MS - 1
        XCTAssertTrue(on(.ringAgreed(ringId: ringOther)).isEmpty)
        // a different ring is still looked up
        XCTAssertEqual(on(.ringAgreed(ringId: ringA)).count, 1)
        on(.lookup(code: code(ringA), result: .notFound))
        now += 1
        XCTAssertEqual(on(.ringAgreed(ringId: ringOther)), [.lookup(code: code(ringOther))])
    }

    func testALookupThatFailsShowsAPlainMessageAndRetriesOnlyAfterTheBackoff() {
        on(.ringAgreed(ringId: ringA))
        on(.lookup(code: code(ringA), result: .offline))
        XCTAssertEqual(flow.state, .failed(message: VisitorCopy.OFFLINE))
        now += VisitorTuning.LOOKUP_RETRY_MIN_MS - 1
        XCTAssertTrue(on(.ringAgreed(ringId: ringA)).isEmpty)
        XCTAssertEqual(flow.state, .failed(message: VisitorCopy.OFFLINE))
        now += 1
        XCTAssertEqual(on(.ringAgreed(ringId: ringA)), [.lookup(code: code(ringA))])
    }

    func testTheRetryDelayDoublesUpToTheCapAndSuccessResetsIt() {
        let c = code(ringA)
        var delay = VisitorTuning.LOOKUP_RETRY_MIN_MS
        for _ in 0..<8 {
            XCTAssertEqual(on(.ringAgreed(ringId: ringA)).count, 1)
            on(.lookup(code: c, result: .rateLimited))
            now += delay - 1
            XCTAssertTrue(on(.ringAgreed(ringId: ringA)).isEmpty)
            now += 1
            delay = min(delay * 2, VisitorTuning.LOOKUP_RETRY_MAX_MS)
        }
        XCTAssertEqual(delay, VisitorTuning.LOOKUP_RETRY_MAX_MS)
        XCTAssertEqual(on(.ringAgreed(ringId: ringA)).count, 1)
        on(.lookup(code: c, result: lookupOk()))
        on(.lookAgain)
        on(.ringAgreed(ringId: ringA))
        on(.lookup(code: c, result: .offline))
        now += VisitorTuning.LOOKUP_RETRY_MIN_MS
        XCTAssertEqual(on(.ringAgreed(ringId: ringA)).count, 1)
    }

    func testARingTheServerDoesntKnowSaysTheSpaceIsntOpenAndStaysThatWay() {
        on(.ringAgreed(ringId: ringOther))
        on(.lookup(code: code(ringOther), result: .notFound))
        XCTAssertEqual(flow.state, .failed(message: VisitorCopy.NOT_OPEN))
        XCTAssertTrue(on(.ringAgreed(ringId: ringOther)).isEmpty)
        XCTAssertEqual(flow.state, .failed(message: VisitorCopy.NOT_OPEN))
    }

    func testAfterAnUnpublishMidVisitTheMessageSurvivesTheRingBeingSeenAgain() {
        toShown()
        on(.feedStatus(.notFound))
        on(.ringAgreed(ringId: ringA))
        on(.lookup(code: code(ringA), result: .notFound))
        XCTAssertEqual(flow.state, .failed(message: VisitorCopy.NOT_OPEN))
    }

    func testAnAnswerForAnEarlierRingIsDroppedWhenASpaceWasOpenedByCode() {
        on(.ringAgreed(ringId: ringA))
        on(.openSpace(code: "ABC123"))
        XCTAssertTrue(on(.lookup(code: code(ringA), result: lookupOk("sp-a"))).isEmpty)
        XCTAssertEqual(flow.state, .loading(code: "ABC123", spaceName: nil))
        XCTAssertEqual(on(.lookup(code: "ABC123", result: lookupOk("sp-b"))).count, 1)
    }

    func testAnAnswerForAnEarlierOpenedCodeIsDropped() {
        on(.openSpace(code: "BBBB"))
        on(.openSpace(code: "CCCC"))
        XCTAssertTrue(on(.lookup(code: "BBBB", result: lookupOk("sp-b"))).isEmpty)
        XCTAssertEqual(flow.state, .loading(code: "CCCC", spaceName: nil))
        XCTAssertEqual(on(.lookup(code: "CCCC", result: lookupOk("sp-c"))), [.startFeed(spaceId: "sp-c")])
    }

    func testLookupFailuresHaveTheirOwnWords() {
        on(.ringAgreed(ringId: ringA))
        on(.lookup(code: code(ringA), result: .rateLimited))
        XCTAssertEqual(flow.state, .failed(message: VisitorCopy.BUSY))
        now += VisitorTuning.LOOKUP_RETRY_MAX_MS
        on(.ringAgreed(ringId: ringA))
        on(.lookup(code: code(ringA), result: .failed(500)))
        XCTAssertEqual(flow.state, .failed(message: VisitorCopy.COULDNT_OPEN))
        now += VisitorTuning.LOOKUP_RETRY_MAX_MS
        on(.ringAgreed(ringId: ringA))
        on(.lookup(code: code(ringA), result: .failed(200)))
        XCTAssertEqual(flow.state, .failed(message: VisitorCopy.BAD_DATA))
    }

    func testAStaleLookupAnswerIsIgnored() {
        on(.ringAgreed(ringId: ringA))
        on(.lookAgain)
        XCTAssertTrue(on(.lookup(code: code(ringA), result: lookupOk())).isEmpty)
        XCTAssertEqual(flow.state, .hint)
    }

    func testTheFirstSnapshotRegistersOnlyTheSpacesRings() {
        on(.ringAgreed(ringId: ringA))
        on(.lookup(code: code(ringA), result: lookupOk()))
        let s = space()
        let fx = on(.feed(snap(s)))
        XCTAssertEqual(fx, [.setRegistered([ringA, ringA2])])
        XCTAssertEqual(flow.state, .locking(space: s))
    }

    func testASteadyRingWithAPoseShowsTheSceneAndFlashesTheOutline() {
        toLocking()
        let fx = on(.steady(ringId: ringA, world: Vec3(x: 0, y: 1.5, z: 0), headingDeg: 10))
        let root = rootFromMarker(markerWorld: Vec3(x: 0, y: 1.5, z: 0), headingWorldDeg: 10, saved: pose)
        XCTAssertEqual(fx, [.showScene(root), .flashOutline(ringId: ringA)])
        XCTAssertEqual(flow.state, .shown(space: space(), root: root))
    }

    func testALaterSteadyRingOfTheSpaceReAnchors() {
        toShown()
        let fx = on(.steady(ringId: ringA2, world: Vec3(x: 3, y: 1.5, z: 0), headingDeg: 40))
        let root = rootFromMarker(markerWorld: Vec3(x: 3, y: 1.5, z: 0), headingWorldDeg: 40, saved: pose)
        XCTAssertEqual(fx, [.reanchor(root)])
        XCTAssertEqual(flow.state, .shown(space: space(), root: root))
    }

    func testARingFromAnotherSpaceDoesntReAnchorOrSwap() {
        toShown()
        let before = flow.state
        XCTAssertTrue(on(.ringAgreed(ringId: ringOther)).isEmpty)
        XCTAssertTrue(on(.steady(ringId: ringOther, world: Vec3(x: 9, y: 1.5, z: 9), headingDeg: 0)).isEmpty)
        XCTAssertEqual(flow.state, before)
    }

    func testAnUnalignedRingSaysNotSetUp() {
        let s = space(rings: [marker("m1", ringA, .some(nil))])
        toLocking(s)
        let fx = on(.steady(ringId: ringA, world: Vec3(x: 0, y: 1.5, z: 0), headingDeg: 10))
        XCTAssertTrue(fx.isEmpty)
        XCTAssertEqual(flow.state, .notSetUp(spaceName: s.name))
    }

    func testATrackingJumpHidesTheSceneAndGoesBackToLocking() {
        toShown()
        let fx = on(.trackingJump)
        // at once, not faded: the scene is at the pre-jump root
        XCTAssertEqual(fx, [.hideNow, .resetAveragers])
        XCTAssertEqual(flow.state, .locking(space: space()))
        // the next steady ring shows it again
        XCTAssertTrue(isShowScene(on(.steady(ringId: ringA, world: Vec3(x: 0, y: 1.5, z: 0), headingDeg: 10)).first!))
    }

    func testAnInterruptedSessionHidesTheSceneUntilARingIsSeenAgain() {
        toShown()
        XCTAssertEqual(on(.sessionInterrupted), [.hideNow, .resetAveragers])
        XCTAssertFalse(on(.sessionResumed).contains(where: isShowScene))
        XCTAssertTrue(on(.steady(ringId: ringA, world: Vec3(x: 0, y: 1.5, z: 0), headingDeg: 10)).contains(where: isShowScene))
    }

    func testLookAtTheRingAgainForgetsTheSpace() {
        toShown()
        let fx = on(.lookAgain)
        XCTAssertEqual(Set(fx.map { "\($0)" }),
                       Set([VisitorEffect.hideScene, .resetAveragers, .stopFeed, .setRegistered(nil), .closeSpacePage].map { "\($0)" }))
        XCTAssertEqual(fx.count, 5)
        XCTAssertEqual(flow.state, .hint)
        // searching again: a ring of the old space is looked up afresh
        XCTAssertEqual(on(.ringAgreed(ringId: ringA)).count, 1)
    }

    func testLookAgainDropsAFailedLookupsBackoffSoTheRingIsAskedAgainAtOnce() {
        on(.ringAgreed(ringId: ringA))
        on(.lookup(code: code(ringA), result: .offline))
        on(.lookAgain)
        XCTAssertEqual(flow.state, .hint)
        XCTAssertEqual(on(.ringAgreed(ringId: ringA)), [.lookup(code: code(ringA))])
        // and the backoff starts again from the minimum
        on(.lookup(code: code(ringA), result: .offline))
        now += VisitorTuning.LOOKUP_RETRY_MIN_MS
        XCTAssertEqual(on(.ringAgreed(ringId: ringA)).count, 1)
    }

    func testOpeningASpaceClearsTheCurrentOneAndLooksTheCodeUp() {
        toShown()
        let fx = on(.openSpace(code: "ABC123"))
        XCTAssertTrue(fx.contains(.hideScene) && fx.contains(.stopFeed) && fx.contains(.setRegistered(nil)))
        XCTAssertEqual(fx.last, .lookup(code: "ABC123"))
        XCTAssertEqual(flow.state, .loading(code: "ABC123", spaceName: nil))
        // the answer carries no ring of ours; it still lands
        let b = space("sp-b")
        XCTAssertEqual(on(.lookup(code: "ABC123", result: lookupOk("sp-b"))), [.startFeed(spaceId: "sp-b")])
        // the old space's feed can no longer touch us
        XCTAssertTrue(on(.feed(snap(space("sp-a"), "9"))).isEmpty)
        on(.feed(snap(b)))
        XCTAssertEqual(flow.state, .locking(space: b))
    }

    func testOpeningALinkWhileAnotherSpaceIsShownClearsIt() {
        toShown()
        let fx = on(.openSpace(code: "2E3D4C5"))
        XCTAssertEqual(fx.first, .hideScene)
        XCTAssertTrue(fx.contains(.stopFeed))
        XCTAssertEqual(fx.last, .lookup(code: "2E3D4C5"))
        XCTAssertEqual(flow.state, .loading(code: "2E3D4C5", spaceName: nil))
    }

    func testFeedNotFoundFailsPlainlyHidesTheSceneAndStops() {
        toShown()
        let fx = on(.feedStatus(.notFound))
        XCTAssertTrue(fx.contains(.hideScene) && fx.contains(.stopFeed) && fx.contains(.setRegistered(nil)))
        XCTAssertEqual(flow.state, .failed(message: VisitorCopy.NOT_OPEN))
    }

    func testFeedNotFoundBeforeTheFirstSnapshotAlsoFailsAndStops() {
        on(.ringAgreed(ringId: ringA))
        on(.lookup(code: code(ringA), result: lookupOk()))
        let fx = on(.feedStatus(.notFound))
        XCTAssertTrue(fx.contains(.hideScene) && fx.contains(.stopFeed))
        XCTAssertEqual(flow.state, .failed(message: VisitorCopy.NOT_OPEN))
    }

    func testOfflineBeforeTheFirstSnapshotFailsAfterItTheSceneStays() {
        on(.ringAgreed(ringId: ringA))
        on(.lookup(code: code(ringA), result: lookupOk()))
        on(.feedStatus(.offline))
        XCTAssertEqual(flow.state, .failed(message: VisitorCopy.OFFLINE))
        // it recovers when the snapshot arrives
        on(.feed(snap()))
        XCTAssertEqual(flow.state, .locking(space: space()))
        on(.steady(ringId: ringA, world: Vec3(x: 0, y: 1.5, z: 0), headingDeg: 10))
        let shown = flow.state
        XCTAssertTrue(on(.feedStatus(.offline)).isEmpty)
        XCTAssertEqual(flow.state, shown)
    }

    func testABadOrFailingFeedBeforeTheFirstSnapshotSaysSoAfterItNothingChanges() {
        on(.ringAgreed(ringId: ringA))
        on(.lookup(code: code(ringA), result: lookupOk()))
        on(.feedStatus(.badData))
        XCTAssertEqual(flow.state, .failed(message: VisitorCopy.BAD_DATA))
        on(.feedStatus(.failed))
        XCTAssertEqual(flow.state, .failed(message: VisitorCopy.COULDNT_OPEN))
        on(.feed(snap()))
        on(.steady(ringId: ringA, world: Vec3(x: 0, y: 1.5, z: 0), headingDeg: 10))
        let shown = flow.state
        XCTAssertTrue(on(.feedStatus(.badData)).isEmpty)
        XCTAssertTrue(on(.feedStatus(.failed)).isEmpty)
        XCTAssertEqual(flow.state, shown)
    }

    func testStepCloserGoesBackToTheHintWhenTheCandidateIsGone() {
        on(.unreadableSeen(sinceMs: now - 2000))
        XCTAssertEqual(flow.state, .stepCloser)
        on(.unreadableGone)
        XCTAssertEqual(flow.state, .hint)
    }

    func testRateLimitedBeforeTheFirstSnapshotSaysBusy() {
        on(.ringAgreed(ringId: ringA))
        on(.lookup(code: code(ringA), result: lookupOk()))
        on(.feedStatus(.rateLimited))
        XCTAssertEqual(flow.state, .failed(message: VisitorCopy.BUSY))
    }

    func testANewerSnapshotUpdatesTheShownSpaceAndItsRegisteredRings() {
        toShown()
        let s2 = space(rings: [marker("m1", ringA), marker("m2", ringA2), marker("m3", 0x3F4E_5D6C)])
        let fx = on(.feed(snap(s2, "2")))
        XCTAssertEqual(fx, [.setRegistered([ringA, ringA2, 0x3F4E_5D6C])])
        XCTAssertEqual(shownSpace, s2)
    }

    func testStepCloserOnlyAfterTheCandidatePersists() {
        on(.unreadableSeen(sinceMs: now - 1000))
        XCTAssertEqual(flow.state, .hint)
        on(.unreadableSeen(sinceMs: now - 1600))
        XCTAssertEqual(flow.state, .stepCloser)
        on(.unreadableSeen(sinceMs: now - 100))
        XCTAssertEqual(flow.state, .hint)
    }

    func testAnUnreadableCandidateDoesNotDisturbAShownScene() {
        toShown()
        let before = flow.state
        on(.unreadableSeen(sinceMs: now - 5000))
        XCTAssertEqual(flow.state, before)
    }

    // MARK: - the space page follows the flow

    func testOpeningASpaceOpensItsPageAfterClosingAnyOldOne() {
        let fx = on(.openSpace(code: "ABC123"))
        let close = fx.firstIndex(of: .closeSpacePage)
        let open = fx.firstIndex(of: .showSpacePage(code: "ABC123"))
        XCTAssertNotNil(close)
        XCTAssertNotNil(open)
        XCTAssertGreaterThan(open!, close!)
    }

    func testLookingAgainClosesThePage() {
        on(.openSpace(code: "ABC123"))
        XCTAssertTrue(on(.lookAgain).contains(.closeSpacePage))
        XCTAssertFalse(on(.lookAgain).contains(where: isShowSpacePage))
    }

    func testASpaceIsChosenFromTheLookupAnswerUntilItIsForgotten() {
        XCTAssertFalse(flow.spaceChosen)
        on(.ringAgreed(ringId: ringA))
        XCTAssertFalse(flow.spaceChosen)
        on(.lookup(code: code(ringA), result: lookupOk()))
        XCTAssertTrue(flow.spaceChosen)
        on(.feedStatus(.offline))
        XCTAssertTrue(flow.spaceChosen) // failed, but there is a space to leave
        on(.lookAgain)
        XCTAssertFalse(flow.spaceChosen)
    }

    // MARK: - feed not found backs off

    func testFeedNotFoundAfterAFoundLookupPutsTheRingOnTheRetryBackoff() {
        let c = code(ringA)
        var delay = VisitorTuning.LOOKUP_RETRY_MIN_MS
        for _ in 0..<5 {
            XCTAssertEqual(on(.ringAgreed(ringId: ringA)), [.lookup(code: c)])
            on(.lookup(code: c, result: lookupOk()))
            on(.feedStatus(.notFound))
            XCTAssertEqual(flow.state, .failed(message: VisitorCopy.NOT_OPEN))
            // the found lookup doesn't reset the backoff: it keeps doubling
            now += delay - 1
            XCTAssertTrue(on(.ringAgreed(ringId: ringA)).isEmpty)
            now += 1
            delay = min(delay * 2, VisitorTuning.LOOKUP_RETRY_MAX_MS)
        }
    }

    func testAFeedThatDeliversResetsTheBackoff() {
        let c = code(ringA)
        on(.ringAgreed(ringId: ringA))
        on(.lookup(code: c, result: lookupOk()))
        on(.feedStatus(.notFound))
        now += VisitorTuning.LOOKUP_RETRY_MIN_MS
        on(.ringAgreed(ringId: ringA))
        on(.lookup(code: c, result: lookupOk()))
        on(.feed(snap()))
        // unpublished mid-visit: the backoff starts again from the minimum
        on(.feedStatus(.notFound))
        now += VisitorTuning.LOOKUP_RETRY_MIN_MS
        XCTAssertEqual(on(.ringAgreed(ringId: ringA)).count, 1)
    }

    // MARK: - "isn't open" clears once the ring is gone

    func testIsntOpenFromTheDoNotAskListGoesBackToTheHintOnceTheRingLeavesView() {
        on(.ringAgreed(ringId: ringOther))
        on(.lookup(code: code(ringOther), result: .notFound))
        on(.tick)
        XCTAssertEqual(flow.state, .failed(message: VisitorCopy.NOT_OPEN))
        // still in view: agreed every frame, the message stays
        for _ in 0..<10 {
            now += 500
            on(.ringAgreed(ringId: ringOther))
            on(.tick)
            XCTAssertEqual(flow.state, .failed(message: VisitorCopy.NOT_OPEN))
        }
        // out of view
        now += VisitorTuning.UNREADABLE_HINT_MS - 1
        on(.tick)
        XCTAssertEqual(flow.state, .failed(message: VisitorCopy.NOT_OPEN))
        now += 1
        on(.tick)
        XCTAssertEqual(flow.state, .hint)
        // seen again: still on the list, so "isn't open" again without a lookup
        XCTAssertTrue(on(.ringAgreed(ringId: ringOther)).isEmpty)
        XCTAssertEqual(flow.state, .failed(message: VisitorCopy.NOT_OPEN))
    }

    func testAFreshNotFoundAnswerAlsoClearsOnceTheRingIsGone() {
        on(.ringAgreed(ringId: ringOther))
        on(.lookup(code: code(ringOther), result: .notFound))
        now += VisitorTuning.UNREADABLE_HINT_MS
        on(.tick)
        XCTAssertEqual(flow.state, .hint)
    }

    func testOtherFailuresAreNotClearedByTime() {
        on(.ringAgreed(ringId: ringA))
        on(.lookup(code: code(ringA), result: .offline))
        now += 60_000
        on(.tick)
        XCTAssertEqual(flow.state, .failed(message: VisitorCopy.OFFLINE))
        // nor is a feed's "isn't open" for a space opened by code
        on(.openSpace(code: "ABC123"))
        on(.lookup(code: "ABC123", result: lookupOk("sp-b")))
        on(.feedStatus(.notFound))
        now += 60_000
        on(.tick)
        XCTAssertEqual(flow.state, .failed(message: VisitorCopy.NOT_OPEN))
    }

    // MARK: - a feed's "isn't open"

    func testFeedNotFoundAfterARingsLookupClearsToTheHintOnceTheRingLeavesView() {
        on(.ringAgreed(ringId: ringA))
        on(.lookup(code: code(ringA), result: lookupOk()))
        on(.feedStatus(.notFound))
        XCTAssertEqual(flow.state, .failed(message: VisitorCopy.NOT_OPEN))
        // still in view, held by the retry backoff: the message stays
        for _ in 0..<3 {
            now += 500
            XCTAssertTrue(on(.ringAgreed(ringId: ringA)).isEmpty)
            on(.tick)
            XCTAssertEqual(flow.state, .failed(message: VisitorCopy.NOT_OPEN))
        }
        now += VisitorTuning.UNREADABLE_HINT_MS
        on(.tick)
        XCTAssertEqual(flow.state, .hint)
    }

    func testAFeedsIsntOpenCountsAsAChosenSpaceForTheMenuButtonUntilItClears() {
        on(.ringAgreed(ringId: ringA))
        on(.lookup(code: code(ringA), result: lookupOk()))
        on(.feedStatus(.notFound))
        XCTAssertTrue(menuButtonShown(flow.state, spaceChosen: flow.spaceChosen))
        now += VisitorTuning.UNREADABLE_HINT_MS
        on(.tick)
        XCTAssertFalse(flow.spaceChosen)
        // opened by code: no ring to leave view, so the message and the button stay until Look again
        on(.openSpace(code: "ABC123"))
        on(.lookup(code: "ABC123", result: lookupOk("sp-b")))
        on(.feedStatus(.notFound))
        now += 60_000
        on(.tick)
        XCTAssertTrue(menuButtonShown(flow.state, spaceChosen: flow.spaceChosen))
        on(.lookAgain)
        XCTAssertFalse(flow.spaceChosen)
        // the server not knowing a ring is not a chosen space
        on(.ringAgreed(ringId: ringOther))
        on(.lookup(code: code(ringOther), result: .notFound))
        XCTAssertFalse(menuButtonShown(flow.state, spaceChosen: flow.spaceChosen))
    }

    func testOnlyASpaceWithAFeedUpOrLoadingCanBeReported() {
        XCTAssertNil(flow.reportSpaceId)
        on(.ringAgreed(ringId: ringA))
        on(.lookup(code: code(ringA), result: lookupOk()))
        XCTAssertEqual(flow.reportSpaceId, "sp-a")
        on(.feedStatus(.notFound))
        XCTAssertNil(flow.reportSpaceId)
        on(.lookAgain)
        XCTAssertNil(flow.reportSpaceId)
    }

    func testEachReportResultHasItsOwnNote() {
        XCTAssertEqual(reportNote(.sent), "Thanks. Virvi will look at this space.")
        XCTAssertEqual(reportNote(.rateLimited), "Too many reports from here. Try again later.")
        XCTAssertEqual(reportNote(.failed), "Couldn't send the report. Check the connection and try again.")
    }

    // MARK: - a newer snapshot moves the anchor ring

    private let moved = MarkerPose(x: 1.2, y: 1.5, z: 2, headingDeg: 80)

    func testANewSavedPoseForTheAnchorRingReAnchorsFromItsAveragedPoseInView() {
        toShown()
        let seen = SteadyPose(world: Vec3(x: 0.1, y: 1.5, z: 0.05), headingDeg: 12)
        let fx = on(.feed(snap(space(rings: [marker("m1", ringA, moved), marker("m2", ringA2)]), "2"), steady: [ringA: seen]))
        let root = rootFromMarker(markerWorld: seen.world, headingWorldDeg: seen.headingDeg, saved: moved)
        XCTAssertEqual(fx, [.reanchor(root)])
        XCTAssertEqual(shownRoot, root)
    }

    func testANewSavedPoseForTheAnchorRingOutOfViewHidesTheSceneToLockAgain() {
        toShown()
        let newer = space(rings: [marker("m1", ringA, moved), marker("m2", ringA2)])
        // only the other ring is steady in view: it isn't what the scene was placed from
        let fx = on(.feed(snap(newer, "2"), steady: [ringA2: SteadyPose(world: Vec3(x: 0, y: 1.5, z: 0), headingDeg: 10)]))
        XCTAssertEqual(fx, [.hideNow, .resetAveragers])
        XCTAssertEqual(flow.state, .locking(space: newer))
        // seen steady again: shown afresh from the new pose
        let again = on(.steady(ringId: ringA, world: Vec3(x: 0, y: 1.5, z: 0), headingDeg: 10))
        let root = rootFromMarker(markerWorld: Vec3(x: 0, y: 1.5, z: 0), headingWorldDeg: 10, saved: moved)
        XCTAssertEqual(again, [.showScene(root), .flashOutline(ringId: ringA)])
    }

    func testTheAnchorRingLosingItsSavedPoseHidesTheScene() {
        toShown()
        let fx = on(.feed(snap(space(rings: [marker("m1", ringA, .some(nil)), marker("m2", ringA2)]), "2")))
        XCTAssertEqual(fx, [.hideNow, .resetAveragers])
        XCTAssertTrue(isLocking)
    }

    func testANewPoseForAnotherRingLeavesTheShownSceneWhereItIs() {
        toShown()
        let before = shownRoot
        let fx = on(.feed(snap(space(rings: [marker("m1", ringA), marker("m2", ringA2, moved)]), "2")))
        XCTAssertTrue(fx.isEmpty)
        XCTAssertEqual(shownRoot, before)
    }

    func testTheAnchorFollowsTheRingTheSceneWasLastPlacedFrom() {
        toShown()
        // re-anchored from ring A2: a move of A no longer matters, a move of A2 does
        on(.steady(ringId: ringA2, world: Vec3(x: 0, y: 1.5, z: 0), headingDeg: 10))
        XCTAssertTrue(on(.feed(snap(space(rings: [marker("m1", ringA, moved), marker("m2", ringA2)]), "2"))).isEmpty)
        let fx = on(.feed(snap(space(rings: [marker("m1", ringA, moved), marker("m2", ringA2, moved)]), "3")))
        XCTAssertEqual(fx, [.hideNow, .resetAveragers])
    }

    func testANewPrintedDiameterForTheAnchorRingHidesTheSceneEvenWhenItIsSteadyInView() {
        toShown()
        let resized = space(rings: [ArMarker(id: "m1", ringId: ringA, code: code(ringA), diameterMm: 120, whereText: nil, pose: pose),
                                    marker("m2", ringA2)])
        let fx = on(.feed(snap(resized, "2"), steady: [ringA: SteadyPose(world: Vec3(x: 0, y: 1.5, z: 0), headingDeg: 10)]))
        XCTAssertEqual(fx, [.hideNow, .resetAveragers])
        XCTAssertEqual(flow.state, .locking(space: resized))
    }

    // MARK: - Review Focus 3: interruptions

    func testAnInterruptionWhileShownHidesAtOnceAndGoesBackToLooking() {
        toShown()
        XCTAssertEqual(on(.sessionInterrupted), [.hideNow, .resetAveragers])
        XCTAssertEqual(flow.state, .locking(space: space()))
        XCTAssertEqual(hintText(flow.state), VisitorCopy.HINT)
        // resuming doesn't bring the scene back, nor do feed updates or ticks
        XCTAssertTrue(on(.sessionResumed).isEmpty)
        XCTAssertTrue(on(.feed(snap(space(), "2"))).isEmpty)
        on(.tick)
        XCTAssertEqual(flow.state, .locking(space: space()))
        // only a new steady ring does
        let fx = on(.steady(ringId: ringA2, world: Vec3(x: 2, y: 1.5, z: 0), headingDeg: 30))
        let root = rootFromMarker(markerWorld: Vec3(x: 2, y: 1.5, z: 0), headingWorldDeg: 30, saved: pose)
        XCTAssertEqual(fx, [.showScene(root), .flashOutline(ringId: ringA2)])
        XCTAssertEqual(flow.state, .shown(space: space(), root: root))
    }

    func testAnInterruptionWithNothingLoadedDoesNothing() {
        XCTAssertTrue(on(.sessionInterrupted).isEmpty)
        XCTAssertEqual(flow.state, .hint)
        XCTAssertTrue(on(.sessionResumed).isEmpty)
    }

    // MARK: - Review Focus 4: a link to one space while standing at another's ring

    private let ringB: UInt32 = 0x5A6B_7C8D

    private func spaceB() -> ArSpace { space("sp-b", rings: [marker("mb", ringB)]) }

    /// Opened from a link: space A loaded and locking, any ring still accepted, "Look at the ring when you get there"
    /// on its page.
    private func openA() {
        on(.openSpace(code: "AAAAAAA"))
        on(.lookup(code: "AAAAAAA", result: lookupOk("sp-a")))
        // until a ring of A is seen any ring stays readable, so a ring of another space can be agreed
        XCTAssertFalse(on(.feed(snap(space()))).contains { if case .setRegistered(let ids) = $0 { return ids != nil } else { return false } })
        XCTAssertEqual(flow.state, .locking(space: space()))
    }

    func testARingOfAnotherSpaceWinsOverALinkOpenedSpace() {
        openA()
        let fx = on(.ringAgreed(ringId: ringB))
        XCTAssertEqual(fx.last, .lookup(code: code(ringB)))
        XCTAssertTrue(fx.contains(.stopFeed))
        XCTAssertTrue(fx.contains(.closeSpacePage))
        XCTAssertEqual(flow.state, .loading(code: code(ringB), spaceName: nil))
        XCTAssertNil(flow.reportSpaceId)
        // A's feed can no longer touch us
        XCTAssertTrue(on(.feed(snap(space(), "2"))).isEmpty)
        // B loads and is shown on its ring's steady pose
        XCTAssertEqual(on(.lookup(code: code(ringB), result: lookupOk("sp-b"))), [.startFeed(spaceId: "sp-b")])
        XCTAssertEqual(on(.feed(snap(spaceB()))), [.setRegistered([ringB])])
        let fx2 = on(.steady(ringId: ringB, world: Vec3(x: 0, y: 1.5, z: 0), headingDeg: 10))
        let root = rootFromMarker(markerWorld: Vec3(x: 0, y: 1.5, z: 0), headingWorldDeg: 10, saved: pose)
        XCTAssertEqual(fx2, [.showScene(root), .flashOutline(ringId: ringB)])
        XCTAssertEqual(flow.state, .shown(space: spaceB(), root: root))
    }

    func testARingOfAnotherSpaceAlsoWinsWhileTheLinksLookupIsPending() {
        on(.openSpace(code: "AAAAAAA"))
        let fx = on(.ringAgreed(ringId: ringB))
        XCTAssertEqual(fx.last, .lookup(code: code(ringB)))
        XCTAssertEqual(flow.state, .loading(code: code(ringB), spaceName: nil))
        // the link's answer is now stale
        XCTAssertTrue(on(.lookup(code: "AAAAAAA", result: lookupOk("sp-a"))).isEmpty)
    }

    func testARingOfTheLinkedSpaceShowsItAndThenOnlyItsRingsCount() {
        openA()
        XCTAssertTrue(on(.ringAgreed(ringId: ringA)).isEmpty)
        let fx = on(.steady(ringId: ringA, world: Vec3(x: 0, y: 1.5, z: 0), headingDeg: 10))
        let root = rootFromMarker(markerWorld: Vec3(x: 0, y: 1.5, z: 0), headingWorldDeg: 10, saved: pose)
        // arrived: from now on only A's rings are read, as for a space found by its ring
        XCTAssertEqual(fx, [.showScene(root), .flashOutline(ringId: ringA), .setRegistered([ringA, ringA2])])
        XCTAssertTrue(on(.ringAgreed(ringId: ringB)).isEmpty)
        on(.trackingJump)
        XCTAssertTrue(on(.ringAgreed(ringId: ringB)).isEmpty)
        XCTAssertEqual(flow.state, .locking(space: space()))
    }

    func testARingOfAnotherSpaceOnTheDoNotAskListLeavesTheLinkedSpace() {
        on(.ringAgreed(ringId: ringB))
        on(.lookup(code: code(ringB), result: .notFound))
        openA()
        XCTAssertTrue(on(.ringAgreed(ringId: ringB)).isEmpty)
        XCTAssertEqual(flow.state, .locking(space: space()))
        XCTAssertEqual(flow.reportSpaceId, "sp-a")
    }

    // MARK: - Review Focus 5: unpublished or unknown spaces, and retries

    func testAnUnknownRingSaysIsntOpenAndIsAskedAgainAfterTheNotFoundRetry() {
        on(.ringAgreed(ringId: ringOther))
        XCTAssertTrue(on(.lookup(code: code(ringOther), result: .notFound)).isEmpty)
        XCTAssertEqual(flow.state, .failed(message: VisitorCopy.NOT_OPEN))
        XCTAssertEqual(hintText(flow.state), "This space isn't open right now.")
        now += VisitorTuning.NOT_FOUND_RETRY_MS - 1
        XCTAssertTrue(on(.ringAgreed(ringId: ringOther)).isEmpty)
        XCTAssertEqual(hintText(flow.state), VisitorCopy.NOT_OPEN)
        now += 1
        XCTAssertEqual(on(.ringAgreed(ringId: ringOther)), [.lookup(code: code(ringOther))])
    }

    func testARingWithNoSavedPoseSaysNotSetUpAndNeverABlankScreen() {
        let s = space(rings: [marker("m1", ringA, .some(nil))])
        toLocking(s)
        on(.steady(ringId: ringA, world: Vec3(x: 0, y: 1.5, z: 0), headingDeg: 10))
        XCTAssertEqual(hintText(flow.state), "This space isn't set up yet")
        // once the owner saves the ring's pose, the next steady pose shows it
        let posed = space()
        on(.feed(snap(posed, "2")))
        XCTAssertEqual(flow.state, .locking(space: posed))
        XCTAssertTrue(on(.steady(ringId: ringA, world: Vec3(x: 0, y: 1.5, z: 0), headingDeg: 10)).contains(where: isShowScene))
    }

    func testAnUnpublishedSnapshotSaysIsntOpenAndStopsTheFeed() {
        on(.ringAgreed(ringId: ringA))
        on(.lookup(code: code(ringA), result: lookupOk()))
        let fx = on(.feed(snap(space(published: false))))
        XCTAssertTrue(fx.contains(.stopFeed) && fx.contains(.setRegistered(nil)))
        XCTAssertEqual(flow.state, .failed(message: VisitorCopy.NOT_OPEN))
        XCTAssertEqual(hintText(flow.state), "This space isn't open right now.")
        XCTAssertNil(flow.reportSpaceId)
        // retried on the lookup backoff
        now += VisitorTuning.LOOKUP_RETRY_MIN_MS - 1
        XCTAssertTrue(on(.ringAgreed(ringId: ringA)).isEmpty)
        now += 1
        XCTAssertEqual(on(.ringAgreed(ringId: ringA)), [.lookup(code: code(ringA))])
    }

    func testAnUnpublishedSnapshotWhileShownHidesTheScene() {
        toShown()
        let fx = on(.feed(snap(space(published: false), "2")))
        XCTAssertTrue(fx.contains(.hideScene) && fx.contains(.stopFeed))
        XCTAssertEqual(flow.state, .failed(message: VisitorCopy.NOT_OPEN))
    }

    func testOfflineAndRateLimitedLookupsBackOffBetween2And30Seconds() {
        for result in [ApiResult<MarkerLookup>.offline, .rateLimited] {
            flow = VisitorFlow()
            var delays: [Int64] = []
            XCTAssertEqual(on(.ringAgreed(ringId: ringA)).count, 1)
            for _ in 0..<7 {
                on(.lookup(code: code(ringA), result: result))
                // the ring stays in view: find when it is asked again
                var waited: Int64 = 0
                while on(.ringAgreed(ringId: ringA)).isEmpty {
                    now += 100
                    waited += 100
                }
                delays.append(waited)
            }
            XCTAssertEqual(delays, [2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000], "\(result)")
            XCTAssertTrue(delays.allSatisfy { $0 >= 2_000 && $0 <= 30_000 })
        }
    }
}
