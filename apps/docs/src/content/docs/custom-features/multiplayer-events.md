---
title: Multiplayer Events
description: Using virvi.sendMessage and virvi.onMessage for custom real-time messaging between players.
---

Multiplayer Events let you send and receive custom real-time messages between all players in a scene. Built on Virvi's Colyseus infrastructure, this system enables interactive multiplayer experiences without managing your own networking.

## How It Works

- Messages are broadcast through the Virvi Colyseus room for your scene.
- All connected players in the same world instance receive the message.
- Messages are fire-and-forget (not persisted). For persistent data, use [Scene State](/docs/custom-features/scene-state/).
- Message payloads are JSON-serializable objects.

## Sending a Message

Use `virvi.sendMessage` to broadcast a message to all players:

```typescript
import { virvi } from "@virvi/sdk";

// Send a simple message
virvi.sendMessage("emoji-reaction", {
  emoji: "fire",
  position: { x: 10, y: 2, z: 5 },
});

// Send a game event
virvi.sendMessage("player-scored", {
  playerId: virvi.userId,
  points: 100,
});
```

The first argument is the **message type** (a string you define). The second is the **payload** (any JSON-serializable object).

## Receiving Messages

Use `virvi.onMessage` to listen for incoming messages:

```typescript
virvi.onMessage("emoji-reaction", (data, senderId) => {
  // Show the emoji effect at the specified position
  spawnEmojiEffect(data.emoji, data.position);
});

virvi.onMessage("player-scored", (data, senderId) => {
  // Update the scoreboard
  updateScoreboard(data.playerId, data.points);
});
```

The callback receives:

- `data` — the message payload
- `senderId` — the ID of the player who sent the message

The sender also receives their own message, so you can use the same handler for local and remote events.

## Removing Listeners

Unsubscribe from a message type when you no longer need it:

```typescript
const unsubscribe = virvi.onMessage("emoji-reaction", handler);

// Later, stop listening
unsubscribe();
```

## Common Use Cases

- **Emoji reactions** — let players broadcast reactions visible to everyone
- **Multiplayer games** — sync game state like scores, turns, and actions
- **Synchronized effects** — trigger visual or audio effects across all clients
- **Collaborative building** — broadcast placement actions to all users
- **Polls and voting** — collect responses from players in real time

## Best Practices

- **Keep payloads small.** Avoid sending large objects or binary data. Send references (IDs, URLs) instead of raw content.
- **Use specific message types.** Instead of one generic message type with a sub-type field, use distinct type strings for each kind of event. This makes listeners cleaner and avoids unnecessary processing.
- **Handle missing data gracefully.** Not all clients may be on the same code version. Validate incoming payloads before using them.
- **Rate limit sends.** Avoid sending messages every frame. Batch or throttle frequent updates (e.g., position syncing) to avoid flooding the Colyseus room.

## Limitations

- Messages are not persisted. If a player connects after a message was sent, they will not receive it.
- Messages are scoped to a single world instance. Players in different instances of the same scene do not receive each other's messages. For cross-world communication, use the [Command Center](/docs/dashboard/command-center/).
- Maximum payload size is subject to Colyseus room limits.
