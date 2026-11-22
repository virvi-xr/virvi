# Virvi AR (AR spike)

This is the prototype the iPhone app, Virvi for iPhone, grows from. The real iPhone app is planned; see the AR page at virvi.io/ar.

**Get the app:** there’s nothing to download. Virvi for iPhone isn’t in the App Store, and this prototype is built from source and run from Xcode as described below ([Build](#build-simulators), [Run on your Apple Vision Pro (or iPhone)](#run-on-your-apple-vision-pro-or-iphone)). The public page is [virvi.io/ar](https://virvi.io/ar).

A spike for checking how Virvi scenes load and look in AR, life-size. Its visionOS half has been taken over by Virvi Builder (`apps/vision-pro`), whose scene core started from this one, and the Quest app (`apps/quest`) is its sibling. It has two apps that share one Swift source folder:

- **VirviAR-iOS** (iPhone only, iOS 18+, a device with ARKit): an ARKit/RealityKit `ARView` with horizontal plane detection. Tap the floor and the scene's centre, Virvi (8, 0, 8), lands on that spot, with Virvi north pointing away from you. The **Tabletop 1:20** toggle shrinks the scene.
- **VirviAR-visionOS** (visionOS 2+): a settings window and an **Enter space** button. The button opens a mixed `ImmersiveSpace` that puts the scene life-size on the floor, with its centre 2 m in front of you.

Both apps long-poll `GET {feedUrl}/api/hyperfy/feed` with a world key, the same way the Hyperfy app does. Then they build RealityKit entities:

- Images become unlit, double-sided textured planes.
- Videos become `VideoMaterial` planes, looped and muted unless **Sound** is on.
- Models (.glb/.gltf) are loaded with GLTFKit2. A model that fails to load shows a pink placeholder box labelled with its file name.
- Sounds play as spatial audio, only when **Sound** is on.

The code is organised like this:

- `Shared/ScenePlan.swift` is a port of `packages/hyperfy-app/src/plan.ts`.
- `Shared/Mapping.swift` is a port of `src/transform.ts`. It handles the left-handed to right-handed axes, YXZ Euler order and `MODEL_TURN`.
- `Tests/` holds the transform test cases ported from `test/transform.test.ts`, two plan tests, and tests for the marker readings (`Shared/MarkerReadings.swift`).

Spike shortcuts:

- The world key is stored in `UserDefaults`. Production would keep it in the Keychain.
- Clicks and analytics aren't implemented.
- A `.gltf` that points to external buffers or textures won't load, because only the main file is downloaded.

## Build (simulators)

```sh
brew install xcodegen          # once
cd apps/ar-spike
xcodegen generate              # creates VirviAR.xcodeproj (git-ignored)
xcodebuild -project VirviAR.xcodeproj -scheme VirviAR-iOS -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project VirviAR.xcodeproj -scheme VirviAR-visionOS -destination 'generic/platform=visionOS Simulator' CODE_SIGNING_ALLOWED=NO build
# unit tests (any iOS 18+ simulator)
xcodebuild -project VirviAR.xcodeproj -scheme VirviAR-iOS -destination 'platform=iOS Simulator,name=<an iOS 18+ iPhone>' CODE_SIGNING_ALLOWED=NO test
```

The iOS simulator has no ARKit, so the iOS app only shows its UI there. AR needs a real iPhone.

### Fixture feed (no world key needed)

`tools/fake_feed.py` serves a small scene with two images, the Khronos Duck GLB and one model that is deliberately missing, on `http://127.0.0.1:8787`. To use it, put `Duck.glb` and a `tex.png` in a folder, then run `python3 tools/fake_feed.py <that folder>`. Then launch the visionOS app with launch arguments. They override the settings for that run only:

```sh
xcrun simctl launch <vision-sim-id> io.virvi.ar.visionos -feedUrl http://127.0.0.1:8787 -worldKey fixture -autoEnterSpace YES
```

See `docs/visionos-immersive-fixture.png` for the result.

## Placing the scene (Vision Pro)

The window's top row has a mode picker (**View**, **Place scene**, **Edit objects**) and **Enter/Leave space**. In **View** mode, gestures are off.

In the space, a translucent 0.6 m disc marks the scene's centre, Virvi (8, 0, 8), on the floor. Its arrow and **N** point to the scene's north, Virvi +Z. A thin outline shows the 16 m × 16 m parcel; the parcel's south-west corner is Virvi's origin.

- **Place scene:** pinch and drag the marker or the outline to slide the whole scene along the floor. Pinch the marker with both hands and twist to turn the scene about its centre.
- **Pin to this room:** adds an ARKit `WorldAnchor` at the scene's current spot and saves its id in `UserDefaults`. On the next launch, the scene moves back to that spot once visionOS finds the anchor. If you move a pinned scene, the pin moves with it.
- **Re-place:** clears the pin and puts the scene 2 m ahead of you again, with north pointing away from you.
- Pinning needs a device. In the simulator the buttons do nothing and the status reads "Pinning needs a device".

## Editing objects (Vision Pro)

In **Edit objects** mode, pinch an image, video or model to select it. The selected object gets a cyan box around it, and the window shows its name and a **Reset object** button.

- Drag to move it in 3D.
- Pinch with both hands and twist to turn it about the vertical axis.
- Pinch with both hands and spread or close them to resize it, from 0.1× to 10× its Virvi size.

Edits stay on the headset and aren't saved to Virvi. When the feed changes an object, the feed's version replaces the local edit, so live edits from Virvi still show. Changing **Sound** and tapping **Connect** rebuilds every object, which drops all local edits.

See `docs/visionos-controls.png` for the window in the simulator.

## Run on your Apple Vision Pro (or iPhone)

1. Run `cd apps/ar-spike && xcodegen generate`, then open `VirviAR.xcodeproj` in Xcode 26.
2. For **both** targets (`VirviAR-iOS` and `VirviAR-visionOS`), go to the **Signing & Capabilities** tab. Keep **Automatically manage signing** on and pick your **Team**. The bundle ids are `io.virvi.ar.ios` and `io.virvi.ar.visionos`. If Xcode says an id is taken, change the prefix (for example `com.yourname.spaces.visionos`).
   - Picking the team in Xcode is lost the next time you run `xcodegen generate`. To keep it, set `DEVELOPMENT_TEAM` in `project.yml`.
3. Pair the Vision Pro:
   1. On the headset, open **Settings → General → Remote Devices**.
   2. On the Mac, open Xcode → **Window → Devices and Simulators**, select the Vision Pro and click **Pair**, then enter the code shown in the headset.
   3. The Mac and the headset must be on the same Wi-Fi network.
   4. If Xcode asks, turn on **Developer Mode** on the headset (**Settings → Privacy & Security → Developer Mode**) and restart it.
4. In Xcode's toolbar, choose the **VirviAR-visionOS** scheme and pick your Vision Pro as the run destination. Press **Run** (⌘R). The first install can take a few minutes while Xcode prepares the device.
   - For an iPhone, plug it in, choose **VirviAR-iOS**, pick the phone and run. On first launch, allow camera access.
5. In the app's settings, paste a world key. To get one, open virvi.io → **Deploy** → **Your Hyperfy worlds** → **Connect a world** and copy the `virviw_…` key. Tap **Connect**. The status line should read `Live · version xxxxxxxx · N items`.
6. **Vision Pro:** tap **Enter space**. The scene appears life-size with its centre 2 m ahead of you on the floor, north pointing away from you. Use **Place scene** to move it and **Pin to this room** to keep it there. **iPhone:** move the phone around until the floor is detected, then tap it.

## Marker detection-range test

Checks how far away each device can spot a registration marker. It was run before Virvi’s own ring markers (`apps/ring-marker`) were built; the Quest app uses those, and this spike still tracks these QR-code test markers. Two test markers, both laid out as the AR spaces design describes (QR code, 2-module quiet zone, hashed border ring; the ring's outer square is the tracked image):

| Marker | Tracked square | Plaque |
|---|---|---|
| `TEST12` | 120 mm | 150 mm |
| `TEST17` | 170 mm | 178 mm |

`python3 tools/make_markers.py` regenerates `markers/` (the reference PNGs are also copied into `Shared/Markers/`, which both apps bundle). Per marker:

- `<code>-paper.pdf`: US Letter, marker at exact size, with a 100 mm check bar. Print at 100% ("Actual size"), then measure the bar. Glue it to stiff card so it stays flat.
- `<code>.3mf`: base and raised parts as one object with two colours, for multicolour printers.
- `<code>-base.stl` and `<code>-raised.stl`: the same two parts for single-colour printers. Load both (they share an origin) and change filament at **4.0 mm**. Matte filament tracks better than glossy.
- `<code>-reference.png`: the tracked square only, which the apps track.

The QR codes open `virvi.io/s/TEST12` and `virvi.io/s/TEST17`, which don't exist yet.

Running it:

- **Vision Pro:** tap **Enter space** (visionOS only tracks images while the space is open). The window's **Marker test** card shows each marker's state. A green square covers a tracked marker.
- **iPhone:** the panel at the bottom shows the same, plus the last QR code read and how far away it was.
- Mount the marker at about 1.5 m. Walk back until it's lost, then toward it until it's found again. "Found at" is the distance where tracking started: that's the number that matters, since a visitor has to be found from where they stand. **Reset** clears the readings.
- If a marker's measured size is more than 3% off its printed size, the status line says so: check the print scale.
