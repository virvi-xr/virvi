/**
 * Click rules in Hyperfy (LIV-196): how many clicks the server half passes on to Virvi per visitor. A short burst,
 * then a few a second, like Virvi's own limit for Decentraland's room.
 */
export const RULE_CLICK_BURST = 5
export const RULE_CLICK_PER_SECOND = 3

export class RuleClickLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>()

  /** True when this visitor's click may go to Virvi now. */
  take(playerId: string, now: number): boolean {
    const b = this.buckets.get(playerId) ?? { tokens: RULE_CLICK_BURST, at: now }
    b.tokens = Math.min(RULE_CLICK_BURST, b.tokens + ((now - b.at) / 1000) * RULE_CLICK_PER_SECOND)
    b.at = now
    const ok = b.tokens >= 1
    if (ok) b.tokens -= 1
    this.buckets.set(playerId, b)
    if (this.buckets.size > 500) for (const k of [...this.buckets.keys()].slice(0, 250)) this.buckets.delete(k)
    return ok
  }
}
