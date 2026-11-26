/**
 * The open relay messages (user_message, scene_sound_locator) are forwarded to everyone else in the room, so any visitor
 * may send them (LIV-156: open by design, as the Multiplayer Events docs describe). To keep one client from flooding a
 * room, each client gets a token bucket per message type: RELAY_BURST at once, refilled at RELAY_PER_SECOND. What's over
 * is dropped quietly. Message size is already capped by the websocket transport (4 KB).
 */
export const RELAY_BURST = 20
export const RELAY_PER_SECOND = 10
export const MESSAGE_ID_MAX = 128

export class RelayLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>()
  constructor(private readonly now: () => number = Date.now) {}

  /** True when this client may relay one more message of this type now. */
  take(clientId: string, type: string): boolean {
    const key = `${clientId}|${type}`
    const t = this.now()
    const b = this.buckets.get(key) ?? { tokens: RELAY_BURST, at: t }
    b.tokens = Math.min(RELAY_BURST, b.tokens + ((t - b.at) / 1000) * RELAY_PER_SECOND)
    b.at = t
    const ok = b.tokens >= 1
    if (ok) b.tokens -= 1
    this.buckets.set(key, b)
    return ok
  }

  /** A client left: forget its buckets. */
  forget(clientId: string): void {
    for (const key of this.buckets.keys()) if (key.startsWith(`${clientId}|`)) this.buckets.delete(key)
  }
}

/** The user_message forwarded to the others: only its id and data, marked inbound; null for a malformed one. */
export function relayUserMessage(message: unknown): { messageId: string; data: unknown; type: 'inbound' } | null {
  if (!message || typeof message !== 'object') return null
  const { messageId, data } = message as { messageId?: unknown; data?: unknown }
  if (typeof messageId !== 'string' || !messageId || messageId.length > MESSAGE_ID_MAX) return null
  return { messageId, data, type: 'inbound' }
}
