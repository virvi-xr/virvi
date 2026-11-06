import { and, asc, eq, gt, lt, or } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { studioDesigns, users } from '../db/schema.js'
import { config } from '../config.js'
import { destroyWorker, type MachineDeps } from '../studio/machines.js'
import { getStudioStore } from '../studio/store.js'
import { recordTrialEvent } from './trial-events.js'

const BATCH = 100
/** Rows looked at per run, failures included, so a run stays bounded when many trials keep failing. */
const MAX_SCANNED = 500

/**
 * Removes trials idle for TRIAL_IDLE_DAYS: their Studio machines and files, then the user (designs cascade).
 * Only rows still `is_trial` qualify, so an account that converted is never touched. Oldest first, at most 100 expired per
 * run; a trial that fails to expire is retried next run but paged past now, so it never holds up the ones behind it.
 */
export async function sweepTrials(now: Date, deps: Partial<MachineDeps> = {}, opts: { batch?: number } = {}): Promise<{ expired: number }> {
  const cutoff = new Date(now.getTime() - config.trialIdleDays * 24 * 3600_000)
  const batch = opts.batch ?? BATCH
  let expired = 0
  let scanned = 0
  let after: { at: Date; id: string } | null = null
  while (expired < BATCH && scanned < MAX_SCANNED) {
    const want = Math.min(batch, BATCH - expired, MAX_SCANNED - scanned)
    const page: Array<{ id: string; at: Date | null }> = await db.select({ id: users.id, at: users.trialLastActiveAt }).from(users)
      .where(and(
        eq(users.isTrial, true),
        lt(users.trialLastActiveAt, cutoff),
        after ? or(gt(users.trialLastActiveAt, after.at), and(eq(users.trialLastActiveAt, after.at), gt(users.id, after.id))) : undefined,
      ))
      .orderBy(asc(users.trialLastActiveAt), asc(users.id))
      .limit(want)
    for (const { id, at } of page) {
      scanned++
      after = { at: at!, id }
      if (await expireTrial(id, cutoff, deps)) expired++
    }
    if (page.length < want) break
  }
  return { expired }
}

async function expireTrial(id: string, cutoff: Date, deps: Partial<MachineDeps>): Promise<boolean> {
  try {
    const designs = await db.select({ id: studioDesigns.id }).from(studioDesigns).where(eq(studioDesigns.ownerId, id))
    for (const d of designs) {
      await destroyWorker(d.id, deps)
      await getStudioStore().deletePrefix(`designs/${d.id}/`)
    }
    // Re-check the row in the delete: a trial that converted since the select is kept
    const gone = await db.delete(users).where(and(eq(users.id, id), eq(users.isTrial, true), lt(users.trialLastActiveAt, cutoff))).returning({ id: users.id })
    if (!gone.length) return false
    recordTrialEvent('expired', id)
    return true
  } catch (err) {
    console.error('[trial-sweep] expire failed:', err instanceof Error ? err.message : err)
    return false
  }
}
