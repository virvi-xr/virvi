import { and, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm'
import { BEAT_RETENTION_DAYS } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { beatClaims, beatMintBatches, beats } from '../db/schema.js'
import type { Exec } from '../studio/quota.js'

/**
 * BEAT privacy and retention (LIV-11). Nothing here logs wallets or display names.
 *
 * - deleteMyBeatData: a visitor's own data. Present, claimed and failed claims are deleted. A claim that is minting
 *   (a transaction is in flight) is flagged, and the minting job settles it when its batch does (deleted if it didn't
 *   mint, unlinked if it did). A minted claim keeps its row and its wallet (public on chain) but loses the link to the
 *   account and the display name.
 * - scrubBeats: the daily 30-day sweep.
 */

const DAY_MS = 86_400_000

/** One transaction (or the caller's, so account deletion can include it). Only this user's claims are touched. */
export async function deleteMyBeatData(userId: string, now: Date, exec?: Exec): Promise<{ deleted: number; unlinked: number; pending: number }> {
  void now
  const run = async (tx: Exec) => {
    const mine = eq(beatClaims.userId, userId)
    const deleted = await tx.delete(beatClaims)
      .where(and(mine, inArray(beatClaims.status, ['present', 'claimed', 'failed'])))
      .returning({ id: beatClaims.id })
    const pending = await tx.update(beatClaims).set({ deleteRequested: true })
      .where(and(mine, eq(beatClaims.status, 'minting')))
      .returning({ id: beatClaims.id })
    const unlinked = await tx.update(beatClaims).set({ userId: null, displayName: null })
      .where(and(mine, eq(beatClaims.status, 'minted')))
      .returning({ id: beatClaims.id })
    return { deleted: deleted.length, unlinked: unlinked.length, pending: pending.length }
  }
  return exec ? run(exec) : db.transaction(run)
}

/** The daily sweep: `present` claims of BEATs that ended BEAT_RETENTION_DAYS ago go, and so do the wallets of batches
 * settled that long ago (their hashes stay). A batch's settle time is confirmed_at, else sent_at, else created_at: a
 * failed batch has no confirmed_at. */
export async function scrubBeats(now: Date): Promise<{ present: number; batches: number }> {
  const cutoff = new Date(now.getTime() - BEAT_RETENTION_DAYS * DAY_MS)
  const ended = db.select({ id: beats.id }).from(beats).where(lte(beats.endsAt, cutoff))
  const present = await db.delete(beatClaims)
    .where(and(eq(beatClaims.status, 'present'), inArray(beatClaims.beatId, ended)))
    .returning({ id: beatClaims.id })
  const batches = await db.update(beatMintBatches).set({ wallets: null })
    .where(and(
      isNotNull(beatMintBatches.wallets),
      inArray(beatMintBatches.status, ['confirmed', 'failed']),
      // postgres-js rejects a Date bound inside a raw sql template, so it goes as an ISO literal
      sql`coalesce(${beatMintBatches.confirmedAt}, ${beatMintBatches.sentAt}, ${beatMintBatches.createdAt}) <= ${cutoff.toISOString()}::timestamptz`,
    ))
    .returning({ id: beatMintBatches.id })
  return { present: present.length, batches: batches.length }
}
