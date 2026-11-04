import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import Stripe from 'stripe'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioEntitlements, studioGiftCodes, studioGiftRedemptions, studioFlags, studioMistakeReports, studioPauses, studioPayments, studioScopeEvents } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { setStripe } from '../src/integrations/stripe.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { setFlagMailer } from '../src/studio/scope.js'
import { hashGiftCode } from '../src/studio/gift-codes.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { addRevision, createDesign, entitle, fakeFly, fakeStripe } from './helpers/studio.js'

const WEBHOOK_SECRET = 'whsec_studio_admin_test'
const signer = new Stripe('sk_test_dummy')

describe('studio admin: flags and pauses', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let stripe: ReturnType<typeof fakeStripe>
  let admin: TestUser
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
    admin = await createUser({ role: 'admin' })
  })

  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const pause = (userId: string, by = admin) => app.inject({ method: 'POST', url: `/api/admin/studio/users/${userId}/pause`, headers: as(by) })
  const resume = (userId: string) => app.inject({ method: 'DELETE', url: `/api/admin/studio/users/${userId}/pause`, headers: as(admin) })
  const paid = async (paymentId: string) => {
    const payload = JSON.stringify({ id: `evt_${Math.random()}`, object: 'event', type: 'checkout.session.completed', data: { object: {
      id: 'cs_x', object: 'checkout.session', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_paused',
      metadata: { vlm_studio_payment_id: paymentId, vlm_user_id: 'x' },
    } } })
    const res = await app.inject({
      method: 'POST', url: '/api/billing/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }) },
      payload,
    })
    expect(res.statusCode).toBe(200)
  }

  it('a paused account is refused new work', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    expect((await pause(u.id)).statusCode).toBe(204)
    const refused = [
      await app.inject({ method: 'POST', url: '/api/studio/designs', headers: as(u), payload: { kind: 'wearable', agent: 'claude' } }),
      await app.inject({ method: 'POST', url: `/api/studio/designs/${d.id}/prompts`, headers: as(u), payload: { text: 'a cap' } }),
      await app.inject({ method: 'POST', url: `/api/studio/designs/${d.id}/prompts`, headers: as(u), payload: { fixChecks: true } }),
      await app.inject({ method: 'POST', url: `/api/studio/designs/${d.id}/renders`, headers: as(u), payload: { categories: ['hat'], bodyShape: 'female', outfit: 'default', emote: null } }),
      await app.inject({ method: 'POST', url: `/api/studio/designs/${d.id}/uploads?name=logo.png`, headers: { ...as(u), 'content-type': 'image/png' }, payload: Buffer.from('x') }),
      await app.inject({ method: 'POST', url: '/api/studio/topups', headers: as(u), payload: { packs: 1 } }),
    ]
    for (const res of refused) expect([res.statusCode, res.json().code]).toEqual([403, 'studio_paused'])
  })

  it('a paused account can still read, finalize, pay and report', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await entitle(d, await addRevision(d, 'hat'))
    await addRevision(d, 'feet')
    const rev = await addRevision(d, 'hat')
    await entitle(d, rev, { amountCents: 1500, paymentIntent: 'pi_rev' })
    await pause(u.id)
    expect((await app.inject({ method: 'GET', url: `/api/studio/designs/${d.id}`, headers: as(u) })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: `/api/studio/designs/${d.id}/finalize`, headers: as(u) })).statusCode).toBe(200)
    const checkout = await app.inject({ method: 'POST', url: `/api/studio/designs/${d.id}/finalize`, headers: as(u), payload: { categories: ['feet'] } })
    expect(checkout.statusCode).toBe(200)
    expect(checkout.json().url).toMatch(/^https:\/\/checkout\.stripe\.test\//)
    const report = await app.inject({ method: 'POST', url: `/api/studio/designs/${d.id}/pieces/hat/revisions/2/report`, headers: as(u), payload: { text: 'the sleeve clips through the arm when waving' } })
    expect(report.statusCode).toBe(200)
    const pkg = await app.inject({ method: 'GET', url: `/api/studio/designs/${d.id}/pieces/hat/revisions/1/package`, headers: as(u) })
    expect(pkg.statusCode).not.toBe(403)
  })

  it('a checkout opened before the pause still grants on the webhook', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    expect((await app.inject({ method: 'POST', url: `/api/studio/designs/${d.id}/finalize`, headers: as(u), payload: {} })).statusCode).toBe(200)
    const [payment] = await db.select().from(studioPayments).where(eq(studioPayments.designId, d.id))
    await pause(u.id)
    await paid(payment.id)
    expect(await db.select().from(studioEntitlements).where(eq(studioEntitlements.paymentId, payment.id))).toHaveLength(1)
  })

  it('usage says paused', async () => {
    const u = await createUser()
    const usage = () => app.inject({ method: 'GET', url: '/api/studio/usage', headers: as(u) })
    expect((await usage()).json().paused).toBe(false)
    await pause(u.id)
    expect((await usage()).json().paused).toBe(true)
    expect((await resume(u.id)).statusCode).toBe(204)
    expect((await usage()).json().paused).toBe(false)
  })

  it('admins list, dismiss, pause and resume; others are refused', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await db.insert(studioScopeEvents).values({ userId: u.id, designId: d.id, by: 'check', category: 'coding', note: 'python', message: 'write python' })
    const [flag] = await db.insert(studioFlags).values({ userId: u.id }).returning()
    const list = async (status = 'open') => (await app.inject({ method: 'GET', url: `/api/admin/studio/flags?status=${status}`, headers: as(admin) })).json().flags
    const open = await list()
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ id: flag.id, status: 'open', paused: false, user: { id: u.id, email: u.email, plan: 'free' } })
    expect(open[0].events).toEqual([expect.objectContaining({ by: 'check', category: 'coding', note: 'python', message: 'write python', designId: d.id })])
    await pause(u.id)
    expect((await list())[0].paused).toBe(true)
    expect((await db.select().from(studioPauses))[0]).toMatchObject({ userId: u.id, pausedBy: admin.id })
    expect((await app.inject({ method: 'POST', url: `/api/admin/studio/flags/${flag.id}/dismiss`, headers: as(admin) })).statusCode).toBe(204)
    expect(await list()).toHaveLength(0)
    expect(await list('closed')).toEqual([expect.objectContaining({ id: flag.id, status: 'dismissed' })])
    const creator = await createUser()
    for (const res of [
      await app.inject({ method: 'GET', url: '/api/admin/studio/flags', headers: as(creator) }),
      await pause(u.id, creator),
      await app.inject({ method: 'POST', url: `/api/admin/studio/flags/${flag.id}/dismiss`, headers: as(creator) }),
    ]) expect(res.statusCode).toBe(403)
  })

  describe('mistake reports past the instant limit', () => {
    let mail: { to: string; subject: string; html: string }[]
    const prevFlag = { ...config.studioFlag }
    beforeEach(() => {
      mail = []
      setFlagMailer(async (to, subject, html) => { mail.push({ to, subject, html }); return true })
      ;(config as any).studioFlag = { ...prevFlag, email: 'owner@virvi.test', instantReports: 2 }
    })
    afterAll(() => {
      setFlagMailer(null)
      ;(config as any).studioFlag = prevFlag
    })
    const TEXT = 'the sleeve clips through the arm when waving'
    const report = (u: TestUser, id: string, n: number) =>
      app.inject({ method: 'POST', url: `/api/studio/designs/${id}/pieces/hat/revisions/${n}/report`, headers: as(u), payload: { text: TEXT } })
    const review = (id: string, action: 'approve' | 'decline') =>
      app.inject({ method: 'POST', url: `/api/admin/studio/reports/${id}/${action}`, headers: as(admin) })
    /** A hat finalized once, then `paidRevisions` paid revisions (numbers 2, 3, ...). */
    async function revisions(u: TestUser, paidRevisions: number) {
      const d = await createDesign(u)
      await entitle(d, await addRevision(d, 'hat'))
      for (let i = 0; i < paidRevisions; i++) await entitle(d, await addRevision(d, 'hat'), { amountCents: 1500, paymentIntent: `pi_r${i}` })
      return d
    }
    const reportRow = async (status: string) => (await db.select().from(studioMistakeReports)).filter((r) => r.status === status)

    it('the first two reports on a piece refund at once; the third waits and emails the owner', async () => {
      const u = await createUser()
      const d = await revisions(u, 3)
      expect((await report(u, d.id, 2)).json()).toMatchObject({ status: 'refunded' })
      expect((await report(u, d.id, 3)).json()).toMatchObject({ status: 'refunded' })
      const third = await report(u, d.id, 4)
      expect(third.statusCode).toBe(200)
      expect(third.json()).toEqual({ status: 'in_review' })
      expect(stripe.calls.refunds).toHaveLength(2)
      expect(await reportRow('in_review')).toHaveLength(1)
      expect(mail).toHaveLength(1)
      expect(mail[0].html).toContain(TEXT)
      expect(mail[0].html).toContain('/admin/studio')
    })

    it('at checkout the third report is charged and held', async () => {
      const u = await createUser()
      const d = await revisions(u, 2)
      await report(u, d.id, 2)
      await report(u, d.id, 3)
      await addRevision(d, 'hat')
      const quote = (await app.inject({ method: 'GET', url: `/api/studio/designs/${d.id}/finalize`, headers: as(u) })).json()
      expect(quote.reportsHeld).toEqual(['hat'])
      const res = await app.inject({ method: 'POST', url: `/api/studio/designs/${d.id}/finalize`, headers: as(u), payload: { reports: { hat: TEXT } } })
      expect(res.statusCode).toBe(200)
      expect(res.json().url).toBeTruthy() // charged: a Stripe session, not an instant grant
      const [pay] = (await db.select().from(studioPayments).where(eq(studioPayments.designId, d.id))).filter((p) => p.status === 'pending')
      expect(pay.amountCents).toBe(1500)
      expect(pay.lines[0]).toMatchObject({ waived: false, held: true, reportText: TEXT })
      await paid(pay.id)
      const held = await reportRow('in_review')
      expect(held).toHaveLength(1)
      expect(held[0]).toMatchObject({ refundCents: 1500, text: TEXT })
    })

    it('approving refunds through Stripe once; declining refunds nothing', async () => {
      const u = await createUser()
      const d = await revisions(u, 4)
      for (const n of [2, 3, 4, 5]) await report(u, d.id, n)
      const held = await reportRow('in_review')
      expect(held).toHaveLength(2)
      const list = (await app.inject({ method: 'GET', url: '/api/admin/studio/reports', headers: as(admin) })).json().reports
      expect(list).toHaveLength(2)
      expect(list[0]).toMatchObject({ text: TEXT, refundCents: 1500, piece: { category: 'hat', name: 'Neon hat' }, user: { id: u.id, email: u.email } })
      expect(list[0].revisionNumber).toBeGreaterThan(3)
      const ok = await review(held[0].id, 'approve')
      expect(ok.statusCode).toBe(200)
      expect(ok.json()).toEqual({ status: 'refunded', refundCents: 1500, creditedCents: 0, manaCents: 0 })
      expect(stripe.calls.refunds).toHaveLength(3)
      expect((await review(held[0].id, 'approve')).statusCode).toBe(409)
      expect((await review(held[1].id, 'decline')).statusCode).toBe(204)
      expect(stripe.calls.refunds).toHaveLength(3)
      const rows = await db.select().from(studioMistakeReports)
      expect(rows.find((r) => r.id === held[0].id)).toMatchObject({ status: 'refunded', reviewedBy: admin.id })
      expect(rows.find((r) => r.id === held[1].id)).toMatchObject({ status: 'declined', reviewedBy: admin.id })
      const creator = await createUser()
      expect((await app.inject({ method: 'GET', url: '/api/admin/studio/reports', headers: as(creator) })).statusCode).toBe(403)
    })

    it('an approval that died midway comes back to the list and refunds once', async () => {
      const u = await createUser()
      const d = await revisions(u, 3)
      for (const n of [2, 3, 4]) await report(u, d.id, n)
      const [held] = await reportRow('in_review')
      // Mid-approval: the lock is taken and Stripe already refunded, then the process died
      await db.update(studioMistakeReports).set({ status: 'approving', reviewedAt: new Date() }).where(eq(studioMistakeReports.id, held.id))
      const list = async () => (await app.inject({ method: 'GET', url: '/api/admin/studio/reports', headers: as(admin) })).json().reports
      expect(await list()).toHaveLength(0) // still in flight
      expect((await review(held.id, 'approve')).statusCode).toBe(409)
      await db.update(studioMistakeReports).set({ reviewedAt: new Date(Date.now() - 20 * 60_000) }).where(eq(studioMistakeReports.id, held.id))
      stripe.made.push({ id: 're_earlier', payment_intent: 'pi_r2', amount: 1500, metadata: { virvi_studio_entitlement_id: held.entitlementId } })
      expect((await list()).map((r: { id: string }) => r.id)).toEqual([held.id])
      const ok = await review(held.id, 'approve')
      expect(ok.statusCode).toBe(200)
      expect(stripe.calls.refunds).toHaveLength(2) // the two instant ones; the earlier refund was recorded, not repeated
      expect((await db.select().from(studioMistakeReports).where(eq(studioMistakeReports.id, held.id)))[0]).toMatchObject({ status: 'refunded', stripeRefundId: 're_earlier' })
    })

    it('a declined report doesn’t use up an instant one; an approved one does', async () => {
      ;(config as any).studioFlag = { ...config.studioFlag, instantReports: 0 }
      const u = await createUser()
      const d = await revisions(u, 4)
      await report(u, d.id, 2)
      await review((await reportRow('in_review'))[0].id, 'decline')
      ;(config as any).studioFlag = { ...config.studioFlag, instantReports: 1 }
      expect((await report(u, d.id, 3)).json()).toMatchObject({ status: 'refunded' })
      expect((await report(u, d.id, 4)).json()).toEqual({ status: 'in_review' })
      await review((await reportRow('in_review'))[0].id, 'approve')
      ;(config as any).studioFlag = { ...config.studioFlag, instantReports: 2 }
      expect((await report(u, d.id, 5)).json()).toEqual({ status: 'in_review' }) // the approved one counts
    })
  })
})

describe('studio admin: gift codes', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let admin: TestUser
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
    admin = await createUser({ role: 'admin' })
  })

  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const make = (payload: unknown, by = admin) => app.inject({ method: 'POST', url: '/api/admin/studio/gift-codes', headers: as(by), payload: payload as object })
  const list = (by = admin) => app.inject({ method: 'GET', url: '/api/admin/studio/gift-codes', headers: as(by) })
  const off = (id: string, by = admin) => app.inject({ method: 'POST', url: `/api/admin/studio/gift-codes/${id}/off`, headers: as(by) })
  const body = { prompts: 50, finalizes: 2, maxUses: 5 }

  it('a non-admin gets 403 on all three', async () => {
    const u = await createUser()
    expect((await make(body, u)).statusCode).toBe(403)
    expect((await list(u)).statusCode).toBe(403)
    expect((await off('00000000-0000-4000-8000-000000000000', u)).statusCode).toBe(403)
  })

  it('creates a code and stores only its hash', async () => {
    const res = await make({ ...body, note: 'launch', expiresAt: new Date(Date.now() + 86400000).toISOString() })
    expect(res.statusCode).toBe(201)
    const { id, code } = res.json()
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    const [row] = await db.select().from(studioGiftCodes).where(eq(studioGiftCodes.id, id))
    expect(row.codeHash).toBe(hashGiftCode(code))
    expect(row).toMatchObject({ prompts: 50, finalizes: 2, maxUses: 5, uses: 0, note: 'launch', createdBy: admin.id })
    expect(JSON.stringify(row)).not.toContain(code)
    expect(JSON.stringify(row)).not.toContain(code.replace(/-/g, ''))
  })

  it('refuses bad input with 400 invalid', async () => {
    const bad = [
      { prompts: 0, finalizes: 0, maxUses: 1 },
      { ...body, expiresAt: new Date(Date.now() - 1000).toISOString() },
      { ...body, expiresAt: 'soon' },
      { ...body, prompts: 1001 },
      { ...body, finalizes: 21 },
      { ...body, maxUses: 0 },
      { ...body, prompts: '5' },
      { ...body, prompts: 1.5 },
      { ...body, note: 'x'.repeat(201) },
      { ...body, note: 5 },
    ]
    for (const b of bad) {
      const res = await make(b)
      expect(res.statusCode, JSON.stringify(b)).toBe(400)
      expect(res.json()).toEqual({ error: 'invalid' })
    }
    expect(await db.select().from(studioGiftCodes)).toHaveLength(0)
  })

  it('lists newest first with hint and redemptions', async () => {
    const first = (await make(body)).json()
    const second = (await make({ ...body, note: 'second' })).json()
    const a = await createUser({ email: 'a@test.dev', name: 'Ann' })
    const b = await createUser({ email: 'b@test.dev', name: 'Bob' })
    await db.insert(studioGiftRedemptions).values({ codeId: first.id, userId: b.id, createdAt: new Date('2026-01-02') })
    await db.insert(studioGiftRedemptions).values({ codeId: first.id, userId: a.id, createdAt: new Date('2026-01-01') })
    const { codes } = (await list()).json()
    expect(codes.map((c: any) => c.id)).toEqual([second.id, first.id])
    const c = codes[1]
    expect(c.hint).toBe(first.code.replace(/-/g, '').slice(-4))
    expect(c).toMatchObject({ prompts: 50, finalizes: 2, maxUses: 5, uses: 0, disabledAt: null, expiresAt: null })
    expect(c.redemptions).toEqual([
      { email: 'a@test.dev', name: 'Ann', at: '2026-01-01T00:00:00.000Z' },
      { email: 'b@test.dev', name: 'Bob', at: '2026-01-02T00:00:00.000Z' },
    ])
    expect(codes[0].redemptions).toEqual([])
    expect(JSON.stringify(codes)).not.toContain(first.code)
  })

  it('turns a code off, 404 for an unknown one', async () => {
    const { id } = (await make(body)).json()
    expect((await off(id)).statusCode).toBe(204)
    const [row] = await db.select().from(studioGiftCodes).where(eq(studioGiftCodes.id, id))
    expect(row.disabledAt).toBeInstanceOf(Date)
    expect((await off('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404)
    expect((await off('nope')).statusCode).toBe(404)
  })
})
