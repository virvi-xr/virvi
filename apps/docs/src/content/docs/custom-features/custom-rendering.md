---
title: Custom Rendering
description: Using the customRendering flag to take control of element rendering instead of relying on Virvi's defaults.
---

By default, Virvi automatically renders all scene elements (videos, images, models, sounds) using built-in platform-specific renderers. The `customRendering` flag lets you override this behavior and handle rendering yourself.

## Why Use Custom Rendering?

Custom rendering is useful when you need to:

- Apply custom shaders or materials to elements
- Implement non-standard positioning or animation logic
- Integrate Virvi elements with an existing rendering pipeline
- Build advanced visual effects that go beyond Virvi's defaults
- Control exactly when and how elements appear

## Enabling Custom Rendering

Set the `customRendering` flag when initializing Virvi:

```typescript
import { virvi } from "@virvi/sdk";

await virvi.init({
  customRendering: true,
});
```

When enabled, Virvi still syncs element data (positions, URLs, properties) from the server, but does not create any visual objects in the scene. You receive the data and decide what to do with it.

## Handling Elements Manually

With custom rendering enabled, use event listeners to receive element data:

```typescript
virvi.onElementCreate((element) => {
  // Virvi has a new element — create your own visual representation
  const mesh = createCustomMesh(element);
  scene.add(mesh);
});

virvi.onElementUpdate((element) => {
  // Element properties changed — update your representation
  updateCustomMesh(element.id, element);
});

virvi.onElementDelete((element) => {
  // Element removed — clean up your representation
  removeCustomMesh(element.id);
});
```

Each element object includes all the data you need:

- `id` — unique element identifier
- `type` — video, image, model, or sound
- `instances` — array of instance transforms and overrides
- `properties` — type-specific data (URL, volume, loop, etc.)

## Per-Element Custom Rendering

You can also enable custom rendering on a per-element basis instead of globally. This lets Virvi handle most elements normally while you take control of specific ones:

```typescript
await virvi.init({
  customRendering: ["element-id-1", "element-id-2"],
});
```

Elements not in the list are rendered by Virvi as usual.

## Real-Time Updates

Custom rendering still benefits from Colyseus real-time sync. When a collaborator changes an element in the dashboard, your `onElementUpdate` callback fires with the new data. You are responsible for applying the change visually, but the data flow is automatic.

## Considerations

- You are responsible for all visual representation when custom rendering is active.
- Platform-specific behavior (Decentraland SDK, Hyperfy API) must be handled in your code.
- The [In-World HUD](/docs/dashboard/in-world-hud/) continues to work normally — it interacts with Virvi data, not the rendering layer.
