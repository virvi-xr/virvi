# Virvi Builder (Apple Vision Pro)

A visionOS app for building a Virvi scene in place, life-size, on a Vision Pro. This first cut is the project shell with the AR spike's scene core (`Core/Scene`: Mapping, ScenePlan, SceneRenderer) and its tests. See `docs/superpowers/specs/2026-10-31-vision-pro-builder-design.md` for the design.

Bundle id `io.virvi.builder.visionos`, visionOS 2.0+, GLTFKit2 0.5.15.

## Build and test (simulator)

```sh
brew install xcodegen          # once
cd apps/vision-pro
xcodegen generate              # creates VirviBuilder.xcodeproj (git-ignored)
xcodebuild -project VirviBuilder.xcodeproj -scheme VirviBuilder \
  -destination 'platform=visionOS Simulator,name=Apple Vision Pro,OS=26.1' \
  CODE_SIGNING_ALLOWED=NO test
```

## Run in the simulator

Build with the command above (`build` instead of `test`), or open `VirviBuilder.xcodeproj` in Xcode, pick the Apple Vision Pro simulator and press Run.

Debug builds read a `-baseUrl` launch argument; Release builds always use `https://virvi.io`:

```sh
xcrun simctl launch <vision-sim-id> io.virvi.builder.visionos -baseUrl http://127.0.0.1:8787
```

## Run on a device

1. Set `DEVELOPMENT_TEAM` in `project.yml` (it is empty in the repo) to your Apple team id, or pick the team in Xcode's Signing & Capabilities tab after `xcodegen generate`.
2. Put the Vision Pro in developer mode and connect it (Xcode, Window > Devices and Simulators).
3. Choose the headset as the run destination and press Run. Trust the developer profile on the headset if asked.

World tracking and anchors (`NSWorldSensingUsageDescription`) only work on a device.

## Fixture server

The fixture server comes with Task 11 of the plan; this section will say how to start it and point the app at it with `-baseUrl`.
