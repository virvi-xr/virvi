---
title: WebSocket Protocol
description: The Colyseus rooms and message types Virvi uses for real-time scene sync and the Command Center.
---

Real-time sync uses [Colyseus](https://colyseus.io/) 0.15 over WebSocket, on the same host and port as the API (`wss://<your server>`). The SDK does all of this for you; read on only if you're writing your own client.

The server defines three rooms: `virvi_scene`, `virvi_command_center` and `virvi_studio` (Design Studio, cloud only; not covered here).

A **session token** is a JWT access token from the [sign-in routes](/docs/api/authentication/). API keys don't work here, and neither do refresh tokens.

## virvi_scene

One room per scene, matched by `sceneId`.

```typescript
import { Client } from 'colyseus.js'

const client = new Client('wss://virvi.example.com')
const room = await client.joinOrCreate('virvi_scene', {
  sceneId: '…',
  sessionToken: accessToken,      // optional: without it you join as an anonymous visitor
  clientType: 'analytics',        // or 'host'; 'host' is granted only to hosts, co-hosts and editors
  user: { id: '…', displayName: 'Me', connectedWallet: '0x…' },
})
room.onMessage('scene_preset_update', (msg) => { /* ... */ })
```

What you may do depends on your role in the scene. A refused message gets `virvi_error`.

### Client → server

| Type | Data | Who may send | What happens |
|---|---|---|---|
| `scene_preset_update` | `{ action, element, instance, elementData, instanceData }` | Editors and up (booking crew for their items) | Saves the change, acks the sender, broadcasts it to the others |
| `scene_change_preset` | `{ presetId }` | Those who manage presets | Makes the preset live and broadcasts it |
| `scene_setting_update` | `{ ... }` | Editors and up | Broadcast to the others |
| `scene_video_update` | `{ sk, isLive, url }` | Those who control that screen | Broadcast to the others as `scene_video_status` |
| `transform_draft` | `{ sk, element, position, rotation, scale }` | Editors and up | Live preview of an unsaved drag, sent to other editors (at most 20 per second) |
| `transform_end` | `{ sk, saved }` | Editors and up | Ends a drag preview |
| `scene_moderator_message`, `scene_moderator_crash` | `{ ... }` | Moderators | Broadcast to the others |
| `scene_sound_locator` | `{ ... }` | Anyone | Broadcast to the others |
| `user_message` | `{ messageId, data }` | Anyone | Broadcast to the others with `type: 'inbound'`. See [Multiplayer Events](/docs/custom-features/multiplayer-events/) |
| `auth_renew` | `{ sessionToken }` | The same user | Swaps in a fresh scene pass for this session |

Any other type is refused.

### Server → client

| Type | Data | When |
|---|---|---|
| `scene_preset_update` | `{ action: 'init', scenePreset, sceneSettings }` | Right after joining: the live preset |
| `scene_preset_update` | `{ action, elementData, instanceData, ... }` | An element or instance changed |
| `scene_preset_update_ack` | `{ action, id, sk }` | Your `scene_preset_update` was saved |
| `scene_change_preset` | `{ scenePreset, user }` | The live preset changed |
| `scene_setting_update` | as sent | A setting changed |
| `scene_video_status` | `{ sk, isLive, url }` | A screen went live or offline |
| `screen_showings` | showings | Scheduled showings for the scene's screens |
| `transform_draft`, `transform_draft_end`, `transform_held` | drag state | Editors only: someone else is dragging an item |
| `user_message` | `{ messageId, data, type: 'inbound' }` | Another client's message |
| `scene_sound_locator`, `scene_moderator_message`, `scene_moderator_crash` | as sent | Relayed from another client |
| `host_joined`, `host_left` | `{ displayName }` | A host client joined or left |
| `auth_status` | `{ authenticated }` | After `init`: whether you're signed in and verified |
| `venue_access` | access | Your access in the scene; sent again when it changes |
| `access_revoked` | `{ bookingId, reason }` | Your booking access ended or was removed |
| `auth_renew_ack` | `{}` | Your `auth_renew` was accepted |
| `virvi_error` | `{ code, messageType }` | A message was refused (`forbidden`, `not_found`, `bad_request`, `server_error`, ...) |

When a scene is deleted, everyone gets an empty `init`, then the room closes.

## virvi_command_center

One room per event, matched by `eventId`. Only the event's owner (or an instance admin) may join, with an account session token.

```typescript
const room = await client.joinOrCreate('virvi_command_center', { eventId: '…', sessionToken: accessToken })
```

| Direction | Type | Data | What it is |
|---|---|---|---|
| Client → server | `cross_world_update` | `{ action }` | Sends `action` to the platform hooks of every linked scene you fully control |
| Server → client | `command_center_status` | `{ eventId, worlds[], aggregate, timestamp }` | Status of the linked scenes, on join and every 5 seconds. `visitorCount` is always `0` for now |
| Server → client | `cross_world_dispatched` | `{ eventId, targetScenes, action }` | Your update was sent |
| Server → client | `virvi_error`, `error` | | A refused or failed update |

`cross_world_update` reaches [platform hooks](/docs/api/rest-reference/#platform-hooks) only. Players in `virvi_scene` rooms don't receive it.
