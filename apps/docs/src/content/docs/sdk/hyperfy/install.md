---
title: Hyperfy Setup
description: Show a Virvi scene in your own Hyperfy world with the Virvi app.
---

The **Virvi app** is a small Hyperfy app (a `.hyp` file) that shows one of your Virvi scenes in a Hyperfy world you run yourself. It reads the scene from Virvi and follows your edits, so you manage the scene in the dashboard and the world keeps up.

## What you need

- A plan that includes deployment (Creator and up).
- Full access to the scene you want to show.
- A self-run Hyperfy world where you can add apps.

## Connect a world

1. In the dashboard, open **Deploy** and pick the scene.
2. Under **Your Hyperfy worlds**, choose **Connect a world** and give it a name.
3. A one-time panel shows the **world key**, a **Download Virvi app (.hyp)** link and the setup steps. Copy the key now: you won't see it again.

Each connected world is listed with its name, the start of its key and when it was last seen.

## Install the app

1. Drag `virvi.hyp` into your Hyperfy world.
2. Open the app's settings and paste the key into **Virvi world key**.
3. Leave **Virvi feed URL** as `https://api.virvi.io`.

The scene appears within a few seconds, and later edits show up in about a second.

Moving or scaling the Virvi app in Hyperfy moves or scales the whole scene in that world only. It never changes the scene in Virvi.

## What renders

- **Video screens:** the live stream when the screen is live and live streaming is on. Otherwise the playlist's first video loops, or the off image shows, depending on the screen's offline mode.
- **Images**
- **3D models**
- **Sounds**
- **External links:** clicking an element with an external link opens it in a new tab.

Media Hyperfy can't play, such as gifs and webm videos, is skipped and the rest of the scene still shows.

Not yet supported: ad spaces and ad modes, NFTs, widgets and claim points.

## Editing from inside Hyperfy

Admins and builders in a Hyperfy world get a Virvi bar at the top of the screen. It lets you change the scene without leaving the world. Visitors see nothing.

### Link the world to your Virvi account

1. In the world, press **Link to Virvi** in the bar.
2. The HUD shows a code (like `ABC-123`) and a link and QR code to `virvi.io/pair/<code>`.
3. Open the link, sign in on virvi.io and approve.

Only people with editing access to the world's Virvi scene can approve: the scene's owner, an admin, cohost or editor, or a booking host during their booking.

Hosted worlds remember the link for that browser until you revoke it or it goes unused for 90 days. Worlds you run yourself pair on each visit, and a link lasts 12 hours at most.

### What you can do

- **Move, rotate and resize** objects with the gizmo.
- **Show or hide** objects, and **switch presets**, in **Scene layout**.
- **Go live or offline** on video screens, in **Streams**.
- **Place models** from the scene library, the catalog or a GLB link, in **3D Models**. The model is placed 2 m in front of you. Models added this way need a Decentraland redeploy to appear there, and the HUD says so.

Press **Edit** to turn on edit mode, then **Save** to keep your changes, **Revert** to drop them or **Done** to leave.

### Controls

- With the pointer locked (normal play), click an object to select it. Click the selected object again and hold the mouse button to drag it; the drag follows where you look. Click a gizmo handle to drag along that axis.
- Press **L** to cycle the axis lock (free, X, Y, Z). Shift is Hyperfy's run key, so it isn't used.
- Press `` ` `` (backquote) or **Esc** to unlock the pointer and click the bar and panels. Click the world to lock the pointer again.
- To type a value or a catalog search, click the field and type. Digits, `-` and `.` work in value fields. Enter confirms and Esc cancels.
- To place a model from a GLB link, type `/virvi` and the link in Hyperfy's chat, for example `/virvi https://example.com/chair.glb`. Pressing `/` opens chat with the slash already typed, so then type `virvi` and the link. Pasting works there. The **Link** tab opens with the link, and the message isn't shown in chat. `/virvi` followed by words searches the catalog.

### Revoking a link

Go to your account settings and find **Linked Hyperfy sessions**. Choose **Revoke** on a session. It stops working immediately.

### Who to make a builder

Hyperfy builders can edit app scripts and props in a world, so only give builder rights to people you trust with your Virvi scene. The world's Virvi secret itself never reaches scripts.

## Analytics

Visitors show up in [Virvi Analytics](/dashboard/analytics) under a **Hyperfy** location for that world. Hyperfy players have no wallets, so they count as unverified guests, and no names are recorded.

## Hosted worlds

Don't want to run Hyperfy yourself? Virvi can host a world for you. Under **Create a hosted world** on the **Deploy** page, give it a name and, if you like, an end date. It is ready within a few minutes, with the Virvi app already installed and showing your scene. Hosted worlds appear only where Virvi has hosting turned on.

### How many you get

| Plan | Hosted worlds |
|---|---|
| Free | 0 |
| Creator | 1 |
| Pro | 3 |
| Studio | 10 |
| Enterprise | Unlimited |

A world counts from the moment you create it, whether or not anyone is in it. Worlds that have ended, worlds that failed to start and worlds you connect yourself don't count. If you downgrade and end up over your limit, your existing worlds keep running, but you can't create new ones until you're back under it. On a Virvi install you run yourself with every feature unlocked, there is no limit.

### Addresses

A world's address is fixed for its life. Worlds created on Creator get `vlm-w-<name>.fly.dev`. Worlds created on Pro or higher get `<name>.worlds.virvi.io`. The name comes from the world's name, in lowercase letters, numbers and dashes, with `-2`, `-3` and so on added if it is taken. Upgrading or downgrading never moves a world.

### Admin code

Creating a world shows its **admin code** once. In the world's chat, type `/admin <code>` to build. If you lose it, choose **Show admin code** on the world's row. Anyone with full access to the scene can do this. A world also has a world key, like a world you run yourself, which you can replace with **New key**.

### Temporary worlds

The end date is optional. Until it passes you can move it with **Edit end date**, or choose **Make permanent** to clear it. On the end date the world stops, its address stops answering and it no longer counts against your limit.

Virvi keeps an ended world's data, address and key for 30 days. Choose **Restore** on its row to bring it back, as long as you have a free hosted world. A restored world has no end date, so it stays until you set a new one. After 30 days the world is deleted for good.

### Destroying a world

**Destroy** deletes the world and everything built in it, including its uploaded files and its address, straight away. It can't be restored, unlike a world that has ended.

## Keys

- **New key** replaces the key. The old one stops working at once, so paste the new key into the app.
- **Remove** disconnects the world.

The world key is readable by anyone in the world, because Hyperfy shares app settings with every visitor. It only lets someone read the scene the world already shows and report visits. If your analytics look spammed, rotate the key.
