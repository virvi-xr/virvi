import Foundation
import simd
import XCTest
import VirviARKit
@testable import VirviAR

/// A scripted transport: each request goes to the first handler whose path suffix matches (404 if none), and every
/// request is recorded. Handlers may suspend (a long-poll that waits to be cancelled).
final class FakeTransport: HttpTransport, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) async throws -> (Int, [String: Any]?)

    private let lock = NSLock()
    private var routes: [(suffix: String, handler: Handler)] = []
    private var log: [URLRequest] = []

    func on(_ suffix: String, _ handler: @escaping Handler) {
        lock.lock(); defer { lock.unlock() }
        routes.append((suffix, handler))
    }

    var requests: [URLRequest] { lock.lock(); defer { lock.unlock() }; return log }
    func count(_ suffix: String) -> Int { requests.filter { $0.url!.path.hasSuffix(suffix) }.count }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let handler: Handler? = {
            lock.lock(); defer { lock.unlock() }
            log.append(request)
            return routes.first { request.url!.path.hasSuffix($0.suffix) }?.handler
        }()
        let (status, body) = try await handler?(request) ?? (404, ["error": "not_found"])
        let data = body.map { (try? JSONSerialization.data(withJSONObject: $0)) ?? Data() } ?? Data()
        return (data, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}

@MainActor
final class FakeSceneView: SceneView {
    var applied: [[RenderItem]] = []
    var roots: [RootPose] = []
    var visible: [Bool] = []
    var hideNowCount = 0
    var clearCount = 0
    var soundOn = false
    var itemCount: Int { applied.last?.count ?? 0 }

    func apply(_ items: [RenderItem]) { applied.append(items) }
    func setRoot(_ root: RootPose) { roots.append(root) }
    func setVisible(_ on: Bool, nowMs: Int64) { visible.append(on) }
    func hideNow() { hideNowCount += 1 }
    func clear() { clearCount += 1 }
    func tick(nowMs: Int64) {}
    func setServerOffset(_ ms: Int64) {}
    func setSoundOn(_ on: Bool) { soundOn = on }
}

@MainActor
final class FakeOutline: OutlineView {
    var flashes: [(world: Vec3, headingDeg: Double, diameterM: Double)] = []
    var clearCount = 0

    func flash(world: Vec3, headingDeg: Double, diameterM: Double, nowMs: Int64) {
        flashes.append((world, headingDeg, diameterM))
    }
    func tick(nowMs: Int64) {}
    func clear() { clearCount += 1 }
}

@MainActor
final class VisitorControllerTests: XCTestCase {
    nonisolated static let code = "2E3D4C5"
    nonisolated static let ring = RingCodec.parseCode(code)!
    nonisolated static let saved = MarkerPose(x: 8, y: 1.5, z: 0, headingDeg: 0)
    /// The detector's intrinsics at 1280 x 960 (the test set's camera).
    static let k = CameraIntrinsics(fx: 867, fy: 867, cx: 640, cy: 480, width: 1280, height: 960)
    /// A wall 0.8 m straight ahead of a camera at the origin (ARKit looks along -z: +z in the Virvi world), facing it.
    static let wall = WallPlane(centre: Vec3(x: 0, y: 0, z: 0.8), normal: Vec3(x: 0, y: 0, z: -1), halfWidth: 2, halfHeight: 2)

    private var transport: FakeTransport!
    private var view: FakeSceneView!
    private var outline: FakeOutline!
    private var nowMs: Int64 = 1_000
    private var controller: VisitorController!

    override func setUp() async throws {
        transport = FakeTransport()
        transport.on("/by-code/\(Self.code)") { _ in
            (200, ["spaceId": "s1", "floorId": "f1", "markerId": "m1", "spaceName": "Loft"])
        }
        transport.on("/feed") { req in
            // The first poll answers; the next one holds until the feed is stopped, as the server's long-poll does.
            if req.url!.query?.contains("since=1") == true {
                try await Task.sleep(nanoseconds: 3_600 * 1_000_000_000)
            }
            return (200, Self.feedBody())
        }
        view = FakeSceneView()
        outline = FakeOutline()
        let api = ArApi(baseUrl: URL(string: "https://virvi.test")!, transport: transport, appVersion: "test")
        controller = VisitorController(api: api, view: view, outline: outline,
                                       analytics: VisitAnalytics(send: { _, _ in .sent }),
                                       clock: { [unowned self] in self.nowMs }, flushIntervalS: 3_600)
    }

    override func tearDown() async throws {
        controller.stop()
        controller = nil
    }

    nonisolated static func feedBody() -> [String: Any] {
        let pose: [String: Any] = ["x": saved.x, "y": saved.y, "z": saved.z, "headingDeg": saved.headingDeg]
        let marker: [String: Any] = ["id": "m1", "ringId": Int(ring), "code": code, "diameterMm": 140, "pose": pose]
        let floor: [String: Any] = ["id": "f1", "name": "Ground", "heightM": 0, "sortOrder": 0, "markers": [marker]]
        return ["v": 1, "version": "1", "scene": NSNull(),
                "space": ["id": "s1", "name": "Loft", "published": true, "floors": [floor]]]
    }

    /// One camera frame seeing the ring at the centre of the image, round, sized for `distanceM` with a 140 mm print.
    private func frame(distanceM: Double) -> PipelineResult {
        let semiMajor = Self.k.fx * 0.07 / distanceM
        let d = RingDetection(id: Self.ring, version: 0, corrected: 0, cx: 640, cy: 480,
                              semiMajor: semiMajor, semiMinor: semiMajor, angleDeg: 0, rotationDeg: 0)
        return PipelineResult(frame: RingFrame(detections: [d], unreadable: []), intrinsics: Self.k,
                              cameraTransform: matrix_identity_float4x4)
    }

    /// Feeds `count` camera frames (about 8 a second, as the pipeline gives them), letting the lookup and feed answer
    /// between them.
    private func seeRing(frames count: Int, distanceM: Double = 0.8) async throws {
        for _ in 0..<count {
            nowMs += 125
            controller.onCameraPose(matrix_identity_float4x4)
            controller.onCameraFrame(frame(distanceM: distanceM), walls: [Self.wall])
            try await Task.sleep(nanoseconds: 50_000_000)
        }
    }

    func testARingSeenSteadilyOnAWallLooksItUpStartsTheFeedPlacesTheSceneAndFadesItIn() async throws {
        try await seeRing(frames: 15)

        XCTAssertEqual(transport.count("/by-code/\(Self.code)"), 1, "looked up once")
        XCTAssertGreaterThanOrEqual(transport.count("/spaces/s1/feed"), 1, "the feed started")
        let root = try XCTUnwrap(view.roots.last, "root transform never set")
        let want = rootFromMarker(markerWorld: Vec3(x: 0, y: 0, z: 0.8), headingWorldDeg: 180, saved: Self.saved)
        XCTAssertEqual(root.position.x, want.position.x, accuracy: 1e-3)
        XCTAssertEqual(root.position.y, want.position.y, accuracy: 1e-3)
        XCTAssertEqual(root.position.z, want.position.z, accuracy: 1e-3)
        XCTAssertEqual(angleDiffDeg(root.yawDeg, want.yawDeg), 0, accuracy: 0.1)
        XCTAssertEqual(view.visible, [true], "the fade started once")
        XCTAssertTrue(controller.sceneShown)
        XCTAssertTrue(view.soundOn, "sound starts with the scene, no tap needed")
        XCTAssertNil(controller.hint)
        XCTAssertEqual(outline.flashes.count, 1)
        XCTAssertEqual(outline.flashes.first?.diameterM ?? 0, 0.14, accuracy: 1e-9)
    }

    func testTheSessionBeingInterruptedHidesTheSceneAtOnce() async throws {
        try await seeRing(frames: 15)
        XCTAssertTrue(controller.sceneShown)

        controller.sessionInterrupted()

        XCTAssertEqual(view.hideNowCount, 1, "hidden without a fade")
        XCTAssertEqual(view.visible, [true], "no fade out")
        XCTAssertFalse(controller.sceneShown)
        guard case .locking = controller.state else { return XCTFail("\(controller.state)") }
    }

    func testLimitedTrackingHidesTheSceneAtOnceAndARingShowsItAgain() async throws {
        try await seeRing(frames: 15)
        controller.trackingChanged(normal: false)
        XCTAssertEqual(view.hideNowCount, 1)
        XCTAssertFalse(controller.sceneShown)

        controller.trackingChanged(normal: true)
        try await seeRing(frames: 8)
        XCTAssertTrue(controller.sceneShown)
        XCTAssertEqual(view.visible, [true, true])
    }

    /// After a pause ARKit restarts tracking limited and only later reports it normal: frames in between (from the
    /// new `run`, before that first report) mustn't step a lock.
    func testAfterAPauseRingsCountOnlyOnceTrackingIsNormalAgain() async throws {
        try await seeRing(frames: 15)
        XCTAssertTrue(controller.sceneShown)

        controller.sessionPaused()
        controller.sessionResumed()
        try await seeRing(frames: 15)
        XCTAssertFalse(controller.sceneShown, "frames before tracking was normal counted")
        XCTAssertEqual(view.visible, [true])

        controller.trackingChanged(normal: true)
        try await seeRing(frames: 15)
        XCTAssertTrue(controller.sceneShown)
    }

    func testARingTooFarAwayNeverPlacesTheScene() async throws {
        try await seeRing(frames: 15, distanceM: 2.5)
        XCTAssertTrue(view.roots.isEmpty)
        XCTAssertEqual(controller.hint, VisitorCopy.TOO_FAR)
    }

    func testTheRingTrackerOnlyAcceptsTheSpacesRingsOnceItsFeedHasAnswered() async throws {
        XCTAssertNil(controller.registeredRings)
        try await seeRing(frames: 15)
        XCTAssertEqual(controller.registeredRings, [Self.ring])
        controller.lookAgain()
        XCTAssertNil(controller.registeredRings)
    }

    func testSoundStaysOffUntilTheSceneIsShown() async throws {
        XCTAssertFalse(view.soundOn)
        try await seeRing(frames: 2)
        XCTAssertFalse(controller.sceneShown)
        XCTAssertFalse(view.soundOn, "no audio session before the scene shows")
    }
}

final class SceneFadeTests: XCTestCase {
    func testFadesInOverFourHundredMillisecondsAndOutFromWhereItGotTo() {
        var f = SceneFade(durationMs: 400)
        XCTAssertEqual(f.alpha, 0)
        f.show(nowMs: 1_000)
        f.tick(nowMs: 1_200)
        XCTAssertEqual(f.alpha, 0.5, accuracy: 1e-9)
        f.tick(nowMs: 1_400)
        XCTAssertEqual(f.alpha, 1)
        f.hide(nowMs: 2_000)
        f.tick(nowMs: 2_100)
        XCTAssertEqual(f.alpha, 0.75, accuracy: 1e-9)
        f.show(nowMs: 2_100)
        f.tick(nowMs: 2_200)
        XCTAssertEqual(f.alpha, 1)
        f.hideNow()
        XCTAssertEqual(f.alpha, 0)
    }
}
