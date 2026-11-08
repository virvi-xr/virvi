---
title: In-World HUD
description: Control and monitor your scenes from within Decentraland.
---

## Management and access control

The management HUD and all scene-changing messages now require a signed-in, verified user with permission for that scene. Visitors still receive scene updates. Clients receive `auth_status`, `venue_access` and `access_revoked` messages, and `virvi_error { code, messageType }` when a message is rejected. The error codes are:

- `forbidden` — the user lacks permission for the requested action
- `not_found` — the requested scene or resource does not exist
- `server_error` — the handler threw an unhandled exception

## Moving things in-world

Editors can move, rotate and resize placed models, images, screens and sounds without leaving Decentraland.

Open the Layout panel and press **Edit layout**. The button shows for editors, cohosts and hosts. Venue renters (and the crew they invite) never see it. Items have to be visible (synced) in your scene before you can edit them.

Click an item to select it, then pick a mode on the bar:

- **Move:** click and drag. The item lands where your pointer hits the scene. Tap **Shift** to cycle Free, X, Y, Z, then back to Free. The locked axis shows as a guide line (red for X, green for Y, blue for Z) and follows the scene's axes.
- **Rotate:** drag one of three rings. Hold **Shift** to turn in 15° steps.
- **Resize:** drag the corner handle to scale evenly, or an axis handle to stretch one way. The handles turn with the item, so a handle always stretches along the item's own side, even on a tilted screen. Images and screens are flat, so they have no depth handle. Hold **Shift** to snap (the corner in 10% steps, an axis handle in 0.25 m steps).

Changes are drafts until you press **Save**. Save stores them to the live preset only; the bar shows **Saving…** until the server confirms. If the save fails, or you're disconnected, the bar says so and your change stays as a draft so you can try again. **Revert** puts the item back. If you press **Done** with unsaved changes, you are asked what to do first.

While you hold an item, other editors see "being moved by" and your name on it and can't grab it until you save or revert. Visitors only ever see saved changes.

@virvixr/dcl needs Decentraland SDK 7.26 or newer (Shift was added in 7.23; the HUD's high-DPI scaling is reliable from 7.26).

## Uploading from in-world

Editors can add images and GLB models to the scene's library (the HUD's **Media Library** panel) while standing in it. This panel is the scene's own list; on the dashboard, images and video live in the Media Library and 3D models in the 3D Asset Library (see [Media Library and 3D Asset Library](/dashboard/media-library/)).

Open the Media Library panel and press **Upload**. The panel shows:

- **Open on this computer:** opens the upload page in your browser. Decentraland asks you to confirm opening the link.
- **A QR code:** scan it with your phone to upload a photo from your camera roll.
- **The link and a 6-character code**, in case you'd rather type it in.

Each link lasts 30 minutes and allows 10 uploads. Press **New link** for a fresh one. Only you can see the code; it's drawn in your own HUD, never in the scene. The link can only upload files to this scene's library. It doesn't sign anyone in. Uploaded files are stored at unguessable links: anyone with a file's link can open it.

Uploads appear in the Media Library straight away, newest first, with a status:

- **• Uploading / • Processing:** the file is on its way.
- **✓ Available:** ready to **Place**.
- **⟳ Needs sync:** a model you've placed that won't show until you run `npx @virvixr/dcl sync` and redeploy the scene. Models only render once they're deployed with the scene.
- **✕ Failed:** the reason is shown, for example when a file is too big. Press **Dismiss** to clear it.

Images can be up to 10 MB and models up to 50 MB. An editor's uploads count against the scene owner's storage. iPhone HEIC photos are usually converted to JPEG automatically; if one isn't, choose a JPEG or PNG instead.

## Streams, screens and showings

The Stream panel lists the live preset's video screens. For each one, editors can:

- **Choose stream:** pick one of the scene's streams, labelled "Main Stage (live)" or "Editor Cam (offline, yours)".
- **Turn live on / off.**
- **Change** the off image, the picture shown when the screen has nothing to play. It lists the Media Library's ready images (up to 8); **No off image** clears it.
- **Showings** (screens in Schedule mode): the screen's showings with **End now**, **Play now** and **Delay 5 min**. See [Scheduled Showings](/dashboard/scheduled-showings/).

The Hyperfy HUD's Streams panel, the Quest's builder Stream tab and the Vision Pro's Stream tab have the same stream, live and off-image controls. The Quest's Stream tab is on personal headsets only.

## Clearing copies

In the Layout panel, an item with copies shows how many (×3) and a **Clear** button. Clear asks first, then removes every copy in one step. The item stays, ready to place again.

## Click actions

From `@virvixr/dcl` 2.11.0, the Layout panel's **Click** button sets what clicking an image, model or screen does. See [Click Actions](/dashboard/click-actions/).


## Frames

From `@virvixr/dcl` 2.12.0, the Layout panel's **Frame** button puts a frame around an image or video screen: **Off**, **Thin** (one slim modern border), **Classic** (a deeper, raised border, wood by default) or **Gallery** (a white mat with a slim frame around it), with a colour swatch and a thickness. Press **Save** and the frame shows at once, on every copy of the item. Thickness is a share of the picture's shorter side, so the frame stays in proportion when you resize it. The scene editor's image and video screen cards have the same **Frame** setting, with any colour. Ad spaces have no frame.

A frame shows the same from both sides of the picture. Each framed copy adds 4 objects to the scene (8 for Gallery), and these count toward Decentraland's object limit for your parcels: publishing tells you if frames take the scene over it, and in-world a frame that would go over the limit is left off. The picture itself still shows.
