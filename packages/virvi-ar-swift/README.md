# VirviARKit

The Swift code Virvi AR shares between Apple Vision Pro (`apps/vision-pro`) and iPhone: the Virvi-to-RealityKit mapping, the scene plan and its diff, scheduled showings, the RealityKit scene renderer, floor and collider helpers, and the HTTP transport. Platforms iOS 18+ and visionOS 2+; GLTFKit2 0.5.15.

## Test

`swift test` can't run here (RealityKit and GLTFKit2 need a simulator SDK), so use xcodebuild:

```sh
cd packages/virvi-ar-swift
xcodebuild -scheme VirviARKit -destination 'platform=iOS Simulator,name=iPhone 16,OS=18.0' test
```

`Tests/VirviARKitTests/FakeTransport.swift` is a copy of `apps/vision-pro/Tests/FakeTransport.swift`: test files can't be shared across a package boundary.
