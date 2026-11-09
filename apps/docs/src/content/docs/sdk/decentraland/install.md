---
title: Decentraland Setup
description: Install @virvixr/dcl in a Decentraland SDK 7 scene, connect it to hosted or self-hosted Virvi, and use its APIs from code.
---

Everything for Decentraland is in one npm package, `@virvixr/dcl` (current version 2.13.0). Import from it, not from the internal `@virvixr/adapter-dcl` or `@virvixr/core` packages, which aren't published.

## Install

```bash
npm install @virvixr/dcl
npx @virvixr/dcl install
```

**Peer dependency:** `@dcl/sdk` 7.26.0 or newer (the HUD scales with the SDK's virtual canvas, so it isn't tiny on high-DPI screens).

`npx @virvixr/dcl install` copies the HUD's launcher icon to `images/virvi/hud-v.png` and the Creator Hub script to `assets/scene/Scripts/VirviManager.ts`. Deploy the icon with the scene. `npx @virvixr/dcl sync` keeps it up to date.

Version 2 is a rewrite and isn't compatible with the 0.x (SDK 6) API.

## Basic usage

```typescript
import { createVirvi } from '@virvixr/dcl'

export async function main() {
  await createVirvi()
}
```

That's it. Everything configured for the scene in Virvi renders automatically. The scene's owner gets the management HUD (top right); visitors see only the content.

## Analytics only

```typescript
import { startVirviAnalytics } from '@virvixr/dcl'

export function main() {
  startVirviAnalytics()
}
```

This collects visits, movement, interactions, video and emote analytics, with no HUD and no live content. No Virvi account is needed. Later, sign in to the dashboard with the wallet that owns the LAND or World and **claim** the scene to see its data.

`createVirvi()` starts analytics too. `createVirvi({ analytics: false })` turns them off. `stopVirviAnalytics()` stops them.

Track your own events with `virvi.track('bought_ticket', { tier: 'vip' })`.

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

`createVirvi(config?)` takes:

| Option | Default | What it does |
|---|---|---|
| `env` | `'prod'` | `'prod'` (`https://api.virvi.io`), `'staging'` or `'dev'` (`http://localhost:3010`) |
| `apiUrl` | from `env` | Your server's HTTP address. For self-hosted Virvi |
| `wssUrl` | from `env` | Your server's WebSocket address. Set it whenever you set `apiUrl` |
| `sceneId` | from `scene.json` | The Virvi scene to show. Without it, Virvi asks the server what the player gets at this location |
| `enableHud` | `true` | `false` hides the management HUD |
| `analytics` | `true` | `false` turns automatic analytics off |
| `debug` | off | `true`, or a list of areas, for debug logging |

```typescript
const virvi = await createVirvi({
  env: 'prod',
  sceneId: '645c3a07-5d49-469f-88f3-1636fd55e701',
  debug: true,
})
```

Editing in-world needs Virvi set up at the scene's location. A `sceneId` set here or in `scene.json` still shows that scene's content anywhere, but you can edit it from the HUD only where it's the scene set up at that parcel or World. Anywhere else the HUD shows "Set up Virvi at this location to edit".

### Scene metadata

You can put the scene ID in `scene.json` instead:

```json
{
  "virvi": {
    "sceneId": "645c3a07-5d49-469f-88f3-1636fd55e701"
  }
}
```

### Self-hosted Virvi

Point the scene at your server. Set both addresses:

```typescript
import { createVirvi, startVirviAnalytics } from '@virvixr/dcl'

export async function main() {
  await createVirvi({
    apiUrl: 'https://virvi.example.com',
    wssUrl: 'wss://virvi.example.com',
  })
}

// Analytics only, against your server:
// startVirviAnalytics({ apiUrl: 'https://virvi.example.com' })
```

- With only `apiUrl`, the WebSocket still goes to virvi.io. Always set `wssUrl` too.
- `npx @virvixr/dcl sync --server https://virvi.example.com` syncs models from your server.
- In Creator Hub, fill in the VirviManager script's **serverUrl** field. It derives the WebSocket address from it (`https` becomes `wss`).
- Sign-ins are verified with Decentraland's signed fetch. In a local preview (`localhost`), a non-cloud server can also accept unverified sign-ins when `ALLOW_UNVERIFIED_PLATFORM_AUTH=true`. Never set that on a public server.

## Creator Hub

1. In a terminal in your scene folder, run `npm install @virvixr/dcl`, then `npx @virvixr/dcl install`.
2. In Creator Hub, add an entity (for example "Virvi Manager"), add a **Script** component, and pick `VirviManager.ts`.
3. Fill in the fields, or leave them:

| Field | Default | Meaning |
|---|---|---|
| sceneId | blank | Virvi scene ID. Blank: set the scene up from the in-world HUD |
| env | `prod` | `prod`, `staging` or `dev` |
| serverUrl | blank | Only for self-hosted Virvi |
| enableHud | on | In-world management HUD for scene owners |
| enableAnalytics | on | Visitor analytics |
| showBeacon | off | Show the Virvi Manager entity's mesh |

An edited `VirviManager.ts` is left alone by `install` unless you pass `--force`.

## What the package exports

| Export | What it is |
|---|---|
| `createVirvi(config?)` | Connects the scene to Virvi. Resolves to the [Virvi object](/docs/sdk/overview/#the-virvi-object) |
| `startVirviAnalytics(opts?)`, `stopVirviAnalytics()` | Analytics without the rest. `opts`: `{ env?, apiUrl? }` |
| `placeDeployedModels()` | Places deployed Virvi models before the scene connects (see below) |
| `startVirviManager(entity, options?)` | The Creator Hub script's entry point |
| `VirviSmartItem` (and the default export) | The smart item used by Creator Hub |
| Types `Virvi`, `VirviInitConfig`, `VirviStorage` | For TypeScript |

## Developer APIs

```typescript
import { createVirvi } from '@virvixr/dcl'

export async function main() {
  const virvi = await createVirvi()

  // Messages between players in the scene (see Multiplayer Events)
  virvi.onMessage('game-event', (data) => console.log(data))

  // Analytics
  virvi.track('level-complete', { level: 3 })

  // Element data, once connected
  virvi.onStateChange((state) => {
    if (state === 'connected') console.log(virvi.storage.videos.configs['my-screen'])
  })
}
```

`sendMessage` throws until the scene's room is joined. See [How it works](/docs/sdk/overview/#how-it-works) for a `whenConnected` helper.

## Platform capabilities

The Decentraland adapter reports:

| Capability | Supported |
|---|---|
| Video | Yes |
| Spatial audio | Yes |
| glTF models | Yes |
| Custom emotes | Yes |
| Player teleport | Yes |
| External URLs | Yes |
| NFT display | Yes |
| Colliders | Yes |
| Screen-space UI | Yes |
| Spatial UI | No |
