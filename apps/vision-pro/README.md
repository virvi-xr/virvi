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

`tools/fake_server.py` stands in for virvi.io so the window can run in the simulator. Put the Khronos `Duck.glb` and any `tex.png` in a folder (as for the AR spike), then:

```sh
python3 tools/fake_server.py <that folder> --flip-live 20   # --flip-live is optional
```

- The API is on `http://127.0.0.1:8787`: pairing (approved on the second claim poll), the scene list (Fixture Gallery as host, Rooftop Stage as editor), passes, the scene feed (long poll), scene, library, publish-status, events, roles, drafts (204), `PUT` instance (200) and the tab actions.
- Placeholder web pages (analytics, publish, upload, pairing) are on `http://localhost:3000`, the dashboard origin `analyticsUrlFor` gives for a local API, so Stats, Publish and Open on this computer have something to open.
- `--flip-live N` turns the Stage stream live/offline every N seconds, so Alerts fills up.
- It logs only the method and path, without query strings and with pairing and upload codes masked. It never logs a token, secret or code.

### Running against it

The Keychain only works in the simulator when the app is signed. An unsigned build (`CODE_SIGNING_ALLOWED=NO`) compiles, but the headset secret can't be saved, so pairing stalls after the code shows. To run the app, build it ad-hoc signed (no team needed):

```sh
xcodebuild -project VirviBuilder.xcodeproj -scheme VirviBuilder \
  -destination 'platform=visionOS Simulator,name=Apple Vision Pro,OS=26.1' \
  CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM= build
xcrun simctl install <vision-sim-id> <DerivedData>/Build/Products/Debug-xrsimulator/VirviBuilder.app
xcrun simctl launch <vision-sim-id> io.virvi.builder.visionos -baseUrl http://127.0.0.1:8787
```

Debug builds also read these launch arguments, which land on a screen without UI automation (Release builds ignore them):

| Argument | Effect |
| --- | --- |
| `-screen pairing` | Forgets the pairing first, so the pairing code shows |
| `-screen picker` | Stays on the scene picker |
| `-tab <Layout\|Assets\|Events\|Stream\|Worlds\|Alerts\|Roles\|Stats>` | Opens the first scene on that HUD tab (`-tab Stats` opens the analytics window; `-tab Events` shows the Switch layout list) |
| `-scene <id>` | Opens that scene instead of the first |

Screenshots from the fixture server are in `docs/`: `pairing.png`, `scene-picker.png`, and `tab-layout.png`, `tab-assets.png`, `tab-events.png`, `tab-stream.png`, `tab-worlds.png`, `tab-alerts.png`, `tab-roles.png`, `tab-stats.png`.

## The window

- **Pairing:** the code in large type, a QR of the approval page, and Cancel, as on the Quest.
- **Scene picker:** "Choose a scene to build", from the headset's scene list.
- **HUD:** the Decentraland HUD's panel, with the same tab bar (Layout, Assets, Events, Stream, Worlds, Alerts, Roles for hosts and co-hosts, Stats), panel titles, empty states and buttons, in Decentraland's colours.
  - **Edit layout** opens the `build` immersive space. Task 12 fills it in.
  - **Upload**, **Publish** and **Stats** open their page in a browser window beside the HUD. Stats is the plain analytics link: the headset never gets a web hand-off.
  - Roles has no **Make host**: it says to use Roles on the dashboard.
  - Every edit failure or refusal, and every stream going live or offline, goes into Alerts and shows as a toast.
- Known gap: nothing on the headset feeds `missingSrcs` yet, so the "Needs sync" badge and the sync notice never show.
- Until Task 12 adds head tracking, Assets → **Place** puts items 2 m north of the parcel's centre.
