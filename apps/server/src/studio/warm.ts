import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { studioDesigns, studioJobs } from '../db/schema.js'
import { config } from '../config.js'
import { ensureWorker, type MachineDeps } from './machines.js'
import { promptStatus } from './quota.js'
import type { Design } from './designs.js'

/**
 * Starting a design's machine before its prompt is sent (POST /designs/:id/warm), when the person starts writing one:
 * the machine is made or started and the worker boots, restores the workspace and polls, so the prompt doesn't wait
 * for all that. No job is made, so nothing is counted or charged; with no prompt the worker exits idle after 600 s
 * and the machine stops, as after any job.
 */

export const WARM_EVERY_MS = 5 * 60_000

export type WarmOutcome = 'warmed' | 'external' | 'archived' | 'no_prompts' | 'busy' | 'recent' | 'failed'

/**
 * Warms the design's machine unless there is no point: the worker is run by hand, the design is archived, the owner
 * couldn't send a prompt now (no prompts left, or past the cost ceiling; a Virvi admin's support prompts don't count
 * so they aren't held to it), a job is already waiting or running (it has the machine coming), or it was warmed in the
 * last 5 minutes (held by the database, so it holds across servers).
 */
export async function warmDesign(d: Design, opts: { support: boolean }, now: Date, deps: Partial<MachineDeps> = {}): Promise<WarmOutcome> {
  if (config.studioMachines === 'external') return 'external'
  if (d.archivedAt) return 'archived'
  if (!opts.support) {
    const s = await promptStatus(d.ownerId, now)
    if (s.left <= 0 || s.overCostCeiling) return 'no_prompts'
  }
  const [open] = await db.select({ id: studioJobs.id }).from(studioJobs)
    .where(and(eq(studioJobs.designId, d.id), inArray(studioJobs.status, ['queued', 'taken']))).limit(1)
  if (open) return 'busy'
  const claimed = await db.update(studioDesigns).set({ warmedAt: now })
    .where(and(eq(studioDesigns.id, d.id), or(isNull(studioDesigns.warmedAt), lt(studioDesigns.warmedAt, new Date(now.getTime() - WARM_EVERY_MS)))))
    .returning({ id: studioDesigns.id })
  if (!claimed.length) return 'recent'
  try {
    await ensureWorker(d.id, deps)
    return 'warmed'
  } catch (err) {
    // Nobody is waiting on it: the prompt, when it comes, starts the machine itself
    console.error('[studio] warm failed:', err instanceof Error ? err.message : err)
    return 'failed'
  }
}
