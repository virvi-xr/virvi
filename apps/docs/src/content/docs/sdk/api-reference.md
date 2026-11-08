---
title: API Reference
description: Virvi class methods and VirviPlatformAdapter interface
---

## VirviPlatformAdapter Interface

Every platform adapter implements this interface. You only need this if you're building a new adapter.

### Identity & Auth
- `getPlatformUser(): Promise<PlatformUser>` — Get current user's platform identity
- `getAuthProof(): Promise<AuthProof>` — Get signed authentication proof
- `getSceneInfo(): Promise<SceneInfo>` — Get scene metadata (ID, location)
- `getEnvironment(): Promise<PlatformEnvironment>` — Get platform environment details

### Entity Lifecycle
- `createEntity(): EntityHandle` — Create a new entity
- `destroyEntity(handle): void` — Destroy an entity
- `entityExists(handle): boolean` — Check if entity exists

### Transform & Rendering
- `setTransform(entity, transform): void` — Set position, rotation, scale
- `setPlaneRenderer(entity): void` — Apply plane mesh
- `setGltfModel(entity, src): void` — Set glTF model
- `setMaterial(entity, material): void` — Apply material (texture, emission, transparency)
- `setVideoMaterial(entity, video): void` — Apply video texture
- `setSolidShape?(entity, shape, color): void` — Optional: a plain colour `'box'` or `'plane'` (channels 0-1). Frames around images and video screens are built from these; without it, items show unframed

### Video
- `createVideoPlayer(entity, options): void` — Create video player
- `updateVideoSource(entity, src): void` — Change video URL
- `setVideoVolume(entity, volume): void` — Set volume (0-1)
- `getVideoState(entity): VideoState` — Get playback state

### Audio
- `setAudioSource(entity, options): void` — Set audio source
- `playAudio(entity): void` / `stopAudio(entity): void`

### Physics & Input
- `setCollider(entity, options): void` / `removeCollider(entity): void`
- `onPointerDown(entity, options, callback): void` / `removePointerEvents(entity): void`

### Player Actions
- `openUrl(url): void` — Open external URL
- `teleportPlayer(destination): void` — Teleport player
- `movePlayer(position, cameraTarget?): void` — Move player
- `triggerEmote(emoteId): void` — Trigger emote

### Frame Loop
- `registerSystem(update): void` / `unregisterSystem(update): void` — Register per-frame update callback

### Capabilities
- `readonly capabilities: PlatformCapabilities` — Declare what the platform supports

## PlatformCapabilities

```typescript
{
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
  platformName: string
  platformVersion?: string
}
```

Managers in @virvixr/core check these before attempting operations. If `capabilities.video` is `false`, the VideoManager skips all video elements — no errors, no empty renders.
