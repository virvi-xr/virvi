import { and, asc, eq, inArray, lte, ne, or, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { beatClaims, beats, userAuthMethods } from '../db/schema.js'
import { isWalletBlocked } from '../auth/wallet-blocks.js'
import { uniqueViolation } from './errors.js'

/**
 * Claims waiting for a wallet. A visitor who earned a BEAT in the Virvi app before linking a wallet holds a `waiting`
 * claim (it holds one of the limited copies, never lapses, and is left alone by the 30-day clean-up). Once a verified
 * wallet is linked to the account, every waiting claim of the account is sent to it: the claim becomes `claimed`, as if
 * it had been claimed with that wallet at this moment, so the minting job picks it up (a BEAT that has ended still
 * mints: waiting claims hold its close open, job.ts). A BEAT whose host reviews claims keeps this one for the host's
 * Send while the review window lasts, like any other claim made then; after the window it goes out at once.
 * Nothing here logs a wallet or a name.
 */

const lc = (s: string) => s.toLowerCase()

/**
 * Sends the user's waiting claims to `wallet`. Each claim moves under `WHERE status = 'waiting'`, so when two wallets are
 * linked at nearly the same time every claim goes to the first and the second finds it gone. A blocked wallet takes
 * nothing (the claims keep waiting for another wallet). A wallet that already holds the BEAT (another claim, even
 * another account's: one wallet, one copy) leaves that claim waiting with `fail_reason = 'wallet_has_it'`, including when
 * the unique index only catches it at the write. `sent` counts claims moved, `kept` the claims still waiting.
 */
export async function fulfilWaitingClaims(userId: string, wallet: string, now: Date = new Date()): Promise<{ sent: number; kept: number }> {
  // `now` only says whether a paid BEAT has started; the claim is stamped by the database's clock, as claimBeat and a host's Send are
  const w = lc(wallet)
  const waiting = await db.select({ id: beatClaims.id, beatId: beatClaims.beatId }).from(beatClaims)
    .innerJoin(beats, eq(beats.id, beatClaims.beatId))
    .where(and(
      eq(beatClaims.userId, userId), eq(beatClaims.status, 'waiting'), eq(beatClaims.deleteRequested, false),
      // A BEAT that is live or ended, or paid and past its start (its go-live tick may not have run yet)
      or(inArray(beats.status, ['live', 'ended']), and(eq(beats.status, 'paid'), lte(beats.startsAt, now))),
    ))
  if (waiting.length === 0) return { sent: 0, kept: 0 }
  if (await isWalletBlocked(w)) return { sent: 0, kept: waiting.length }
  let sent = 0
  let kept = 0
  for (const claim of waiting) {
    const [other] = await db.select({ id: beatClaims.id }).from(beatClaims)
      .where(and(eq(beatClaims.beatId, claim.beatId), eq(beatClaims.wallet, w), ne(beatClaims.id, claim.id)))
    if (!other) {
      try {
        const done = await db.update(beatClaims)
          .set({ status: 'claimed', wallet: w, claimedAt: sql`clock_timestamp()`, failReason: null })
          .where(and(eq(beatClaims.id, claim.id), eq(beatClaims.status, 'waiting'), eq(beatClaims.userId, userId)))
          .returning({ id: beatClaims.id })
        // None moved: another wallet's call took it first, or the host removed it
        if (done.length) sent++
        continue
      } catch (e) {
        if (uniqueViolation(e) === null) throw e
      }
    }
    // The wallet holds this BEAT already: the claim stays waiting, and says why
    const marked = await db.update(beatClaims).set({ failReason: 'wallet_has_it' })
      .where(and(eq(beatClaims.id, claim.id), eq(beatClaims.status, 'waiting'))).returning({ id: beatClaims.id })
    if (marked.length) kept++
  }
  return { sent, kept }
}

/** After a wallet link (or a re-link of one already there): sends the account's waiting claims. Errors are logged and never reach the link's response. */
export async function fulfilAfterLink(userId: string, wallet: string): Promise<void> {
  try {
    await fulfilWaitingClaims(userId, wallet)
  } catch (e) {
    console.error('[beats] sending waiting claims failed:', e instanceof Error ? e.message : 'error')
  }
}

/**
 * When the account reads its BEATs (the collection, the app's My BEATs): a claim still waiting although a verified
 * wallet is linked (its send at link time failed, say) is sent now, to the wallets in the order they were linked (first
 * linked wins). Best effort: errors are logged and never reach the read.
 */
export async function fulfilOnRead(userId: string): Promise<void> {
  try {
    const [one] = await db.select({ id: beatClaims.id }).from(beatClaims)
      .where(and(eq(beatClaims.userId, userId), eq(beatClaims.status, 'waiting'), eq(beatClaims.deleteRequested, false))).limit(1)
    if (!one) return
    const wallets = await db.select({ identifier: userAuthMethods.identifier, metadata: userAuthMethods.metadata }).from(userAuthMethods)
      .where(and(eq(userAuthMethods.userId, userId), eq(userAuthMethods.type, 'wallet')))
      .orderBy(asc(sql`coalesce(${userAuthMethods.linkedAt}, ${userAuthMethods.createdAt})`), asc(userAuthMethods.id))
    for (const w of wallets) {
      if ((w.metadata as { verified?: unknown } | null)?.verified === false) continue
      const { sent, kept } = await fulfilWaitingClaims(userId, w.identifier)
      if (sent + kept === 0) return // nothing left waiting
    }
  } catch (e) {
    console.error('[beats] sending waiting claims failed:', e instanceof Error ? e.message : 'error')
  }
}
