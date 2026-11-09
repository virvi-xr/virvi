---
title: Decentraland Setup
description: Install and configure Virvi in a Decentraland SDK 7 scene
---

## Analytics only (one line)

```ts
import { startVirviAnalytics } from '@virvixr/adapter-dcl/analytics'
startVirviAnalytics()
```

This starts collecting visits, movement, interactions, video and emote analytics. No Virvi account is needed. When you're ready, sign in to the dashboard with the wallet that owns the LAND or World and **claim** the scene to see its data. `createVirvi()` also starts analytics by default (`createVirvi({ analytics: false })` turns it off). Visitors never see Virvi setup screens: only the LAND or World owner does.

Track your own events with `virvi.track('bought_ticket', { tier: 'vip' })`.

## Installation

```bash
npm install @virvixr/dcl
```

**Peer dependency:** `@dcl/sdk >=7.26.0` (the HUD scales with the SDK's virtual canvas, so it isn't tiny on high-DPI screens).

The HUD's launcher icon loads from `images/virvi/hud-v.png` in your scene. Run `npx @virvixr/dcl install` in the scene folder to copy it there (`npx @virvixr/dcl sync` keeps it up to date), and deploy it with the scene.

## Basic Usage

```typescript
import { createVirvi } from '@virvixr/adapter-dcl'

const virvi = await createVirvi()
```

That's it. All scene elements configured in the Virvi dashboard render automatically.

## Show your Virvi models on the Decentraland map

For scenes that run your own code: uploaded through [Scene Import](/docs/dashboard/scene-import/), or built elsewhere and connected to a Virvi scene. Scenes Virvi builds for you already do this.

```typescript
import { createVirvi, placeDeployedModels } from '@virvixr/dcl'

export async function main() {
  await placeDeployedModels()
  await createVirvi()
}
```

This needs `@virvixr/dcl` 2.11.0 or later.

**Why it's needed.** Decentraland builds the map and the distant view of your scene from a snapshot. To take it, Decentraland runs your scene for a few seconds with no network, so models Virvi adds while the scene is live never get in.

**What it does:**
- When Virvi deploys your scene, it adds one file next to yours, `virvi/placements.json`. It lists where each placed copy of the Virvi models in that deploy goes.
- `placeDeployedModels()` reads that file and places those models straight away. Decentraland's snapshot then has them, and visitors see them before Virvi connects.
- When `createVirvi()` connects, it takes those models over without loading them again. It removes any you've deleted since, or that belong to another preset.

Without the file (nothing placed, or a deploy from before this existed), it places nothing. It never throws, and it stops waiting after 5 seconds.

Import both functions from `@virvixr/dcl`, and `await` the first before calling `createVirvi()`. Called once Virvi has loaded the scene, `placeDeployedModels()` does nothing. If you never call it, nothing changes.

**When the file changes:**
- Virvi writes the file every time it deploys the scene: a new upload, or a redeploy when you add models. It only lists models that are in that deploy.
- Moving a model in Virvi doesn't redeploy the scene on its own. Until the next deploy, the snapshot keeps the earlier positions.
- Virvi never changes your code or `scene.json` for this. A `virvi/placements.json` inside an upload (a "Download live" zip has one) is replaced with the current one.

**The map photo.** Decentraland re-captures the map by hand, now and then. So even with the snapshot ready, the map picture may take a while to change. Worlds don't have a satellite map yet.

**How to check:**
- **On the dashboard:** the destination's card has a **Map data** line under **Last deploy**. It says *ready (N models)*, *waiting for Decentraland*, or that Decentraland didn't build a snapshot. Virvi checks for 24 hours after each deploy it makes. A scene you deploy yourself shows no Map data line until Virvi deploys it.
- **Directly:** open `https://abgen-cdn.decentraland.org/LOD/lods-unity/manifests/<entityId>_InitialSceneState.json` with the deploy's entity id. A 200 whose `assets` list your models means the snapshot is ready.

## Configuration

```typescript
const virvi = await createVirvi({
  env: 'prod',        // 'dev' | 'staging' | 'prod'
  sceneId: 'uuid',    // Override scene ID (default: from scene.json metadata)
  debug: true,        // Enable debug logging
})
```

Editing in-world needs Virvi set up at the scene's location. A `sceneId` set here, or in `scene.json`, still shows that scene's content anywhere, but you can edit it from the HUD only where it's the scene set up at that parcel or World. Anywhere else the HUD shows "Set up Virvi at this location to edit".

### Scene Metadata

Add your Virvi scene ID to `scene.json`:

```json
{
  "virvi": {
    "sceneId": "645c3a07-5d49-469f-88f3-1636fd55e701"
  }
}
```

If omitted, you must pass `sceneId` in the config.

## V1 Migration

If migrating from Virvi V1:

```typescript
// V1:
import Virvi from '@virvixr/dcl'
await Virvi.init()

// V2 (compatible wrapper):
import Virvi from '@virvixr/adapter-dcl'
const storage = await Virvi.init()
```

The default export provides a backward-compatible `init()` that returns `virvi.storage`.

## Developer APIs

```typescript
// Custom messaging between players
virvi.sendMessage('game-event', { score: 100 })
virvi.onMessage('game-event', (data) => console.log(data))

// Analytics
virvi.track('level-complete', { level: 3 })

// Direct element access
virvi.storage.videos.configs['my-screen']
```

## Platform Capabilities

The Decentraland adapter reports:

| Capability | Supported |
|-----------|-----------|
| Video | Yes |
| Spatial Audio | Yes |
| glTF Models | Yes |
| Custom Emotes | Yes |
| Player Teleport | Yes |
| External URLs | Yes |
| NFT Display | Yes |
| Colliders | Yes |
| Screen-Space UI | Yes |
