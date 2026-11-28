---
title: Widgets
description: Widgets store a control value in a scene's preset, set on the dashboard, and scene code reacts to them with onWidgetChange and onWidgetClick.
---

A widget is a scene element that holds one control value, such as an on/off switch or a number, which you set from the dashboard.

## Rules: make a widget do something, no code

On the scene's **Widgets** tab, under **Rules**, choose **+ Add rule** and pick:

1. **When:** a widget, and what it does. A **Toggle** can be turned on, turned off, or switched either way. A **Trigger** is pressed. Any other widget changes.
2. **Do:** one or more actions, run in order (up to 10):
   - **Show**, **Hide**, or **Show or hide (switch)** an item of the preset.
   - **Switch to the preset** you pick.

For example: *When Stage lights is turned off, hide Light rig 1, then hide Light rig 2.*

Rules run on Virvi's servers the moment a widget changes, whether it changed on the dashboard, in the in-world HUD, from the Virvi Assistant or through the API. So they work the same in Decentraland, Hyperfy and AR Spaces, for everyone in the scene, on any SDK version, with no redeploy.

- Each preset has its own rules, up to 50. Copying a preset copies its rules too.
- Switch a rule off with its **On** box to keep it without running it.
- Rules never change widgets, so a rule can't set itself off.
- The scene's Activity tab shows each change a rule made, and whose widget change set it off.

Timed rules (a date and time arriving), item clicks as triggers, and setting volume or brightness from a slider are coming later.

## In your scene's code

From `@virvixr/dcl` 2.24.0, scene code gets every widget of the live preset, and hears changes the moment they're saved on the dashboard. Name a widget by its **custom id**, its **name**, or its element id.

```ts
import { createVirvi } from '@virvixr/dcl'

const virvi = await createVirvi({
  // Optional: handlers and a default value per widget, used until the widget is in the scene
  widgets: [{ id: 'stage-lights', value: false, update: (on) => setLights(on === true) }],
})

// Or listen by name; returns an unsubscribe
const stop = virvi.onWidgetChange('Doors open', (value) => showDoorTime(String(value ?? '')))

// A Trigger fires once per press
virvi.onWidgetClick('Fireworks', () => launchFireworks())

virvi.getWidgetValue('stage-lights') // the current value (or the default)
virvi.listWidgets()                   // every widget: id, customId, name, type, value
```

- `onWidgetChange` also fires when the widget first arrives with the scene, and with `undefined` when it's removed or hidden.
- `virvi.storage.widgets.configs` holds every widget by its element id.
- Each press of a **Trigger** on the dashboard stores the press time, so `onWidgetClick` fires once per press.
- The `widgets` option's `init` runs when the widget first appears, `update(value)` on each change, and `delete` when it goes.

Hosts, co-hosts and editors can also change widgets in-world, from the HUD's **Widgets** tab (see [In-World HUD](/docs/dashboard/in-world-hud/#widgets)). `onWidgetChange('*', …)` listens to every widget.

Scenes on 2.23.0 or older don't pass widgets to scene code: update `@virvixr/dcl` and redeploy. The Hyperfy app doesn't support widgets yet.

## Control types

The control types (`WidgetControlType` in `@virvixr/shared`):

| Value | Type |
|---|---|
| 0 | None |
| 1 | Toggle |
| 2 | Text |
| 3 | Selector |
| 4 | Date and time |
| 5 | Trigger |
| 6 | Slider |

## Other ways to drive a scene

- **A switch you flip from the dashboard:** make two presets and switch between them (dashboard, HUD, or `POST /api/presets/:presetId/activate`). Every player gets the change.
- **Show or hide one item:** `PUT /api/elements/:elementId` with `{ "enabled": false }` (or `true`). Connected players see the change.
- **Live values between players:** [Multiplayer Events](/docs/custom-features/multiplayer-events/).
- **Reading widget values from a backend:** `GET /api/scenes/:sceneId` returns the scene's presets and their elements, widgets included. It needs a sign-in or [API key](/docs/api/authentication/#api-keys) with access to the scene, so call it from your own server, never from scene code.
