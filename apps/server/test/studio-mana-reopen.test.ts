import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioCreditLedger, studioEntitlements, studioFinalizeCredits, studioPayments } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { setStripe } from '../src/integrations/stripe.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { setFlagMailer } from '../src/studio/scope.js'
import { addCredit, creditBalance, takeCredit } from '../src/studio/credit.js'
import { createFinalizeCheckout, createTopupCheckout, grantPayment, reportMistake, type CheckoutResult } from '../src/studio/payments.js'
import { setManaRateSource } from '../src/studio/mana/rate.js'
import { setManaSaltSource, type ManaQuote } from '../src/studio/mana/quote.js'
import { setPolygon } from '../src/studio/mana/polygon.js'
import { reportManaTx, settleTransferByHand, watchManaTransfers } from '../src/studio/mana/settle.js'
import { sweepStudio } from '../src/studio/sweep.js'
import { resetDb } from './helpers/db.js'
import { createUser, randomWallet, type TestUser } from './helpers/factories.js'
import { linkVerifiedWallet } from '../src/auth/wallet-users.js'
import { users } from '../src/db/schema.js'
import { createDesign, addRevision, entitle, fakeFly, fakePolygon, fakeStripe } from './helpers/studio.js'

/**
 * Ruling R9: a MANA payment reopened late in its grace takes over the holds of the customer's newer open checkouts
 * (so a discount can't be had twice), and its lines are re-allocated to the credit and free finalizes it really holds
 * again, so a grant or a later refund never pays back cents that weren't held.
 */

const RECIPIENT = '0x01d871870CbBddE934526E17637c0cfEf0b3b38B'
const MIN = 60_000
const T = new Date('2026-11-04T12:00:00Z')
const at = (ms: number) => new Date(T.getTime() + ms)

describe('reopening a MANA payment late in its grace (R9)', () => {
  let chain: ReturnType<typeof fakePolygon>
  let stripe: ReturnType<typeof fakeStripe>
  const prev = { enabled: config.studioEnabled, image: config.studioWorkerImage, recipient: config.studioMana.recipient, flag: { ...config.studioFlag } }
  beforeAll(() => {
    ;(config as any).studioEnabled = true
    ;(config as any).studioWorkerImage = 'registry.fly.io/vlm-studio-worker:test'
    setFlagMailer(async () => true)
  })
  afterAll(() => {
    ;(config as any).studioEnabled = prev.enabled
    ;(config as any).studioWorkerImage = prev.image
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
    setManaRateSource(async () => 0.25)
    setManaSaltSource(null)
    stripe = fakeStripe()
    setStripe(stripe)
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
  const entitlementsOf = (designId: string) => db.select().from(studioEntitlements).where(eq(studioEntitlements.designId, designId))
  /** Credit is conserved: the user's ledger adds up to their balance. */
  async function ledgerMatches(u: TestUser) {
    const [{ n }] = await db.select({ n: sql<number>`coalesce(sum(${studioCreditLedger.deltaCents}), 0)::int` })
      .from(studioCreditLedger).where(eq(studioCreditLedger.userId, u.id))
    expect(n).toBe(await creditBalance(u.id))
  }
  const manaOf = (r: CheckoutResult) => (r as { mana: ManaQuote }).mana
  const sessionOf = async (id: string) => (await paymentOf(id)).stripeSessionId!
  /** The newest payment of a user other than `not`. */
  async function newest(u: TestUser, not: string) {
    const rows = await db.select().from(studioPayments).where(eq(studioPayments.userId, u.id))
    return rows.filter((p) => p.id !== not).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
  }

  function pay(mana: ManaQuote, when: Date, confirmations = 30) {
    const hash = chain.send({ to: RECIPIENT, amountWei: BigInt(mana.amountWei), at: when })
    chain.advance(confirmations)
    return hash
  }

  async function hat(credit: number) {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    if (credit) await give(u, credit)
    return { u, d }
  }

  it('(a) takes the credit back from a newer card checkout, which is expired through Stripe', async () => {
    const { u, d } = await hat(1000)
    const a = manaOf(await createFinalizeCheckout(d, userOf(u), null, {}, T, 'mana'))
    expect(a.usdCents).toBe(1900)
    // The customer opens a card checkout too: it takes the credit, expiring the quote
    const b = await createFinalizeCheckout(d, userOf(u), null, {}, at(9 * MIN), 'card') as { url: string }
    expect(b.url).toBeTruthy()
    const card = await newest(u, a.paymentId)
    expect(await paymentOf(a.paymentId)).toMatchObject({ status: 'expired', creditHeldCents: 0 })
    expect(card).toMatchObject({ status: 'pending', creditHeldCents: 1000 })
    // ...and pays the quote in MANA anyway
    const hash = pay(a, at(9.5 * MIN))
    expect(await reportManaTx(u.id, a.paymentId, hash, at(10 * MIN))).toEqual({ status: 'granted' })
    expect(stripe.calls.expired).toContain(await sessionOf(card.id))
    expect(await paymentOf(card.id)).toMatchObject({ status: 'expired', creditHeldCents: 0 })
    expect(await paymentOf(a.paymentId)).toMatchObject({ status: 'paid', creditHeldCents: 1000, refundDueCents: 0 })
    expect(await entitlementsOf(d.id)).toMatchObject([{ amountCents: 2900, creditCents: 1000, method: 'mana' }])
    // The customer paid 1900 MANA and 1000 credit for 2900: they can't keep the credit too
    expect(await creditBalance(u.id)).toBe(0)
    await sweepStudio(at(60 * MIN))
    expect(await creditBalance(u.id)).toBe(0)
    await ledgerMatches(u)
  })

  it('(a) takes the credit back from a newer MANA quote ("Get a new price"), in the same transaction', async () => {
    const { u, d } = await hat(1000)
    const a = manaOf(await createFinalizeCheckout(d, userOf(u), null, {}, T, 'mana'))
    const b = manaOf(await createFinalizeCheckout(d, userOf(u), null, {}, at(9 * MIN), 'mana'))
    expect(b.paymentId).not.toBe(a.paymentId)
    expect(await paymentOf(b.paymentId)).toMatchObject({ status: 'pending', creditHeldCents: 1000 })
    const hash = pay(a, at(9.5 * MIN))
    expect(await reportManaTx(u.id, a.paymentId, hash, at(10 * MIN))).toEqual({ status: 'granted' })
    expect(await paymentOf(b.paymentId)).toMatchObject({ status: 'expired', creditHeldCents: 0 })
    expect(await paymentOf(a.paymentId)).toMatchObject({ status: 'paid', creditHeldCents: 1000 })
    expect(await creditBalance(u.id)).toBe(0)
    await sweepStudio(at(60 * MIN))
    expect(await creditBalance(u.id)).toBe(0)
    await ledgerMatches(u)
  })

  it('(b) when the newer checkout was paid, the late MANA comes back as credit, and no credit is made from nothing', async () => {
    const { u, d } = await hat(1000)
    const a = manaOf(await createFinalizeCheckout(d, userOf(u), null, {}, T, 'mana'))
    await createFinalizeCheckout(d, userOf(u), null, {}, at(9 * MIN), 'card')
    const card = await newest(u, a.paymentId)
    stripe.completedSessions.add(card.stripeSessionId!)
    expect(await grantPayment(card.id, 'pi_card', at(9.2 * MIN))).toBe('granted')
    const hash = pay(a, at(9.5 * MIN))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await reportManaTx(u.id, a.paymentId, hash, at(10 * MIN))).toEqual({ status: 'granted' })
    } finally {
      warn.mockRestore()
    }
    expect(await paymentOf(a.paymentId)).toMatchObject({ status: 'paid', creditHeldCents: 0, refundDueCents: 0 })
    expect(await entitlementsOf(d.id)).toMatchObject([{ paymentId: card.id, creditCents: 1000 }])
    // The quote's 1900 MANA paid for nothing comes back as credit; its 1000 of credit was never held again
    expect(await creditBalance(u.id)).toBe(1900)
    await ledgerMatches(u)
  })

  it('takes a free finalize back from a newer checkout', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    await addRevision(d, 'feet')
    await db.insert(studioFinalizeCredits).values({ userId: u.id, balance: 1 })
    const a = manaOf(await createFinalizeCheckout(d, userOf(u), null, {}, T, 'mana'))
    expect(await paymentOf(a.paymentId)).toMatchObject({ giftsHeld: 1 })
    await createFinalizeCheckout(d, userOf(u), null, {}, at(9 * MIN), 'card')
    const card = await newest(u, a.paymentId)
    expect(card).toMatchObject({ status: 'pending', giftsHeld: 1 })
    const hash = pay(a, at(9.5 * MIN))
    expect(await reportManaTx(u.id, a.paymentId, hash, at(10 * MIN))).toEqual({ status: 'granted' })
    expect(await paymentOf(card.id)).toMatchObject({ status: 'expired', giftsHeld: 0 })
    expect(await paymentOf(a.paymentId)).toMatchObject({ status: 'paid', giftsHeld: 1 })
    expect(await gifts(u)).toBe(0)
    await sweepStudio(at(60 * MIN))
    expect(await gifts(u)).toBe(0)
  })

  it('drops the gift from a line whose free finalize was spent meanwhile, absorbing it, and never gives it back', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    await addRevision(d, 'feet')
    await db.insert(studioFinalizeCredits).values({ userId: u.id, balance: 1 })
    const a = manaOf(await createFinalizeCheckout(d, userOf(u), null, {}, T, 'mana'))
    const quoted = await paymentOf(a.paymentId)
    const giftLine = quoted.lines.find((l) => l.gift)!
    const expiresAt = new Date(a.expiresAt).getTime()
    await sweepStudio(new Date(expiresAt + 16 * MIN))
    expect(await gifts(u)).toBe(1)
    // Spent on another design meanwhile
    await db.update(studioFinalizeCredits).set({ balance: 0 }).where(eq(studioFinalizeCredits.userId, u.id))
    const hash = pay(a, new Date(expiresAt + 5 * MIN))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await reportManaTx(u.id, a.paymentId, hash, new Date(expiresAt + 17 * MIN))).toEqual({ status: 'granted' })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain(a.paymentId)
    } finally {
      warn.mockRestore()
    }
    const paid = await paymentOf(a.paymentId)
    expect(paid).toMatchObject({ status: 'paid', giftsHeld: 0, refundDueCents: 0 })
    expect(paid.lines.some((l) => l.gift)).toBe(false)
    const ents = await entitlementsOf(d.id)
    // The line the gift paid is recorded as paid nothing: the owner absorbed it
    expect(ents.find((e) => e.category === giftLine.category)).toMatchObject({ amountCents: 0, creditCents: 0 })
    expect(await gifts(u)).toBe(0)
    expect(await creditBalance(u.id)).toBe(0)
  })

  it('(c) a later mistake refund pays back only the credit really held again', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await entitle(d, await addRevision(d, 'hat'))
    await addRevision(d, 'hat')
    await give(u, 1000)
    const a = manaOf(await createFinalizeCheckout(d, userOf(u), null, {}, T, 'mana'))
    expect(a.usdCents).toBe(500) // a 1500 revision, 1000 of it credit
    const expiresAt = new Date(a.expiresAt).getTime()
    await sweepStudio(new Date(expiresAt + 16 * MIN))
    await db.transaction((tx) => takeCredit(tx, u.id, 600, 'spend', null, new Date(expiresAt + 16 * MIN)))
    const hash = pay(a, new Date(expiresAt + 5 * MIN))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await reportManaTx(u.id, a.paymentId, hash, new Date(expiresAt + 17 * MIN))).toEqual({ status: 'granted' })
    } finally {
      warn.mockRestore()
    }
    expect(await creditBalance(u.id)).toBe(0)
    const ent = (await entitlementsOf(d.id)).find((e) => e.paymentId === a.paymentId)!
    // Paid 500 MANA and 400 credit: the other 600 the owner absorbed
    expect(ent).toMatchObject({ amountCents: 900, creditCents: 400, method: 'mana' })
    const res = await reportMistake(d, 'hat', 2, 'the brim clips', new Date(expiresAt + 30 * MIN))
    expect(res).toMatchObject({ status: 'refunded', creditedCents: 900, manaCents: 500 })
    expect(await creditBalance(u.id)).toBe(900)
    await ledgerMatches(u)
  })

  it('a MANA top-up takes its credit back from a newer top-up', async () => {
    const u = await createUser()
    await give(u, 100)
    const a = manaOf(await createTopupCheckout(userOf(u), 1, T, 'mana'))
    expect(a.usdCents).toBe(400)
    await createTopupCheckout(userOf(u), 1, at(9 * MIN), 'card')
    const card = await newest(u, a.paymentId)
    expect(card).toMatchObject({ status: 'pending', creditHeldCents: 100 })
    const hash = pay(a, at(9.5 * MIN))
    expect(await reportManaTx(u.id, a.paymentId, hash, at(10 * MIN))).toEqual({ status: 'granted' })
    expect(await paymentOf(card.id)).toMatchObject({ status: 'expired', creditHeldCents: 0 })
    expect(await paymentOf(a.paymentId)).toMatchObject({ status: 'paid', creditHeldCents: 100 })
    expect(await creditBalance(u.id)).toBe(0)
    await ledgerMatches(u)
  })

  it('settling by hand re-allocates a reopened payment to the credit really held (R2 shortfall)', async () => {
    const { u, d } = await hat(1000)
    const a = manaOf(await createFinalizeCheckout(d, userOf(u), null, {}, T, 'mana'))
    const expiresAt = new Date(a.expiresAt).getTime()
    await sweepStudio(new Date(expiresAt + 16 * MIN))
    await db.transaction((tx) => takeCredit(tx, u.id, 600, 'spend', null, new Date(expiresAt + 16 * MIN)))
    const hash = chain.send({ to: RECIPIENT, amountWei: BigInt(a.amountWei), at: new Date(expiresAt + 20 * MIN) })
    chain.advance(30)
    expect(await watchManaTransfers(new Date(expiresAt + 21 * MIN))).toEqual({ matched: 0, unmatched: 1 })
    const admin = await createUser({ role: 'admin' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await settleTransferByHand(hash, 0, a.paymentId, admin.id, null, new Date(expiresAt + 22 * MIN))
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain(a.paymentId)
      expect(String(warn.mock.calls[0][0])).toContain('600')
    } finally {
      warn.mockRestore()
    }
    expect(await paymentOf(a.paymentId)).toMatchObject({ status: 'paid', creditHeldCents: 400, refundDueCents: 0 })
    expect(await entitlementsOf(d.id)).toMatchObject([{ amountCents: 2300, creditCents: 400, method: 'mana' }])
    expect(await creditBalance(u.id)).toBe(0)
    await ledgerMatches(u)
  })

  it("a visitor's MANA top-up still finds its credit hold after their wallet joins an account (finding 8)", async () => {
    const w = randomWallet()
    const shell = await createUser({ role: 'viewer', email: null, wallet: w })
    const e = await createUser({ role: 'creator' })
    await give(shell, 100)
    const a = manaOf(await createTopupCheckout(userOf(shell), 1, T, 'mana'))
    const expiresAt = new Date(a.expiresAt).getTime()
    await sweepStudio(new Date(expiresAt + 16 * MIN))
    expect(await creditBalance(shell.id)).toBe(100)
    expect(await linkVerifiedWallet(e.id, w)).toBe('linked')
    expect(await db.select().from(users).where(eq(users.id, shell.id))).toEqual([]) // the shell is gone
    expect(await creditBalance(e.id)).toBe(100)
    await ledgerMatches(e)
    const hash = pay(a, new Date(expiresAt + 5 * MIN))
    expect(await reportManaTx(e.id, a.paymentId, hash, new Date(expiresAt + 17 * MIN))).toEqual({ status: 'granted' })
    expect(await paymentOf(a.paymentId)).toMatchObject({ status: 'paid', userId: e.id, creditHeldCents: 100 })
    expect(await creditBalance(e.id)).toBe(0)
    await ledgerMatches(e)
  })
})

