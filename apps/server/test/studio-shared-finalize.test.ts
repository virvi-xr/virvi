import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { assetLibraryItems, studioDesignMembers, studioEntitlements, studioFinalizeCredits, studioJobs, studioPayments, studioRevisions } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { setStripe } from '../src/integrations/stripe.js'
import { memoryStudioStore, setStudioStore, jobFileKey } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { addCredit, creditBalance } from '../src/studio/credit.js'
import { grantPayment } from '../src/studio/payments.js'
import { addToLibrary, setLibraryStorage } from '../src/studio/library.js'
import { setManaRateSource } from '../src/studio/mana/rate.js'
import type { StorageProvider } from '../src/storage/index.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { addRevision, createDesign, entitle, fakeFly, fakeStripe } from './helpers/studio.js'

const S = '/api/studio'
const H = 3600_000
const CHAIR_GLB = readFileSync(new URL('../../studio-worker/tests/fixtures/scene/furniture_chair/chair.glb', import.meta.url))

/** Finalizing a shared design (LIV-159): whoever pays is charged and owns the payment; every member downloads. */
describe('finalizing a shared design', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let store: ReturnType<typeof memoryStudioStore>
  let stripe: ReturnType<typeof fakeStripe>
  let owner: TestUser
  let collab: TestUser
  const prev = {
    enabled: config.studioEnabled, key: config.stripeSecretKey, image: config.studioWorkerImage, recipient: config.studioMana.recipient,
  }
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
    setStripe(null)
    setMachineDeps(null)
    setStudioStore(null)
    setLibraryStorage(null)
    setManaRateSource(null)
  })
  beforeEach(async () => {
    await resetDb()
    store = memoryStudioStore()
    setStudioStore(store)
    stripe = fakeStripe()
    setStripe(stripe)
    setMachineDeps({ fly: fakeFly() })
    app = await testApp()
    owner = await createUser({ name: 'Olive Owner' })
    collab = await createUser({ name: 'Cole Collab' })
  })

  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const join = async (designId: string, u: TestUser, role: 'collaborator' | 'viewer', over: { joinedAt?: Date; leftAt?: Date } = {}) => {
    await db.insert(studioDesignMembers).values({ designId, userId: u.id, role, ...over })
  }
  /** The owner's design shared with the collaborator, with a hat to finalize. */
  async function shared(opts: Parameters<typeof createDesign>[1] = {}) {
    const d = await createDesign(owner, opts)
    await join(d.id, collab, 'collaborator')
    const rev = await addRevision(d, 'hat')
    return { d, rev }
  }
  const finalize = (u: TestUser, id: string, payload: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: `${S}/designs/${id}/finalize`, headers: as(u), payload })
  const give = (u: TestUser, cents: number) => db.transaction((tx) => addCredit(tx, u.id, cents, 'refund', null, new Date()))
  const gifts = (u: TestUser, balance: number) => db.insert(studioFinalizeCredits).values({ userId: u.id, balance, updatedAt: new Date() })
  const giftsOf = async (u: TestUser) => (await db.select().from(studioFinalizeCredits).where(eq(studioFinalizeCredits.userId, u.id)))[0]?.balance ?? 0
  const paymentsOf = (designId: string) => db.select().from(studioPayments).where(eq(studioPayments.designId, designId))

  /** Makes an entitlement's package ready, as a finalize job finishing at `at` would. */
  async function readyAt(e: { id: string; designId: string; category: string }, at: Date) {
    const [job] = await db.insert(studioJobs).values({ designId: e.designId, type: 'finalize', status: 'done', payload: {}, finishedAt: at }).returning()
    const packageKey = jobFileKey(e.designId, job.id, `final/${e.category}/package.zip`)
    await store.put(packageKey, Buffer.from(`PK-${e.id}`), 'application/zip')
    await db.update(studioEntitlements).set({ status: 'ready', jobId: job.id, packageKey }).where(eq(studioEntitlements.id, e.id))
  }

  it('a collaborator pays by card; only they are recorded and charged', async () => {
    const { d } = await shared()
    const res = await finalize(collab, d.id)
    expect(res.statusCode).toBe(200)
    expect(res.json().url).toMatch(/^https:\/\/checkout\.stripe\.test\//)
    expect(stripe.calls.customers).toMatchObject([{ email: collab.email, metadata: { vlm_user_id: collab.id } }])
    expect(stripe.calls.sessions[0].metadata).toMatchObject({ vlm_user_id: collab.id })
    const [pay] = await paymentsOf(d.id)
    expect(pay).toMatchObject({ userId: collab.id, method: 'card', status: 'pending' })
    expect(await grantPayment(pay.id, 'pi_collab', new Date())).toBe('granted')
    const [e] = await db.select().from(studioEntitlements).where(eq(studioEntitlements.designId, d.id))
    expect(e).toMatchObject({ userId: collab.id, paymentId: pay.id })
  })

  it("a collaborator pays with credit; the owner's credit is untouched", async () => {
    const { d } = await shared()
    await give(collab, 5000)
    await give(owner, 5000)
    const res = await finalize(collab, d.id)
    expect(res.json()).toMatchObject({ granted: true })
    expect(stripe.calls.sessions).toHaveLength(0)
    const [pay] = await paymentsOf(d.id)
    expect(pay).toMatchObject({ userId: collab.id, method: 'credit', status: 'paid', creditHeldCents: 2900 })
    expect(await creditBalance(collab.id)).toBe(2100)
    expect(await creditBalance(owner.id)).toBe(5000)
    const [e] = await db.select().from(studioEntitlements).where(eq(studioEntitlements.designId, d.id))
    expect(e).toMatchObject({ userId: collab.id, method: 'credit', creditCents: 2900 })
  })

  it("a collaborator pays with a free finalize; the owner's free finalizes are untouched", async () => {
    const { d } = await shared()
    await gifts(collab, 1)
    await gifts(owner, 1)
    const res = await finalize(collab, d.id)
    expect(res.json()).toMatchObject({ granted: true })
    const [pay] = await paymentsOf(d.id)
    expect(pay).toMatchObject({ userId: collab.id, status: 'paid', giftsHeld: 1 })
    expect(await giftsOf(collab)).toBe(0)
    expect(await giftsOf(owner)).toBe(1)
  })

  it("a collaborator's MANA quote is theirs and leaves the owner's open quote alone", async () => {
    ;(config.studioMana as any).recipient = '0x01d871870CbBddE934526E17637c0cfEf0b3b38B'
    setManaRateSource(async () => 0.25)
    const { d } = await shared()
    await addRevision(d, 'feet')
    const mine = await finalize(owner, d.id, { method: 'mana', categories: ['feet'] })
    expect(mine.statusCode).toBe(200)
    const res = await finalize(collab, d.id, { method: 'mana', categories: ['hat'] })
    expect(res.statusCode).toBe(200)
    const pays = await paymentsOf(d.id)
    expect(pays.find((p) => p.id === res.json().mana.paymentId)).toMatchObject({ userId: collab.id, method: 'mana', status: 'pending' })
    expect(pays.find((p) => p.id === mine.json().mana.paymentId)).toMatchObject({ userId: owner.id, status: 'pending' })
  })

  it('a second member\'s checkout for the same revision is refused while one is open', async () => {
    const { d } = await shared()
    await addRevision(d, 'feet')
    const first = await finalize(owner, d.id, { categories: ['hat'] })
    expect(first.statusCode).toBe(200)
    const second = await finalize(collab, d.id, { categories: ['hat', 'feet'] })
    expect(second.statusCode).toBe(409)
    expect(second.json()).toMatchObject({ code: 'checkout_open' })
    // the owner's own checkout is handed out again, and another piece is the collaborator's to pay for
    expect((await finalize(owner, d.id, { categories: ['hat'] })).json().url).toBe(first.json().url)
    const feet = await finalize(collab, d.id, { categories: ['feet'] })
    expect(feet.statusCode).toBe(200)
    expect(stripe.calls.expired).toEqual([])
    const pays = await paymentsOf(d.id)
    expect(pays.map((p) => [p.userId, p.status]).sort()).toEqual([[collab.id, 'pending'], [owner.id, 'pending']].sort())
  })

  it('every member downloads the package whoever paid', async () => {
    const { d, rev } = await shared()
    const viewer = await createUser()
    await join(d.id, viewer, 'viewer')
    const { entitlement } = await entitle(d, rev, { userId: collab.id })
    await readyAt(entitlement, new Date())
    for (const u of [owner, collab, viewer]) {
      const one = await app.inject({ method: 'GET', url: `${S}/designs/${d.id}/pieces/hat/revisions/1/package`, headers: as(u) })
      expect(one.statusCode).toBe(200)
      expect(one.rawPayload.toString()).toBe(`PK-${entitlement.id}`)
      expect((await app.inject({ method: 'GET', url: `${S}/designs/${d.id}/packages`, headers: as(u) })).statusCode).toBe(200)
    }
    const stranger = await createUser()
    expect((await app.inject({ method: 'GET', url: `${S}/designs/${d.id}/pieces/hat/revisions/1/package`, headers: as(stranger) })).statusCode).toBe(404)
  })

  it('only the payer can report a mistake', async () => {
    const { d, rev } = await shared()
    await entitle(d, rev)
    const rev2 = await addRevision(d, 'hat')
    await entitle(d, rev2, { userId: collab.id, paymentIntent: 'pi_collab' })
    const report = (u: TestUser) => app.inject({
      method: 'POST', url: `${S}/designs/${d.id}/pieces/hat/revisions/2/report`, headers: as(u), payload: { text: 'the agent broke the visor' },
    })
    // the page offers the report to the payer alone
    const offered = async (u: TestUser) => {
      const res = await app.inject({ method: 'GET', url: `${S}/designs/${d.id}`, headers: as(u) })
      return res.json().pieces[0].finalized.find((f: any) => f.revision === 2).reportableUntil
    }
    expect(await offered(owner)).toBeNull()
    expect(await offered(collab)).toEqual(expect.any(String))
    const theirs = await report(owner)
    expect(theirs.statusCode).toBe(404)
    expect(theirs.json()).toMatchObject({ code: 'not_found' })
    expect(stripe.calls.refunds).toHaveLength(0)
    const res = await report(collab)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'refunded', refundCents: 1500 })
    expect(stripe.calls.refunds[0].params).toMatchObject({ payment_intent: 'pi_collab', amount: 1500 })
  })

  describe("a scene piece goes to the payer's library", () => {
    let uploads: Map<string, Buffer>
    beforeEach(() => {
      uploads = new Map()
      const storage: StorageProvider = {
        upload: async (key, data) => { uploads.set(key, data); return `https://cdn.test/${key}` },
        delete: async (key) => { uploads.delete(key) },
        getPublicUrl: (key) => `https://cdn.test/${key}`,
      }
      setLibraryStorage(storage)
    })

    async function paidChair() {
      const d = await createDesign(owner, { kind: 'scene' })
      await join(d.id, collab, 'collaborator')
      const rev = await addRevision(d, 'furniture_chair', undefined, { kind: 'furniture', type: 'chair', name: 'Neon Chair' })
      const files = ['pieces/furniture_chair/chair.glb']
      await db.update(studioRevisions).set({ files }).where(eq(studioRevisions.id, rev.id))
      await store.put(jobFileKey(d.id, rev.jobId, files[0]), CHAIR_GLB, 'model/gltf-binary')
      const { entitlement, payment } = await entitle(d, rev, { userId: collab.id })
      return { d, entitlement, payment }
    }

    it("a scene piece goes to the payer's library", async () => {
      const { entitlement } = await paidChair()
      expect(await addToLibrary(entitlement.id, new Date())).toHaveLength(1)
      const [row] = await db.select().from(assetLibraryItems)
      expect(row.uploadedBy).toBe(collab.id)
      expect(row.storageKey).toMatch(new RegExp(`^assets/${collab.id}/.+\\.glb$`))
    })

    it("goes to the design owner's library once the payer's account is gone", async () => {
      const { entitlement, payment } = await paidChair()
      await db.update(studioPayments).set({ userId: null }).where(eq(studioPayments.id, payment.id))
      expect(await addToLibrary(entitlement.id, new Date())).toHaveLength(1)
      const [row] = await db.select().from(assetLibraryItems)
      expect(row.uploadedBy).toBe(owner.id)
      expect(row.storageKey).toMatch(new RegExp(`^assets/${owner.id}/`))
    })
  })

  describe('packages finalized while you were on it', () => {
    const list = (u: TestUser) => app.inject({ method: 'GET', url: `${S}/past-packages`, headers: as(u) })
    const pkg = (u: TestUser, id: string) => app.inject({ method: 'GET', url: `${S}/past-packages/${id}/package`, headers: as(u) })

    it('a member who left lists and downloads packages finalized while they were on it, not later ones', async () => {
      const t0 = new Date(Date.now() - 10 * H)
      const d = await createDesign(owner, { name: 'Neon set' })
      await join(d.id, collab, 'collaborator', { joinedAt: new Date(t0.getTime() + H), leftAt: new Date(t0.getTime() + 5 * H) })
      const before = (await entitle(d, await addRevision(d, 'hat'))).entitlement
      await readyAt(before, t0) // ready before they joined
      const during = (await entitle(d, await addRevision(d, 'feet'))).entitlement
      await readyAt(during, new Date(t0.getTime() + 3 * H))
      const after = (await entitle(d, await addRevision(d, 'hat'))).entitlement
      await readyAt(after, new Date(t0.getTime() + 7 * H))

      const res = await list(collab)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual([{
        entitlementId: during.id, designName: 'Neon set', category: 'feet', revisionNumber: 1, finalizedAt: new Date(t0.getTime() + 3 * H).toISOString(),
      }])
      const got = await pkg(collab, during.id)
      expect(got.statusCode).toBe(200)
      expect(got.headers['content-type']).toBe('application/zip')
      expect(got.headers['content-disposition']).toBe('attachment; filename="neon-feet-r1.zip"')
      expect(got.rawPayload.toString()).toBe(`PK-${during.id}`)
      expect((await pkg(collab, before.id)).statusCode).toBe(404)
      expect((await pkg(collab, after.id)).statusCode).toBe(404)
    })

    it('a payer who left keeps what they paid for, even if it was packaged after they left', async () => {
      const t0 = new Date(Date.now() - 10 * H)
      const d = await createDesign(owner)
      await join(d.id, collab, 'collaborator', { joinedAt: t0, leftAt: new Date(t0.getTime() + H) })
      const paid = (await entitle(d, await addRevision(d, 'hat'), { userId: collab.id })).entitlement
      await readyAt(paid, new Date(t0.getTime() + 2 * H))
      expect((await list(collab)).json()).toMatchObject([{ entitlementId: paid.id }])
      expect((await pkg(collab, paid.id)).statusCode).toBe(200)
    })

    it('someone still on the design, the owner and a package not ready yet are not listed', async () => {
      const t0 = new Date(Date.now() - 10 * H)
      const d = await createDesign(owner)
      await join(d.id, collab, 'collaborator', { joinedAt: t0 })
      const ready = (await entitle(d, await addRevision(d, 'hat'))).entitlement
      await readyAt(ready, new Date(t0.getTime() + H))
      // a collaborator who left and came back has a role again: the design's own routes serve them
      const back = await createUser()
      await join(d.id, back, 'viewer', { joinedAt: t0, leftAt: new Date(t0.getTime() + 2 * H) })
      await join(d.id, back, 'viewer', { joinedAt: new Date(t0.getTime() + 3 * H) })
      // a member who left while a package was still being made
      const early = await createUser()
      await join(d.id, early, 'viewer', { joinedAt: t0, leftAt: new Date(t0.getTime() + 2 * H) })
      const packaging = (await entitle(d, await addRevision(d, 'feet'))).entitlement
      await db.update(studioEntitlements).set({ status: 'packaging', packageKey: null }).where(eq(studioEntitlements.id, packaging.id))
      for (const u of [collab, owner, back]) {
        expect((await list(u)).json()).toEqual([])
        expect((await pkg(u, ready.id)).statusCode).toBe(404)
      }
      expect((await list(early)).json()).toMatchObject([{ entitlementId: ready.id }])
      expect((await pkg(early, packaging.id)).statusCode).toBe(404)
    })

    it('a stranger gets 404 on past-packages/:id', async () => {
      const d = await createDesign(owner)
      const e = (await entitle(d, await addRevision(d, 'hat'))).entitlement
      await readyAt(e, new Date())
      const stranger = await createUser()
      expect((await list(stranger)).json()).toEqual([])
      const res = await pkg(stranger, e.id)
      expect(res.statusCode).toBe(404)
      expect(res.json()).toMatchObject({ error: 'not_found' })
      expect((await pkg(stranger, 'not-a-uuid')).statusCode).toBe(404)
    })
  })
})
