# Virvi AR for Meta Quest

The Quest app (`io.virvi.ar`), promoted from the spike that lived in `apps/quest-spike` (sibling of `apps/ar-spike`, iPhone and Vision Pro). It shows a Virvi space life-size in passthrough on a **Meta Quest 3 or 3S**, placed from the ring marker the visitor looks at. Debug builds also run the marker detection-range test. Built with Meta's [Spatial SDK](https://developers.meta.com/horizon/documentation/spatial-sdk/spatial-sdk-explainer) (Kotlin, Android, no Unity).

What it does:

- **Visitor mode.** A hint card (1 m ahead, a little below the eyes, following the head lazily) shows a drawing of a ring and says "Look for a ring like this, at eye level near the entrance." A ring seen but not readable turns it into "Step closer to the ring". A readable ring is looked up (`GET /api/ar/markers/by-code/:code`), the space's feed is long-polled (`GET /api/ar/spaces/:id/feed`), and once the ring is within 1.5 m and its averaged position and wall heading hold still, the scene fades in (400 ms) placed from the ring's saved pose, with a cyan outline flashing on the ring. While it waits the card says "Hold still…" only while one of the space's rings is actually being gathered; with none in view (after a tracking jump, the headset back on, or a space opened from a link before arriving) it shows the standard hint, and a ring too far away or unreadable says "Step closer to the ring". The wall heading must agree with the ring's own tilt (within 20°), so near a corner or a door frame the perpendicular wall isn't taken; when two walls facing different ways agree about as well (within 15° of each other, as at an inside corner seen at about 45°) there is no heading until the visitor moves. A heading counts only within 30° of head-on, by both the wall it picks and the ring's own tilt, so a perpendicular wall can't stand in for an unscanned one; a steeper view says "Stand in front of the ring". Any other ring of the same space re-anchors it, and so does a newer snapshot that moves the saved pose of the ring the scene was placed from (if that ring isn't steady in view, or its printed size changed, the scene hides until it locks again); a tracking jump (the head moving faster than 2.5 m/s or turning faster than 300°/s) hides it until a ring is seen again. Taking the headset off ends the visit (back to the hint card, nothing loaded). The code is in `visitor/`: `VisitorFlow` (the state machine), `VisitorController` (the glue to the headset), `HintCard`, `VisitorMenu`, `RingOutline`; the space itself (feed, scene, ring locks, outline, placement), which builder mode will share, is `space/SpaceSession`.
- **Menu:** the left controller's menu button at any time, or the small "⋯" button below the hint card's place whenever a space is up (shown, locking, not set up, or failed after its lookup; not on the plain hint card). **Look at the ring again**, occlusion (**Hide behind walls** / **Live depth** / **Off**), **Spaces** and **Builder** (builder mode, below). While builder mode is on, or whenever the headset is paired, the menu also has the owner's **Keep the scene loaded between visitors** switch (`AppPrefs.keepLoadedBetweenVisitors`) and **Sign out**. Debug builds add **Developer**: the old control panel, with the feed status, occlusion and the marker readings.
- **Builder mode** (`builder/BuilderController`, the counterpart of `VisitorController`). The menu's **Builder** pairs a signed-out headset first (the pairing panel: the code, a QR of the approval page, **Cancel**), then finds the space: the one whose ring is in view (its code matched against `POST /api/ar/devices/:id/spaces`), otherwise a pick list of the account's spaces. Entering pauses visitor mode and follows the space's feed on the same space session with the space's AR pass (re-asked for every 30 s, so a pass about to run out is minted again). The scene is placed from a steady ring with a saved pose; a ring on a floor with no saved pose opens the **Align** panel first (sticks nudge the scene, one step every 100 ms while held; **Save alignment**, then **Done**). Then the HUD (banner, booking and several-places warnings, Layout and Assets, Save / Revert / Done), the pointer, gizmo and carries, and a ring panel for the floor's other rings (check, **Record** / **Re-record**). Builder mode doesn't re-anchor from other rings, so the ring check measures them against where the scene was placed. Taking the headset off hides the scene; back on, it is placed afresh from a ring, with the drafts kept (a personal headset off for over 10 minutes drops them; a shared one off for over 2 minutes signs out, back at the hint card with nothing loaded, even while still off). **Done** returns to visitor mode with a published space still shown, as a visit, following its published feed as a visitor would; an unpublished one goes back to the hint card with nothing loaded. **Sign out** and a headset revoked on the website return to the hint card with nothing loaded; a revoked headset is asked to pair again straight away. **A shared headset signs out whenever builder mode closes**, for any reason (Done, Cancel, a refused pass, the space gone, the headset off), and a shared pairing never outlives the app: one restored at startup is ended at once. A space link (or the Spaces list) while building says "Finish building first (Done) to open another space".
- **Server:** always `https://virvi.io` in release builds. Debug builds take a `baseUrl` intent extra and remember it.
- **Images** are unlit, double-sided textured quads. **Videos** are video panels (ExoPlayer, muted, mp4 and HLS). **Models** load straight from their URL; only `.glb` works, anything else shows a pink box. **Sounds** aren't played yet.
- **Hide behind real things:** a menu choice. **Walls** draws the room scan's wall faces and ceiling (MRUK `AnchorProceduralMesh`) with the hole-punch material (`AlphaMode.HOLE_PUNCH`, `HOLE_PUNCH_SHADER`; `SceneMaterial.passthrough()` showed the room but didn't hide what was behind it), so they show the real room and hide anything virtual behind them. **Live depth** turns on Spatial SDK's environment depth occlusion (`EnvironmentDepthMode.OCCLUSION`), which also hides behind furniture and people; it's the default, and looked better on the headset. The choice is remembered. **Show scanned walls** tints the same surfaces, to check the room scan against the real walls.
- **Marker test:** Virvi's ring markers (`../ring-marker`) are found in the left passthrough camera's frames (Camera2, 1280 × 960, Horizon OS v74+). The distance comes from the ring's size in the image, the position from that and the head pose, and the heading from the scanned wall the marker is on. The panel shows, per test marker, where tracking started ("found at"), where it stopped, the current distance, the position and the wall heading.

Code:

- `ScenePlan.kt` ports `packages/hyperfy-app/src/plan.ts` (via the Swift spike). `Mapping.kt` is the transform. Spatial SDK is left-handed, Y up, +Z forward, the same frame as Decentraland, so positions and scales carry over unchanged and rotations are Decentraland's Euler degrees in YXZ order. `MappingTest` checks that Spatial SDK's own `Quaternion` agrees.
- `api/` (`ArApi`, `ArFeed`), `space/SpaceAlignment.kt` (scene root from a ring's saved pose), `SceneRenderer.kt`, `MainActivity.kt` (lifecycle, camera, room scan, panels), `AppPrefs.kt`, `ControlPanel.kt` (the Developer panel), `MarkerReadings.kt`.
- `ring/`: `RingCodec.kt` and `RingDetector.kt` port `../ring-marker/ringmarker/codec.py` and `detect.py`, and their tests run against that folder's vectors and synthetic test set. `RingTracker.kt` trusts an ID after 3 frames in a row. `PassthroughCamera.kt` is the camera. `RingPose.kt` turns a detection into a position and finds the wall heading.

Shortcuts and open questions:

- **Model facing is unverified.** Decentraland shows a glTF x-mirrored; RealityKit and three.js needed a half turn about Y to match. Spatial SDK converts glTFs to its own frame, and its docs don't say how. The **Turn models half a turn** switch (on by default) flips between the two. Compare a model with an obvious front against the same scene in Decentraland and keep whichever matches.
- **Image facing is also unverified.** Images are double-sided, so they always show, but one side may read mirrored. Check text on an image from the front.
- **The lens pose** is read as Android defines it, relative to the head pose Spatial SDK reports. On a Quest 3 (2026-10-22) `LENS_POSE_REFERENCE` is `GYROSCOPE`, and the 1.0 m distance and Align checks passed with it as is.
- The camera's intrinsics are scaled from the sensor's pre-correction active array to the 1280 × 960 stream (centre crop, then scale, as in Meta's passthrough samples). On a Quest 3 the array is 1280 × 1280 and fx = fy = 866.9 px, so the stream is the middle 960 rows at unchanged scale. The synthetic test set (`ringmarker/testset.py`, `FOCAL_PX`) is rendered at fx = 867 px to match, and writes it to `manifest.json` as `focal_px`, which the Kotlin tests read.
- The room scan sometimes fails to load right after the headset wakes, while tracking recovers (`ERROR_UNKNOWN`, sometimes `ERROR_NO_ROOMS_FOUND`). The app retries it 5 times, 3 s apart, and again each time it comes back to the foreground without one.
- The marker's world position uses the head pose at the tick after the frame, not at the frame's capture time, so it lags while you move your head. Averaging over 15 frames smooths noise but not lag, which is why the scene waits for the ring to hold still.
- Clicks and sounds aren't implemented. Videos pause while the scene is hidden or the app is in the background.

### New visitor copy (the owner may reword)

Added in the whole-branch review fixes, so a visitor is never left without an instruction. They show on the hint card, and on the space page when it is open. The camera, spatial data and room scan lines take precedence over everything but a shown scene.

- Room scan missing, or failed to load after its retries: "Set up your space on this headset first: Settings → Physical space → Space setup."
- Camera permission denied: "Virvi AR needs camera access to find rings. Allow it in Settings → Apps → Virvi AR."
- Spatial data permission denied (the room scan can't be read): "Virvi AR needs spatial data access to line spaces up with the room. Allow it in Settings → Apps → Virvi AR."
- A ring that holds still with its wall found, but seen more than 30° from head-on (one ring's outline can't tell its own wall from a perpendicular one that steeply): "Stand in front of the ring"
- A ring that holds still but has had no wall heading for over 3 s (the scan missed its wall, or the wall disagrees with the ring's tilt): "Can't see the wall behind this ring. Look around the room so the headset can map it."

### New builder copy (the owner may reword)

The align panel's refusals (`AlignCopy` in `builder/Alignment.kt`). "Step closer to the ring to save" and "This account can't edit this scene" are the plan's copy.

- Save failed because the headset is offline: "Can't reach virvi.io: check the connection and save again"
- Save failed for any other reason: "Couldn't save the alignment: try again"

Builder mode's own panels (`BuilderCopy` in `builder/BuilderController.kt`) and the menu:

- While the spaces load: "Finding your spaces…"; the pick list: "Choose a space to build"; none: "This account has no spaces to build on yet"
- Offline: "Can't reach virvi.io: check the connection and try again"; any other failure: "Couldn't load your spaces: try again"; the space's pass refused for another reason: "Couldn't open this space for building: try again"
- Pairing ended without an approval (code expired or refused): "Pairing didn't finish: tap Builder to try again"
- These notices, and "This account can't edit this scene" when the space's pass is refused, show on the builder panel with a **Close** button
- Waiting to place the scene: "Look at a ring of <space>"; a ring with no saved pose on a floor that already has one: "Look at a ring that is already lined up on this floor"
- A space link while building: "Finish building first (Done) to open another space"
- The menu's owner items: "Keep the scene loaded between visitors" and "Sign out" (the brief's names)

**Scan this room** (`RoomScanCopy` in `roomscan/RoomScanApi.kt`). "Room scans need a personal headset. This one is shared." is the plan's copy.

- No rooms set up: "No rooms are set up on this headset yet", with **Set up my space**
- Uploading: "Uploading…"; done: "Uploaded “<name>”: pick it on virvi.io to build a set from it"
- Refused as empty: "This scan has no rooms: set up your space and try again"; as unreadable: "This room scan couldn't be read: set up your space again and retry"
- Offline: "Can't reach virvi.io: check the connection and try again"; signed out meanwhile: "This headset was signed out: pair it again to upload"; anything else: "Couldn't upload the scan: try again"

## Build

Needs JDK 17 and the Android SDK (API 34). On this Mac they're installed with Homebrew:

```sh
brew install openjdk@17
brew install --cask android-commandlinetools android-platform-tools
sdkmanager --sdk_root=$HOME/Library/Android/sdk "platforms;android-34" "build-tools;34.0.0"
```

Then:

```sh
cd apps/quest
export JAVA_HOME=/opt/homebrew/opt/openjdk@17 ANDROID_HOME=$HOME/Library/Android/sdk
echo "sdk.dir=$ANDROID_HOME" > local.properties   # once
./gradlew :app:testDebugUnitTest    # unit tests (no headset needed)
./gradlew :app:assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
```

## Run it on your Quest

1. **Developer mode (once).** Developer mode needs a Meta developer account, which is free:
   1. Sign up at [developers.meta.com/horizon](https://developers.meta.com/horizon/) and create an organisation. Any name works.
   2. On your phone, open the **Meta Horizon** app, then **Devices** → your headset → **Headset settings** → **Developer mode**, and turn it on.
   3. Restart the headset.
2. **Connect.** Plug the headset into the Mac with a USB-C cable that carries data. In the headset, accept **Allow USB debugging** and tick "Always allow". Then run `adb devices`: the headset should be listed as `device`.
3. **Install and start:**
   ```sh
   adb install -r app/build/outputs/apk/debug/app-debug.apk
   adb shell am start -n io.virvi.ar/.MainActivity
   ```
   The app is also listed in the headset's library under **Unknown sources**, as "Virvi AR". If the old spike (`io.virvi.ar.quest`) is still installed, remove it with `adb uninstall io.virvi.ar.quest`.
4. On first launch, allow the **camera** (marker detection) and **spatial data** (the room's walls, for heading). Heading also needs a room scan: if the panel says "No room scan", set up your space in the Quest settings (**Physical space** → **Space setup**) and restart the app.
5. **Look at a ring** of a published, aligned space. A debug build can point at another server (saved for next launches; pass `https://virvi.io` to go back):
   ```sh
   adb shell am start -n io.virvi.ar/.MainActivity --es baseUrl http://192.168.1.20:3000
   ```
6. Point the controller at a panel and pull the trigger to press buttons. The Developer panel can be grabbed and moved.

Logs: `adb logcat -s VirviAR`.

## Ring marker test

Print the test markers from `../ring-marker` (see its README: print at actual size, check the 100 mm bar, matte filament). There are three sizes: `RING120`, `RING140` and `RING170`. Only these IDs count, and only after 3 frames in a row agree.

In a debug build, the Developer panel (menu → **Developer**) shows, per marker:

- **found at / lost at:** the distance when tracking started and stopped. **Reset readings** clears them.
- **tracking at:** the current distance from the camera, from the ring's size in the image (`fx × radius / semi-major axis`).
- **at (x, y, z) m ±N cm over K:** the marker's world position, averaged over its last 15 camera frames, and the spread (the largest distance of one frame's position from that mean). It clears when the marker is lost.
- **wall faces …° / no wall:** the heading of the scanned wall within 10 cm of the marker, or "no wall".

Logs worth checking (`adb logcat -s VirviAR`): the camera's raw and scaled intrinsics, the lens pose and its reference, the room scan's wall count, tracking jumps.

### Headset check

1. Tape `RING140` at 1.5 m on a wall.
2. Stand 1.0 m away, measured with a tape measure. The panel's distance should read 1.00 ± 0.02 m. If it's off by a constant factor, the lens pose or fx is wrong: check the logged values.
3. The panel's wall heading should be perpendicular to the wall within 1°. Check it against a floor tile line or a tape line on the floor.

### Range test

For each size, walk back from the marker head-on, at 30° and at 45° off its face. Record "found at" (walking in) and "lost at" (walking out). The targets are found from 0.6–1.8 m, up to 45° off the face, with heading within 1° and position within 2 cm at 1.8 m.

The table is filled in from the range test on the headset; it hasn't been run yet.

| Marker | Angle | Found at | Lost at |
|---|---|---|---|
| `RING120` (120 mm) | 0° | — | — |
| `RING120` (120 mm) | 30° | — | — |
| `RING120` (120 mm) | 45° | — | — |
| `RING140` (140 mm) | 0° | — | — |
| `RING140` (140 mm) | 30° | — | — |
| `RING140` (140 mm) | 45° | — | — |
| `RING170` (170 mm) | 0° | — | — |
| `RING170` (170 mm) | 30° | — | — |
| `RING170` (170 mm) | 45° | — | — |

Headset check on a Quest 3, 2026-10-22: `RING140` (paper) was tracked within seconds; the distance at 1.0 m and the heading after **Align to the marker** looked right by eye (not yet measured to ±2 cm and 1°). **Walls** and **Live depth** both hid scene content behind real surfaces.

## Owner checks (visitor mode)

Not yet run (no headset was connected when visitor mode was built). Record the results here and in the plan's ledger.

Prepare a published test space with plan 1's dashboard, or with a direct API call on a local or staging server (never the shared dev database `virvi`): one floor, `RING140`, and an alignment set with a temporary admin call or by hand-entering a pose that matches the room. Tape `RING140` at eye level on a scanned wall. For a local server, start the app with `--es baseUrl http://<mac's address>:<port>` (debug build).

- [ ] Opening the app shows only the hint card.
- [ ] Far away (about 3 m), the hint changes to "Step closer to the ring". (The unreadable band is narrow, so it may read the ring instead: then "Opening …" and "Step closer to the ring" while it's beyond 1.5 m.)
- [ ] At about 1 m, "Hold still…", then the scene fades in with the outline flashing on the ring.
- [ ] Live depth hides the scene behind a hand and furniture.
- [ ] Taking the headset off and on hides the scene; looking at the ring shows it again.
- [ ] Menu → **Look at the ring again** clears it and returns to the hint.
- [ ] Open a space from a link. A verified link from the browser needs plan 3's `assetlinks.json` with the release key's fingerprint, so until then use the intent: `adb shell am start -a android.intent.action.VIEW -d "https://virvi.io/s/<code>"`. The app opens on the space page: the space's name, where to find it, "Look at the ring when you get there" and **Close**. Looking at that space's ring then shows the scene. Sent while the app is already open, it replaces the current space.
- [ ] Menu → **Spaces** lists the spaces opened or visited, newest first; picking one opens its page.
- [ ] Analytics: after a visit (scene shown, walk around for 30 s, take the headset off), the space's analytics on plan 1's dashboard show one visit on platform `ar-quest` with a path of positions in scene coordinates. A tracking-jump re-show within the visit does not count a second visit; looking at the ring again afterwards, or putting the headset back on, does. Nothing identifying the device is sent.

Also worth noting while there:

- Whether the left controller's menu button opens the menu (Horizon OS may keep it for itself; the "⋯" button works while the scene is shown).
- Whether images and videos visibly fade, or snap (the fade sets material alpha at runtime; if the unlit shader ignores it they snap at the end of the fade).
- Whether opening the Quest's system menu pauses the app (it would end the visit, as taking the headset off does). If it does, the headset-off trigger moves from `onPause` to an XR session state or the proximity sensor.
- A ring on a wall the room scan missed never locks: heading comes from the wall. After 3 s of holding still the card says "Can't see the wall behind this ring…".
- A ring 5 cm from an inside corner, seen at about 30°, places the scene square to its own wall, not turned 90°.
- First launch from a link: the permission dialog doesn't drop the space; its page is still up after allowing.

## Builder checks

Research for builder mode (plan 3, Task 1). **No headset was connected, so every finding is "from docs/samples, unverified on device".** Sources: the SDK 0.14.0 jars in the Gradle cache (`javap`), Meta's Spatial SDK docs, and `meta-quest/Meta-Spatial-SDK-Samples` (commit f233e23). The on-device list at the end is for the owner.

### (a) Pinch on a mesh with a hit point (unverified on device)

- ISDK is registered by `VRFeature` ([supporting systems](https://developers.meta.com/horizon/documentation/spatial-sdk/spatial-sdk-isdk-supporting-systems/)), so nothing to add. Get the system with `systemManager.findSystem<IsdkSystem>()`.
- `IsdkSystem.registerObserver((PointerEvent) -> Unit)` sees every pointer event; `registerInteractableObserver(entity, (PointerEvent) -> Unit)` returns an `IsdkSystem.InteractableObserverHandle` for one entity, and `unregisterInteractableObserver(handle)` / `unregisterObserver(fn)` remove them. The sample `AnimationsSample/.../DroneSceneController.kt` uses `registerObserver` (a per-SceneObject listener is lost when the SceneObject is recreated, e.g. on a material change).
- `PointerEvent` (0.14.0 jar): `source: Entity` (the hand or controller entity), `type: Int` (compare with `PointerEventType.X.id`), `hitInfo: HitInfo`, `scrollInfo: Vector2`, `semanticType: Int` (compare with `SemanticType.Select.id` / `SemanticType.Grab.id`), `pointerType: Int`, `eventId: Int`.
- `PointerEventType`: `Hover, Unhover, Select, Unselect, Move, Cancel`. `SemanticType`: `Unknown, None, Select, Grab, Scroll`.
- `HitInfo`: `entity: Entity`, `sceneObjectHandle: Long`, `nodeId: Int`, `meshElementId: Int`, `distance: Float`, `point: Vector3`, `normal: Vector3`, `textureCoordinate: Vector2`. So a pinch (or trigger) on a mesh gives the world hit point and normal.
- Which hand: `isdkSystem.getHandForPointerEvent(event): Hand` (`Hand.LEFT` / `RIGHT`); `getInteractionEventSourceBehavior(event)` says ray vs poke vs collider (`FAR_FIELD_HOVER_SIGNAL_ACTUATE`, `COLLIDER_HOVER_CONTACT_ACTUATE`, ...).
- The target needs a collider or mesh the ISDK can hit. Docs: use Spatial SDK colliders (Box/RoundedBox/Quad/Plane map to `IsdkBoxCollider`, Sphere to `IsdkSphereCollider`; these allow ray and touch interaction; Mesh allows ray only) ([grabbable doc](https://developers.meta.com/horizon/documentation/spatial-sdk/spatial-sdk-isdk-grabbable/)). Whether a plain toolkit `Hittable` mesh (no `Grabbable`) produces ISDK `Select` events with a hit point is not stated in the docs. Unverified.
- Legacy path, still in the jar: `InputListener` on a `SceneObject` (`onClick(SceneObject, HitInfo, Entity)`, `onClickDown`, `onHoverStart/Stop`, `onDragMove`, `onPointerEvent(SceneObject, HitInfo, type, sourceOfInput: Entity, scrollInfo: Vector2, semanticType)`), and `Hittable(MeshCollision)`. Docs mark the old `GrabbableSystem` deprecated in favour of `IsdkSystem`.

### (b) Hand grab carrying an entity, and release (unverified on device)

- The simple route: add toolkit `Grabbable(enabled, type: GrabbableType (FACE | PIVOT_Y), isGrabbed, minHeight, maxHeight)` plus a collider or mesh. Docs: `IsdkToolkitBridgeSystem` turns that into ISDK grabbing, so hands and controllers can both grab it (hands by pinch or palm, ray or touch). The app's Developer panel already uses `Grabbable()` this way.
- Finer control: use `IsdkGrabbable(enabled = true, grabState: IsdkGrabState, movementType: IsdkGrabMovementType (Direct | Billboard | AxialBillboard | None), responsiveness: Float, billboardOrientation: Vector3)` in place of `Grabbable`. Optional `IsdkGrabConstraints(lockFlags, scaleMinMax, verticalMinMax, depthMinMax, lateralMinMax, maxGrabbers)` and `IsdkGrabFilter(handContactPinch, handDistancePinch, handContactPalm, handDistancePalm)` choose which hand gestures can grab.
- Observing grab and release: `IsdkGrabbable.grabState` is `IsdkGrabState.NotGrabbed | Grabbed` (read it by `entity.getComponent<IsdkGrabbable>()`), and the grab arrives as pointer events with `semanticType == SemanticType.Grab.id`: `PointerEventType.Select` at grab start, `Unselect` at release. Sample `Object3DSampleIsdk` counts Selects/Unselects per entity because two hands can hold one object (release is the last `Unselect`). Toolkit `Grabbable.isGrabbed` is a plain boolean attribute and only reflects the old system.
- Position on release: read the entity's `Transform` in the `Unselect` handler. Unverified on device: that the transform is final by then, and how `Cancel` arises (treat it like release).
- Not stated in the docs: whether an `IsdkGrabbable` entity under a parent (the scene root from `SpaceSession`) keeps parent-relative placement. Builder tasks must convert world to scene-local on release.

### (c) Wrist and palm pose (unverified on device)

- `AvatarBody(root, head, leftHand, rightHand, isPlayerControlled)` (toolkit component) holds entities for head and hands; their `Transform` is the controller or hand pose. Entity transform is in the app's reference space.
- `Scene.getControllerPoseAtTime(isLeft: Boolean, time: Long): ControllerPose` (`pose: Pose`, `flags: Int`; check `ControllerPose.ValidBits` / `TrackedBits` before using it). Whether it returns the hand wrist when the user has no controller is not documented.
- `Scene.setBodyTrackingJointSet(JointSet.DEFAULT | FULL_BODY)` and `Scene.updateBodyTrackingBuffersAtTime(List<ControllerPose>, List<SkeletonJoint>, time)` fill joints; `JointType` has `LEFT_HAND_WRIST`, `LEFT_HAND_PALM`, `LEFT_HAND_WRIST_TWIST` (and right, and every finger joint). `SkeletonJoint(jointIndex, parentJointIndex, pose)`. No sample in the samples repo reads wrist or palm joints, so the exact use is a guess.
- The head pose is `Scene.getViewerPose()`.
- Manifest: the app already declares `oculus.software.handtracking` (not required), `com.oculus.permission.HAND_TRACKING` and `handtracking.version V2.0`.

### Controller input (from the jar, unverified on device)

- `Controller` component (one per hand, `ControllerType.CONTROLLER | HAND | EYES`): `buttonState`, `changedButtons`, `isActive`, `laserEnabled`, `directTouchEnabled`, `isDown(bits)`, `isPressed(bits)`, `isReleased(bits)`.
- `ButtonBits`: `ButtonA/B/X/Y`, `ButtonTriggerL/R`, `ButtonSqueezeL/R`, `ButtonThumbL*/R*`, `ButtonMenu`, `ButtonSystem`, plus click, touch and mask sets. `ControllerButton` is the enum form.

### Notifications by place (Step 2)

Building notifications is out of this plan; this is the finding for the owner.

- Horizon OS supports **event-based user notifications** that the app's own server triggers: create the notification in the Meta Horizon Developer Dashboard, submit for review, then POST to the Graph API at `https://graph.oculus.com` with the request ID and recipient IDs. Social-category notifications need a user token; other categories use app credentials. Mobile notifications reach the **Meta Horizon mobile app** as push notifications and in its feed; on the headset they appear in the notification feed only, not as a push. [Event-based user notifications](https://developers.meta.com/horizon/documentation/spatial-sdk/ps-user-notifications-event/), [create](https://developers.meta.com/vr/documentation/native/ps-user-notifications-create), [push register](https://developers.meta.com/horizon/reference/platform/v77/function_o_v_r_requests_push_notification_8h_ovr_push_notification_register/).
- Single-send audiences are users who own the app or follow an organization profile.
- **No proximity, Wi-Fi, Bluetooth or location trigger** is documented. The trigger is always an event in our own code. A "you are near a space" notice would have to be our server deciding from something the app reports, and the app has to be running to report it.
- No rate limits were found on the page. Not verified.

### Rulings (Step 3)

| Finding | Ruling |
| --- | --- |
| (a) Pinch/trigger select with a hit point | Documented and in the 0.14.0 jar. Tasks 7 and 8 read `PointerEvent.hitInfo.point` from `IsdkSystem.registerObserver`. Unverified on device. |
| (b) Hand grab and release | Documented route exists (`Grabbable` via bridge, `IsdkGrabbable`, `Grab` semantic Select/Unselect). Not clearly usable: the docs never say how release and parent-relative placement behave for hands, and no sample uses it for placement. **Baseline applies:** controllers use the toolkit `Grabbable` plus ray hits; hands use the system pointer pinch (`SemanticType.Select`) only. Re-open if the owner's on-device checks below pass. |
| (c) Wrist/palm pose | Joints exist (`JointType.LEFT_HAND_WRIST`, `LEFT_HAND_PALM`) but no sample or doc shows reading them. **Keep plan 2's "⋯" button where it is**; do not move it to the left wrist until the owner check passes. |
| Notifications | Only developer-triggered event notifications to the headset feed and Horizon mobile app. No place triggers. Out of scope. |

### Builder input checks (owner, on device)

Do these on the Quest 3 with a debug build when convenient. Each says what result changes the ruling.

1. **Pinch on a mesh.** With hands, pinch an image or model in a placed space. Does a `registerObserver` callback log `Select` with `semanticType == Select` and a `hitInfo.point` on the surface? Same with the controller trigger. If yes, (a) is confirmed.
2. **Hand grab.** Add `Grabbable()` (or `IsdkGrabbable()`) to a test entity with a Box collider. Grab it with a pinch, then with a palm grab, and release. Does it follow the hand? Does `Unselect` with `Grab` semantic arrive once at release (and `Cancel` if tracking is lost)? Is the final `Transform` correct, also when the entity is a child of the scene root? If all yes, Tasks 7 and 8 can use ISDK for hands too.
3. **Wrist pose.** Log `scene.getControllerPoseAtTime(true, time)` with hands only and with a controller, and `JointType.LEFT_HAND_WRIST` after `setBodyTrackingJointSet(JointSet.DEFAULT)`. Is `pose` valid and tracked, and does it follow the wrist? If yes, "⋯" can move to the left wrist.
4. **Mesh without a grabbable.** Does a plain entity with a mesh (no `Grabbable`) produce `Select` events with hit points, or does it need a collider component?

### Setting up rings (builders)

- Tape rings flat on a wall the headset has scanned. A sign standing in front of a wall, turned 25–60° from it, can line up wrong.
- The printed-size check covers prints from 75% to 125% of the recorded size.
- Record a floor's other rings within 4 m of the ring the scene was last anchored from; further away, align from that ring instead.

### Owner checks (alignment, plan 3 Task 5)

Not yet run (no headset was connected). Reach the align panel from the menu's **Builder** (see the full run below). Use a test space on a local or staging server, with a floor whose ring has no saved pose.

- [ ] Look at the ring from under 1.5 m: the scene appears with the ring at the middle of its north wall, facing into the scene.
- [ ] Left stick moves the scene, right stick turns it, about the ring (the ring stays put as the scene turns); with the grip held, steps are 1 cm and 0.5°. (Without the grip they are 5 cm and 2.5°: confirm that feels right.)
- [ ] **Save alignment** from over 1.5 m is refused with "Step closer to the ring to save"; from under it saves.
- [ ] Reload as a visitor and look at the same ring: the scene lines up with where it was aligned.
- [ ] A floor whose recorded height doesn't match the ring's height above the real floor shows "Floor height doesn't match <floor> (<h> m): check the floor".
- [ ] A ring printed at 92% (or any size off by over 3%) says "This ring looks about 8% smaller than its recorded size: was it printed at 100%?"; one at 100% says nothing. Check the depth range against a tape measure from the headset to the wall.

### Owner checks (record, check and re-record rings, plan 3 Task 6)

Not yet run (no headset was connected). The ring panel shows while building whenever a ring of the floor is steady in view. Use a floor that has been aligned from its first ring, with a second printed ring on the same floor that has no saved pose.

- [ ] Look at the second ring from under 4 m of the first: **Record this ring** shows. Press it: "Ring saved".
- [ ] Look at the second ring again: "This ring is <d> cm and <a>° from where it should be" reads a few cm and under 1°, and no **Re-record this ring** button shows.
- [ ] Look at the second ring from the first: the check line reads the same few cm.
- [ ] Move the printed ring 6 cm (or turn it over 1°): the line shows as a warning with **Re-record this ring**. Press it: only that ring's pose changes.
- [ ] A ring with no pose more than 4 m (straight line) from the last anchor shows "Too far from the last ring to record accurately: walk back, or align from this ring instead" and no Record button.
- [ ] A floor with a single ring shows "Add a second ring on this floor so visitors stay lined up".

### Owner checks (builder HUD, picking and the transform bar, plan 3 Task 7)

Not yet run (no headset was connected). The HUD (`R.id.builder_hud`, `BuilderHud`), `Picking`, `Gizmo`, `PickOutline` and `BuilderEditor` are wired into builder mode (`BuilderController`, `HeadsetBuilderTools`). The transform math is a port of `packages/core/src/transform/session.ts` and its tests; what follows is what only the headset can show.

Unverified from the 0.14.0 jars and docs (confirmed there: `SemanticType.X.id` and `PointerEventType.X.id` are `getId()`, so `.id` is right; `IsdkSystem.registerObserver`, `PointerEvent.source / hitInfo.entity`, `Pose.forward()`, `ButtonBits.ButtonSqueezeL/R`):

- [ ] **Picking an item.** In builder mode, items' meshes are `Mesh(hittable = LineTest)` (visitors keep `NoCollision`). Point the controller at an image and a model and pull the trigger, then pinch with a hand: the item is outlined in yellow and the bar shows. If no `Select` arrives, the mesh needs a collider (README check 4 above); videos (panels) and sounds may only be pickable from the Layout list.
- [ ] **The ray while dragging.** `Picking` reads `PointerEvent.source`'s `Transform` every frame and takes its +Z as the ray. Drag an image along the floor in Move: it follows the ray's spot on the horizontal plane through the item. If it moves wrongly (or not at all), the source entity's pose isn't the pointer's world pose; switch to the controller pose from `AvatarBody` / `scene.getControllerPoseAtTime`.
- [ ] **Release.** Let go of the trigger mid-drag: the drag ends (`Unselect` or `Cancel` from the same source) and the last pose is relayed (Decentraland shows it where it was dropped).
- [ ] **Gizmo.** Move shows three coloured axis handles (dragging one moves along that axis only, with a guide line); Rotate shows three rings; Resize shows a white corner handle and coloured face handles (no Z for images). Handles are 12 cm boxes, rings 4 cm thick, at least 0.5 m across. Holding either grip snaps (15° turns, 0.1 scale steps, 0.25 stretch steps).
- [ ] **Resizing an image or video live.** The quad (or panel) gets a `Scale` relative to the size it was built at. Check the image grows and shrinks while dragging, and that a video panel does too (if a panel ignores `Scale`, its size only updates when the feed rebuilds it after Save).
- [ ] **Exact fields.** Tap a field: the system keyboard opens (a text keyboard, for the minus sign). Type a value and press Done, or tap elsewhere: the item moves. A bad entry goes back to the old value.
- [ ] **Save, Everywhere and Just this place.** Pick, move, rotate and resize an image and a model; Save. Everywhere: Decentraland shows the change. Just this place: Decentraland doesn't, the AR feed does, and the Layout row gets the dot; **Reset to shared** then Save puts it back.
- [ ] **Held.** While someone moves an item in Decentraland, try to drag it on the headset: the pick drops and the HUD says "<name> is moving this".
- [ ] **Done.** With unsaved changes, Done asks "Save your changes before leaving?" (Save / Don't save / Cancel, wording the owner may change); with none it leaves at once.

### Owner checks (carrying and snapping, plan 3 Task 8)

Not yet run (no headset was connected; adb showed only an offline emulator). `Picking` carries and `MainActivity.builderSurfaces()` reads the room, and builder mode creates `Picking` with those surfaces. The carry math (`Carry`), the snap rules (`snap`) and the landing (`landCarried`) are unit tested; what only the headset can show:

- [ ] **Carry an image to a real wall (Step 4).** Pick an image, point a controller at it and hold its grip: the image follows that controller, turning with it. Flick the thumbstick left or right: it turns 15 degrees a flick. Let go of the grip within 15 cm of a wall: the image lands flush against the wall (1 cm off it), upright and facing into the room. Check the wall's normal points into the room (if the image faces the wall, the scan's wall plane normal is flipped).
- [ ] **Carry a model onto a table.** Put a model down with its base within 15 cm of a table top: it sits on the top, keeping its turn. Same on the floor. If it lands at the wrong height, the MRUK table plane is not its top face (check `builderSurfaces()` for `MRUKLabel.TABLE`, `FLOOR` anchors and their `MRUKPlane` extents).
- [ ] **No snap.** Hold the OTHER controller's grip while letting go: the item stays exactly where it was.
- [ ] **Saving.** After a carry, Decentraland shows the item where it was put down (drafts relay while carrying, the last pose on release), and Save keeps it. Move the scene root (re-align) first and repeat: the saved pose is still where you saw it.
- [ ] **Controller poses.** `Picking` takes each `Controller` entity's `Transform` as the controller's world pose (+Z along the ray) and its `buttonState` as holding that side's grip and thumbstick bits only. If the item jumps on grip, or a grip starts a carry on the wrong controller, switch to `AvatarBody` / `scene.getControllerPoseAtTime`.
- [ ] **Tracking loss.** Cover or drop the carrying controller mid-carry (it stops reporting): the item lands where it last was, snapped like a normal release. This is intended; check it does not drop the item somewhere surprising.

### Owner checks (placing from the library, plan 3 Task 9)

Not yet run (no headset was connected). `AssetsTab`, `placeAhead`, `BuilderApi.placeEntry` and `BuilderEditor.pickWhenPresent` are wired into builder mode: it loads `BuilderApi.library` into `AssetsState`, reads the scene's `activePresetId`, and calls `placeEntry` at `placeAhead(head, headYaw, root)` followed by `pickWhenPresent(placed.instanceId)`.

- [ ] **Library lists.** The Assets tab shows the scene's images (with a small preview), videos and models (no preview); sounds and uploads still in progress are left out.
- [ ] **Place an image.** Place puts it 1 m ahead of the head at eye height, turned to face you (not mirrored, not edge-on), and it is picked (gizmo showing) as soon as the next snapshot arrives. Move it, then Save.
- [ ] **Place a model.** Same, then move it onto a table (snap) and save.
- [ ] **Place a video.** It appears as a screen that plays the clip (a one-video playlist); check it in Decentraland too.
- [ ] **Scheduled showings (LIV-87).** Put a screen in Schedule mode on virvi.io with a showing a few minutes ahead and a holding image. The holding image shows until the start, then the video plays from the start; walk in mid-show (or take the headset off and on) and it joins at the same moment as Decentraland, within a couple of seconds. After the show the holding image comes back.
- [ ] **In a turned room.** After aligning to a ring so the scene is turned (root yaw not 0), a placed item still lands 1 m in front of you and faces you.
- [ ] **Shared.** With the switch on Just this place, Place still adds the item to the shared scene (it shows at Decentraland and at other places); the switch applies to its later edits.
- [ ] **Failure.** Offline, Place leaves nothing behind (no empty element in the scene's Layout).

### Owner checks (builder mode end to end, plan 3 Task 10)

Not yet run: no headset was connected, so nothing was installed. The wiring is unit tested (`BuilderControllerTest`: entering with a ring in view and from the pick list, Align for an unaligned floor, a shared headset off over 2 minutes, a personal one off for a minute, Done, a revoked headset, Assets place and pick); what follows is the whole run on the headset, with a debug build against a test space, as plan 3 Task 10 Step 2 lays out. Tick each step and note anything that went wrong.

Before you start: a scene you can edit with one AR space (a floor with two printed rings, the first with no saved pose), the same scene open in Decentraland, and the website signed in on your phone.

1. **Pair as personal.**
   - [ ] Open the menu, tap **Builder**: the pairing panel shows a code (ABC-123 style) and a QR code.
   - [ ] Scan the QR (or type the code on virvi.io), choose **This is my headset** and approve: the panel closes by itself within a few seconds.
   - [ ] With the first ring in view, the space opens straight away; with no ring in view, a list of your spaces shows (pick yours). The banner "Builder: visitors don't see your changes until you save" isn't up yet; the builder panel says "Look at a ring of <space>".
   - [ ] **Cancel** on the pairing panel (try it once before approving) closes it; approving that code on the website afterwards pairs nothing (the headset stopped asking).
2. **Align a floor.**
   - [ ] Look at the first ring from under 1.5 m: the Align panel opens and the scene appears with the ring at its default spot.
   - [ ] Nudge with the sticks (left moves, right turns; hold a grip for fine steps). Holding a stick keeps stepping: about 50 cm/s, 25°/s, or a fifth of that with the grip. Say if that's too fast or slow.
   - [ ] If the ring was printed off size, the size warning shows. **Save alignment**, then **Done**: the HUD opens to your left, showing the banner, and items can be picked.
3. **Record a second ring.**
   - [ ] Walk to the second ring (within 4 m of the first) and look at it: the ring panel (to the right) shows **Record this ring**. Press it: "Ring saved", then the check line reads a few cm and under 1°.
4. **Move two images.**
   - [ ] Pick an image, set **Everywhere**, move it; pick another, set **Just this place**, move it. Decentraland shows the first moving live (drafts), not the second.
5. **Headset off for 1 minute.**
   - [ ] Take the headset off for about a minute and put it back on: the scene is hidden and the builder panel asks to look at a ring. Look at a ring: the scene comes back with both moves still unsaved (the Layout rows marked •, **Save** enabled).
6. **Save.**
   - [ ] **Save**: Decentraland shows the Everywhere move where you left it, and not the Just this place one. The Layout row of the second image gets the dot.
   - [ ] **Done**: the HUD closes and the space stays shown, as a visitor sees it (the first image moved, the second moved here only).
7. **Check the AR feed as a visitor.**
   - [ ] Menu → **Look at the ring again**, then look at a ring: the space shows with both saved moves.
8. **Pair a second time as shared.**
   - [ ] Menu → **Sign out** (the menu loses **Sign out** and the switch). **Builder** again: a new code. Approve it as **Shared headset**.
   - [ ] Build, then take the headset off for 3 minutes. Put it back on: it's at the hint card ("Look for a ring like this…") with nothing loaded, the menu has no **Sign out**, and **Builder** asks for a new code. The website no longer lists the shared headset.
   - [ ] While shared, **Done**, **Cancel** on the pick list, and taking the headset off at the pick list each sign out (the next **Builder** asks for a new code). Force-stop and reopen the app while shared: it starts signed out.
9. **Revoke the personal headset.**
   - [ ] Pair as personal again and start building. On the website, revoke this headset. Move an item (its live draft is the first call to fail) or **Save**: builder mode closes to the hint card with nothing loaded, and the pairing panel asks to pair again.
10. **The switch.**
    - [ ] With **Keep the scene loaded between visitors** on, a visitor's scene hides when the headset comes off and comes back after looking at a ring without loading again; off (the default), the next person starts at the hint card.

Also worth a look on the way: the HUD and the Align panel can be grabbed and moved; leaving builder mode with **Done** doesn't flash the scene (the renderer rebuilds its items when picking is turned off).

### Owner checks (Scan this room, room scan Task 10)

The layout is read from MRUK in the app's world frame (metres, Y up) and uploaded as it is; the server places it on a plot. Unverified on device.

1. Pair as **Personal headset** and start building. The Layout tab has **Scan this room**. (Paired as shared, it isn't there.)
2. With no rooms in Space Setup: **Scan this room** says "No rooms are set up on this headset yet"; **Set up my space** opens Space Setup (the panel closes while it runs). After finishing it, tap **Scan this room** again: it shows the new outline.
3. **Scan this room** shows each room's outline from above (forward is up) and the name "My room" (one room) or "My home" (several). **Upload** says it's uploaded.
4. On virvi.io, start a room set from the scan in the wizard: the picker lists it, with the right size (measure a wall), doors and windows on the right walls, and furniture where it is.
