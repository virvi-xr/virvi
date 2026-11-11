import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { notifications, studioDesignMembers, studioDesignInvites, studioJobs, studioPayments, users } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { setStripe } from '../src/integrations/stripe.js'
import { memoryStudioStore, setStudioStore, jobFileKey } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { quoteFinalize } from '../src/studio/pricing.js'
import { grantPayment } from '../src/studio/payments.js'
import { flushNotifications } from '../src/notifications/notifications.js'
import { sweepStudio } from '../src/studio/sweep.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { createDesign, addRevision, fakeFly, fakeStripe, issueWorker } from './helpers/studio.js'

const DAY = 24 * 3600_000
const PROMPT_TEXT = 'a very secret neon cap prompt'

describe('notifications', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let store: ReturnType<typeof memoryStudioStore>
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
    setStripe(null)
    setStudioStore(null)
    setMachineDeps(null)
  })
  beforeEach(async () => {
    await resetDb()
    store = memoryStudioStore()
    setStudioStore(store)
    setStripe(fakeStripe())
    setMachineDeps({ fly: fakeFly() })
    app = await testApp()
  })

  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const list = async (u: TestUser, qs = '') => (await flushNotifications(), (await app.inject({ method: 'GET', url: `/api/notifications${qs}`, headers: as(u) })).json())
  const count = async (u: TestUser) => (await flushNotifications(), await app.inject({ method: 'GET', url: '/api/notifications/unread-count', headers: as(u) })).json().count
  const post = (u: TestUser, url: string) => app.inject({ method: 'POST', url, headers: as(u), payload: {} })
  const invite = (u: TestUser, designId: string, email: string, role = 'collaborator') =>
    app.inject({ method: 'POST', url: `/api/studio/designs/${designId}/invites`, headers: as(u), payload: { email, role } })
  const join = (designId: string, u: TestUser, role = 'collaborator') =>
    db.insert(studioDesignMembers).values({ designId, userId: u.id, role })
  /** A prompt, then its job done so the next can be queued. */
  async function prompt(u: TestUser, designId: string) {
    const res = await app.inject({ method: 'POST', url: `/api/studio/designs/${designId}/prompts`, headers: as(u), payload: { text: PROMPT_TEXT, selectedSlots: ['hat'] } })
    expect(res.statusCode).toBe(202)
    await db.update(studioJobs).set({ status: 'done' }).where(eq(studioJobs.designId, designId))
  }

  it('invite creates a notification for the matched account and accepting marks it read', async () => {
    const olive = await createUser({ name: 'Olive', email: 'olive@test.dev' })
    const sam = await createUser({ name: 'Sam', email: 'sam@test.dev' })
    const d = await createDesign(olive, { name: 'Neon cap' })
    const sent = await invite(olive, d.id, 'sam@test.dev', 'viewer')
    expect(sent.statusCode).toBe(201)
    const { items } = await list(sam)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'studio_invite', readAt: null, gone: false, open: true,
      data: { designId: d.id, designName: 'Neon cap', inviterName: 'Olive', role: 'viewer' },
    })
    expect(await count(sam)).toBe(1)
    expect((await post(sam, `/api/studio/invites/${items[0].data.inviteId}/accept`)).statusCode).toBe(200)
    expect(await count(sam)).toBe(0)
    // Accepted: I'm on the design now, so it isn't gone, only no longer open
    expect((await list(sam)).items[0]).toMatchObject({ readAt: expect.any(String), gone: false, open: false })
  })

  it('declining or cancelling an invite marks it read, and an expired one is gone', async () => {
    const olive = await createUser({ name: 'Olive', email: 'olive@test.dev' })
    const sam = await createUser({ email: 'sam@test.dev' })
    const kim = await createUser({ email: 'kim@test.dev' })
    const lee = await createUser({ email: 'lee@test.dev' })
    const d = await createDesign(olive)
    for (const e of ['sam@test.dev', 'kim@test.dev', 'lee@test.dev']) await invite(olive, d.id, e)
    const id = async (u: TestUser) => (await list(u)).items[0].data.inviteId
    expect((await post(sam, `/api/studio/invites/${await id(sam)}/decline`)).statusCode).toBe(204)
    expect(await count(sam)).toBe(0)
    expect((await list(sam)).items[0]).toMatchObject({ gone: true, open: false })
    expect((await post(olive, `/api/studio/designs/${d.id}/invites/${await id(kim)}/cancel`)).statusCode).toBe(204)
    expect(await count(kim)).toBe(0)
    expect((await list(kim)).items[0]).toMatchObject({ gone: true, open: false })
    await db.update(studioDesignInvites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(studioDesignInvites.userId, lee.id))
    expect((await list(lee)).items[0]).toMatchObject({ readAt: null, gone: true, open: false })
    await sweepStudio(new Date())
    expect(await count(lee)).toBe(0)
    expect((await list(lee)).items[0]).toMatchObject({ readAt: expect.any(String), gone: true })
    // A resend after expiry shows it again as a new unread item
    const sent = (await db.select().from(studioDesignInvites).where(eq(studioDesignInvites.userId, lee.id)))[0]
    await db.update(studioDesignInvites).set({ lastSentAt: new Date(Date.now() - 2 * 3600_000) }).where(eq(studioDesignInvites.id, sent.id))
    expect((await post(olive, `/api/studio/designs/${d.id}/invites/${sent.id}/resend`)).statusCode).toBe(200)
    expect(await count(lee)).toBe(1)
    expect((await list(lee)).items[0]).toMatchObject({ readAt: null, gone: false })
  })

  it('an invite to an email with no account notifies nobody', async () => {
    const olive = await createUser({ email: 'olive@test.dev' })
    const d = await createDesign(olive)
    await invite(olive, d.id, 'nobody@test.dev')
    expect(await db.select().from(notifications)).toHaveLength(0)
  })

  it('prompts group into one unread item per design', async () => {
    const olive = await createUser({ name: 'Olive' })
    const sam = await createUser({ name: 'Sam' })
    const alex = await createUser({ name: 'Alex' })
    const d = await createDesign(olive)
    await join(d.id, sam)
    await join(d.id, alex)
    for (const who of [sam, alex, sam, alex, sam]) await prompt(who, d.id)
    const { items } = await list(olive)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'studio_prompts', data: { designId: d.id, count: 5, senders: ['Sam', 'Alex'] } })
    expect(await count(olive)).toBe(1)
    await post(olive, `/api/notifications/${items[0].id}/read`)
    await prompt(alex, d.id)
    const next = (await list(olive)).items
    expect(next).toHaveLength(2)
    expect(next[0]).toMatchObject({ readAt: null, data: { count: 1, senders: ['Alex'] } })
  })

  it("the sender isn't notified", async () => {
    const olive = await createUser({ name: 'Olive' })
    const sam = await createUser({ name: 'Sam' })
    const d = await createDesign(olive)
    await join(d.id, sam)
    await prompt(sam, d.id)
    expect((await list(sam)).items).toHaveLength(0)
    await prompt(olive, d.id)
    expect((await list(sam)).items).toHaveLength(1)
    expect((await list(olive)).items).toHaveLength(1)
  })

  it('two prompts at once leave one unread item', async () => {
    const { notify } = await import('../src/notifications/notifications.js')
    const olive = await createUser()
    const merge = (o: any, n: any) => ({ n: o.n + n.n })
    await Promise.all(Array.from({ length: 6 }, () => notify(olive.id, 'studio_prompts', { n: 1 }, { groupKey: 'g', merge })))
    const rows = await db.select().from(notifications)
    expect(rows).toHaveLength(1)
    expect(rows[0].data).toEqual({ n: 6 })
  })

  it('a failed notify never fails the prompt', async () => {
    const olive = await createUser()
    const sam = await createUser()
    const d = await createDesign(olive)
    await join(d.id, sam)
    // The notifications table is gone for a moment: every notify throws
    await db.execute(sql`ALTER TABLE notifications RENAME TO notifications_gone`)
    const res = await app.inject({ method: 'POST', url: `/api/studio/designs/${d.id}/prompts`, headers: as(olive), payload: { text: 'x', selectedSlots: ['hat'] } })
    await flushNotifications()
    await db.execute(sql`ALTER TABLE notifications_gone RENAME TO notifications`)
    expect(res.statusCode).toBe(202)
  })

  it('support prompts notify the owner and members as Virvi support', async () => {
    const { notifyPrompt } = await import('../src/notifications/notifications.js')
    const olive = await createUser()
    const sam = await createUser()
    const admin = await createUser({ role: 'admin' } as any)
    const d = await createDesign(olive)
    await join(d.id, sam)
    await notifyPrompt(d, admin.id, 'Ada', true)
    expect((await list(olive)).items[0].data.senders).toEqual(['Virvi support'])
    expect((await list(sam)).items[0].data.senders).toEqual(['Virvi support'])
  })

  async function paidHat(u: TestUser) {
    const d = await createDesign(u, { name: 'Neon set' })
    const rev = await addRevision(d, 'hat')
    for (const f of rev.files) await store.put(jobFileKey(d.id, rev.jobId, f), Buffer.from(`v1:${f}`), 'text/plain')
    const q = await quoteFinalize(d, ['hat'], [])
    const [pay] = await db.insert(studioPayments).values({ userId: u.id, designId: d.id, kind: 'finalize', amountCents: q.totalCents, lines: q.lines }).returning()
    expect(await grantPayment(pay.id, 'pi_test', new Date())).toBe('granted')
    return { d, token: await issueWorker(d) }
  }

  it('package ready notifies owner and members', async () => {
    const olive = await createUser({ name: 'Olive' })
    const sam = await createUser({ name: 'Sam' })
    const gone = await createUser({ name: 'Gone' })
    const { d, token } = await paidHat(olive)
    await join(d.id, sam, 'viewer')
    await db.insert(studioDesignMembers).values({ designId: d.id, userId: gone.id, role: 'viewer', leftAt: new Date() })
    const bearer = { authorization: `Bearer ${token}` }
    const job = (await app.inject({ method: 'GET', url: `/api/studio/worker/designs/${d.id}/jobs/next`, headers: bearer })).json()
    await app.inject({ method: 'PUT', url: `/api/studio/worker/jobs/${job.jobId}/files/final/hat/package.zip`, headers: { ...bearer, 'content-type': 'application/zip' }, payload: Buffer.from('PK') })
    const res = await app.inject({ method: 'POST', url: `/api/studio/worker/jobs/${job.jobId}/result`, headers: bearer, payload: { outcome: 'ok', pieces: [{ category: 'hat', files: ['final/hat/package.zip'], finalize: null }], costUsd: null } })
    expect(res.statusCode).toBe(204)
    for (const u of [olive, sam]) {
      expect((await list(u)).items).toMatchObject([{ kind: 'studio_package_ready', data: { designId: d.id, designName: 'Neon set', category: 'hat' } }])
    }
    expect((await list(gone)).items).toHaveLength(0)
  })

  it("a removed member's items show gone", async () => {
    const olive = await createUser()
    const sam = await createUser()
    const d = await createDesign(olive)
    await join(d.id, sam)
    await prompt(olive, d.id)
    expect((await list(sam)).items[0].gone).toBe(false)
    await db.update(studioDesignMembers).set({ leftAt: new Date() }).where(eq(studioDesignMembers.userId, sam.id))
    expect((await list(sam)).items[0].gone).toBe(true)
  })

  it('unread-count and read-all', async () => {
    const { notify } = await import('../src/notifications/notifications.js')
    const u = await createUser()
    for (let i = 0; i < 3; i++) await notify(u.id, 'studio_owner', { designId: u.id, designName: `D${i}` })
    expect(await count(u)).toBe(3)
    expect((await post(u, '/api/notifications/read-all')).statusCode).toBe(204)
    expect(await count(u)).toBe(0)
    expect((await list(u)).items.every((i: any) => i.readAt)).toBe(true)
  })

  it('lists newest update first in pages with before and more', async () => {
    const u = await createUser()
    for (let i = 0; i < 5; i++) {
      await db.insert(notifications).values({ userId: u.id, kind: 'studio_owner', data: { designId: u.id, designName: `D${i}` }, updatedAt: new Date(Date.now() - i * 1000) })
    }
    const first = await list(u, '?limit=2')
    expect(first.items.map((i: any) => i.data.designName)).toEqual(['D0', 'D1'])
    expect(first.more).toBe(true)
    const second = await list(u, `?limit=2&before=${encodeURIComponent(first.items[1].updatedAt)}`)
    expect(second.items.map((i: any) => i.data.designName)).toEqual(['D2', 'D3'])
    expect((await app.inject({ method: 'GET', url: '/api/notifications?before=nope', headers: as(u) })).statusCode).toBe(400)
  })

  it("another user's notification id → 404 on read", async () => {
    const { notify } = await import('../src/notifications/notifications.js')
    const a = await createUser()
    const b = await createUser()
    await notify(b.id, 'studio_owner', { designId: b.id, designName: 'x' })
    const [row] = await db.select().from(notifications)
    expect((await post(a, `/api/notifications/${row.id}/read`)).statusCode).toBe(404)
    expect((await post(a, '/api/notifications/not-a-uuid/read')).statusCode).toBe(404)
    expect((await db.select().from(notifications))[0].readAt).toBeNull()
    expect((await post(b, `/api/notifications/${row.id}/read`)).statusCode).toBe(204)
  })

  it('prune removes items older than 90 days', async () => {
    const u = await createUser()
    const old = new Date(Date.now() - 91 * DAY)
    await db.insert(notifications).values([
      { userId: u.id, kind: 'studio_owner', data: { designName: 'old' }, createdAt: old, updatedAt: old },
      // created long ago but updated recently: kept
      { userId: u.id, kind: 'studio_owner', data: { designName: 'fresh' }, createdAt: old, updatedAt: new Date(Date.now() - 89 * DAY) },
    ])
    await sweepStudio(new Date())
    expect((await db.select().from(notifications)).map((n) => (n.data as any).designName)).toEqual(['fresh'])
  })

  it('no notification data contains the prompt text', async () => {
    const olive = await createUser({ email: 'olive@test.dev' })
    const sam = await createUser({ email: 'sam@test.dev' })
    const d = await createDesign(olive)
    await invite(olive, d.id, 'sam@test.dev')
    await join(d.id, sam)
    await prompt(olive, d.id)
    await flushNotifications()
    const rows = await db.select().from(notifications)
    expect(rows.length).toBeGreaterThan(1)
    expect(JSON.stringify(rows)).not.toContain(PROMPT_TEXT)
  })

  it('a trial gets an empty list and 0', async () => {
    const t = await createUser({ email: null })
    await db.update(users).set({ isTrial: true }).where(eq(users.id, t.id))
    await db.insert(notifications).values({ userId: t.id, kind: 'studio_owner', data: { designId: t.id, designName: 'x' } })
    const { issueTrialSession } = await import('../src/auth/trial.js')
    const s = issueTrialSession(app, { id: t.id, displayName: t.displayName, role: 'creator', trialLastActiveAt: new Date() })
    const h = { authorization: `Bearer ${s.accessToken}` }
    expect((await app.inject({ method: 'GET', url: '/api/notifications', headers: h })).json()).toEqual({ items: [], more: false })
    expect((await app.inject({ method: 'GET', url: '/api/notifications/unread-count', headers: h })).json()).toEqual({ count: 0 })
  })
})
