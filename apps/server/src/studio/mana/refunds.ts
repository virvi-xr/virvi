import { and, asc, eq } from 'drizzle-orm'
import { getAddress } from 'ethers'
import { db } from '../../db/connection.js'
import { studioCredits, studioManaRefunds, studioMistakeReports, users } from '../../db/schema.js'
import { config } from '../../config.js'
import { verifiedWalletsOf } from '../../analytics/claims.js'
import { addCredit, takeCredit } from '../credit.js'
import { PaymentError } from '../payments.js'
import { manaWeiAtLeast } from './quote.js'
import { getManaRate } from './rate.js'
import { getPolygon, parseTransfers, type PolygonReader } from './polygon.js'

/**
 * MANA back on request. A mistake refund on a MANA-paid line goes back as credit (Task 4, its MANA share recorded on
 * the report as manaCents); the customer can turn that credit into a request to have it back as MANA. The owner sends
 * it by hand from their own wallet (the server holds no key), and the server checks the transaction on Polygon before
 * recording it. Declining gives the credit back. Only mistake-report refunds can be asked back (ruling R6).
 */

export type ManaRefundStatus = 'requested' | 'sent' | 'declined'

const isUniqueViolation = (err: unknown) =>
  (err as { code?: string }).code === '23505' || (err as { cause?: { code?: string } }).cause?.code === '23505'

/**
 * Turns the MANA share of the caller's refunded mistake report into a request, taking that much credit. Refused when
 * the report has no MANA share (not_mana), was already asked back (already_requested), the account has no verified
 * wallet (no_wallet), or less credit than the share is left (credit_spent, taking nothing).
 */
export async function requestManaRefund(userId: string, reportId: string, now: Date): Promise<{ id: string; status: 'requested'; usdCents: number }> {
  const [wallet] = await verifiedWalletsOf(userId)
  return db.transaction(async (tx) => {
    // The report row is the lock: two requests for one report run one after the other. Then the credit, as merges do.
    const [r] = await tx.select().from(studioMistakeReports)
      .where(and(eq(studioMistakeReports.id, reportId), eq(studioMistakeReports.userId, userId))).for('update')
    if (!r) throw new PaymentError(404, 'report_not_found')
    if (r.manaCents <= 0) throw new PaymentError(409, 'not_mana')
    if (r.status !== 'refunded') throw new PaymentError(409, 'not_refunded')
    const [asked] = await tx.select({ id: studioManaRefunds.id }).from(studioManaRefunds).where(eq(studioManaRefunds.reportId, r.id))
    if (asked) throw new PaymentError(409, 'already_requested')
    if (!wallet) throw new PaymentError(409, 'no_wallet')
    const [bal] = await tx.select({ balanceCents: studioCredits.balanceCents }).from(studioCredits)
      .where(eq(studioCredits.userId, userId)).for('update')
    if ((bal?.balanceCents ?? 0) < r.manaCents) throw new PaymentError(409, 'credit_spent')
    await takeCredit(tx, userId, r.manaCents, 'mana_refund_request', r.id, now)
    const [row] = await tx.insert(studioManaRefunds).values({
      userId, reportId: r.id, usdCents: r.manaCents, toAddress: getAddress(wallet), status: 'requested', createdAt: now,
    }).returning({ id: studioManaRefunds.id })
    return { id: row.id, status: 'requested' as const, usdCents: r.manaCents }
  })
}

/** The owner's list of requests in a status, oldest first, with each user's email and first verified wallet. */
export async function listManaRefunds(status: ManaRefundStatus) {
  const rows = await db.select({ r: studioManaRefunds, email: users.email }).from(studioManaRefunds)
    .innerJoin(users, eq(users.id, studioManaRefunds.userId))
    .where(eq(studioManaRefunds.status, status))
    .orderBy(asc(studioManaRefunds.createdAt))
  return Promise.all(rows.map(async ({ r, email }) => ({
    id: r.id,
    user: { id: r.userId, email, wallet: (await verifiedWalletsOf(r.userId))[0] ?? null },
    usdCents: r.usdCents, toAddress: r.toAddress, createdAt: r.createdAt,
    ...(status === 'requested' ? {} : { manaAmountWei: r.manaAmountWei, txHash: r.txHash, decidedAt: r.decidedAt, decidedBy: r.decidedBy }),
  })))
}

async function openRequest(id: string) {
  const [r] = await db.select().from(studioManaRefunds).where(eq(studioManaRefunds.id, id))
  if (!r) throw new PaymentError(404, 'not_found')
  if (r.status !== 'requested') throw new PaymentError(409, 'already_decided')
  return r
}

/** What to send for a request: its USD value at the current rate, rounded up to a millionth of a MANA, with no salt. */
export async function manaRefundQuote(id: string, now: Date) {
  const r = await openRequest(id)
  const rate = await getManaRate(now)
  if (!rate) throw new PaymentError(503, 'rate_unavailable')
  return {
    amountWei: manaWeiAtLeast(r.usdCents, rate.usdPerMana).toString(),
    token: config.studioMana.token, chainId: config.studioMana.chainId, to: r.toAddress, usdPerMana: rate.usdPerMana,
  }
}

/**
 * Records the owner's send, once the transaction is checked on chain: mined, not reverted, and holding a MANA
 * Transfer of exactly amountWei to the request's wallet.
 */
export async function recordManaRefundSent(
  id: string, txHash: string, amountWei: bigint, adminId: string, now: Date, reader: PolygonReader = getPolygon(),
) {
  const hash = txHash.toLowerCase()
  const r = await openRequest(id)
  const receipt = await reader.receipt(hash)
  if (!receipt) throw new PaymentError(404, 'tx_not_found')
  if (receipt.status !== 1) throw new PaymentError(409, 'tx_failed')
  const sent = parseTransfers(config.studioMana.token, receipt.logs.map((l) => ({ ...l, transactionHash: hash, blockNumber: receipt.blockNumber })))
    .some((t) => t.to.toLowerCase() === r.toAddress.toLowerCase() && t.amountWei === amountWei)
  if (!sent) throw new PaymentError(409, 'tx_mismatch')
  try {
    const [row] = await db.update(studioManaRefunds)
      .set({ status: 'sent', txHash: hash, manaAmountWei: amountWei.toString(), decidedAt: now, decidedBy: adminId })
      .where(and(eq(studioManaRefunds.id, id), eq(studioManaRefunds.status, 'requested')))
      .returning({ id: studioManaRefunds.id })
    if (!row) throw new PaymentError(409, 'already_decided')
  } catch (err) {
    if (isUniqueViolation(err)) throw new PaymentError(409, 'tx_used')
    throw err
  }
  return { id, status: 'sent' as const, txHash: hash, amountWei: amountWei.toString() }
}

/** Declines a request: its credit goes back to the account. */
export async function declineManaRefund(id: string, adminId: string, now: Date) {
  return db.transaction(async (tx) => {
    const [r] = await tx.update(studioManaRefunds).set({ status: 'declined', decidedAt: now, decidedBy: adminId })
      .where(and(eq(studioManaRefunds.id, id), eq(studioManaRefunds.status, 'requested')))
      .returning()
    if (!r) {
      const [any] = await tx.select({ id: studioManaRefunds.id }).from(studioManaRefunds).where(eq(studioManaRefunds.id, id))
      throw new PaymentError(any ? 409 : 404, any ? 'already_decided' : 'not_found')
    }
    await addCredit(tx, r.userId, r.usdCents, 'mana_refund_declined', r.reportId, now)
    return { id, status: 'declined' as const }
  })
}
