# Virvi Builder for Vision Pro (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A visionOS app where the owner pairs the headset once, picks a scene, puts it down life-size in their room, and builds it with a HUD that matches Decentraland's: all eight tabs, place from the library, and Move/Rotate/Resize with Save/Revert/Done. Edits go to the shared scene.

**Architecture:**
- **Server:** four small additions.
  - A headset pass for a scene (not only an AR space), plus the list of scenes the headset can build on.
  - A scene-keyed draft feed.
  - The HUD's routes accept that pass, except `POST /api/auth/handoff` and transfer host.
  - A scene-scoped events read.
- **App:** a new Xcode project, `apps/vision-pro`, grown from `apps/ar-spike`.
  - A UI-free `Core/` folder holds the API client, pairing, passes, the feed, and every HUD model. It's covered by XCTest on the visionOS simulator.
  - `App/` holds the SwiftUI window and the RealityKit immersive space.
  - Edits go over HTTP, as on the Quest: drafts to `/api/ar/drafts`, and saves to `PUT /api/instances/:id`.

**Tech Stack:**
- Server: Fastify, TypeScript, Drizzle and vitest, in `apps/server`; shared types in `packages/shared`.
- App: Swift 5, SwiftUI, RealityKit and ARKit on visionOS 2+, GLTFKit2 0.5.15, xcodegen and XCTest. The installed Xcode is 26.1.

**Spec:** `docs/superpowers/specs/2026-10-31-vision-pro-builder-design.md` (read it first; it's the authority).

## Global Constraints

- The HUD matches the Decentraland HUD: tab names and order **Layout, Assets, Events, Stream, Worlds, Alerts, Roles, Stats**, labels, empty-state copy, confirmation wording, and the Save/Revert/Done rules. Where the plan doesn't quote copy, copy it from `packages/adapter-dcl/src/DclHUDRenderer.tsx` and `packages/adapter-dcl/src/hud/EditModeBar.tsx`, verbatim.
- New copy uses Virvi names. `node scripts/check-no-vlm.mjs` (run from the repo root) must report 0 hits.
- Secrets:
  - The headset secret is kept only in the Keychain, never in `UserDefaults`.
  - Tokens, secrets and pairing codes are never logged, on the server or in the app.
- Personal headsets only. A shared headset is refused a scene pass with 403 `personal_only`.
- `POST /api/auth/handoff` and `POST /api/scenes/:sceneId/transfer-host` keep refusing headset passes.
- Billing code is off limits.
- Node: put `~/.nvm/versions/node/v22.23.3/bin` first on PATH, because the default `node` is 16.
- Never use bare `git stash`. Commit trailers:
  ```
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_018ds2NZXw5KLxDpVm9B3ABD
  ```
- Don't touch the dev DB `vlm`. The server tests use their own test DB through `test/helpers/db.js`.
- Bundle id `io.virvi.builder.visionos`, display name **Virvi Builder**, deployment target visionOS 2.0, `DEVELOPMENT_TEAM: ""`.
- Swift test command, from `apps/vision-pro`:
  ```
  xcodegen generate && xcodebuild -project VirviBuilder.xcodeproj -scheme VirviBuilder -destination 'platform=visionOS Simulator,name=Apple Vision Pro,OS=26.1' CODE_SIGNING_ALLOWED=NO test
  ```
- Server test command, from `apps/server`: `npx vitest run <file>`.

## Review Focus

1. **A pass that runs out mid-edit:** a call that gets 401 (other than `device_revoked`) mints a fresh pass once and retries. The builder never sees it. *Test:* Task 6, `testRetriesOnceWithFreshPassAfter401`.
2. **The headset revoked on the dashboard while building:** the next mint answers 401 `device_revoked`. The app goes back to pairing, drops its drafts, and doesn't crash or loop. *Test:* Task 6, `testRevokedDeviceReturnsToUnpaired`.
3. **A feed update arriving while an item is being dragged:** the dragged item keeps its local transform until Save or Revert. Other items update. *Test:* Task 9, `testFeedUpdateDoesNotMoveItemBeingEdited`.
4. **Someone else holding the item** (draft 409 `held`): the bar shows "being moved by <holderName>", drafting stops, and Save stays off. *Test:* Task 9, `testHeldItemStopsDraftingAndBlocksSave`.
5. **Offline:** any call failing for lack of a network gives "Can't reach virvi.io: check the connection and try again" (the Quest's copy). Nothing is lost locally, and Save can be pressed again. *Test:* Task 9, `testOfflineSaveKeepsDraftAndShowsCopy`.

---

### Task 1: A headset pass for a scene, and the scenes it can build

**Files:**
- Modify: `packages/shared/src/ar.ts` (types)
- Modify: `apps/server/src/ar/devices.ts`
- Modify: `apps/server/src/routes/ar-devices.ts`
- Test: `apps/server/test/ar-devices.test.ts`

**Interfaces:**
- Produces:
  - `POST /api/ar/devices/:id/pass` with body `{ secret, sceneId }`, as an alternative to `{ secret, spaceId }`. It returns `ArPassResponse`, unchanged. Errors are the existing `MintError` codes plus 403 `personal_only` for a shared headset that sends `sceneId`. Exactly one of `spaceId` and `sceneId` must be given, otherwise 400.
  - `POST /api/ar/devices/:id/scenes` with body `{ secret }`. It returns `ArDeviceScene[]`, sorted by `sceneName`.
  - In shared: `export type ArDeviceScene = { sceneId: string; sceneName: string }`.
  - In `devices.ts`:
    - `mintArPassForScene(app, deviceId, secret, sceneId, now?)` returns `Promise<{ pass; passExpiresAt; sceneId } | MintError | 'personal_only'>`.
    - `listDeviceScenes(deviceId, secret, now?)` returns `Promise<ArDeviceScene[] | 'bad_secret' | 'device_revoked'>`.
- The pass is the same AR pass (`issueArPass`, `via: 'ar'`, `deviceId`, `sceneId`), so the draft routes work unchanged.

- [ ] **Step 1: Write failing tests** in the existing `describe` of `ar-devices.test.ts`, using its `pairAs` helper:
  - `it('mints a pass for a scene the approver can build on, with no space')`: pair a personal headset, then `POST /pass` with `{ secret, sceneId }`. Expect 200 and `sceneId` equal to the scene. `verifySessionToken(pass)` has `via: 'ar'`, the device id and the scene id.
  - `it('refuses a scene pass to a shared headset')`: expect 403, `{ error: 'personal_only' }`.
  - `it('refuses a scene pass on a scene the approver cannot build')`: another user's scene. Expect 403 `no_access`.
  - `it('needs exactly one of spaceId and sceneId')`: both, or neither. Expect 400.
  - `it('lists the scenes the approver can build on')`: owned, collaborator, and a role holder (copy `listDeviceSpaces`' candidate set) are listed, with or without a space. A scene with no access isn't listed. A bad secret gives 401.
- [ ] **Step 2:** Run `npx vitest run test/ar-devices.test.ts`. Expected: the new tests FAIL (400 or 404).
- [ ] **Step 3: Implement.**
  - Factor the candidate-scenes query out of `listDeviceSpaces` into one private helper, and use it in `listDeviceScenes`.
  - `mintArPassForScene` reuses `mintArPass`'s body after the scene lookup, through one private helper that takes a resolved `sceneId`. Don't copy it. It returns `'personal_only'` when `device.kind !== 'personal'`, before the access check.
  - Update the route-list doc comment at the top of `routes/ar-devices.ts`.
- [ ] **Step 4:** Run the same file. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(ar): a personal headset mints a pass for a scene, and lists the scenes it can build`.

### Task 2: A draft feed for a scene

**Files:**
- Modify: `packages/shared/src/ar.ts`
- Modify: `apps/server/src/routes/ar-feed.ts`
- Test: `apps/server/test/ar-feed.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/ar/scenes/:id/feed?since=<version>`, a long poll like the space feed. It returns `ArSceneFeedResponse = { v: 1; version: string; scene: SerializedScene | null }`.
  - It needs a builder: any signed-in caller (account token or AR pass) for whom `mayBuild` holds. Anyone else, including a call with no header, gets 404 `not_found`.
  - The route config is `{ logLevel: 'warn', config: { rateLimit: false, scenePass: { sceneFrom: fromParam('id'), ar: true } } }`. The per-IP `AR_FEED_LIMIT` limiter is shared with the space feed.
  - `version` is the SHA-256 of `JSON.stringify({ scene })`. Build it from `sceneSnapshot(sceneId)` (`../hyperfy/snapshot.js`) with no adjustments.

- [ ] **Step 1: Write failing tests:**
  - `it('serves a scene feed to its builder with an AR pass')`.
  - `it('hides a scene feed from a visitor and from another scene's pass')`: expect 404 and 403 respectively. The 403 comes from `authenticate` for the wrong scene's pass.
  - `it('holds until the scene changes when since matches')`: use `setArFeedHoldMs`, as the existing space-feed tests do.
- [ ] **Step 2:** Run `npx vitest run test/ar-feed.test.ts`. Expected: FAIL (404 route).
- [ ] **Step 3: Implement** next to the space feed. Reuse `longPoll`, `isBuilder` and `signInIfPresent`. `fromParam` is in `../auth/scene-from.js`.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(ar): a scene-keyed draft feed for headset builders`.

### Task 3: The HUD's routes take a headset pass

**Files:**
- Modify: `apps/server/src/routes/scene-library.ts`
- Modify: `apps/server/src/routes/companion-upload.ts`
- Modify: `apps/server/src/routes/scene-roles.ts`
- Modify: `apps/server/src/routes/dcl-destinations.ts`
- Modify: `apps/server/src/routes/scenes.ts`
- Test (new): `apps/server/test/ar-hud-routes.test.ts`

**Interfaces:**
- Produces: `ar: true` is added to the `scenePass` config of exactly these routes. Each keeps its existing scene and scope checks.
  - `GET`, `POST`, `PATCH` and `DELETE` on `/api/scenes/:sceneId/library[/:id]`, where not already set.
  - `POST /api/upload-tokens`.
  - `GET` and `POST /api/scenes/:sceneId/roles`, and `DELETE /api/scenes/:sceneId/roles/:wallet`.
  - `GET /api/scenes/:sceneId/dcl/publish-status`.
  - `POST /api/elements/:elementId/live`.
  - `PUT /api/scenes/:sceneId`.
  - `GET /api/scenes/:sceneId`, if not already set.
- Unchanged, and asserted to refuse an AR pass (403 `ar_pass_not_allowed`): `POST /api/scenes/:sceneId/transfer-host` and `POST /api/auth/handoff`.

- [ ] **Step 1: Write failing tests.**
  - Pair a personal headset and mint a scene pass (Task 1). Then:
    - `it.each` over the routes above: each returns its normal success status for the scene's owner pass. It is not 403 `ar_pass_not_allowed`.
    - The same pass on another scene's id gets 403.
  - `it('keeps transfer-host and the web hand-off away from a headset pass')`: both answer 403 `ar_pass_not_allowed`.
- [ ] **Step 2:** Run `npx vitest run test/ar-hud-routes.test.ts`. Expected: FAIL on the not-yet-marked routes.
- [ ] **Step 3: Implement.** Add `ar: true` only to the listed routes.
- [ ] **Step 4:** Run it, then the whole server suite with `npx vitest run`. Expected: all PASS.
- [ ] **Step 5:** Commit: `feat(ar): the in-world HUD's routes accept a headset pass (not host transfer or web hand-off)`.

### Task 4: The scene's events

**Files:**
- Create: `apps/server/src/routes/scene-events.ts` (register it in `apps/server/src/app.ts` next to `events.ts`)
- Modify: `packages/shared/src/` (a type next to the other scene types)
- Test (new): `apps/server/test/scene-events.test.ts`

**Interfaces:**
- Produces `GET /api/scenes/:sceneId/events`, which returns `SceneEventsResponse = { events: Array<{ id: string; name: string; startTime: string | null; endTime: string | null; live: boolean }> }`.
  - It lists the events linked to the scene through `eventSceneLinks`.
  - The order is live first, then upcoming by `startTime`, then the rest.
  - An event is `live` when `startTime <= now` and (`endTime` is null or `endTime > now`).
  - A caller without `scene.edit` on the scene gets 404 `not_found`.
  - The route config is `scenePass: { sceneFrom: fromParam('sceneId'), ar: true }`.

- [ ] **Step 1: Write failing tests:**
  - `it('lists the events a scene is linked to, live first')`.
  - `it('hides events from a caller who cannot edit the scene')`.
  - `it('takes a headset pass for its scene')`.
- [ ] **Step 2:** Run `npx vitest run test/scene-events.test.ts`. Expected: FAIL (404 route).
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(events): a scene's events, for the headset's Events tab`.

### Task 5: The app project, with the spike's core ported

**Files:**
- Create:
  - `apps/vision-pro/project.yml`
  - `apps/vision-pro/README.md`
  - `apps/vision-pro/.gitignore` (ignores `VirviBuilder.xcodeproj`)
  - `apps/vision-pro/Core/Scene/Mapping.swift`, `Core/Scene/ScenePlan.swift` and `Core/Scene/SceneRenderer.swift`, copied from `apps/ar-spike/Shared/`
  - `apps/vision-pro/App/VirviBuilderApp.swift` (a window that says "Virvi Builder")
  - `apps/vision-pro/Tests/MappingTests.swift` and `Tests/ScenePlanTests.swift`, copied from the spike's tests
- Leave `apps/ar-spike` as it is.

**Interfaces:**
- `project.yml` has these targets:
  - `VirviBuilder`: application, visionOS. Sources `[Core, App]`. GLTFKit2 at `exactVersion: 0.5.15`.
  - `VirviBuilderTests`: `bundle.unit-test`, visionOS. Sources `[Tests, Core]`. Host app `VirviBuilder`.
  - Scheme `VirviBuilder` runs the tests.
- Info: `NSWorldSensingUsageDescription: "Virvi Builder uses world tracking to pin your scene to a spot in this room."`, and `NSAppTransportSecurity.NSAllowsArbitraryLoadsForMedia: true`.
- Debug builds read a `-baseUrl` launch argument. Release builds always use `https://virvi.io`. `Core/Config.swift` has `enum AppConfig { static var baseUrl: URL }`.

- [ ] **Step 1:** Copy the spike's tests into `Tests/`.
- [ ] **Step 2:** Run the Swift test command. Expected: FAIL, because the project doesn't exist yet or has missing types.
- [ ] **Step 3:** Write `project.yml`, the copied Core files, the app shell and `Config.swift`. The README covers building, running in the simulator, running on the device (signing, as in the spike's README), and the fixture server from Task 11.
- [ ] **Step 4:** Run the Swift test command. Expected: PASS, with the spike's mapping and plan tests green.
- [ ] **Step 5:** Commit: `feat(vision-pro): Virvi Builder project with the spike's scene core`.

### Task 6: API client, pairing and passes

**Files:**
- Create:
  - `Core/Api/HttpTransport.swift`
  - `Core/Api/VirviApi.swift`
  - `Core/Auth/SecretStore.swift`
  - `Core/Auth/DeviceAuth.swift`
  - `Core/Auth/PassProvider.swift`
- Test: `Tests/DeviceAuthTests.swift`, `Tests/PassProviderTests.swift` and `Tests/FakeTransport.swift`

**Interfaces:**
- `protocol HttpTransport: Sendable { func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) }`, with `struct URLSessionTransport: HttpTransport`.
- `enum ApiError: Error, Equatable { case offline; case status(Int, code: String?); case decode }`. `.offline` is any `URLError` from the transport. `code` is the body's `error` field.
- `final class VirviApi: Sendable`:
  - `init(baseUrl: URL, transport: HttpTransport, passes: PassProvider?)`.
  - `func device<T: Decodable>(_ method: String, _ path: String, body: [String: Any]) async throws -> T` sends without a pass.
  - `func scene<T: Decodable>(_ sceneId: String, _ method: String, _ path: String, body: [String: Any]?) async throws -> T` sends with `Authorization: Bearer <pass>`. On a 401 whose code isn't `device_revoked`, it asks `passes` for a fresh pass once and retries. An `EmptyResponse` type covers 204.
- `protocol SecretStore { func load(_ key: String) -> String?; func save(_ key: String, _ value: String); func delete(_ key: String) }`, with `KeychainStore` (kSecClassGenericPassword, service `io.virvi.builder`) and `MemoryStore` for tests.
- `@MainActor final class DeviceAuth: ObservableObject`:
  - `@Published private(set) var state: AuthState`, where `enum AuthState: Equatable { case unpaired; case pairing(code: String, approveUrl: URL); case paired(deviceId: String); case refused }`.
  - `func startPairing() async`: generates a 32-byte random secret and stores it under `headsetSecret`. It posts `/api/ar/pair` with `{ secretHash: sha256hex(secret), deviceName: "Apple Vision Pro" }`.
  - `func pollClaim() async`: calls `/api/ar/pair/:code/claim` every 2 s until approved or refused. On approval it stores `deviceId`.
  - `func cancel()`.
  - `func signOut() async`: posts `/api/ar/devices/:id/end`, then clears both keys.
  - `func scenes() async throws -> [DeviceScene]`.
  - `func onRevoked()`: clears the keys and sets `.unpaired`.
- `actor PassProvider`:
  - `init(baseUrl:transport:secrets:onRevoked:)`.
  - `func pass(for sceneId: String) async throws -> String` caches per scene and mints again when under 30 s remain, or when `forceFresh: true`. A 401 `device_revoked` (or `bad_secret`) calls `onRevoked` and throws `ApiError.status(401, code: "device_revoked")`.
- `formatPairingCode("ABC123") == "ABC-123"`, as in the Quest's `PairingPanel.kt`.

- [ ] **Step 1: Write failing tests:**
  - `testPairingStoresSecretInKeychainNotDefaults`.
  - `testClaimApprovedStoresDeviceId`.
  - `testClaimRefusedSetsRefused`.
  - `testPassIsReusedUntil30sBeforeExpiry`.
  - `testRetriesOnceWithFreshPassAfter401`: the first call 401 `bad_token`, the second 200. Expect two mints and one success.
  - `testRevokedDeviceReturnsToUnpaired`: the mint answers 401 `device_revoked`. State goes to `.unpaired`, the keys are cleared, and there's no retry loop (at most one mint).
  - `testUrlErrorIsOffline`.
  - `testFormatPairingCode`.
- [ ] **Step 2:** Run the Swift test command. Expected: FAIL (missing types).
- [ ] **Step 3: Implement.** Use `CryptoKit.SHA256` for the hash.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(vision-pro): pairing, Keychain secret and scene passes`.

### Task 7: The scene feed and renderer

**Files:**
- Create: `Core/Scene/SceneFeed.swift`
- Modify: `Core/Scene/SceneRenderer.swift`
- Test: `Tests/SceneFeedTests.swift`

**Interfaces:**
- `@MainActor final class SceneFeed: ObservableObject`:
  - `@Published private(set) var scene: Props?`, `version: String?` and `status: FeedStatus`.
  - `func start(sceneId: String)` long-polls `GET /api/ar/scenes/:id/feed?since=<version>` through `VirviApi.scene`.
  - `func stop()`.
  - Failure backoff is 1, 2, 4 and 8 s, capped at 8. `.offline` keeps the last scene.
  - `static func parse(_ data: Data) -> (version: String, scene: Props?)?`.
- `SceneRenderer`: `apply(_:)` takes an extra `holding: Set<String>`, the keys being edited. Their entities keep their current transform; everything else follows the plan. Add `instanceKey(_ entity: Entity) -> (elementId: String, sk: String)?` for picking.
- A model that isn't `.glb`/`.gltf`, or that fails to load, gets the spike's pink `placeholderBox(named:)`. It stays pickable (it has an `EditableItemComponent` and a collision shape).

- [ ] **Step 1: Write failing tests:**
  - `testParseReadsVersionAndScene`.
  - `testFeedPassesSinceOnNextPoll`.
  - `testOfflineKeepsLastScene`.
  - `testBackoffCapsAt8s`: inject a sleeper.
  - `testHeldKeysAreNotRepositioned`: renderer with a plain `Entity` root. The test runs in the visionOS simulator.
  - `testPlaceholderIsPickable`.
- [ ] **Step 2:** Run the Swift test command. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(vision-pro): scene feed and renderer that hold items being edited`.

### Task 8: HUD model: tabs, Layout, Assets and placing

**Files:**
- Create: `Core/Hud/HudModel.swift`, `Core/Hud/LayoutModel.swift`, `Core/Hud/AssetsModel.swift`, `Core/Hud/Placement.swift` and `Core/Hud/PlacedMessage.swift`
- Test: `Tests/HudModelTests.swift`, `Tests/AssetsModelTests.swift` and `Tests/PlacementTests.swift`

**Interfaces:**
- `enum HudTab: String, CaseIterable { case layout = "Layout", assets = "Assets", events = "Events", stream = "Stream", worlds = "Worlds", alerts = "Alerts", roles = "Roles", stats = "Stats" }`.
- `enum SceneRole: String { case host, cohost, editor, viewer }`. Find the role the same way the Decentraland HUD sets `state.sceneRole`, in `packages/adapter-dcl/src/index.ts`.
- `func visibleTabs(role: SceneRole) -> [HudTab]` returns the order above, with `.roles` only for host and cohost. It matches `NavBar`.
- `func canEdit(_ role: SceneRole) -> Bool`: host, cohost and editor.
- **LayoutModel:**
  - `rows(scene: Props) -> (rows: [LayoutRow], more: Int)`, capped at 12. `more` produces "+N more — manage them on the dashboard".
  - `LayoutRow { elementId, typeTag (3 letters, as DclHUDRenderer), name, enabled }`.
  - `setEnabled` calls `PUT /api/elements/:id {enabled}`. `delete` calls `DELETE /api/elements/:id`.
  - The confirmation copy is "Delete this element and all its copies? This can't be undone.".
- **AssetsModel:**
  - `rows(library:) -> (rows: [AssetRow], more: Int)`, capped at 10. `more` produces "+N more — place them from the dashboard".
  - `AssetRow { id, tag ("GLB" | "IMG"), name, badge, action }`, where `action` is `.place`, `.dismiss` (for `failed`) or `.none` (for in-flight). `needs_sync` shows "⟳ Needs sync" and can still be placed.
  - `rename` calls `PATCH /api/scenes/:sceneId/library/:id {name}`.
  - `uploadUrl()` posts `/api/upload-tokens {sceneId}` and returns `token.uploadUrl`.
  - The sync notice copy matches DclHUDRenderer's `SyncNotice`.
- **Placement:**
  - `func placement(kind: PlaceKind, headPosition: SIMD3<Double>, headYawDeg: Double) -> ItemTransform`, in Virvi scene coordinates. It ports `placementInFrontOfPlayer` from `packages/adapter-dcl/src/index.ts:86-105` exactly:
    - 2 m ahead along the head yaw.
    - The yaw squared to the nearest 90°, then facing the builder (`(yawDeg + 180) mod 360`).
    - Images at `feet + 1.2` with scale `(2, 2, 1)`; models at `feet` with scale `(1, 1, 1)`.
    - Values rounded to 0.01.
  - Here `feet` is the floor under the scene (Virvi y 0), so `feet = 0`. The App layer converts the head pose into scene coordinates with `Mapping`'s inverse.
  - `place(row:)` posts `/api/presets/:activePresetId/elements {type, name, properties}`, then `/api/elements/:id/instances {position, rotation, scale}`, as the Quest's `BuilderApi.place` does. If the instance post fails, it deletes the element.
- **PlacedMessage:** `placedMessage(name: String, destination: PublishDestination?) -> (text: String, publish: Bool)` ports `packages/core/src/placed-message.ts` verbatim (all six texts).

- [ ] **Step 1: Write failing tests:**
  - `testTabsOrderAndRolesOnlyForHosts`.
  - `testLayoutCapsAt12WithMoreLine`.
  - `testAssetRowsActionsByStatus`.
  - `testPlacementMatchesDclForYaw0And100`: yaw 100 squares to 90, giving the position `(2, 0, 0)` relative to the head, rotation y `270`, scale `(1, 1, 1)` for a model. For an image, y is `1.2` and the scale `(2, 2, 1)`.
  - `testPlacedMessageTexts`: one assertion per branch, with the strings copied from `placed-message.ts`.
  - `testPlaceDeletesElementWhenInstanceFails`.
- [ ] **Step 2:** Run the Swift test command. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(vision-pro): HUD tabs, layout, library and placing, as in Decentraland`.

### Task 9: The edit session

**Files:**
- Create: `Core/Edit/EditSession.swift`, `Core/Edit/DraftSender.swift` and `Core/Edit/TransformMath.swift`
- Test: `Tests/EditSessionTests.swift`

**Interfaces:**
- `enum EditMode: String { case move = "Move", rotate = "Rotate", resize = "Resize" }` and `enum AxisLock { case free, x, y, z }`. `next()` cycles free, x, y, z, free.
- `@MainActor final class EditSession: ObservableObject`:
  - Published state: `mode`, `lock`, `snap: Bool`, `selected: Selection?` (`elementId`, `sk`, `name`, `original: ItemTransform`, `current: ItemTransform`), `dirty: Bool`, `saving: Bool`, `message: String?` and `heldBy: String?`.
  - `func select(_:) -> Bool` returns false, and sets `message` to "Save or revert changes to <name> first.", when another item is dirty.
  - `func update(_ t: ItemTransform)` applies snap when it's on: rotation 15°, uniform scale 0.1, single-axis scale 0.25, the values in `packages/core/src/transform/session.ts`. Move isn't snapped. It sends a draft through `DraftSender`.
  - `func exact(_ field: ExactField, _ v: Vec3)`.
  - `func save() async` calls `PUT /api/instances/:sk {position, rotation, scale}` and waits for the answer. On success it sends `drafts/end {saved: true}`; `original` becomes `current`, and `dirty` becomes false.
  - `func revert()` sends `drafts/end {saved: false}`.
  - `func done() -> Bool` is false, with the same message, while dirty.
  - `saveEnabled` is `dirty && !saving && heldBy == nil`. `revertEnabled` is `dirty && !saving`.
- `DraftSender` throttles to one `POST /api/ar/drafts {element, sk, position, rotation, scale}` per 100 ms, always sending the latest. A 409 `held` sets `heldBy = holderName` and stops sending. It resumes on the next `select`.
- `editingKeys: Set<String>` feeds `SceneRenderer.apply(_:holding:)`.

- [ ] **Step 1: Write failing tests:**
  - `testSaveRevertOffUntilChange`.
  - `testSelectingAnotherWhileDirtyIsRefusedWithCopy`.
  - `testDoneWhileDirtyRefusedWithCopy`.
  - `testSnapSteps`: 22° snaps to 15°, 1.23 to 1.2 uniform, 1.37 to 1.25 on one axis.
  - `testLockCycles`.
  - `testDraftsThrottledTo100ms`: inject a clock. 10 updates in 50 ms send 1 draft now and 1 trailing.
  - `testSaveSendsPutThenDraftEndSaved`.
  - `testFeedUpdateDoesNotMoveItemBeingEdited`: `editingKeys` contains the selected sk until save or revert.
  - `testHeldItemStopsDraftingAndBlocksSave`.
  - `testOfflineSaveKeepsDraftAndShowsCopy`: the message is "Can't reach virvi.io: check the connection and try again", `dirty` stays true, and `saveEnabled` is true again.
- [ ] **Step 2:** Run the Swift test command. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(vision-pro): Move/Rotate/Resize edit session with drafts and Save/Revert/Done`.

### Task 10: Stream, Worlds, Alerts, Events and Roles models

**Files:**
- Create: `Core/Hud/StreamModel.swift`, `Core/Hud/WorldsModel.swift`, `Core/Hud/AlertsLog.swift`, `Core/Hud/EventsModel.swift` and `Core/Hud/RolesModel.swift`
- Test: `Tests/TabModelsTests.swift`

**Interfaces** (the spec's "The tabs built for real on the headset" section is binding; empty-state copy is verbatim):
- **StreamModel:**
  - `streams(scene: Props) -> [StreamRow { elementId, name, isLive }]` covers the video elements, as in `packages/hyperfy-app/src/hud/model.ts`.
  - `setLive(_ elementId: String, _ on: Bool)` calls `POST /api/elements/:id/live {enabled}`.
  - The button label is "Go Live" or "Go Offline". The empty state is "No active streams".
- **WorldsModel:**
  - `load()` calls `GET /api/scenes/:id/dcl/publish-status` and returns `WorldRow? { world, status, pending, publishUrl }`.
  - The empty state is "No connected worlds".
  - It also feeds `PlacedMessage`'s `PublishDestination`.
- **AlertsLog:**
  - `push(_ text: String, kind: .info | .error)` keeps the last 20, newest first, for the session.
  - `diff(prev: Props?, next: Props?) -> [String]` gives "Stream is live" or "Stream went offline" per video whose `isLive` changed. It's a port of `model.ts`'s diff.
  - The empty state is "No notifications".
- **EventsModel:**
  - `load()` calls `GET /api/scenes/:id/events` (Task 4).
  - `presets(scene:)` returns the scene's presets with the active one marked.
  - `switchLayout(presetId)` calls `PUT /api/scenes/:id {activePresetId}`, with the label "Switch layout".
  - The empty state is "No active events".
- **RolesModel:**
  - `load()`, `add(wallet:role:)` and `remove(wallet:)` use the three role routes.
  - The role labels are Co-host, Editor and Viewer (`roleLabel` in DclHUDRenderer).
  - There's no transfer host. In its place the tab shows: "To hand this scene to another host, use Roles on the dashboard."

- [ ] **Step 1: Write failing tests:**
  - `testStreamsListVideosWithLiveLabels`.
  - `testWorldsEmptyAndLoaded`.
  - `testAlertsKeep20NewestFirstAndDiffLiveChanges`.
  - `testEventsSwitchLayoutPutsActivePreset`.
  - `testRolesHasNoTransferHostAndShowsDashboardLine`.
- [ ] **Step 2:** Run the Swift test command. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(vision-pro): Stream, Worlds, Alerts, Events and Roles tabs`.

### Task 11: The window: pairing, scene picker and the HUD

**Files:**
- Create: `App/RootView.swift`, `App/PairingView.swift`, `App/ScenePickerView.swift`, `App/HudView.swift` (one view per tab, in `App/Tabs/`) and `App/BrowserWindow.swift`
- Create: `apps/vision-pro/tools/fake_server.py`, a fixture server for the simulator
- Modify: `apps/vision-pro/README.md`

**Interfaces:**
- `RootView` switches on `DeviceAuth.state`:
  - `PairingView` shows the formatted code in large type, a QR of `approveUrl` (CoreImage `CIQRCodeGenerator`), and **Cancel**.
  - `ScenePickerView` shows "Choose a scene to build" and the list from `scenes()`. While loading it says "Finding your scenes…", and with no scenes, "This account has no scenes to build on yet".
  - Once a scene is picked, `HudView`.
- `HudView` is a tab bar from `visibleTabs(role:)` and one view per tab, bound to the Task 8 and Task 10 models.
  - **Edit layout** (editors only) opens the immersive space in edit mode.
  - **Upload** shows **Open on this computer**, which opens `uploadUrl` in `BrowserWindow`, plus the phone QR/code view, **New link** and **Back**, as in Decentraland.
  - **Stats** opens the analytics URL in `BrowserWindow`. The URL is the one `analyticsUrlFor` builds in `packages/core`, with no hand-off.
  - **Publish** opens `publishUrl` in `BrowserWindow`.
- Every `EditSession.message` that reports a failure or refusal (save failed, offline, held, refused) is also pushed to `AlertsLog` as `.error`, and the feed's `AlertsLog.diff` runs on each new scene. This is the spec's Alerts behaviour.
- `BrowserWindow`: a `WindowGroup(id: "browser", for: URL.self)` showing an `SFSafariViewController`-equivalent web view (`WKWebView` through `UIViewRepresentable`).
- `fake_server.py` serves, on `127.0.0.1:8787`:
  - pair, claim (approves on the second poll), `scenes`, `pass` and the scene `feed`, with the spike's Duck GLB fixture;
  - `GET` scene, library, `publish-status`, `events` and `roles`;
  - drafts (204) and `PUT` instance (200).
  - It logs no tokens.

- [ ] **Step 1:** Build for the simulator:
  ```
  xcodebuild -project VirviBuilder.xcodeproj -scheme VirviBuilder -destination 'generic/platform=visionOS Simulator' CODE_SIGNING_ALLOWED=NO build
  ```
  Expected: `** BUILD SUCCEEDED **`.
- [ ] **Step 2:** Run `python3 tools/fake_server.py <fixture dir>`, then launch with `xcrun simctl launch <vision-sim-id> io.virvi.builder.visionos -baseUrl http://127.0.0.1:8787`. Take screenshots with `xcrun simctl io <id> screenshot` of pairing, the scene picker, and each of the eight tabs. Save them to `apps/vision-pro/docs/`.
  - Expected: the tab labels and order are exactly the Global Constraints list, and each empty or loaded state matches Task 10's copy.
- [ ] **Step 3:** Run the Swift test command. Expected: PASS.
- [ ] **Step 4:** Commit: `feat(vision-pro): pairing, scene picker and the full HUD window`.

### Task 12: The immersive space: put the scene down, pick, gizmo, edit bar

**Files:**
- Create: `App/BuildSpace.swift` (ported from the spike's `visionOS/SpaceController.swift` and `VirviSpacesApp.swift` immersive part), `App/Gizmo.swift` and `App/EditBarView.swift`
- Modify: `apps/vision-pro/README.md`

**Interfaces:**
- **Putting the scene down:** the spike's **Place scene** behaviour, unchanged.
  - The floor disc and parcel outline.
  - Pinch-drag on them slides the scene; a two-hand twist turns it.
  - **Pin to this room** uses a `WorldAnchor`, with its id in `UserDefaults` keyed per scene id. **Re-place** clears the pin.
  - The scene is placed 2 m ahead with north pointing away.
  - Edit mode never moves the whole scene.
- **Picking:** a look-and-pinch on an item calls `EditSession.select`. The selected item gets the cyan box from the spike.
- **Gizmo** (`Gizmo.swift`): RealityKit entities on the selected item.
  - Move arrows (X, Y, Z), rotation rings and resize handles, in the Decentraland gizmo's colors (`packages/adapter-dcl/src/transform/gizmo.ts`).
  - Each handle has a collision shape at least 6 cm across, scaled with distance so it stays easy to hit 2–5 m away.
  - Pinch-dragging a handle drives `EditSession.update` under the current mode and lock. Pinch-dragging the item body also moves it freely in Move mode.
- **Edit bar** (`EditBarView.swift`): an ornament under the HUD window.
  - It reads **Move | Rotate | Resize**, then the selected name (or "Pinch an item to select it"), the lock, **Snap**, **Exact**, **Save**, **Revert** and **Done**, bound to `EditSession`.
  - **Exact** shows the Position (m), Rotation (degrees) and Scale fields with **Apply**.
  - "Pinch an item to select it" replaces Decentraland's "Click an item to select it". It's the one copy change the input forces.
- **Placing:** Assets → **Place** uses the head pose from `WorldTrackingProvider.queryDeviceAnchor`, converted to scene coordinates, with `Placement.placement`. The new item is then selected.
- Rendering uses `SceneRenderer.apply(plan, holding: session.editingKeys)` on every feed change.

- [ ] **Step 1:** Build for the simulator (Task 11's build command). Expected: `** BUILD SUCCEEDED **`.
- [ ] **Step 2:** Against the fixture server, take simulator screenshots of the placed scene, a selected item with its gizmo, and the edit bar. Save them to `apps/vision-pro/docs/`.
- [ ] **Step 3:** Run the Swift test command. Expected: PASS.
- [ ] **Step 4:** README: add the device checklist the owner runs, since the simulator has no world tracking:
  1. Pair.
  2. Pick a scene.
  3. Place it and pin it. Relaunch, and it comes back.
  4. Place a GLB from Assets. It lands 2 m ahead, facing you.
  5. Move, rotate and resize it with the gizmo, then Save.
  6. Check in Decentraland or Hyperfy that the item moved there too.
  7. While dragging, a second editor on the dashboard sees "being moved by".
  8. Revoke the headset on the dashboard. The app returns to pairing.
  9. Gizmo handles are easy to hit at 2–5 m.
- [ ] **Step 5:** Commit: `feat(vision-pro): put the scene down, pick, gizmo and edit bar`.

### Task 13: Finish

- [ ] **Step 1:** Run `node scripts/check-no-vlm.mjs` from the repo root. Expected: 0 hits.
- [ ] **Step 2:** Run the whole server suite, `cd apps/server && npx vitest run`, and the web suite, `cd apps/web && npx vitest run`. Expected: all PASS. Also run `npx tsc --noEmit -p .` in `apps/server` and `packages/shared`.
- [ ] **Step 3:** Run the Swift test command once more. Expected: PASS.
- [ ] **Step 4:** Commit any fixes.
