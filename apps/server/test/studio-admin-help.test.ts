import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import {
  studioDesigns, studioEntitlements, studioFinalizeCredits, studioJobs, studioMessages, studioPayments, studioPromptCredits, studioScopeEvents,
  studioTrialSpendDays, studioUploads, studioUsageDays, users,
} from '../src/db/schema.js'
import { config } from '../src/config.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { setStripe } from '../src/integrations/stripe.js'
import { SUPPORT_PREFIX } from '../src/studio/designs.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, randomWallet, type TestUser } from './helpers/factories.js'
import { addRevision, createDesign, fakeFly, fakePolygon, fakeStripe, issueWorker, okResult } from './helpers/studio.js'
import { createFinalizeCheckout } from '../src/studio/payments.js'
import { creditBalance } from '../src/studio/credit.js'
import { setManaRateSource } from '../src/studio/mana/rate.js'
import { type ManaQuote } from '../src/studio/mana/quote.js'
import { setPolygon } from '../src/studio/mana/polygon.js'
import { watchManaTransfers } from '../src/studio/mana/settle.js'

const S = '/api/studio'

describe('Virvi support: admins help on anyone’s design', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let fly: ReturnType<typeof fakeFly>
  let stripe: ReturnType<typeof fakeStripe>
  let admin: TestUser
  let owner: TestUser
  const prev = { enabled: config.studioEnabled, image: config.studioWorkerImage, key: config.stripeSecretKey }
  beforeAll(() => {
    ;(config as any).studioEnabled = true
    ;(config as any).studioWorkerImage = 'registry.fly.io/vlm-studio-worker:test'
    ;(config as any).stripeSecretKey = 'sk_test_studio'
  })
  afterAll(() => {
    ;(config as any).studioEnabled = prev.enabled
    ;(config as any).studioWorkerImage = prev.image
    ;(config as any).stripeSecretKey = prev.key
    setStudioStore(null)
    setMachineDeps(null)
    setStripe(null)
  })
  beforeEach(async () => {
    await resetDb()
    setStudioStore(memoryStudioStore())
    fly = fakeFly()
    setMachineDeps({ fly })
    stripe = fakeStripe()
    setStripe(stripe)
    app = await testApp()
    admin = await createUser({ role: 'admin', name: 'Ada Admin' })
    owner = await createUser({ name: 'Olive Owner', email: 'olive@example.com', wallet: randomWallet() })
  })

  const as = (u: TestUser, extra: Record<string, unknown> = {}) => ({ authorization: `Bearer ${tokenFor(u, extra)}` })
  const prompt = (u: TestUser, id: string, body: Record<string, unknown> = { text: 'make the visor glow brighter' }, extra = {}) =>
    app.inject({ method: 'POST', url: `${S}/designs/${id}/prompts`, headers: as(u, extra), payload: body })
  const finish = async (jobId: string, result: Record<string, unknown>) => {
    const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, jobId))
    const [d] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, job.designId))
    const token = await issueWorker(d, d.machineId ?? 'm-test')
    await db.update(studioJobs).set({ status: 'taken', takenAt: new Date() }).where(eq(studioJobs.id, jobId))
    const res = await app.inject({ method: 'POST', url: `/api/studio/worker/jobs/${jobId}/result`, headers: { authorization: `Bearer ${token}` }, payload: result as any })
    expect(res.statusCode).toBe(204)
  }
  const usageRows = async (userId: string) => db.select().from(studioUsageDays).where(eq(studioUsageDays.userId, userId))

  describe('the admin list of designs', () => {
    const list = (u: TestUser, query = '', extra = {}) => app.inject({ method: 'GET', url: `/api/admin/studio/designs${query}`, headers: as(u, extra) })

    it('lists every design, trial ones included, newest activity first, with owner, kind, pieces and last prompt', async () => {
      const trial = await createUser({ email: null, name: 'Trial visitor' })
      await db.update(users).set({ isTrial: true, trialLastActiveAt: new Date() }).where(eq(users.id, trial.id))
      const old = await createDesign(owner, { name: 'Old cap', lastJobAt: new Date(Date.now() - 3600_000) })
      const t = await createDesign(trial, { name: 'Trial wave', kind: 'emote', lastJobAt: new Date() })
      const archived = await createDesign(owner, { name: 'Shelved', archivedAt: new Date(), lastJobAt: new Date(Date.now() - 7200_000) })
      await addRevision(old, 'hat')
      await db.insert(studioJobs).values({ designId: old.id, type: 'prompt', status: 'done', payload: {} })
      const res = await list(admin)
      expect(res.statusCode).toBe(200)
      const { designs, nextCursor } = res.json()
      expect(nextCursor).toBeNull()
      expect(designs.map((d: any) => d.id)).toEqual([t.id, old.id, archived.id])
      expect(designs[0]).toMatchObject({ name: 'Trial wave', kind: 'emote', pieceCount: 0, owner: { id: trial.id, trial: true, email: null } })
      expect(designs[1]).toMatchObject({ name: 'Old cap', pieceCount: 1, archivedAt: null, owner: { id: owner.id, name: 'Olive Owner', email: 'olive@example.com', wallet: owner.wallet, trial: false } })
      expect(designs[1].lastPromptAt).not.toBeNull()
      expect(designs[2].archivedAt).not.toBeNull()
    })

    it('searches by owner email, wallet, name, design name and id, and filters by kind', async () => {
      const other = await createUser({ name: 'Someone Else', email: 'else@example.com' })
      const mine = await createDesign(owner, { name: 'Neon cap' })
      const theirs = await createDesign(other, { name: 'Dance move', kind: 'emote' })
      const ids = async (q: string) => (await list(admin, q)).json().designs.map((d: any) => d.id)
      expect(await ids('?q=OLIVE@example')).toEqual([mine.id])
      expect(await ids(`?q=${owner.wallet!.slice(2, 12).toUpperCase()}`)).toEqual([mine.id])
      expect(await ids('?q=olive%20owner')).toEqual([mine.id])
      expect(await ids('?q=dance')).toEqual([theirs.id])
      expect(await ids(`?q=${theirs.id}`)).toEqual([theirs.id])
      expect(await ids(`?q=${other.id}`)).toEqual([theirs.id])
      expect(await ids('?kind=emote')).toEqual([theirs.id])
      expect(await ids('?q=%25')).toEqual([]) // a % is itself, not everything
      expect((await list(admin, '?kind=hat')).statusCode).toBe(400)
      expect((await list(admin, '?cursor=nonsense')).statusCode).toBe(400)
    })

    it('pages with a cursor', async () => {
      const base = Date.now()
      const made = []
      for (let i = 0; i < 53; i++) made.push(await createDesign(owner, { name: `d${i}`, lastJobAt: new Date(base - i * 1000) }))
      const first = (await list(admin)).json()
      expect(first.designs).toHaveLength(50)
      expect(first.nextCursor).toBeTruthy()
      const second = (await list(admin, `?cursor=${first.nextCursor}`)).json()
      expect(second.designs.map((d: any) => d.name)).toEqual(['d50', 'd51', 'd52'])
      expect(second.nextCursor).toBeNull()
    })

    it('is for admins only, the role read from the database', async () => {
      expect((await list(owner)).statusCode).toBe(403)
      // A token claiming admin for an account that isn't one
      expect((await list(owner, '', { role: 'admin' })).statusCode).toBe(403)
      // An admin demoted after the token was minted
      await db.update(users).set({ role: 'creator' }).where(eq(users.id, admin.id))
      expect((await list(admin)).statusCode).toBe(403)
    })
  })

  describe('viewing and prompting', () => {
    it('an admin opens anyone’s design, with whose it is', async () => {
      const d = await createDesign(owner)
      const res = await app.inject({ method: 'GET', url: `${S}/designs/${d.id}`, headers: as(admin) })
      expect(res.statusCode).toBe(200)
      expect(res.json().support).toEqual({ ownerId: owner.id, ownerName: 'Olive Owner', ownerEmail: 'olive@example.com', trial: false })
      // The owner's own view has no support block
      expect((await app.inject({ method: 'GET', url: `${S}/designs/${d.id}`, headers: as(owner) })).json().support).toBeUndefined()
    })

    it('others, a token claiming admin and a scene pass get 404; an admin’s API key is an admin’s', async () => {
      const d = await createDesign(owner)
      const stranger = await createUser()
      const get = (headers: Record<string, string>) => app.inject({ method: 'GET', url: `${S}/designs/${d.id}`, headers })
      expect((await get(as(stranger))).statusCode).toBe(404)
      expect((await get(as(stranger, { role: 'admin' }))).statusCode).toBe(404)
      expect((await prompt(stranger, d.id, { text: 'pwned' }, { role: 'admin' })).statusCode).toBe(404)
      expect((await get(as(admin, { kind: 'scene', via: 'studio', sceneId: null }))).statusCode).toBe(404)
      const key = await app.inject({ method: 'POST', url: '/api/keys', headers: as(admin), payload: { name: 'admin key' } })
      expect(key.statusCode).toBe(201)
      // An admin's own API key is an admin's on every admin route, so on support too (one check: src/auth/admin.ts)
      expect((await get({ authorization: `Bearer ${key.json().key}` })).statusCode).toBe(200)
    })

    it('an admin’s prompt is free for everyone, records the admin, and shows as Virvi support', async () => {
      const d = await createDesign(owner)
      // The owner has no allowance left today
      await db.insert(studioUsageDays).values({ userId: owner.id, day: new Date().toISOString().slice(0, 10), prompts: 99, costUsd: 0 })
      expect((await prompt(owner, d.id)).statusCode).toBe(429)
      // Credits and gifts the owner holds are left alone too
      await db.insert(studioPromptCredits).values({ userId: owner.id, balance: 2, gifted: 1 })
      const res = await prompt(admin, d.id, { text: 'make the visor glow brighter', selectedSlots: ['hat'] })
      expect(res.statusCode).toBe(202)
      const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, res.json().jobId))
      expect(job).toMatchObject({ counted: false, countedDay: null, countedFrom: null, byAdminId: admin.id })
      const payload = job.payload as Record<string, unknown>
      expect(payload.prompt).toBe(`${SUPPORT_PREFIX}make the visor glow brighter`)
      expect(payload.check).toBe(false) // support's words aren't scope-checked
      expect(payload.limits).toEqual({ timeoutSec: 1500, maxTurns: 80, costCeilingUsd: 3 }) // per-prompt limits stay
      const [msg] = await db.select().from(studioMessages).where(eq(studioMessages.designId, d.id))
      expect(msg).toMatchObject({ role: 'user', text: 'make the visor glow brighter', byAdminId: admin.id })
      const [credits] = await db.select().from(studioPromptCredits).where(eq(studioPromptCredits.userId, owner.id))
      expect(credits).toMatchObject({ balance: 2, gifted: 1 })
      expect((await usageRows(owner.id))[0].prompts).toBe(99)
      expect(await usageRows(admin.id)).toEqual([])
      expect(fly.calls.create).toHaveLength(1)

      // Its cost goes on nobody's day, and the owner sees the message as support's
      await finish(job.id, okResult(job.id, { costUsd: 2.5 }))
      expect((await usageRows(owner.id))[0].costUsd).toBe(0)
      expect(await usageRows(admin.id)).toEqual([])
      const seen = (await app.inject({ method: 'GET', url: `${S}/designs/${d.id}`, headers: as(owner) })).json()
      expect(seen.messages.map((m: any) => [m.role, m.support])).toEqual([['user', true], ['agent', false]])
      expect(JSON.stringify(seen)).not.toContain(admin.id)
    })

    it('an owner’s own prompt is not support', async () => {
      const d = await createDesign(owner)
      const res = await prompt(owner, d.id)
      expect(res.statusCode).toBe(202)
      const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, res.json().jobId))
      expect(job).toMatchObject({ counted: true, byAdminId: null })
      expect((job.payload as any).prompt).toBe('make the visor glow brighter')
      const seen = (await app.inject({ method: 'GET', url: `${S}/designs/${d.id}`, headers: as(owner) })).json()
      expect(seen.messages[0].support).toBe(false)
    })

    it('a trial’s design: past its free prompts and the trials’ daily budget, support still helps, on nobody’s budget', async () => {
      const trial = await createUser({ email: null })
      await db.update(users).set({ isTrial: true, trialLastActiveAt: new Date() }).where(eq(users.id, trial.id))
      const d = await createDesign(trial)
      await db.insert(studioUsageDays).values({ userId: trial.id, day: '1970-01-01', prompts: 99, costUsd: 99 })
      await db.insert(studioTrialSpendDays).values({ day: new Date().toISOString().slice(0, 10), costUsd: 1000 })
      const res = await prompt(admin, d.id)
      expect(res.statusCode).toBe(202)
      await finish(res.json().jobId, okResult(res.json().jobId, { costUsd: 1 }))
      const [spend] = await db.select().from(studioTrialSpendDays)
      expect(spend.costUsd).toBe(1000)
      expect((await usageRows(trial.id))[0]).toMatchObject({ prompts: 99, costUsd: 99 })
    })

    it('an off-topic support prompt is not logged against the owner', async () => {
      const d = await createDesign(owner)
      const res = await prompt(admin, d.id)
      const jobId = res.json().jobId
      await finish(jobId, okResult(jobId, { outcome: 'off_topic', pieces: [], scope: { by: 'check', category: 'coding', note: 'x' } }))
      expect(await db.select().from(studioScopeEvents)).toEqual([])
    })

    it('the design’s own state still holds: one prompt at a time, and archived takes none', async () => {
      const d = await createDesign(owner)
      expect((await prompt(owner, d.id)).statusCode).toBe(202)
      expect((await prompt(admin, d.id)).json()).toMatchObject({ code: 'busy' })
      const shelved = await createDesign(owner, { archivedAt: new Date() })
      expect((await prompt(admin, shelved.id)).json()).toMatchObject({ code: 'archived' })
    })

    it('Continue and fixing the checks by support are support’s, and free', async () => {
      const d = await createDesign(owner)
      await addRevision(d, 'hat', { pass: false, failures: 1, warnings: 0 })
      const res = await prompt(admin, d.id, { fixChecks: true })
      expect(res.statusCode).toBe(202)
      const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, res.json().jobId))
      expect(job.byAdminId).toBe(admin.id)
      expect((job.payload as any).prompt).toBe('Fix every FAIL the checker reported for: hat. Change nothing else.')
    })

    it('owner-only routes stay the owner’s: rename and archive, uploads, mistake reports', async () => {
      const d = await createDesign(owner)
      const [u] = await db.insert(studioUploads).values({ designId: d.id, name: 'logo.png', kind: 'image', contentType: 'image/png', size: 4 }).returning()
      const h = as(admin)
      expect((await app.inject({ method: 'PATCH', url: `${S}/designs/${d.id}`, headers: h, payload: { archived: true } })).statusCode).toBe(404)
      expect((await app.inject({ method: 'DELETE', url: `${S}/designs/${d.id}/uploads/${u.id}`, headers: h })).statusCode).toBe(404)
      expect((await app.inject({ method: 'POST', url: `${S}/designs/${d.id}/uploads?name=x.png`, headers: { ...h, 'content-type': 'image/png' }, payload: Buffer.from('x') })).statusCode).toBe(404)
      expect((await app.inject({ method: 'POST', url: `${S}/designs/${d.id}/pieces/hat/revisions/1/report`, headers: h, payload: { text: 'the agent broke it' } })).statusCode).toBe(404)
      const [still] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, d.id))
      expect(still.archivedAt).toBeNull()
    })
  })

  describe('finalizing for the owner', () => {
    it('the quote is free, and finalizing grants the ticked pieces to the owner at once, recording the admin', async () => {
      const d = await createDesign(owner)
      await addRevision(d, 'hat')
      await addRevision(d, 'upper_body')
      await db.insert(studioFinalizeCredits).values({ userId: owner.id, balance: 2 })
      const quote = (await app.inject({ method: 'GET', url: `${S}/designs/${d.id}/finalize?categories=hat`, headers: as(admin) })).json()
      expect(quote).toMatchObject({ totalCents: 0, dueCents: 0, giftsUsed: 0 })
      expect(quote.lines.map((l: any) => [l.category, l.admin])).toEqual([['hat', true]])
      const res = await app.inject({ method: 'POST', url: `${S}/designs/${d.id}/finalize`, headers: as(admin), payload: { categories: ['hat'], method: 'mana' } })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ granted: true })
      const [pay] = await db.select().from(studioPayments)
      expect(pay).toMatchObject({ userId: owner.id, byAdminId: admin.id, status: 'paid', amountCents: 0, giftsHeld: 0, creditHeldCents: 0, stripeSessionId: null, manaAmountWei: null })
      const ents = await db.select().from(studioEntitlements)
      expect(ents.map((e) => [e.category, e.userId, e.amountCents])).toEqual([['hat', owner.id, 0]])
      expect(stripe.calls?.sessions ?? []).toEqual([])
      const [credits] = await db.select().from(studioFinalizeCredits).where(eq(studioFinalizeCredits.userId, owner.id))
      expect(credits.balance).toBe(2)
      // The owner sees it finalized, as if they had paid
      const seen = (await app.inject({ method: 'GET', url: `${S}/designs/${d.id}`, headers: as(owner) })).json()
      expect(seen.pieces.find((p: any) => p.category === 'hat').finalized).toHaveLength(1)
      expect(seen.design.finalizedPieces).toBe(1)
    })

    it('support downloads and retries the owner’s packages; a stranger can’t', async () => {
      const d = await createDesign(owner)
      await addRevision(d, 'hat')
      await app.inject({ method: 'POST', url: `${S}/designs/${d.id}/finalize`, headers: as(admin), payload: { categories: ['hat'] } })
      const [e] = await db.select().from(studioEntitlements)
      const store = memoryStudioStore()
      setStudioStore(store)
      await store.put('designs/x/final/hat/package.zip', Buffer.from('PK-hat'), 'application/zip')
      await db.update(studioEntitlements).set({ status: 'ready', packageKey: 'designs/x/final/hat/package.zip' }).where(eq(studioEntitlements.id, e.id))
      const url = `${S}/designs/${d.id}/pieces/hat/revisions/1/package`
      const got = await app.inject({ method: 'GET', url, headers: as(admin) })
      expect(got.statusCode).toBe(200)
      expect(got.body).toBe('PK-hat')
      const stranger = await createUser()
      expect((await app.inject({ method: 'GET', url, headers: as(stranger) })).statusCode).toBe(404)
      await db.update(studioEntitlements).set({ status: 'failed' }).where(eq(studioEntitlements.id, e.id))
      expect((await app.inject({ method: 'POST', url: `${url}/retry`, headers: as(stranger) })).statusCode).toBe(404)
      expect((await app.inject({ method: 'POST', url: `${url}/retry`, headers: as(admin) })).statusCode).toBe(202)
    })

    it('a stranger’s finalize, even claiming admin, is 404 and nothing is granted', async () => {
      const d = await createDesign(owner)
      await addRevision(d, 'hat')
      const stranger = await createUser()
      const res = await app.inject({ method: 'POST', url: `${S}/designs/${d.id}/finalize`, headers: as(stranger, { role: 'admin' }), payload: {} })
      expect(res.statusCode).toBe(404)
      expect(await db.select().from(studioPayments)).toEqual([])
    })
  })
})

describe('support’s finalize closes the owner’s open checkouts for those pieces', () => {
  const RECIPIENT = '0x01d871870CbBddE934526E17637c0cfEf0b3b38B'
  const T = new Date('2026-11-04T12:00:00Z')
  let stripe: ReturnType<typeof fakeStripe>
  let chain: ReturnType<typeof fakePolygon>
  const prev = { enabled: config.studioEnabled, image: config.studioWorkerImage, key: config.stripeSecretKey, recipient: config.studioMana.recipient }
  beforeAll(() => {
    ;(config as any).studioEnabled = true
    ;(config as any).studioWorkerImage = 'registry.fly.io/vlm-studio-worker:test'
    ;(config as any).stripeSecretKey = 'sk_test_studio'
  })
  afterAll(() => {
    ;(config as any).studioEnabled = prev.enabled
    ;(config as any).studioWorkerImage = prev.image
    ;(config as any).stripeSecretKey = prev.key
    ;(config.studioMana as any).recipient = prev.recipient
    setStripe(null); setMachineDeps(null); setStudioStore(null); setManaRateSource(null); setPolygon(null)
  })
  beforeEach(async () => {
    await resetDb()
    ;(config.studioMana as any).recipient = RECIPIENT
    setManaRateSource(async () => 0.25)
    stripe = fakeStripe()
    setStripe(stripe)
    setMachineDeps({ fly: fakeFly() })
    setStudioStore(memoryStudioStore())
    chain = fakePolygon({ t0: T })
    setPolygon(chain)
  })
  const paymentOf = async (id: string) => (await db.select().from(studioPayments).where(eq(studioPayments.id, id)))[0]

  it('expires the card and MANA checkouts covering a finalized piece, leaves others, and a late MANA transfer comes back as credit', async () => {
    const owner = await createUser()
    const admin = await createUser({ role: 'admin' })
    const d = await createDesign(owner)
    await addRevision(d, 'hat')
    await addRevision(d, 'upper_body')
    const ownerUser = { id: owner.id, email: owner.email ?? null }
    const card = await createFinalizeCheckout(d, ownerUser, ['hat'], {}, T, 'card') as { url: string }
    expect(card.url).toBeTruthy()
    const { mana } = await createFinalizeCheckout(d, ownerUser, ['hat'], {}, T, 'mana') as { mana: ManaQuote }
    const other = await createFinalizeCheckout(d, ownerUser, ['upper_body'], {}, T, 'card') as { url: string }
    const pays = await db.select().from(studioPayments)
    const cardPay = pays.find((p) => p.method === 'card' && p.lines.some((l) => l.category === 'hat'))!
    const otherPay = pays.find((p) => p.lines.some((l) => l.category === 'upper_body'))!
    expect(other.url).toBeTruthy()

    const later = new Date(T.getTime() + 60_000)
    expect(await createFinalizeCheckout(d, ownerUser, ['hat'], {}, later, 'card', { byAdminId: admin.id })).toMatchObject({ granted: true })
    expect(stripe.calls.expired).toEqual([cardPay.stripeSessionId])
    expect(await paymentOf(cardPay.id)).toMatchObject({ status: 'expired' })
    expect(await paymentOf(mana.paymentId)).toMatchObject({ status: 'expired' })
    expect(await paymentOf(otherPay.id)).toMatchObject({ status: 'pending' })

    // The owner had already sent the MANA: the existing path reopens and grants it, and owes the piece back as credit
    const hash = chain.send({ to: RECIPIENT, amountWei: BigInt(mana.amountWei), at: new Date(T.getTime() + 2 * 60_000) })
    chain.advance(30)
    expect(await watchManaTransfers(new Date(T.getTime() + 3 * 60_000))).toEqual({ matched: 1, unmatched: 0 })
    expect(hash).toBeTruthy()
    expect(await paymentOf(mana.paymentId)).toMatchObject({ status: 'paid' })
    const ents = await db.select().from(studioEntitlements).where(eq(studioEntitlements.category, 'hat'))
    expect(ents).toHaveLength(1)
    expect(await creditBalance(owner.id)).toBe((await paymentOf(mana.paymentId)).amountCents)
  })
})
