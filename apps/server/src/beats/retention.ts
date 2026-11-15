import { and, eq, inArray, isNotNull, lte, or, sql } from 'drizzle-orm'
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
export async function deleteMyBeatData(userId: string, _now: Date, exec?: Exec): Promise<{ deleted: number; unlinked: number; pending: number }> {
  const run = async (tx: Exec) => {
    // Lock the user's claims first: the job settles and picks claims under FOR UPDATE, so none can change status between
    // the three statements below (a claim leaving `minting` after the delete ran would otherwise escape all three)
    await tx.select({ id: beatClaims.id }).from(beatClaims).where(eq(beatClaims.userId, userId)).for('update')
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

/** The daily sweep: `present` claims of BEATs that ended BEAT_RETENTION_DAYS ago go, and so do the wallets and signed raw
 * txs of batches settled that long ago (their hashes stay). A batch's settle time is confirmed_at, else sent_at, else created_at: a
 * failed batch has no confirmed_at. */
export async function scrubBeats(now: Date): Promise<{ present: number; batches: number }> {
  const cutoff = new Date(now.getTime() - BEAT_RETENTION_DAYS * DAY_MS)
  const ended = db.select({ id: beats.id }).from(beats).where(lte(beats.endsAt, cutoff))
  const present = await db.delete(beatClaims)
    .where(and(eq(beatClaims.status, 'present'), inArray(beatClaims.beatId, ended)))
    .returning({ id: beatClaims.id })
  // raw_tx goes with the wallets: a mint's calldata is mintTo(id, wallets), and for a batch that never mined those wallets
  // aren't public. last_error holds codes only, and claims' fail_reason a revert name, so nothing else keeps a wallet
  const batches = await db.update(beatMintBatches).set({ wallets: null, rawTx: null })
    .where(and(
      or(isNotNull(beatMintBatches.wallets), isNotNull(beatMintBatches.rawTx)),
      inArray(beatMintBatches.status, ['confirmed', 'failed']),
      // postgres-js rejects a Date bound inside a raw sql template, so it goes as an ISO literal
      sql`coalesce(${beatMintBatches.confirmedAt}, ${beatMintBatches.sentAt}, ${beatMintBatches.createdAt}) <= ${cutoff.toISOString()}::timestamptz`,
    ))
    .returning({ id: beatMintBatches.id })
  return { present: present.length, batches: batches.length }
}
