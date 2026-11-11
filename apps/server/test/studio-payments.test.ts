import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import Stripe from 'stripe'
import { eq, sql } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import {
  studioDesigns, studioEntitlements, studioFinalizeCredits, studioJobs, studioMistakeReports, studioPayments, studioPromptCredits,
  subscriptions,
} from '../src/db/schema.js'
import { config } from '../src/config.js'
import { setStripe } from '../src/integrations/stripe.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { createDesign, addRevision, entitle, fakeFly, fakeStripe } from './helpers/studio.js'

const WEBHOOK_SECRET = 'whsec_studio_test'
const signer = new Stripe('sk_test_dummy')

describe('studio payments', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let stripe: ReturnType<typeof fakeStripe>
  let fly: ReturnType<typeof fakeFly>
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
    fly = fakeFly()
    setMachineDeps({ fly })
    setStudioStore(memoryStudioStore())
    app = await testApp()
  })

  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const finalize = (u: TestUser, id: string, payload: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: `/api/studio/designs/${id}/finalize`, headers: as(u), payload })
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
  const paid = (paymentId: string, intent = 'pi_1') => webhook('checkout.session.completed', {
    id: 'cs_x', object: 'checkout.session', mode: 'payment', payment_status: 'paid', payment_intent: intent,
    metadata: { vlm_studio_payment_id: paymentId, vlm_user_id: 'x' },
  })
  const paymentOf = async (designId: string) => db.select().from(studioPayments).where(eq(studioPayments.designId, designId))

  it('checkout opens one Stripe session at the quoted price', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    const before = Date.now()
    const res = await finalize(u, d.id)
    expect(res.statusCode).toBe(200)
    expect(res.json().url).toBe('https://checkout.stripe.test/2')
    expect(stripe.calls.sessions).toHaveLength(1)
    const s = stripe.calls.sessions[0]
    const [pay] = await paymentOf(d.id)
    expect(pay).toMatchObject({ status: 'pending', kind: 'finalize', amountCents: 2900, stripeSessionId: 'cs_test_2' })
    expect(s.mode).toBe('payment')
    expect(s.line_items.map((l: any) => l.price_data.unit_amount)).toEqual([2900])
    expect(s.line_items[0].price_data.currency).toBe('usd')
    expect(s.metadata).toEqual({ vlm_user_id: u.id, vlm_studio_payment_id: pay.id })
    expect(s.payment_intent_data.metadata).toEqual({ vlm_user_id: u.id, vlm_studio_payment_id: pay.id })
    expect(new URL(s.success_url).pathname + new URL(s.success_url).search).toBe(`/studio/${d.id}?payment=${pay.id}`)
    expect(new URL(s.cancel_url).pathname + new URL(s.cancel_url).search).toBe(`/studio/${d.id}`)
    // Stripe's minimum is 30 minutes from when it receives the request, so the session asks for 31
    expect(s.expires_at * 1000 - before).toBeGreaterThan(1850_000)
    expect(s.expires_at * 1000 - before).toBeLessThan(1870_000)
  })

  it('a gifted 4x4 building opens one Stripe line for the rest, and the grant keeps that price', async () => {
    const u = await createUser()
    const d = await createDesign(u, { kind: 'scene' })
    await addRevision(d, 'building', { pass: true, failures: 0, warnings: 0 }, { kind: 'building', footprint: '4x4' })
    await db.insert(studioFinalizeCredits).values({ userId: u.id, balance: 1 })
    expect((await finalize(u, d.id)).statusCode).toBe(200)
    expect(stripe.calls.sessions[0].line_items.map((l: any) => l.price_data.unit_amount)).toEqual([5000])
    const [pay] = await paymentOf(d.id)
    expect(pay).toMatchObject({ amountCents: 5000, giftsHeld: 1 })
    await paid(pay.id)
    const [ent] = await db.select().from(studioEntitlements)
    expect(ent).toMatchObject({ category: 'building', amountCents: 5000, status: 'packaging' })
    const [after] = await paymentOf(d.id)
    expect(after.refundedCents).toBe(0)
  })

  it('finalizing a building with furniture finalizes every piece (LIV-82)', async () => {
    const u = await createUser({ role: 'admin' })
    const d = await createDesign(u, { kind: 'scene' })
    await addRevision(d, 'building', { pass: true, failures: 0, warnings: 0 }, { kind: 'building', footprint: '4x4' })
    await addRevision(d, 'furniture_desk', { pass: true, failures: 0, warnings: 0 }, { kind: 'furniture' })
    await addRevision(d, 'furniture_chair', { pass: true, failures: 0, warnings: 0 }, { kind: 'furniture' })
    const quote = await app.inject({ method: 'GET', url: `/api/studio/designs/${d.id}/finalize`, headers: as(u) })
    expect(quote.json().lines.map((l: any) => l.category).sort()).toEqual(['building', 'furniture_chair', 'furniture_desk'])
    expect((await finalize(u, d.id)).statusCode).toBe(200)
    const ents = await db.select().from(studioEntitlements)
    expect(ents.map((e) => e.category).sort()).toEqual(['building', 'furniture_chair', 'furniture_desk'])
    expect(await db.select().from(studioJobs).where(eq(studioJobs.type, 'finalize'))).toHaveLength(3)
  })

  it('a Virvi admin finalizes free: granted at once, no Stripe, packaged like any paid piece', async () => {
    const u = await createUser({ role: 'admin' })
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    const quote = await app.inject({ method: 'GET', url: `/api/studio/designs/${d.id}/finalize`, headers: as(u) })
    expect(quote.json()).toMatchObject({ totalCents: 0, lines: [{ category: 'hat', amountCents: 2900, admin: true }] })
    const res = await finalize(u, d.id)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ granted: true })
    expect(stripe.calls.sessions).toHaveLength(0)
    const [ent] = await db.select().from(studioEntitlements)
    expect(ent).toMatchObject({ category: 'hat', amountCents: 0, status: 'packaging' })
    expect(await db.select().from(studioJobs).where(eq(studioJobs.type, 'finalize'))).toHaveLength(1)
  })

  it('a Virvi admin finalizes free when Stripe isn’t set up; a creator is told payments are off', async () => {
    const key = config.stripeSecretKey
    ;(config as any).stripeSecretKey = ''
    try {
      const admin = await createUser({ role: 'admin' })
      const d = await createDesign(admin)
      await addRevision(d, 'hat')
      const res = await finalize(admin, d.id)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ granted: true })
      const creator = await createUser({ role: 'creator' })
      const c = await createDesign(creator)
      await addRevision(c, 'hat')
      const off = await finalize(creator, c.id)
      expect([off.statusCode, off.json().code]).toEqual([503, 'payments_unavailable'])
    } finally {
      ;(config as any).stripeSecretKey = key
    }
  })

  it('a creator still pays', async () => {
    const u = await createUser({ role: 'creator' })
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    await finalize(u, d.id)
    expect(stripe.calls.sessions[0].line_items.map((l: any) => l.price_data.unit_amount)).toEqual([2900])
  })

  it('a second click reuses the open session', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    const a = (await finalize(u, d.id)).json().url
    const b = (await finalize(u, d.id)).json().url
    expect(b).toBe(a)
    expect(stripe.calls.sessions).toHaveLength(1)
    expect(await paymentOf(d.id)).toHaveLength(1)
  })

  it('the paid webhook grants entitlements and queues one finalize job', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    await finalize(u, d.id)
    const [pay] = await paymentOf(d.id)
    await paid(pay.id)
    const ents = await db.select().from(studioEntitlements)
    expect(ents).toHaveLength(1)
    expect(ents[0]).toMatchObject({ category: 'hat', kind: 'first', amountCents: 2900, status: 'packaging', paymentId: pay.id })
    const jobs = await db.select().from(studioJobs).where(eq(studioJobs.type, 'finalize'))
    expect(jobs).toHaveLength(1)
    expect(ents[0].jobId).toBe(jobs[0].id)
    const [after] = await paymentOf(d.id)
    expect(after).toMatchObject({ status: 'paid', stripePaymentIntent: 'pi_1' })
    const [design] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, d.id))
    expect(design.finalizedAt).not.toBeNull()
    expect(fly.calls.create.length + fly.calls.start.length).toBeGreaterThan(0)
  })

  it('the same webhook twice changes nothing', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    await finalize(u, d.id)
    const [pay] = await paymentOf(d.id)
    await paid(pay.id)
    await paid(pay.id)
    expect(await db.select().from(studioEntitlements)).toHaveLength(1)
    expect(await db.select().from(studioJobs).where(eq(studioJobs.type, 'finalize'))).toHaveLength(1)
    expect(stripe.calls.refunds).toHaveLength(0)
  })

  it('duplicate payment for an entitled revision is refunded', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    await finalize(u, d.id)
    const [first] = await paymentOf(d.id)
    // the first session lapses on the client's side; a second one is opened and both end up paid
    await db.update(studioPayments).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(studioPayments.id, first.id))
    await finalize(u, d.id)
    const second = (await paymentOf(d.id)).find((p) => p.id !== first.id)!
    expect(stripe.calls.sessions).toHaveLength(2)
    await paid(first.id, 'pi_first')
    await paid(second.id, 'pi_second')
    expect(await db.select().from(studioEntitlements)).toHaveLength(1)
    expect(stripe.calls.refunds).toEqual([{
      params: expect.objectContaining({ payment_intent: 'pi_second', amount: 2900 }),
      opts: { idempotencyKey: expect.stringMatching(new RegExp(`^studio-refund-${second.id}-`)) },
    }])
    const [after] = await db.select().from(studioPayments).where(eq(studioPayments.id, second.id))
    expect(after.refundedCents).toBe(2900)
  })

  it('an expired session expires its payment', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    await finalize(u, d.id)
    const [pay] = await paymentOf(d.id)
    await webhook('checkout.session.expired', { id: 'cs_x', object: 'checkout.session', mode: 'payment', payment_status: 'unpaid', metadata: { vlm_studio_payment_id: pay.id } })
    expect((await paymentOf(d.id))[0].status).toBe('expired')
    expect(await db.select().from(studioEntitlements)).toHaveLength(0)
  })

  it('a fully waived checkout grants at once', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await entitle(d, await addRevision(d, 'hat'))
    const rev2 = await addRevision(d, 'hat')
    const res = await finalize(u, d.id, { reports: { hat: 'the brim clipped through the hair when waving' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ granted: true })
    expect(stripe.calls.sessions).toHaveLength(0)
    const [ent] = await db.select().from(studioEntitlements).where(eq(studioEntitlements.revisionId, rev2.id))
    expect(ent).toMatchObject({ kind: 'revision', amountCents: 0, status: 'packaging' })
    const [report] = await db.select().from(studioMistakeReports).where(eq(studioMistakeReports.entitlementId, ent.id))
    expect(report).toMatchObject({ status: 'waived', refundCents: 1500, text: 'the brim clipped through the hair when waving' })
  })

  it("a blocked piece can't be bought", async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat', { pass: false, failures: 1, warnings: 0 })
    const res = await finalize(u, d.id, { categories: ['hat'] })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'checks_failed', categories: ['hat'] })
    expect(await paymentOf(d.id)).toHaveLength(0)
  })

  it('a top-up adds credits when paid', async () => {
    const u = await createUser()
    const res = await app.inject({ method: 'POST', url: '/api/studio/topups', headers: as(u), payload: { packs: 2 } })
    expect(res.statusCode).toBe(200)
    const s = stripe.calls.sessions[0]
    expect(s.line_items).toEqual([expect.objectContaining({ quantity: 2, price_data: expect.objectContaining({ unit_amount: 500 }) })])
    expect(new URL(s.success_url).search).toMatch(/^\?payment=/)
    const [pay] = await db.select().from(studioPayments).where(eq(studioPayments.userId, u.id))
    expect(pay).toMatchObject({ kind: 'topup', prompts: 20, amountCents: 1000, designId: null })
    await paid(pay.id)
    const [credits] = await db.select().from(studioPromptCredits).where(eq(studioPromptCredits.userId, u.id))
    expect(credits.balance).toBe(20)
    expect((await app.inject({ method: 'POST', url: '/api/studio/topups', headers: as(u), payload: { packs: 11 } })).statusCode).toBe(400)
  })

  it('without Stripe the routes answer 503', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    ;(config as any).stripeSecretKey = undefined
    try {
      const a = await finalize(u, d.id)
      expect(a.statusCode).toBe(503)
      expect(a.json().code).toBe('payments_unavailable')
      expect((await app.inject({ method: 'POST', url: '/api/studio/topups', headers: as(u), payload: {} })).statusCode).toBe(503)
    } finally {
      ;(config as any).stripeSecretKey = 'sk_test_studio'
    }
  })

  it('a failed Stripe call leaves no payment behind', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    stripe.failSessions = true
    const res = await finalize(u, d.id)
    expect(res.statusCode).toBe(502)
    expect(res.json().code).toBe('stripe_error')
    expect(await paymentOf(d.id)).toHaveLength(0)
  })

  it('subscription checkouts still activate a subscription', async () => {
    const u = await createUser()
    await db.insert(subscriptions).values({ userId: u.id, stripeCustomerId: 'cus_s', tier: 'free', status: 'active' })
    await webhook('checkout.session.completed', {
      id: 'cs_sub', object: 'checkout.session', mode: 'subscription', subscription: 'sub_1', customer: 'cus_s',
      metadata: { vlm_user_id: u.id },
    })
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, u.id))
    expect(sub).toMatchObject({ stripeSubscriptionId: 'sub_1', status: 'active' })
  })

  describe('mistake reports', () => {
    const report = (u: TestUser, id: string, category: string, n: number, text = 'the sleeve clips through the arm when waving') =>
      app.inject({ method: 'POST', url: `/api/studio/designs/${id}/pieces/${category}/revisions/${n}/report`, headers: as(u), payload: { text } })

    async function revised(u: TestUser, opts: { paidAt?: Date } = {}) {
      const d = await createDesign(u)
      await entitle(d, await addRevision(d, 'hat'))
      await entitle(d, await addRevision(d, 'feet'))
      await addRevision(d, 'feet')
      const rev = await addRevision(d, 'hat')
      // hat revision 2, paid as the second revision line in its checkout
      const { entitlement } = await entitle(d, rev, { amountCents: 1000, paidAt: opts.paidAt, paymentIntent: 'pi_rev' })
      return { d, entitlement }
    }

    it("a report refunds the revision's line in full", async () => {
      const u = await createUser()
      const { d, entitlement } = await revised(u)
      const res = await report(u, d.id, 'hat', 2)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ status: 'refunded', refundCents: 1000, creditedCents: 0, manaCents: 0 })
      expect(stripe.calls.refunds).toEqual([{
        params: expect.objectContaining({ payment_intent: 'pi_rev', amount: 1000 }),
        opts: { idempotencyKey: expect.stringMatching(new RegExp(`^studio-report-${entitlement.id}-`)) },
      }])
      const [row] = await db.select().from(studioMistakeReports)
      expect(row).toMatchObject({ entitlementId: entitlement.id, status: 'refunded', refundCents: 1000, text: 'the sleeve clips through the arm when waving' })
      expect(row.stripeRefundId).toMatch(/^re_/)
      const [pay] = await db.select().from(studioPayments).where(eq(studioPayments.id, entitlement.paymentId))
      expect(pay.refundedCents).toBe(1000)
    })

    it('a second report is 409 already_reported', async () => {
      const u = await createUser()
      const { d } = await revised(u)
      await report(u, d.id, 'hat', 2)
      const again = await report(u, d.id, 'hat', 2)
      expect(again.statusCode).toBe(409)
      expect(again.json().code).toBe('already_reported')
      expect(stripe.calls.refunds).toHaveLength(1)
    })

    it("a first finalize can't be reported", async () => {
      const u = await createUser()
      const { d } = await revised(u)
      const res = await report(u, d.id, 'hat', 1)
      expect(res.statusCode).toBe(409)
      expect(res.json().code).toBe('not_a_revision')
    })

    it('after 30 days the window is closed', async () => {
      const u = await createUser()
      const { d } = await revised(u, { paidAt: new Date(Date.now() - 31 * 24 * 3600 * 1000) })
      const res = await report(u, d.id, 'hat', 2)
      expect(res.statusCode).toBe(409)
      expect(res.json().code).toBe('report_window_closed')
    })

    it('a refused refund stores no report', async () => {
      const u = await createUser()
      const { d, entitlement } = await revised(u)
      stripe.failRefunds = true
      const res = await report(u, d.id, 'hat', 2)
      expect(res.statusCode).toBe(502)
      expect(res.json().code).toBe('stripe_error')
      expect(await db.select().from(studioMistakeReports)).toHaveLength(0)
      stripe.failRefunds = false
      // Stripe replays a key's first answer for a day, errors included: the retry must use a new key
      expect((await report(u, d.id, 'hat', 2)).statusCode).toBe(200)
      const keys = stripe.calls.refunds.map((r) => r.opts.idempotencyKey)
      expect(keys).toHaveLength(2)
      expect(keys[0]).not.toBe(keys[1])
      expect(stripe.made).toHaveLength(1)
    })

    it('a refund Stripe already made is recorded, not repeated', async () => {
      const u = await createUser()
      const { d, entitlement } = await revised(u)
      // an earlier attempt reached Stripe but its answer was lost
      stripe.made.push({ id: 're_earlier', payment_intent: 'pi_rev', amount: 1000, metadata: { virvi_studio_entitlement_id: entitlement.id } })
      const res = await report(u, d.id, 'hat', 2)
      expect(res.statusCode).toBe(200)
      expect(stripe.calls.refunds).toHaveLength(0)
      const [row] = await db.select().from(studioMistakeReports)
      expect(row).toMatchObject({ status: 'refunded', stripeRefundId: 're_earlier' })
    })

    it('the customer keeps the files after a refund', async () => {
      const u = await createUser()
      const { d, entitlement } = await revised(u)
      expect((await report(u, d.id, 'hat', 2)).statusCode).toBe(200)
      const [e] = await db.select().from(studioEntitlements).where(eq(studioEntitlements.id, entitlement.id))
      expect(e.status).toBe('ready')
    })

    it('report input and ownership are checked', async () => {
      const u = await createUser()
      const { d } = await revised(u)
      expect((await report(u, d.id, 'hat', 2, 'short')).statusCode).toBe(400)
      expect((await report(u, d.id, 'hat', 9)).statusCode).toBe(402)
      expect((await report(u, d.id, 'hat', 9)).json().code).toBe('not_paid')
      expect((await report(await createUser(), d.id, 'hat', 2)).statusCode).toBe(404)
    })

    it('nothing charged means nothing to refund', async () => {
      const u = await createUser()
      const d = await createDesign(u)
      await entitle(d, await addRevision(d, 'hat'))
      await entitle(d, await addRevision(d, 'hat'), { amountCents: 0 })
      const res = await report(u, d.id, 'hat', 2)
      expect(res.statusCode).toBe(409)
      expect(res.json().code).toBe('nothing_charged')
    })
  })

  describe('review fixes', () => {
    const grantOf = async (designId: string) => (await paymentOf(designId)).sort((a, b) => +a.createdAt - +b.createdAt)

    it('the finalize jobs commit with the grant', async () => {
      const u = await createUser()
      const d = await createDesign(u)
      await addRevision(d, 'hat')
      await finalize(u, d.id)
      const [first] = await paymentOf(d.id)
      await db.update(studioPayments).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(studioPayments.id, first.id))
      await finalize(u, d.id)
      await paid(first.id, 'pi_first')
      await db.update(studioEntitlements).set({ status: 'failed' })
      // the next grant must refund a duplicate; Stripe never answers (as when the server dies mid-webhook)
      const { addRevision: add } = await import('./helpers/studio.js')
      await add(d, 'mask')
      stripe.hangRefunds = true
      const { quoteFinalize } = await import('../src/studio/pricing.js')
      const { grantPayment } = await import('../src/studio/payments.js')
      const q = await quoteFinalize(d, ['mask'], [])
      const second = (await paymentOf(d.id)).find((p) => p.id !== first.id)!
      await db.update(studioPayments).set({ lines: [...second.lines, ...q.lines] }).where(eq(studioPayments.id, second.id))
      void grantPayment(second.id, 'pi_second', new Date())
      const deadline = Date.now() + 5000
      let mask: any
      while (Date.now() < deadline) {
        ;[mask] = await db.select().from(studioEntitlements).where(eq(studioEntitlements.category, 'mask'))
        if (mask) break
        await new Promise((r) => setTimeout(r, 25))
      }
      expect(mask).toBeTruthy()
      expect(mask.jobId).not.toBeNull()
      const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, mask.jobId))
      expect(job).toMatchObject({ type: 'finalize', status: 'queued' })
    })

    it('a paid piece left without a job is packaged by the sweep', async () => {
      const { sweepStudio } = await import('../src/studio/sweep.js')
      const u = await createUser()
      const d = await createDesign(u)
      const { entitlement } = await entitle(d, await addRevision(d, 'hat'))
      await db.update(studioEntitlements).set({ status: 'packaging', jobId: null, createdAt: new Date(Date.now() - 10 * 60_000) })
        .where(eq(studioEntitlements.id, entitlement.id))
      await sweepStudio(new Date(), { fly })
      const [e] = await db.select().from(studioEntitlements).where(eq(studioEntitlements.id, entitlement.id))
      expect(e.status).toBe('packaging')
      expect(e.jobId).not.toBeNull()
      const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, e.jobId!))
      expect(job).toMatchObject({ type: 'finalize', status: 'queued' })
    })

    it('a reused session must match the waivers', async () => {
      const u = await createUser()
      const d = await createDesign(u)
      await entitle(d, await addRevision(d, 'hat'))
      await entitle(d, await addRevision(d, 'mask'))
      await addRevision(d, 'hat')
      await addRevision(d, 'mask')
      const plain = (await finalize(u, d.id)).json().url
      const reported = await finalize(u, d.id, { reports: { hat: 'the brim clips through the hair' } })
      expect(reported.statusCode).toBe(200)
      expect(reported.json().url).not.toBe(plain)
      expect(stripe.calls.sessions).toHaveLength(2)
      expect(stripe.calls.sessions[1].line_items.map((l: any) => l.price_data.unit_amount)).toEqual([1000])
    })

    it('two open checkouts for a new set are re-priced when paid', async () => {
      const u = await createUser()
      const d = await createDesign(u)
      await addRevision(d, 'hat')
      await addRevision(d, 'mask')
      await finalize(u, d.id, { categories: ['hat'] })
      await finalize(u, d.id, { categories: ['mask'] })
      const [a, b] = await grantOf(d.id)
      expect([a.amountCents, b.amountCents]).toEqual([2900, 2900])
      await paid(a.id, 'pi_a')
      await paid(b.id, 'pi_b')
      const [mask] = await db.select().from(studioEntitlements).where(eq(studioEntitlements.category, 'mask'))
      expect(mask).toMatchObject({ kind: 'first', amountCents: 1900 })
      expect(stripe.calls.refunds).toEqual([{ params: expect.objectContaining({ payment_intent: 'pi_b', amount: 1000 }), opts: expect.anything() }])
      const [after] = await db.select().from(studioPayments).where(eq(studioPayments.id, b.id))
      expect(after).toMatchObject({ refundedCents: 1000, refundDueCents: 0 })
    })

    it('a revision bought as a first finalize is re-priced', async () => {
      const u = await createUser()
      const d = await createDesign(u)
      await addRevision(d, 'hat')
      await finalize(u, d.id)
      await addRevision(d, 'hat')
      const [first] = await grantOf(d.id)
      await db.update(studioPayments).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(studioPayments.id, first.id))
      // revision 1's checkout is still open in another tab when revision 2 is quoted
      const { quoteFinalize } = await import('../src/studio/pricing.js')
      const q = await quoteFinalize(d, null, [])
      expect(q.lines[0]).toMatchObject({ priceKind: 'first', amountCents: 2900, revisionNumber: 2 })
      await finalize(u, d.id)
      const second = (await grantOf(d.id))[1]
      await paid(first.id, 'pi_r1')
      await paid(second.id, 'pi_r2')
      const ents = await db.select().from(studioEntitlements)
      expect(ents.map((e) => [e.kind, e.amountCents]).sort()).toEqual([['first', 2900], ['revision', 1500]])
      expect(stripe.calls.refunds.map((r) => [r.params.payment_intent, r.params.amount])).toEqual([['pi_r2', 1400]])
    })

    it('a duplicate refund that fails is owed and retried by the sweep', async () => {
      const { sweepStudio } = await import('../src/studio/sweep.js')
      const u = await createUser()
      const d = await createDesign(u)
      await addRevision(d, 'hat')
      await finalize(u, d.id)
      const [first] = await paymentOf(d.id)
      await db.update(studioPayments).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(studioPayments.id, first.id))
      await finalize(u, d.id)
      const second = (await paymentOf(d.id)).find((p) => p.id !== first.id)!
      await paid(first.id, 'pi_first')
      stripe.failRefunds = true
      await paid(second.id, 'pi_second')
      const [owed] = await db.select().from(studioPayments).where(eq(studioPayments.id, second.id))
      expect(owed).toMatchObject({ refundDueCents: 2900, refundedCents: 0 })
      stripe.failRefunds = false
      await sweepStudio(new Date(), { fly })
      const [settled] = await db.select().from(studioPayments).where(eq(studioPayments.id, second.id))
      expect(settled).toMatchObject({ refundDueCents: 0, refundedCents: 2900 })
      expect(stripe.made).toHaveLength(1)
      await sweepStudio(new Date(), { fly })
      expect(stripe.made).toHaveLength(1)
    })

    it('each paid piece gets its own finalize job', async () => {
      const u = await createUser()
      const d = await createDesign(u)
      await addRevision(d, 'hat')
      await addRevision(d, 'mask')
      await finalize(u, d.id)
      const [pay] = await paymentOf(d.id)
      await paid(pay.id)
      const ents = await db.select().from(studioEntitlements)
      expect(ents).toHaveLength(2)
      expect(new Set(ents.map((e) => e.jobId)).size).toBe(2)
      const jobs = await db.select().from(studioJobs).where(eq(studioJobs.type, 'finalize'))
      expect(jobs.map((j) => (j.payload as any).finalize.pieces.length)).toEqual([1, 1])
    })
  })

  describe('free finalizes', () => {
    const giveFinalizes = (u: TestUser, n: number) => db.insert(studioFinalizeCredits).values({ userId: u.id, balance: n })
    const balanceOf = async (u: TestUser) =>
      (await db.select().from(studioFinalizeCredits).where(eq(studioFinalizeCredits.userId, u.id)))[0]?.balance ?? 0
    const heldBy = async (designId: string) =>
      (await paymentOf(designId)).filter((p) => p.status === 'pending').reduce((sum, p) => sum + p.giftsHeld, 0)
    const expired = (paymentId: string) => webhook('checkout.session.expired', {
      id: 'cs_x', object: 'checkout.session', mode: 'payment', payment_status: 'unpaid', metadata: { vlm_studio_payment_id: paymentId },
    })
    /** A new set of a hat and a mask: with one free finalize the $29 hat is free and the $19 mask is paid. */
    async function hatAndMask(u: TestUser) {
      const d = await createDesign(u)
      const hat = await addRevision(d, 'hat')
      await addRevision(d, 'mask')
      return { d, hat }
    }

    it('a free finalize alone grants without Stripe and uses the credit', async () => {
      const u = await createUser()
      const d = await createDesign(u)
      await addRevision(d, 'hat')
      await giveFinalizes(u, 1)
      const quote = await app.inject({ method: 'GET', url: `/api/studio/designs/${d.id}/finalize`, headers: as(u) })
      expect(quote.json()).toMatchObject({ totalCents: 0, giftsUsed: 1, lines: [{ category: 'hat', amountCents: 2900, gift: true }] })
      const res = await finalize(u, d.id)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ granted: true })
      expect(stripe.calls.sessions).toHaveLength(0)
      expect(await balanceOf(u)).toBe(0)
      const [ent] = await db.select().from(studioEntitlements)
      expect(ent).toMatchObject({ category: 'hat', kind: 'first', amountCents: 0, status: 'packaging' })
      const [pay] = await paymentOf(d.id)
      expect(pay).toMatchObject({ status: 'paid', amountCents: 0, giftsHeld: 1, refundDueCents: 0 })
    })

    it('a mixed checkout sends only paid lines to Stripe and holds the credit', async () => {
      const u = await createUser()
      const { d } = await hatAndMask(u)
      await giveFinalizes(u, 1)
      const res = await finalize(u, d.id)
      expect(res.statusCode).toBe(200)
      expect(stripe.calls.sessions[0].line_items.map((l: any) => [l.price_data.product_data.name, l.price_data.unit_amount]))
        .toEqual([['Neon mask: finalize', 1900]])
      const [pay] = await paymentOf(d.id)
      expect(pay).toMatchObject({ status: 'pending', amountCents: 1900, giftsHeld: 1 })
      expect(pay.lines.map((l) => [l.category, !!l.gift])).toEqual([['hat', true], ['mask', false]])
      expect(await balanceOf(u)).toBe(0)
      // paid: the hat is free, the mask charged, the credit used once
      await paid(pay.id)
      const ents = await db.select().from(studioEntitlements)
      expect(ents.map((e) => [e.category, e.amountCents]).sort()).toEqual([['hat', 0], ['mask', 1900]])
      expect(stripe.calls.refunds).toHaveLength(0)
      expect(await balanceOf(u)).toBe(0)
      expect((await paymentOf(d.id))[0]).toMatchObject({ status: 'paid', giftsHeld: 1, refundDueCents: 0 })
    })

    it('an expired checkout gives its free finalize back', async () => {
      const u = await createUser()
      const { d } = await hatAndMask(u)
      await giveFinalizes(u, 1)
      await finalize(u, d.id)
      const [pay] = await paymentOf(d.id)
      expect([pay.giftsHeld, await balanceOf(u)]).toEqual([1, 0])
      await expired(pay.id)
      expect(await balanceOf(u)).toBe(1)
      expect((await paymentOf(d.id))[0]).toMatchObject({ status: 'expired', giftsHeld: 0 })
      // the same event again gives nothing more
      await expired(pay.id)
      expect(await balanceOf(u)).toBe(1)
    })

    it('a failed delayed payment gives its free finalize back', async () => {
      const u = await createUser()
      const { d } = await hatAndMask(u)
      await giveFinalizes(u, 1)
      await finalize(u, d.id)
      const [pay] = await paymentOf(d.id)
      expect([pay.giftsHeld, await balanceOf(u)]).toEqual([1, 0])
      // a bank debit: the session completes unpaid, then the payment fails
      const session = { id: 'cs_x', object: 'checkout.session', mode: 'payment', payment_status: 'unpaid', metadata: { vlm_studio_payment_id: pay.id } }
      await webhook('checkout.session.completed', session)
      expect((await paymentOf(d.id))[0]).toMatchObject({ status: 'pending', giftsHeld: 1 })
      await webhook('checkout.session.async_payment_failed', session)
      expect((await paymentOf(d.id))[0]).toMatchObject({ status: 'expired', giftsHeld: 0 })
      expect(await balanceOf(u)).toBe(1)
      await webhook('checkout.session.async_payment_failed', session)
      expect(await balanceOf(u)).toBe(1)
      expect(await db.select().from(studioEntitlements)).toHaveLength(0)
    })

    it('a failed Stripe session gives its free finalize back', async () => {
      const u = await createUser()
      const { d } = await hatAndMask(u)
      await giveFinalizes(u, 1)
      stripe.failSessions = true
      const res = await finalize(u, d.id)
      expect(res.statusCode).toBe(502)
      expect(await paymentOf(d.id)).toHaveLength(0)
      expect(await balanceOf(u)).toBe(1)
      // still there to use
      stripe.failSessions = false
      expect((await finalize(u, d.id)).statusCode).toBe(200)
      expect([(await paymentOf(d.id))[0].giftsHeld, await balanceOf(u)]).toEqual([1, 0])
    })

    it('a new checkout replaces the open one and takes over its free finalize', async () => {
      const u = await createUser()
      const { d } = await hatAndMask(u)
      await addRevision(d, 'feet')
      await giveFinalizes(u, 1)
      await finalize(u, d.id, { categories: ['hat', 'mask'] })
      const [first] = await paymentOf(d.id)
      expect(first.giftsHeld).toBe(1)
      const res = await finalize(u, d.id, { categories: ['feet', 'mask'] })
      expect(res.statusCode).toBe(200)
      expect(stripe.calls.expired).toEqual([first.stripeSessionId])
      const second = (await paymentOf(d.id)).find((p) => p.id !== first.id)!
      expect(second).toMatchObject({ status: 'pending', giftsHeld: 1, amountCents: 1900 })
      expect(second.lines.map((l) => [l.category, !!l.gift])).toEqual([['feet', true], ['mask', false]])
      expect((await paymentOf(d.id)).find((p) => p.id === first.id)).toMatchObject({ status: 'expired', giftsHeld: 0 })
      expect((await balanceOf(u)) + (await heldBy(d.id))).toBe(1)
      // Stripe's own expired event for the replaced session changes nothing
      await expired(first.id)
      expect((await balanceOf(u)) + (await heldBy(d.id))).toBe(1)
    })

    it("an open checkout Stripe says is complete keeps its free finalize", async () => {
      const u = await createUser()
      const { d } = await hatAndMask(u)
      await addRevision(d, 'feet')
      await giveFinalizes(u, 1)
      await finalize(u, d.id, { categories: ['hat', 'mask'] })
      const [first] = await paymentOf(d.id)
      stripe.completedSessions.add(first.stripeSessionId!)
      // the quote counted its credit, so a full-price checkout is refused rather than opened
      const res = await finalize(u, d.id, { categories: ['feet', 'mask'] })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'free_finalize_busy' })
      expect(await paymentOf(d.id)).toEqual([expect.objectContaining({ id: first.id, status: 'pending', giftsHeld: 1 })])
      expect(await balanceOf(u)).toBe(0)
      // its payment lands: the credit is used by it, once
      await paid(first.id)
      expect(await balanceOf(u)).toBe(0)
      expect(await db.select().from(studioEntitlements).where(eq(studioEntitlements.category, 'hat')))
        .toEqual([expect.objectContaining({ amountCents: 0 })])
    })

    it('a checkout whose free finalize is held elsewhere is refused, not charged in full', async () => {
      const u = await createUser()
      const { d } = await hatAndMask(u)
      await addRevision(d, 'feet')
      await giveFinalizes(u, 1)
      await finalize(u, d.id, { categories: ['hat', 'mask'] })
      const [first] = await paymentOf(d.id)
      stripe.failExpire = true
      const res = await finalize(u, d.id, { categories: ['feet', 'mask'] })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ error: 'free_finalize_busy', code: 'free_finalize_busy' })
      expect(stripe.calls.expired).toEqual([first.stripeSessionId])
      expect(stripe.calls.sessions).toHaveLength(1)
      expect(await paymentOf(d.id)).toEqual([expect.objectContaining({ id: first.id, status: 'pending', giftsHeld: 1 })])
      expect((await balanceOf(u)) + (await heldBy(d.id))).toBe(1)
      // once Stripe answers, the retry takes the credit over
      stripe.failExpire = false
      expect((await finalize(u, d.id, { categories: ['feet', 'mask'] })).statusCode).toBe(200)
      expect((await balanceOf(u)) + (await heldBy(d.id))).toBe(1)
      expect((await paymentOf(d.id)).find((p) => p.id !== first.id)).toMatchObject({ giftsHeld: 1, amountCents: 1900 })
    })

    it('reopening the same checkout reuses it', async () => {
      const u = await createUser()
      const { d } = await hatAndMask(u)
      await giveFinalizes(u, 1)
      const a = (await finalize(u, d.id)).json().url
      const b = (await finalize(u, d.id)).json().url
      expect(b).toBe(a)
      expect(stripe.calls.sessions).toHaveLength(1)
      expect(stripe.calls.expired).toHaveLength(0)
      expect(await paymentOf(d.id)).toHaveLength(1)
      expect(await balanceOf(u)).toBe(0)
      expect(await heldBy(d.id)).toBe(1)
    })

    it('a gift line already paid elsewhere gives its credit back', async () => {
      const u = await createUser()
      const { d, hat } = await hatAndMask(u)
      await giveFinalizes(u, 1)
      await finalize(u, d.id)
      const [pay] = await paymentOf(d.id)
      // the hat's revision is paid for by another checkout first
      await entitle(d, hat)
      await paid(pay.id)
      expect(await balanceOf(u)).toBe(1)
      const [after] = await db.select().from(studioPayments).where(eq(studioPayments.id, pay.id))
      expect(after).toMatchObject({ status: 'paid', giftsHeld: 0, refundDueCents: 0 })
      expect(stripe.calls.refunds).toHaveLength(0)
      const [mask] = await db.select().from(studioEntitlements).where(eq(studioEntitlements.category, 'mask'))
      expect(mask).toMatchObject({ amountCents: 1900 })
    })

    it('two checkouts at once never use one credit twice', async () => {
      const u = await createUser()
      const { d } = await hatAndMask(u)
      await giveFinalizes(u, 1)
      // six at once, so their transactions overlap
      const res = await Promise.all(Array.from({ length: 6 }, () => finalize(u, d.id)))
      // the others reuse its session, or are told the credit is held while it is still opening
      for (const r of res) expect(r.statusCode === 200 || r.json().code === 'free_finalize_busy').toBe(true)
      expect(res.some((r) => r.statusCode === 200)).toBe(true)
      const pays = await paymentOf(d.id)
      // exactly one checkout holds the credit, however many were opened
      expect(pays.filter((p) => p.giftsHeld === 1)).toHaveLength(1)
      expect(pays.reduce((sum, p) => sum + p.giftsHeld, 0)).toBe(1)
      expect(await balanceOf(u)).toBe(0)
    })

    it('a checkout that commits while another is quoting is reused, not expired by a double-counted credit', async () => {
      const u = await createUser()
      const { d } = await hatAndMask(u)
      await giveFinalizes(u, 1)
      // The first checkout as it is once open; set aside so it can be committed at the worst moment
      await finalize(u, d.id)
      const [first] = await paymentOf(d.id)
      await db.delete(studioPayments).where(eq(studioPayments.id, first.id))
      await db.update(studioFinalizeCredits).set({ balance: 1 }).where(eq(studioFinalizeCredits.userId, u.id))
      let release!: () => void
      let locked!: () => void
      const held = new Promise<void>((r) => { release = r })
      const ready = new Promise<void>((r) => { locked = r })
      // The second request reads the balance (1) and then waits to read what open checkouts hold
      const commit = db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE studio_payments IN ACCESS EXCLUSIVE MODE`)
        locked()
        await held
        // the first checkout commits in between: the credit moves from the balance to its hold
        await tx.insert(studioPayments).values(first)
        await tx.update(studioFinalizeCredits).set({ balance: 0 }).where(eq(studioFinalizeCredits.userId, u.id))
      })
      await ready
      const second = finalize(u, d.id)
      for (let i = 0; i < 200; i++) {
        const [{ n }] = await db.execute(sql`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`) as unknown as [{ n: number }]
        if (n > 0) break
        await new Promise((r) => setTimeout(r, 25))
      }
      release()
      await commit
      const res = await second
      // one credit, counted once: the same quote, so the open session is handed out again
      expect(res.statusCode).toBe(200)
      expect(res.json().url).toBe(first.stripeSessionUrl)
      expect(stripe.calls.expired).toEqual([])
      expect(await paymentOf(d.id)).toEqual([expect.objectContaining({ id: first.id, status: 'pending', giftsHeld: 1 })])
      expect(await balanceOf(u)).toBe(0)
    })
  })
})
