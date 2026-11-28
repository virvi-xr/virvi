---
title: Scene State
description: A small shared key-value store per scene, kept by Virvi, that scene code reads and writes and every visitor sees.
---

Scene state is a small key-value store that Virvi keeps for each scene. Your scene's code reads and writes it, and every visitor sees the same values. It's saved on the server, so it survives the room emptying, server restarts and reconnects, and late joiners get it straight away.

Use it for things like which round a game is on, whether the doors are open, a shared counter, or the high score.

It's new in `@virvixr/dcl` 2.24.0.

## In your scene's code

```ts
import { createVirvi } from '@virvixr/dcl'

const virvi = await createVirvi()

// Read: undefined until it's set, or until the state has arrived (virvi.state.ready)
const round = virvi.state.get('round')
virvi.state.all() // every key and value

// Listen to one key, or to every key with '*'. Also fires when the state first arrives
const stop = virvi.state.on('round', (value) => showRound(Number(value ?? 1)))

// Write: resolves once the server has saved it; every copy of the scene hears it, this one too
try {
  await virvi.state.set('round', 2)
  await virvi.state.delete('doors')
} catch (err) {
  // err.code: forbidden, bad_key, bad_value, value_too_large, too_many_keys, rate_limited, not_connected, state_timeout
}
```

- **Keys** are 1 to 64 letters, digits, or `_ . : -`.
- **Values** are any JSON (string, number, boolean, null, array or object), up to 4 KB each.
- A scene keeps up to **100 keys**. Overwriting a key is always fine; a new key past the limit is refused (`too_many_keys`).
- Writes are limited per visitor (a short burst, then a few per second): don't save every frame.

## Who can change it

Set it on the scene's **Settings** tab, under **Scene state**:

- **Editors only** (the default): only the scene's host, co-hosts and editors can change the state from in-world, so a value set by your scene code only saves while one of them is in the scene. Use this for anything that must be trusted.
- **Every visitor's scene code**: any visitor's copy of the scene can change it. Scene code is public and anyone can send their own messages, so treat these values as untrusted: fine for a shared counter or a door, not for prizes.

The same panel lists what's saved, and you can delete keys from it.

## From your own server

A backend of yours can read and write the state through the REST API with an [API key](/docs/api/authentication/#api-keys). Writes need an editor's key (host, co-host or editor), and connected visitors hear each change straight away.

```bash
# Read it all
curl "$VIRVI_URL/api/v1/scenes/$SCENE_ID/state" -H "Authorization: Bearer $VIRVI_API_KEY"

# Set one key
curl -X PUT "$VIRVI_URL/api/v1/scenes/$SCENE_ID/state/round" \
  -H "Authorization: Bearer $VIRVI_API_KEY" -H "Content-Type: application/json" \
  -d '{"value": 3}'
```

See the [REST reference](/docs/api/rest-reference/#scenes-presets-and-elements). Never put an API key in scene code: anyone can read it.

## When to use something else

| You need | Use |
|---|---|
| Fast-moving values between players that don't need saving (positions, a live timer) | [Multiplayer Events](/docs/custom-features/multiplayer-events/) |
| What the scene shows (screens, images, models, which preset is live) | Virvi itself: the dashboard, the HUD or the REST API |
| A value an editor sets on the dashboard (a switch, a slider) | [Widgets](/docs/custom-features/widgets/) |
| Saved per-player data (progress, preferences, collectibles) | Your own backend. Scene state is one set of values for the whole scene |
