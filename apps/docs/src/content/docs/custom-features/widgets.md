---
title: Widgets
description: Using widget elements to create custom UI controls within your Virvi scenes.
---

Widgets are special elements that let you add custom interactive UI controls to your scenes. They provide a way to build scene-specific interfaces beyond the standard video, image, model, and sound elements.

## What Are Widgets?

A widget is a UI element that appears in-world and responds to user interaction. Widgets are defined in the dashboard and can trigger actions in your scene code via the SDK.

Common uses include:

- Toggle buttons for scene features
- Selection menus for user preferences
- Information panels with dynamic content
- Voting or polling interfaces
- Custom control panels for interactive experiences

## Creating a Widget

1. Open the [Scene Editor](/docs/dashboard/scene-editor/).
2. Navigate to the **Widgets** section.
3. Click **Add Widget**.
4. Configure the widget:
   - **Type** — button, toggle, slider, dropdown, or text input
   - **Label** — display text for the widget
   - **Default value** — initial state
   - **Position** — where the widget appears in the scene

## Widget Types

| Type       | Description                          | Value Type |
| ---------- | ------------------------------------ | ---------- |
| Button     | Triggers an action on click          | None       |
| Toggle     | On/off switch                        | Boolean    |
| Slider     | Numeric range input                  | Number     |
| Dropdown   | Selection from a list of options     | String     |
| Text Input | Free-form text entry                 | String     |

## Handling Widget Events in Code

Use the Virvi SDK to listen for widget interactions:

```typescript
import { virvi } from "@virvi/sdk";

virvi.onWidgetChange("my-toggle", (value: boolean) => {
  // React to the toggle change
  if (value) {
    enableFeature();
  } else {
    disableFeature();
  }
});

virvi.onWidgetClick("my-button", () => {
  // React to button press
  triggerAction();
});
```

## Syncing Widget State

Widget state is synced through Colyseus like all other scene elements. When one user interacts with a widget, all connected users see the result if the widget is configured as shared. Widgets can also be set to per-user mode, where each user has their own independent state.

## Dashboard Control

Operators can set widget values from the dashboard or the [In-World HUD](/docs/dashboard/in-world-hud/), letting you control scene behavior remotely without writing additional code.
