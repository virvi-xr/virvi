# Virvi AR for iPhone

Visitor mode on iPhone (phase 1; iOS 18+, iPhone only, portrait): point the camera at a ring marker and the space appears,
placed from the ring's saved pose. Built on the shared Swift package `packages/virvi-ar-swift` (module `VirviARKit`):
the ring detector and maths, the visitor flow, the AR Spaces API and the RealityKit scene renderer. This app is the
ARKit, RealityKit and SwiftUI glue around it. The design is `docs/superpowers/specs/2026-11-22-virvi-ar-iphone-design.md`.

**Get the app:** it isn't in the App Store yet. For now, build it from source as described below. The public page is
[virvi.io/ar](https://virvi.io/ar).

## Requirements

- An iPhone with ARKit, on iOS 18 or later.
- A Mac with Xcode, and [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`).
- The owner's Apple developer team, `P22YGT64VU`, to sign for a real phone.

The Xcode project is generated with [XcodeGen](https://github.com/yonaskolb/XcodeGen) from `project.yml` and isn't
committed:

```sh
cd apps/iphone
xcodegen generate
open VirviAR.xcodeproj
```

## Build and run on a phone

1. `cd apps/iphone && xcodegen generate`, then open `VirviAR.xcodeproj`.
2. Pick your phone as the destination. Signing is automatic with team `P22YGT64VU`.
3. Press Run.

The scheme's **Run and Profile use the Release configuration**: the ring detector is about 60 times slower without
optimisation (1.3 s a frame in Debug against 21 ms in Release), so a Debug build can't find rings in practice. Tests
still run in Debug. Don't switch Run to Debug unless you need a local server.

Release builds talk to `https://virvi.io`. Debug builds take `-baseUrl <url>` as a launch argument (see
`AppConfig`), so use it from a Debug test run or switch the scheme's Run configuration to Debug for a local server.

Universal links (`https://virvi.io/s/<code>`) need the server's `/.well-known/apple-app-site-association`, which
lists `P22YGT64VU.io.virvi.ar`.

## Test

```sh
cd apps/ring-marker && python3 -m ringmarker.testset testset   # once: the detector's test images (git-ignored)
cd ../iphone && xcodegen generate
xcodebuild -project VirviAR.xcodeproj -scheme VirviAR -destination 'platform=iOS Simulator,name=iPhone 16,OS=18.0' test
```

The tests cover the camera-frame pipeline (a full-resolution sensor-orientation frame from the test set), the visitor
controller with fake camera input, transport and scene, and link parsing. The camera, tracking and occlusion can only be
checked on a phone.

## Layout

- `App/VirviARApp.swift`: the app, link parsing (`spaceCode(fromLink:)`), and the screen.
- `App/ArSessionView.swift`: the ARKit session and its delegate, the RealityKit scene view and its 400 ms fade.
- `App/FramePipeline.swift`: the captured image's luma plane, kept in sensor orientation, scaled to 1280 wide and run
  through the ring detector on a background queue, about 8 frames a second.
- `App/VisitorController.swift`: the visitor flow wired to the camera, the feed, the scene and the UI.
- `App/HintCard.swift`, `VisitorMenu.swift`, `ReportSheet.swift`, `RingOutline.swift`: what the visitor sees.
