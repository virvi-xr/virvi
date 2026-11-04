import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import {
  studioDesigns, studioEntitlements, studioFinalizeCredits, studioJobs, studioMistakeReports, studioPayments, studioPieces, studioPromptCredits,
  studioRenders, studioRevisions, users, type PaymentLine,
} from '../db/schema.js'
import { config } from '../config.js'
import { ensureCustomer, getStripe } from '../integrations/stripe.js'
import { allocateCredit, chargedCents, dueCentsOf, instantReportsUsed, isVirviAdmin, priceLines, quoteFinalize, QuoteError } from './pricing.js'
import { addCredit, creditBalance, takeCredit } from './credit.js'
import { startWorker, type Design } from './designs.js'
import type { Exec } from './quota.js'
import { publishStudio } from './events.js'
import { mailOwner } from './scope.js'
import { frameUrlExpiry, signRenderFrame } from './render-urls.js'
import { getManaRate, type ManaRate } from './mana/rate.js'
import { ManaBusy, manaQuoteOf, setManaAmount, type ManaQuote } from './mana/quote.js'

/**
 * Design Studio payments: one-time Stripe Checkout sessions for finalizing pieces and for prompt top-ups, applied once
 * from Stripe's webhook. A paid revision gets an entitlement, and the finalize job builds its package from the exact
 * files that were paid for.
 */

// Stripe refuses an expires_at under 30 minutes away, measured when it receives the request
const CHECKOUT_TTL_MS = 31 * 60 * 1000
export const FINALIZE_LIMITS = { timeoutSec: 1800, maxTurns: 0, costCeilingUsd: 0 }
export const REPORT_WINDOW_DAYS = 30
const PENDING_REPORT_MS = 10 * 60_000
// An open MANA quote is handed out again only with more than this left to pay it in
const MANA_REUSE_MIN_MS = 2 * 60_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class PaymentError extends Error {
  constructor(public status: number, public code: string) { super(code) }
}

export type CheckoutMethod = 'card' | 'mana'
export type CheckoutResult = { url: string } | { mana: ManaQuote } | { granted: true; paymentId: string }

/** A MANA checkout is refused before anything is held when MANA is off (no recipient set). */
function requireMana(): void {
  if (!config.studioMana.recipient) throw new PaymentError(503, 'mana_unavailable')
}

/** The rate a MANA quote is priced at; refused with no rate fetched in the last 5 minutes. */
async function requireRate(now: Date): Promise<ManaRate> {
  const rate = await getManaRate(now)
  if (!rate) throw new PaymentError(503, 'rate_unavailable')
  return rate
}

/** Prices a pending MANA payment's due cents and returns its quote, in the transaction that holds its credit. */
async function quoteMana(
  tx: Exec, pay: typeof studioPayments.$inferSelect, creditCents: number, dueCents: number, rate: ManaRate | null,
): Promise<ManaQuote> {
  if (!rate) throw new PaymentError(503, 'rate_unavailable')
  try {
    const amountWei = await setManaAmount(tx, pay.id, dueCents, rate)
    return manaQuoteOf({ ...pay, creditHeldCents: creditCents, manaAmountWei: amountWei, manaUsdRate: String(rate.usdPerMana) })
  } catch (err) {
    if (err instanceof ManaBusy) throw new PaymentError(503, 'mana_busy')
    throw err
  }
}

const appUrl = (path: string) => `${config.publicUrl.replace(/\/+$/, '')}${path}`
// An open session is reused only for exactly the same lines: revisions, what each costs, which are waived or free, and
// what credit pays of each
const lineKey = (lines: PaymentLine[]) =>
  lines.map((l) => `${l.revisionId}:${l.amountCents}:${l.gift ? 'g' : l.waived ? 'w' : l.held ? 'h' : 'c'}:${l.creditCents ?? 0}`).sort().join(',')
const sameLines = (a: PaymentLine[], b: PaymentLine[]) => lineKey(a) === lineKey(b)

function lineName(l: PaymentLine): string {
  return l.priceKind.startsWith('revision') ? `${l.pieceName}: revision ${l.revisionNumber}` : `${l.pieceName}: finalize`
}

async function openSession(params: Record<string, unknown>, paymentId: string): Promise<string> {
  try {
    const session = await (await getStripe()).checkout.sessions.create(params)
    await db.update(studioPayments).set({ stripeSessionId: session.id, stripeSessionUrl: session.url }).where(eq(studioPayments.id, paymentId))
    return session.url
  } catch (err) {
    console.error('[studio] checkout session failed:', err instanceof Error ? err.message : err)
    await dropPayment(paymentId, new Date())
    throw new PaymentError(502, 'stripe_error')
  }
}

/** Adds free-finalize credits back to a user's balance. */
async function returnGifts(tx: Exec, userId: string, n: number, now: Date): Promise<void> {
  if (!(n > 0)) return
  await tx.insert(studioFinalizeCredits).values({ userId, balance: n, updatedAt: now })
    .onConflictDoUpdate({ target: studioFinalizeCredits.userId, set: { balance: sql`${studioFinalizeCredits.balance} + ${n}`, updatedAt: now } })
}

/** Deletes a pending payment that never reached Stripe, giving back the free finalizes and credit it held, in one step. */
async function dropPayment(paymentId: string, now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    const [gone] = await tx.delete(studioPayments).where(and(eq(studioPayments.id, paymentId), eq(studioPayments.status, 'pending')))
      .returning({ userId: studioPayments.userId, giftsHeld: studioPayments.giftsHeld, creditHeldCents: studioPayments.creditHeldCents })
    if (!gone) return
    await returnGifts(tx, gone.userId, gone.giftsHeld, now)
    await addCredit(tx, gone.userId, gone.creditHeldCents, 'release', paymentId, now)
  })
}

/**
 * Marks a pending payment expired and gives back the free finalizes and credit it held, once (a paid or expired one is
 * left alone).
 */
async function expirePayment(paymentId: string, now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    const [pay] = await tx.select({ userId: studioPayments.userId, giftsHeld: studioPayments.giftsHeld, creditHeldCents: studioPayments.creditHeldCents })
      .from(studioPayments).where(and(eq(studioPayments.id, paymentId), eq(studioPayments.status, 'pending'))).for('update')
    if (!pay) return
    await tx.update(studioPayments).set({ status: 'expired', giftsHeld: 0, creditHeldCents: 0 }).where(eq(studioPayments.id, paymentId))
    await returnGifts(tx, pay.userId, pay.giftsHeld, now)
    await addCredit(tx, pay.userId, pay.creditHeldCents, 'release', paymentId, now)
  })
}

/**
 * Holds credit for a new pending checkout (a finalize or a top-up, whatever pays the rest): takes up to what it
 * charges from the user's balance under a lock on the credit row, spends it on its lines in order, and records both
 * on the payment. One the credit covers in full becomes a credit payment, granted at once by its caller. The caller
 * locks the design and the free-finalize credits first, in the order a grant does.
 */
async function holdCredit(
  tx: Exec, pay: { id: string; userId: string; amountCents: number; lines: PaymentLine[] }, now: Date,
): Promise<{ lines: PaymentLine[]; creditCents: number; dueCents: number }> {
  const taken = await takeCredit(tx, pay.userId, pay.amountCents, 'hold', pay.id, now)
  if (!(taken > 0)) return { lines: pay.lines, creditCents: 0, dueCents: pay.amountCents }
  const lines = pay.lines.length ? allocateCredit(pay.lines, taken).lines : pay.lines
  const dueCents = pay.amountCents - taken
  await tx.update(studioPayments).set({
    lines, creditHeldCents: taken, ...(dueCents === 0 ? { method: 'credit', expiresAt: null } : {}),
  }).where(eq(studioPayments.id, pay.id))
  return { lines, creditCents: taken, dueCents }
}

/**
 * Expires open checkouts another checkout takes over the holds of: a card one through Stripe (one Stripe won't expire
 * keeps them), a MANA quote (no Stripe session) directly.
 */
async function expireOpen(pays: { id: string; method: string; stripeSessionId: string | null }[], now: Date): Promise<void> {
  for (const p of pays) {
    if (p.method === 'mana') {
      await expirePayment(p.id, now)
      continue
    }
    if (!p.stripeSessionId) continue // one still being opened is left to its request
    try {
      await (await getStripe()).checkout.sessions.expire(p.stripeSessionId)
    } catch (err) {
      console.error(`[studio] checkout ${p.id} could not be expired:`, err instanceof Error ? err.message : err)
      continue
    }
    await expirePayment(p.id, now)
  }
}

/**
 * Credit cents a checkout could use: the user's balance plus what their open checkouts for this design (or their open
 * top-ups, for null) hold, since a new checkout takes those over.
 */
export async function creditFor(userId: string, designId: string | null, now: Date, exec: Exec = db): Promise<number> {
  const [held] = await exec.select({ n: sql<number>`coalesce(sum(${studioPayments.creditHeldCents}), 0)::int` }).from(studioPayments)
    .where(and(eq(studioPayments.userId, userId),
      designId ? and(eq(studioPayments.designId, designId), eq(studioPayments.kind, 'finalize')) : eq(studioPayments.kind, 'topup'),
      eq(studioPayments.status, 'pending'), gt(studioPayments.expiresAt, now)))
  return (await creditBalance(userId, exec)) + held.n
}

/**
 * Free-finalize credits a checkout for this design could use: the user's balance plus what this design's open
 * checkouts hold (a new checkout takes those over).
 */
export async function giftsFor(userId: string, designId: string, now: Date, exec: Exec = db): Promise<number> {
  const [bal] = await exec.select({ balance: studioFinalizeCredits.balance }).from(studioFinalizeCredits)
    .where(eq(studioFinalizeCredits.userId, userId))
  const [held] = await exec.select({ n: sql<number>`coalesce(sum(${studioPayments.giftsHeld}), 0)::int` }).from(studioPayments)
    .where(and(eq(studioPayments.userId, userId), eq(studioPayments.designId, designId), eq(studioPayments.kind, 'finalize'),
      eq(studioPayments.status, 'pending'), gt(studioPayments.expiresAt, now)))
  return (bal?.balance ?? 0) + held.n
}

/**
 * A checkout for a design's pieces. An open session with exactly the same lines is reused. Otherwise, when the new
 * quote has a free line (or spends Virvi credit), this design's open sessions that hold free finalizes (or credit) are
 * expired through Stripe first, so they come back for the new quote; one Stripe won't expire (already paid) keeps
 * them, and a checkout that would then lose a free line or credit it was quoted is refused (free_finalize_busy,
 * credit_busy). The new checkout then takes its free finalizes, and after them its credit, from the balances under
 * locks on the user's rows, so two checkouts at once never use one twice. A checkout that never reaches Stripe gives
 * them back; an expired one gives them back from the webhook. One the credit covers in full is granted at once.
 *
 * With method 'mana' there is no Stripe session: the rest is quoted in MANA at the current rate (ManaQuote), held for
 * 10 minutes. An open MANA quote for the same lines with more than 2 minutes left is handed out again; otherwise this
 * design's open MANA quotes are expired (giving back their holds) and a new one is made. It is refused with MANA off
 * (mana_unavailable) or no fresh rate (rate_unavailable) before anything is held.
 */
export async function createFinalizeCheckout(
  design: Design,
  user: { id: string; email: string | null },
  categories: string[] | null,
  reports: Record<string, string>,
  now: Date,
  method: CheckoutMethod = 'card',
): Promise<CheckoutResult> {
  if (method === 'mana') requireMana()
  const waived = Object.keys(reports)
  const withReports = (lines: PaymentLine[]) => lines.map((l) => (l.waived || l.held ? { ...l, reportText: reports[l.category] } : l))
  const admin = await isVirviAdmin(user.id)
  const quote = await quoteFinalize(design, categories, waived, admin ? 0 : await giftsFor(user.id, design.id, now), db,
    { admin, credit: admin ? 0 : await creditFor(user.id, design.id, now) })
  if (!quote.lines.length) throw new QuoteError('nothing_to_pay', categories ?? [])
  const open = await db.select().from(studioPayments).where(and(
    eq(studioPayments.designId, design.id), eq(studioPayments.status, 'pending'), gt(studioPayments.expiresAt, now),
  ))
  if (quote.dueCents > 0 && method === 'card') {
    const same = open.find((p) => p.stripeSessionUrl && sameLines(p.lines, withReports(quote.lines)))
    if (same) return { url: same.stripeSessionUrl! }
  }
  if (quote.dueCents > 0 && method === 'mana') {
    const same = open.find((p) => p.method === 'mana' && p.manaAmountWei && sameLines(p.lines, withReports(quote.lines))
      && p.expiresAt!.getTime() - now.getTime() > MANA_REUSE_MIN_MS)
    if (same) return { mana: manaQuoteOf(same) }
  }
  // The rate before anything is expired or held, so a refusal leaves everything as it was
  const rate = method === 'mana' && quote.dueCents > 0 ? await requireRate(now) : null
  // A new MANA quote replaces this design's open ones; any checkout takes over the free finalizes and credit it needs
  await expireOpen(open.filter((p) => (method === 'mana' && p.method === 'mana')
    || (quote.giftsUsed > 0 && p.giftsHeld > 0) || (quote.creditCents > 0 && p.creditHeldCents > 0)), now)

  const expiresAt = new Date(now.getTime() + (method === 'mana' ? config.studioMana.quoteTtlMs : CHECKOUT_TTL_MS))
  const { pay, lines, mana } = await db.transaction(async (tx) => {
    // The design before the credits, in the order a grant locks them (the payment's foreign key needs the design)
    await tx.select({ id: studioDesigns.id }).from(studioDesigns).where(eq(studioDesigns.id, design.id)).for('key share')
    await tx.insert(studioFinalizeCredits).values({ userId: user.id, balance: 0, updatedAt: now }).onConflictDoNothing()
    const [credits] = await tx.select().from(studioFinalizeCredits).where(eq(studioFinalizeCredits.userId, user.id)).for('update')
    const q = await quoteFinalize(design, categories, waived, admin ? 0 : credits.balance, tx, { admin })
    if (!q.lines.length) throw new QuoteError('nothing_to_pay', categories ?? [])
    // The quote the customer saw counted a credit an older checkout still holds (Stripe didn't expire it, or it is
    // still opening): refuse rather than charge that line in full
    if (q.giftsUsed < quote.giftsUsed) throw new PaymentError(409, 'free_finalize_busy')
    const [pay] = await tx.insert(studioPayments).values({
      userId: user.id, designId: design.id, kind: 'finalize', amountCents: q.totalCents, lines: withReports(q.lines), giftsHeld: q.giftsUsed,
      ...(q.totalCents > 0 ? { expiresAt, method } : {}),
    }).returning()
    if (q.giftsUsed > 0) {
      await tx.update(studioFinalizeCredits).set({ balance: sql`${studioFinalizeCredits.balance} - ${q.giftsUsed}`, updatedAt: now })
        .where(eq(studioFinalizeCredits.userId, user.id))
    }
    // Credit after gifts: the lock on the credit row comes last
    const held = await holdCredit(tx, pay, now)
    if (held.creditCents < Math.min(quote.creditCents, q.totalCents)) throw new PaymentError(409, 'credit_busy')
    // MANA pays what is left after gifts and credit: the lines with something due
    const mana = method === 'mana' && held.dueCents > 0 ? await quoteMana(tx, pay, held.creditCents, held.dueCents, rate) : null
    return { pay: { ...pay, dueCents: held.dueCents }, lines: held.lines, mana }
  })
  if (pay.dueCents === 0) {
    try {
      await grantPayment(pay.id, null, now)
    } catch (err) {
      await dropPayment(pay.id, now) // a grant that didn't commit leaves it pending, holding its credits
      throw err
    }
    return { granted: true, paymentId: pay.id }
  }
  if (mana) return { mana }
  let customer: string
  try {
    customer = await ensureCustomer(user.id, user.email)
  } catch (err) {
    console.error('[studio] stripe customer failed:', err instanceof Error ? err.message : err)
    await dropPayment(pay.id, now)
    throw new PaymentError(502, 'stripe_error')
  }
  const metadata = { vlm_user_id: user.id, vlm_studio_payment_id: pay.id }
  const url = await openSession({
    mode: 'payment',
    customer,
    line_items: lines.filter((l) => dueCentsOf(l) > 0).map((l) => ({
      quantity: 1,
      price_data: { currency: 'usd', unit_amount: dueCentsOf(l), product_data: { name: lineName(l) } },
    })),
    metadata,
    payment_intent_data: { metadata },
    success_url: appUrl(`/studio/${design.id}?payment=${pay.id}`),
    cancel_url: appUrl(`/studio/${design.id}`),
    expires_at: Math.floor(expiresAt.getTime() / 1000),
  }, pay.id)
  return { url }
}

/**
 * A checkout for prompt packs. Virvi credit pays first, held as a finalize's is: the user's open top-ups that hold
 * credit are expired through Stripe so it comes back for this one, and a top-up the credit covers in full is granted
 * at once. With method 'mana' the rest is quoted in MANA instead, as a finalize's is.
 */
export async function createTopupCheckout(
  user: { id: string; email: string | null }, packs: number, now: Date, method: CheckoutMethod = 'card',
): Promise<CheckoutResult> {
  const { topupCents, topupPrompts } = config.studioPrices
  if (method === 'mana') requireMana()
  const credit = await creditFor(user.id, null, now)
  // The rate before anything is expired or held, so a refusal leaves everything as it was
  const rate = method === 'mana' && credit < topupCents * packs ? await requireRate(now) : null
  const expiresAt = new Date(now.getTime() + (method === 'mana' ? config.studioMana.quoteTtlMs : CHECKOUT_TTL_MS))
  if (credit > 0) {
    await expireOpen(await db.select().from(studioPayments).where(and(
      eq(studioPayments.userId, user.id), eq(studioPayments.kind, 'topup'), eq(studioPayments.status, 'pending'),
      gt(studioPayments.expiresAt, now), gt(studioPayments.creditHeldCents, 0),
    )), now)
  }
  const { pay, held, mana } = await db.transaction(async (tx) => {
    const [pay] = await tx.insert(studioPayments).values({
      userId: user.id, kind: 'topup', amountCents: topupCents * packs, prompts: topupPrompts * packs, expiresAt, method,
    }).returning()
    const held = await holdCredit(tx, pay, now)
    const mana = method === 'mana' && held.dueCents > 0 ? await quoteMana(tx, pay, held.creditCents, held.dueCents, rate) : null
    return { pay, held, mana }
  })
  if (held.dueCents === 0) {
    try {
      await grantPayment(pay.id, null, now)
    } catch (err) {
      await dropPayment(pay.id, now)
      throw err
    }
    return { granted: true, paymentId: pay.id }
  }
  if (mana) return { mana }
  let customer: string
  try {
    customer = await ensureCustomer(user.id, user.email)
  } catch (err) {
    console.error('[studio] stripe customer failed:', err instanceof Error ? err.message : err)
    await dropPayment(pay.id, now)
    throw new PaymentError(502, 'stripe_error')
  }
  const metadata = { vlm_user_id: user.id, vlm_studio_payment_id: pay.id }
  const url = await openSession({
    mode: 'payment',
    customer,
    // With credit spent, the rest is one line: it needn't divide by the packs
    line_items: held.creditCents > 0
      ? [{ quantity: 1, price_data: { currency: 'usd', unit_amount: held.dueCents, product_data: { name: `${topupPrompts * packs} Design Studio prompts` } } }]
      : [{ quantity: packs, price_data: { currency: 'usd', unit_amount: topupCents, product_data: { name: `${topupPrompts} Design Studio prompts` } } }],
    metadata,
    payment_intent_data: { metadata },
    success_url: appUrl(`/studio?payment=${pay.id}`),
    cancel_url: appUrl('/studio'),
    expires_at: Math.floor(expiresAt.getTime() / 1000),
  }, pay.id)
  return { url }
}

/**
 * Applies a paid payment once (a conditional update claims it): entitlements and their finalize jobs for a finalize,
 * credits for a top-up, all in one transaction, so a paid revision is never left without a job. Each line is priced
 * again against what is paid for by then (another checkout may have been paid first): an overcharge, and a line whose
 * revision was already paid for, are owed back, refunded after the commit and retried by the sweep until Stripe
 * confirms. A free line (a free-finalize credit) is charged nothing; one whose revision was already paid for gives its
 * credit back instead. Of what a line is owed back, the share Virvi credit paid goes back as credit at once (a line
 * kept at a lower price keeps as much of its credit as it still charges); only the rest is refunded.
 */
export async function grantPayment(paymentId: string, paymentIntent: string | null, now: Date): Promise<'granted' | 'already'> {
  const held: { name: string; revision: number; text: string }[] = []
  const out = await db.transaction(async (tx) => {
    const [pay] = await tx.update(studioPayments)
      .set({ status: 'paid', paidAt: now, ...(paymentIntent ? { stripePaymentIntent: paymentIntent } : {}) })
      .where(and(eq(studioPayments.id, paymentId), eq(studioPayments.status, 'pending')))
      .returning()
    if (!pay) return null
    if (pay.kind === 'topup') {
      await tx.insert(studioPromptCredits).values({ userId: pay.userId, balance: pay.prompts })
        .onConflictDoUpdate({ target: studioPromptCredits.userId, set: { balance: sql`${studioPromptCredits.balance} + ${pay.prompts}`, updatedAt: now } })
      return { pay, jobIds: [] as string[] }
    }
    // Grants for one design run one at a time, so each prices against the others
    const [design] = await tx.select().from(studioDesigns).where(eq(studioDesigns.id, pay.designId!)).for('update')
    const earlier = await tx.select({ category: studioEntitlements.category, revisionId: studioEntitlements.revisionId })
      .from(studioEntitlements).where(eq(studioEntitlements.designId, design.id))
    const fresh = pay.lines.filter((l) => !earlier.some((e) => e.revisionId === l.revisionId))
    const repriced = priceLines(design.kind, fresh.map((l) => ({
      kind: earlier.some((e) => e.category === l.category) ? 'revision' as const : 'first' as const,
      category: l.category, footprint: l.footprint,
    })), earlier.length > 0)
    const unpaid = pay.lines.filter((l) => !fresh.includes(l))
    let owed = unpaid.reduce((sum, l) => sum + dueCentsOf(l), 0)
    let creditBack = unpaid.reduce((sum, l) => sum + (l.creditCents ?? 0), 0)
    // A free line whose revision was paid for meanwhile gives its credit back
    const unusedGifts = Math.min(pay.giftsHeld, pay.lines.filter((l) => !fresh.includes(l) && l.gift).length)
    if (unusedGifts > 0) {
      await tx.update(studioPayments).set({ giftsHeld: pay.giftsHeld - unusedGifts }).where(eq(studioPayments.id, pay.id))
      await returnGifts(tx, pay.userId, unusedGifts, now)
    }
    const entitlementIds: string[] = []
    for (const [i, l] of fresh.entries()) {
      const price = repriced[i]
      // Never more than was paid for the line; a credit still covers what it covered
      const charged = chargedCents({ ...l, amountCents: Math.min(l.amountCents, price.amountCents) })
      const creditCents = Math.min(l.creditCents ?? 0, charged)
      creditBack += (l.creditCents ?? 0) - creditCents
      owed += dueCentsOf(l) - (charged - creditCents)
      const [e] = await tx.insert(studioEntitlements).values({
        revisionId: l.revisionId, paymentId: pay.id, userId: pay.userId, designId: design.id, category: l.category,
        kind: price.priceKind.startsWith('revision') ? 'revision' : 'first', amountCents: charged, method: pay.method, creditCents,
        status: 'packaging',
      }).returning()
      entitlementIds.push(e.id)
      if (l.waived) {
        await tx.insert(studioMistakeReports).values({
          entitlementId: e.id, userId: pay.userId, text: l.reportText ?? '', refundCents: l.amountCents, status: 'waived',
        })
      } else if (l.held) { // past the instant limit: charged, and the report waits for the owner
        await tx.insert(studioMistakeReports).values({
          entitlementId: e.id, userId: pay.userId, text: l.reportText ?? '', refundCents: charged, status: 'in_review',
        })
        held.push({ name: l.pieceName, revision: l.revisionNumber, text: l.reportText ?? '' })
      }
    }
    // The credit row after the design and the free-finalize credits, in the order a checkout locks them
    await addCredit(tx, pay.userId, creditBack, 'refund', pay.id, now)
    if (owed > 0) await tx.update(studioPayments).set({ refundDueCents: owed }).where(eq(studioPayments.id, pay.id))
    if (entitlementIds.length) {
      await tx.update(studioDesigns).set({ finalizedAt: now })
        .where(and(eq(studioDesigns.id, design.id), isNull(studioDesigns.finalizedAt)))
    }
    return { pay, jobIds: await insertFinalizeJobs(tx, design, entitlementIds, now) }
  })
  if (!out) return 'already'
  for (const h of held) await mailHeldReport(out.pay.userId, h.name, h.revision, h.text)
  await settleRefund(out.pay.id)
  await startFinalizeJobs(out.pay.designId, out.jobIds, now)
  return 'granted'
}

/** One finalize job per entitlement, each building one paid revision's package from that revision's own files. */
async function insertFinalizeJobs(tx: Exec, design: Design, entitlementIds: string[], now: Date): Promise<string[]> {
  if (!entitlementIds.length) return []
  const rows = await tx.select({ e: studioEntitlements, r: studioRevisions, name: studioPieces.name })
    .from(studioEntitlements)
    .innerJoin(studioRevisions, eq(studioRevisions.id, studioEntitlements.revisionId))
    .innerJoin(studioPieces, eq(studioPieces.id, studioRevisions.pieceId))
    .where(inArray(studioEntitlements.id, entitlementIds))
  const jobIds: string[] = []
  for (const { e, r, name } of rows) {
    const [job] = await tx.insert(studioJobs).values({
      designId: design.id,
      type: 'finalize',
      payload: {
        type: 'finalize', kind: design.kind, agent: null, model: null, prompt: null, selectedSlots: null,
        limits: FINALIZE_LIMITS, render: null,
        finalize: {
          designName: design.name,
          pieces: [{ category: e.category, name, revision: r.number, files: r.files, sourceJobId: r.jobId }],
        },
      },
    }).returning({ id: studioJobs.id })
    await tx.update(studioEntitlements).set({ status: 'packaging', jobId: job.id }).where(eq(studioEntitlements.id, e.id))
    jobIds.push(job.id)
  }
  await tx.update(studioDesigns).set({ lastJobAt: now }).where(eq(studioDesigns.id, design.id))
  return jobIds
}

async function startFinalizeJobs(designId: string | null, jobIds: string[], now: Date): Promise<void> {
  if (!designId || !jobIds.length) return
  for (const jobId of jobIds) await publishStudio(designId, { type: 'job', jobId, status: 'queued' })
  await startWorker(designId, jobIds[0], now)
}

/** Queues packaging again for these entitlements (a free retry, or the sweep finding one with no live job). */
export async function queueFinalize(designId: string, entitlementIds: string[], now: Date): Promise<string[]> {
  const jobIds = await db.transaction(async (tx) => {
    const [design] = await tx.select().from(studioDesigns).where(eq(studioDesigns.id, designId)).for('update')
    return insertFinalizeJobs(tx, design, entitlementIds, now)
  })
  await startFinalizeJobs(designId, jobIds, now)
  return jobIds
}

/**
 * Pays back what a payment owes (refundDueCents). A card payment is refunded through Stripe: a refund Stripe already
 * made for it (an answer that was lost) is recorded rather than repeated; a failed attempt counts up, and its key with
 * it, because Stripe replays a key's first answer, errors included. A MANA or credit payment's debt goes back as
 * Virvi credit, once: the debt is cleared in the same transaction.
 */
export async function settleRefund(paymentId: string): Promise<void> {
  const [pay] = await db.select().from(studioPayments).where(eq(studioPayments.id, paymentId))
  if (!pay || !(pay.refundDueCents > 0)) return
  if (pay.method === 'mana' || pay.method === 'credit') {
    const due = pay.refundDueCents
    try {
      await db.transaction(async (tx) => {
        const [cleared] = await tx.update(studioPayments).set({ refundDueCents: 0 })
          .where(and(eq(studioPayments.id, pay.id), eq(studioPayments.refundDueCents, due))).returning({ id: studioPayments.id })
        if (cleared) await addCredit(tx, pay.userId, due, 'refund', pay.id, new Date())
      })
    } catch (err) { // the sweep tries again
      console.error(`[studio] crediting ${due} cents owed by payment ${pay.id} failed:`, err instanceof Error ? err.message : err)
    }
    return
  }
  if (!pay.stripePaymentIntent) {
    console.error(`[studio] payment ${pay.id} owes ${pay.refundDueCents} cents but has no payment intent to refund`)
    return
  }
  const due = pay.refundDueCents
  try {
    const stripe = await getStripe()
    const made = (await stripe.refunds.list({ payment_intent: pay.stripePaymentIntent, limit: 100 })).data as { metadata?: Record<string, string> }[]
    if (!made.some((r) => r.metadata?.virvi_studio_owed_by === pay.id)) {
      await stripe.refunds.create(
        { payment_intent: pay.stripePaymentIntent, amount: due, metadata: { vlm_studio_payment_id: pay.id, virvi_studio_owed_by: pay.id } },
        { idempotencyKey: `studio-refund-${pay.id}-${pay.refundAttempts}` },
      )
    }
    await db.update(studioPayments)
      .set({ refundDueCents: 0, refundedCents: sql`${studioPayments.refundedCents} + ${due}` })
      .where(and(eq(studioPayments.id, pay.id), eq(studioPayments.refundDueCents, due)))
  } catch (err) {
    console.error(`[studio] refund of ${due} cents for payment ${pay.id} failed:`, err instanceof Error ? err.message : err)
    await db.update(studioPayments).set({ refundAttempts: sql`${studioPayments.refundAttempts} + 1` }).where(eq(studioPayments.id, pay.id))
  }
}

/** A Stripe Checkout event for a studio payment; false when the event isn't one. */
export async function handleStudioSession(event: { type: string; data?: { object?: any } }): Promise<boolean> {
  const s = event.data?.object
  const id = s?.metadata?.vlm_studio_payment_id
  if (!id || s?.object !== 'checkout.session' || s.mode !== 'payment') return false
  if (typeof id !== 'string' || !UUID.test(id)) return true
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    if (s.payment_status === 'paid') await grantPayment(id, typeof s.payment_intent === 'string' ? s.payment_intent : null, new Date())
  } else if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
    // A delayed payment (a bank debit) that fails ends the checkout as an expiry does: Stripe won't expire it later
    await expirePayment(id, new Date())
  }
  return true
}

/**
 * The customer says a paid revision fixed the agent's own mistake: its line is refunded in full, the way it was paid
 * (refundSplit), at once and without review (Virvi reviews the log afterwards). A pending report row is the lock, so
 * two clicks refund once; a refund Stripe already made for this entitlement (an answer that was lost) is recorded,
 * not repeated; a refused refund removes the row so the customer can try again, under a new key (Stripe replays a
 * key's first answer, errors included).
 */
export async function reportMistake(
  design: Design,
  category: string,
  revisionNumber: number,
  text: string,
  now: Date,
): Promise<RefundResult | { status: 'in_review' }> {
  const [row] = await db.select({ e: studioEntitlements, pay: studioPayments })
    .from(studioEntitlements)
    .innerJoin(studioRevisions, eq(studioRevisions.id, studioEntitlements.revisionId))
    .innerJoin(studioPieces, eq(studioPieces.id, studioRevisions.pieceId))
    .innerJoin(studioPayments, eq(studioPayments.id, studioEntitlements.paymentId))
    .where(and(eq(studioPieces.designId, design.id), eq(studioPieces.category, category), eq(studioRevisions.number, revisionNumber)))
  if (!row) throw new PaymentError(402, 'not_paid')
  const { e, pay } = row
  if (e.kind !== 'revision') throw new PaymentError(409, 'not_a_revision')
  if (!(e.amountCents > 0)) throw new PaymentError(409, 'nothing_charged')
  if (refundSplit(e).stripeCents > 0 && !pay.stripePaymentIntent) throw new PaymentError(409, 'nothing_charged')
  if (!pay.paidAt || now.getTime() - pay.paidAt.getTime() > REPORT_WINDOW_DAYS * 24 * 3600 * 1000) {
    throw new PaymentError(409, 'report_window_closed')
  }
  if ((await instantReportsUsed(design.id, category)) >= config.studioFlag.instantReports) {
    const [held] = await db.insert(studioMistakeReports).values({
      entitlementId: e.id, userId: e.userId, text, refundCents: e.amountCents, status: 'in_review', createdAt: now,
    }).onConflictDoNothing().returning()
    if (!held) throw new PaymentError(409, 'already_reported')
    const [piece] = await db.select({ name: studioPieces.name }).from(studioPieces)
      .where(and(eq(studioPieces.designId, design.id), eq(studioPieces.category, category)))
    await mailHeldReport(e.userId, piece?.name ?? category, revisionNumber, text)
    return { status: 'in_review' }
  }
  // A pending row left by a request that died mid-refund stops being a lock after a while
  await db.delete(studioMistakeReports).where(and(
    eq(studioMistakeReports.entitlementId, e.id), eq(studioMistakeReports.status, 'pending'),
    lt(studioMistakeReports.createdAt, new Date(now.getTime() - PENDING_REPORT_MS)),
  ))
  const [lock] = await db.insert(studioMistakeReports).values({
    entitlementId: e.id, userId: e.userId, text, refundCents: e.amountCents, status: 'pending', createdAt: now,
  }).onConflictDoNothing().returning()
  if (!lock) throw new PaymentError(409, 'already_reported')
  return refundReport(e, pay, lock.id, 'delete')
}

export type RefundResult = { status: 'refunded'; refundCents: number; creditedCents: number; manaCents: number }

/**
 * How a line's refund goes back, the way it was paid: a card line's card share through Stripe; its credit share, and
 * all of a MANA or credit line, as Virvi credit. `manaCents` is the share MANA paid (it may later go back as MANA).
 */
export function refundSplit(e: { amountCents: number; creditCents: number; method: string }): { stripeCents: number; creditCents: number; manaCents: number } {
  const credit = Math.min(Math.max(e.creditCents, 0), e.amountCents)
  if (e.method === 'mana') return { stripeCents: 0, creditCents: credit, manaCents: e.amountCents - credit }
  if (e.method === 'credit') return { stripeCents: 0, creditCents: e.amountCents, manaCents: 0 }
  return { stripeCents: e.amountCents - credit, creditCents: credit, manaCents: 0 }
}

/**
 * Refunds a report's line in full, the way it was paid (refundSplit), and records it. The Stripe share is refunded
 * first; a refund Stripe already made for this entitlement (an answer that was lost) is recorded, not repeated. On a
 * refused refund the report is removed (a customer's instant report, so they can try again) or put back in review
 * (an owner's approval), and 502 is thrown. The credit share is added in the transaction that marks the report
 * refunded, and only if this call is the one that marks it, so a retried report never credits twice.
 */
async function refundReport(
  e: typeof studioEntitlements.$inferSelect, pay: typeof studioPayments.$inferSelect, reportId: string,
  onFailure: 'delete' | 'back_to_review', review?: { by: string; at: Date },
): Promise<RefundResult> {
  const split = refundSplit(e)
  const creditedCents = split.creditCents + split.manaCents
  let refundId: string | null = null
  if (split.stripeCents > 0) {
    try {
      const stripe = await getStripe()
      const made = (await stripe.refunds.list({ payment_intent: pay.stripePaymentIntent!, limit: 100 })).data as { id: string; metadata?: Record<string, string> }[]
      const earlier = made.find((r) => r.metadata?.virvi_studio_entitlement_id === e.id)
      refundId = earlier?.id ?? (await stripe.refunds.create(
        { payment_intent: pay.stripePaymentIntent!, amount: split.stripeCents, metadata: { virvi_studio_entitlement_id: e.id, reason: 'agent_mistake' } },
        { idempotencyKey: `studio-report-${e.id}-${reportId}` },
      )).id
    } catch (err) {
      console.error('[studio] mistake refund failed:', err instanceof Error ? err.message : err)
      if (onFailure === 'delete') await db.delete(studioMistakeReports).where(eq(studioMistakeReports.id, reportId))
      else await db.update(studioMistakeReports).set({ status: 'in_review' }).where(eq(studioMistakeReports.id, reportId))
      throw new PaymentError(502, 'stripe_error')
    }
  }
  const now = review?.at ?? new Date()
  await db.transaction(async (tx) => {
    const [marked] = await tx.update(studioMistakeReports)
      .set({
        status: 'refunded', stripeRefundId: refundId, creditedCents, manaCents: split.manaCents,
        ...(review ? { reviewedAt: review.at, reviewedBy: review.by } : {}),
      })
      .where(and(eq(studioMistakeReports.id, reportId), inArray(studioMistakeReports.status, ['pending', 'approving'])))
      .returning({ id: studioMistakeReports.id })
    if (!marked) return // another attempt already recorded this report
    if (split.stripeCents > 0) {
      await tx.update(studioPayments).set({ refundedCents: sql`${studioPayments.refundedCents} + ${split.stripeCents}` })
        .where(eq(studioPayments.id, pay.id))
    }
    await addCredit(tx, e.userId, creditedCents, 'refund', reportId, now)
  })
  return { status: 'refunded', refundCents: e.amountCents, creditedCents, manaCents: split.manaCents }
}

/** A design's paid revision of one piece, by revision number, with the piece's name; null when it wasn't paid for. */
export async function entitlementFor(designId: string, category: string, revisionNumber: number) {
  const [row] = await db.select({ e: studioEntitlements, name: studioPieces.name })
    .from(studioEntitlements)
    .innerJoin(studioRevisions, eq(studioRevisions.id, studioEntitlements.revisionId))
    .innerJoin(studioPieces, eq(studioPieces.id, studioRevisions.pieceId))
    .where(and(eq(studioPieces.designId, designId), eq(studioPieces.category, category), eq(studioRevisions.number, revisionNumber)))
  return row ?? null
}

/** Each piece's newest paid revision whose package is ready: what "Download all" bundles. */
export async function readyPackages(designId: string) {
  const rows = await db.select({
    category: studioEntitlements.category, packageKey: studioEntitlements.packageKey, number: studioRevisions.number, name: studioPieces.name,
  })
    .from(studioEntitlements)
    .innerJoin(studioRevisions, eq(studioRevisions.id, studioEntitlements.revisionId))
    .innerJoin(studioPieces, eq(studioPieces.id, studioRevisions.pieceId))
    .where(and(eq(studioEntitlements.designId, designId), eq(studioEntitlements.status, 'ready')))
  const newest = new Map<string, { category: string; packageKey: string; number: number; name: string }>()
  for (const r of rows) {
    if (!r.packageKey) continue
    const had = newest.get(r.category)
    if (!had || r.number > had.number) newest.set(r.category, { ...r, packageKey: r.packageKey })
  }
  return [...newest.values()].sort((a, b) => a.category.localeCompare(b.category))
}

/** Every paid revision of a design, newest first, as the page lists them (never the package's location). */
export async function finalizedRevisions(designId: string) {
  const rows = await db.select({
    e: studioEntitlements, number: studioRevisions.number, paidAt: studioPayments.paidAt,
    reportStatus: studioMistakeReports.status, reportedAt: studioMistakeReports.createdAt,
  })
    .from(studioEntitlements)
    .innerJoin(studioRevisions, eq(studioRevisions.id, studioEntitlements.revisionId))
    .innerJoin(studioPayments, eq(studioPayments.id, studioEntitlements.paymentId))
    .leftJoin(studioMistakeReports, eq(studioMistakeReports.entitlementId, studioEntitlements.id))
    .where(eq(studioEntitlements.designId, designId))
  return rows
    .sort((a, b) => b.number - a.number)
    .map((r) => ({
      category: r.e.category,
      revision: r.number,
      kind: r.e.kind,
      status: r.e.status,
      amountCents: r.e.amountCents,
      paymentId: r.e.paymentId,
      paidAt: r.paidAt,
      report: r.reportStatus ? { status: r.reportStatus, createdAt: r.reportedAt } : null,
      reportableUntil: r.e.kind === 'revision' && r.e.amountCents > 0 && !r.reportStatus && r.paidAt
        ? new Date(r.paidAt.getTime() + REPORT_WINDOW_DAYS * 24 * 3600 * 1000)
        : null,
    }))
}

async function mailHeldReport(userId: string, pieceName: string, revision: number, text: string) {
  const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId))
  const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  await mailOwner(`Mistake report to review: ${u?.email ?? userId}`, `
    <p>${esc(u?.email ?? userId)} reported that revision ${revision} of ${esc(pieceName)} fixed the agent's mistake. It's past
    the instant refunds for this piece, so it waits for you.</p>
    <blockquote>${esc(text)}</blockquote>
    <p><a href="${appUrl('/admin/studio')}">Approve or decline it on the Studio flags page</a>.</p>`)
}

/** The owner approves a held report: its line is refunded in full, the way it was paid, as an instant report would be. */
export async function approveReport(reportId: string, adminId: string, now: Date): Promise<RefundResult> {
  // in_review -> approving is the lock: a second approval finds nothing to approve. An approval that died midway
  // (approving for longer than a refund takes) can be approved again; Stripe's earlier refund is found, not repeated.
  const [lock] = await db.update(studioMistakeReports).set({ status: 'approving', reviewedAt: now })
    .where(and(eq(studioMistakeReports.id, reportId), approvable(now))).returning()
  if (!lock) throw new PaymentError(409, 'not_in_review')
  const [row] = await db.select({ e: studioEntitlements, pay: studioPayments }).from(studioEntitlements)
    .innerJoin(studioPayments, eq(studioPayments.id, studioEntitlements.paymentId))
    .where(eq(studioEntitlements.id, lock.entitlementId))
  if (!row || !(row.e.amountCents > 0) || (refundSplit(row.e).stripeCents > 0 && !row.pay.stripePaymentIntent)) {
    await db.update(studioMistakeReports).set({ status: 'in_review' }).where(eq(studioMistakeReports.id, reportId))
    throw new PaymentError(409, 'nothing_charged')
  }
  return refundReport(row.e, row.pay, reportId, 'back_to_review', { by: adminId, at: now })
}

/** A report the owner can act on: waiting for review, or an approval that died midway. */
const approvable = (now: Date) => or(
  eq(studioMistakeReports.status, 'in_review'),
  and(eq(studioMistakeReports.status, 'approving'), lt(studioMistakeReports.reviewedAt, new Date(now.getTime() - PENDING_REPORT_MS))),
)

export async function declineReport(reportId: string, adminId: string, now: Date): Promise<boolean> {
  const [r] = await db.update(studioMistakeReports).set({ status: 'declined', reviewedAt: now, reviewedBy: adminId })
    .where(and(eq(studioMistakeReports.id, reportId), approvable(now))).returning({ id: studioMistakeReports.id })
  return !!r
}

/** Held reports for the admin page, oldest first, with the piece, the revision's request and a frame of before and after. */
export async function heldReports(now: Date) {
  const rows = await db.select({ r: studioMistakeReports, e: studioEntitlements, rev: studioRevisions, piece: studioPieces, email: users.email })
    .from(studioMistakeReports)
    .innerJoin(studioEntitlements, eq(studioEntitlements.id, studioMistakeReports.entitlementId))
    .innerJoin(studioRevisions, eq(studioRevisions.id, studioEntitlements.revisionId))
    .innerJoin(studioPieces, eq(studioPieces.id, studioRevisions.pieceId))
    .innerJoin(users, eq(users.id, studioMistakeReports.userId))
    .where(approvable(now))
    .orderBy(asc(studioMistakeReports.createdAt))
  const expires = frameUrlExpiry(now)
  // The first frame of one ready render of a revision of the piece: enough to see what changed
  const frame = async (piece: typeof studioPieces.$inferSelect, number: number) => {
    const [x] = await db.select({ render: studioRenders }).from(studioRenders)
      .innerJoin(studioRevisions, eq(studioRevisions.id, studioRenders.revisionId))
      .where(and(eq(studioRevisions.pieceId, piece.id), eq(studioRevisions.number, number), eq(studioRenders.status, 'ready')))
      .orderBy(asc(studioRenders.viewKey))
      .limit(1)
    return x ? signRenderFrame({
      designId: piece.designId, revisionId: x.render.revisionId, viewKey: x.render.viewKey, category: piece.category, frame: 0, jobId: x.render.jobId,
    }, expires) : null
  }
  return Promise.all(rows.map(async ({ r, e, rev, piece, email }) => {
    const [job] = rev.jobId ? await db.select({ payload: studioJobs.payload }).from(studioJobs).where(eq(studioJobs.id, rev.jobId)) : []
    return {
      id: r.id, text: r.text, refundCents: r.refundCents, createdAt: r.createdAt,
      user: { id: r.userId, email },
      designId: e.designId, piece: { category: piece.category, name: piece.name }, revisionNumber: rev.number,
      request: String((job?.payload as { prompt?: unknown } | undefined)?.prompt ?? ''),
      before: await frame(piece, rev.number - 1), after: await frame(piece, rev.number),
    }
  }))
}
