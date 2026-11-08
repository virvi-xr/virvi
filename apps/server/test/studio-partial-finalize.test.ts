import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import Stripe from 'stripe'
import { and, eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioDesigns, studioEmoteChecks, studioEntitlements, studioFinalizeCredits, studioJobs, studioPayments, studioPieces, studioSetRenders } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { setStripe } from '../src/integrations/stripe.js'
import { memoryStudioStore, setStudioStore, jobFileKey } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { currentRevisions } from '../src/studio/sets.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { createDesign, addRevision, entitle, fakeFly, fakeStripe, issueWorker, okResult } from './helpers/studio.js'

const S = '/api/studio'
const WEBHOOK_SECRET = 'whsec_studio_partial'
const signer = new Stripe('sk_test_dummy')
const OK = { pass: true, failures: 0, warnings: 0 }

/** LIV-81: choosing which pieces to finalize, and a design that is partly finalized. */
describe('finalizing some of the pieces', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let store: ReturnType<typeof memoryStudioStore>
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
    store = memoryStudioStore()
    setStudioStore(store)
    stripe = fakeStripe()
    setStripe(stripe)
    setMachineDeps({ fly: fakeFly() })
    app = await testApp()
  })

  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const quote = (u: TestUser, id: string, categories?: string) =>
    app.inject({ method: 'GET', url: `${S}/designs/${id}/finalize${categories !== undefined ? `?categories=${categories}` : ''}`, headers: as(u) })
  const finalize = (u: TestUser, id: string, payload: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: `${S}/designs/${id}/finalize`, headers: as(u), payload })
  const detail = async (u: TestUser, id: string) => (await app.inject({ method: 'GET', url: `${S}/designs/${id}`, headers: as(u) })).json()
  const usage = async (u: TestUser) => (await app.inject({ method: 'GET', url: `${S}/usage`, headers: as(u) })).json()
  async function webhook(type: string, object: Record<string, unknown>) {
    const payload = JSON.stringify({ id: `evt_${Math.random()}`, object: 'event', type, data: { object } })
    const res = await app.inject({
      method: 'POST', url: '/api/billing/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }) },
      payload,
    })
    expect(res.statusCode).toBe(200)
  }
  const paid = (paymentId: string, intent = 'pi_1') => webhook('checkout.session.completed', {
    id: 'cs_x', object: 'checkout.session', mode: 'payment', payment_status: 'paid', payment_intent: intent,
    metadata: { vlm_studio_payment_id: paymentId, vlm_user_id: 'x' },
  })
  const pendingPayment = async (designId: string) =>
    (await db.select().from(studioPayments).where(and(eq(studioPayments.designId, designId), eq(studioPayments.status, 'pending'))))[0]
  const entitlements = (designId: string) => db.select().from(studioEntitlements).where(eq(studioEntitlements.designId, designId))
  const finalizeJobs = (designId: string) =>
    db.select().from(studioJobs).where(and(eq(studioJobs.designId, designId), eq(studioJobs.type, 'finalize')))

  /** The worker builds an entitlement's package: its finalize job uploads the zip and reports ok. */
  async function packageIt(designId: string, jobId: string, category: string) {
    const [d] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, designId))
    const token = await issueWorker(d, d.machineId ?? 'm-test')
    await db.update(studioJobs).set({ status: 'taken', takenAt: new Date() }).where(eq(studioJobs.id, jobId))
    const path = `final/${category}/package.zip`
    const put = await app.inject({
      method: 'PUT', url: `${S}/worker/jobs/${jobId}/files/${path}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/zip' }, payload: Buffer.from(`PK-${category}`),
    })
    expect(put.statusCode).toBe(204)
    const res = await app.inject({
      method: 'POST', url: `${S}/worker/jobs/${jobId}/result`, headers: { authorization: `Bearer ${token}` },
      payload: { outcome: 'ok', pieces: [{ category, files: [path], finalize: {} }], costUsd: null } as any,
    })
    expect(res.statusCode).toBe(204)
  }

  /** A piece's latest revision, as entitle() takes it. */
  async function latest(designId: string, category: string) {
    const [p] = await db.select().from(studioPieces).where(and(eq(studioPieces.designId, designId), eq(studioPieces.category, category)))
    return { id: p.latestRevisionId!, pieceId: p.id }
  }

  /** A four-piece collection, every piece built and passing. */
  async function collection(u: TestUser) {
    const d = await createDesign(u, { name: 'Street set' })
    for (const c of ['feet', 'hat', 'lower_body', 'upper_body']) await addRevision(d, c)
    return d
  }

  describe('the live quote', () => {
    it('?categories= prices only the chosen pieces: the first full price, the rest extra pieces', async () => {
      const u = await createUser()
      const d = await collection(u)
      const all = (await quote(u, d.id)).json()
      expect(all.lines.map((l: any) => [l.category, l.priceKind, l.amountCents])).toEqual([
        ['feet', 'first', 2900], ['hat', 'first_extra', 1900], ['lower_body', 'first_extra', 1900], ['upper_body', 'first_extra', 1900],
      ])
      const some = await quote(u, d.id, 'upper_body,hat')
      expect(some.statusCode).toBe(200)
      expect(some.json().lines.map((l: any) => [l.category, l.priceKind, l.amountCents])).toEqual([
        ['hat', 'first', 2900], ['upper_body', 'first_extra', 1900],
      ])
      expect(some.json()).toMatchObject({ totalCents: 4800, dueCents: 4800 })
      // every piece is still listed, so the dialog can show what wasn't ticked
      expect(some.json().pieces.map((p: any) => p.category)).toEqual(['feet', 'hat', 'lower_body', 'upper_body'])
    })

    it('a free finalize follows the selection', async () => {
      const u = await createUser()
      const d = await collection(u)
      await db.insert(studioFinalizeCredits).values({ userId: u.id, balance: 1 })
      const q = (await quote(u, d.id, 'lower_body')).json()
      expect(q.lines).toEqual([expect.objectContaining({ category: 'lower_body', priceKind: 'first', amountCents: 2900, gift: true })])
      expect(q).toMatchObject({ totalCents: 0, giftsUsed: 1 })
    })

    it('a bad selection is refused as the checkout refuses it', async () => {
      const u = await createUser()
      const d = await createDesign(u)
      await addRevision(d, 'hat')
      await addRevision(d, 'feet', { pass: false, failures: 1, warnings: 0 })
      expect((await quote(u, d.id, 'Hat;drop')).statusCode).toBe(400)
      const unknown = await quote(u, d.id, 'hat,eyewear')
      expect([unknown.statusCode, unknown.json().code, unknown.json().categories]).toEqual([400, 'unknown_piece', ['eyewear']])
      const failing = await quote(u, d.id, 'feet')
      expect([failing.statusCode, failing.json().code]).toEqual([409, 'checks_failed'])
      // an empty selection is no selection: the whole quote, as before
      expect((await quote(u, d.id, '')).json().lines.map((l: any) => l.category)).toEqual(['hat'])
    })
  })

  it('paying for 2 of 4 grants and packages those 2; the design is partly finalized and still open', async () => {
    const u = await createUser()
    const d = await collection(u)
    const res = await finalize(u, d.id, { categories: ['hat', 'upper_body'] })
    expect(res.statusCode).toBe(200)
    expect(stripe.calls.sessions[0].line_items.map((l: any) => [l.price_data.product_data.name, l.price_data.unit_amount])).toEqual([
      ['Neon hat: finalize', 2900], ['Neon upper_body: finalize', 1900],
    ])
    await paid((await pendingPayment(d.id)).id)

    const ents = await entitlements(d.id)
    expect(ents.map((e) => [e.category, e.amountCents]).sort()).toEqual([['hat', 2900], ['upper_body', 1900]])
    const jobs = await finalizeJobs(d.id)
    expect(jobs.map((j) => (j.payload as any).finalize.pieces[0].category).sort()).toEqual(['hat', 'upper_body'])

    const body = await detail(u, d.id)
    expect(body.design).toMatchObject({ finalizedPieces: 2, pieceCount: 4 })
    expect(body.design.finalizedAt).not.toBeNull()
    const list = (await app.inject({ method: 'GET', url: `${S}/designs`, headers: as(u) })).json()
    expect(list[0]).toMatchObject({ id: d.id, finalizedPieces: 2, pieceCount: 4 })
    // still open: it counts toward the limit, so another design doesn't fit the free plan's one
    expect((await usage(u)).openDesigns).toBe(1)
    const another = await app.inject({ method: 'POST', url: `${S}/designs`, headers: as(u), payload: { kind: 'wearable', agent: 'claude' } })
    expect([another.statusCode, another.json().code]).toEqual([403, 'open_design_limit'])
    // and open for prompts on the rest
    const p = await app.inject({ method: 'POST', url: `${S}/designs/${d.id}/prompts`, headers: as(u), payload: { text: 'make the boots taller', selectedSlots: ['feet'] } })
    expect(p.statusCode).toBe(202)

    // each finalized piece downloads as soon as its package is built
    const hatJob = jobs.find((j) => (j.payload as any).finalize.pieces[0].category === 'hat')!
    await packageIt(d.id, hatJob.id, 'hat')
    const dl = await app.inject({ method: 'GET', url: `${S}/designs/${d.id}/pieces/hat/revisions/1/package`, headers: as(u) })
    expect([dl.statusCode, dl.rawPayload.toString()]).toEqual([200, 'PK-hat'])
    const unpaid = await app.inject({ method: 'GET', url: `${S}/designs/${d.id}/pieces/feet/revisions/1/package`, headers: as(u) })
    expect(unpaid.statusCode).toBe(402)
  })

  it('finalizing the rest later charges extra-piece prices and leaves the first packages alone', async () => {
    const u = await createUser()
    const d = await collection(u)
    await finalize(u, d.id, { categories: ['hat', 'upper_body'] })
    await paid((await pendingPayment(d.id)).id, 'pi_first')
    for (const j of await finalizeJobs(d.id)) await packageIt(d.id, j.id, (j.payload as any).finalize.pieces[0].category)
    const before = (await entitlements(d.id)).map((e) => ({ id: e.id, packageKey: e.packageKey, jobId: e.jobId }))
    expect(before.every((e) => e.packageKey)).toBe(true)

    const rest = (await quote(u, d.id)).json()
    expect(rest.lines.map((l: any) => [l.category, l.priceKind, l.amountCents])).toEqual([['feet', 'first_extra', 1900], ['lower_body', 'first_extra', 1900]])
    expect(rest.pieces.filter((p: any) => p.state === 'entitled').map((p: any) => p.category)).toEqual(['hat', 'upper_body'])
    await finalize(u, d.id, { categories: ['feet', 'lower_body'] })
    expect(stripe.calls.sessions[1].line_items.map((l: any) => l.price_data.unit_amount)).toEqual([1900, 1900])
    await paid((await pendingPayment(d.id)).id, 'pi_rest')

    const after = await entitlements(d.id)
    expect(after).toHaveLength(4)
    for (const b of before) expect(after.find((e) => e.id === b.id)).toMatchObject({ packageKey: b.packageKey, jobId: b.jobId, status: 'ready' })
    const jobs = await finalizeJobs(d.id)
    expect(jobs.map((j) => (j.payload as any).finalize.pieces[0].category).sort()).toEqual(['feet', 'hat', 'lower_body', 'upper_body'])
    // every piece finalized: the design is finalized and no longer open
    expect((await detail(u, d.id)).design).toMatchObject({ finalizedPieces: 4, pieceCount: 4 })
    expect((await usage(u)).openDesigns).toBe(0)
  })

  describe('which designs count as open (fix round 1, I1)', () => {
    it('everything ticked with a blocked piece closes the design, as before', async () => {
      const u = await createUser()
      const d = await createDesign(u)
      await addRevision(d, 'hat')
      await addRevision(d, 'upper_body')
      await addRevision(d, 'feet', { pass: false, failures: 1, warnings: 0 })
      expect((await finalize(u, d.id)).statusCode).toBe(200)
      await paid((await pendingPayment(d.id)).id)
      expect((await entitlements(d.id)).map((e) => e.category).sort()).toEqual(['hat', 'upper_body'])
      expect((await usage(u)).openDesigns).toBe(0)
      // once the boots pass the checker they can be finalized: the design is open again until they are
      await addRevision(d, 'feet')
      expect((await usage(u)).openDesigns).toBe(1)
    })

    it('finalizing 1 of 3 finalizable pieces leaves the design open', async () => {
      const u = await createUser()
      const d = await createDesign(u)
      for (const c of ['feet', 'hat', 'upper_body']) await addRevision(d, c)
      await finalize(u, d.id, { categories: ['hat'] })
      await paid((await pendingPayment(d.id)).id)
      expect((await usage(u)).openDesigns).toBe(1)
    })

    it('a finalized design that gains a piece stays closed until the piece has a revision', async () => {
      const u = await createUser()
      const d = await createDesign(u)
      await entitle(d, await addRevision(d, 'hat'))
      expect((await usage(u)).openDesigns).toBe(0)
      await db.insert(studioPieces).values({ designId: d.id, category: 'feet', name: 'Neon boots' })
      expect((await usage(u)).openDesigns).toBe(0)
      await addRevision(d, 'feet')
      expect((await usage(u)).openDesigns).toBe(1)
    })
  })

  it('the open-design limit says partly finalized designs count', async () => {
    const u = await createUser()
    const d = await collection(u)
    await entitle(d, await latest(d.id, 'hat'))
    const res = await app.inject({ method: 'POST', url: `${S}/designs`, headers: as(u), payload: { kind: 'wearable', agent: 'claude' } })
    expect(res.json()).toEqual({
      error: 'Your plan has no room for another open design. Designs with pieces left to finalize count as open: finalize or archive one to make room.',
      code: 'open_design_limit',
    })
  })

  it('archiving a partly finalized design frees its slot', async () => {
    const u = await createUser()
    const d = await collection(u)
    await entitle(d, await latest(d.id, 'hat'))
    expect((await usage(u)).openDesigns).toBe(1)
    await app.inject({ method: 'PATCH', url: `${S}/designs/${d.id}`, headers: as(u), payload: { archived: true } })
    expect((await usage(u)).openDesigns).toBe(0)
  })

  it('everything ticked behaves as before: no categories, every payable piece, fully finalized', async () => {
    const u = await createUser()
    const d = await collection(u)
    expect((await finalize(u, d.id)).statusCode).toBe(200)
    expect(stripe.calls.sessions[0].line_items.map((l: any) => l.price_data.unit_amount)).toEqual([2900, 1900, 1900, 1900])
    await paid((await pendingPayment(d.id)).id)
    expect(await entitlements(d.id)).toHaveLength(4)
    expect((await detail(u, d.id)).design).toMatchObject({ finalizedPieces: 4, pieceCount: 4 })
    expect((await usage(u)).openDesigns).toBe(0)
    // a later revision of a finalized piece keeps it finalized (a paid revision, as before)
    await addRevision(d, 'hat')
    expect((await detail(u, d.id)).design).toMatchObject({ finalizedPieces: 4, pieceCount: 4 })
    expect((await usage(u)).openDesigns).toBe(0)
  })

  describe('a building with furnishings', () => {
    const house = (d: { id: string }) => addRevision(d, 'building', OK, { kind: 'building', footprint: '1x1' })
    const chair = (d: { id: string }, c = 'furniture_chair') => addRevision(d, c, OK, { kind: 'furniture', type: 'chair' })
    async function scene(u: TestUser) {
      const d = await createDesign(u, { kind: 'scene' })
      await house(d)
      await chair(d)
      await chair(d, 'furniture_table')
      return d
    }
    const priced = (q: any) => q.lines.map((l: any) => [l.category, l.priceKind, l.amountCents])

    it('furniture only, building only, or both: the quote says which line is the first', async () => {
      const u = await createUser()
      const d = await scene(u)
      expect(priced((await quote(u, d.id, 'furniture_table,furniture_chair')).json())).toEqual([
        ['furniture_chair', 'first', 900], ['furniture_table', 'first_extra', 500],
      ])
      expect(priced((await quote(u, d.id, 'building')).json())).toEqual([['building', 'first', 2900]])
      expect(priced((await quote(u, d.id, 'building,furniture_chair')).json())).toEqual([
        ['building', 'first', 2900], ['furniture_chair', 'first_extra', 500],
      ])
    })

    it('furniture finalized before its building: then the building alone, at its own price', async () => {
      const u = await createUser()
      const d = await scene(u)
      await finalize(u, d.id, { categories: ['furniture_chair'] })
      await paid((await pendingPayment(d.id)).id)
      expect((await entitlements(d.id)).map((e) => [e.category, e.amountCents])).toEqual([['furniture_chair', 900]])
      expect((await detail(u, d.id)).design).toMatchObject({ finalizedPieces: 1, pieceCount: 3 })
      expect(priced((await quote(u, d.id)).json())).toEqual([['building', 'first', 2900], ['furniture_table', 'first_extra', 500]])
      expect(priced((await quote(u, d.id, 'building')).json())).toEqual([['building', 'first', 2900]])
      await finalize(u, d.id, { categories: ['building'] })
      await paid((await pendingPayment(d.id)).id, 'pi_b')
      expect((await entitlements(d.id)).map((e) => e.category).sort()).toEqual(['building', 'furniture_chair'])
    })
  })

  describe('the emote checklist for a selection', () => {
    const setRender = (u: TestUser, id: string, body: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: `${S}/designs/${id}/set-renders`, headers: as(u), payload: body })
    const setJobs = async (designId: string) =>
      (await db.select().from(studioJobs).where(and(eq(studioJobs.designId, designId), eq(studioJobs.type, 'render'))))
        .filter((j) => (j.payload as any).render?.set)

    it('renders the chosen pieces and the finalized ones worn together, never the others', async () => {
      const u = await createUser()
      const d = await collection(u)
      // the hat is finalized already
      const hat = await latest(d.id, 'hat')
      await entitle(d, hat)
      const res = await setRender(u, d.id, { bodyShape: 'male', outfit: 'default', emote: 'dance', categories: ['upper_body'] })
      expect(res.json()).toEqual({ status: 'queued' })
      const [job] = await setJobs(d.id)
      expect((job.payload as any).render).toEqual({ set: true, bodyShape: 'male', outfit: 'default', emote: 'dance', categories: ['hat', 'upper_body'] })
      const worn = [hat.id, (await latest(d.id, 'upper_body')).id].sort().join(',')
      expect((job.payload as any).revisions).toBe(worn)
      const [row] = await db.select().from(studioSetRenders).where(eq(studioSetRenders.jobId, job.id))
      expect(row.revisions).toBe(worn)

      // looks fine, for that selection: the selection's checklist has it, the whole set's doesn't
      const ok = await app.inject({ method: 'POST', url: `${S}/designs/${d.id}/emote-checks`, headers: as(u), payload: { emote: 'dance', bodyShape: 'male', state: 'fine', categories: ['upper_body'] } })
      expect(ok.statusCode).toBe(204)
      const sel = await app.inject({ method: 'GET', url: `${S}/designs/${d.id}/set?categories=upper_body`, headers: as(u) })
      expect(sel.statusCode).toBe(200)
      expect(sel.json()).toMatchObject({ revisions: worn, checks: [{ emote: 'dance', bodyShape: 'male', state: 'fine' }] })
      expect(sel.json().views['walk-male-default-dance']).toMatchObject({ status: 'queued' })
      expect((await detail(u, d.id)).set.checks).toEqual([])
      // a change to a piece that isn't worn doesn't make the selection's check stale
      await addRevision(d, 'feet')
      expect((await app.inject({ method: 'GET', url: `${S}/designs/${d.id}/set?categories=upper_body`, headers: as(u) })).json().checks).toHaveLength(1)
      // Finalize's renders for a selection are the selection's
      const fin = await app.inject({ method: 'POST', url: `${S}/designs/${d.id}/finalize-renders`, headers: as(u), payload: { categories: ['upper_body'] } })
      expect(fin.json()).toEqual({ queued: 13 })
      expect((await setJobs(d.id)).every((j) => (j.payload as any).render.categories?.join() === 'hat,upper_body')).toBe(true)
    })

    it('clipping seen in a selection’s view is fixed looking at the same pieces worn', async () => {
      const u = await createUser()
      const d = await collection(u)
      await setRender(u, d.id, { bodyShape: 'female', outfit: 'default', emote: 'dance', categories: ['hat', 'feet'] })
      const [job] = await setJobs(d.id)
      // not seen yet: only the whole set's view would count, and there is none
      const early = await app.inject({ method: 'POST', url: `${S}/designs/${d.id}/clipping`, headers: as(u), payload: { emote: 'dance', bodyShape: 'female', outfit: 'default', categories: ['hat', 'feet'] } })
      expect(early.json().code).toBe('not_seen')
      await db.update(studioSetRenders).set({ status: 'ready', frames: 96 }).where(eq(studioSetRenders.jobId, job.id))
      await db.update(studioJobs).set({ status: 'done' }).where(eq(studioJobs.id, job.id))
      const whole = await app.inject({ method: 'POST', url: `${S}/designs/${d.id}/clipping`, headers: as(u), payload: { emote: 'dance', bodyShape: 'female', outfit: 'default' } })
      expect(whole.json().code).toBe('not_seen')
      const res = await app.inject({ method: 'POST', url: `${S}/designs/${d.id}/clipping`, headers: as(u), payload: { emote: 'dance', bodyShape: 'female', outfit: 'default', categories: ['hat', 'feet'] } })
      expect(res.statusCode).toBe(202)
      const [fix] = await db.select().from(studioJobs).where(eq(studioJobs.id, res.json().jobId))
      expect((fix.payload as any).fixClipping).toEqual({ emote: 'dance', bodyShape: 'female', outfit: 'default', categories: ['feet', 'hat'] })
      const sel = (await app.inject({ method: 'GET', url: `${S}/designs/${d.id}/set?categories=hat,feet`, headers: as(u) })).json()
      expect(sel.checks).toEqual([{ emote: 'dance', bodyShape: 'female', state: 'clipping' }])
      // the fix lands: that view is rendered again, for the same pieces
      const [row] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, d.id))
      const token = await issueWorker(row, row.machineId ?? 'm-test')
      await db.update(studioJobs).set({ status: 'taken', takenAt: new Date() }).where(eq(studioJobs.id, fix.id))
      const done = await app.inject({ method: 'POST', url: `${S}/worker/jobs/${fix.id}/result`, headers: { authorization: `Bearer ${token}` }, payload: okResult(fix.id) as any })
      expect(done.statusCode).toBe(204)
      const again = (await setJobs(d.id)).filter((j) => j.status === 'queued')
      expect(again.map((j) => (j.payload as any).render)).toEqual([
        { set: true, bodyShape: 'female', outfit: 'default', emote: 'dance', categories: ['feet', 'hat'] },
      ])
    })

    it('a selection of every piece is the whole set, as before', async () => {
      const u = await createUser()
      const d = await collection(u)
      await setRender(u, d.id, { bodyShape: 'male', outfit: 'default', emote: 'run', categories: ['feet', 'hat', 'lower_body', 'upper_body'] })
      const [job] = await setJobs(d.id)
      expect((job.payload as any).render).toEqual({ set: true, bodyShape: 'male', outfit: 'default', emote: 'run' })
      expect((job.payload as any).revisions).toBe(await currentRevisions(d.id))
      const sel = (await app.inject({ method: 'GET', url: `${S}/designs/${d.id}/set?categories=feet,hat,lower_body,upper_body`, headers: as(u) })).json()
      expect(sel.revisions).toBe((await detail(u, d.id)).set.revisions)
      expect((await app.inject({ method: 'GET', url: `${S}/designs/${d.id}/set`, headers: as(u) })).json().revisions).toBe(sel.revisions)
    })

    it('a prompt that changes a worn piece cancels the selection’s queued render; one that changes another piece doesn’t', async () => {
      const u = await createUser()
      const d = (await app.inject({ method: 'POST', url: `${S}/designs`, headers: as(u), payload: { kind: 'wearable', agent: 'claude' } })).json()
      await addRevision(d, 'upper_body')
      const first = (await app.inject({ method: 'POST', url: `${S}/designs/${d.id}/prompts`, headers: as(u), payload: { text: 'a neon cap', selectedSlots: ['hat'] } })).json().jobId
      const finish = async (jobId: string) => {
        const [row] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, d.id))
        const token = await issueWorker(row, row.machineId ?? 'm-test')
        await db.update(studioJobs).set({ status: 'taken', takenAt: new Date() }).where(eq(studioJobs.id, jobId))
        const r = await app.inject({ method: 'POST', url: `${S}/worker/jobs/${jobId}/result`, headers: { authorization: `Bearer ${token}` }, payload: okResult(jobId) as any })
        expect(r.statusCode).toBe(204)
      }
      await finish(first)
      await setRender(u, d.id, { bodyShape: 'male', outfit: 'default', emote: 'run', categories: ['upper_body'] })
      const [jacketOnly] = await setJobs(d.id)
      // the hat changes: the jacket-only view is still the jacket as it is
      const second = (await app.inject({ method: 'POST', url: `${S}/designs/${d.id}/prompts`, headers: as(u), payload: { text: 'make it pink', selectedSlots: ['hat'] } })).json().jobId
      await finish(second)
      expect((await db.select().from(studioJobs).where(eq(studioJobs.id, jacketOnly.id)))[0].status).toBe('queued')
      await setRender(u, d.id, { bodyShape: 'male', outfit: 'default', emote: 'run', categories: ['hat'] })
      const hatOnly = (await setJobs(d.id)).find((j) => j.id !== jacketOnly.id)!
      const third = (await app.inject({ method: 'POST', url: `${S}/designs/${d.id}/prompts`, headers: as(u), payload: { text: 'make it blue', selectedSlots: ['hat'] } })).json().jobId
      await finish(third)
      expect((await db.select().from(studioJobs).where(eq(studioJobs.id, hatOnly.id)))[0].status).toBe('failed')
      expect((await db.select().from(studioJobs).where(eq(studioJobs.id, jacketOnly.id)))[0].status).toBe('queued')
      expect(await db.select().from(studioEmoteChecks)).toEqual([])
    })
  })
})
