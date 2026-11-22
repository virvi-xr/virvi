# VirviARKit

The Swift code Virvi AR shares between Apple Vision Pro and iPhone. Platforms iOS 18+ and visionOS 2+; GLTFKit2 0.5.15.

Used by `apps/vision-pro` and `apps/iphone`.

What's in `Sources/VirviARKit`:

- `Scene`: the Virvi-to-RealityKit mapping, the scene plan and its diff, scheduled showings, the RealityKit scene renderer, and floor and collider helpers.
- `Api`: the HTTP transport and the AR Spaces API client.
- `Ring`: the ARC (Augmented Reality Code) detector and the ARC maths.
- `Space`: lining a space up with the room: the ARKit boundary (camera intrinsics, camera-to-world, wall planes; iOS only) and placing the scene from an ARC's saved pose (`rootFromMarker`, `realityKitRootTransform`).
- `Visitor`: the visitor flow (find the ARC, line the scene up, hints).
- `Config.swift`: shared settings.

## Test

`swift test` can't run here (RealityKit and GLTFKit2 need a simulator SDK), so use xcodebuild:

```sh
cd packages/virvi-ar-swift
xcodebuild -scheme VirviARKit -destination 'platform=iOS Simulator,name=iPhone 16,OS=18.0' test
```

`Tests/VirviARKitTests/FakeTransport.swift` is a copy of `apps/vision-pro/Tests/FakeTransport.swift`: test files can't be shared across a package boundary.

The package also has to build for visionOS, since the Vision Pro app uses it:

```sh
xcodebuild -scheme VirviARKit -destination 'generic/platform=visionOS Simulator' build
```

The ARC tests need the detector's test images: `cd apps/ring-marker && python3 -m ringmarker.testset testset`.
