import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import { db } from '../../db/connection.js'
import { studioCreditLedger, studioDesigns, studioFinalizeCredits, studioManaScan, studioManaTransfers, studioPayments } from '../../db/schema.js'
import { config } from '../../config.js'
import { takeCredit } from '../credit.js'
import { grantPayment, PaymentError } from '../payments.js'
import { getPolygon, parseTransfers, type ManaTransfer, type PolygonReader } from './polygon.js'

/**
 * Settling MANA payments. A payment is matched to a Transfer of exactly its quoted wei amount to the recipient on the
 * MANA contract, mined before its quote's expiry plus the grace, and settles once the transfer has 30 confirmations:
 * when the customer's page reports the transaction, or when the watcher (run by the sweep) finds it on its own.
 * Each transaction hash settles at most one payment: claiming it sets the payment's unique manaTxHash.
 */

const SCAN_ID = 'polygon'
const FIRST_SCAN_BLOCKS = 2000 // how far back the first scan starts
const MAX_SCAN_BLOCKS = 5000 // blocks scanned per call

type Payment = typeof studioPayments.$inferSelect

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const lateAfter = (pay: Payment) => pay.expiresAt!.getTime() + config.studioMana.graceMs

const isUniqueViolation = (err: unknown) =>
  (err as { code?: string }).code === '23505' || (err as { cause?: { code?: string } }).cause?.code === '23505'

function requireRecipient(): string {
  const r = config.studioMana.recipient
  if (!r) throw new PaymentError(503, 'mana_unavailable')
  return r
}

/**
 * Claims the hash for the payment (set where none is set, the unique column being the lock). 'taken' when another
 * payment holds the hash; 'other' when this payment already holds another hash (or is no longer open).
 */
async function claim(paymentId: string, txHash: string): Promise<'claimed' | 'taken' | 'other'> {
  try {
    const [got] = await db.update(studioPayments).set({ manaTxHash: txHash })
      .where(and(eq(studioPayments.id, paymentId), isNull(studioPayments.manaTxHash), inArray(studioPayments.status, ['pending', 'expired'])))
      .returning({ id: studioPayments.id })
    if (got) return 'claimed'
  } catch (err) {
    if (isUniqueViolation(err)) return 'taken'
    throw err
  }
  const [pay] = await db.select({ manaTxHash: studioPayments.manaTxHash }).from(studioPayments).where(eq(studioPayments.id, paymentId))
  return pay?.manaTxHash === txHash ? 'claimed' : 'other'
}

/**
 * Puts an expired MANA payment back to pending, taking its free finalizes and credit again (a newer checkout or the
 * sweep released them while its transaction was on the way). What was spent meanwhile can't be taken: the payment is
 * granted anyway and the owner absorbs the shortfall (ruling R2), which is logged, never owed to the customer.
 */
async function reopen(paymentId: string, now: Date): Promise<void> {
  const short = await db.transaction(async (tx) => {
    const [pay] = await tx.select().from(studioPayments)
      .where(and(eq(studioPayments.id, paymentId), eq(studioPayments.status, 'expired'))).for('update')
    if (!pay) return null
    // In the order a grant locks them: the design, the free finalizes, the credit
    if (pay.designId) await tx.select({ id: studioDesigns.id }).from(studioDesigns).where(eq(studioDesigns.id, pay.designId)).for('key share')
    const giftsWanted = pay.lines.filter((l) => l.gift).length
    let gifts = 0
    if (giftsWanted > 0) {
      await tx.insert(studioFinalizeCredits).values({ userId: pay.userId, balance: 0, updatedAt: now }).onConflictDoNothing()
      const [bal] = await tx.select().from(studioFinalizeCredits).where(eq(studioFinalizeCredits.userId, pay.userId)).for('update')
      gifts = Math.min(Math.max(bal.balance, 0), giftsWanted)
      if (gifts > 0) {
        await tx.update(studioFinalizeCredits).set({ balance: sql`${studioFinalizeCredits.balance} - ${gifts}`, updatedAt: now })
          .where(eq(studioFinalizeCredits.userId, pay.userId))
      }
    }
    // The credit the quote held: its first hold in the ledger
    const [hold] = await tx.select({ deltaCents: studioCreditLedger.deltaCents }).from(studioCreditLedger)
      .where(and(eq(studioCreditLedger.refId, pay.id), eq(studioCreditLedger.reason, 'hold')))
      .orderBy(asc(studioCreditLedger.createdAt)).limit(1)
    const creditWanted = hold ? -hold.deltaCents : 0
    const credit = await takeCredit(tx, pay.userId, creditWanted, 'hold', pay.id, now)
    await tx.update(studioPayments).set({ status: 'pending', giftsHeld: gifts, creditHeldCents: credit }).where(eq(studioPayments.id, pay.id))
    return { gifts: giftsWanted - gifts, cents: creditWanted - credit }
  })
  if (short && (short.gifts > 0 || short.cents > 0)) {
    console.warn(`[studio] MANA payment ${paymentId} was reopened short: ${short.cents} cents of credit and ${short.gifts} free finalizes`
      + ' were spent meanwhile; granted anyway, the shortfall is absorbed')
  }
}

/** Grants a claimed MANA payment, reopening it first if it was expired. */
async function settle(paymentId: string, now: Date): Promise<void> {
  await reopen(paymentId, now)
  await grantPayment(paymentId, null, now)
}

/** Records the transfer as settling this payment (taking over an unmatched record of it). */
async function recordMatched(t: ManaTransfer, paymentId: string): Promise<void> {
  await db.insert(studioManaTransfers).values({
    txHash: t.txHash, logIndex: t.logIndex, fromAddress: t.from, amountWei: t.amountWei.toString(), blockNumber: t.blockNumber,
    paymentId, status: 'matched',
  }).onConflictDoUpdate({
    target: [studioManaTransfers.txHash, studioManaTransfers.logIndex],
    set: { paymentId, status: 'matched' },
    setWhere: eq(studioManaTransfers.status, 'unmatched'),
  })
}

const stateOf = (status: string) => ({ status: status === 'paid' ? 'granted' as const : 'confirming' as const })

/**
 * The customer's page reports the transaction that pays a MANA payment. It is checked on chain (mined, not reverted, a
 * Transfer of exactly the quoted amount to the recipient on the MANA contract, mined within the quote and its grace),
 * claimed, and granted once it has 30 confirmations; before that it answers 'confirming' and the watcher grants it.
 */
export async function reportManaTx(
  userId: string, paymentId: string, txHash: string, now: Date, reader: PolygonReader = getPolygon(),
): Promise<{ status: 'granted' | 'confirming' }> {
  const hash = txHash.toLowerCase()
  const [pay] = await db.select().from(studioPayments).where(and(eq(studioPayments.id, paymentId), eq(studioPayments.userId, userId)))
  if (!pay || pay.method !== 'mana' || !pay.manaAmountWei || !pay.expiresAt) throw new PaymentError(404, 'not_found')
  const recipient = requireRecipient()
  const { token, confirmations } = config.studioMana
  // Already paid by a reported or found transaction: the same answer again
  if (pay.manaTxHash && (pay.manaTxHash !== hash || pay.status === 'paid')) return stateOf(pay.status)
  const [usedBy] = await db.select({ id: studioPayments.id }).from(studioPayments)
    .where(and(eq(studioPayments.manaTxHash, hash), ne(studioPayments.id, pay.id)))
  const [recorded] = await db.select({ id: studioManaTransfers.txHash }).from(studioManaTransfers)
    .where(and(eq(studioManaTransfers.txHash, hash), ne(studioManaTransfers.status, 'unmatched'),
      or(isNull(studioManaTransfers.paymentId), ne(studioManaTransfers.paymentId, pay.id))))
  if (usedBy || recorded) throw new PaymentError(409, 'tx_used')

  const receipt = await reader.receipt(hash)
  if (!receipt) throw new PaymentError(404, 'tx_not_found')
  if (receipt.status !== 1) throw new PaymentError(409, 'tx_failed')
  // The receipt's caller knows the hash and block of its own logs
  const transfer = parseTransfers(token, receipt.logs.map((l) => ({ ...l, transactionHash: hash, blockNumber: receipt.blockNumber })))
    .find((t) => sameAddress(t.to, recipient) && t.amountWei === BigInt(pay.manaAmountWei!))
  if (!transfer) throw new PaymentError(409, 'tx_mismatch')
  const minedAt = await reader.blockTime(receipt.blockNumber)
  if (minedAt.getTime() > lateAfter(pay)) throw new PaymentError(409, 'tx_late')

  const claimed = await claim(pay.id, hash)
  if (claimed === 'taken') throw new PaymentError(409, 'tx_used')
  if (claimed === 'other') {
    const [now_] = await db.select({ status: studioPayments.status }).from(studioPayments).where(eq(studioPayments.id, pay.id))
    return stateOf(now_.status)
  }
  if ((await reader.latestBlock()) - receipt.blockNumber < confirmations) return { status: 'confirming' }
  await settle(pay.id, now)
  await recordMatched(transfer, pay.id)
  return { status: 'granted' }
}

/**
 * The MANA payment a transfer pays: the one that claimed its hash, else one asking for exactly its amount that is
 * pending, or expired (by the sweep or a newer checkout) with the transfer mined within its quote and grace.
 */
async function paymentFor(t: ManaTransfer, minedAt: Date): Promise<Payment | null> {
  const rows = await db.select().from(studioPayments).where(and(
    eq(studioPayments.method, 'mana'), eq(studioPayments.manaAmountWei, t.amountWei.toString()),
    or(isNull(studioPayments.manaTxHash), eq(studioPayments.manaTxHash, t.txHash)),
  ))
  const own = rows.find((p) => p.manaTxHash === t.txHash)
  if (own) return own
  const open = rows.filter((p) => ['pending', 'expired'].includes(p.status) && p.expiresAt && minedAt.getTime() <= lateAfter(p))
    .sort((a, b) => (a.status === b.status ? b.createdAt.getTime() - a.createdAt.getTime() : a.status === 'pending' ? -1 : 1))
  return open[0] ?? null
}

/**
 * Scans the recipient's MANA transfers with 30 confirmations, from where the last scan stopped (2000 blocks back on
 * the first run), at most 5000 blocks a call. Each transfer is recorded once: matched (and its payment granted) or
 * unmatched, for the owner to look at. Throws on a chain or database error; the sweep logs it, and the next run picks
 * up from the same block, skipping transfers already recorded.
 */
export async function watchManaTransfers(now: Date, reader?: PolygonReader): Promise<{ matched: number; unmatched: number }> {
  const { recipient, token, confirmations } = config.studioMana
  const out = { matched: 0, unmatched: 0 }
  if (!recipient) return out
  const chain = reader ?? getPolygon()
  const latest = await chain.latestBlock()
  const [scan] = await db.select().from(studioManaScan).where(eq(studioManaScan.id, SCAN_ID))
  const fromBlock = scan ? scan.lastBlock + 1 : Math.max(latest - FIRST_SCAN_BLOCKS, 0)
  const toBlock = Math.min(latest - confirmations, fromBlock + MAX_SCAN_BLOCKS - 1)
  if (toBlock < fromBlock) return out
  const transfers = await chain.transfersTo(token, recipient, fromBlock, toBlock)
  const times = new Map<number, Date>()
  for (const raw of transfers) {
    if (!sameAddress(raw.to, recipient) || !raw.txHash) continue
    const t = { ...raw, txHash: raw.txHash.toLowerCase() }
    const [seen] = await db.select({ status: studioManaTransfers.status }).from(studioManaTransfers)
      .where(and(eq(studioManaTransfers.txHash, t.txHash), eq(studioManaTransfers.logIndex, t.logIndex)))
    if (seen) continue
    if (!times.has(t.blockNumber)) times.set(t.blockNumber, await chain.blockTime(t.blockNumber))
    const pay = await paymentFor(t, times.get(t.blockNumber)!)
    if (pay && (pay.status === 'paid' || (await claim(pay.id, t.txHash)) === 'claimed')) {
      await settle(pay.id, now)
      await recordMatched(t, pay.id)
      out.matched++
      continue
    }
    await db.insert(studioManaTransfers).values({
      txHash: t.txHash, logIndex: t.logIndex, fromAddress: t.from, amountWei: t.amountWei.toString(), blockNumber: t.blockNumber,
      status: 'unmatched',
    }).onConflictDoNothing()
    out.unmatched++
  }
  await db.insert(studioManaScan).values({ id: SCAN_ID, lastBlock: toBlock })
    .onConflictDoUpdate({ target: studioManaScan.id, set: { lastBlock: sql`greatest(${studioManaScan.lastBlock}, ${toBlock})` } })
  return out
}
