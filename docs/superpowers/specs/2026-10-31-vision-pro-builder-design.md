# Virvi Builder for Apple Vision Pro: Design

Status: draft for the owner's review (2026-10-31).

## Intent

The owner wants to build their own Virvi scenes while wearing an Apple Vision Pro. They put the scene down in the room around them, pick assets from their library and place them life-size, and move them where they want them. The edits go to the shared Virvi scene, so Decentraland, Hyperfy and every other place see them.

The thing the owner would wince at: **a headset HUD that's dramatically different from the in-world HUD built for Decentraland.** Someone who knows the Decentraland HUD should feel at home straight away. Where the headset's input forces a difference, the difference should be as small as possible.

The owner might build anywhere: in their own room, as a workshop for a scene that mostly lives in Decentraland and Hyperfy, or in the real place where the scene will be shown in AR. Version 1 covers the workshop. The real place comes later (see Later).

## Goals (version 1)

- **Placing assets from the library around you** is the heart of version 1. If it could only do one thing well, the owner picked this.
- **All the Decentraland HUD's tabs, with the same names, order and behaviour:** Layout, Assets, Events, Stream, Worlds, Alerts, Roles (hosts and co-hosts only) and Stats. (The owner's decision.)
- **Edits go to the shared scene**, through the same paths the Decentraland HUD uses: drafts that other editors see as "being moved by <name>", then Save, Revert and Done.
- **Workshop placement:** you put the whole scene down in your room and pin it there. Next launch, it comes back to the same spot.

## Non-goals (version 1)

- **Room scanning** into a building GLB. It comes right after version 1 (the owner's decision).
- **Redeploying from the headset.** It comes right after version 1 (the owner's decision). Until then, the Worlds tab shows each World's status and **Publish** (see below).
- **Lining the scene up from ring markers in a real place.** It comes after the Vision Pro ring-detection test (the owner's decision). So there's no **Everywhere / Just this place** choice in version 1, because it only applies to an AR space.
- **Visitor mode.** This app is for builders.
- **An iPhone version.** It can share the code later.
- **The App Store.** Builds go onto the owner's headset from Xcode, with TestFlight later.

## Anti-goals

- **A HUD that's dramatically different from the Decentraland HUD** (the owner's words). That covers labels, tab order, what each tab shows, the confirmation wording, and the Save/Revert/Done rules.
- **Edits that never reach the shared scene, or that land somewhere different from where the builder let go.**
- **Signing in with secrets typed into the headset or stored outside the Keychain.**

## What the Decentraland HUD does (the reference)

This is how it's built today, and the headset copies it. Paths are in the repo.

- **The panel and tabs.** `packages/adapter-dcl/src/DclHUDRenderer.tsx` (`NavBar`, about lines 634–700). Before the tabs, it shows Connecting, scene setup ("Your Scenes" / "Create Scene"), "Set up Virvi here" and the "Scene Created!" banner.
- **Layout ("Scene Layout").**
  - **Edit layout** (editors only) enters edit mode.
  - Each element row has a three-letter type tag, the name, ON/OFF, **Hide/Show** and **Delete**.
  - Delete asks "Delete this element and all its copies? This can't be undone."
  - It shows 12 rows, then "+N more — manage them on the dashboard".
- **Assets ("Media Library", "Images and GLB models").**
  - Each library row has a GLB or IMG tag, the name, a status badge, **Rename**, and **Place**. A failed row shows **Dismiss** instead of Place.
  - It shows 10 rows, then "+N more — place them from the dashboard".
  - The **Upload** view has **Open on this computer**, or a QR code or entered code to upload from a phone, with **New link** and **Back**.
  - There's a Scene Budget meter, and the sync notice "N model(s) need sync + redeploy…".
- **Placing** (`packages/adapter-dcl/src/index.ts` about 86–105 and 335–375).
  - It creates an element in the active preset, then an instance.
  - The item lands 2 m in front, facing you, squared to the nearest 90°. Images sit at eye height (feet + 1.2 m) at 2×2×1; models sit at your feet.
  - There's no confirmation step. It shows "Placed <name>". For models, it adds the next-step message from `packages/core/src/placed-message.ts`, with **Publish** when the World is in sign mode.
- **The edit bar** (`packages/adapter-dcl/src/hud/EditModeBar.tsx`).
  - It reads **Move | Rotate | Resize**, then the selected name or "Click an item to select it", the axis lock (Free/X/Y/Z), and **Exact, Save, Revert, Done**.
  - **Exact** opens typed Position (m), Rotation (degrees) and Scale fields.
  - Save and Revert are off until something changes. Done, or picking another item with unsaved changes, says "Save or revert changes to <name> first."
  - Snapping steps are 15° for rotation, 0.1 for uniform scale and 0.25 for a single axis (`packages/core/src/transform/session.ts`).
  - There's no undo beyond Revert.
- **Saving** goes over the scene's live room. Drafts are `transform_draft` and `transform_end`, sent about every 100 ms. Save is one `scene_preset_update` that waits up to 5 s for its acknowledgement (`packages/core/src/Virvi.ts`).
- **The other tabs:**
  - **Roles** lets hosts and co-hosts manage who can edit.
  - **Stats** opens the web analytics.
  - **Events, Stream and Worlds are unfinished in Decentraland (checked 2026-10-31).** Nothing connects them to their data, because `setHUDActionHandler` is never called. They always read "No active events", "No active streams" and "No connected worlds", and their buttons do nothing.
  - **Alerts half works.** Toasts appear when a host joins or leaves, but the list empties after 5 seconds.

### The tabs built for real on the headset (the owner's decision, 2026-10-31)

The headset builds these four tabs for real. Each keeps Decentraland's title, empty-state copy and button labels. Wiring Decentraland's own tabs the same way is a follow-up, outside this design. The data choices below are **Claude's calls**:

- **Stream:**
  - The scene's video elements, each with its name and whether it's live.
  - **Go Live** and **Go Offline** call `POST /api/elements/:id/live {enabled}`, the route Hyperfy's HUD uses. It applies the same video-control rules as the room.
  - The empty state is "No active streams".
  - This mirrors Hyperfy's streams model (`packages/hyperfy-app/src/hud/model.ts`).
- **Worlds:**
  - The scene's Decentraland World from `GET /api/scenes/:id/dcl/publish-status`: the World's name, its status, and how many models wait for a deploy (`pending`).
  - **Publish** opens `publishUrl` in a browser window, where the wallet signs, as Decentraland's Publish does.
  - The empty state is "No connected worlds".
  - Redeploying from here comes after version 1.
- **Alerts:**
  - A list kept for the session (newest first, the last 20), not only 5 seconds.
  - Alerts are made by comparing feed snapshots, as Hyperfy's HUD does:
    - "Stream is live" and "Stream went offline" when a video's live state changes.
    - Save failures and refusals.
  - Each alert also shows as a toast.
  - The empty state is "No notifications".
- **Events:**
  - The events this scene is part of: name, start and end, and whether it's on now.
  - It uses a new scene-scoped read, `GET /api/scenes/:id/events`, because the account-wide `/api/events` routes don't take scene passes and shouldn't.
  - Under the list, **Switch layout** picks the scene's active preset with `PUT /api/scenes/:id {activePresetId}`. That's the useful part of Decentraland's unfinished `switchPreset` button, kept to this scene.
  - Giveaways and other cross-world event actions stay on the dashboard.
  - The empty state is "No active events".

The Quest builder (`apps/quest/app/src/main/java/io/virvi/ar/builder/`) already copies the Layout and Assets tabs and the edit bar for a headset. It's the nearest prior art for headset input and for using pairing passes.

## Version 1, as the owner will use it

1. **Pair once.** The app shows a pairing code and a QR code. The owner approves it on virvi.io, the same headset pairing the Quest uses, as a personal headset. The headset's secret goes in the Keychain. Taking the headset away is done the same way as on the Quest: revoke it from the dashboard's device list.
2. **Pick a scene.** The app lists the scenes the owner can build on: ones they own, collaborate on, or hold a role in.
3. **Put it down.** The scene appears life-size with its centre 2 m ahead, north pointing away. A floor disc and the parcel outline show where it is, as in the spike. The owner can drag it along the floor and twist it to turn it, then **Pin to this room**. Next launch, it returns to the pin. **Re-place** clears the pin.
4. **Build with the HUD.** A floating window holds the Decentraland HUD's tabs. The owner places from **Assets**, then selects and edits in place with the edit bar. Everything else works as described above.

## Where the headset has to differ, and how (Claude's calls)

Keep each difference this small:

- **Pointing:** look and pinch replaces the mouse click, for selecting items and pressing buttons.
- **Gizmo:** the same move handles, rotation rings and resize handles as Decentraland's, grabbed with a pinch-drag. Pinch-dragging the item itself also moves it, as the spike does, because it's the natural headset gesture. The selected item gets the same highlight as in Decentraland.
- **Snap:** with no Shift key, **Snap** is a toggle button on the edit bar, as it is in Hyperfy's HUD.
- **Typing:** **Exact** and **Rename** use the visionOS keyboard.
- **Upload:** see "How it gets built". The same page Decentraland opens, in a browser window.
- **Stats:** opens the analytics page in a browser window beside you, where the owner signs in on the web themselves. The headset never gets a web session through `POST /api/auth/handoff`, because that session would outlive revoking the headset. (The owner's decision.)
- **Roles:** everything the Decentraland tab does except **transfer host**, which can't be undone and stays on the dashboard. Adding and removing roles works. The headset's Roles tab says where to transfer host instead. (The owner's decision.)
- **Placing:** 2 m ahead of where your head points (visionOS doesn't tell apps where your eyes look), on the floor for models and at eye height for images. The same 90° squaring and default sizes as Decentraland.
- **Placement units:** the scene is life-size. A Virvi metre is a real metre, using the spike's tested axis mapping (`apps/ar-spike/Shared/Mapping.swift`).

## How it gets built (Claude's calls)

- **App:** Swift and RealityKit for visionOS 2+. It grows out of `apps/ar-spike` (its scene feed, plan, mapping, renderer, placement and pinning), promoted into a real app the way the Quest app was promoted from its spike. It keeps the shared Swift core so an iPhone app can use it later.
- **Rendering the scene:** as the spike does, it renders images, videos and models (GLTFKit2), with a pink box for a model that won't load. Live updates come over the scene feed and the live room.
- **Server changes:**
  - **A pass for a scene, not only a space.** Today `POST /api/ar/devices/:id/pass` needs a `spaceId`, and the scene list only lists spaces. Version 1 adds a pass for a scene the approver can build on, and a list of buildable scenes. The checks stay the same: the approver's build access, the headset still live, and the pass never outliving the headset.
  - **The HUD's routes take that pass.** An AR pass works only on routes marked `scenePass.ar`. Every route the Decentraland HUD's tabs call (Layout, Assets, Events, Stream, Worlds, Alerts, Roles, the live room's save and draft messages) must accept the headset's pass, with the same per-scene and per-role checks it applies to the Decentraland HUD. The two exceptions are `POST /api/auth/handoff` and transfer host, which keep refusing it (see "Where the headset has to differ"). The builder lists those routes from the Decentraland HUD's client calls (`packages/client/src/http.ts`) and marks each one. Routes nobody marks keep refusing the pass.
  - **Saves and drafts go over HTTP, as on the Quest, not a Swift Colyseus client.** Drafts post to `POST /api/ar/drafts` and `/api/ar/drafts/end`. The server relays them into the scene room as the room's own `transform_draft` / `transform_draft_end`, so Decentraland editors still see "being moved by <name>". A 409 `held` means someone else holds the item. Saves use `PUT /api/instances/:id`, as the Quest's Everywhere saves do. The rules don't change: Save and Revert are off until something changes, Done needs a save or a revert first, and Save waits for the server's answer. **Why:** Swift has no official Colyseus client, and the Quest's path is already built and tested. Production runs rooms in one process, with no Redis (checked 2026-10-31), so the draft routes work there. If rooms ever move to Redis, those routes answer 503 `drafts_unavailable` and drafts stop showing to others, but saves still work. **Claude's call.**
  - **A scene feed for the pass.** The only AR feed today is per space (`/api/ar/spaces/:id/feed`). Version 1 adds a scene-keyed draft feed for a scene pass, the same as the space feed minus per-space adjustments. A scene with no AR space can be built on. **Claude's call.**
  - **Personal headsets only.** A shared headset is refused a scene pass, the same as for room scans. **Claude's call.**
  - **Upload:** the headset doesn't upload files itself. **Open on this computer** opens the existing upload page with an upload token, in a browser window beside you, just as the Decentraland HUD opens one. The phone QR and code path is unchanged. This keeps the headset off the storage-limit code. **Claude's call.** (This replaces the file-picker idea under "Where the headset has to differ".)
- **Billing code** stays off limits.

## Constraints

- **Secrets:** the headset's secret and passes live in the Keychain, and tokens and keys are never logged.
- **Names:** new copy uses Virvi names, and `check-no-vlm` must report 0 hits.
- **Deploying the server:** only with `railway up <release-deploy worktree> --path-as-root -s virvi-server --ci`, after fetching origin, and only with the owner's OK.

## Risks

- **visionOS window and HUD layout.** The Decentraland HUD is a 2D panel. A visionOS window is also 2D, so the match should be close. The gizmo, though, is RealityKit entities that must be easy to hit with the eyes at 2–5 m. The first build step checks handle sizes on the device.
- **Gesture conflict.** Moving the whole scene (in placement) and moving an item (in edit mode) both use pinch-drag. Edit mode only moves items, and the scene moves only from the floor disc or outline, as in the spike.

## Later (in order, as agreed)

1. **Room scan** into a building GLB, using visionOS plane detection (wall, floor, ceiling, door, window, table and seat) and scene reconstruction, through the existing room-scan upload. RoomPlan isn't on visionOS, so a device check comes first.
2. **Redeploy from the Worlds tab** for Worlds that need it, such as Decentraland after new models.
3. **Ring alignment in a real place**, after the Vision Pro ring-detection test, with **Everywhere / Just this place**.

## Left to the builder

- How the window, the edit bar and the gizmo are laid out in visionOS, within "as close to Decentraland's as the headset allows".
- The order of the server's route-marking work, and how the scene pass is told apart from a space pass in the token.
- Test coverage, and the fixture feed for the simulator (the spike has `tools/fake_feed.py`).
