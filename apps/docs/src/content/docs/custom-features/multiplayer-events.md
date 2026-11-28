---
title: Multiplayer Events
description: Send custom real-time messages between players in a scene with virvi.sendMessage and virvi.onMessage, and see who sent each one.
---

`sendMessage` and `onMessage` pass your own messages between everyone connected to a scene. They ride on the scene's Virvi room, so you don't run any networking yourself.

## How it works

- Each Virvi scene has one real-time room (`virvi_scene`). Every player whose scene code has connected to Virvi is in it.
- `sendMessage(id, data)` sends `{ messageId: id, data }` to the room. The server forwards it to **every other** client in the room. The sender does not get its own message back.
- `onMessage(id, callback)` calls `callback(data, from)` for each message with that `id`. `from` is who sent it, stamped by the server (see [Who sent it](#who-sent-it)).
- Nothing is stored. A player who connects later never sees earlier messages.
- `data` must survive JSON-like serialization: plain objects, arrays, strings, numbers, booleans and `null`.
- **Limits:** a message can be up to about 4 KB, and its `id` up to 128 characters. Each player can send a burst of 20 messages, then 10 a second. Messages over the limit are dropped without an error, so don't send one every frame.

## Send

```typescript
import { createVirvi } from '@virvixr/dcl'

export async function main() {
  const virvi = await createVirvi()

  const sendReaction = (emoji: string) => {
    if (virvi.connectionState !== 'connected') return // sendMessage throws "Not in a room" before this
    virvi.sendMessage('emoji-reaction', { emoji, at: Date.now() })
  }

  sendReaction('fire')
}
```

## Receive

```typescript
virvi.onMessage('emoji-reaction', (data) => {
  const { emoji } = data as { emoji?: string }
  if (typeof emoji === 'string') showEmoji(emoji)
})
```

To act on your own message too, call your handler directly when you send.

## Who sent it

From `@virvixr/dcl` 2.24.0, the callback's second argument is the sender, as the server saw them. Scene code can't fake it: the server replaces anything the sender claims.

```typescript
virvi.onMessage('start-round', (data, from) => {
  if (!from?.staff) return // only the scene's host, co-hosts and editors may start a round
  startRound()
})
```

| Field | Meaning |
|---|---|
| `sessionId` | The sender's connection in the room. Stable while they stay connected |
| `userId` | Their Virvi account id, or `null` |
| `wallet` | Their checked wallet address, or `null` |
| `guest` | `true` when they aren't signed in with a checked wallet or Virvi account |
| `staff` | `true` for the scene's host, co-hosts and editors |

`from` can be `null` (a message relayed by a server from before this change), so check it before use. The **payload** is still whatever the sender wrote, so check its shape.

## One handler per message ID

`onMessage` keeps one callback per `id`. Calling it again with the same `id` replaces the earlier callback. It returns a function that removes it, and `offMessage(id)` removes whatever is listening for `id`.

```typescript
const stop = virvi.onMessage('emoji-reaction', (data) => { /* ... */ })
// later
stop() // or virvi.offMessage('emoji-reaction')
```

On 2.23.0 and older, `onMessage` returns nothing and there's no `offMessage`: have your callback check a flag instead.

## Who can send

Any client in the room, signed in or not. The server stamps who sent it but doesn't check the payload. Treat every message's data as untrusted input:

- Validate its shape before using it.
- Never let a message alone grant anything (prizes, access, edits). Check `from.staff` for messages only staff should send.
- Throttle what you send: don't send every frame.

## Limits

- Messages reach players in the same room. In scalable mode without Redis, each server has its own room for the scene, so players on different servers don't hear each other.
- Players whose scene doesn't run Virvi's code (or hasn't connected yet) don't get messages.
- Not for cross-scene messages. The [Command Center](/docs/dashboard/command-center/) sends to registered platform hooks, not to these rooms.
- Keep payloads small: send IDs or URLs, not content.
