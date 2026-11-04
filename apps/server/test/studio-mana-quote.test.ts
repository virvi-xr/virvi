import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioPayments } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { setStripe } from '../src/integrations/stripe.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { addCredit, creditBalance } from '../src/studio/credit.js'
import { createFinalizeCheckout } from '../src/studio/payments.js'
import { getManaRate, setManaRateSource } from '../src/studio/mana/rate.js'
import { manaWeiFor, setManaSaltSource } from '../src/studio/mana/quote.js'
import { parseTransfers, TRANSFER_TOPIC } from '../src/studio/mana/polygon.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { createDesign, addRevision, fakeFly, fakeStripe } from './helpers/studio.js'

const RECIPIENT = '0x01d871870CbBddE934526E17637c0cfEf0b3b38B'
const TOKEN = '0xA1c57f48F0Deb89f569dFbE6E2B7f46D33606fD4'
const MANA = 10n ** 18n
const STEP = 10n ** 12n

describe('manaWeiFor', () => {
  it('converts the USD price at the rate and adds the salt', () => {
    expect(manaWeiFor(2900, 0.5, 7n)).toBe(58n * MANA + 7n)
  })

  it('rounds up, never below the USD price, and leaves the low digits to the salt', () => {
    const wei = manaWeiFor(2900, 0.3, 1n)
    // 29 / 0.3 MANA, in wei, rounded down: the quote is at least this
    expect(wei * 3n >= 290n * MANA).toBe(true)
    expect(wei.toString().slice(-12)).toBe('000000000001')
  })

  it('refuses a salt outside 1..10^12-1', () => {
    expect(() => manaWeiFor(2900, 0.5, 0n)).toThrow()
    expect(() => manaWeiFor(2900, 0.5, STEP)).toThrow()
  })
})

describe('getManaRate', () => {
  afterAll(() => setManaRateSource(null))

  it('caches a rate for 60 seconds', async () => {
    let calls = 0
    setManaRateSource(async () => { calls++; return 0.4 })
    const t = new Date('2026-11-04T12:00:00Z')
    expect(await getManaRate(t)).toMatchObject({ usdPerMana: 0.4 })
    await getManaRate(new Date(t.getTime() + 59_000))
    expect(calls).toBe(1)
    await getManaRate(new Date(t.getTime() + 61_000))
    expect(calls).toBe(2)
  })

  it('serves a cached rate while a refresh fails, until it is 5 minutes old', async () => {
    let up = true
    setManaRateSource(async () => { if (!up) throw new Error('down'); return 0.4 })
    const t = new Date('2026-11-04T12:00:00Z')
    await getManaRate(t)
    up = false
    expect(await getManaRate(new Date(t.getTime() + 4 * 60_000))).toMatchObject({ usdPerMana: 0.4 })
    expect(await getManaRate(new Date(t.getTime() + 5 * 60_000 + 1))).toBeNull()
  })

  it('refuses a rate that is not a positive number', async () => {
    setManaRateSource(async () => 0)
    expect(await getManaRate(new Date())).toBeNull()
  })
})

describe('parseTransfers', () => {
  const word = (hex: string) => '0x' + hex.replace(/^0x/, '').toLowerCase().padStart(64, '0')
  const from = '0x1111111111111111111111111111111111111111'
  const log = (over: Record<string, unknown> = {}) => ({
    address: TOKEN.toLowerCase(), topics: [TRANSFER_TOPIC, word(from), word(RECIPIENT)],
    data: word((116n * MANA + 7n).toString(16)), logIndex: 3, transactionHash: '0xabc', blockNumber: 99, ...over,
  })

  it('decodes a Transfer of the token', () => {
    expect(TRANSFER_TOPIC).toBe('0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef')
    expect(parseTransfers(TOKEN, [log()])).toEqual([
      { txHash: '0xabc', logIndex: 3, from, to: RECIPIENT, amountWei: 116n * MANA + 7n, blockNumber: 99 },
    ])
  })

  it('ignores another contract, another event and a malformed log', () => {
    expect(parseTransfers(TOKEN, [
      log({ address: '0x2222222222222222222222222222222222222222' }),
      log({ topics: ['0x' + '1'.repeat(64), word(from), word(RECIPIENT)] }),
      log({ topics: [TRANSFER_TOPIC, word(from)] }),
      log({ data: '0x' }),
    ])).toEqual([])
  })
})

describe('MANA checkout', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let stripe: ReturnType<typeof fakeStripe>
  const prev = {
    enabled: config.studioEnabled, key: config.stripeSecretKey, billing: config.billingEnabled,
    image: config.studioWorkerImage, recipient: config.studioMana.recipient,
  }
  beforeAll(() => {
    ;(config as any).studioEnabled = true
    ;(config as any).studioWorkerImage = 'registry.fly.io/vlm-studio-worker:test'
    ;(config as any).stripeSecretKey = 'sk_test_studio'
    ;(config as any).billingEnabled = true
  })
  afterAll(() => {
    ;(config as any).studioEnabled = prev.enabled
    ;(config as any).studioWorkerImage = prev.image
    ;(config as any).stripeSecretKey = prev.key
    ;(config as any).billingEnabled = prev.billing
    ;(config.studioMana as any).recipient = prev.recipient
    setStripe(null)
    setMachineDeps(null)
    setStudioStore(null)
    setManaRateSource(null)
    setManaSaltSource(null)
  })
  beforeEach(async () => {
    await resetDb()
    ;(config as any).stripeSecretKey = 'sk_test_studio'
    ;(config.studioMana as any).recipient = RECIPIENT
    setManaRateSource(async () => 0.25)
    setManaSaltSource(null)
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
  const paymentsOf = (designId: string) => db.select().from(studioPayments).where(eq(studioPayments.designId, designId))
  const userOf = (u: TestUser) => ({ id: u.id, email: u.email ?? null })

  it('quotes a $29 wearable in MANA at the rate, with a salt in the low digits', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    const before = Date.now()
    const res = await finalize(u, d.id, { method: 'mana' })
    expect(res.statusCode).toBe(200)
    const { mana } = res.json()
    const wei = BigInt(mana.amountWei)
    expect(wei / STEP).toBe(116n * MANA / STEP)
    expect(wei % STEP > 0n).toBe(true)
    expect(mana).toMatchObject({ recipient: RECIPIENT, token: config.studioMana.token, chainId: 137, usdCents: 2900, usdPerMana: 0.25 })
    const ttl = new Date(mana.expiresAt).getTime() - before
    expect(ttl).toBeGreaterThanOrEqual(600_000 - 50)
    expect(ttl).toBeLessThanOrEqual(600_000 + 5_000)
    expect(stripe.calls.sessions).toHaveLength(0)
    expect(stripe.calls.customers).toHaveLength(0)
    const [pay] = await paymentsOf(d.id)
    expect(pay).toMatchObject({
      id: mana.paymentId, method: 'mana', status: 'pending', amountCents: 2900, manaAmountWei: mana.amountWei, manaUsdRate: '0.25',
      stripeSessionId: null,
    })
    expect(pay.expiresAt!.toISOString()).toBe(mana.expiresAt)
  })

  it('charges only what credit leaves, and holds the credit', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    await give(u, 1000)
    const { mana } = (await finalize(u, d.id, { method: 'mana' })).json()
    expect(mana.usdCents).toBe(1900)
    expect(BigInt(mana.amountWei) / STEP).toBe(76n * MANA / STEP)
    expect(await creditBalance(u.id)).toBe(0)
    const [pay] = await paymentsOf(d.id)
    expect(pay).toMatchObject({ method: 'mana', creditHeldCents: 1000 })
  })

  it('refuses with rate_unavailable when there is no rate, holding nothing; a card checkout still works', async () => {
    setManaRateSource(async () => { throw new Error('CoinGecko is down') })
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    await give(u, 1000)
    const res = await finalize(u, d.id, { method: 'mana' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ code: 'rate_unavailable' })
    expect(await paymentsOf(d.id)).toHaveLength(0)
    expect(await creditBalance(u.id)).toBe(1000)
    const card = await finalize(u, d.id)
    expect(card.statusCode).toBe(200)
    expect(card.json().url).toMatch(/^https:\/\/checkout\.stripe\.test\//)
  })

  it('refuses with mana_unavailable when no recipient is set', async () => {
    ;(config.studioMana as any).recipient = null
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    const res = await finalize(u, d.id, { method: 'mana' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ code: 'mana_unavailable' })
    expect(await paymentsOf(d.id)).toHaveLength(0)
    const topup = await app.inject({ method: 'POST', url: '/api/studio/topups', headers: as(u), payload: { method: 'mana' } })
    expect(topup.statusCode).toBe(503)
    expect(topup.json()).toMatchObject({ code: 'mana_unavailable' })
  })

  it('quotes MANA with Stripe unset; a card checkout is still refused', async () => {
    ;(config as any).stripeSecretKey = ''
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    expect((await finalize(u, d.id)).statusCode).toBe(503)
    const res = await finalize(u, d.id, { method: 'mana' })
    expect(res.statusCode).toBe(200)
    expect(res.json().mana.usdCents).toBe(2900)
    const topup = await app.inject({ method: 'POST', url: '/api/studio/topups', headers: as(u), payload: { method: 'mana' } })
    expect(topup.statusCode).toBe(200)
    expect(topup.json().mana.usdCents).toBe(config.studioPrices.topupCents)
  })

  it('refuses an unknown method', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    expect((await finalize(u, d.id, { method: 'bitcoin' })).statusCode).toBe(400)
    const topup = await app.inject({ method: 'POST', url: '/api/studio/topups', headers: as(u), payload: { method: 'bitcoin' } })
    expect(topup.statusCode).toBe(400)
  })

  it('gives two customers with the same price different amounts', async () => {
    const a = await createUser()
    const b = await createUser()
    const da = await createDesign(a)
    const db_ = await createDesign(b)
    await addRevision(da, 'hat')
    await addRevision(db_, 'hat')
    const qa = (await finalize(a, da.id, { method: 'mana' })).json().mana
    const qb = (await finalize(b, db_.id, { method: 'mana' })).json().mana
    expect(qa.usdCents).toBe(qb.usdCents)
    expect(qa.amountWei).not.toBe(qb.amountWei)
  })

  it('draws a new salt when an open quote already asks for the amount', async () => {
    const salts = [5n, 5n, 5n, 9n]
    setManaSaltSource(() => salts.shift()!)
    const a = await createUser()
    const b = await createUser()
    const da = await createDesign(a)
    const db_ = await createDesign(b)
    await addRevision(da, 'hat')
    await addRevision(db_, 'hat')
    const qa = (await finalize(a, da.id, { method: 'mana' })).json().mana
    const qb = (await finalize(b, db_.id, { method: 'mana' })).json().mana
    expect(BigInt(qa.amountWei)).toBe(116n * MANA + 5n)
    expect(BigInt(qb.amountWei)).toBe(116n * MANA + 9n)
  })

  it('gives up after 5 clashing salts, leaving nothing held', async () => {
    setManaSaltSource(() => 5n)
    const a = await createUser()
    const b = await createUser()
    const da = await createDesign(a)
    const db_ = await createDesign(b)
    await addRevision(da, 'hat')
    await addRevision(db_, 'hat')
    await give(a, 500) // the same amount due for both
    await give(b, 500)
    expect((await finalize(a, da.id, { method: 'mana' })).statusCode).toBe(200)
    const res = await finalize(b, db_.id, { method: 'mana' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ code: 'mana_busy' })
    expect(await paymentsOf(db_.id)).toHaveLength(0)
    expect(await creditBalance(b.id)).toBe(500)
  })

  it('is granted at once with no quote when credit covers everything', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    await give(u, 5000)
    const res = await finalize(u, d.id, { method: 'mana' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ granted: true })
    expect(res.json().mana).toBeUndefined()
    const [pay] = await paymentsOf(d.id)
    expect(pay).toMatchObject({ status: 'paid', method: 'credit', manaAmountWei: null, creditHeldCents: 2900 })
  })

  it('reuses an open quote for the same lines with more than 2 minutes left', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    await give(u, 1000)
    const t = new Date()
    const first = await createFinalizeCheckout(d, userOf(u), null, {}, t, 'mana')
    const again = await createFinalizeCheckout(d, userOf(u), null, {}, new Date(t.getTime() + 7 * 60_000), 'mana')
    expect(again).toEqual(first)
    expect(await paymentsOf(d.id)).toHaveLength(1)
    expect(await creditBalance(u.id)).toBe(0)
  })

  it('replaces an open quote with 2 minutes or less left, releasing its holds once', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    await give(u, 1000)
    const t = new Date()
    const first = await createFinalizeCheckout(d, userOf(u), null, {}, t, 'mana') as { mana: { paymentId: string; amountWei: string } }
    const later = new Date(t.getTime() + 8 * 60_000)
    const second = await createFinalizeCheckout(d, userOf(u), null, {}, later, 'mana') as { mana: { paymentId: string; usdCents: number } }
    expect(second.mana.paymentId).not.toBe(first.mana.paymentId)
    expect(second.mana.usdCents).toBe(1900)
    const pays = await paymentsOf(d.id)
    expect(pays.find((p) => p.id === first.mana.paymentId)).toMatchObject({ status: 'expired', creditHeldCents: 0 })
    expect(pays.find((p) => p.id === second.mana.paymentId)).toMatchObject({ status: 'pending', creditHeldCents: 1000 })
    expect(await creditBalance(u.id)).toBe(0)
  })

  it('replaces an open quote whose lines changed', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    const first = (await finalize(u, d.id, { method: 'mana' })).json().mana
    await addRevision(d, 'feet')
    const second = (await finalize(u, d.id, { method: 'mana' })).json().mana
    expect(second.paymentId).not.toBe(first.paymentId)
    expect(second.usdCents).toBeGreaterThan(first.usdCents)
    const [old] = await db.select().from(studioPayments).where(eq(studioPayments.id, first.paymentId))
    expect(old.status).toBe('expired')
  })

  it('a card checkout takes over the credit an open MANA quote holds', async () => {
    const u = await createUser()
    const d = await createDesign(u)
    await addRevision(d, 'hat')
    await give(u, 1000)
    const { mana } = (await finalize(u, d.id, { method: 'mana' })).json()
    const card = await finalize(u, d.id)
    expect(card.statusCode).toBe(200)
    expect(stripe.calls.expired).toHaveLength(0) // a MANA quote has no Stripe session
    const [old] = await db.select().from(studioPayments).where(eq(studioPayments.id, mana.paymentId))
    expect(old).toMatchObject({ status: 'expired', creditHeldCents: 0 })
    expect(stripe.calls.sessions[0].line_items[0].price_data.unit_amount).toBe(1900)
  })

  it('quotes a top-up in MANA', async () => {
    const u = await createUser()
    await give(u, 100)
    const res = await app.inject({ method: 'POST', url: '/api/studio/topups', headers: as(u), payload: { packs: 2, method: 'mana' } })
    expect(res.statusCode).toBe(200)
    const { mana } = res.json()
    expect(mana.usdCents).toBe(config.studioPrices.topupCents * 2 - 100)
    const [pay] = await db.select().from(studioPayments).where(eq(studioPayments.id, mana.paymentId))
    expect(pay).toMatchObject({ kind: 'topup', method: 'mana', creditHeldCents: 100, manaAmountWei: mana.amountWei })
    expect(stripe.calls.sessions).toHaveLength(0)
  })
})
