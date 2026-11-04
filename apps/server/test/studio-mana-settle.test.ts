import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import {
  studioCreditLedger, studioEntitlements, studioFinalizeCredits, studioJobs, studioManaScan, studioManaTransfers, studioPayments,
} from '../src/db/schema.js'
import { config } from '../src/config.js'
import { setStripe } from '../src/integrations/stripe.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { addCredit, creditBalance, takeCredit } from '../src/studio/credit.js'
import { createFinalizeCheckout, createTopupCheckout, PaymentError } from '../src/studio/payments.js'
import { setManaRateSource } from '../src/studio/mana/rate.js'
import { setManaSaltSource, type ManaQuote } from '../src/studio/mana/quote.js'
import { setPolygon } from '../src/studio/mana/polygon.js'
import { reportManaTx, watchManaTransfers } from '../src/studio/mana/settle.js'
import { sweepStudio } from '../src/studio/sweep.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { createDesign, addRevision, fakeFly, fakePolygon, fakeStripe } from './helpers/studio.js'

const RECIPIENT = '0x01d871870CbBddE934526E17637c0cfEf0b3b38B'
const OTHER = '0x2222222222222222222222222222222222222222'
const MIN = 60_000
const T = new Date('2026-11-04T12:00:00Z')
const at = (ms: number) => new Date(T.getTime() + ms)

describe('settling MANA payments', () => {
  let chain: ReturnType<typeof fakePolygon>
  const prev = { enabled: config.studioEnabled, image: config.studioWorkerImage, recipient: config.studioMana.recipient }
  beforeAll(() => {
    ;(config as any).studioEnabled = true
    ;(config as any).studioWorkerImage = 'registry.fly.io/vlm-studio-worker:test'
  })
  afterAll(() => {
    ;(config as any).studioEnabled = prev.enabled
    ;(config as any).studioWorkerImage = prev.image
    ;(config.studioMana as any).recipient = prev.recipient
    setStripe(null)
    setMachineDeps(null)
    setStudioStore(null)
    setManaRateSource(null)
    setManaSaltSource(null)
    setPolygon(null)
  })
  beforeEach(async () => {
    await resetDb()
    ;(config.studioMana as any).recipient = RECIPIENT
    setManaRateSource(async () => 0.25)
    setManaSaltSource(null)
    setStripe(fakeStripe())
    setMachineDeps({ fly: fakeFly() })
    setStudioStore(memoryStudioStore())
    chain = fakePolygon({ t0: T })
    setPolygon(chain)
  })

  const userOf = (u: TestUser) => ({ id: u.id, email: u.email ?? null })
  const give = (u: TestUser, cents: number) => db.transaction((tx) => addCredit(tx, u.id, cents, 'refund', null, T))
  const paymentOf = async (id: string) => (await db.select().from(studioPayments).where(eq(studioPayments.id, id)))[0]
  const gifts = async (u: TestUser) =>
    (await db.select().from(studioFinalizeCredits).where(eq(studioFinalizeCredits.userId, u.id)))[0]?.balance ?? 0

  async function quoted(opts: { credit?: number; gift?: boolean; now?: Date } = {}) {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    if (opts.gift) {
      await addRevision(d, 'feet')
      await db.insert(studioFinalizeCredits).values({ userId: u.id, balance: 1 })
    }
    if (opts.credit) await give(u, opts.credit)
    const res = await createFinalizeCheckout(d, userOf(u), null, {}, opts.now ?? T, 'mana') as { mana: ManaQuote }
    return { u, d, mana: res.mana }
  }

  /** Mines a payment of the quote at `when` and adds `confirmations` blocks on top. */
  function pay(mana: ManaQuote, when: Date, confirmations = 30, over: Record<string, unknown> = {}) {
    const hash = chain.send({ to: RECIPIENT, amountWei: BigInt(mana.amountWei), at: when, ...over })
    chain.advance(confirmations)
    return hash
  }

  async function refusal(p: Promise<unknown>) {
    try {
      await p
    } catch (err) {
      expect(err).toBeInstanceOf(PaymentError)
      return { status: (err as PaymentError).status, code: (err as PaymentError).code }
    }
    throw new Error('expected a refusal')
  }

  it('grants a confirmed transaction of the exact amount to the recipient', async () => {
    const { u, d, mana } = await quoted()
    const hash = pay(mana, at(MIN))
    expect(await reportManaTx(u.id, mana.paymentId, hash, at(2 * MIN))).toEqual({ status: 'granted' })
    expect(await paymentOf(mana.paymentId)).toMatchObject({ status: 'paid', manaTxHash: hash, refundDueCents: 0 })
    const ents = await db.select().from(studioEntitlements).where(eq(studioEntitlements.designId, d.id))
    expect(ents).toMatchObject([{ method: 'mana', amountCents: 2900, status: 'packaging' }])
    const jobs = await db.select().from(studioJobs).where(and(eq(studioJobs.designId, d.id), eq(studioJobs.type, 'finalize')))
    expect(jobs).toHaveLength(1)
    expect(await db.select().from(studioManaTransfers)).toMatchObject([{ txHash: hash, paymentId: mana.paymentId, status: 'matched' }])
  })

  it('waits for 30 confirmations; the watcher grants it once they are there', async () => {
    const { u, mana } = await quoted()
    const hash = pay(mana, at(MIN), 10)
    expect(await reportManaTx(u.id, mana.paymentId, hash, at(2 * MIN))).toEqual({ status: 'confirming' })
    expect(await paymentOf(mana.paymentId)).toMatchObject({ status: 'pending', manaTxHash: hash })
    expect(await watchManaTransfers(at(2 * MIN))).toEqual({ matched: 0, unmatched: 0 })
    chain.advance(30)
    expect(await watchManaTransfers(at(3 * MIN))).toEqual({ matched: 1, unmatched: 0 })
    expect(await paymentOf(mana.paymentId)).toMatchObject({ status: 'paid', manaTxHash: hash })
    // A later report finds it granted
    expect(await reportManaTx(u.id, mana.paymentId, hash, at(4 * MIN))).toEqual({ status: 'granted' })
  })

  it('refuses a wrong amount, recipient or token, and a reverted transaction', async () => {
    const { u, mana } = await quoted()
    const wei = BigInt(mana.amountWei)
    const short = pay(mana, at(MIN), 30, { amountWei: wei - 1n })
    const over = pay(mana, at(MIN), 30, { amountWei: wei + 1n })
    const elsewhere = pay(mana, at(MIN), 30, { to: OTHER })
    const token = pay(mana, at(MIN), 30, { token: '0x3333333333333333333333333333333333333333' })
    const reverted = pay(mana, at(MIN), 30, { status: 0 })
    for (const h of [short, over, elsewhere, token]) {
      expect(await refusal(reportManaTx(u.id, mana.paymentId, h, at(2 * MIN)))).toEqual({ status: 409, code: 'tx_mismatch' })
    }
    expect(await refusal(reportManaTx(u.id, mana.paymentId, reverted, at(2 * MIN)))).toEqual({ status: 409, code: 'tx_failed' })
    expect(await refusal(reportManaTx(u.id, mana.paymentId, '0x' + 'f'.repeat(64), at(2 * MIN)))).toEqual({ status: 404, code: 'tx_not_found' })
    expect(await paymentOf(mana.paymentId)).toMatchObject({ status: 'pending', manaTxHash: null })
  })

  it("refuses someone else's payment", async () => {
    const { mana } = await quoted()
    const stranger = await createUser()
    const hash = pay(mana, at(MIN))
    expect(await refusal(reportManaTx(stranger.id, mana.paymentId, hash, at(2 * MIN)))).toEqual({ status: 404, code: 'not_found' })
  })

  it('settles a hash once: tx_used for another payment, the same answer again for its own', async () => {
    const a = await quoted()
    const b = await quoted()
    const hash = pay(a.mana, at(MIN))
    expect(await reportManaTx(a.u.id, a.mana.paymentId, hash, at(2 * MIN))).toEqual({ status: 'granted' })
    expect(await refusal(reportManaTx(b.u.id, b.mana.paymentId, hash, at(2 * MIN)))).toEqual({ status: 409, code: 'tx_used' })
    expect(await reportManaTx(a.u.id, a.mana.paymentId, hash, at(3 * MIN))).toEqual({ status: 'granted' })
    expect(await db.select().from(studioEntitlements).where(eq(studioEntitlements.designId, a.d.id))).toHaveLength(1)
    expect(await db.select().from(studioJobs).where(and(eq(studioJobs.designId, a.d.id), eq(studioJobs.type, 'finalize')))).toHaveLength(1)
    expect(await paymentOf(b.mana.paymentId)).toMatchObject({ status: 'pending', manaTxHash: null })
  })

  it('the watcher alone grants a payment nobody reported', async () => {
    const { d, mana } = await quoted()
    const hash = pay(mana, at(MIN))
    expect(await watchManaTransfers(at(2 * MIN))).toEqual({ matched: 1, unmatched: 0 })
    expect(await paymentOf(mana.paymentId)).toMatchObject({ status: 'paid', manaTxHash: hash })
    expect(await db.select().from(studioEntitlements).where(eq(studioEntitlements.designId, d.id))).toMatchObject([{ method: 'mana' }])
    // Scanning the same blocks again records and grants nothing twice
    await db.delete(studioManaScan)
    expect(await watchManaTransfers(at(3 * MIN))).toEqual({ matched: 0, unmatched: 0 })
    expect(await db.select().from(studioManaTransfers)).toHaveLength(1)
  })

  it('the watcher grants a MANA top-up', async () => {
    const u = await createUser()
    const { mana } = await createTopupCheckout(userOf(u), 1, T, 'mana') as { mana: ManaQuote }
    pay(mana, at(MIN))
    expect(await watchManaTransfers(at(2 * MIN))).toEqual({ matched: 1, unmatched: 0 })
    expect(await paymentOf(mana.paymentId)).toMatchObject({ status: 'paid' })
  })

  it('settles a transfer mined 5 minutes late after the sweep expired it, holding its gifts and credit again', async () => {
    const { u, d, mana } = await quoted({ credit: 1000, gift: true })
    const expiresAt = new Date(mana.expiresAt).getTime()
    expect(await gifts(u)).toBe(0)
    await sweepStudio(new Date(expiresAt + 16 * MIN))
    expect(await paymentOf(mana.paymentId)).toMatchObject({ status: 'expired', creditHeldCents: 0, giftsHeld: 0 })
    expect(await creditBalance(u.id)).toBe(1000)
    expect(await gifts(u)).toBe(1)
    const hash = pay(mana, new Date(expiresAt + 5 * MIN))
    expect(await reportManaTx(u.id, mana.paymentId, hash, new Date(expiresAt + 17 * MIN))).toEqual({ status: 'granted' })
    expect(await paymentOf(mana.paymentId)).toMatchObject({ status: 'paid', creditHeldCents: 1000, giftsHeld: 1, refundDueCents: 0 })
    expect(await creditBalance(u.id)).toBe(0)
    expect(await gifts(u)).toBe(0)
    expect(await db.select().from(studioEntitlements).where(eq(studioEntitlements.designId, d.id))).toHaveLength(2)
    const ledger = await db.select().from(studioCreditLedger).where(eq(studioCreditLedger.refId, mana.paymentId))
    expect(ledger.map((l) => [l.reason, l.deltaCents]).sort()).toEqual([['hold', -1000], ['hold', -1000], ['release', 1000]])
  })

  it('the watcher settles a late-in-grace transfer the sweep expired', async () => {
    const { u, mana } = await quoted({ credit: 1000 })
    const expiresAt = new Date(mana.expiresAt).getTime()
    await sweepStudio(new Date(expiresAt + 16 * MIN))
    pay(mana, new Date(expiresAt + 5 * MIN))
    expect(await watchManaTransfers(new Date(expiresAt + 17 * MIN))).toEqual({ matched: 1, unmatched: 0 })
    expect(await paymentOf(mana.paymentId)).toMatchObject({ status: 'paid', creditHeldCents: 1000 })
    expect(await creditBalance(u.id)).toBe(0)
  })

  it('grants a reopened payment whose credit was spent meanwhile, absorbing the shortfall (R2)', async () => {
    const { u, mana } = await quoted({ credit: 1000 })
    const expiresAt = new Date(mana.expiresAt).getTime()
    await sweepStudio(new Date(expiresAt + 16 * MIN))
    await db.transaction((tx) => takeCredit(tx, u.id, 600, 'spend', null, new Date(expiresAt + 16 * MIN)))
    const hash = pay(mana, new Date(expiresAt + 5 * MIN))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await reportManaTx(u.id, mana.paymentId, hash, new Date(expiresAt + 17 * MIN))).toEqual({ status: 'granted' })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain(mana.paymentId)
      expect(String(warn.mock.calls[0][0])).toContain('600')
    } finally {
      warn.mockRestore()
    }
    expect(await paymentOf(mana.paymentId)).toMatchObject({ status: 'paid', creditHeldCents: 400, refundDueCents: 0 })
    expect(await creditBalance(u.id)).toBe(0)
    await sweepStudio(new Date(expiresAt + 18 * MIN))
    expect(await creditBalance(u.id)).toBe(0)
  })

  it('stores a transfer mined 20 minutes late as unmatched, and refuses it as tx_late', async () => {
    const { u, mana } = await quoted({ credit: 1000 })
    const expiresAt = new Date(mana.expiresAt).getTime()
    await sweepStudio(new Date(expiresAt + 16 * MIN))
    const hash = pay(mana, new Date(expiresAt + 20 * MIN))
    expect(await watchManaTransfers(new Date(expiresAt + 21 * MIN))).toEqual({ matched: 0, unmatched: 1 })
    expect(await db.select().from(studioManaTransfers)).toMatchObject([{ txHash: hash, paymentId: null, status: 'unmatched' }])
    expect(await refusal(reportManaTx(u.id, mana.paymentId, hash, new Date(expiresAt + 22 * MIN)))).toEqual({ status: 409, code: 'tx_late' })
    expect(await paymentOf(mana.paymentId)).toMatchObject({ status: 'expired', manaTxHash: null })
    expect(await creditBalance(u.id)).toBe(1000)
  })

  it('the sweep expires an unpaid MANA payment after the grace, giving back its credit', async () => {
    const { u, mana } = await quoted({ credit: 1000 })
    const expiresAt = new Date(mana.expiresAt).getTime()
    await sweepStudio(new Date(expiresAt + 14 * MIN))
    expect(await paymentOf(mana.paymentId)).toMatchObject({ status: 'pending' })
    await sweepStudio(new Date(expiresAt + 16 * MIN))
    expect(await paymentOf(mana.paymentId)).toMatchObject({ status: 'expired', creditHeldCents: 0 })
    expect(await creditBalance(u.id)).toBe(1000)
  })

  it('the sweep leaves a reported payment still confirming', async () => {
    const { u, mana } = await quoted({ credit: 1000 })
    const expiresAt = new Date(mana.expiresAt).getTime()
    const hash = pay(mana, at(9 * MIN), 5)
    expect(await reportManaTx(u.id, mana.paymentId, hash, at(9 * MIN))).toEqual({ status: 'confirming' })
    await sweepStudio(new Date(expiresAt + 16 * MIN))
    expect(await paymentOf(mana.paymentId)).toMatchObject({ status: 'pending', creditHeldCents: 1000 })
  })

  it('settles a quote a newer checkout expired early, and credits a second payment of the same design once', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    const first = (await createFinalizeCheckout(d, userOf(u), null, {}, T, 'mana') as { mana: ManaQuote }).mana
    const second = (await createFinalizeCheckout(d, userOf(u), null, {}, at(9 * MIN), 'mana') as { mana: ManaQuote }).mana
    expect(await paymentOf(first.paymentId)).toMatchObject({ status: 'expired' })
    const h1 = pay(first, at(9 * MIN), 0)
    const h2 = pay(second, at(9 * MIN), 30)
    expect(await reportManaTx(u.id, first.paymentId, h1, at(10 * MIN))).toEqual({ status: 'granted' })
    expect(await reportManaTx(u.id, second.paymentId, h2, at(10 * MIN))).toEqual({ status: 'granted' })
    expect(await db.select().from(studioEntitlements).where(eq(studioEntitlements.designId, d.id))).toMatchObject([{ paymentId: first.paymentId }])
    expect(await paymentOf(second.paymentId)).toMatchObject({ status: 'paid', refundDueCents: 0 })
    expect(await creditBalance(u.id)).toBe(2900)
    await sweepStudio(at(40 * MIN))
    expect(await watchManaTransfers(at(41 * MIN))).toEqual({ matched: 0, unmatched: 0 })
    expect(await creditBalance(u.id)).toBe(2900)
  })

  it('scans from 2000 blocks back on the first run, then from where it stopped, at most 5000 blocks a call', async () => {
    await watchManaTransfers(T)
    expect(chain.calls.transfersTo).toEqual([{ fromBlock: chain.latest - 2000, toBlock: chain.latest - 30 }])
    const stopped = chain.latest - 30
    chain.advance(12_000)
    await watchManaTransfers(T)
    expect(chain.calls.transfersTo[1]).toEqual({ fromBlock: stopped + 1, toBlock: stopped + 5000 })
    const [scan] = await db.select().from(studioManaScan)
    expect(scan.lastBlock).toBe(stopped + 5000)
  })

  it('the sweep logs a watcher failure and carries on', async () => {
    chain.failScan = true
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(sweepStudio(T)).resolves.toBeDefined()
      expect(err.mock.calls.some((c) => String(c[0]).includes('MANA'))).toBe(true)
    } finally {
      err.mockRestore()
    }
  })

  describe('routes', () => {
    let app: Awaited<ReturnType<typeof testApp>>
    beforeEach(async () => { app = await testApp() })
    const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })

    it('reports a transaction and shows the payment for the page to poll', async () => {
      const now = new Date()
      chain = fakePolygon({ t0: now })
      setPolygon(chain)
      const { u, mana } = await quoted({ now })
      const hash = pay(mana, now)
      const bad = await app.inject({ method: 'POST', url: `/api/studio/payments/${mana.paymentId}/mana-tx`, headers: as(u), payload: { txHash: '0x12' } })
      expect(bad.statusCode).toBe(400)
      const stranger = await createUser()
      const theirs = await app.inject({ method: 'POST', url: `/api/studio/payments/${mana.paymentId}/mana-tx`, headers: as(stranger), payload: { txHash: hash } })
      expect(theirs.statusCode).toBe(404)
      const res = await app.inject({ method: 'POST', url: `/api/studio/payments/${mana.paymentId}/mana-tx`, headers: as(u), payload: { txHash: hash } })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ status: 'granted' })
      const got = await app.inject({ method: 'GET', url: `/api/studio/payments/${mana.paymentId}`, headers: as(u) })
      expect(got.statusCode).toBe(200)
      expect(got.json()).toEqual({ status: 'paid', method: 'mana', expiresAt: mana.expiresAt, manaTxHash: hash })
      expect((await app.inject({ method: 'GET', url: `/api/studio/payments/${mana.paymentId}`, headers: as(stranger) })).statusCode).toBe(404)
      expect((await app.inject({ method: 'GET', url: `/api/studio/payments/${mana.paymentId}` })).statusCode).toBe(401)
    })

    it('answers a refusal with its code', async () => {
      const now = new Date()
      chain = fakePolygon({ t0: now })
      setPolygon(chain)
      const { u, mana } = await quoted({ now })
      const hash = pay(mana, now, 30, { amountWei: 1n })
      const res = await app.inject({ method: 'POST', url: `/api/studio/payments/${mana.paymentId}/mana-tx`, headers: as(u), payload: { txHash: hash } })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'tx_mismatch' })
    })
  })
})
