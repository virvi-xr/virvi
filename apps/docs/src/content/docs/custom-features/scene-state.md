---
title: Scene State
description: Virvi has no per-player key-value store in the SDK; here is what to use for saved and shared state instead.
---

The Virvi SDK (`@virvixr/dcl` 2.15.0) has **no** `setState` or `getState`, and the server has no per-player key-value store. Earlier versions of these docs described one; it doesn't exist.

Pick by what the state is for.

| You need | Use |
|---|---|
| State everyone sees live, that can be lost when the room empties (scores in a round, a shared timer) | [Multiplayer Events](/docs/custom-features/multiplayer-events/): send changes with `sendMessage`. Note that the sender doesn't receive its own message, and late joiners don't see earlier ones |
| What the scene shows (screens, images, models, which preset is live) | Virvi itself: change it in the dashboard, the HUD or the [REST API](/docs/api/rest-reference/). Every connected player gets the change |
| Saved per-player data (progress, preferences, collectibles) | Your own backend. Virvi doesn't store it |

## Changing what the scene shows from your own server

A backend of yours can change a scene through the REST API with an [API key](/docs/api/authentication/#api-keys). For example, switch the live preset:

```bash
curl -X POST "$VIRVI_URL/api/presets/$PRESET_ID/activate" \
  -H "Authorization: Bearer $VIRVI_API_KEY"
```

Every player in the scene sees the new preset. The key's account must be the scene's host, a co-host or an editor; otherwise the call returns `403`.

Never put an API key in scene code. Scene code is public: anyone can read it.

## Late joiners and shared live state

Messages aren't replayed. A common pattern for "current state" over messages:

1. When a player connects, send a `state-request` message.
2. Players who have the state answer with `state-snapshot`.
3. Everyone applies the newest snapshot they get.

Any client can send any payload, so this works for cosmetic or game state, not for anything that must be trusted.
