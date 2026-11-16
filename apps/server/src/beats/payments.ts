import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import { BEAT_CARD_MIN_CENTS, beatMinCardTopupCap, beatPriceCents, beatTopupCents, type BeatChain } from '@virvixr/shared'
import { config } from '../config.js'
import { db } from '../db/connection.js'
import { beatClaims, beatPayments, beats, mediaAssets } from '../db/schema.js'
import { recordJobFailure } from '../errors/record.js'
import { ensureCustomer, getStripe } from '../integrations/stripe.js'
import { createStorage, type StorageProvider } from '../storage/index.js'
import { addCredit, creditBalance, takeCredit } from '../studio/credit.js'
import { BeatError } from './errors.js'
import { readImageBytes } from './image.js'
import { lockBeat } from './lock.js'

/**
 * BEAT payments (LIV-11): the first purchase of a BEAT's supply ('create') and later cap raises ('topup'), by card
 * (a one-off Stripe Checkout, confirmed by the webhook), by Virvi credit when it covers the whole amount, or free on
 * Polygon Amoy ('test'). Refunds on cancel, and the frozen copy of the artwork. Modelled on studio/payments.ts.
 * Nothing here logs a wallet, a display name or a Stripe secret.
 */

type BeatRow = typeof beats.$inferSelect
type PaymentRow = typeof beatPayments.$inferSelect

// Stripe refuses an expires_at under 30 minutes away, measured when it receives the request
const CHECKOUT_TTL_MS = 31 * 60_000
/** A pending payment is expired by the sweep this long after it was made (its Stripe session is gone by then). */
export const BEAT_PAYMENT_EXPIRY_MS = CHECKOUT_TTL_MS + 5 * 60_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
const SEQUENCE: Record<BeatChain, string> = { 'polygon-amoy': 'beat_token_id_polygon_amoy_seq', polygon: 'beat_token_id_polygon_seq' }

const isAmoy = (chain: BeatChain) => chain === 'polygon-amoy'
const appUrl = (path: string) => `${config.publicUrl.replace(/\/+$/, '')}${path}`

let storageOverride: StorageProvider | null = null
let made: StorageProvider | null = null
/** Tests swap in a fake; null goes back to the configured storage. */
export function setBeatStorage(s: StorageProvider | null): void { storageOverride = s }
const storage = () => storageOverride ?? (made ??= createStorage())

// ── Quotes ───────────────────────────────────────────────────────────────────

export interface BeatQuote { cents: number; lines: { label: string; cents: number }[]; refundableUnclaimed: false }

/** The price of a draft at `cap`, or of raising a paid BEAT's cap to `cap`. A test BEAT (Amoy) is free. */
export function beatQuote(row: BeatRow, cap: number): BeatQuote {
  const p = config.beats.price
  if (isAmoy(row.chain)) return { cents: 0, lines: [{ label: 'Test BEAT on Polygon Amoy', cents: 0 }], refundableUnclaimed: false }
  if (row.status !== 'draft') {
    const cents = beatTopupCents(row.supplyCap, cap, p)
    return { cents, lines: [{ label: `Supply from ${row.supplyCap} to ${cap}`, cents }], refundableUnclaimed: false }
  }
  const extra = Math.max(0, cap - p.includedMints)
  const lines = [{ label: `Base price, up to ${p.includedMints} tokens`, cents: p.baseCents }]
  if (extra > 0) lines.push({ label: `${extra} more tokens`, cents: p.extraMintCents * extra })
  return { cents: beatPriceCents(cap, p), lines, refundableUnclaimed: false }
}

/**
 * Stripe refuses a card charge under BEAT_CARD_MIN_CENTS (money I2), so a card raise that would cost more than nothing but
 * less than that is refused up front as `below_minimum`, with the smallest supply (and extra tokens) a card can pay for.
 * Credit pays any amount, and a free raise (inside the included supply, or on Amoy) needs no card.
 */
export function refuseBelowCardMinimum(row: BeatRow, quote: BeatQuote): void {
  if (quote.cents <= 0 || quote.cents >= BEAT_CARD_MIN_CENTS) return
  const minSupply = row.status === 'draft' ? null : beatMinCardTopupCap(row.supplyCap, config.beats.price)
  const minExtraTokens = minSupply === null ? null : minSupply - row.supplyCap
  throw new BeatError(400, 'below_minimum', minExtraTokens === null
    ? `Card payments start at $${(BEAT_CARD_MIN_CENTS / 100).toFixed(2)}. Pay with credit instead.`
    : `Card payments start at $${(BEAT_CARD_MIN_CENTS / 100).toFixed(2)}: add at least ${minExtraTokens} tokens, or pay with credit.`,
  { minCents: BEAT_CARD_MIN_CENTS, minSupply, minExtraTokens })
}

// ── Checkout ─────────────────────────────────────────────────────────────────

export type BeatPayMethod = 'card' | 'credit'
export type BeatCheckoutResult = { url: string } | { paid: true }
export interface BeatPayer { id: string; email: string | null; admin: boolean }

/**
 * Pays for a draft's supply. Callers have checked the caller may manage the BEAT; the grant checks the state again
 * under the BEAT's lock.
 */
export async function createBeatCheckout(row: BeatRow, payer: BeatPayer, method: BeatPayMethod, now: Date): Promise<BeatCheckoutResult> {
  if (row.status !== 'draft') {
    throw new BeatError(409, 'locked', row.status === 'cancelled' ? 'This BEAT is cancelled.' : 'This BEAT is already paid for.')
  }
  if (row.startsAt.getTime() <= now.getTime()) throw new BeatError(409, 'too_late', 'This BEAT has already started. Pick a new time first.')
  const q = beatQuote(row, row.supplyCap)
  if (method === 'card') refuseBelowCardMinimum(row, q)
  return checkout(row, payer, method, { kind: 'create', capFrom: 0, capTo: row.supplyCap, quote: q }, now)
}

/** Raises a paid or live BEAT's cap before its end; the cap changes only when the payment is granted. */
export async function createCapTopup(row: BeatRow, payer: BeatPayer, supplyCap: number, method: BeatPayMethod, now: Date): Promise<BeatCheckoutResult> {
  if (row.status === 'draft') throw new BeatError(409, 'locked', 'This BEAT isn\'t paid for yet. Change its supply in its settings.')
  if (row.status === 'cancelled') throw new BeatError(409, 'locked', 'This BEAT is cancelled.')
  if (row.status === 'ended' || row.endsAt.getTime() <= now.getTime()) throw new BeatError(409, 'too_late', 'This BEAT is over.')
  if (supplyCap <= row.supplyCap) throw new BeatError(400, 'bad_cap', `The new supply must be more than ${row.supplyCap}.`)
  const q = beatQuote(row, supplyCap)
  if (method === 'card') refuseBelowCardMinimum(row, q)
  return checkout(row, payer, method, { kind: 'topup', capFrom: row.supplyCap, capTo: supplyCap, quote: q }, now)
}

async function checkout(
  row: BeatRow, payer: BeatPayer, method: BeatPayMethod,
  what: { kind: 'create' | 'topup'; capFrom: number; capTo: number; quote: BeatQuote }, now: Date,
): Promise<BeatCheckoutResult> {
  const test = isAmoy(row.chain)
  if (test && !payer.admin) throw new BeatError(403, 'forbidden', 'Test BEATs are for Virvi admins.')
  const cents = what.quote.cents
  // Nothing to charge (a test BEAT, or a raise still inside the included supply): granted at once
  const paidMethod = test ? 'test' : cents === 0 ? 'credit' : method
  if (paidMethod === 'credit' && cents > 0 && (await creditBalance(payer.id)) < cents) {
    throw new BeatError(402, 'insufficient_credit', "Your Virvi credit doesn't cover this. Pay by card instead.")
  }
  const values = { beatId: row.id, userId: payer.id, kind: what.kind, capFrom: what.capFrom, capTo: what.capTo, amountCents: cents, createdAt: now }

  if (paidMethod !== 'card') {
    const [pay] = await db.insert(beatPayments).values({ ...values, method: paidMethod }).returning()
    try {
      await grantBeatPayment(pay.id, null, now)
    } catch (err) {
      await db.delete(beatPayments).where(and(eq(beatPayments.id, pay.id), eq(beatPayments.status, 'pending')))
      throw err
    }
    return { paid: true }
  }

  // One open card checkout per BEAT and kind: an older one is expired through Stripe. One Stripe won't expire (it was
  // just paid) stays pending, and its grant refunds whichever payment comes second.
  await expireOpen(row.id, what.kind, now)
  const [pay] = await db.insert(beatPayments).values({ ...values, method: 'card' }).returning()
  const stripeDown = () => new BeatError(502, 'stripe_error', "We couldn't reach the card processor. Try again.")
  let session: { id: string; url: string }
  try {
    const customer = await ensureCustomer(payer.id, payer.email)
    const metadata = { kind: 'beat', paymentId: pay.id }
    const expiresAt = new Date(now.getTime() + CHECKOUT_TTL_MS)
    session = await (await getStripe()).checkout.sessions.create({
      mode: 'payment',
      customer,
      line_items: what.quote.lines.filter((l) => l.cents > 0).map((l) => ({
        quantity: 1, price_data: { currency: 'usd', unit_amount: l.cents, product_data: { name: `BEAT: ${l.label}` } },
      })),
      metadata,
      payment_intent_data: { metadata },
      // The dashboard's BEAT page is /beats?id= (its static export has one page for every id, as /scenes?id=)
      success_url: appUrl(`/beats?id=${row.id}&payment=${pay.id}`),
      cancel_url: appUrl(`/beats?id=${row.id}&payment=cancelled`),
      expires_at: Math.floor(expiresAt.getTime() / 1000),
    })
  } catch (err) {
    // No session exists, so nothing can be paid against this row
    console.error('[beats] checkout session failed:', err instanceof Error ? err.message : err)
    await db.delete(beatPayments).where(and(eq(beatPayments.id, pay.id), eq(beatPayments.status, 'pending')))
    throw stripeDown()
  }
  try {
    await db.update(beatPayments).set({ stripeSessionId: session.id }).where(eq(beatPayments.id, pay.id))
  } catch (err) {
    // The session exists and carries this row's id: keep the row (a payment that still comes in is granted) and expire
    // the session so it isn't paid. The sweep expires the row.
    console.error(`[beats] saving the session of payment ${pay.id} failed:`, err instanceof Error ? err.message : err)
    try {
      await (await getStripe()).checkout.sessions.expire(session.id)
    } catch (e) {
      console.error(`[beats] checkout ${pay.id} could not be expired:`, e instanceof Error ? e.message : e)
    }
    throw stripeDown()
  }
  return { url: session.url }
}

/** Expires a BEAT's open card checkouts of one kind through Stripe; one Stripe won't expire is left pending. */
async function expireOpen(beatId: string, kind: 'create' | 'topup', now: Date): Promise<void> {
  const open = await db.select().from(beatPayments).where(and(
    eq(beatPayments.beatId, beatId), eq(beatPayments.kind, kind), eq(beatPayments.status, 'pending'),
    eq(beatPayments.method, 'card'), isNotNull(beatPayments.stripeSessionId),
  ))
  for (const p of open) {
    try {
      await (await getStripe()).checkout.sessions.expire(p.stripeSessionId)
    } catch (err) {
      console.error(`[beats] checkout ${p.id} could not be expired:`, err instanceof Error ? err.message : err)
      continue
    }
    await expireBeatPayment(p.id, now)
  }
}

/** Marks a pending payment expired (a paid, refunded or expired one is left alone). */
export async function expireBeatPayment(paymentId: string, _now: Date): Promise<void> {
  await db.update(beatPayments).set({ status: 'expired' }).where(and(eq(beatPayments.id, paymentId), eq(beatPayments.status, 'pending')))
}

// ── Grant ────────────────────────────────────────────────────────────────────

/** Why a confirmed payment can't be applied to its BEAT (it is refunded instead), or null when it can. */
function strayReason(pay: PaymentRow, beat: BeatRow | undefined, now: Date): string | null {
  if (!beat) return 'the BEAT is gone'
  if (beat.status === 'cancelled' || beat.status === 'ended') return `the BEAT is ${beat.status}`
  if (beat.endsAt.getTime() <= now.getTime()) return 'the BEAT is over'
  if (pay.kind === 'create') return beat.status === 'draft' ? null : 'the BEAT was already paid for'
  if (beat.status === 'draft') return 'the BEAT is not paid for'
  return beat.supplyCap === pay.capFrom ? null : 'the supply changed since the checkout'
}

/**
 * Applies a payment once, under the BEAT's lock (`beat:<id>`, shared with edit and cancel) and the payment's row lock.
 * A create takes the chain's next token id (once per BEAT), sets the BEAT paid at the cap that was paid for, and leaves
 * it for the minting job (status paid, no created_on_chain_tx); the artwork is copied after the commit. A top-up sets the
 * cap. Credit is taken in the same transaction and must cover the whole amount. A card payment Stripe confirms after it
 * expired here is still granted (the money was taken). One that can't be applied (the BEAT was cancelled, paid by another
 * checkout, or its cap moved) is refunded in full; if that refund fails it throws, so Stripe sends the webhook again.
 */
export async function grantBeatPayment(paymentId: string, paymentIntent: string | null, now: Date): Promise<'granted' | 'already'> {
  if (!UUID.test(paymentId)) return 'already'
  const out = await db.transaction(async (tx) => {
    const [first] = await tx.select({ beatId: beatPayments.beatId }).from(beatPayments).where(eq(beatPayments.id, paymentId))
    if (!first) return null
    await lockBeat(tx, first.beatId)
    const [pay] = await tx.select().from(beatPayments).where(eq(beatPayments.id, paymentId)).for('update')
    if (!pay || !(pay.status === 'pending' || (pay.status === 'expired' && pay.method === 'card'))) return null
    const [beat] = await tx.select().from(beats).where(eq(beats.id, pay.beatId)).for('update')
    const stray = strayReason(pay, beat, now)
    if (stray) {
      if (pay.method !== 'card') throw new BeatError(409, 'conflict', 'This BEAT just changed. Reload and try again.')
      const intent = paymentIntent ?? pay.stripePaymentIntent
      if (intent && intent !== pay.stripePaymentIntent) await tx.update(beatPayments).set({ stripePaymentIntent: intent }).where(eq(beatPayments.id, pay.id))
      return { pay: { ...pay, stripePaymentIntent: intent }, stray, create: false }
    }
    let creditCents = 0
    if (pay.method === 'credit' && pay.amountCents > 0) {
      creditCents = pay.userId ? await takeCredit(tx, pay.userId, pay.amountCents, 'beat', pay.id, now) : 0
      if (creditCents < pay.amountCents) throw new BeatError(402, 'insufficient_credit', "Your Virvi credit doesn't cover this. Pay by card instead.")
    }
    await tx.update(beatPayments).set({
      status: 'paid', paidAt: now, creditCents, ...(paymentIntent ? { stripePaymentIntent: paymentIntent } : {}),
    }).where(eq(beatPayments.id, pay.id))
    if (pay.kind === 'create') {
      const tokenId = beat!.tokenId ?? (await nextTokenId(tx, beat!.chain))
      await tx.update(beats).set({ status: 'paid', paymentId: pay.id, tokenId, supplyCap: pay.capTo, updatedAt: now }).where(eq(beats.id, beat!.id))
    } else {
      await tx.update(beats).set({ supplyCap: pay.capTo, updatedAt: now }).where(eq(beats.id, beat!.id))
    }
    return { pay, stray: null, create: pay.kind === 'create' }
  })
  if (!out) return 'already'
  if (out.stray) {
    console.warn(`[beats] payment ${out.pay.id} refunded: ${out.stray}`)
    await stripeRefund(out.pay)
    // Never applied, so no paid_at: only refunded_at
    await db.update(beatPayments).set({ status: 'refunded', refundedAt: now })
      .where(and(eq(beatPayments.id, out.pay.id), inArray(beatPayments.status, ['pending', 'expired'])))
    return 'granted'
  }
  if (out.create) {
    // The sweep tries again if this fails; the BEAT shows its library image meanwhile
    await copyBeatImage(out.pay.beatId).catch((err) => console.error(`[beats] artwork copy for ${out.pay.beatId} failed:`, err instanceof Error ? err.message : err))
  }
  return 'granted'
}

async function nextTokenId(tx: Pick<typeof db, 'execute'>, chain: BeatChain): Promise<number> {
  const rows = await tx.execute<{ n: string }>(sql`select nextval(${SEQUENCE[chain]}::regclass)::text as n`) as unknown as { n: string }[]
  return Number(rows[0].n)
}

/** A Stripe Checkout event for a BEAT payment (metadata kind 'beat'); false when the event isn't one. */
export async function handleBeatSession(event: { type: string; data?: { object?: any } }): Promise<boolean> {
  const s = event.data?.object
  if (s?.object !== 'checkout.session' || s.mode !== 'payment' || s.metadata?.kind !== 'beat') return false
  const id = s.metadata.paymentId
  if (typeof id !== 'string' || !UUID.test(id)) return true
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    if (s.payment_status === 'paid') await grantBeatPayment(id, typeof s.payment_intent === 'string' ? s.payment_intent : null, new Date())
  } else if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
    await expireBeatPayment(id, new Date())
  }
  return true
}

// ── Refunds ──────────────────────────────────────────────────────────────────

/**
 * Refunds a card payment in full through Stripe, once: a refund Stripe already made for it (its answer was lost, or the
 * server stopped before saving) is found by its metadata rather than made again, and the idempotency key covers two
 * calls at once. Stripe also refuses to refund more than was charged.
 */
async function stripeRefund(pay: Pick<PaymentRow, 'id' | 'amountCents' | 'creditCents' | 'stripePaymentIntent'>): Promise<number> {
  const cents = pay.amountCents - pay.creditCents
  if (cents <= 0) return 0
  if (!pay.stripePaymentIntent) throw new Error(`BEAT payment ${pay.id} has no payment intent to refund`)
  const stripe = await getStripe()
  const made = (await stripe.refunds.list({ payment_intent: pay.stripePaymentIntent, limit: 100 })).data as { metadata?: Record<string, string> }[]
  if (made.some((r) => r.metadata?.virvi_beat_payment_id === pay.id)) return cents
  await stripe.refunds.create(
    { payment_intent: pay.stripePaymentIntent, amount: cents, metadata: { virvi_beat_payment_id: pay.id } },
    { idempotencyKey: `beat-refund-${pay.id}` },
  )
  return cents
}

/**
 * Refunds every paid payment of a BEAT, newest first (top-ups before the create): card amounts through Stripe, credit
 * back as Virvi credit. Each payment is marked refunded on its own, and the one that leaves none paid also sets the BEAT
 * cancelled, so a retry after a crash refunds only what is still paid. A refunded top-up takes its cap raise back in the
 * same transaction (once, with its status), never below the claims already made: then the cap stays at that count and
 * admins are told. It takes no BEAT lock: cancel holds `beat:<id>` around this call. Returns what this call gave back.
 */
export async function refundBeat(beatId: string, now: Date): Promise<{ stripeCents: number; creditCents: number }> {
  const paid = await db.select().from(beatPayments).where(and(eq(beatPayments.beatId, beatId), eq(beatPayments.status, 'paid')))
    .orderBy(desc(beatPayments.createdAt), desc(beatPayments.capTo))
  let stripeCents = 0
  let creditCents = 0
  for (const pay of paid) {
    const card = pay.method === 'card' ? await stripeRefund(pay) : 0
    let alert: string | null = null
    await db.transaction(async (tx) => {
      const [done] = await tx.update(beatPayments).set({ status: 'refunded', refundedAt: now })
        .where(and(eq(beatPayments.id, pay.id), eq(beatPayments.status, 'paid'))).returning()
      if (!done) return
      stripeCents += card
      if (done.creditCents > 0) {
        await addCredit(tx, done.userId, done.creditCents, 'refund', done.id, now)
        creditCents += done.creditCents
      }
      if (done.kind === 'topup') alert = await revertTopup(tx, beatId, done.capTo - done.capFrom, now)
      await tx.update(beats).set({ status: 'cancelled', updatedAt: now }).where(and(
        eq(beats.id, beatId), eq(beats.status, 'paid'),
        sql`not exists (select 1 from beat_payments p where p.beat_id = ${beatId} and p.status = 'paid')`,
      ))
    })
    // Only once the refund (and the cap it set) has committed
    if (alert) {
      console.error(`[beats] ${alert}`)
      recordJobFailure('beat_refund', new Error(alert), { owner: beatId })
    }
  }
  return { stripeCents, creditCents }
}

/** Lowers the BEAT's cap by a refunded top-up's raise, to no less than its claims (any status but present). Returns
 * the admin alert to record once the transaction commits when the claims kept it from fully reverting, else null. */
async function revertTopup(tx: Pick<typeof db, 'select' | 'update'>, beatId: string, raise: number, now: Date): Promise<string | null> {
  const [row] = await tx.select({ cap: beats.supplyCap }).from(beats).where(eq(beats.id, beatId)).for('update')
  if (!row || raise <= 0) return null
  const [c] = await tx.select({ n: sql<number>`count(*)::int` }).from(beatClaims)
    .where(and(eq(beatClaims.beatId, beatId), sql`${beatClaims.status} not in ('present', 'removed')`))
  const claims = c?.n ?? 0
  const cap = Math.max(claims, row.cap - raise)
  await tx.update(beats).set({ supplyCap: cap, updatedAt: now }).where(eq(beats.id, beatId))
  return cap > row.cap - raise
    ? `BEAT ${beatId}: a refunded top-up of ${raise} could only lower the cap from ${row.cap} to ${cap}, the claims already made`
    : null
}

// ── The frozen artwork ───────────────────────────────────────────────────────

/**
 * Copies the BEAT's image to `beats/{chain}/{tokenId}-{imageMediaId}.{ext}` and records the copy's URL. The copy is not a
 * media row, so deleting the original or its library item leaves it. The key names the image, so a slow copy of an older
 * image writes its own file and never overwrites the current one; image_url is written only if the BEAT still has the
 * image that was copied (two quick edits can finish out of order). Returns the copy's URL.
 */
export async function copyBeatImage(beatId: string): Promise<string> {
  const [row] = await db.select().from(beats).where(eq(beats.id, beatId))
  if (!row) throw new BeatError(404, 'not_found', 'BEAT not found.')
  if (row.tokenId === null) throw new BeatError(409, 'locked', 'This BEAT has no token id yet.')
  if (!row.imageMediaId) {
    if (row.imageUrl) return row.imageUrl
    throw new BeatError(400, 'bad_image', 'This BEAT has no image.')
  }
  const mediaId = row.imageMediaId
  const [m] = await db.select().from(mediaAssets).where(eq(mediaAssets.id, mediaId))
  const ext = m ? EXT[m.contentType] : undefined
  if (!m?.publicUrl || !ext) throw new BeatError(400, 'bad_image', "This BEAT's image can't be read.")
  const data = await readImageBytes(m.publicUrl)
  if (!data) throw new BeatError(502, 'bad_image', "This BEAT's image can't be read.")
  const url = await storage().upload(`beats/${row.chain}/${row.tokenId}-${mediaId}.${ext}`, data, m.contentType)
  await db.update(beats).set({ imageUrl: url }).where(and(eq(beats.id, beatId), eq(beats.imageMediaId, mediaId)))
  return url
}

// ── Sweep ────────────────────────────────────────────────────────────────────

/**
 * Expires pending payments left past their checkout's life, and copies the artwork of paid or live BEATs still missing
 * their frozen copy. Run from the studio sweep; Task 7's job may call it too.
 */
export async function sweepBeatPayments(now: Date): Promise<{ expired: number; copied: number }> {
  const expired = await db.update(beatPayments).set({ status: 'expired' }).where(and(
    eq(beatPayments.status, 'pending'), lt(beatPayments.createdAt, new Date(now.getTime() - BEAT_PAYMENT_EXPIRY_MS)),
  )).returning({ id: beatPayments.id })
  const missing = await db.select({ id: beats.id }).from(beats).where(and(
    or(eq(beats.status, 'paid'), eq(beats.status, 'live')), isNull(beats.imageUrl), isNotNull(beats.imageMediaId), isNotNull(beats.tokenId),
  ))
  let copied = 0
  for (const { id } of missing) {
    try {
      await copyBeatImage(id)
      copied++
    } catch (err) {
      console.error(`[beats] artwork copy for ${id} failed:`, err instanceof Error ? err.message : err)
    }
  }
  return { expired: expired.length, copied }
}
