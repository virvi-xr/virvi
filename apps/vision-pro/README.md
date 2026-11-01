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
| `-build YES` | Starts editing once the scene is open (the scene itself always shows) |
| `-select <elementId:instanceId>` | Selects that item in the build space (for example `duck:d`) |
| `-editMode <Move\|Rotate\|Resize>` | Starts the edit bar in that mode |
| `-exact YES` | Opens the Exact panel |
| `-sceneAhead <m>` | Puts the scene's centre that far ahead instead of 2 m, so a screenshot takes in more of it |

Screenshots from the fixture server are in `docs/`: `pairing.png`, `scene-picker.png`, and `tab-layout.png`, `tab-assets.png`, `tab-events.png`, `tab-stream.png`, `tab-worlds.png`, `tab-alerts.png`, `tab-roles.png`, `tab-stats.png`. The build space: `build-placed.png` (the scene put down, in Place scene), `build-selected.png` (the Duck selected; it predates the outline), `build-gizmo-rotate.png` (the rotation rings) and `build-gizmo-move-edit-bar.png` (the Move arrows on a poster, with the edit bar and the Exact panel).

The simulator has no world tracking. There the scene always goes down at a fixed spot ahead of the space's origin, with no `WorldAnchor`: Pin to this room says "Pinning needs a device", and Assets → Place says it can't tell where you're facing, and places nothing.

## The window

- **Pairing:** the code in large type, the approval page's address to type on a phone or computer (the wearer can't scan a QR shown inside the headset), a small QR for someone beside them, and Cancel.
- **Scene picker:** "Choose a scene to build", from the headset's scene list.
- **HUD:** the Decentraland HUD's panel, with the same tab bar (Layout, Assets, Events, Stream, Worlds, Alerts, Roles for hosts and co-hosts, Stats), panel titles, empty states and buttons, in Decentraland's colours.
  - **Edit layout** opens the `build` immersive space (below).
  - **Upload**, **Publish** and **Stats** open their page in a browser window beside the HUD. Stats is the plain analytics link: the headset never gets a web hand-off.
  - Roles has no **Make host**: it says to use Roles on the dashboard.
  - Every edit failure or refusal, and every stream going live or offline, goes into Alerts and shows as a toast.
- Known gap: nothing on the headset feeds `missingSrcs` yet, so the "Needs sync" badge and the sync notice never show.

## The build space

- **The scene in the room:** whenever a scene is open, for viewers and builders alike, it shows life-size in the room (the `build` immersive space); changing scene, a revoke or signing out takes it away. If it is closed with the Digital Crown, **Show in room** on the HUD brings it back.
- **Putting the scene down:** the AR spike's Place scene. The scene appears life-size with its centre 2 m ahead and north pointing away, with the floor disc and the parcel outline. While placing (a scene's first visit starts there), pinch-drag on them slides the scene and a two-hand twist turns it, and items don't take pinches. **Done placing** (or **Pin to this room**) finishes placing; **Move scene** goes back. **Pin to this room** saves a `WorldAnchor`, with its id in `UserDefaults` per scene, and the next launch comes back to it. **Re-place** clears the pin. The scene sits on the floor the headset detects (visionOS's own floor guess can be centimetres off): the first floor found sets an unpinned scene down, and while placing **▲** / **▼** move it 1 cm and **Snap to floor** puts the marker back on the detected floor, with a readout such as "2 cm above the floor". The pin keeps the height. Finding the floor asks for the world-sensing permission. Edit never moves the whole scene.
- **Picking:** looking at an item lights it up in cyan; pinch to select it. The selected item gets a cyan outline on its box's edges, a faint fill and its name above it. Items over 1.5 m on a side catch looks only on their own surfaces, so a building or floor doesn't block what's inside or behind it; smaller items get a box at least 15 cm on each side. The Layout tab's **Select** picks an element's first copy (not a sound) and opens the build space on it.
- **Gizmo:** Move arrows, rotation rings and resize handles in the Decentraland gizmo's colours. Each handle's hit shape is at least 6 cm across and grows with distance (5 cm per metre), so it stays easy to hit 2–5 m away. Pinch-dragging a handle moves, turns or resizes the item under the edit bar's mode and lock. Pinch-dragging the item itself moves it freely in Move.
- **Edit bar:** an ornament under the HUD window, as Decentraland's: Move | Rotate | Resize, the selected name (or how to pick one, which says when you are still placing), the lock (Free/X/Y/Z, which you pinch to change), **Snap**, **Exact**, **Save**, **Revert** and **Done**. It shows from **Edit layout** (or Select, or placing an asset) until **Done**, which stops editing and leaves the scene showing; items take pinches only while editing. Under it, whenever the scene is in the room, are Done placing / Move scene, Pin to this room and Re-place.
- **Decentraland colliders:** model parts whose node or mesh name contains `_collider` are collision only in Decentraland and aren't drawn.
- **Placing:** Assets → **Place** takes the head pose from world tracking and puts the item 2 m ahead, facing you, then selects it. If the build space isn't open, Place opens it first. With no head pose, it says so and places nothing.
- Leaving the scene (Change scene, revoking the headset, signing out) closes the build space and drops any unsaved change.

## Device checklist

The simulator has no world tracking, so the owner runs these on the headset:

1. Pair.
2. Pick a scene.
3. Place it and pin it. Relaunch, and it comes back.
4. Place a GLB from Assets. It lands 2 m ahead, facing you.
5. Move, rotate and resize it with the gizmo, then Save.
6. Check in Decentraland or Hyperfy that the item moved there too.
7. While you drag, a second editor on the dashboard sees "being moved by".
8. Revoke the headset on the dashboard. The app returns to pairing.
9. The gizmo handles are easy to hit from 2–5 m away.
