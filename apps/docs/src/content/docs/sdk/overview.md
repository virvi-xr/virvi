---
title: SDK Overview
description: Which Virvi package to install, how the SDK packages fit together, and what a scene's code can do with Virvi.
---

## Which package to install

| You are building | Install | Notes |
|---|---|---|
| A Decentraland SDK 7 scene | `@virvixr/dcl` (2.15.0) from npm | The only Virvi SDK package on npm. See [Decentraland Setup](/docs/sdk/decentraland/install/). |
| A Hyperfy world | The Virvi app (`virvi.hyp`) | Downloaded from your Virvi server, not npm. See [Hyperfy Setup](/docs/sdk/hyperfy/install/). |
| A script, bot or backend | Nothing | Call the [REST API](/docs/api/rest-reference/) with an [API key](/docs/api/authentication/#api-keys). |
| A platform that can only make HTTP calls | Nothing | Use the [platform hooks](/docs/api/rest-reference/#platform-hooks) (`/hook/*`). |
| Support for a new platform | The monorepo | See [Building an Adapter](/docs/sdk/building-an-adapter/). |

## The packages inside

`@virvixr/dcl` bundles the workspace packages below. They live in `packages/` in the repo, are marked private, and are not published to npm on their own: import from `@virvixr/dcl` in a Decentraland scene.

| Package | Purpose |
|---|---|
| `@virvixr/shared` | Types, enums, the `VirviPlatformAdapter` interface, protocol types |
| `@virvixr/client` | HTTP client (`VirviHttpClient`) and Colyseus WebSocket manager |
| `@virvixr/core` | The `Virvi` class, `SceneManager`, element managers (video, image, model, sound, ad space) |
| `@virvixr/hud` | The in-world management HUD |
| `@virvixr/adapter-dcl` | The Decentraland SDK 7 adapter and `createVirvi()` |
| `@virvixr/hyperfy-app` | Builds the Hyperfy app (`virvi.hyp`) |

## How it works

1. `createVirvi()` makes a platform adapter and a `Virvi` instance.
2. It signs in to the Virvi server with the platform's identity (in Decentraland, a signed request from the player's wallet).
3. It joins the scene's real-time room (`virvi_scene`) and receives the live preset.
4. Core's element managers call the adapter to draw every element.
5. When someone edits the scene in the dashboard or the HUD, the room sends the change and core applies it.

```typescript
import { createVirvi, type Virvi } from '@virvixr/dcl'

/** Run fn once Virvi has joined the scene's room (now, if it already has). */
function whenConnected(virvi: Virvi, fn: () => void) {
  if (virvi.connectionState === 'connected') return fn()
  const off = virvi.onStateChange((state) => {
    if (state === 'connected') { off(); fn() }
  })
}

export async function main() {
  const virvi = await createVirvi()

  // Handlers can be added at any time
  virvi.onMessage('game-event', (data) => console.log('got', data))

  // Sending needs the room: before it is joined, sendMessage throws "Not in a room"
  whenConnected(virvi, () => virvi.sendMessage('game-event', { score: 100 }))

  // A custom analytics event
  virvi.track('level-complete', { level: 3 })
}
```

`createVirvi()` can resolve before the scene has loaded: for example while the owner sees "Set up Virvi here", or while it connects in the background. Wait for `connected`, as above, before you send messages or read `storage`.

## The Virvi object

What `createVirvi()` resolves to. These are the members meant for scene code.

| Member | What it does |
|---|---|
| `sendMessage(id, data?)` | Sends `data` to every other client in the scene's room. Not to yourself. See [Multiplayer Events](/docs/custom-features/multiplayer-events/). |
| `onMessage(id, callback)` | Calls `callback(data)` when a message with that `id` arrives. One callback per `id`; a second call replaces the first. |
| `track(name, props?)` | Records a custom analytics event. |
| `recordAction(id, metadata?)` | Deprecated name for `track()`. |
| `storage` | Read-only view of the scene's elements. See [Storage](#storage). |
| `sceneId` | The connected Virvi scene's ID, or `null`. |
| `user` | The signed-in user (`id`, `displayName`, `role`), or `null`. |
| `connectionState` | `idle`, `authenticating`, `authenticated`, `discovering_scene`, `scene_ready`, `connecting`, `connected` or `error`. |
| `onStateChange(listener)` | Calls `listener(state, detail?)` on every change. Returns a function that removes it. |
| `onActivePresetChanged(listener)` | Calls `listener(presetId)` when the live preset changes. Returns a remover. |
| `destroy()` | Leaves the room and stops. |

There is no per-user key-value store in the SDK. See [Scene State](/docs/custom-features/scene-state/) for what to use instead.

## Storage

`virvi.storage` holds the live preset's elements, keyed by each element's custom ID (or its internal key when it has none). Each store has `configs` (elements) and `instances` (placed copies).

```typescript
virvi.storage.videos.configs['my-screen']
virvi.storage.images.configs['banner']
virvi.storage.models.configs['trophy']
virvi.storage.sounds.configs['ambient']
```

The stores are `videos`, `images`, `models`, `sounds`, `adSpaces`, `nfts`, `claimPoints` and `widgets`. The SDK fills the first five. Read them; don't write to them.
