---
title: Command Center
description: Watch the scenes linked to an event and send one action to all of their platform hooks at once.
---

The **Command Center** (in the dashboard's sidebar) shows the scenes linked to one of your events and sends actions to all of them together.

## Use it

1. Create an event under **Events** and link scenes to it.
2. Open **Command Center** and pick the event.
3. Each linked scene shows as a card with its name, thumbnail, platform and whether its latest deployment is live.
4. Under **Broadcast to All Worlds**, choose a tab and send:
   - **Send Message:** text, colour and font size (`{ type: 'show_message', text, color, fontSize }`).
   - **Switch Preset:** a preset ID (`{ type: 'switch_preset', presetId }`).
   - **Toggle Element:** an element ID and on/off (`{ type: 'toggle_element', elementId, enabled }`).
5. The **Activity Feed** lists what you sent this session.

Only the event's owner (or an instance admin) can open an event here.

## Where broadcasts go

A broadcast goes to the **platform hooks** of each linked scene you have full access to (host or co-host): the callback URLs registered with `/hook/register` by HTTP-only integrations. Each gets a POST like:

```json
{ "action": "cross_world_update", "eventId": "…", "type": "switch_preset", "presetId": "…" }
```

It does **not** change the scenes themselves, and players in Decentraland or Hyperfy scenes running the Virvi SDK don't receive it. To switch presets for everyone, switch them per scene (dashboard, HUD, or `POST /api/presets/:presetId/activate`). The hook integration decides what to do with each action.

## Status

The page refreshes the status every 5 seconds over a WebSocket, or every 10 seconds when it can't connect. The visitor count isn't measured yet and shows `0`.

## API

- `GET /api/command-center/:eventId/status`
- `POST /api/command-center/:eventId/broadcast` with `{ action, targetScenes? }` (`targetScenes`: a list of scene IDs, or `'all'`)
- The `virvi_command_center` room. See [WebSocket Protocol](/docs/api/websocket-protocol/#virvi_command_center).
