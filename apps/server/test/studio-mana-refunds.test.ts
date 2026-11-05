import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioCreditLedger, studioEntitlements, studioManaRefunds, studioManaTransfers, studioMistakeReports, studioPayments, users } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { setStripe } from '../src/integrations/stripe.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { setFlagMailer } from '../src/studio/scope.js'
import { addCredit, creditBalance, takeCredit } from '../src/studio/credit.js'
import { createFinalizeCheckout } from '../src/studio/payments.js'
import { setManaRateSource } from '../src/studio/mana/rate.js'
import { manaWeiAtLeast, setManaSaltSource, type ManaQuote } from '../src/studio/mana/quote.js'
import { setPolygon } from '../src/studio/mana/polygon.js'
import { watchManaTransfers } from '../src/studio/mana/settle.js'
import { sweepStudio } from '../src/studio/sweep.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, randomWallet, tokenFor, type TestUser } from './helpers/factories.js'
import { createDesign, addRevision, entitle, fakeFly, fakePolygon, fakeStripe } from './helpers/studio.js'

const RECIPIENT = '0x01d871870CbBddE934526E17637c0cfEf0b3b38B'
const OTHER = '0x2222222222222222222222222222222222222222'
const TEXT = 'the sleeve clips through the arm when waving'
const MIN = 60_000
const E18 = 10n ** 18n

describe('MANA back on request, and the owner\'s MANA admin', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let chain: ReturnType<typeof fakePolygon>
  let admin: TestUser
  let rate: number
  const prev = {
    enabled: config.studioEnabled, key: config.stripeSecretKey, billing: config.billingEnabled,
    image: config.studioWorkerImage, flag: { ...config.studioFlag }, recipient: config.studioMana.recipient,
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
    ;(config.studioMana as any).recipient = prev.recipient
    setFlagMailer(null)
    setStripe(null)
    setMachineDeps(null)
    setStudioStore(null)
    setManaRateSource(null)
    setManaSaltSource(null)
    setPolygon(null)
  })
  beforeEach(async () => {
    await resetDb()
    ;(config as any).studioFlag = { ...prev.flag, email: 'owner@virvi.test', instantReports: 2 }
    ;(config.studioMana as any).recipient = RECIPIENT
    rate = 0.5
    setManaRateSource(async () => rate)
    setStripe(fakeStripe())
    setMachineDeps({ fly: fakeFly() })
    setStudioStore(memoryStudioStore())
    chain = fakePolygon({ t0: new Date() })
    setPolygon(chain)
    app = await testApp()
    admin = await createUser({ role: 'admin' })
  })

  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const ask = (u: TestUser, reportId: string) =>
    app.inject({ method: 'POST', url: '/api/studio/mana-refunds', headers: as(u), payload: { reportId } })
  const adminGet = (url: string, by = admin) => app.inject({ method: 'GET', url, headers: as(by) })
  const adminPost = (url: string, payload: Record<string, unknown> = {}, by = admin) =>
    app.inject({ method: 'POST', url, headers: as(by), payload })

  /** A hat whose revision 2 was paid as given, then reported as a mistake and refunded (Task 4's route). */
  async function refunded(u: TestUser, method: 'card' | 'mana' = 'mana') {
    const d = await createDesign(u)
    await entitle(d, await addRevision(d, 'hat'))
    const { entitlement, payment } = await entitle(d, await addRevision(d, 'hat'), { amountCents: 1500, paymentIntent: 'pi_rev' })
    await db.update(studioEntitlements).set({ method }).where(eq(studioEntitlements.id, entitlement.id))
    if (method === 'mana') await db.update(studioPayments).set({ method, stripePaymentIntent: null }).where(eq(studioPayments.id, payment.id))
    const res = await app.inject({
      method: 'POST', url: `/api/studio/designs/${d.id}/pieces/hat/revisions/2/report`, headers: as(u), payload: { text: TEXT },
    })
    expect(res.json()).toMatchObject({ status: 'refunded' })
    const [r] = await db.select().from(studioMistakeReports).where(eq(studioMistakeReports.entitlementId, entitlement.id))
    return Object.assign(r, { designId: d.id })
  }

  /** A customer with a verified wallet, a refunded MANA report of 1500 cents, and a request for it. */
  async function requested() {
    const u = await createUser({ wallet: randomWallet() })
    const r = await refunded(u)
    const res = await ask(u, r.id)
    expect(res.statusCode).toBe(201)
    return { u, r, id: res.json().id as string }
  }

  describe('the customer', () => {
    it('turns a refunded MANA report into a request, taking its credit', async () => {
      const u = await createUser({ wallet: randomWallet() })
      const r = await refunded(u)
      expect(r).toMatchObject({ manaCents: 1500, creditedCents: 1500 })
      expect(await creditBalance(u.id)).toBe(1500)
      const res = await ask(u, r.id)
      expect(res.statusCode).toBe(201)
      expect(res.json()).toEqual({ id: expect.any(String), status: 'requested', usdCents: 1500 })
      expect(await creditBalance(u.id)).toBe(0)
      const [row] = await db.select().from(studioManaRefunds)
      expect(row).toMatchObject({ userId: u.id, reportId: r.id, usdCents: 1500, status: 'requested', txHash: null })
      expect(row.toAddress.toLowerCase()).toBe(u.wallet)
      const ledger = await db.select().from(studioCreditLedger).where(eq(studioCreditLedger.reason, 'mana_refund_request'))
      expect(ledger).toMatchObject([{ userId: u.id, deltaCents: -1500, refId: r.id }])
    })

    it("the design's paid revisions name a refunded report's id, its MANA share and any MANA-back request", async () => {
      const u = await createUser({ wallet: randomWallet() })
      const r = await refunded(u)
      const piece = async () => (await app.inject({ method: 'GET', url: `/api/studio/designs/${r.designId}`, headers: as(u) })).json()
        .pieces.find((p: any) => p.category === 'hat').finalized.find((f: any) => f.revision === 2)
      expect((await piece()).report).toMatchObject({ id: r.id, status: 'refunded', manaCents: 1500, creditedCents: 1500, manaRefund: null })
      expect((await ask(u, r.id)).statusCode).toBe(201)
      expect((await piece()).report.manaRefund).toBe('requested')
    })

    it('refuses with credit_spent when the credit was spent, taking nothing (Review Focus 5)', async () => {
      const u = await createUser({ wallet: randomWallet() })
      const r = await refunded(u)
      await db.transaction((tx) => takeCredit(tx, u.id, 1100, 'spend', null, new Date()))
      const res = await ask(u, r.id)
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'credit_spent' })
      expect(await creditBalance(u.id)).toBe(400)
      expect(await db.select().from(studioManaRefunds)).toHaveLength(0)
    })

    it('takes one request per report', async () => {
      const { u, r } = await requested()
      const again = await ask(u, r.id)
      expect(again.statusCode).toBe(409)
      expect(again.json()).toMatchObject({ code: 'already_requested' })
      expect(await db.select().from(studioManaRefunds)).toHaveLength(1)
    })

    it('two requests at once for the same report make one', async () => {
      const u = await createUser({ wallet: randomWallet() })
      const r = await refunded(u)
      const both = await Promise.all([ask(u, r.id), ask(u, r.id)])
      expect(both.map((x) => x.statusCode).sort()).toEqual([201, 409])
      expect(await db.select().from(studioManaRefunds)).toHaveLength(1)
      expect(await creditBalance(u.id)).toBe(0)
    })

    it('refuses a card-paid report with not_mana', async () => {
      const u = await createUser({ wallet: randomWallet() })
      const r = await refunded(u, 'card')
      expect(r.manaCents).toBe(0)
      const res = await ask(u, r.id)
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'not_mana' })
    })

    it('refuses an account with no verified wallet with no_wallet, taking nothing', async () => {
      const u = await createUser()
      const r = await refunded(u)
      const res = await ask(u, r.id)
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'no_wallet' })
      expect(await creditBalance(u.id)).toBe(1500)
    })

    it("refuses someone else's report, a bad id and no sign-in", async () => {
      const u = await createUser({ wallet: randomWallet() })
      const r = await refunded(u)
      const stranger = await createUser({ wallet: randomWallet() })
      expect((await ask(stranger, r.id)).statusCode).toBe(404)
      expect((await ask(u, 'nope')).statusCode).toBe(400)
      expect((await app.inject({ method: 'POST', url: '/api/studio/mana-refunds', payload: { reportId: r.id } })).statusCode).toBe(401)
      expect(await creditBalance(u.id)).toBe(1500)
    })
  })

  describe('the owner', () => {
    it('lists requests with the user and their wallet', async () => {
      const { u, id } = await requested()
      const res = await adminGet('/api/admin/studio/mana-refunds?status=requested')
      expect(res.statusCode).toBe(200)
      expect(res.json().refunds).toEqual([{
        id, user: { id: u.id, email: u.email, wallet: u.wallet }, usdCents: 1500, toAddress: expect.any(String), createdAt: expect.any(String),
      }])
      expect((await adminGet('/api/admin/studio/mana-refunds?status=sent')).json().refunds).toEqual([])
    })

    it('quotes the MANA to send at the current rate, rounded up, with no salt', async () => {
      const { u, id } = await requested()
      const res = await adminGet(`/api/admin/studio/mana-refunds/${id}/quote`)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ amountWei: (30n * E18).toString(), token: config.studioMana.token, chainId: 137, to: expect.any(String), usdPerMana: 0.5 })
      expect(res.json().to.toLowerCase()).toBe(u.wallet)
      expect(manaWeiAtLeast(1, 3)).toBe(3334n * 10n ** 12n)
    })

    it('answers rate_unavailable with no rate', async () => {
      const { id } = await requested()
      setManaRateSource(async () => { throw new Error('down') })
      const err = console.error
      console.error = () => {}
      try {
        const res = await adminGet(`/api/admin/studio/mana-refunds/${id}/quote`)
        expect(res.statusCode).toBe(503)
        expect(res.json()).toMatchObject({ code: 'rate_unavailable' })
      } finally {
        console.error = err
      }
    })

    it('records a matching send, and refuses one to the wrong address or of another amount', async () => {
      const { u, id } = await requested()
      const wei = 30n * E18
      const wrongTo = chain.send({ to: OTHER, amountWei: wei })
      const wrongAmount = chain.send({ to: u.wallet!, amountWei: wei - 1n })
      const reverted = chain.send({ to: u.wallet!, amountWei: wei, status: 0 })
      const good = chain.send({ to: u.wallet!, amountWei: wei })
      for (const h of [wrongTo, wrongAmount]) {
        const res = await adminPost(`/api/admin/studio/mana-refunds/${id}/sent`, { txHash: h, amountWei: wei.toString() })
        expect(res.statusCode).toBe(409)
        expect(res.json()).toMatchObject({ code: 'tx_mismatch' })
      }
      const failed = await adminPost(`/api/admin/studio/mana-refunds/${id}/sent`, { txHash: reverted, amountWei: wei.toString() })
      expect(failed.json()).toMatchObject({ code: 'tx_failed' })
      const missing = await adminPost(`/api/admin/studio/mana-refunds/${id}/sent`, { txHash: '0x' + 'f'.repeat(64), amountWei: wei.toString() })
      expect(missing.statusCode).toBe(404)
      const bad = await adminPost(`/api/admin/studio/mana-refunds/${id}/sent`, { txHash: '0x12', amountWei: wei.toString() })
      expect(bad.statusCode).toBe(400)
      expect((await db.select().from(studioManaRefunds))[0]).toMatchObject({ status: 'requested', txHash: null })

      const res = await adminPost(`/api/admin/studio/mana-refunds/${id}/sent`, { txHash: good, amountWei: wei.toString() })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ id, status: 'sent', txHash: good })
      const [row] = await db.select().from(studioManaRefunds)
      expect(row).toMatchObject({ status: 'sent', txHash: good, manaAmountWei: wei.toString(), decidedBy: admin.id })
      expect(row.decidedAt).toBeInstanceOf(Date)
      const again = await adminPost(`/api/admin/studio/mana-refunds/${id}/sent`, { txHash: good, amountWei: wei.toString() })
      expect(again.statusCode).toBe(409)
      expect(again.json()).toMatchObject({ code: 'already_decided' })
      expect(await creditBalance(u.id)).toBe(0)
    })

    it('declining gives the credit back, once', async () => {
      const { u, r, id } = await requested()
      const res = await adminPost(`/api/admin/studio/mana-refunds/${id}/decline`)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ id, status: 'declined' })
      expect(await creditBalance(u.id)).toBe(1500)
      expect((await db.select().from(studioManaRefunds))[0]).toMatchObject({ status: 'declined', decidedBy: admin.id })
      const ledger = await db.select().from(studioCreditLedger).where(eq(studioCreditLedger.reason, 'mana_refund_declined'))
      expect(ledger).toMatchObject([{ userId: u.id, deltaCents: 1500, refId: r.id }])
      const again = await adminPost(`/api/admin/studio/mana-refunds/${id}/decline`)
      expect(again.statusCode).toBe(409)
      expect(again.json()).toMatchObject({ code: 'already_decided' })
      expect(await creditBalance(u.id)).toBe(1500)
      const quote = await adminGet(`/api/admin/studio/mana-refunds/${id}/quote`)
      expect(quote.json()).toMatchObject({ code: 'already_decided' })
    })

    it('a declined request leaves the report closed to a second request', async () => {
      const { u, r, id } = await requested()
      await adminPost(`/api/admin/studio/mana-refunds/${id}/decline`)
      const again = await ask(u, r.id)
      expect(again.json()).toMatchObject({ code: 'already_requested' })
      expect(await creditBalance(u.id)).toBe(1500)
    })

    it('unknown requests are 404', async () => {
      const none = '00000000-0000-4000-8000-000000000000'
      expect((await adminGet(`/api/admin/studio/mana-refunds/${none}/quote`)).statusCode).toBe(404)
      expect((await adminPost(`/api/admin/studio/mana-refunds/${none}/decline`)).statusCode).toBe(404)
      expect((await adminPost(`/api/admin/studio/mana-refunds/nope/sent`, { txHash: '0x' + 'a'.repeat(64), amountWei: '1' })).statusCode).toBe(404)
    })
  })

  describe("payments that didn't match", () => {
    const T = new Date('2026-11-04T12:00:00Z')

    /** A MANA finalize quote of 2900 cents whose transfer arrives 20 minutes after its grace: unmatched. */
    async function unmatched(credit = 0) {
      chain = fakePolygon({ t0: T })
      setPolygon(chain)
      rate = 0.25
      const u = await createUser()
      const d = await createDesign(u)
      await addRevision(d, 'hat')
      if (credit) await db.transaction((tx) => addCredit(tx, u.id, credit, 'refund', null, T))
      const { mana } = await createFinalizeCheckout(d, { id: u.id, email: u.email ?? null }, null, {}, T, 'mana') as { mana: ManaQuote }
      const expiresAt = new Date(mana.expiresAt).getTime()
      await sweepStudio(new Date(expiresAt + 16 * MIN))
      const hash = chain.send({ to: RECIPIENT, amountWei: BigInt(mana.amountWei), at: new Date(expiresAt + 20 * MIN) })
      chain.advance(30)
      expect(await watchManaTransfers(new Date(expiresAt + 21 * MIN))).toEqual({ matched: 0, unmatched: 1 })
      await db.update(studioManaTransfers).set({ createdAt: new Date(expiresAt + 21 * MIN) })
      return { u, d, mana, hash }
    }

    it('lists unmatched transfers with the MANA payments near them', async () => {
      const { u, mana, hash } = await unmatched()
      // Far off in amount: not a candidate
      const far = await createUser()
      const fd = await createDesign(far)
      await addRevision(fd, 'hat')
      setManaRateSource(async () => 0.1) // drops the cached rate
      await createFinalizeCheckout(fd, { id: far.id, email: far.email ?? null }, null, {}, T, 'mana')
      // Payments take their created_at from the database clock; pin them to the test's clock so "near in time" holds on any day
      await db.update(studioPayments).set({ createdAt: T })
      const res = await adminGet('/api/admin/studio/mana-transfers?status=unmatched')
      expect(res.statusCode).toBe(200)
      const [t] = res.json().transfers
      expect(t).toMatchObject({ txHash: hash, logIndex: 0, amountWei: mana.amountWei, status: 'unmatched' })
      expect(t.candidates).toEqual([expect.objectContaining({
        id: mana.paymentId, user: { id: u.id, email: u.email }, amountCents: 2900, manaAmountWei: mana.amountWei, status: 'expired',
      })])
    })

    it('settles an unmatched transfer by hand against an expired payment, holding its credit again and granting it', async () => {
      const { u, d, mana, hash } = await unmatched(1000)
      expect(await creditBalance(u.id)).toBe(1000)
      const res = await adminPost(`/api/admin/studio/mana-transfers/${hash}/0/settle`, { paymentId: mana.paymentId })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ status: 'settled_by_hand', paymentId: mana.paymentId })
      const [pay] = await db.select().from(studioPayments).where(eq(studioPayments.id, mana.paymentId))
      expect(pay).toMatchObject({ status: 'paid', manaTxHash: hash, creditHeldCents: 1000, refundDueCents: 0 })
      expect(await creditBalance(u.id)).toBe(0)
      expect(await db.select().from(studioEntitlements).where(eq(studioEntitlements.designId, d.id))).toMatchObject([{ method: 'mana' }])
      const [t] = await db.select().from(studioManaTransfers)
      expect(t).toMatchObject({ status: 'settled_by_hand', paymentId: mana.paymentId })
      expect(t.note).toContain(admin.id)
      // A paid payment, or a transfer no longer unmatched, is refused
      const again = await adminPost(`/api/admin/studio/mana-transfers/${hash}/0/settle`, { paymentId: mana.paymentId })
      expect(again.statusCode).toBe(409)
      expect(again.json()).toMatchObject({ code: 'not_unmatched' })
    })

    it('refuses to settle against a paid payment', async () => {
      const { mana, hash } = await unmatched()
      await db.update(studioPayments).set({ status: 'paid' }).where(eq(studioPayments.id, mana.paymentId))
      const res = await adminPost(`/api/admin/studio/mana-transfers/${hash}/0/settle`, { paymentId: mana.paymentId })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'already_paid' })
      expect((await db.select().from(studioManaTransfers))[0]).toMatchObject({ status: 'unmatched', paymentId: null })
    })

    it('marks a transfer returned', async () => {
      const { hash } = await unmatched()
      const back = '0x' + 'b'.repeat(64)
      const bad = await adminPost(`/api/admin/studio/mana-transfers/${hash}/0/returned`, { returnTxHash: 'x' })
      expect(bad.statusCode).toBe(400)
      const res = await adminPost(`/api/admin/studio/mana-transfers/${hash}/0/returned`, { returnTxHash: back })
      expect(res.statusCode).toBe(200)
      const [t] = await db.select().from(studioManaTransfers)
      expect(t.status).toBe('returned')
      expect(t.note).toContain(back)
      const again = await adminPost(`/api/admin/studio/mana-transfers/${hash}/0/returned`, { returnTxHash: back })
      expect(again.json()).toMatchObject({ code: 'not_unmatched' })
      expect((await adminPost(`/api/admin/studio/mana-transfers/${'0x' + 'c'.repeat(64)}/0/returned`, { returnTxHash: back })).statusCode).toBe(404)
    })
  })

  it('deleting an account that paid in MANA and asked for MANA back keeps the transfer, unlinked', async () => {
    const { u, r } = await requested()
    const [e] = await db.select().from(studioEntitlements).where(eq(studioEntitlements.id, r.entitlementId))
    const hash = '0x' + 'd'.repeat(64)
    await db.insert(studioManaTransfers).values({
      txHash: hash, logIndex: 0, fromAddress: OTHER, amountWei: '1', blockNumber: 1, paymentId: e.paymentId, status: 'matched',
    })
    await db.delete(users).where(eq(users.id, u.id))
    expect(await db.select().from(studioManaTransfers)).toMatchObject([{ txHash: hash, paymentId: null, status: 'matched' }])
    expect(await db.select().from(studioPayments).where(eq(studioPayments.id, e.paymentId))).toEqual([])
  })

  it('deleting a report (with its payment) leaves its MANA-back request, unlinked', async () => {
    const { r, id } = await requested()
    await db.delete(studioMistakeReports).where(eq(studioMistakeReports.id, r.id))
    expect(await db.select().from(studioManaRefunds).where(eq(studioManaRefunds.id, id))).toMatchObject([{ reportId: null, status: 'requested' }])
  })

  it('non-admins get 403 on every admin route', async () => {
    const someone = await createUser({ wallet: randomWallet() })
    const id = '00000000-0000-4000-8000-000000000000'
    const hash = '0x' + 'a'.repeat(64)
    const routes: [string, string][] = [
      ['GET', '/api/admin/studio/mana-refunds?status=requested'],
      ['GET', `/api/admin/studio/mana-refunds/${id}/quote`],
      ['POST', `/api/admin/studio/mana-refunds/${id}/sent`],
      ['POST', `/api/admin/studio/mana-refunds/${id}/decline`],
      ['GET', '/api/admin/studio/mana-transfers?status=unmatched'],
      ['POST', `/api/admin/studio/mana-transfers/${hash}/0/settle`],
      ['POST', `/api/admin/studio/mana-transfers/${hash}/0/returned`],
    ]
    for (const [method, url] of routes) {
      const res = await app.inject({ method: method as 'GET', url, headers: as(someone), payload: method === 'POST' ? {} : undefined })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
    }
  })
})
