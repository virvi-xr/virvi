---
title: Click Actions
description: Make a placed image, model or video screen do something when a visitor clicks it.
---

A placed image, model or video screen can do something when a visitor clicks it.

## Actions

- **Open a link.** Decentraland always asks the visitor before it opens.
- **Play a sound**, from the Media Library or a link (an mp3 or ogg).
- **Move the visitor** to a spot in the scene (x, y, z in metres), optionally turning the camera to look at another spot.
- **Teleport** the visitor to a parcel, such as `52,-20`.

Each action has **hover text** (up to 60 characters), shown when a visitor points at the item, and an optional highlight.

## Setting an action

On the dashboard, open the scene, pick the item, and use **On click: … Edit**.

Each copy of the item uses the item's action. To give one copy its own, use **Set for this copy** on that copy; **Use the item's** goes back.

From `@virvixr/dcl` 2.11.0, editors can also set an item's action in-world: in the HUD's Layout panel, press **Click** on an image, model or screen.

Actions are checked when they're saved. For example, a link must start with `https://` or `http://`, and a teleport needs parcel coordinates.

## Where actions run

| Action | Decentraland | Hyperfy |
| --- | --- | --- |
| Open a link | Yes | Yes |
| Play a sound | Yes | Yes |
| Move the visitor | Yes | Yes (without turning the camera) |
| Teleport to a parcel | Yes | No (parcels are Decentraland's) |
| Hover text | Yes | No (Hyperfy shows its pointer) |

Decentraland runs actions from `@virvixr/dcl` 2.10.0; redeploy your scene to get them. Hyperfy needs the latest `virvi.hyp`. The Quest and Vision Pro apps don't run click actions yet.

A video screen showing ads keeps the ad's link instead of its own action.

## In the backup

The Virvi-free backup download includes each item's click action as plain Decentraland SDK7 code. Actions it can't carry are listed in its README.
