---
title: Building an Adapter
description: How to add Virvi support to a new platform by implementing VirviPlatformAdapter inside the Virvi monorepo.
---

An adapter tells `@virvixr/core` how to draw things on one platform. Core decides what to draw; the adapter only decides how. The Decentraland adapter (`packages/adapter-dcl`) is the working example.

## Before you start

- `@virvixr/core`, `@virvixr/shared` and `@virvixr/client` are private workspace packages, not on npm. Build your adapter inside the monorepo, as a package in `packages/`.
- For a platform that can only make HTTP calls, skip the adapter: use the [platform hooks](/docs/api/rest-reference/#platform-hooks).

## Steps

1. Create `packages/adapter-yourplatform/` with a `package.json` that lists `@virvixr/core`, `@virvixr/shared` and `@virvixr/client` as `workspace:*` dependencies (see `packages/adapter-dcl/package.json`).
2. Implement `VirviPlatformAdapter` from `@virvixr/shared`. Every method is listed in the [API Reference](/docs/sdk/api-reference/).
3. Set `capabilities` honestly. Core skips video and models when their flags are `false`.
4. Implement `signedRequest` if the platform can sign requests so the server can verify the player. Without it, the server signs every player in as a guest: they see the scene's content but can't edit it.
5. Export a `createVirvi()` entry point.
6. Run `pnpm install` at the repo root, then `pnpm turbo build`.

## Minimal example

```typescript
import { Virvi } from '@virvixr/core'
import type {
  VirviPlatformAdapter,
  PlatformCapabilities,
  PlatformUser,
  AuthProof,
  VirviInitConfig,
} from '@virvixr/shared'

class MyAdapter implements VirviPlatformAdapter {
  readonly capabilities: PlatformCapabilities = {
    video: true,
    spatialAudio: false,
    gltfModels: true,
    customEmotes: false,
    playerTeleport: false,
    externalUrls: true,
    nftDisplay: false,
    colliders: true,
    spatialUI: false,
    screenSpaceUI: false,
    platformName: 'myplatform',
    platformVersion: '1',
  }

  async getPlatformUser(): Promise<PlatformUser> {
    return { id: 'player-1', displayName: 'Player', isGuest: true }
  }

  async getAuthProof(): Promise<AuthProof> {
    return { type: 'platform-token', payload: {} }
  }

  // ...and every other required method in the API Reference:
  // getSceneInfo, getEnvironment, createEntity, destroyEntity, entityExists, setTransform,
  // setPlaneRenderer, setGltfModel, setMaterial, setVideoMaterial, createVideoPlayer,
  // updateVideoSource, setVideoVolume, getVideoState, setAudioSource, playAudio, stopAudio,
  // setCollider, removeCollider, onPointerDown, removePointerEvents, openUrl, teleportPlayer,
  // movePlayer, triggerEmote, registerSystem, unregisterSystem
}

export async function createVirvi(config: Partial<VirviInitConfig> = {}): Promise<Virvi> {
  const virvi = new Virvi(new MyAdapter())
  await virvi.init({ env: 'prod', ...config })
  return virvi
}
```

`virvi.init()` signs in, finds or creates the scene, joins its room and resolves with `virvi.storage` once the scene has loaded. Pass `sceneId` to connect to a known scene. Pass `apiUrl` and `wssUrl` together to use a self-hosted server; with only `env`, `prod` means `https://api.virvi.io` and `dev` means `http://localhost:3010`.

## Principles

- **Core owns the logic.** Scene state, room messages, presets, video live/offline switching.
- **The adapter only renders.** It never decides what to show.
- **Capabilities drive what's skipped.** Report them honestly.
- **Optional methods add features.** Without `setSolidShape` there are no frames; without `onVideoEnded` playlists don't advance. The API Reference lists each one.
