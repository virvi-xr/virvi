---
title: Decentraland SDK Changelog
description: What changed in each release of @virvixr/dcl, the Virvi SDK for Decentraland scenes, newest first.
sidebar:
  order: 50
---

This page lists what changed in each release of `@virvixr/dcl`, from 2.5.0 on. Scenes built by the Virvi dashboard get these updates when you redeploy them from the dashboard. Scenes you build yourself update when you raise `@virvixr/dcl` in `package.json` and redeploy. See [Decentraland Setup](/docs/sdk/decentraland/install/) for installing and upgrading.

When a scene is behind, its page in the dashboard says which version it runs, lists what's new since then and links here.

No release so far has needed changes to scene code, so none is marked as breaking.

## 2.24.0 — unreleased

- **Editing in an area:** an editor whose role is limited to an area of the scene (a tenant) can edit from the HUD. They can place, move and remove items inside their area, and the Layout panel says where it is. An edit outside the area is refused with a message naming the area. Presets, streams and raffles stay with the host, co-hosts and full editors.
- **Widgets for scene code:** `onWidgetChange`, `onWidgetClick`, `getWidgetValue` and `listWidgets`, `virvi.storage.widgets`, and the `widgets` option's handlers and defaults now work. Scene code hears a widget the moment it changes on the dashboard. See [Widgets](/docs/custom-features/widgets/).
- **Scene state:** `virvi.state` (`get`, `all`, `set`, `delete`, `on`) is a small shared key-value store per scene, saved by Virvi. Every visitor sees the same values, and late joiners get them on arrival. Editors write by default; a scene setting lets every visitor's scene code write too. See [Scene State](/docs/custom-features/scene-state/).

## 2.23.0 — 2026-11-27

- **Sound plays:** the scene records when a sound starts playing, by the sound's name, for the scene's analytics. The Analytics page lists each sound's plays under Screens and sounds. Visitors who decline analytics aren't recorded, as before.

## 2.22.0 — 2026-11-25

- **Update notice:** when a newer release is out, hosts, co-hosts and editors see a line under the HUD's tabs saying so, with how to update. Visitors and viewers don't see it.

## 2.21.1 — 2026-11-25

- **Version reporting:** the scene reports its own version to Virvi. 2.20.0 and 2.21.0 reported the release before theirs, so the dashboard could show them one version behind.

## 2.21.0 — 2026-11-25

- **BEAT auto-claim:** when a BEAT has auto-claim on, a visitor who agrees to attendance tracking gets the BEAT claimed for them once they have been there long enough. The card says "Your BEAT is on its way."
- **New consent text:** the BEAT card shows an updated agreement that mentions auto-claim. Visitors in scenes on older versions still agree to the old text and press Claim themselves.

## 2.20.0 — 2026-11-24

- **Visitor privacy notice:** every Virvi scene with analytics shows a notice with Accept and Decline and a link to the privacy page. It never blocks movement.
- **Privacy entry:** once a visitor has decided, a small Privacy entry stays at the foot of the card column so they can change their mind.
- **Nothing is sent before a decision:** analytics wait for the visitor's choice. If they decline, nothing more is recorded and ad views are no longer counted. Ads still show.

## 2.19.0 — 2026-11-24

- **Giveaway kiosks:** a scene with kiosks shows the giveaway card when a visitor clicks a kiosk, with a Close button. It says "Not open right now" if that kiosk's giveaway isn't the open one.
- **Kiosk look:** a kiosk can draw a booth around the item, or show the item alone, such as an image, a model or a mannequin.
- **Mannequins:** a mannequin can show a base male or female body, or dress like the visitor, in the giveaway's wearables.
- Scenes with no clickable kiosk keep the card that shows by itself.

## 2.18.0 — 2026-11-23

- **Giveaway card:** scenes running Virvi show the scene's open giveaway. Visitors agree, see the time left, then press Claim. The card then says "On its way" and later "Sent" with a View link.
- **Stop tracking:** the card offers it while a claim is in progress.
- **Guests:** visitors without a wallet see a short "Connect a wallet" notice.

## 2.17.0 — 2026-11-16

This is the BEAT card as it ships for mainnet.

- **Clearer consent:** the agreement now names the 30-second check-ins and the permanent public record on Polygon. It has an I agree button and larger text that shows in full.
- **Stop tracking:** it stays on the card until a claim, including when the BEAT is sold out or over.
- **Better status text:** the card says when a BEAT starts and that time counts from then. It tells a final failure from a retry, and explains claims the host is checking or removed.
- **Blocked wallets:** the HUD tells a visitor whose wallet is blocked that they can no longer use Virvi.
- Scenes on older versions can't take a visitor's BEAT agreement. They show "this scene needs an update" until you redeploy.

## 2.16.0 — 2026-11-14

- **BEAT card:** visitors get an in-world card to agree to attendance tracking, see their progress and claim their BEAT.
- **Guests:** visitors without a wallet see a one-time "Connect a wallet" notice.
- **Test BEATs:** BEATs on the test network show a Test label.

## 2.15.0 — 2026-11-13

- **Raffle card:** visitors can enter a raffle, withdraw, read the rules and see a drum-style wheel when the draw happens, then the full list of winners.
- **Raffle tab:** hosts, co-hosts and editors get a Raffle tab in the HUD with Open, Snapshot, Spin and Close.
- **Missed draws:** a winner who dropped out during the draw sees "You won!" when they come back.

## 2.14.0 — 2026-11-13

- **HUD version tracking:** the HUD now reports which release it runs. The scene page in the dashboard says when a scene is behind and asks you to redeploy.
- **Scene Library:** the in-world panel is called Scene Library, since it holds both models and images.
- **License:** the package is now under Apache-2.0.

## 2.13.0 — 2026-11-08

- **3D Models panel:** the HUD's library panel for models is renamed from Media Library to 3D Models. Models uploaded in-world land there.
- Includes the frames from 2.12.0.

## 2.12.0 — 2026-11-07

2.12.0 was never published to npm. Its changes arrived in 2.13.0.

- **Frames:** images and video screens can have a frame: Thin, Classic or Gallery, with a colour and a thickness. Frames are off by default.
- **Frame button:** the HUD's Layout panel has a Frame button to set them.
- **Entity limit:** frames never push a scene over Decentraland's entity limit. If one would, it is left off and the picture stays.

## 2.11.0 — 2026-11-07

- **Models on the map:** Virvi-built scenes now carry a snapshot of their placed models. Models show on the Decentraland map and in the distant view, instead of blank parcels.
- **No visible change in the live scene:** the live scene takes over the snapshot's models when it connects.
- **For scene builders:** the package exports `placeDeployedModels()` to place that snapshot.

## 2.10.1 — 2026-11-05

- **Type fix:** the package now ships self-contained type files. Versions 2.4.0 to 2.10.0 failed a scene's type check with a missing-module error. Use 2.10.1 or newer.

## 2.10.0 — 2026-11-05

- **Click actions:** items you place can run an action when a visitor clicks them. The action can open a link (Decentraland asks first), play a sound, move the visitor, or teleport them to a parcel.
- **Hover text:** each action can have its own hover text.
- **Per copy:** a copy of an item can have its own action, or use the item's.

## 2.9.0 — 2026-11-05

- **Showings list:** screens in Schedule mode get a Showings list in the Stream panel, with End now, Play now and Delay 5 min.
- **Refusals:** if a control is refused, the HUD shows the server's reason.

## 2.8.0 — 2026-11-05

- **Stream panel:** pick each video screen's live stream, and turn it on or off.
- **Off image:** choose a screen's off image from the scene library.
- **Clear:** remove every copy of an element from the Layout panel. The element itself stays.
- **Next switch:** the Presets section shows the next scheduled preset switch, with Skip and Undo.

## 2.7.0 — 2026-11-04

- **Scheduled showings:** video screens can play scheduled showings. Visitors see the same second of the same video, even if they arrive mid-film. A countdown and a "Now showing" sign appear on the screen.
- **Drift correction:** a player that falls behind the shared clock is pulled back.
- **Presets:** hosts, co-hosts and editors can see, create, rename and switch presets in the Events panel. The old Switch Preset button, which didn't work, is gone.
- **Model colliders:** models with collisions now use their own shape instead of a flat plane.

## 2.6.0 — 2026-11-03

- **Missing icon:** if the scene was deployed without the HUD launcher icon, the launcher shows a plain V instead of a white square. It logs how to fix it.
- **Edit errors:** the HUD says why it can't edit: signed out, disconnected, no permission, or "This scene needs a redeploy to edit".
- **Reconnect:** the HUD rejoins a dropped room on its own.

## 2.5.0 — 2026-11-01

- **Named items:** Virvi's items are named after their elements. Other clicked objects are named by their own name, their parent or their model file. Analytics Interactions no longer show entity numbers.
