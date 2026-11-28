---
title: Custom Rendering
description: Draw an image, video screen, model or sound yourself instead of Virvi, with onElementCreate, onElementUpdate and onElementDelete.
---

Virvi draws every image, video screen, model and sound in the live preset for you. From `@virvixr/dcl` 2.24.0 your scene's code can take over drawing some of them, or all of them. Virvi then keeps their data current and tells your code when to draw, change or remove them.

## What gets handed over

- **One element:** set its `customRendering` to `true`, with `PUT /api/elements/:elementId` and `{ "customRendering": true }`. Virvi stops drawing it and all its placed copies.
- **One placed copy:** set the instance's `customRendering` to `true` with `PUT /api/instances/:instanceId`. Virvi still draws the element's other copies.
- **Everything:** `createVirvi({ customRendering: true })`. Virvi draws no images, screens, models or sounds at all.

Only those four types are handed over. Widgets, ad spaces and giveaway kiosks behave as before.

Turning `customRendering` off again gives the element back to Virvi: your code gets a delete, and Virvi draws it.

## Drawing it yourself

```typescript
import { createVirvi } from '@virvixr/dcl'
import { engine, Transform, MeshRenderer, Material } from '@dcl/sdk/ecs'

export async function main() {
  const virvi = await createVirvi()
  const drawn = new Map<string, ReturnType<typeof engine.addEntity>>()

  // `instance` is set when the call is about one placed copy; without it, it's about the element as a whole
  virvi.onElementCreate((type, element, instance) => {
    if (type !== 'image' || !instance) return
    const e = engine.addEntity()
    Transform.create(e, { position: instance.position, rotation: instance.rotation, scale: instance.scale })
    MeshRenderer.setPlane(e)
    Material.setBasicMaterial(e, { texture: Material.Texture.Common({ src: element.imageSrc }) })
    drawn.set(instance.sk, e)
  })

  virvi.onElementUpdate((type, element, instance) => {
    const e = instance && drawn.get(instance.sk)
    if (e) Transform.createOrReplace(e, { position: instance.position, rotation: instance.rotation, scale: instance.scale })
  })

  virvi.onElementDelete((type, element, instance) => {
    const e = instance && drawn.get(instance.sk)
    if (e) { engine.removeEntity(e); drawn.delete(instance.sk) }
  })
}
```

- `type` is `image`, `video`, `model` or `sound`.
- `element` is the element's full data: `sk` (its id), `customId`, `name`, its type's fields (`imageSrc`, `modelSrc`, `audioSrc` and so on) and `instances`.
- `instance` is one placed copy: `sk`, `position`, `rotation`, `scale` and its own fields.
- Each call gets the **full new data**, not just what changed. A hidden element or copy counts as deleted, and showing it again counts as created.
- Each function returns an unsubscribe.

Register the callbacks right after `createVirvi()`. The scene's elements arrive once it connects.

## Reacting to any change

`onStorageChange` fires for every change to the scene's elements, whether Virvi draws them or not, so code that only wants to react (refresh a menu, say) doesn't need custom rendering:

```typescript
virvi.onStorageChange(({ action, type, id }) => {
  // action: init (a whole preset arrived), create, update, upsert or delete
  refreshMenu(virvi.storage)
})
```

`virvi.storage` holds every element's data, custom-rendered ones included, keyed by custom id (or element id).

## Editing

The dashboard and the REST API edit custom-rendered elements as usual, and every change reaches your callbacks. The [In-World HUD](/docs/dashboard/in-world-hud/) can't select what it didn't draw, so pick custom-rendered items from its panels, not by clicking them in the world.

Scenes on 2.23.0 or older ignore `customRendering`, and Virvi draws everything. The Hyperfy app and AR Spaces have no scene code to hand things to, so they ignore it too and draw as usual.
