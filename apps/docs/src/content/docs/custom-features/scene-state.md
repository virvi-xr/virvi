---
title: Scene State
description: Using virvi.setState and virvi.getState for persistent key-value storage per user per scene.
---

Scene State provides a simple persistent key-value store scoped to each user within each scene. Use it to save user preferences, progress, or any custom data that should survive across sessions.

## How It Works

- Data is stored as key-value pairs on the Virvi server.
- Each entry is scoped to a specific **user** and **scene** combination.
- State persists across sessions — when a user returns to your scene, their data is still there.
- Keys are strings. Values can be strings, numbers, booleans, or JSON-serializable objects.

## Setting State

Use `virvi.setState` to save a value:

```typescript
import { virvi } from "@virvi/sdk";

// Save a simple value
await virvi.setState("theme", "dark");

// Save a number
await virvi.setState("score", 42);

// Save an object
await virvi.setState("preferences", {
  musicVolume: 0.8,
  showTutorial: false,
});
```

`setState` returns a promise that resolves when the value has been persisted on the server.

## Getting State

Use `virvi.getState` to retrieve a previously saved value:

```typescript
const theme = await virvi.getState("theme");
// "dark"

const score = await virvi.getState("score");
// 42

const prefs = await virvi.getState("preferences");
// { musicVolume: 0.8, showTutorial: false }
```

If the key does not exist, `getState` returns `undefined`.

## Deleting State

Remove a key by setting it to `null`:

```typescript
await virvi.setState("theme", null);
```

## Common Use Cases

- **User preferences** — save UI settings, language choice, or accessibility options
- **Progress tracking** — record which areas a user has visited or which tasks they have completed
- **Collectibles** — track which items a user has found in a scavenger hunt
- **Personalization** — remember a user's chosen avatar outfit or display name

## Scope and Isolation

State is isolated per user per scene:

- User A's state in Scene 1 is separate from User A's state in Scene 2.
- User A's state is separate from User B's state in the same scene.
- There is no built-in way to read another user's state. For shared data, use [Multiplayer Events](/custom-features/multiplayer-events/) or [Widgets](/custom-features/widgets/).

## Storage Limits

Each user-scene pair has a storage budget based on your subscription tier. Keep values compact and avoid storing large binary data. Use [Images & Video and 3D Models](/dashboard/media-library/) for files and store only references in scene state.
