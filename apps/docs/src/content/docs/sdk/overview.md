---
title: SDK Overview
description: How the Virvi SDK works across platforms
---

The Virvi SDK is split into layered packages:

| Package | Purpose |
|---------|---------|
| `@virvixr/shared` | Types, enums, `VirviPlatformAdapter` interface, protocol types |
| `@virvixr/client` | HTTP client + Colyseus WebSocket manager |
| `@virvixr/core` | `Virvi` class, `SceneManager`, element managers (Video, Image, Mesh, Sound) |
| `@virvixr/hud` | In-world management HUD (optional) |
| `@virvixr/adapter-dcl` | Decentraland SDK 7 adapter |
| `@virvixr/hyperfy-app` | Virvi app for self-run Hyperfy worlds (see [Hyperfy Setup](/docs/sdk/hyperfy/install)) |

## How It Works

1. Your scene imports the platform-specific adapter (e.g., `@virvixr/adapter-dcl`)
2. The adapter creates a `Virvi` instance with itself as the platform implementation
3. `Virvi.init()` authenticates with the server, joins the Colyseus room, and receives the scene data
4. @virvixr/core's element managers call adapter methods to render everything
5. When the dashboard sends an update, @virvixr/core receives it and calls the adapter to apply changes

```typescript
// Decentraland scene
import { createVirvi } from '@virvixr/adapter-dcl'

const virvi = await createVirvi()

// Everything renders automatically. Developer APIs:
virvi.sendMessage('game-event', { score: 100 })
virvi.onMessage('game-event', (data) => console.log(data))
virvi.setState('high-score', 9999)
virvi.recordAction('level-complete', { level: 3 })
```

## The Virvi Class

The `Virvi` class is the main entry point. After `init()`:

| Method | Purpose |
|--------|---------|
| `sendMessage(id, data)` | Send a custom message to other clients in the room |
| `onMessage(id, callback)` | Listen for custom messages |
| `setState(key, value)` | Store persistent key-value state on the server |
| `getState(key)` | Retrieve stored state |
| `recordAction(id, metadata)` | Log a user action for analytics |
| `initHUD(renderer, limits)` | Initialize the in-world management HUD (optional) |
| `destroy()` | Clean up — sends session_end, leaves room |

## Storage

`virvi.storage` provides read-only access to all scene elements:

```typescript
virvi.storage.videos.configs['my-screen']   // video element by customId
virvi.storage.images.configs['banner']       // image element
virvi.storage.models.configs['trophy']       // 3D model element
virvi.storage.sounds.configs['ambient']      // sound element
```
