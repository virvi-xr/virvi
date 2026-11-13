---
title: Widgets
description: Widget elements store a control value in a scene's preset; the current SDK doesn't pass them to scene code yet.
---

A widget is a scene element that holds one control value, such as an on/off switch or a number, which you set from the dashboard.

## Current status

- **Dashboard:** a scene's editor has a **Widgets** section. You can add a widget, pick its control type and set its value. It is saved in the preset like any other element.
- **SDK:** `@virvixr/dcl` 2.14.0 does **not** pass widgets to scene code. `virvi.storage.widgets` stays empty, and the `widgets` option in `VirviInitConfig` is accepted but not used. There is no `onWidgetChange` or `onWidgetClick`.
- **Hyperfy app:** widgets aren't supported.

So today a widget's value can't drive your scene through the SDK.

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

## What to use instead

- **A switch you flip from the dashboard:** make two presets and switch between them (dashboard, HUD, or `POST /api/presets/:presetId/activate`). Every player gets the change.
- **Show or hide one item:** `PUT /api/elements/:elementId` with `{ "enabled": false }` (or `true`). Connected players see the change.
- **Live values between players:** [Multiplayer Events](/docs/custom-features/multiplayer-events/).
- **Reading widget values from a backend:** `GET /api/scenes/:sceneId` returns the scene's presets and their elements, widgets included. It needs a sign-in or [API key](/docs/api/authentication/#api-keys) with access to the scene, so call it from your own server, never from scene code.
