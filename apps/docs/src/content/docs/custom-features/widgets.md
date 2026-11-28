---
title: Widgets
description: Widgets store a control value in a scene's preset, set on the dashboard, and scene code reacts to them with onWidgetChange and onWidgetClick.
---

A widget is a scene element that holds one control value, such as an on/off switch or a number, which you set from the dashboard.

## Rules: make a widget do something, no code

On the scene's **Widgets** tab, under **Rules**, choose **+ Add rule** and pick:

1. **When:** an image, video screen or model being **clicked in-world**, or a widget and what it does. A **Toggle** can be turned on, turned off, or switched either way. A **Trigger** is pressed. A **Date and time** widget's date and time arrives, in the time zone you pick (your own, to start with). Any widget can also just change.
2. **Do:** one or more actions, run in order (up to 10):
   - **Show**, **Hide**, or **Show or hide (switch)** an item of the preset.
   - **Switch to the preset** you pick.
   - **Show the item for the chosen option** (for a rule that starts from a **Selector** changing): give each option an item, and choosing an option shows its item and hides the others'. That's a video picker: one screen per film, and the Selector picks which one is showing. With nothing chosen, all of them are hidden.
   - **Set the volume from the slider** of a sound or video screen (for a rule that starts from a **Slider** changing): the slider's 0 to 100 becomes the volume, so 30 plays at 30%.
   - **Set the brightness from the slider** of an image or video screen (also from a **Slider**): 0 is unlit and 100 is fully bright (Virvi's default is 60). Decentraland draws brightness; Hyperfy and AR Spaces don't, so there it does nothing.

For example: *When Stage lights is turned off, hide Light rig 1, then hide Light rig 2.*

Rules run on Virvi's servers the moment a widget changes (or a timed rule's time arrives, or an item is clicked), whether the widget changed on the dashboard, in the in-world HUD, from the Virvi Assistant or through the API. So widget and timed rules work the same in Decentraland, Hyperfy and AR Spaces, for everyone in the scene, on any SDK version, with no redeploy.

- Each preset has its own rules, up to 50. Copying a preset copies its rules too.
- Switch a rule off with its **On** box to keep it without running it.
- Rules never change widgets, so a rule can't set itself off.
- The scene's Activity tab shows each change a rule made, and whose widget change set it off.

### Timed rules

A timed rule runs once when its widget's date and time arrives, within about 20 seconds. For example: *When the date and time in Doors open arrives (Europe/London time), hide Gate, then switch to the preset Show time.*

- To run it again, set a new date and time on the widget, on the dashboard, in the HUD or through the API.
- A date and time already more than 10 minutes in the past when it's set is skipped, rather than running late.
- The Activity tab shows timed rules' changes as done by **Virvi**.

### Click rules

A click rule runs when anyone in the scene clicks the item, such as a light switch on a wall: *When someone clicks Wall switch, show or hide Lamp.* Everyone sees the result.

- Visitors don't need a role: anyone can click. Clicks are limited per visitor (a short burst, then a few a second).
- An item with a click action (open a link, play a sound and so on) still does that too.
- Click rules work in Decentraland scenes on `@virvixr/dcl` 2.24.0 or later, and in Hyperfy worlds running Virvi app 1.2.0 or later (download the app again from the scene's Sync page and drag it into the world). AR Spaces don't send clicks to rules yet.

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
- `virvi.storage.widgets.configs` holds every widget by its element id. A Selector's widget has its `options`, and its value is the chosen option.
- Each press of a **Trigger** on the dashboard stores the press time, so `onWidgetClick` fires once per press.
- The `widgets` option's `init` runs when the widget first appears, `update(value)` on each change, and `delete` when it goes.

Hosts, co-hosts and editors can also change widgets in-world, from the HUD's **Widgets** tab (see [In-World HUD](/docs/dashboard/in-world-hud/#widgets)). `onWidgetChange('*', …)` listens to every widget.

Scenes on 2.23.0 or older don't pass widgets to scene code: update `@virvixr/dcl` and redeploy.

## In a Hyperfy world

A Hyperfy world has no scene code, so from Virvi app 1.3.0 the app tells the world's other apps about the scene's widgets with world events. Your own app's script can listen, on the server or in each visitor's client:

```js
world.on('virvi:widget', (w) => {
  // w: { id, customId, name, type, value, options, removed? }
  if (w.name === 'Stage lights') lights.visible = w.value === true
})

world.on('virvi:widget-click', (w) => {
  if (w.name === 'Fireworks') launch()
})
```

- `virvi:widget` comes once for every widget when the Virvi app gets the scene, then each time one changes. A widget that's removed or hidden comes once more with `removed: true`.
- `virvi:widget-click` comes when a Trigger is pressed.
- `type` is the control type number (see the table below), and a Selector's `value` is its chosen option, from `options`.
- Listen as your app starts: the first round comes when the Virvi app gets the scene, a few seconds after the world opens.

For changes that need no code at all, use [rules](#rules-make-a-widget-do-something-no-code).

## Control types

The control types (`WidgetControlType` in `@virvixr/shared`):

| Value | Type |
|---|---|
| 0 | None |
| 1 | Toggle |
| 2 | Text |
| 3 | Selector: its options (`properties.options`, set on the dashboard as a comma-separated list) and the chosen one (`value`, a string; empty when nothing is chosen) |
| 4 | Date and time |
| 5 | Trigger |
| 6 | Slider |

## Other ways to drive a scene

- **A switch you flip from the dashboard:** make two presets and switch between them (dashboard, HUD, or `POST /api/presets/:presetId/activate`). Every player gets the change.
- **Show or hide one item:** `PUT /api/elements/:elementId` with `{ "enabled": false }` (or `true`). Connected players see the change.
- **Live values between players:** [Multiplayer Events](/docs/custom-features/multiplayer-events/).
- **Reading widget values from a backend:** `GET /api/scenes/:sceneId` returns the scene's presets and their elements, widgets included. It needs a sign-in or [API key](/docs/api/authentication/#api-keys) with access to the scene, so call it from your own server, never from scene code.
