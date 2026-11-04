import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioCreditLedger, studioEntitlements, studioMistakeReports, studioPayments } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { setStripe } from '../src/integrations/stripe.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { setFlagMailer } from '../src/studio/scope.js'
import { addCredit, creditBalance } from '../src/studio/credit.js'
import { approveReport, grantPayment, refundSplit } from '../src/studio/payments.js'
import { sweepStudio } from '../src/studio/sweep.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { createDesign, addRevision, entitle, fakeFly, fakeStripe } from './helpers/studio.js'

const TEXT = 'the sleeve clips through the arm when waving'

describe('refundSplit', () => {
  it('a card line refunds its card share through Stripe and its credit share as credit', () => {
    expect(refundSplit({ amountCents: 1500, creditCents: 500, method: 'card' })).toEqual({ stripeCents: 1000, creditCents: 500, manaCents: 0 })
  })
  it('a MANA line goes back as credit, its MANA share marked', () => {
    expect(refundSplit({ amountCents: 1500, creditCents: 200, method: 'mana' })).toEqual({ stripeCents: 0, creditCents: 200, manaCents: 1300 })
  })
  it('a credit line goes back as credit', () => {
    expect(refundSplit({ amountCents: 1500, creditCents: 1500, method: 'credit' })).toEqual({ stripeCents: 0, creditCents: 1500, manaCents: 0 })
  })
  it('an old card line without credit refunds in full through Stripe', () => {
    expect(refundSplit({ amountCents: 1000, creditCents: 0, method: 'card' })).toEqual({ stripeCents: 1000, creditCents: 0, manaCents: 0 })
  })
})

describe('mistake refunds by how each line was paid', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let stripe: ReturnType<typeof fakeStripe>
  const prev = {
    enabled: config.studioEnabled, key: config.stripeSecretKey, billing: config.billingEnabled,
    image: config.studioWorkerImage, flag: { ...config.studioFlag },
  }
  beforeAll(() => {
    ;(config as any).studioEnabled = true
    ;(config as any).studioWorkerImage = 'registry.fly.io/vlm-studio-worker:test'
    ;(config as any).stripeSecretKey = 'sk_test_studio'
    ;(config as any).billingEnabled = true
    setFlagMailer(async () => true)
  })
  afterAll(() => {
    ;(config as any).studioEnabled = prev.enabled
    ;(config as any).studioWorkerImage = prev.image
    ;(config as any).stripeSecretKey = prev.key
    ;(config as any).billingEnabled = prev.billing
    ;(config as any).studioFlag = prev.flag
    setFlagMailer(null)
    setStripe(null)
    setMachineDeps(null)
    setStudioStore(null)
  })
  beforeEach(async () => {
    await resetDb()
    ;(config as any).studioFlag = { ...prev.flag, email: 'owner@virvi.test', instantReports: 2 }
    stripe = fakeStripe()
    setStripe(stripe)
    setMachineDeps({ fly: fakeFly() })
    setStudioStore(memoryStudioStore())
    app = await testApp()
  })

  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const report = (u: TestUser, id: string, n = 2) =>
    app.inject({ method: 'POST', url: `/api/studio/designs/${id}/pieces/hat/revisions/${n}/report`, headers: as(u), payload: { text: TEXT } })

  /** A hat finalized once, then revision 2 paid as given. */
  async function revised(u: TestUser, paid: { amountCents: number; creditCents: number; method: 'card' | 'mana' | 'credit' }) {
    const d = await createDesign(u)
    await entitle(d, await addRevision(d, 'hat'))
    const { entitlement, payment } = await entitle(d, await addRevision(d, 'hat'), { amountCents: paid.amountCents, paymentIntent: 'pi_rev' })
    await db.update(studioEntitlements).set({ method: paid.method, creditCents: paid.creditCents }).where(eq(studioEntitlements.id, entitlement.id))
    await db.update(studioPayments).set({
      method: paid.method, creditHeldCents: paid.creditCents, ...(paid.method === 'card' ? {} : { stripePaymentIntent: null }),
    }).where(eq(studioPayments.id, payment.id))
    return { d, entitlement, payment }
  }
  const refundLedger = async (u: TestUser) =>
    (await db.select().from(studioCreditLedger).where(eq(studioCreditLedger.userId, u.id))).filter((r) => r.reason === 'refund')

  it('a card revision partly paid by credit refunds the card share through Stripe and the rest as credit', async () => {
    const u = await createUser()
    const { d, entitlement, payment } = await revised(u, { amountCents: 1500, creditCents: 500, method: 'card' })
    const res = await report(u, d.id)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'refunded', refundCents: 1500, creditedCents: 500, manaCents: 0 })
    expect(stripe.calls.refunds.map((r) => [r.params.payment_intent, r.params.amount])).toEqual([['pi_rev', 1000]])
    expect(await creditBalance(u.id)).toBe(500)
    const [row] = await db.select().from(studioMistakeReports)
    expect(row).toMatchObject({ entitlementId: entitlement.id, status: 'refunded', refundCents: 1500, creditedCents: 500, manaCents: 0 })
    expect(row.stripeRefundId).toMatch(/^re_/)
    expect(await refundLedger(u)).toEqual([expect.objectContaining({ deltaCents: 500, refId: row.id })])
    const [pay] = await db.select().from(studioPayments).where(eq(studioPayments.id, payment.id))
    expect(pay.refundedCents).toBe(1000)
  })

  it('a MANA revision goes back as credit without calling Stripe', async () => {
    const u = await createUser()
    const { d } = await revised(u, { amountCents: 1500, creditCents: 0, method: 'mana' })
    const res = await report(u, d.id)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'refunded', refundCents: 1500, creditedCents: 1500, manaCents: 1500 })
    expect(stripe.calls.refunds).toHaveLength(0)
    expect(await creditBalance(u.id)).toBe(1500)
    const [row] = await db.select().from(studioMistakeReports)
    expect(row).toMatchObject({ status: 'refunded', refundCents: 1500, creditedCents: 1500, manaCents: 1500, stripeRefundId: null })
    // A second report credits nothing more
    expect((await report(u, d.id)).statusCode).toBe(409)
    expect(await creditBalance(u.id)).toBe(1500)
  })

  it('a revision paid fully by credit goes back as credit', async () => {
    const u = await createUser()
    const { d } = await revised(u, { amountCents: 1500, creditCents: 1500, method: 'credit' })
    const res = await report(u, d.id)
    expect(res.json()).toEqual({ status: 'refunded', refundCents: 1500, creditedCents: 1500, manaCents: 0 })
    expect(stripe.calls.refunds).toHaveLength(0)
    expect(await creditBalance(u.id)).toBe(1500)
  })

  it('a held report on a MANA line, approved by the owner, goes back as credit', async () => {
    ;(config as any).studioFlag = { ...config.studioFlag, instantReports: 0 }
    const admin = await createUser({ role: 'admin' })
    const u = await createUser()
    const { d } = await revised(u, { amountCents: 1500, creditCents: 0, method: 'mana' })
    expect((await report(u, d.id)).json()).toEqual({ status: 'in_review' })
    const [held] = await db.select().from(studioMistakeReports)
    const ok = await app.inject({ method: 'POST', url: `/api/admin/studio/reports/${held.id}/approve`, headers: as(admin) })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ status: 'refunded', refundCents: 1500, creditedCents: 1500, manaCents: 1500 })
    expect(stripe.calls.refunds).toHaveLength(0)
    expect(await creditBalance(u.id)).toBe(1500)
    const [row] = await db.select().from(studioMistakeReports)
    expect(row).toMatchObject({ status: 'refunded', creditedCents: 1500, manaCents: 1500, reviewedBy: admin.id })
    expect((await app.inject({ method: 'POST', url: `/api/admin/studio/reports/${held.id}/approve`, headers: as(admin) })).statusCode).toBe(409)
    expect(await creditBalance(u.id)).toBe(1500)
  })

  it('a free revision still has nothing to refund', async () => {
    const u = await createUser()
    const { d } = await revised(u, { amountCents: 0, creditCents: 0, method: 'mana' })
    const res = await report(u, d.id)
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('nothing_charged')
  })

  it('an old card-only payment refunds in full through Stripe, as before', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await entitle(d, await addRevision(d, 'hat'))
    await entitle(d, await addRevision(d, 'hat'), { amountCents: 1000, paymentIntent: 'pi_old' })
    const res = await report(u, d.id)
    expect(res.json()).toEqual({ status: 'refunded', refundCents: 1000, creditedCents: 0, manaCents: 0 })
    expect(stripe.calls.refunds.map((r) => [r.params.payment_intent, r.params.amount])).toEqual([['pi_old', 1000]])
    expect(await creditBalance(u.id)).toBe(0)
    expect(await refundLedger(u)).toHaveLength(0)
  })

  it('an overcharge found at grant time on a MANA payment goes back as credit, not through Stripe', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    const hat = await addRevision(d, 'hat')
    await addRevision(d, 'feet')
    // feet the first finalize (2900), hat an extra piece (1900)
    expect((await app.inject({ method: 'POST', url: `/api/studio/designs/${d.id}/finalize`, headers: as(u), payload: {} })).statusCode).toBe(200)
    const [pay] = await db.select().from(studioPayments).where(eq(studioPayments.designId, d.id))
    await db.update(studioPayments).set({ method: 'mana', stripeSessionId: null }).where(eq(studioPayments.id, pay.id))
    // Meanwhile hat was paid for: feet drops to 1900 (1000 over), hat is owed back in full (1900)
    await entitle(d, hat, { amountCents: 2900 })
    expect(await grantPayment(pay.id, null, new Date())).toBe('granted')
    expect(stripe.calls.refunds).toHaveLength(0)
    expect(await creditBalance(u.id)).toBe(2900)
    const [after] = await db.select().from(studioPayments).where(eq(studioPayments.id, pay.id))
    expect(after.refundDueCents).toBe(0)
    expect(await refundLedger(u)).toEqual([expect.objectContaining({ deltaCents: 2900, refId: pay.id })])
    const [e] = await db.select().from(studioEntitlements).where(eq(studioEntitlements.paymentId, pay.id))
    expect(e).toMatchObject({ category: 'feet', amountCents: 1900, method: 'mana' })
  })
  it('a MANA overcharge that also held credit gives back exactly the overcharge', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    const hat = await addRevision(d, 'hat')
    await addRevision(d, 'feet')
    await db.transaction((tx) => addCredit(tx, u.id, 2000, 'refund', null, new Date()))
    // feet the first finalize, 2900 (2000 credit + 900 MANA); hat an extra piece, 1900 MANA: 4800 paid in all
    expect((await app.inject({ method: 'POST', url: `/api/studio/designs/${d.id}/finalize`, headers: as(u), payload: {} })).statusCode).toBe(200)
    const [pay] = await db.select().from(studioPayments).where(eq(studioPayments.designId, d.id))
    expect(pay.creditHeldCents).toBe(2000)
    expect(await creditBalance(u.id)).toBe(0)
    await db.update(studioPayments).set({ method: 'mana', stripeSessionId: null }).where(eq(studioPayments.id, pay.id))
    // Meanwhile hat was paid for: only feet, now 1900, is kept; 4800 - 1900 = 2900 is owed back
    await entitle(d, hat, { amountCents: 2900 })
    expect(await grantPayment(pay.id, null, new Date())).toBe('granted')
    expect(stripe.calls.refunds).toHaveLength(0)
    expect(await creditBalance(u.id)).toBe(2900)
    const back = (await refundLedger(u)).filter((r) => r.refId === pay.id)
    expect(back.reduce((sum, r) => sum + r.deltaCents, 0)).toBe(2900)
    const [e] = await db.select().from(studioEntitlements).where(eq(studioEntitlements.paymentId, pay.id))
    expect(e).toMatchObject({ category: 'feet', amountCents: 1900, creditCents: 1900, method: 'mana' })
  })

  it('the sweep credits a MANA payment still owed back, once', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    // A grant whose post-commit credit didn't land (the database blinked): the debt is still on the payment
    const [pay] = await db.insert(studioPayments).values({
      userId: u.id, designId: d.id, kind: 'finalize', status: 'paid', method: 'mana', amountCents: 2900, paidAt: new Date(), refundDueCents: 700,
    }).returning()
    await sweepStudio(new Date(), { fly: fakeFly() })
    expect(await creditBalance(u.id)).toBe(700)
    await sweepStudio(new Date(), { fly: fakeFly() })
    expect(await creditBalance(u.id)).toBe(700)
    expect(await refundLedger(u)).toEqual([expect.objectContaining({ deltaCents: 700, refId: pay.id })])
    const [after] = await db.select().from(studioPayments).where(eq(studioPayments.id, pay.id))
    expect(after.refundDueCents).toBe(0)
    expect(stripe.calls.refunds).toHaveLength(0)
  })

  it('a stale approval approved again on a card and credit line refunds Stripe once and credits once', async () => {
    ;(config as any).studioFlag = { ...config.studioFlag, instantReports: 0 }
    const admin = await createUser({ role: 'admin' })
    const u = await createUser()
    const { d, payment } = await revised(u, { amountCents: 1500, creditCents: 500, method: 'card' })
    expect((await report(u, d.id)).json()).toEqual({ status: 'in_review' })
    const [held] = await db.select().from(studioMistakeReports)
    // The first approval stalls before it reaches Stripe
    const list = stripe.refunds.list.bind(stripe.refunds)
    let entered!: () => void
    let release!: () => void
    const stalled = new Promise<void>((r) => { entered = r })
    const gate = new Promise<void>((r) => { release = r })
    let first = true
    stripe.refunds.list = async (params: any) => {
      if (first) { first = false; entered(); await gate }
      return list(params)
    }
    const t0 = new Date()
    const a = approveReport(held.id, admin.id, t0)
    await stalled
    // Past the approval's lock time, the owner approves again and it completes
    const b = await approveReport(held.id, admin.id, new Date(t0.getTime() + 20 * 60_000))
    expect(b).toEqual({ status: 'refunded', refundCents: 1500, creditedCents: 500, manaCents: 0 })
    // The first approval resumes: it finds Stripe's refund and records nothing more
    release()
    expect(await a).toEqual({ status: 'refunded', refundCents: 1500, creditedCents: 500, manaCents: 0 })
    expect(stripe.calls.refunds).toHaveLength(1)
    expect(stripe.made).toHaveLength(1)
    expect(await creditBalance(u.id)).toBe(500)
    expect(await refundLedger(u)).toHaveLength(1)
    const [pay] = await db.select().from(studioPayments).where(eq(studioPayments.id, payment.id))
    expect(pay.refundedCents).toBe(1000)
    const [row] = await db.select().from(studioMistakeReports)
    expect(row).toMatchObject({ status: 'refunded', creditedCents: 500, stripeRefundId: stripe.made[0].id })
  })
})
