import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest'
import Stripe from 'stripe'
import sharp from 'sharp'
import { and, eq, sql } from 'drizzle-orm'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { beatClaims, beatPayments, beats, beatScenes, mediaAssets, studioCreditLedger, studioCredits } from '../src/db/schema.js'
import { recordJobFailure } from '../src/errors/record.js'
import { setStripe } from '../src/integrations/stripe.js'
import { setImageBytesReader, setImageSizeReader } from '../src/beats/image.js'
import {
  copyBeatImage, grantBeatPayment, handleBeatSession, refundBeat, setBeatStorage, sweepBeatPayments,
} from '../src/beats/payments.js'
import { sweepStudio } from '../src/studio/sweep.js'
import type { StorageProvider } from '../src/storage/index.js'
import { resetDb } from './helpers/db.js'
import { BEATS_READY } from './helpers/beats-ready.js'
import { createScene, createUser, randomWallet, testApp, tokenFor, type TestUser } from './helpers/factories.js'
import { fakeFly, fakeStripe } from './helpers/studio.js'

vi.mock('../src/errors/record.js', async (orig) => ({
  ...(await orig<typeof import('../src/errors/record.js')>()),
  recordJobFailure: vi.fn(),
}))

const WEBHOOK_SECRET = 'whsec_beat_test'
const signer = new Stripe('sk_test_dummy')
const H = 3_600_000
const MIN = 60_000
const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })

/** Storage in memory: key → bytes, with the public URL a CDN would give. */
function memoryStorage() {
  const files = new Map<string, Buffer>()
  const cache = new Map<string, string | undefined>()
  const s: StorageProvider & { files: Map<string, Buffer>; cache: Map<string, string | undefined> } = {
    files,
    cache,
    async upload(key, data, _type, opts) { files.set(key, data); cache.set(key, opts?.cacheControl); return s.getPublicUrl(key) },
    async delete(key) { files.delete(key) },
    getPublicUrl: (key) => `https://cdn.virvi.test/${key}`,
  }
  return s
}

describe('BEAT payments (LIV-11)', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let stripe: ReturnType<typeof fakeStripe>
  let storage: ReturnType<typeof memoryStorage>
  let host: TestUser
  let sceneA: string
  let image: typeof mediaAssets.$inferSelect
  const bytes = new Map<string, Buffer | (() => Promise<Buffer | null>)>()
  const prev = { beats: config.beats, key: config.stripeSecretKey, billing: config.billingEnabled, secret: config.stripeWebhookSecret }
  const setBeats = (patch: Record<string, unknown>) => { ;(config as any).beats = { ...config.beats, ...patch } }

  beforeAll(() => {
    ;(config as any).stripeSecretKey = 'sk_test_beats'
    ;(config as any).billingEnabled = true
    ;(config as any).stripeWebhookSecret = WEBHOOK_SECRET
  })
  afterAll(() => {
    ;(config as any).stripeSecretKey = prev.key
    ;(config as any).billingEnabled = prev.billing
    ;(config as any).stripeWebhookSecret = prev.secret
    setStripe(null)
  })
  beforeEach(async () => {
    await resetDb()
    vi.mocked(recordJobFailure).mockClear()
    await db.execute(sql`ALTER SEQUENCE beat_token_id_polygon_seq RESTART WITH 1`)
    await db.execute(sql`ALTER SEQUENCE beat_token_id_polygon_amoy_seq RESTART WITH 1`)
    stripe = fakeStripe()
    setStripe(stripe)
    storage = memoryStorage()
    setBeatStorage(storage)
    bytes.clear()
    setImageSizeReader(async () => ({ width: 1024, height: 1024 }))
    setImageBytesReader(async (url) => {
      const b = bytes.get(url)
      return typeof b === 'function' ? b() : b ?? null
    })
    setBeats({ enabled: true, chain: 'polygon', ...BEATS_READY, price: { baseCents: 500, includedMints: 100, extraMintCents: 2 } })
    app = await testApp()
    host = await createUser({ wallet: randomWallet() })
    sceneA = (await createScene(host, 'A')).scene.id
    image = await media(host, 'image/png')
  })
  afterEach(async () => {
    ;(config as any).beats = prev.beats
    setImageSizeReader(null)
    setImageBytesReader(null)
    setBeatStorage(null)
    await app.close()
  })

  /** A real square image (1200 px unless given), a random colour, so each media item's art differs. */
  const png = (px = 1200) => sharp({ create: { width: px, height: px, channels: 3, background: { r: Math.floor(Math.random() * 255), g: 9, b: 9 } } }).png().toBuffer()
  async function media(owner: TestUser, contentType = 'image/png') {
    const url = `https://cdn.example/${Math.random().toString(36).slice(2)}.png`
    bytes.set(url, await png())
    const [m] = await db.insert(mediaAssets).values({ ownerId: owner.id, filename: 'b.png', contentType, sizeBytes: 1, storageKey: 'k', publicUrl: url }).returning()
    return m
  }
  async function seed(over: Partial<typeof beats.$inferInsert> = {}) {
    const [b] = await db.insert(beats).values({
      chain: 'polygon', ownerUserId: host.id, name: 'Seed', description: '', imageMediaId: image.id,
      startsAt: new Date(Date.now() + 2 * H), endsAt: new Date(Date.now() + 4 * H), ...over,
    }).returning()
    await db.insert(beatScenes).values({ beatId: b.id, sceneId: sceneA })
    return b
  }
  const call = (method: string, url: string, user: TestUser = host, payload?: unknown) =>
    app.inject({ method: method as any, url, headers: as(user), payload: payload as any })
  const beatOf = async (id: string) => (await db.select().from(beats).where(eq(beats.id, id)))[0]
  const paymentsOf = async (id: string) => db.select().from(beatPayments).where(eq(beatPayments.beatId, id))
  async function webhook(type: string, object: Record<string, unknown>) {
    const payload = JSON.stringify({ id: `evt_${Math.random()}`, object: 'event', type, data: { object } })
    return app.inject({
      method: 'POST', url: '/api/billing/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }) },
      payload,
    })
  }
  const session = (paymentId: string, intent = 'pi_beat_1') => ({
    id: 'cs_x', object: 'checkout.session', mode: 'payment', payment_status: 'paid', payment_intent: intent, metadata: { kind: 'beat', paymentId },
  })
  async function payByCard(beatId: string, intent = 'pi_beat_1') {
    const res = await call('POST', `/api/beats/${beatId}/checkout`, host, { method: 'card' })
    expect(res.statusCode, res.body).toBe(200)
    const [pay] = (await paymentsOf(beatId)).filter((p) => p.status === 'pending')
    const hook = await webhook('checkout.session.completed', session(pay.id, intent))
    expect(hook.statusCode, hook.body).toBe(200)
    return pay
  }
  const giveCredit = (u: TestUser, cents: number) => db.insert(studioCredits).values({ userId: u.id, balanceCents: cents, updatedAt: new Date() })
  const balance = async (u: TestUser) => (await db.select().from(studioCredits).where(eq(studioCredits.userId, u.id)))[0]?.balanceCents ?? 0

  describe('quote', () => {
    it('cap 150 is 600 cents in two lines', async () => {
      const b = await seed()
      const res = await call('GET', `/api/beats/${b.id}/quote?cap=150`)
      expect(res.statusCode, res.body).toBe(200)
      const q = res.json()
      expect(q.cents).toBe(600)
      expect(q.refundableUnclaimed).toBe(false)
      expect(q.lines).toHaveLength(2)
      expect(q.lines.map((l: any) => l.cents)).toEqual([500, 100])
    })

    it("a bad cap is bad_cap, and someone else's BEAT is not found", async () => {
      const b = await seed()
      expect((await call('GET', `/api/beats/${b.id}/quote?cap=0`)).json().error).toBe('bad_cap')
      expect((await call('GET', `/api/beats/${b.id}/quote?cap=abc`)).json().error).toBe('bad_cap')
      const stranger = await createUser()
      expect((await call('GET', `/api/beats/${b.id}/quote?cap=150`, stranger)).statusCode).toBe(404)
    })

    it('a paid BEAT is quoted the top-up', async () => {
      const b = await seed({ status: 'paid', tokenId: 7 })
      const q = (await call('GET', `/api/beats/${b.id}/quote?cap=150`)).json()
      expect(q.cents).toBe(100)
    })
  })

  describe('card checkout and the webhook', () => {
    it('creates a pending payment and a Stripe session tagged kind beat', async () => {
      const b = await seed({ supplyCap: 150 })
      const res = await call('POST', `/api/beats/${b.id}/checkout`, host, { method: 'card' })
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().url).toMatch(/^https:\/\/checkout\.stripe\.test\//)
      const [pay] = await paymentsOf(b.id)
      expect(pay).toMatchObject({ kind: 'create', method: 'card', status: 'pending', amountCents: 600, capFrom: 0, capTo: 150, userId: host.id })
      expect(pay.stripeSessionId).toMatch(/^cs_test_/)
      expect(stripe.calls.sessions).toHaveLength(1)
      const s = stripe.calls.sessions[0]
      expect(s.metadata).toEqual({ kind: 'beat', paymentId: pay.id })
      // Back to the dashboard's BEAT page, which follows /scenes?id= under the static export
      expect(s.success_url).toMatch(new RegExp(`/beats\\?id=${b.id}&payment=${pay.id}$`))
      expect(s.cancel_url).toMatch(new RegExp(`/beats\\?id=${b.id}&payment=cancelled$`))
      expect(s.line_items.reduce((n: number, l: any) => n + l.price_data.unit_amount * l.quantity, 0)).toBe(600)
      expect((await beatOf(b.id)).status).toBe('draft')
    })

    it('M4: checkout and a cap top-up refuse, taking nothing, while the server chain has no contract or minter key', async () => {
      const b = await seed()
      const paid = await seed({ status: 'paid', tokenId: 4, startsAt: new Date(Date.now() + 10 * H), endsAt: new Date(Date.now() + 11 * H) })
      await giveCredit(host, 10_000)
      for (const patch of [{ contracts: {} }, { minterKey: null }]) {
        setBeats(patch)
        for (const method of ['card', 'credit']) {
          const res = await call('POST', `/api/beats/${b.id}/checkout`, host, { method })
          expect([res.statusCode, res.json().error, res.json().message]).toEqual([503, 'not_configured', "BEATs aren't set up yet. Try again later."])
          const top = await call('POST', `/api/beats/${paid.id}/cap`, host, { method, supplyCap: 200 })
          expect([top.statusCode, top.json().error]).toEqual([503, 'not_configured'])
        }
        setBeats(BEATS_READY)
      }
      expect(stripe.calls.sessions).toHaveLength(0)
      expect(await paymentsOf(b.id)).toHaveLength(0)
      expect(await paymentsOf(paid.id)).toHaveLength(0)
      expect(await balance(host)).toBe(10_000)
    })

    it('a bad method is bad_request; a paid BEAT is locked; a started one too_late', async () => {
      const b = await seed()
      expect((await call('POST', `/api/beats/${b.id}/checkout`, host, { method: 'mana' })).json().error).toBe('bad_request')
      const paid = await seed({ status: 'paid', tokenId: 3, startsAt: new Date(Date.now() + 10 * H), endsAt: new Date(Date.now() + 11 * H) })
      expect((await call('POST', `/api/beats/${paid.id}/checkout`, host, { method: 'card' })).json().error).toBe('locked')
      const started = await seed({ startsAt: new Date(Date.now() - H), endsAt: new Date(Date.now() + 20 * H) })
      expect((await call('POST', `/api/beats/${started.id}/checkout`, host, { method: 'card' })).json().error).toBe('too_late')
    })

    it('checkout.session.completed grants it; granting again is already', async () => {
      const b = await seed()
      const pay = await payByCard(b.id)
      const beat = await beatOf(b.id)
      expect(beat).toMatchObject({ status: 'paid', paymentId: pay.id, tokenId: 1, supplyCap: 100, createdOnChainTx: null })
      const [after] = await paymentsOf(b.id)
      expect(after).toMatchObject({ status: 'paid', stripePaymentIntent: 'pi_beat_1' })
      expect(after.paidAt).toBeInstanceOf(Date)
      expect(await grantBeatPayment(pay.id, 'pi_beat_1', new Date())).toBe('already')
      expect((await beatOf(b.id)).tokenId).toBe(1)
    })

    it('two concurrent grants of one payment assign one token id', async () => {
      const b = await seed()
      await call('POST', `/api/beats/${b.id}/checkout`, host, { method: 'card' })
      const [pay] = await paymentsOf(b.id)
      const results = await Promise.all([grantBeatPayment(pay.id, 'pi_a', new Date()), grantBeatPayment(pay.id, 'pi_a', new Date())])
      expect(results.sort()).toEqual(['already', 'granted'])
      expect((await beatOf(b.id)).tokenId).toBe(1)
      const [{ n }] = await db.execute<{ n: string }>(sql`select nextval('beat_token_id_polygon_seq')::text as n`) as unknown as { n: string }[]
      expect(n).toBe('2')
    })

    it('a second paid checkout for the same BEAT is refunded, not given a second token id', async () => {
      const b = await seed()
      await call('POST', `/api/beats/${b.id}/checkout`, host, { method: 'card' })
      stripe.failExpire = true // the first session can't be expired: both get paid
      await call('POST', `/api/beats/${b.id}/checkout`, host, { method: 'card' })
      const pays = await paymentsOf(b.id)
      expect(pays).toHaveLength(2)
      const results = await Promise.all(pays.map((p, i) => grantBeatPayment(p.id, `pi_${i}`, new Date())))
      expect(results).toEqual(['granted', 'granted'])
      const beat = await beatOf(b.id)
      expect(beat.tokenId).toBe(1)
      const after = await paymentsOf(b.id)
      expect(after.map((p) => p.status).sort()).toEqual(['paid', 'refunded'])
      const stray = after.find((p) => p.status === 'refunded')!
      expect(beat.paymentId).not.toBe(stray.id)
      expect(stripe.calls.refunds).toHaveLength(1)
      expect(stripe.calls.refunds[0].params).toMatchObject({ payment_intent: stray.stripePaymentIntent, amount: 500 })
    })

    it('a session whose id could not be saved is expired, and its payment row is kept', async () => {
      const b = await seed()
      const other = await seed({ startsAt: new Date(Date.now() + 10 * H), endsAt: new Date(Date.now() + 11 * H) })
      await db.insert(beatPayments).values({ beatId: other.id, userId: host.id, kind: 'create', capFrom: 0, capTo: 100, method: 'card', amountCents: 500, stripeSessionId: 'cs_dup' })
      stripe.checkout.sessions.create = async (params: any) => { stripe.calls.sessions.push(params); return { id: 'cs_dup', url: 'https://checkout.stripe.test/dup' } }
      const res = await call('POST', `/api/beats/${b.id}/checkout`, host, { method: 'card' })
      expect([res.statusCode, res.json().error]).toEqual([502, 'stripe_error'])
      expect(stripe.calls.expired).toEqual(['cs_dup'])
      const [kept] = await paymentsOf(b.id)
      expect(kept).toMatchObject({ status: 'pending', method: 'card' })
    })

    it('a session Stripe refused leaves no payment row', async () => {
      const b = await seed()
      stripe.failSessions = true
      const res = await call('POST', `/api/beats/${b.id}/checkout`, host, { method: 'card' })
      expect([res.statusCode, res.json().error]).toEqual([502, 'stripe_error'])
      expect(await paymentsOf(b.id)).toHaveLength(0)
    })

    it('a new checkout expires the open one through Stripe', async () => {
      const b = await seed()
      await call('POST', `/api/beats/${b.id}/checkout`, host, { method: 'card' })
      const [first] = await paymentsOf(b.id)
      await call('POST', `/api/beats/${b.id}/checkout`, host, { method: 'card' })
      expect(stripe.calls.expired).toEqual([first.stripeSessionId])
      expect((await db.select().from(beatPayments).where(eq(beatPayments.id, first.id)))[0].status).toBe('expired')
    })

    it('checkout.session.expired expires the payment; a studio session is not ours', async () => {
      const b = await seed()
      await call('POST', `/api/beats/${b.id}/checkout`, host, { method: 'card' })
      const [pay] = await paymentsOf(b.id)
      expect((await webhook('checkout.session.expired', { ...session(pay.id), payment_status: 'unpaid' })).statusCode).toBe(200)
      expect((await paymentsOf(b.id))[0].status).toBe('expired')
      expect(await handleBeatSession({ type: 'checkout.session.completed', data: { object: { object: 'checkout.session', mode: 'payment', metadata: { vlm_studio_payment_id: pay.id } } } })).toBe(false)
    })

    it('a payment that lands on a cancelled BEAT is refunded', async () => {
      const b = await seed()
      await call('POST', `/api/beats/${b.id}/checkout`, host, { method: 'card' })
      const [pay] = await paymentsOf(b.id)
      expect((await call('POST', `/api/beats/${b.id}/cancel`)).statusCode).toBe(200)
      await webhook('checkout.session.completed', session(pay.id, 'pi_late'))
      const [late] = await paymentsOf(b.id)
      expect(late.status).toBe('refunded')
      expect(late.paidAt).toBeNull() // never applied
      expect(late.refundedAt).toBeInstanceOf(Date)
      expect(stripe.calls.refunds[0].params).toMatchObject({ payment_intent: 'pi_late', amount: 500 })
      expect((await beatOf(b.id))).toMatchObject({ status: 'cancelled', tokenId: null })
    })
  })

  describe('token ids on Amoy', () => {
    it("an admin's checkout is paid at once as a free test payment; ids count up from 1", async () => {
      setBeats({ chain: 'polygon-amoy' })
      const admin = await createUser({ role: 'admin', wallet: randomWallet() })
      const one = await seed({ chain: 'polygon-amoy', ownerUserId: admin.id })
      const two = await seed({ chain: 'polygon-amoy', ownerUserId: admin.id, startsAt: new Date(Date.now() + 10 * H), endsAt: new Date(Date.now() + 11 * H) })
      for (const b of [one, two]) {
        const res = await call('POST', `/api/beats/${b.id}/checkout`, admin, { method: 'card' })
        expect(res.statusCode, res.body).toBe(200)
        expect(res.json()).toEqual({ paid: true })
      }
      expect((await beatOf(one.id)).tokenId).toBe(1)
      expect((await beatOf(two.id)).tokenId).toBe(2)
      const [pay] = await paymentsOf(one.id)
      expect(pay).toMatchObject({ method: 'test', amountCents: 0, status: 'paid' })
      expect(stripe.calls.sessions).toHaveLength(0)
    })

    it('a non-admin may not pay for a test BEAT', async () => {
      setBeats({ chain: 'polygon-amoy' })
      const b = await seed({ chain: 'polygon-amoy' })
      const res = await call('POST', `/api/beats/${b.id}/checkout`, host, { method: 'card' })
      expect([res.statusCode, res.json().error]).toEqual([403, 'forbidden'])
    })
  })

  describe('frozen image copy (standards I1, I3)', () => {
    const live = (id: string) => db.update(beats).set({ status: 'live', startsAt: new Date(Date.now() - H) }).where(eq(beats.id, id))

    it('payment copies nothing; once live, the sweep freezes the art as WebP within 1024 px with an immutable cache; deleting the media leaves it', async () => {
      const b = await seed()
      await payByCard(b.id)
      expect(storage.files.size).toBe(0)
      expect((await beatOf(b.id)).imageUrl).toBeNull()
      // Paid but not live: not yet
      expect((await sweepBeatPayments(new Date())).copied).toBe(0)
      await live(b.id)
      expect(await sweepBeatPayments(new Date())).toMatchObject({ copied: 1, copyFailed: [] })
      const key = `beats/polygon/1-${image.id}.webp`
      const meta = await sharp(storage.files.get(key)!).metadata()
      expect([meta.format, meta.width, meta.height]).toEqual(['webp', 1024, 1024])
      expect(storage.cache.get(key)).toBe('public, max-age=31536000, immutable')
      expect((await beatOf(b.id)).imageUrl).toBe(`https://cdn.virvi.test/${key}`)
      await db.update(beats).set({ imageMediaId: null }).where(eq(beats.id, b.id))
      await db.delete(mediaAssets).where(eq(mediaAssets.id, image.id))
      expect((await call('GET', `/api/beats/${b.id}`)).json().imageUrl).toBe(`https://cdn.virvi.test/${key}`)
    })

    it('a small image is not enlarged', async () => {
      const b = await seed({ status: 'live', tokenId: 3, startsAt: new Date(Date.now() - H) })
      bytes.set(image.publicUrl!, await png(600))
      await copyBeatImage(b.id)
      const meta = await sharp(storage.files.get(`beats/polygon/3-${image.id}.webp`)!).metadata()
      expect(meta.width).toBe(600)
    })

    it('a file that is no image is bad_image, and the sweep reports it', async () => {
      const b = await seed({ status: 'live', tokenId: 6, startsAt: new Date(Date.now() - H) })
      bytes.set(image.publicUrl!, Buffer.from('not an image'))
      await expect(copyBeatImage(b.id)).rejects.toMatchObject({ code: 'bad_image' })
      expect((await sweepBeatPayments(new Date())).copyFailed).toEqual([b.id])
    })

    it('does not write image_url when the image changed while it copied', async () => {
      const b = await seed({ status: 'live', tokenId: 4 })
      const other = await media(host, 'image/webp')
      const oldArt = await png()
      bytes.set(image.publicUrl!, async () => {
        await db.update(beats).set({ imageMediaId: other.id }).where(eq(beats.id, b.id))
        return oldArt
      })
      await copyBeatImage(b.id)
      expect((await beatOf(b.id)).imageUrl).toBeNull()
      const url = await copyBeatImage(b.id)
      expect(url).toBe(`https://cdn.virvi.test/beats/polygon/4-${other.id}.webp`)
      expect((await beatOf(b.id)).imageUrl).toBe(url)
    })

    it('an older copy finishing last never replaces the new artwork', async () => {
      const b = await seed({ status: 'live', tokenId: 5 })
      const next = await media(host, 'image/png')
      let release!: () => void
      const gate = new Promise<void>((r) => { release = r })
      let started!: () => void
      const reading = new Promise<void>((r) => { started = r })
      const oldArt = await png()
      bytes.set(image.publicUrl!, async () => { started(); await gate; return oldArt })
      const slow = copyBeatImage(b.id)
      await reading
      await db.update(beats).set({ imageMediaId: next.id }).where(eq(beats.id, b.id))
      const fast = await copyBeatImage(b.id)
      release()
      await slow
      const key = `beats/polygon/5-${next.id}.webp`
      expect(fast).toBe(`https://cdn.virvi.test/${key}`)
      expect((await beatOf(b.id)).imageUrl).toBe(`https://cdn.virvi.test/${key}`)
    })

    it('a copy that failed is retried by the sweep', async () => {
      const b = await seed()
      await payByCard(b.id)
      await live(b.id)
      bytes.delete(image.publicUrl!)
      expect((await sweepBeatPayments(new Date())).copyFailed).toEqual([b.id])
      bytes.set(image.publicUrl!, await png())
      await sweepBeatPayments(new Date())
      expect((await beatOf(b.id)).imageUrl).toBe(`https://cdn.virvi.test/beats/polygon/1-${image.id}.webp`)
    })

    it('a media item that is a paid or live BEAT\'s art can\'t be deleted (in_use_by_beat); a draft\'s can', async () => {
      const b = await seed()
      await payByCard(b.id)
      const del = await call('DELETE', `/api/media/${image.id}`)
      expect([del.statusCode, del.json().error, del.json().beatId]).toEqual([409, 'in_use_by_beat', b.id])
      const spare = await media(host)
      await seed({ imageMediaId: spare.id, startsAt: new Date(Date.now() + 20 * H), endsAt: new Date(Date.now() + 21 * H) })
      expect((await call('DELETE', `/api/media/${spare.id}`)).statusCode).toBe(204)
    })
  })

  describe('credit', () => {
    it('with enough credit the checkout is paid at once and the balance drops', async () => {
      await giveCredit(host, 1000)
      const b = await seed()
      const res = await call('POST', `/api/beats/${b.id}/checkout`, host, { method: 'credit' })
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toEqual({ paid: true })
      expect(await balance(host)).toBe(500)
      const [pay] = await paymentsOf(b.id)
      expect(pay).toMatchObject({ method: 'credit', amountCents: 500, creditCents: 500, status: 'paid' })
      const ledger = await db.select().from(studioCreditLedger).where(eq(studioCreditLedger.userId, host.id))
      expect(ledger).toEqual([expect.objectContaining({ deltaCents: -500, reason: 'beat', refId: pay.id })])
      expect((await beatOf(b.id))).toMatchObject({ status: 'paid', tokenId: 1 })
      expect(stripe.calls.sessions).toHaveLength(0)
    })

    it('with too little credit method credit is insufficient_credit and nothing changes', async () => {
      await giveCredit(host, 499)
      const b = await seed()
      const res = await call('POST', `/api/beats/${b.id}/checkout`, host, { method: 'credit' })
      expect([res.statusCode, res.json().error]).toEqual([402, 'insufficient_credit'])
      expect(await balance(host)).toBe(499)
      expect(await paymentsOf(b.id)).toHaveLength(0)
      expect((await beatOf(b.id)).status).toBe('draft')
    })
  })

  describe('cap top-ups', () => {
    it('100 to 150 charges 100 cents and raises the cap only once granted', async () => {
      const b = await seed()
      await payByCard(b.id)
      const res = await call('POST', `/api/beats/${b.id}/cap`, host, { supplyCap: 150 })
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().url).toBeTruthy()
      const top = (await paymentsOf(b.id)).find((p) => p.kind === 'topup')!
      expect(top).toMatchObject({ status: 'pending', capFrom: 100, capTo: 150, amountCents: 100, method: 'card' })
      expect(stripe.calls.sessions[1].metadata).toEqual({ kind: 'beat', paymentId: top.id })
      expect((await beatOf(b.id)).supplyCap).toBe(100)
      await webhook('checkout.session.completed', session(top.id, 'pi_top'))
      expect((await beatOf(b.id))).toMatchObject({ supplyCap: 150, tokenId: 1, status: 'paid' })
    })

    it('a lower or equal cap is bad_cap; after the end is too_late; a draft is locked', async () => {
      const b = await seed({ status: 'paid', tokenId: 9, supplyCap: 150 })
      expect((await call('POST', `/api/beats/${b.id}/cap`, host, { supplyCap: 120 })).json().error).toBe('bad_cap')
      expect((await call('POST', `/api/beats/${b.id}/cap`, host, { supplyCap: 150 })).json().error).toBe('bad_cap')
      const over = await seed({ status: 'live', tokenId: 10, startsAt: new Date(Date.now() - 3 * H), endsAt: new Date(Date.now() - H) })
      const late = await call('POST', `/api/beats/${over.id}/cap`, host, { supplyCap: 200 })
      expect([late.statusCode, late.json().error]).toEqual([409, 'too_late'])
      const draft = await seed({ startsAt: new Date(Date.now() + 10 * H), endsAt: new Date(Date.now() + 11 * H) })
      expect((await call('POST', `/api/beats/${draft.id}/cap`, host, { supplyCap: 200 })).json().error).toBe('locked')
    })

    it('money I2: a card raise under 50 cents is below_minimum with the smallest supply; credit pays it; the quote says the same', async () => {
      await giveCredit(host, 300)
      const b = await seed({ status: 'live', tokenId: 13, startsAt: new Date(Date.now() - H), endsAt: new Date(Date.now() + H) })
      const card = await call('POST', `/api/beats/${b.id}/cap`, host, { supplyCap: 110, method: 'card' })
      expect(card.statusCode, card.body).toBe(400)
      expect(card.json()).toMatchObject({ error: 'below_minimum', minCents: 50, minSupply: 125, minExtraTokens: 25 })
      expect(stripe.calls.sessions).toHaveLength(0)
      expect(await paymentsOf(b.id)).toHaveLength(0)
      const q = await call('GET', `/api/beats/${b.id}/quote?cap=110`)
      expect([q.statusCode, q.json().error, q.json().minSupply]).toEqual([400, 'below_minimum', 125])
      const qc = await call('GET', `/api/beats/${b.id}/quote?cap=110&method=credit`)
      expect([qc.statusCode, qc.json().cents]).toEqual([200, 20])
      expect((await call('GET', `/api/beats/${b.id}/quote?cap=125`)).json().cents).toBe(50)
      const credit = await call('POST', `/api/beats/${b.id}/cap`, host, { supplyCap: 110, method: 'credit' })
      expect(credit.json()).toEqual({ paid: true })
      expect((await beatOf(b.id)).supplyCap).toBe(110)
    })

    it('a live BEAT can top up with credit at once', async () => {
      await giveCredit(host, 300)
      const b = await seed({ status: 'live', tokenId: 11, startsAt: new Date(Date.now() - H), endsAt: new Date(Date.now() + H) })
      const res = await call('POST', `/api/beats/${b.id}/cap`, host, { supplyCap: 200, method: 'credit' })
      expect(res.json()).toEqual({ paid: true })
      expect((await beatOf(b.id)).supplyCap).toBe(200)
      expect(await balance(host)).toBe(100)
    })

    it('a top-up overtaken by another is refunded, not applied', async () => {
      const b = await seed({ status: 'paid', tokenId: 12 })
      stripe.failExpire = true
      await call('POST', `/api/beats/${b.id}/cap`, host, { supplyCap: 150 })
      await call('POST', `/api/beats/${b.id}/cap`, host, { supplyCap: 200 })
      const [a, c] = (await paymentsOf(b.id)).sort((x, y) => x.capTo - y.capTo)
      await webhook('checkout.session.completed', session(c.id, 'pi_200'))
      await webhook('checkout.session.completed', session(a.id, 'pi_150'))
      expect((await beatOf(b.id)).supplyCap).toBe(200)
      expect((await db.select().from(beatPayments).where(eq(beatPayments.id, a.id)))[0].status).toBe('refunded')
      expect(stripe.calls.refunds.map((r) => r.params.payment_intent)).toEqual(['pi_150'])
    })
  })

  describe('refunds on cancel', () => {
    it('a paid card BEAT is refunded in full through Stripe, once', async () => {
      const b = await seed()
      await payByCard(b.id, 'pi_cancel')
      const res = await call('POST', `/api/beats/${b.id}/cancel`)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().status).toBe('cancelled')
      expect(stripe.calls.refunds).toHaveLength(1)
      expect(stripe.calls.refunds[0].params).toMatchObject({ payment_intent: 'pi_cancel', amount: 500 })
      const [pay] = await paymentsOf(b.id)
      expect(pay.status).toBe('refunded')
      expect(pay.refundedAt).toBeInstanceOf(Date)
      expect(await refundBeat(b.id, new Date())).toEqual({ stripeCents: 0, creditCents: 0 })
      expect(stripe.calls.refunds).toHaveLength(1)
    })

    it('a retry after Stripe refunded but before the status was saved does not refund twice', async () => {
      const b = await seed()
      const pay = await payByCard(b.id, 'pi_crash')
      expect(await refundBeat(b.id, new Date())).toEqual({ stripeCents: 500, creditCents: 0 })
      // The crash: Stripe made the refund, the row still says paid
      await db.update(beatPayments).set({ status: 'paid', refundedAt: null }).where(eq(beatPayments.id, pay.id))
      await db.update(beats).set({ status: 'paid' }).where(eq(beats.id, b.id))
      await refundBeat(b.id, new Date())
      expect(stripe.calls.refunds).toHaveLength(1)
      expect((await paymentsOf(b.id))[0].status).toBe('refunded')
      expect((await beatOf(b.id)).status).toBe('cancelled')
    })

    it('a BEAT paid by credit and topped up by card gets both back', async () => {
      await giveCredit(host, 500)
      const b = await seed()
      expect((await call('POST', `/api/beats/${b.id}/checkout`, host, { method: 'credit' })).json()).toEqual({ paid: true })
      const res = await call('POST', `/api/beats/${b.id}/cap`, host, { supplyCap: 150 })
      expect(res.json().url).toBeTruthy()
      const top = (await paymentsOf(b.id)).find((p) => p.kind === 'topup')!
      await webhook('checkout.session.completed', session(top.id, 'pi_topup'))
      expect(await balance(host)).toBe(0)
      expect((await call('POST', `/api/beats/${b.id}/cancel`)).json().status).toBe('cancelled')
      expect(await balance(host)).toBe(500)
      expect(stripe.calls.refunds.map((r) => r.params)).toEqual([expect.objectContaining({ payment_intent: 'pi_topup', amount: 100 })])
      expect((await paymentsOf(b.id)).every((p) => p.status === 'refunded')).toBe(true)
      const ledger = await db.select().from(studioCreditLedger).where(and(eq(studioCreditLedger.userId, host.id), eq(studioCreditLedger.reason, 'refund')))
      expect(ledger.map((l) => l.deltaCents)).toEqual([500])
    })
  })

  describe('a refunded top-up lowers the cap again', () => {
    it('a cancel that fails partway (the top-up refunded, the create not) reverts the raise; the retry finishes without reverting twice', async () => {
      const b = await seed()
      await payByCard(b.id, 'pi_create')
      await call('POST', `/api/beats/${b.id}/cap`, host, { supplyCap: 150 })
      const top = (await paymentsOf(b.id)).find((p) => p.kind === 'topup')!
      await webhook('checkout.session.completed', session(top.id, 'pi_top'))
      expect((await beatOf(b.id)).supplyCap).toBe(150)
      const create = stripe.refunds.create.bind(stripe.refunds)
      stripe.refunds.create = (async (params: any, opts: any) => {
        if (params.payment_intent === 'pi_create') throw new Error('refund refused')
        return create(params, opts)
      }) as typeof stripe.refunds.create
      expect((await call('POST', `/api/beats/${b.id}/cancel`)).statusCode).toBe(500)
      expect((await paymentsOf(b.id)).map((p) => [p.kind, p.status]).sort()).toEqual([['create', 'paid'], ['topup', 'refunded']])
      expect(await beatOf(b.id)).toMatchObject({ status: 'paid', supplyCap: 100 })
      stripe.refunds.create = create
      expect((await call('POST', `/api/beats/${b.id}/cancel`)).json().status).toBe('cancelled')
      expect((await beatOf(b.id)).supplyCap).toBe(100)
      // Again: nothing left to refund, the cap stays
      expect(await refundBeat(b.id, new Date())).toEqual({ stripeCents: 0, creditCents: 0 })
      expect((await beatOf(b.id)).supplyCap).toBe(100)
      expect(recordJobFailure).not.toHaveBeenCalled()
    })

    it('never below the claims already made: keeps max(claims, cap - topup) and records an admin alert', async () => {
      const b = await seed({ status: 'paid', tokenId: 20, supplyCap: 150 })
      const [create] = await db.insert(beatPayments).values({ beatId: b.id, userId: host.id, kind: 'create', capFrom: 0, capTo: 100, method: 'test', amountCents: 0, status: 'paid', paidAt: new Date() }).returning()
      await db.update(beats).set({ paymentId: create.id }).where(eq(beats.id, b.id))
      await db.insert(beatPayments).values({ beatId: b.id, userId: host.id, kind: 'topup', capFrom: 100, capTo: 150, method: 'credit', amountCents: 100, creditCents: 100, status: 'paid', paidAt: new Date() })
      const statuses = ['claimed', 'minting', 'minted', 'failed'] as const
      await db.insert(beatClaims).values(Array.from({ length: 120 }, (_, i) => ({ beatId: b.id, wallet: randomWallet(), consentVersion: 1, status: statuses[i % 4] })))
      // Present visitors haven't claimed: they don't count
      await db.insert(beatClaims).values(Array.from({ length: 10 }, () => ({ beatId: b.id, wallet: randomWallet(), consentVersion: 1, status: 'present' as const })))
      // M4: the alert is raised once the refund has committed (another connection already sees the lowered cap)
      const seen: Promise<number>[] = []
      vi.mocked(recordJobFailure).mockImplementationOnce(() => { seen.push(db.select().from(beats).where(eq(beats.id, b.id)).then((r) => r[0].supplyCap)) })
      await refundBeat(b.id, new Date())
      expect((await beatOf(b.id)).supplyCap).toBe(120)
      expect(recordJobFailure).toHaveBeenCalledTimes(1)
      expect(await Promise.all(seen)).toEqual([120])
      const [job, err, f] = vi.mocked(recordJobFailure).mock.calls[0]
      expect(job).toBe('beat_refund')
      expect((err as Error).message).toContain(b.id)
      expect(f).toEqual({ owner: b.id })
      await refundBeat(b.id, new Date())
      expect(recordJobFailure).toHaveBeenCalledTimes(1)
    })
  })

  describe('expiry', () => {
    it('the studio sweep expires a stale pending payment and leaves a fresh one', async () => {
      const b = await seed()
      const now = new Date()
      const [stale] = await db.insert(beatPayments).values({ beatId: b.id, userId: host.id, kind: 'create', capFrom: 0, capTo: 100, method: 'card', amountCents: 500, createdAt: new Date(now.getTime() - 40 * MIN) }).returning()
      const [fresh] = await db.insert(beatPayments).values({ beatId: b.id, userId: host.id, kind: 'create', capFrom: 0, capTo: 100, method: 'card', amountCents: 500, createdAt: new Date(now.getTime() - 5 * MIN) }).returning()
      await sweepStudio(now, { fly: fakeFly() })
      const rows = await paymentsOf(b.id)
      expect(rows.find((p) => p.id === stale.id)!.status).toBe('expired')
      expect(rows.find((p) => p.id === fresh.id)!.status).toBe('pending')
    })

    it('a card payment Stripe completes after it expired is still granted', async () => {
      const b = await seed()
      await call('POST', `/api/beats/${b.id}/checkout`, host, { method: 'card' })
      const [pay] = await paymentsOf(b.id)
      await db.update(beatPayments).set({ status: 'expired' }).where(eq(beatPayments.id, pay.id))
      await webhook('checkout.session.completed', session(pay.id))
      expect((await beatOf(b.id))).toMatchObject({ status: 'paid', tokenId: 1 })
    })
  })
})
