import { and, eq, lt } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { studioDesigns, users } from '../db/schema.js'
import { config } from '../config.js'
import { destroyWorker, type MachineDeps } from '../studio/machines.js'
import { getStudioStore } from '../studio/store.js'
import { recordTrialEvent } from './trial-events.js'

const BATCH = 100

/**
 * Removes trials idle for TRIAL_IDLE_DAYS: their Studio machines and files, then the user (designs cascade).
 * Only rows still `is_trial` qualify, so an account that converted is never touched. At most 100 per run.
 */
export async function sweepTrials(now: Date, deps: Partial<MachineDeps> = {}): Promise<{ expired: number }> {
  const cutoff = new Date(now.getTime() - config.trialIdleDays * 24 * 3600_000)
  const idle = await db.select({ id: users.id }).from(users)
    .where(and(eq(users.isTrial, true), lt(users.trialLastActiveAt, cutoff)))
    .limit(BATCH)
  let expired = 0
  for (const { id } of idle) {
    try {
      const designs = await db.select({ id: studioDesigns.id }).from(studioDesigns).where(eq(studioDesigns.ownerId, id))
      for (const d of designs) {
        await destroyWorker(d.id, deps)
        await getStudioStore().deletePrefix(`designs/${d.id}/`)
      }
      // Re-check the row in the delete: a trial that converted since the select is kept
      const gone = await db.delete(users).where(and(eq(users.id, id), eq(users.isTrial, true), lt(users.trialLastActiveAt, cutoff))).returning({ id: users.id })
      if (gone.length) {
        recordTrialEvent('expired', id)
        expired++
      }
    } catch (err) {
      console.error('[trial-sweep] expire failed:', err instanceof Error ? err.message : err)
    }
  }
  return { expired }
}
