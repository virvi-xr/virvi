import { and, eq, inArray, isNotNull, lte, or, sql } from 'drizzle-orm'
import { BEAT_CLAIM_GRACE_MS, BEAT_RETENTION_DAYS } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { beatClaims, beatMintBatches, beatNetworkClaims, beats } from '../db/schema.js'
import type { Exec } from '../studio/quota.js'
import { deleteMyReissueRequests, scrubReissueRequests } from './reissue.js'

/**
 * BEAT privacy and retention (LIV-11). Nothing here logs wallets or display names.
 *
 * - deleteMyBeatData: a visitor's own data. Present, waiting, claimed and failed claims are deleted. A claim that is minting
 *   (a transaction is in flight) is flagged, and the minting job settles it when its batch does (deleted if it didn't
 *   mint, unlinked if it did). A minted claim keeps its row and its wallet (public on chain) but loses the link to the
 *   account and the display name.
 * - scrubBeats: the daily 30-day sweep. A claim waiting for a wallet is never scrubbed: it holds a copy for a visitor
 *   who may link a wallet any time. (It isn't on chain, so a visitor deleting their data deletes it.)
 */

const DAY_MS = 86_400_000

/**
 * What unlinking a minted claim clears (privacy M1): its account, its display name, its time present, the consent,
 * event check-in and claim times, and a reissued claim's old wallet (reissue_tx and reissued_at stay, as on chain). On chain only the wallet remains, so the row keeps the wallet, its status and the mint.
 */
export const UNLINKED_CLAIM = {
  userId: null, displayName: null, secondsPresent: null, lastSeenAt: null, consentedAt: null, claimedAt: null, replacedWallet: null,
  eventCheckedInAt: null, secondsAtEventScan: null,
} as const

/** One transaction (or the caller's, so account deletion can include it). Only this user's claims are touched. */
export async function deleteMyBeatData(userId: string, _now: Date, exec?: Exec): Promise<{ deleted: number; unlinked: number; pending: number }> {
  const run = async (tx: Exec) => {
    // Lock the user's claims first: the job settles and picks claims under FOR UPDATE, so none can change status between
    // the three statements below (a claim leaving `minting` after the delete ran would otherwise escape all three)
    await tx.select({ id: beatClaims.id }).from(beatClaims).where(eq(beatClaims.userId, userId)).for('update')
    const mine = eq(beatClaims.userId, userId)
    const deleted = await tx.delete(beatClaims)
      .where(and(mine, inArray(beatClaims.status, ['present', 'waiting', 'claimed', 'failed'])))
      .returning({ id: beatClaims.id })
    // A claim a host removed stays as a wallet-only tombstone, so the wallet can't track and claim that BEAT again (I-2)
    const tombstones = await tx.update(beatClaims).set(UNLINKED_CLAIM)
      .where(and(mine, eq(beatClaims.status, 'removed')))
      .returning({ id: beatClaims.id })
    const pending = await tx.update(beatClaims).set({ deleteRequested: true })
      .where(and(mine, eq(beatClaims.status, 'minting')))
      .returning({ id: beatClaims.id })
    const unlinked = await tx.update(beatClaims).set(UNLINKED_CLAIM)
      .where(and(mine, eq(beatClaims.status, 'minted')))
      .returning({ id: beatClaims.id })
    // Reissue requests go; one approved or proposed keeps only its wallets, ids and state until it settles (reissue.ts)
    await deleteMyReissueRequests(tx, userId, _now)
    return { deleted: deleted.length, unlinked: unlinked.length + tombstones.length, pending: pending.length }
  }
  return exec ? run(exec) : db.transaction(run)
}

/**
 * The daily sweep, at BEAT_RETENTION_DAYS:
 * - `present` and `removed` claims of BEATs that ended that long ago go;
 * - a BEAT's per-network claim counts and their salt go once its claims are over (grace passed, closed or cancelled);
 * - the wallets and signed raw txs of batches settled that long ago go (their hashes stay). A batch's settle time is
 *   confirmed_at, else sent_at, else created_at: a failed batch has no confirmed_at. A batch still open (`sending` or
 *   `sent`) that long after it was made goes too (privacy M3): reconcile settles it by receipt or nonce without them, it
 *   only can't rebroadcast or reprice it, and after 30 days neither matters;
 * - reissue requests closed (rejected, cancelled or done) that long ago go; open ones stay.
 */
export async function scrubBeats(now: Date): Promise<{ present: number; batches: number; networks: number; reissueRequests: number }> {
  const cutoff = new Date(now.getTime() - BEAT_RETENTION_DAYS * DAY_MS)
  const ended = db.select({ id: beats.id }).from(beats).where(lte(beats.endsAt, cutoff))
  const present = await db.delete(beatClaims)
    .where(and(inArray(beatClaims.status, ['present', 'removed']), inArray(beatClaims.beatId, ended)))
    .returning({ id: beatClaims.id })
  // The network counts and their salt go once nobody can claim any more: the claim grace is over, or the BEAT is
  // closed on chain or cancelled
  const over = db.select({ id: beats.id }).from(beats).where(or(
    lte(beats.endsAt, new Date(now.getTime() - BEAT_CLAIM_GRACE_MS)), isNotNull(beats.closedOnChainAt), eq(beats.status, 'cancelled'),
  ))
  const networks = await db.delete(beatNetworkClaims).where(inArray(beatNetworkClaims.beatId, over)).returning({ id: beatNetworkClaims.beatId })
  await db.update(beats).set({ networkSalt: null }).where(and(isNotNull(beats.networkSalt), inArray(beats.id, over)))
  // raw_tx goes with the wallets: a mint's calldata is mintTo(id, wallets), and for a batch that never mined those wallets
  // aren't public. last_error holds codes only, and claims' fail_reason a revert name, so nothing else keeps a wallet
  // postgres-js rejects a Date bound inside a raw sql template, so the cutoff goes as an ISO literal
  const old = (col: unknown) => sql`${col} <= ${cutoff.toISOString()}::timestamptz`
  const batches = await db.update(beatMintBatches).set({ wallets: null, rawTx: null })
    .where(and(
      or(isNotNull(beatMintBatches.wallets), isNotNull(beatMintBatches.rawTx)),
      or(
        and(inArray(beatMintBatches.status, ['confirmed', 'failed']), old(sql`coalesce(${beatMintBatches.confirmedAt}, ${beatMintBatches.sentAt}, ${beatMintBatches.createdAt})`)),
        and(inArray(beatMintBatches.status, ['sending', 'sent']), old(beatMintBatches.createdAt)),
      ),
    ))
    .returning({ id: beatMintBatches.id })
  // Reissue requests closed (rejected, cancelled or done) that long ago; open ones stay
  const reissueRequests = await scrubReissueRequests(cutoff, now)
  return { present: present.length, batches: batches.length, networks: networks.length, reissueRequests }
}
