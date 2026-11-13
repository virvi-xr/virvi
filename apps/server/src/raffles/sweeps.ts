import { and, inArray, isNotNull, lte, or } from 'drizzle-orm'
import { AUTO_CLOSE_AFTER_DRAW_DAYS, AUTO_CLOSE_AFTER_OPEN_DAYS, RAFFLE_RETENTION_DAYS } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { raffleEntries, raffles } from '../db/schema.js'
import { emitRaffleChanged, takeSnapshot } from './service.js'

const DAY_MS = 86_400_000
const ACTIVE = ['open', 'drawn'] as const

/**
 * Close raffles left running (7 days after the last draw, 30 days after opening), then take the auto-snapshots
 * that are due. takeSnapshot claims `next_auto_snapshot_at` under the raffle's row lock and returns null when
 * the snapshot is not due, so two instances sweeping at once make one snapshot.
 */
export async function runRaffleSweep(now = new Date()): Promise<{ snapshots: number; closed: number }> {
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
    if (await takeSnapshot(id, 'auto', now)) snapshots++
  }
  return { snapshots, closed: closing.length }
}

/** Clear names and wallets from entries of raffles that ended RAFFLE_RETENTION_DAYS ago. Draws keep only ids. */
export async function scrubEndedRaffles(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RAFFLE_RETENTION_DAYS * DAY_MS)
  const rows = await db
    .update(raffleEntries)
    .set({ wallet: null, displayName: null })
    .where(
      and(
        or(isNotNull(raffleEntries.wallet), isNotNull(raffleEntries.displayName)),
        inArray(raffleEntries.raffleId, db.select({ id: raffles.id }).from(raffles).where(and(isNotNull(raffles.endedAt), lte(raffles.endedAt, cutoff)))),
      ),
    )
    .returning({ id: raffleEntries.id })
  return rows.length
}
