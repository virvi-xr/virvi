---
title: API Reference
description: The VirviPlatformAdapter interface every platform adapter implements, and the PlatformCapabilities it reports.
---

This is the contract between `@virvixr/core` and a platform. You need it only to [build an adapter](/docs/sdk/building-an-adapter/). For the methods scene code calls, see [The Virvi object](/docs/sdk/overview/#the-virvi-object).

The source of truth is `packages/shared/src/platform.ts`. Methods marked *optional* may be left out.

## VirviPlatformAdapter

### Identity and sign-in

| Method | What it does |
|---|---|
| `getPlatformUser(): Promise<PlatformUser>` | The current player: `{ id, displayName?, walletAddress?, isGuest, avatarUrl? }` |
| `getAuthProof(): Promise<AuthProof>` | A proof of identity: `{ type, payload }`, where `type` is `'signed-fetch'`, `'wallet-signature'`, `'platform-token'` or `'api-key'` |
| `signedRequest?(url, init)` | *Optional.* Makes a request the server can verify (Decentraland's signed fetch). Returns `{ status, body }`. Without it, the server can't verify the player and signs them in as a guest |
| `hudProtocol?: number` | *Optional.* The HUD edit protocol, sent as `x-virvi-hud-protocol` |
| `analytics?`, `getAnalyticsScene?()` | *Optional.* Hooks for automatic analytics |

### Scene metadata

| Method | What it does |
|---|---|
| `getSceneInfo(): Promise<SceneInfo>` | The scene's ID and location |
| `getEnvironment(): Promise<PlatformEnvironment>` | Details of the running platform |

### Entities

| Method | What it does |
|---|---|
| `createEntity(): EntityHandle` | Creates an entity |
| `destroyEntity(handle): void` | Removes it |
| `entityExists(handle): boolean` | Whether it still exists |
| `adoptEntity?(instanceId)`, `releaseUnadopted?()` | *Optional.* Hand over entities the platform placed before live state arrived (Decentraland's deployed placements), then remove the ones nobody took |
| `setName?(entity, name)` | *Optional.* A display name, which analytics report for clicks. Without it, clicks on Virvi items are anonymous |
| `entityCount?()` | *Optional.* Entities in use. With `capabilities.maxEntities`, frames that would go over the limit are left off |

### Transform and rendering

| Method | What it does |
|---|---|
| `setTransform(entity, transform)` | Position, rotation and scale |
| `setPlaneRenderer(entity)` | A plane mesh (for images and video screens) |
| `setGltfModel(entity, src)` | A glTF/GLB model |
| `resolveModelSrc?(src)` | *Optional.* Maps a model URL to a file the platform can load, or `null` if it can't |
| `setMaterial(entity, material)` | Texture, emission, transparency |
| `setVideoMaterial(entity, video)` | A video texture |
| `setSolidShape?(entity, shape, color)` | *Optional.* A plain `'box'` or `'plane'` (colour channels 0 to 1). Frames are built from these; without it, items show unframed |
| `setText?(entity, text, opts)` | *Optional.* Text with `{ fontSize }` (the "Ad" label). Without it, ads show no label |

### Video and audio

| Method | What it does |
|---|---|
| `createVideoPlayer(entity, options)` | Creates a video player |
| `updateVideoSource(entity, src)` | Changes the video URL |
| `setVideoVolume(entity, volume)` | Volume, 0 to 1 |
| `getVideoState(entity): VideoState` | Playback state |
| `getVideoPosition?(entity)` | *Optional.* Seconds into the video. Scheduled showings use it to keep players in sync |
| `onVideoEnded?(entity, cb)` | *Optional.* Called when the video ends. Without it, playlists don't advance and video ads don't play |
| `setAudioSource(entity, options)` | Sets a sound |
| `playAudio(entity)`, `stopAudio(entity)` | Plays or stops it |

### Physics and input

| Method | What it does |
|---|---|
| `setCollider(entity, options)`, `removeCollider(entity)` | Colliders |
| `onPointerDown(entity, options, cb)`, `removePointerEvents(entity)` | Clicks |
| `onPointerHover?(entity, onEnter, onLeave, maxDistance)` | *Optional.* Hover |

### Player

| Method | What it does |
|---|---|
| `openUrl(url)` | Opens an external link |
| `teleportPlayer(destination)` | Teleports the player |
| `movePlayer(position, cameraTarget?)` | Moves the player |
| `triggerEmote(emoteId)` | Plays an emote |
| `getCameraPose?()` | *Optional.* `{ position, rotation }` of the camera |

### Frame loop

| Method | What it does |
|---|---|
| `registerSystem(update)`, `unregisterSystem(update)` | Per-frame callback `update(dt)`. Core uses it for timers, since scene runtimes may have none |

### Capabilities

`readonly capabilities: PlatformCapabilities`

## PlatformCapabilities

```typescript
interface PlatformCapabilities {
  video: boolean
  spatialAudio: boolean
  gltfModels: boolean
  customEmotes: boolean
  playerTeleport: boolean
  externalUrls: boolean
  nftDisplay: boolean
  colliders: boolean
  spatialUI: boolean
  screenSpaceUI: boolean
  maxEntities?: number
  platformName: string
  platformVersion?: string
}
```

Core reads these flags today:

- `video: false`: video elements are skipped.
- `gltfModels: false`: model elements are skipped.
- `spatialUI` / `screenSpaceUI`: whether the HUD can start.
- `maxEntities`: the entity budget for frames.
- `platformName`: sent to the server as the platform (`world`) at sign-in.

The other flags describe the platform but don't change what core does yet.
