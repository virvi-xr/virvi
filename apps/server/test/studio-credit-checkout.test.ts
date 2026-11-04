import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import Stripe from 'stripe'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioCreditLedger, studioEntitlements, studioFinalizeCredits, studioPayments, type PaymentLine } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { setStripe } from '../src/integrations/stripe.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { addCredit, creditBalance } from '../src/studio/credit.js'
import { allocateCredit, dueCentsOf } from '../src/studio/pricing.js'
import { grantPayment } from '../src/studio/payments.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { createDesign, addRevision, entitle, fakeFly, fakeStripe } from './helpers/studio.js'

const WEBHOOK_SECRET = 'whsec_studio_credit_test'
const signer = new Stripe('sk_test_dummy')

const line = (over: Partial<PaymentLine>): PaymentLine => ({
  category: 'hat', revisionId: 'r', revisionNumber: 1, pieceName: 'Neon hat', priceKind: 'first', amountCents: 2900, waived: false, ...over,
})

describe('allocateCredit', () => {
  const lines = [line({ amountCents: 2900 }), line({ category: 'feet', priceKind: 'first_extra', amountCents: 1900 })]

  it('pays lines in order up to the credit', () => {
    const a = allocateCredit(lines, 2000)
    expect(a.lines.map((l) => l.creditCents)).toEqual([2000, 0])
    expect(a.usedCents).toBe(2000)
  })

  it('spills over onto the next line', () => {
    const a = allocateCredit(lines, 4000)
    expect(a.lines.map((l) => l.creditCents)).toEqual([2900, 1100])
    expect(a.usedCents).toBe(4000)
    expect(a.lines.map(dueCentsOf)).toEqual([0, 800])
  })

  it('never takes more than the lines charge', () => {
    expect(allocateCredit(lines, 9000).usedCents).toBe(4800)
  })

  it('gives a waived line none', () => {
    const a = allocateCredit([line({ waived: true, priceKind: 'revision', amountCents: 1500 }), line({ category: 'feet' })], 1000)
    expect(a.lines.map((l) => l.creditCents)).toEqual([undefined, 1000])
  })
})

describe('credit at checkout', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let stripe: ReturnType<typeof fakeStripe>
  const prev = {
    enabled: config.studioEnabled, key: config.stripeSecretKey, billing: config.billingEnabled,
    secret: config.stripeWebhookSecret, image: config.studioWorkerImage,
  }
  beforeAll(() => {
    ;(config as any).studioEnabled = true
    ;(config as any).studioWorkerImage = 'registry.fly.io/vlm-studio-worker:test'
    ;(config as any).stripeSecretKey = 'sk_test_studio'
    ;(config as any).billingEnabled = true
    ;(config as any).stripeWebhookSecret = WEBHOOK_SECRET
  })
  afterAll(() => {
    ;(config as any).studioEnabled = prev.enabled
    ;(config as any).studioWorkerImage = prev.image
    ;(config as any).stripeSecretKey = prev.key
    ;(config as any).billingEnabled = prev.billing
    ;(config as any).stripeWebhookSecret = prev.secret
    setStripe(null)
    setMachineDeps(null)
    setStudioStore(null)
  })
  beforeEach(async () => {
    await resetDb()
    stripe = fakeStripe()
    setStripe(stripe)
    setMachineDeps({ fly: fakeFly() })
    setStudioStore(memoryStudioStore())
    app = await testApp()
  })

  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const finalize = (u: TestUser, id: string, payload: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: `/api/studio/designs/${id}/finalize`, headers: as(u), payload })
  const give = (u: TestUser, cents: number) => db.transaction((tx) => addCredit(tx, u.id, cents, 'refund', null, new Date()))
  async function webhook(type: string, object: Record<string, unknown>) {
    const payload = JSON.stringify({ id: `evt_${Math.random()}`, object: 'event', type, data: { object } })
    const res = await app.inject({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }) },
      payload,
    })
    expect(res.statusCode).toBe(200)
  }
  const session = (paymentId: string) => ({
    id: 'cs_x', object: 'checkout.session', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_1',
    metadata: { vlm_studio_payment_id: paymentId, vlm_user_id: 'x' },
  })
  const paymentsOf = (designId: string) => db.select().from(studioPayments).where(eq(studioPayments.designId, designId))
  const amounts = (s: any) => s.line_items.map((l: any) => l.price_data.unit_amount * l.quantity)

  it('quotes the credit it would apply', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    await give(u, 1000)
    const res = await app.inject({ method: 'GET', url: `/api/studio/designs/${d.id}/finalize`, headers: as(u) })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ totalCents: 2900, creditCents: 1000, dueCents: 1900 })
  })

  it('a partly covered finalize charges the rest by card, and the entitlement records the credit', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    await give(u, 1000)
    const res = await finalize(u, d.id)
    expect(res.statusCode).toBe(200)
    expect(stripe.calls.sessions).toHaveLength(1)
    expect(amounts(stripe.calls.sessions[0])).toEqual([1900])
    expect(await creditBalance(u.id)).toBe(0)
    const [pay] = await paymentsOf(d.id)
    expect(pay).toMatchObject({ method: 'card', creditHeldCents: 1000, amountCents: 2900 })
    const ledger = await db.select().from(studioCreditLedger).where(eq(studioCreditLedger.reason, 'hold'))
    expect(ledger).toMatchObject([{ deltaCents: -1000, refId: pay.id }])
    await webhook('checkout.session.completed', session(pay.id))
    const [e] = await db.select().from(studioEntitlements).where(eq(studioEntitlements.paymentId, pay.id))
    expect(e).toMatchObject({ creditCents: 1000, method: 'card', amountCents: 2900 })
    const [after] = await paymentsOf(d.id)
    expect(after).toMatchObject({ status: 'paid', creditHeldCents: 1000, refundDueCents: 0 })
  })

  it('a fully covered finalize is granted at once, with no Stripe session', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    await give(u, 5000)
    const res = await finalize(u, d.id)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ granted: true })
    expect(stripe.calls.sessions).toHaveLength(0)
    const [pay] = await paymentsOf(d.id)
    expect(pay).toMatchObject({ method: 'credit', status: 'paid', creditHeldCents: 2900 })
    expect(await creditBalance(u.id)).toBe(2100)
    const [e] = await db.select().from(studioEntitlements).where(eq(studioEntitlements.paymentId, pay.id))
    expect(e).toMatchObject({ creditCents: 2900, method: 'credit', amountCents: 2900 })
  })

  it('an expired checkout returns its credit once', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    await give(u, 1000)
    await finalize(u, d.id)
    expect(await creditBalance(u.id)).toBe(0)
    const [pay] = await paymentsOf(d.id)
    await webhook('checkout.session.expired', session(pay.id))
    expect(await creditBalance(u.id)).toBe(1000)
    await webhook('checkout.session.expired', session(pay.id))
    expect(await creditBalance(u.id)).toBe(1000)
    const [after] = await paymentsOf(d.id)
    expect(after).toMatchObject({ status: 'expired', creditHeldCents: 0 })
    const released = await db.select().from(studioCreditLedger).where(eq(studioCreditLedger.reason, 'release'))
    expect(released).toMatchObject([{ deltaCents: 1000, refId: pay.id }])
  })

  it('a checkout that never reaches Stripe gives its credit back', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    await give(u, 1000)
    stripe.failSessions = true
    expect((await finalize(u, d.id)).statusCode).toBe(502)
    expect(await creditBalance(u.id)).toBe(1000)
    expect(await paymentsOf(d.id)).toHaveLength(0)
  })

  it('reuses an open session for the same lines, without taking the credit twice', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    await give(u, 1000)
    const one = await finalize(u, d.id)
    const two = await finalize(u, d.id)
    expect(two.json().url).toBe(one.json().url)
    expect(stripe.calls.sessions).toHaveLength(1)
    expect(await creditBalance(u.id)).toBe(0)
  })

  it('a second checkout for the design takes over the credit an open one holds', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    await addRevision(d, 'feet')
    await give(u, 1000)
    await finalize(u, d.id, { categories: ['hat'] })
    const [first] = await paymentsOf(d.id)
    expect(first.creditHeldCents).toBe(1000)
    const res = await finalize(u, d.id)
    expect(res.statusCode).toBe(200)
    expect(stripe.calls.expired).toEqual([first.stripeSessionId])
    expect(stripe.calls.sessions).toHaveLength(2)
    expect(amounts(stripe.calls.sessions[1]).reduce((a: number, b: number) => a + b, 0)).toBe(2900 + 1900 - 1000)
    const pays = await paymentsOf(d.id)
    expect(pays.find((p) => p.id === first.id)).toMatchObject({ status: 'expired', creditHeldCents: 0 })
    expect(pays.find((p) => p.id !== first.id)).toMatchObject({ status: 'pending', creditHeldCents: 1000 })
    expect(await creditBalance(u.id)).toBe(0)
  })

  it('refuses when the credit it quoted is held by a checkout Stripe will not expire', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    await addRevision(d, 'feet')
    await give(u, 1000)
    await finalize(u, d.id, { categories: ['hat'] })
    stripe.failExpire = true
    const res = await finalize(u, d.id)
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('credit_busy')
    expect(await creditBalance(u.id)).toBe(0)
    expect(stripe.calls.sessions).toHaveLength(1)
  })

  it('spends gift finalizes before credit', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    await db.insert(studioFinalizeCredits).values({ userId: u.id, balance: 1 })
    await give(u, 1000)
    const res = await finalize(u, d.id)
    expect(res.json()).toMatchObject({ granted: true })
    const [pay] = await paymentsOf(d.id)
    expect(pay.lines[0]).toMatchObject({ gift: true })
    expect(pay.creditHeldCents).toBe(0)
    expect(pay.method).toBe('card')
    expect(await creditBalance(u.id)).toBe(1000)
  })

  it('an overcharge found at grant time gives the credit share back as credit and refunds the card share', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    const hat = await addRevision(d, 'hat')
    await addRevision(d, 'feet')
    await give(u, 2000)
    // Quoted in piece order: feet the first finalize, 2900 (2000 credit + 900 card); hat an extra piece, 1900 by card
    await finalize(u, d.id)
    const [pay] = await paymentsOf(d.id)
    expect(pay.lines.map((l) => [l.category, l.amountCents, l.creditCents])).toEqual([['feet', 2900, 2000], ['hat', 1900, 0]])
    // Meanwhile hat was paid for by another checkout: feet becomes an extra piece (1900), hat is already paid
    await entitle(d, hat, { amountCents: 2900 })
    await db.update(studioPayments).set({ stripePaymentIntent: 'pi_over' }).where(eq(studioPayments.id, pay.id))
    expect(await grantPayment(pay.id, 'pi_over', new Date())).toBe('granted')
    // feet: charged 2900 (2000 credit), now 1900: keeps 1900 of credit, 100 back as credit, 900 by card
    // hat: 1900 by card, already paid: all of it back by card
    expect(await creditBalance(u.id)).toBe(100)
    const [e] = await db.select().from(studioEntitlements).where(eq(studioEntitlements.paymentId, pay.id))
    expect(e).toMatchObject({ category: 'feet', amountCents: 1900, creditCents: 1900, method: 'card' })
    expect(stripe.calls.refunds.map((r) => r.params.amount)).toEqual([900 + 1900])
    const refunded = await db.select().from(studioCreditLedger).where(eq(studioCreditLedger.reason, 'refund'))
    expect(refunded.find((r) => r.refId === pay.id)).toMatchObject({ deltaCents: 100 })
  })

  it('a top-up spends credit and opens Stripe for the rest', async () => {
    const u = await createUser()
    await give(u, 300)
    const res = await app.inject({ method: 'POST', url: '/api/studio/topups', headers: as(u), payload: { packs: 1 } })
    expect(res.statusCode).toBe(200)
    expect(stripe.calls.sessions).toHaveLength(1)
    expect(amounts(stripe.calls.sessions[0])).toEqual([200])
    expect(await creditBalance(u.id)).toBe(0)
    const [pay] = await db.select().from(studioPayments).where(eq(studioPayments.userId, u.id))
    expect(pay).toMatchObject({ kind: 'topup', creditHeldCents: 300, amountCents: 500 })
    await webhook('checkout.session.expired', session(pay.id))
    expect(await creditBalance(u.id)).toBe(300)
  })

  it('a top-up fully covered by credit is granted at once', async () => {
    const u = await createUser()
    await give(u, 800)
    const res = await app.inject({ method: 'POST', url: '/api/studio/topups', headers: as(u), payload: { packs: 1 } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ granted: true })
    expect(stripe.calls.sessions).toHaveLength(0)
    expect(await creditBalance(u.id)).toBe(300)
    const [pay] = await db.select().from(studioPayments).where(eq(studioPayments.userId, u.id))
    expect(pay).toMatchObject({ status: 'paid', method: 'credit', creditHeldCents: 500 })
  })
})
