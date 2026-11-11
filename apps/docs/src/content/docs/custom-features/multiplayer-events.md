---
title: Multiplayer Events
description: Send custom real-time messages between players in a scene with virvi.sendMessage and virvi.onMessage.
---

`sendMessage` and `onMessage` pass your own messages between everyone connected to a scene. They ride on the scene's Virvi room, so you don't run any networking yourself.

## How it works

- Each Virvi scene has one real-time room (`virvi_scene`). Every player whose scene code has connected to Virvi is in it.
- `sendMessage(id, data)` sends `{ messageId: id, data }` to the room. The server forwards it to **every other** client in the room. The sender does not get its own message back.
- `onMessage(id, callback)` calls `callback(data)` for each message with that `id`.
- Nothing is stored. A player who connects later never sees earlier messages.
- `data` must survive JSON-like serialization: plain objects, arrays, strings, numbers, booleans and `null`.

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

The callback gets only `data`. Virvi doesn't add who sent it. If you need that, put it in the payload yourself, for example `virvi.user?.id` (and don't trust it: any client can send any payload).

To act on your own message too, call your handler directly when you send.

## One handler per message ID

`onMessage` keeps one callback per `id`. Calling it again with the same `id` replaces the earlier callback. It returns nothing, and there is no way to remove a handler. To stop reacting, have your callback check a flag.

```typescript
let listening = true
virvi.onMessage('emoji-reaction', (data) => {
  if (!listening) return
  // ...
})
// later
listening = false
```

## Who can send

Any client in the room, signed in or not. The server forwards `user_message` without checking the sender's role or the payload. Treat every message as untrusted input:

- Validate its shape before using it.
- Never let a message alone grant anything (prizes, access, edits).
- Throttle what you send: don't send every frame.

## Limits

- Messages reach players in the same room. In scalable mode without Redis, each server has its own room for the scene, so players on different servers don't hear each other.
- Players whose scene doesn't run Virvi's code (or hasn't connected yet) don't get messages.
- Not for cross-scene messages. The [Command Center](/docs/dashboard/command-center/) sends to registered platform hooks, not to these rooms.
- Keep payloads small: send IDs or URLs, not content.
