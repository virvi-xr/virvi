---
title: Core Concepts
description: Scenes, presets, elements, instances, and platform adapters
sidebar:
  order: 3
---

## Scenes

A **scene** is the top-level container for a virtual space. It represents one deployable unit — a Decentraland parcel, a Hyperfy world, a Second Life region.

### Activity

The scene's **Activity** tab lists who changed what, and when. It covers:

- items added, changed or deleted, and copies placed, moved or removed, whether in the dashboard or in-world;
- the scene's name, description and thumbnail;
- presets created, renamed, deleted or made live;
- collaborators and wallet roles added, changed or removed, and the host handed over;
- deploys, and the scene being deleted or restored.

Each line names the person (their Virvi name, else their wallet) and says where they made the change: Dashboard, In-world or API. Repeat edits of one thing by one person within a minute show as one line with a count, so dragging a model around takes one line, not hundreds. Visitors' own actions (watching, clicking, claiming) aren't listed: those are in [Analytics](/docs/dashboard/analytics/).

Only the host and co-hosts can see it. The log stays with the scene while it's in Trash, and is erased with it when the scene is deleted for good.

## Presets

Each scene has one or more **presets** — named configurations of elements. Think of presets as "looks" for your scene. You might have a "Default" preset and a "Holiday" preset with different decorations. Switching presets is instant and syncs to all connected clients.

## Elements

An **element** defines _what_ something is — a video screen, an image, a 3D model, or a sound source. Elements have type-specific properties:

| Type | Key Properties |
|------|---------------|
| **Video** | `liveSrc`, `offImageSrc`, `offType`, `playlist`, `volume`, `isLive` |
| **Image** | `textureSrc`, `emission`, `isTransparent` |
| **Model** | `modelSrc` |
| **Sound** | `audioSrc`, `volume`, `sourceType` (clip or loop) |

## Instances

An **instance** is a placed copy of an element in the scene. One video element can have multiple instances at different positions. Instances carry:

- `position` / `rotation` / `scale` — where it appears in 3D space
- `enabled` — whether it's visible
- `withCollisions` — whether it has physics colliders

## Platform Adapters

A **platform adapter** implements the `VirviPlatformAdapter` interface for a specific metaverse platform. The adapter translates generic Virvi commands (create entity, set transform, play video) into platform-native API calls.

```
@virvixr/core (business logic) → adapter.createEntity()
                           → adapter.setTransform(entity, position)
                           → adapter.createVideoPlayer(entity, options)
                                    ↓
                           DclAdapter: engine.addEntity(), Transform.create(), VideoPlayer.create()
                           Hyperfy: the Virvi app builds a <video> node from the scene feed
```

The adapter never makes decisions about _what_ to render — it only knows _how_ to render what @virvixr/core tells it to.

## Real-Time Sync

Virvi uses [Colyseus](https://colyseus.io/) for real-time communication. When you change a video URL in the dashboard, the flow is:

1. Dashboard sends `scene_preset_update` to the Colyseus room
2. Server persists the change to PostgreSQL
3. Server broadcasts to all other clients in the room
4. In-world SDK receives the update and calls the adapter to apply it
5. For non-WebSocket platforms (Second Life), the server also POSTs to registered HTTP callbacks

Changes propagate within milliseconds for WebSocket clients, and within 1-3 seconds for HTTP callback clients.
