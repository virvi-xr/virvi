import { and, eq, inArray, isNotNull, lte, or } from 'drizzle-orm'
import { AUTO_CLOSE_AFTER_DRAW_DAYS, AUTO_CLOSE_AFTER_OPEN_DAYS, RAFFLE_RETENTION_DAYS } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { raffleEntries, raffles } from '../db/schema.js'
import { RaffleError, emitRaffleChanged, openRaffle, takeSnapshot } from './service.js'

const DAY_MS = 86_400_000
const ACTIVE = ['open', 'drawn'] as const

/**
 * Open the drafts whose `opens_at` has come, through the same openRaffle the host's button uses (its update is guarded
 * by `status = 'draft'`, so two instances sweeping at once open a raffle once). A scene that already has a raffle
 * running keeps the draft, with the reason for the host. Any other failure is tried again on the next sweep.
 */
async function openDueRaffles(now: Date): Promise<number> {
  const due = await db.select().from(raffles).where(and(eq(raffles.status, 'draft'), isNotNull(raffles.opensAt), lte(raffles.opensAt, now)))
  let opened = 0
  for (const row of due) {
    try {
      await openRaffle(row, now)
      opened++
    } catch (err) {
      if (err instanceof RaffleError && err.code === 'raffle_already_active') {
        await db.update(raffles).set({ opensAt: null, openError: err.message, updatedAt: now }).where(and(eq(raffles.id, row.id), eq(raffles.status, 'draft')))
      } else if (!(err instanceof RaffleError && err.code === 'bad_status')) {
        // bad_status: another instance opened it first
        console.error('[raffles] scheduled open failed:', row.id, (err as Error)?.message)
      }
    }
  }
  return opened
}

/**
 * Open the drafts that are due, close raffles left running (7 days after the last draw, 30 days after opening), then take the auto-snapshots
 * that are due. takeSnapshot claims `next_auto_snapshot_at` under the raffle's row lock and returns null when
 * the snapshot is not due, so two instances sweeping at once make one snapshot.
 */
export async function runRaffleSweep(now = new Date()): Promise<{ opened: number; snapshots: number; closed: number }> {
  const opened = await openDueRaffles(now)
  const afterDraw = new Date(now.getTime() - AUTO_CLOSE_AFTER_DRAW_DAYS * DAY_MS)
  const afterOpen = new Date(now.getTime() - AUTO_CLOSE_AFTER_OPEN_DAYS * DAY_MS)
  const closing = await db
    .update(raffles)
    .set({ status: 'closed', endedAt: now, nextAutoSnapshotAt: null, updatedAt: now })
    .where(and(inArray(raffles.status, [...ACTIVE]), or(lte(raffles.lastDrawnAt, afterDraw), lte(raffles.openedAt, afterOpen))))
    .returning({ sceneId: raffles.sceneId })
  for (const r of closing) emitRaffleChanged(r.sceneId)

  const due = await db
    .select({ id: raffles.id })
    .from(raffles)
    .where(and(inArray(raffles.status, [...ACTIVE]), isNotNull(raffles.nextAutoSnapshotAt), lte(raffles.nextAutoSnapshotAt, now)))
  let snapshots = 0
  for (const { id } of due) {
    // One raffle's failure doesn't hold up the others; the next sweep tries it again
    try {
      if (await takeSnapshot(id, 'auto', now)) snapshots++
    } catch (err) {
      console.error('[raffles] auto snapshot failed:', id, (err as Error)?.message)
    }
  }
  return { opened, snapshots, closed: closing.length }
}

/**
 * Delete the entries of raffles that ended RAFFLE_RETENTION_DAYS ago. Draw records keep only entry ids and their
 * stored pool, so they still replay.
 */
export async function scrubEndedRaffles(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RAFFLE_RETENTION_DAYS * DAY_MS)
  const rows = await db
    .delete(raffleEntries)
    .where(inArray(raffleEntries.raffleId, db.select({ id: raffles.id }).from(raffles).where(and(isNotNull(raffles.endedAt), lte(raffles.endedAt, cutoff)))))
    .returning({ id: raffleEntries.id })
  return rows.length
}
