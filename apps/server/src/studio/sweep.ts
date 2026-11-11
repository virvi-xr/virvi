import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { studioDesigns, studioEntitlements, studioJobs, studioPayments } from '../db/schema.js'
import { destroyWorker, ensureWorker, type MachineDeps } from './machines.js'
import { failJobs } from './results.js'
import { expirePayment, queueFinalize, settleRefund } from './payments.js'
import { watchManaTransfers } from './mana/settle.js'
import { config } from '../config.js'
import { addMissingLibraryRows } from './library.js'
import { sweepTrials } from '../auth/trial-sweep.js'
import { sendWeeklyDigest } from './rating-review.js'
import { markExpiredInvitesRead, pruneNotifications } from '../notifications/notifications.js'

/**
 * The Design Studio sweep: fails jobs that will never get a result (refunding counted prompts), restarts machines for
 * jobs left waiting, destroys machines idle for days, packages paid pieces left without a job, settles MANA transfers
 * and expires MANA quotes left unpaid past their grace, and pays back refunds still owed. Every transition is
 * conditional, so concurrent sweeps on several servers fail each job once.
 */

export const STUDIO_SWEEP_MS = 60_000
const GRACE_SEC = 15 * 60 // after a job's own time limit
const RENDER_TIMEOUT_SEC = 300
const QUEUED_LOST_MS = 10 * 60_000
const QUEUED_RESTART_MS = 60_000 // a worker can exit idle just as a job is queued
const IDLE_MACHINE_MS = 3 * 24 * 3600_000
const ORPHAN_PACKAGING_MS = 2 * 60_000

export const MACHINE_STOPPED = 'The studio machine stopped responding.'
export const MACHINE_NEVER_STARTED = 'The studio machine did not start.'

export async function sweepStudio(now: Date, deps: Partial<MachineDeps> = {}): Promise<{ lost: number; destroyed: number }> {
  const taken = await db.select({ id: studioJobs.id }).from(studioJobs).where(and(
    eq(studioJobs.status, 'taken'),
    sql`${studioJobs.takenAt} < ${now.toISOString()}::timestamptz - make_interval(secs => (CASE WHEN ${studioJobs.type} = 'render' THEN ${RENDER_TIMEOUT_SEC}
      ELSE COALESCE((${studioJobs.payload}->'limits'->>'timeoutSec')::int, 1500) END) + ${GRACE_SEC})`,
  ))
  let lost = await failJobs(taken.map((j) => j.id), MACHINE_STOPPED, now)

  // A worker takes one job at a time: a job waiting behind a running one, or one that finished under 10 minutes
  // ago, is not lost. The 10 minutes count from the later of its queuing and the design's last taken or finished job.
  const lostBefore = new Date(now.getTime() - QUEUED_LOST_MS).toISOString()
  const neverTaken = await db.select({ id: studioJobs.id }).from(studioJobs).where(and(
    eq(studioJobs.status, 'queued'),
    sql`${studioJobs.createdAt} < ${lostBefore}::timestamptz`,
    sql`NOT EXISTS (SELECT 1 FROM studio_jobs o WHERE o.design_id = ${studioJobs.designId} AND o.id <> ${studioJobs.id}
      AND (o.status = 'taken' OR o.finished_at >= ${lostBefore}::timestamptz))`,
  ))
  lost += await failJobs(neverTaken.map((j) => j.id), MACHINE_NEVER_STARTED, now)

  const waiting = await db.selectDistinct({ designId: studioJobs.designId }).from(studioJobs)
    .where(and(eq(studioJobs.status, 'queued'), lt(studioJobs.createdAt, new Date(now.getTime() - QUEUED_RESTART_MS))))
  for (const { designId } of waiting) {
    await ensureWorker(designId, deps).catch((err) => console.error('[studio-sweep] restart failed:', err instanceof Error ? err.message : err))
  }

  const idle = await db.select({ id: studioDesigns.id }).from(studioDesigns).where(and(
    isNotNull(studioDesigns.machineId),
    // A machine warmed ahead of a prompt (warm.ts) is in use too: GREATEST skips a null warmed_at
    sql`GREATEST(COALESCE(${studioDesigns.lastJobAt}, ${studioDesigns.createdAt}), ${studioDesigns.warmedAt}) < ${new Date(now.getTime() - IDLE_MACHINE_MS).toISOString()}::timestamptz`,
    sql`NOT EXISTS (SELECT 1 FROM studio_jobs j WHERE j.design_id = ${studioDesigns.id} AND j.status IN ('queued', 'taken'))`,
  ))
  let destroyed = 0
  for (const { id } of idle) {
    try {
      await destroyWorker(id, deps)
      destroyed++
    } catch (err) {
      console.error('[studio-sweep] destroy failed:', err instanceof Error ? err.message : err)
    }
  }

  // A paid piece still packaging with no live job (a server died mid-grant before jobs were committed with it, or a
  // job finished without settling it) is queued again; the customer has paid and must get a package
  const orphans = await db.select({ id: studioEntitlements.id, designId: studioEntitlements.designId }).from(studioEntitlements).where(and(
    eq(studioEntitlements.status, 'packaging'),
    lt(studioEntitlements.createdAt, new Date(now.getTime() - ORPHAN_PACKAGING_MS)),
    sql`NOT EXISTS (SELECT 1 FROM studio_jobs j WHERE j.id = ${studioEntitlements.jobId} AND j.status IN ('queued', 'taken'))`,
  ))
  for (const o of orphans) {
    await queueFinalize(o.designId, [o.id], now).catch((err) => console.error('[studio-sweep] requeue failed:', err instanceof Error ? err.message : err))
  }

  // MANA: transfers first, so one mined in time settles even if its quote is expired just after
  await watchManaTransfers(now).catch((err) => console.error('[studio-sweep] MANA watcher failed:', err instanceof Error ? err.message : err))
  const lapsed = await db.select({ id: studioPayments.id }).from(studioPayments).where(and(
    eq(studioPayments.method, 'mana'), eq(studioPayments.status, 'pending'), isNull(studioPayments.manaTxHash),
    lt(studioPayments.expiresAt, new Date(now.getTime() - config.studioMana.graceMs)),
  ))
  for (const { id } of lapsed) {
    await expirePayment(id, now).catch((err) => console.error('[studio-sweep] MANA expiry failed:', err instanceof Error ? err.message : err))
  }

  const owing = await db.select({ id: studioPayments.id }).from(studioPayments)
    .where(and(sql`${studioPayments.refundDueCents} > 0`, or(
      isNotNull(studioPayments.stripePaymentIntent), // a card refund through Stripe
      inArray(studioPayments.method, ['mana', 'credit']), // paid back as credit
    )))
  for (const { id } of owing) {
    await settleRefund(id).catch((err) => console.error('[studio-sweep] refund settle failed:', err instanceof Error ? err.message : err))
  }
  // Paid scene pieces whose library rows didn't land (storage was down) get another try
  await addMissingLibraryRows(now).catch((err) => console.error('[studio-sweep] library retry failed:', err instanceof Error ? err.message : err))
  await markExpiredInvitesRead(now).catch((err) => console.error('[studio-sweep] expired invite notifications failed:', err instanceof Error ? err.message : err))
  // Notifications are kept 90 days from their last update
  await pruneNotifications(now).catch((err) => console.error('[studio-sweep] notification prune failed:', err instanceof Error ? err.message : err))
  return { lost, destroyed }
}

let timer: ReturnType<typeof setInterval> | null = null

export function startStudioSweep(ms = STUDIO_SWEEP_MS): void {
  if (timer) return
  let running = false
  timer = setInterval(() => {
    if (running) return
    running = true
    const now = new Date()
    sweepStudio(now)
      .catch((err) => console.error('[studio-sweep] failed:', err))
      .then(() => sweepTrials(now))
      .catch((err) => console.error('[trial-sweep] failed:', err))
      // The ratings digest for admins, once a week (LIV-142); a week already dealt with is a single read
      .then(() => sendWeeklyDigest(now))
      .catch((err) => console.error('[studio-digest] failed:', err))
      .finally(() => { running = false })
  }, ms)
  timer.unref?.()
}
