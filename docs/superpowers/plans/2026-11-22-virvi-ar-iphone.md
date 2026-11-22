# Virvi AR for iPhone, phase 1 (visitor mode) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An iPhone app, Virvi AR, that finds a venue's ring marker through the camera and shows the venue's Virvi scene life-size and lined up with the room, with no sign-in, plus the two server changes it needs.

**Architecture:** A new local Swift package, `VirviARKit` (`packages/virvi-ar-swift`), holds the platform-neutral code: the scene code moved out of the Vision Pro app, and new Swift ports of the Quest's ring reader, AR API client, space alignment and visitor flow. All ported maths runs in the Virvi/Quest frame (left-handed, Y up, +Z forward, headings in degrees from +Z toward +X); the iPhone app converts at its boundary with ARKit/RealityKit by mirroring z. A new `apps/iphone` app (xcodegen) wires ARKit camera frames, planes and tracking into the package's visitor flow and draws with the package's `SceneRenderer`.

**Tech Stack:** Swift 5, SwiftUI, ARKit + RealityKit (iOS 18), GLTFKit2 0.5.15, XCTest, xcodegen; server: Fastify + Vitest (TypeScript).

**Spec:** `docs/superpowers/specs/2026-11-22-virvi-ar-iphone-design.md`

## Global Constraints

- App: display name `Virvi AR`, bundle id `io.virvi.ar`, team `P22YGT64VU`, automatic signing, iOS 18.0+, iPhone only (`TARGETED_DEVICE_FAMILY "1"`), `UIRequiredDeviceCapabilities: [arkit]`, portrait only.
- Package platforms: iOS 18, visionOS 2. GLTFKit2 `exactVersion: 0.5.15` everywhere.
- Server platform string for the iPhone: `ar-ios`. Analytics body `v: 1`, header `X-Virvi-App-Version` on every request.
- The printed rings depend on the codec's mask seed `"VLM ring marker v0"`: never change it.
- Visitor words are the Quest's `VisitorCopy` strings, word for word, except the connection failure, which on iPhone reads `Can't reach Virvi. Check the phone's connection.` Headset-only strings (room scan, keep loaded, builder, sign out, spatial data) are not used.
- Tuning values are the Quest's `VisitorTuning` values (1.5 m, 5/15 frames, 0.01 m, 1.0°, 30°, 0.25 m, 25°, 2.5 m/s, 300°/s, 0.5 s, 600000 ms, 3000 ms, 1500 ms, 2000–30000 ms).
- Scene fade-in 400 ms. Video sound starts with the scene (owner, 2026-11-22; was: only after a tap). "Hide behind people and things" appears only when `ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)` is true.
- Camera frames never leave the phone. No account, no extra identifiers.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; subjects become public release notes, so they're written for players.
- The Vision Pro app's behaviour must not change; its full test suite passes after it moves onto the package.

## Review Focus

1. **Camera image orientation:** `ARFrame.capturedImage` is in the sensor's landscape orientation whatever the phone's orientation; the detector and intrinsics must run in that orientation, never a rotated copy, or ring positions land rotated by 90°. Pinned by the frame-pipeline test in Task 8.
2. **The z mirror at the ARKit boundary:** a sign slip places the scene mirrored or turned the wrong way. Pinned by the round-trip test in Task 6 (ARKit pose → Virvi frame → root → RealityKit transform puts a scene point back where the marker's saved pose says).
3. **Interruptions:** a phone call, backgrounding or ARKit `limited` tracking must hide the scene and require a ring again, never leave it drifting. Pinned in Task 7 (`TrackingJump` from `sessionWasInterrupted` and `limited` tracking).
4. **A link to one space while standing at another's ring:** the ring's space wins (spec). Pinned in Task 7.
5. **Ring of an unpublished or unknown space:** shows "This space isn't set up yet" or "This space isn't open right now." and retries on the Quest's schedule, never a blank screen. Pinned in Task 7.

---

### Task 1: Server accepts the iPhone, and serves Apple's link file

**Files:**
- Modify: `apps/server/src/ar/analytics.ts` (`AR_ANALYTICS_PLATFORMS`)
- Modify: `apps/server/src/config.ts` (new `appleAppIds`)
- Modify: `apps/server/src/app.ts` (route next to `/.well-known/assetlinks.json`, ~line 399)
- Test: `apps/server/test/ar-analytics.test.ts`, `apps/server/test/ar-reports.test.ts`, `apps/server/test/ar-pages.test.ts`, `apps/server/test/helpers/public-routes.ts`

**Interfaces:**
- Produces: `GET /.well-known/apple-app-site-association` (content type `application/json`) returning `{ applinks: { details: [{ appIDs: string[], components: [{ "/": "/s/*" }] }] } }`, or `{ applinks: { details: [] } }` when no app IDs are configured. Config `appleAppIds: string[]` from env `APPLE_APP_IDS` (comma-separated), default `["P22YGT64VU.io.virvi.ar"]`.

- [ ] **Step 1: Failing tests:**
  - analytics accepts `platform: 'ar-ios'` (202/201 as the Quest case does) and still refuses `'ar-android'` with 400 `bad_platform`;
  - report accepts `platform: 'ar-ios'` (201);
  - `GET /.well-known/apple-app-site-association` returns 200 JSON with `appIDs: ['P22YGT64VU.io.virvi.ar']` and component `{ '/': '/s/*' }`; with `APPLE_APP_IDS=''` it returns `{ applinks: { details: [] } }`;
  - the new route is listed in `helpers/public-routes.ts`.
- [ ] **Step 2: Run** `cd apps/server && TEST_DATABASE_URL=postgres://vlm:vlm_dev@localhost:5432/vlm_test_sounds npx vitest run test/ar-analytics.test.ts test/ar-reports.test.ts test/ar-pages.test.ts` — Expected: the new cases FAIL.
- [ ] **Step 3: Implement:** add `'ar-ios'` to the set (keep the comment, drop "adds `ar-ios`"); add `appleAppIds` to config; add the route, served before the static/SPA fallback like `assetlinks.json`.
- [ ] **Step 4: Run** the same command plus the full server suite (`npx vitest run`, redirected to a file) and `npx tsc --noEmit -p .` — Expected: all PASS.
- [ ] **Step 5: Commit** `feat(ar): the server accepts Virvi AR for iPhone, and virvi.io/s links can open the app`.

### Task 2: The shared Swift package, with the Vision Pro app moved onto it

**Files:**
- Create: `packages/virvi-ar-swift/Package.swift`, `Sources/VirviARKit/...`, `Tests/VirviARKitTests/...`, `README.md`
- Move (git mv): `apps/vision-pro/Core/Scene/*.swift` → `Sources/VirviARKit/Scene/`; `Core/Config.swift` → `Sources/VirviARKit/Config.swift`; `Core/Api/HttpTransport.swift` → `Sources/VirviARKit/Api/HttpTransport.swift`
- Move tests: `ScenePlanTests`, `ShowingsTests`, `FloorTests`, `MappingTests`, `HeadPoseTests`, `SceneVisibilityTests`, `PlaylistPlayerTests` → package tests; `FakeTransport.swift` → package tests and keep a copy reference for the Vision Pro tests (or make it `public` in a `VirviARKitTesting` target) **(builder's choice)**
- Modify: `apps/vision-pro/project.yml` (local package dependency `VirviARKit`, sources stop including the moved files), the Vision Pro files that use moved types (`import VirviARKit`)

**Interfaces:**
- Produces: library product `VirviARKit` (platforms `.iOS(.v18)`, `.visionOS(.v2)`), depending on GLTFKit2 0.5.15. Every moved type and function used outside its file becomes `public` with the same name and signature: `Vec3`, `MappedTransform`, `toRealityKitTransform`, `quaternionYXZ`, `MODEL_TURN`, `VIRVI_SCENE_CENTER`, `fromRealityKitPosition`, `headPoseInScene`, `planScene`, `RenderItem`, `Props`, `PlanDiff`, `diffPlans`, `ShowingInstance`, `ScreenState`, `screenStateAt`, `parseShowings`, `resolveScheduled`, `SeekGuard`, `PlaylistPlayer`, `SceneRenderer`, `Downloads`, `AppConfig`, `HttpTransport`, `URLSessionTransport`, floor helpers, collider helpers.
- `SceneFeed` (the builder's `/api/ar/scenes/:id/feed` poller) stays in the Vision Pro app: it is builder-only.

- [ ] **Step 1:** Create the package and move the files and their tests (git mv, so history follows). Mark used declarations `public`; nothing else changes.
- [ ] **Step 2: Run the package tests on iOS:** `cd packages/virvi-ar-swift && xcodebuild -scheme VirviARKit -destination 'platform=iOS Simulator,name=iPhone 16,OS=18.0' test` — Expected: the moved tests PASS on iOS (this also proves `SceneRenderer` compiles for iOS).
- [ ] **Step 3: Run the Vision Pro suite:** `cd apps/vision-pro && xcodegen generate && xcodebuild -project VirviBuilder.xcodeproj -scheme VirviBuilder -destination 'platform=visionOS Simulator,name=Apple Vision Pro,OS=26.1' CODE_SIGNING_ALLOWED=NO test` — Expected: PASS, same test count as before the move minus the moved tests (which now run in the package).
- [ ] **Step 4: Commit** `refactor(ar): the Vision Pro app's scene code moves into a shared Swift package`.

### Task 3: Ring codec (Swift port)

**Files:**
- Create: `Sources/VirviARKit/Ring/RingCodec.swift`
- Test: `Tests/VirviARKitTests/Ring/RingCodecTests.swift` (reads `apps/ring-marker/vectors/codec.json` via a path built from `#filePath`)

**Interfaces:**
- Produces: `public struct RingDecoded: Equatable { id: UInt32; version: Int; corrected: Int }`; `public enum RingCodec { static let cells = 72; static func encode(id: UInt32, version: Int = 0) -> [Bool]; static func decode(_ cells: [Bool?]) -> RingDecoded?; static func codeOf(_ id: UInt32) -> String; static func parseCode(_ code: String) -> UInt32? }`; `public let RING_TEST_MARKERS: [(name: String, id: UInt32, diameterM: Double)]` = RING120 `0x1D2C3B4A`/0.120, RING140 `0x2E3D4C5B`/0.140, RING170 `0x3F4E5D6C`/0.170.
- Port `apps/quest/.../ring/RingCodec.kt` exactly: RS(12,6) over GF(64), 6 parity symbols, up to 2 errors, budget 4 (2·errors + erasures), `OFFSET [0,2,4]`, mask from SHA-256 of `"VLM ring marker v0"` (CryptoKit), 36-bit value `(version << 32) | id`, Crockford alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`.

- [ ] **Step 1: Failing tests:** every `encode` vector reproduces its 72-char cell string; every `decode` vector returns its `expect` (or nil); `codeOf`/`parseCode` round-trip the three test IDs; `parseCode("o1l-...")` reads O as 0 and I/L as 1, ignores hyphens and spaces, and refuses values ≥ 2^32.
- [ ] **Step 2: Run** `xcodebuild -scheme VirviARKit -destination 'platform=iOS Simulator,name=iPhone 16,OS=18.0' test -only-testing:VirviARKitTests/RingCodecTests` — Expected: FAIL (no `RingCodec`).
- [ ] **Step 3: Implement** by porting the Kotlin file.
- [ ] **Step 4: Run** the same — Expected: PASS.
- [ ] **Step 5: Commit** `feat(ar): iPhone reads ring codes the same way as the Quest`.

### Task 4: Ring detector (Swift port)

**Files:**
- Create: `Sources/VirviARKit/Ring/RingDetector.swift`, `Sources/VirviARKit/Ring/RingTracker.swift`
- Test: `Tests/VirviARKitTests/Ring/RingDetectorTests.swift`, `RingTrackerTests.swift`
- Fixture: `apps/ring-marker/testset/` (git-ignored). Generate before testing: `cd apps/ring-marker && python3 -m ringmarker.testset testset` (needs cv2, numpy, PIL, as the Quest's Gradle task does). The test reads `testset/manifest.json` and the 1280×960 grey PNGs via `#filePath`, and fails with a clear message if the folder is missing.

**Interfaces:**
- Produces: `public struct RingDetection: Equatable { id: UInt32; version: Int; corrected: Int; cx, cy, semiMajor, semiMinor, angleDeg, rotationDeg: Double }` (same meanings as the Kotlin type: continuous pixel coordinates, image y down, `angleDeg` in [0,180), `rotationDeg` clockwise from image-up in [0,360)); `public struct UnreadableRing { cx, cy, semiMajor: Double }`; `public struct RingFrame { detections: [RingDetection]; unreadable: [UnreadableRing] }`; `public final class RingDetector { init(); func detectFrame(gray: UnsafeBufferPointer<UInt8>, width: Int, height: Int, rowStride: Int) -> RingFrame }` (not thread-safe; one per camera queue); `public final class RingTracker { init(registered: Set<UInt32>?, framesToAgree: Int = 3); var registered: Set<UInt32>?; func update(_ detections: [RingDetection]) -> [RingDetection]; func reset() }`; `public func nearestToCentre(_ d: [RingDetection], width: Int, height: Int) -> RingDetection?`.
- Port `apps/quest/.../ring/RingDetector.kt` and `RingTracker.kt` faithfully (its docstring spec is `apps/ring-marker/ringmarker/detect.py`). Use Accelerate only where it leaves results identical within the test tolerances.

- [ ] **Step 1: Failing tests,** mirroring `apps/quest/app/src/test/.../ring/RingDetectorTest.kt` and `RingTrackerTest.kt`:
  - each manifest image with `expect: "ids"` yields exactly its markers' IDs, centres within the Kotlin test's tolerance of `center_px`, and `rotationDeg` within its tolerance of `rotation_deg`;
  - each `expect: "none"` image (heavy damage, decoys, `too_far`) yields no detections;
  - `range-RING120-1.8-45` reports nothing it shouldn't;
  - the tracker accepts an ID only after 3 frames in a row, a miss resets it, and a non-nil `registered` filters IDs.
- [ ] **Step 2: Run** with `-only-testing:VirviARKitTests/RingDetectorTests -only-testing:VirviARKitTests/RingTrackerTests` — Expected: FAIL.
- [ ] **Step 3: Implement** the port.
- [ ] **Step 4: Run** — Expected: PASS. Also time `detectFrame` on a 1280×960 image in a test (`measure {}`) and record the number in the commit message.
- [ ] **Step 5: Commit** `feat(ar): iPhone finds ring markers in camera images`.

### Task 5: AR API client (lookup, space feed, report, analytics)

**Files:**
- Create: `Sources/VirviARKit/Api/ArModels.swift`, `ArApi.swift`, `ArFeed.swift`, `VisitAnalytics.swift`
- Test: `Tests/VirviARKitTests/Api/ArApiTests.swift`, `ArFeedTests.swift`, `VisitAnalyticsTests.swift` (with `FakeTransport`)

**Interfaces:**
- Produces (Swift mirrors of `apps/quest/.../api/*.kt` and `packages/shared/src/ar.ts`):
  - `public struct MarkerPose: Equatable { x, y, z, headingDeg: Double }`, `ArMarker { id: String; ringId: UInt32; code: String; diameterMm: Double; whereText: String?; pose: MarkerPose? }`, `ArFloor { id, name: String; heightM: Double; sortOrder: Int; markers: [ArMarker] }`, `ArSpace { id, name: String; place: String?; published: Bool; floors: [ArFloor]; func markerByRing(_ ringId: UInt32) -> (ArFloor, ArMarker)? }`, `MarkerLookup { spaceId, floorId, markerId, spaceName: String; whereText: String? }`, `ArFeedSnapshot { version: String; space: ArSpace; scene: [String: Any]? (as the renderer's planScene expects); showings: [String: [ShowingInstance]]; serverTime: Int64? }`.
  - `public enum ApiResult<T> { case ok(T), notFound, rateLimited, offline, failed(Int) }`.
  - `public final class ArApi { init(baseUrl: URL, transport: HttpTransport, appVersion: String); func lookup(code: String) async -> ApiResult<MarkerLookup>; func feed(spaceId: String, since: String?) async -> ApiResult<ArFeedSnapshot>; func report(spaceId: String, reason: ReportReason) async -> ReportResult; func sendAnalytics(spaceId: String, events: [VisitEvent]) async -> AnalyticsResult }` with routes `GET /api/ar/markers/by-code/:code` (15 s timeout), `GET /api/ar/spaces/:id/feed?since=<version>` (40 s read timeout), `POST /api/ar/spaces/:id/report` `{reason, platform:"ar-ios"}` (201 Sent, 429 RateLimited), `POST /api/ar/spaces/:id/analytics` `{v:1, platform:"ar-ios", events:[{type, playerId, t, x?, y?, z?}]}`.
  - `public enum FeedStatus { connecting, live, offline, rateLimited, notFound, badData, failed }`; `public final class ArFeed { init(api: ArApi, onSnapshot: @escaping (ArFeedSnapshot) -> Void, onStatus: @escaping (FeedStatus) -> Void); func start(spaceId: String); func stop() }` — long-poll loop, back-off 1 s doubling to 30 s on error, as `ArFeed.kt`.
  - `public final class VisitAnalytics` as `VisitAnalytics.kt` (`MAX_QUEUED 200`, `POS_INTERVAL_MS 5000`, a UUID `playerId` per visit; drop on 4xx except 408/429, retry otherwise).

- [ ] **Step 1: Failing tests:** each route's URL, method, headers (`X-Virvi-App-Version`) and body; 404/429/offline/5xx map to the `ApiResult` cases; a full feed body (the shape in this task's Interfaces) parses, a marker without `pose` parses with `pose == nil`; the feed loop sends `since=` from the last version, backs off 1→2→4…30 s on errors (fake clock), and reports `live`; analytics batches enter/pos/leave, caps the queue at 200, and drops on 400.
- [ ] **Step 2: Run** the three test classes — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(ar): iPhone talks to Virvi's AR Spaces API`.

### Task 6: Ring pose and space alignment for ARKit

**Files:**
- Create: `Sources/VirviARKit/Ring/RingPose.swift`, `Sources/VirviARKit/Space/SpaceAlignment.swift`, `Sources/VirviARKit/Space/ArFrame.swift`
- Test: `Tests/VirviARKitTests/Ring/RingPoseTests.swift`, `Tests/VirviARKitTests/Space/SpaceAlignmentTests.swift`

**Interfaces:**
- Produces:
  - `public struct CameraIntrinsics { fx, fy, cx, cy: Double; width, height: Int }` and `public func intrinsics(fromARKit k: simd_float3x3, imageSize: CGSize, scaledTo width: Int, height: Int) -> CameraIntrinsics` (ARKit's matrix is for the full-resolution captured image; scale to the downscaled grey frame).
  - `public func markerInCamera(_ d: RingDetection, _ k: CameraIntrinsics, diameterM: Double) -> Vec3` — range `fx·(D/2)/semiMajor` along the ray through the centre, in the image camera frame (+x right, +y down, +z forward), as `RingPose.kt`.
  - `public func cameraToVirviWorld(_ p: Vec3, cameraTransform: simd_float4x4) -> Vec3`: image camera frame → ARKit camera frame (flip y and z) → ARKit world (`cameraTransform`) → Virvi world (mirror z). **All later maths runs in the Virvi world frame**.
  - `public struct WallPlane { centre: Vec3; normal: Vec3; halfWidth, halfHeight: Double }` (Virvi frame, normal into the room) and `public func wallPlane(from anchor: ARPlaneAnchor) -> WallPlane?` (vertical planes only).
  - Ports of `wallFix(...) -> WallFix?` (`headingDeg: Double?`, `viewAngleDeg: Double`), `circleNormals`, `circleTiltDeg`, `PoseAverager(capacity: 15, minCount: 5)` with the Kotlin constants `TILT_TOLERANCE_DEG 20`, `TILT_AMBIGUOUS_DEG 15`, `WALL_TOLERANCE_M 0.10`, `ROUND_RATIO 0.97`.
  - `public struct RootPose: Equatable { position: Vec3; yawDeg: Double }`, `public func rootFromMarker(markerWorld: Vec3, headingWorldDeg: Double, saved: MarkerPose) -> RootPose`, `markerInScene`, `angleDiffDeg` (ports of `SpaceAlignment.kt`), and `public func realityKitRootTransform(_ root: RootPose) -> Transform` (mirror back for RealityKit, consistent with `toRealityKitTransform`).

- [ ] **Step 1: Failing tests:** port `RingPoseTest.kt` and `SpaceAlignmentTest.kt` cases that don't depend on Meta's `Pose`; plus:
  - a detection of a 140 mm ring with `semiMajor` 101.15 px and `fx` 867 sits 0.600 m away (±1 mm);
  - intrinsics scaling from 1920×1440 to 1280×960 divides fx, fy, cx, cy by 1.5;
  - **round trip (Review Focus 2):** with a saved pose `{x: 8, y: 1.5, z: 2, headingDeg: 180}`, a marker seen at ARKit world (1, 1.5, −2) facing ARKit +Z, `realityKitRootTransform(rootFromMarker(...))` maps scene point (8, 1.5, 2) to ARKit (1, 1.5, −2) (±1 mm) and a scene point 1 m in front of the marker to 1 m in front of it in ARKit;
  - a wall that disagrees with the ring's tilt by more than 20° gives no heading.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(ar): iPhone works out where a ring is and lines the scene up from it`.

### Task 7: The visitor flow (pure state machine)

**Files:**
- Create: `Sources/VirviARKit/Visitor/VisitorFlow.swift`, `VisitorCopy.swift`, `VisitorTuning.swift`, `RingLock.swift`, `LockGate.swift`, `HeadingAverager.swift`, `TrackingWatch.swift`, `UnreadableWatch.swift`, `HintText.swift`
- Test: one test file per source file, ported from `apps/quest/app/src/test/.../visitor/` (`VisitorFlowTest`, `RingLockTest`, `LockGateTest`, `HeadingAveragerTest`, `TrackingWatchTest`, `UnreadableWatchTest`, `HintTextTest`)

**Interfaces:**
- Consumes: Task 5 types (`ArSpace`, `MarkerLookup`, `ArFeedSnapshot`, `ApiResult`, `FeedStatus`), Task 6 (`RootPose`, `rootFromMarker`, `WallFix`).
- Produces (Swift ports, same names and meanings as the Kotlin):
  - `public enum VisitorState { hint, stepCloser, loading(code: String, spaceName: String?), notSetUp(spaceName: String), failed(message: String), locking(space: ArSpace), shown(space: ArSpace, root: RootPose) }`
  - `public enum VisitorEvent { unreadableSeen(sinceMs: Int64), ringAgreed(ringId: UInt32), lookup(code: String, result: ApiResult<MarkerLookup>), unreadableGone, feed(ArFeedSnapshot, steady: [UInt32: SteadyPose]), feedStatus(FeedStatus), steady(ringId: UInt32, world: Vec3, headingDeg: Double), trackingJump, sessionInterrupted, sessionResumed, lookAgain, openSpace(code: String), tick }` (`headsetOff`/`headsetOn` become `sessionInterrupted`/`sessionResumed`; `adopt` is builder-only and not ported)
  - `public enum VisitorEffect { lookup(code: String), startFeed(spaceId: String), stopFeed, showScene(RootPose), reanchor(RootPose), hideScene, hideNow, flashOutline(ringId: UInt32), resetAveragers, setRegistered(Set<UInt32>?), showSpacePage(code: String), closeSpacePage }`
  - `public final class VisitorFlow { public private(set) var state: VisitorState; var reportSpaceId: String?; func on(_ e: VisitorEvent, nowMs: Int64) -> [VisitorEffect] }`
  - `public func hintText(_ state: VisitorState, gather: GatherStatus, unreadableForMs: Int64, problem: DeviceProblem?) -> String?` with `DeviceProblem { cameraDenied, offline }`; `RingLock`, `LockStep`, `LockHeading`, `lockHeading`, `GatherStatus`, `gatherStatus`, `LockGate`, `HeadingAverager`, `TrackingWatch`, `UnreadableWatch` as in the Kotlin.
  - `VisitorCopy`: the Quest strings listed in Global Constraints, plus `NO_CAMERA = "Virvi AR needs camera access to find rings. Allow it in Settings → Apps → Virvi AR."` (the Quest's, unchanged) and `OFFLINE = "Can't reach Virvi. Check the phone's connection."`.

- [ ] **Step 1: Failing tests:** port the Kotlin tests one-to-one (renaming headset events), then add:
  - **Review Focus 3:** `sessionInterrupted` while shown → effects `[hideNow, resetAveragers]`, state back to looking; `sessionResumed` stays hidden until a new `steady`;
  - **Review Focus 4:** after `openSpace("AAAAAAA")` (space A loaded, "Look at the ring when you get there"), a `ringAgreed` of a ring from space B → `lookup(B's code)`, `stopFeed` for A, and B's space shown on `steady`;
  - **Review Focus 5:** `lookup` → `notFound` shows `NOT_SET_UP` and retries after `NOT_FOUND_RETRY_MS`; a feed snapshot with `published: false` shows `NOT_OPEN`; `rateLimited`/`offline` retry with back-off between 2000 and 30000 ms;
  - `hintText` returns `HINT`, `TOO_FAR`, `HOLD_STILL`, `STAND_IN_FRONT` (no wall for 3000 ms) and `nil` when shown, exactly as the Quest's `HintTextTest`.
- [ ] **Step 2: Run** `-only-testing:VirviARKitTests/` the seven classes — Expected: FAIL.
- [ ] **Step 3: Implement** by porting `VisitorFlow.kt`, `HintCard.kt`'s `hintText`/`lockingHint`, and the helpers.
- [ ] **Step 4: Run** — Expected: PASS; then the whole package suite — Expected: PASS.
- [ ] **Step 5: Commit** `feat(ar): iPhone guides visitors to the ring and shows the space, the same way as the Quest`.

### Task 8: The iPhone app

**Files:**
- Create: `apps/iphone/project.yml`, `apps/iphone/App/VirviARApp.swift`, `App/Info.plist`, `App/VirviAR.entitlements` (`com.apple.developer.associated-domains: [applinks:virvi.io]`), `App/ArSessionView.swift` (ARView + session delegate), `App/FramePipeline.swift`, `App/VisitorController.swift`, `App/HintCard.swift`, `App/VisitorMenu.swift`, `App/ReportSheet.swift`, `App/RingOutline.swift`, `README.md`
- Test: `apps/iphone/Tests/FramePipelineTests.swift`, `VisitorControllerTests.swift`, `LinkTests.swift`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `FramePipeline`: on a serial background queue, at most one frame in flight, about 8 frames a second; takes `ARFrame.capturedImage`'s luma plane (`kCVPixelFormatType_420YpCbCr8BiPlanarFullRange`, plane 0) **in sensor orientation**, downscales to 1280×960 (vImage), runs `RingDetector.detectFrame`, and returns detections plus `intrinsics(fromARKit:imageSize:scaledTo:)` and the frame's `camera.transform`. `func process(luma: CVPixelBuffer, intrinsics: simd_float3x3, cameraTransform: simd_float4x4) -> PipelineResult`.
  - `VisitorController`: owns `VisitorFlow`, `RingTracker`, the `ArApi`/`ArFeed`, `VisitAnalytics`, `SceneRenderer`; feeds events from the pipeline (via `RingLock` per marker, as `SpaceSession.onRings` does), from ARKit (`trackingState` `.limited`/`.notAvailable` and `sessionWasInterrupted` → `trackingJump`/`sessionInterrupted`; `sessionInterruptionEnded` → `sessionResumed`; head motion → `TrackingWatch`), from the feed, and from links; applies effects to the RealityKit root (`realityKitRootTransform`), the 400 ms fade, the outline and the menu state.
  - `ARWorldTrackingConfiguration` with `planeDetection = [.vertical, .horizontal]`; when `supportsFrameSemantics(.sceneDepth)`, offer the menu switch that sets `[.sceneDepth, .personSegmentationWithDepth]` and `environment.sceneUnderstanding.options.insert(.occlusion)`.
  - Info.plist: `CFBundleDisplayName Virvi AR`; `NSCameraUsageDescription "Virvi AR uses the camera to find rings and to show the space in this room."`; `UIRequiredDeviceCapabilities [arkit]`; portrait only; `NSAllowsArbitraryLoadsForMedia true`.
  - Links: `onOpenURL`, universal links only — a `https://virvi.io/s/<code>` URL feeds `openSpace(code)`, parsed with `RingCodec.parseCode`; anything else is ignored.
  - Menu: "Look at the ring again", the occlusion switch (LiDAR phones only), "Report this space" (reasons Offensive/Unsafe/Spam/Something else, the Quest's words and results), "Close".
  - Video sound starts with the scene (owner, 2026-11-22).

- [ ] **Step 1: Failing tests:**
  - **Review Focus 1:** `FramePipelineTests` feeds a 1920×1440 luma buffer containing the testset's `range-RING140-0.6-0` image upscaled 1.5× in sensor orientation, and gets RING140 with its centre at the manifest's `center_px` (±2 px after scaling), and intrinsics scaled from the full-resolution fx 1300.5 back to 867;
  - `VisitorControllerTests` (with fake ARKit inputs, fake transport and a fake renderer): a ring seen steadily for 15 frames at 0.8 m on a wall → `lookup`, feed start, then the root transform set and the fade started; `sessionWasInterrupted` hides immediately;
  - `LinkTests`: `https://virvi.io/s/2E3D4C5` → `openSpace("2E3D4C5")`; `https://virvi.io/summit/` and `https://evil.example/s/2E3D4C5` → ignored.
- [ ] **Step 2: Run** `cd apps/iphone && xcodegen generate && xcodebuild -project VirviAR.xcodeproj -scheme VirviAR -destination 'platform=iOS Simulator,name=iPhone 16,OS=18.0' test` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same — Expected: PASS. Then build for a device: `xcodebuild -project VirviAR.xcodeproj -scheme VirviAR -destination 'generic/platform=iOS' build` — Expected: BUILD SUCCEEDED (signing with team `P22YGT64VU`).
- [ ] **Step 5: Commit** `feat(ar): Virvi AR for iPhone, visitor mode: look at the ring and the space appears`.

### Task 9: Docs, the AR page, and the owner's on-device check

**Files:**
- Modify: `packages/shared/src/ar-apps.ts` (the iPhone card's `sourceUrl` → `apps/iphone`, status stays `prototype` until the device check passes, then `preview`), its test; `apps/iphone/README.md` (build, run on a device, test, "Get the app"); `apps/ar-spike/README.md` (point to `apps/iphone` as the real app); `packages/virvi-ar-swift/README.md`.
- Test: `apps/web/src/lib/ar-apps.test.ts`.

- [ ] **Step 1: Failing test:** the iPhone app's `sourceUrl` is `https://github.com/virvi-xr/virvi/tree/main/apps/iphone`.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/lib/ar-apps.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the config change and the READMEs.
- [ ] **Step 4: Run** the full web suite and both typechecks — Expected: PASS.
- [ ] **Step 5: Commit** `docs(ar): Virvi AR for iPhone's source, build and test guide`.
- [ ] **Step 6: The owner's device check** (manual, from the spec's Testing section), with a printed ring of a published space on a wall: opens within a few seconds at 0.6–1.5 m; "Step closer to the ring" further away; walking around keeps the scene in place; a second ring re-anchors; leaving the app and coming back hides the scene until the ring is seen again; a `virvi.io/s/<code>` link from Messages opens the app. Results go in the ledger; if it passes, set the iPhone card's status to `preview` in a follow-up commit.
