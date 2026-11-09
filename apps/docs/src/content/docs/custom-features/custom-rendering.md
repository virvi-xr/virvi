---
title: Custom Rendering
description: How to draw Virvi content your own way today, and what the stored customRendering flag does and doesn't do.
---

Virvi draws every image, video screen, model and sound in the live preset for you. The SDK has **no** option to turn that off: there is no `customRendering` setting in `createVirvi()` and no `onElementCreate`, `onElementUpdate` or `onElementDelete` callbacks.

## The customRendering field

Elements and instances have a `customRendering` field (default `false`). You can set it through the API, for example `PUT /api/elements/:elementId` with `{ "customRendering": true }`, and it comes back with the scene's data.

The SDK (`@virvixr/dcl` 2.13.0) ignores it: Virvi still draws the element. Treat it as a label your own code can read, not as a switch.

## Ways to draw content yourself

**Hide Virvi's copy and draw your own.** Set the element's `enabled` to `false` (`PUT /api/elements/:elementId` with `{ "enabled": false }`, or hide it in the dashboard or HUD) so Virvi doesn't draw it. Keep what your code needs in your own scene code or backend.

**Add effects next to Virvi's.** Let Virvi draw the element, and read its data from `virvi.storage` once connected:

```typescript
import { createVirvi } from '@virvixr/dcl'

export async function main() {
  const virvi = await createVirvi()
  virvi.onStateChange((state) => {
    if (state !== 'connected') return
    const screen = virvi.storage.videos.configs['main-screen'] // by custom ID
    if (screen) console.log('screen element', screen)
  })
}
```

`storage` is a read-only snapshot that Virvi updates as the scene changes. There's no change callback per element; read it when you need it, or react to `onActivePresetChanged` for preset switches.

**Write an adapter.** For full control over how every element is drawn on a platform, implement `VirviPlatformAdapter` yourself. See [Building an Adapter](/docs/sdk/building-an-adapter/). This is a monorepo-level change, not a scene-level one.

## Things that keep working

The [In-World HUD](/docs/dashboard/in-world-hud/) edits Virvi's data, not your drawing code, so it works the same whichever approach you take.
