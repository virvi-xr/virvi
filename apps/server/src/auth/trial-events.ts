import { sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { trialEvents } from '../db/schema.js'

export type TrialEventKind = 'started' | 'prompt' | 'blocked' | 'signed_up' | 'expired'

const pending = new Set<Promise<unknown>>()

function track(p: Promise<unknown>): void {
  const tracked: Promise<unknown> = p
    .catch((err) => console.error('[trial-events] write failed:', err instanceof Error ? err.message : err))
    .finally(() => pending.delete(tracked))
  pending.add(tracked)
}

/** Records one funnel step. Fire-and-forget: never throws and never delays the caller. */
export function recordTrialEvent(kind: TrialEventKind, userId: string | null, action?: string | null): void {
  track(db.insert(trialEvents).values({ kind, userId, action: action ?? null }).then(() => {}))
}

/** `blocked`, only for this trial's first refusal ever: the partial unique index `trial_events_blocked_uq` makes concurrent refusals collapse to one row. Fire-and-forget. */
export function recordTrialBlocked(userId: string, action: string | null): void {
  track(db.execute(sql`
    INSERT INTO trial_events (user_id, kind, action)
    VALUES (${userId}::uuid, 'blocked', ${action})
    ON CONFLICT (user_id) WHERE kind = 'blocked' DO NOTHING`))
}

/** Resolves once every funnel write started so far has settled (for tests and a graceful shutdown). */
export async function flushTrialEvents(): Promise<void> {
  while (pending.size) await Promise.all([...pending])
}

/** A client-supplied `fromAction` as a short string, else null. */
export function cleanAction(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null
}
