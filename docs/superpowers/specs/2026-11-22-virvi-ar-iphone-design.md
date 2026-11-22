# Virvi AR for iPhone, phase 1 (visitor mode): design

Status: approved by the owner, 2026-11-22, with the builder check's answers folded in. Linear: LIV-197, phase 1. Builds on
`2026-10-21-ar-spaces-design.md`, `2026-10-22-ring-marker-design.md` and
`2026-10-22-ar-builder-and-visitor-modes-design.md`. Calls marked **(call)** are mine and open to change.

## Intent

Virvi AR is one app on three platforms: Meta Quest, Apple Vision Pro and iPhone (owner, 2026-11-22). The
Quest app and the Vision Pro app exist. This builds the iPhone app's first phase: a visitor at a venue opens
Virvi AR, points the phone at the ring by the door, and the venue's Virvi scene appears life-size, lined up
with the room. No account, no key, no settings.

**Why:** phones are the front door to AR Spaces. Far more people carry an iPhone than a headset, and someone who
finds a scene at a venue may visit the same scene in Decentraland or Hyperfy from home.

## Goals

- **Look at a ring, and the space appears,** lined up with the room, within a few seconds, the same way it does
  on Quest.
- **No sign-in, no setup.** The app opens straight into looking for a ring.
- **Live.** Edits from any HUD show within about a second, through the same published-space feed the Quest uses.
- **One app.** The same name (Virvi AR), the same words on screen as the Quest's visitor mode where they fit a
  phone, and the same server routes.
- **Opened from a link.** `virvi.io/s/<code>` opens the space in the app when it's installed.

## Non-goals (this phase)

- Sign-in, BEAT claims and My BEATs (LIV-197 phase 2), Host mode (phase 3), builder mode (later).
- Saving alignment from the phone. Owners line spaces up with the Quest, as today: only the Quest app can save a ring's pose (the Vision Pro app can't read rings).
- iPad layout, Android, outdoor spaces, seeing other visitors.
- App Store Connect and TestFlight. This phase ends at builds the owner installs from Xcode (owner, 2026-11-22: neither Apple app has been uploaded, so bundle IDs stay reversible).

## Anti-goals (from the visitor-mode design)

- A visitor who doesn't know to look at the ring.
- A scene that lands visibly in the wrong place. A short wait is better than a wrong placement.
- Visitors seeing builder tools or half-finished edits.

## Decided

- **Option 1 (owner):** a separate iPhone app that shares a Swift package with the Vision Pro app.
- **Testing (owner):** the owner has an iPhone for on-device testing.
- **Server work is in scope (owner):** accept `ar-ios` as a platform, and serve Apple's link file; tested and deployed to production with the phase.
- **From the earlier designs:** the iPhone runs the same ring detector as the Quest, on ARKit's camera frames;
  the ring's heading comes from the wall behind it (ARKit plane detection); the scene is placed from the
  marker's saved pose, kept level by gravity.

## Approaches considered

1. **Shared Swift package + new iPhone app (picked by the owner).** Move the platform-neutral Swift code out of
   the Vision Pro app into a local Swift package used by both apps; add the ring detector there. Least
   disruption to the working Vision Pro app; one copy of the scene code.
2. **One Xcode project with iPhone and Vision Pro targets.** Tidier later, but restructures the Vision Pro app
   first. Not now.
3. **Grow the iPhone half of `apps/ar-spike`.** Rejected: the spike is throwaway (no ring reading, no visitor
   flow), and its scene code is an older copy of the Vision Pro app's.

## The design

### Code layout

- **`packages/virvi-ar-swift`** (new local Swift package, `VirviARKit`) **(call)**, for iOS 18 and visionOS 2:
  - `Scene/`: moved from `apps/vision-pro/Core/Scene` (Mapping, ScenePlan, SceneRenderer, SceneFeed, Showings,
    PlaylistPlayer, Floor, Colliders), with their tests. Anything visionOS-only stays in the Vision Pro app or
    sits behind `#if os(visionOS)`.
  - `Api/`: moved `HttpTransport` and the read parts of `VirviApi`, plus the AR routes the iPhone needs:
    `GET /api/ar/markers/by-code/:code` and the published feed `GET /api/ar/spaces/:id/feed`, with the wire
    shapes from `packages/shared/src/ar.ts` (as `apps/quest/.../api/ArModels.kt` reads them).
  - `Ring/` (new): a Swift port of the Quest's `RingCodec`, `RingDetector`, `RingPose` and `RingTracker`,
    checked against the same vectors and synthetic images in `apps/ring-marker` (`vectors/codec.json`,
    `vectors/layout.json`, and the test set `ringmarker/testset.py` renders).
  - `Space/` (new): the scene root from a marker's saved pose, ported from the Quest's `space/SpaceAlignment.kt`. Saved poses are in the Quest's frame (left-handed, Y up, +Z forward, Decentraland's); they're converted into RealityKit's right-handed frame with the same mapping `Scene/Mapping` already uses, and the visitor flow as a pure,
    tested state machine ported from `apps/quest/.../visitor/VisitorFlow.kt` and its helpers (ring lock,
    heading averager, unreadable and tracking-jump watches), with the Quest's tuning values.
- **`apps/vision-pro`** depends on the package instead of its own copies. Its behaviour doesn't change; its
  test suite must pass unchanged in meaning.
- **`apps/iphone`** (new, xcodegen like the others) **(call)**: the iPhone app. ARKit + RealityKit (`ARView`),
  SwiftUI overlay for the hint card and menu, the camera-frame pipeline, and the glue to the package.

### Identity

- **Display name:** Virvi AR. **Bundle id:** `io.virvi.ar`, the same as the Quest's package name **(call)**.
- **Team:** the owner's Apple team (`P22YGT64VU`), automatic signing. iOS 18 or later, iPhone only, ARKit
  required (`UIRequiredDeviceCapabilities: arkit`).
- Later, before the first upload, the Vision Pro app switches to the same bundle ID so the store shows one app on
  iPhone and Vision Pro. Not part of this phase; neither app has been uploaded (owner).

### What the visitor sees

1. **Opening:** the camera view with a hint card at the bottom: a drawing of a ring and "Look for a ring like
   this, at eye level near the entrance." No buttons in the way.
2. **Seeing a ring it can't read yet:** "Step closer to the ring" (too far or blurry), "Stand in front of the
   ring" (too steep), the Quest's rules.
3. **Reading a ring:** it looks the ring up, says "Opening <space name>…", then "Hold still…" while it settles
   the ring's position and the wall's heading.
4. **Locked:** the scene fades in (400 ms) placed from the ring's saved pose, with a brief cyan outline on the
   ring. Images, videos (with sound from the start; owner, 2026-11-22: the tap rule was a web autoplay rule a native app doesn't have), 3D models, sounds, live
   streams and scheduled showings play. Edits arrive live.
5. **Walking around:** ARKit world tracking keeps the scene in place. Seeing any of the space's rings again
   re-anchors it. A tracking jump (ARKit's tracking state goes limited, or the pose jumps) hides the scene until a
   ring is seen again.
6. **Menu (a small button):** Look at the ring again; Hide behind people and things (on phones with LiDAR:
   ARKit scene depth and people occlusion; hidden on phones without it) **(call)**; Report this space (the
   Quest's report flow); Close.
7. **Problems,** in the Quest's words where they fit: "This space isn't set up yet", "This space isn't open
   right now.", "Can't reach Virvi. Check the phone's connection.", camera permission denied (with a button to
   Settings).

### Lining up

- **Ring position:** the detector's ellipse gives the ring's centre in the image and its size; with the
  camera's intrinsics from `ARFrame.camera` and the ring's printed diameter from the marker record, that gives
  the distance and the 3D position in ARKit's world, using the frame's own camera transform (no lag, unlike the
  Quest).
- **Heading:** a raycast from the ring's centre onto ARKit's vertical planes gives the wall it's on; the ring
  faces straight out of that wall. The Quest's agreement checks apply: the wall must agree with the ring's own
  tilt within 20°, the view must be within 30° of head-on.
- **Steady:** the scene appears only once the ring is within 1.5 m and its averaged position and heading hold
  still (the Quest's thresholds), so a visitor never sees a wrong placement flash up.
- **Level:** gravity, never the ring's tilt.

### Opening from a link

- Associated Domains `applinks:virvi.io`, and `/.well-known/apple-app-site-association` served by `apps/server`
  for `/s/*`, built from config like the existing Android `/.well-known/assetlinks.json` route (the owner's team ID
  plus `io.virvi.ar`).
- A link opens the app on that space: it loads the space and says "Look at the ring when you get there" until a
  ring of that space is seen. A ring of a different space wins.

### Server changes

- `apps/server/src/ar/analytics.ts`: add `'ar-ios'` to `AR_ANALYTICS_PLATFORMS`, so the iPhone's visit analytics and
  Report (`POST /api/ar/spaces/:id/report`) are accepted, labelled as iPhone.
- The `apple-app-site-association` route above.
- Tests for both; deployed to production with the phase.

### Analytics and privacy

- The same anonymous visit analytics the Quest sends (`apps/quest/.../api/VisitAnalytics.kt`), with platform
  `ar-ios`, nothing more. No
  account, no device identifiers beyond what the Quest sends. Camera frames never leave the phone.
- Privacy wording in the app's Info.plist: camera use only to find rings and place the scene.

## Testing

- **Package (Swift tests, iOS simulator):**
  - Ring codec and detector against `apps/ring-marker`'s vectors and synthetic images: the same IDs and poses
    the Python reference and the Kotlin port get.
  - Ring pose maths (intrinsics, distance, heading agreement) with fixed numbers.
  - The visitor flow state machine: every state and message in "What the visitor sees", re-anchoring, jumps,
    link opening, the failure messages.
  - The moved scene code's existing tests, now in the package.
- **Vision Pro app:** its full test suite still passes after it switches to the package.
- **iPhone app:** builds for device and simulator; UI starts in the simulator (no ARKit there).
- **On the owner's iPhone (manual):** a printed ring on a wall: opens within a few seconds at 0.6–1.5 m;
  "Step closer" further away; walk around; leave and come back; a second ring re-anchors; a `virvi.io/s/<code>`
  link opens the app.

## Risks

- **Detector speed on a phone.** The Quest detector runs on 1280×960 frames. On iPhone it runs on a downscaled
  copy of `capturedImage` off the main thread, a few times a second, not every frame. If it's slow, use a
  smaller frame or Accelerate/vImage for the heavy steps.
- **Vertical planes take time to appear** on a plain wall. While there's no wall yet, the app says "Hold
  still…" for up to 3 s, then "Stand in front of the ring" (the Quest's no-wall rule).
- **Moving shared code** could break the Vision Pro app. Its tests run after the move, before anything else.

## Left to the builder

- Exact SwiftUI layout of the hint card and menu (match the Quest's look and words).
- How often the detector runs, within the risk note above.
- Internal type names.
