import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import bcrypt from 'bcryptjs'
import { db } from '../src/db/connection.js'
import {
  notifications, studioDesignInvites, studioDesignMembers, studioDesigns, studioEntitlements, studioJobs, studioMessages, studioPayments,
  userAuthMethods, users,
} from '../src/db/schema.js'
import { config } from '../src/config.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { handOverDesigns } from '../src/studio/handover.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { addRevision, createDesign, entitle, fakeFly } from './helpers/studio.js'

const S = '/api/studio'

/** LIV-159: a shared design passes to its longest-standing collaborator (else viewer) when its owner's account goes. */
describe('hand-over on account deletion', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let store: ReturnType<typeof memoryStudioStore>
  let owner: TestUser
  const prev = { enabled: config.studioEnabled, image: config.studioWorkerImage }
  beforeAll(() => {
    ;(config as any).studioEnabled = true
    ;(config as any).studioWorkerImage = 'registry.fly.io/vlm-studio-worker:test'
  })
  afterAll(() => {
    ;(config as any).studioEnabled = prev.enabled
    ;(config as any).studioWorkerImage = prev.image
    setStudioStore(null)
    setMachineDeps(null)
  })
  beforeEach(async () => {
    await resetDb()
    store = memoryStudioStore()
    setStudioStore(store)
    setMachineDeps({ fly: fakeFly() })
    app = await testApp()
    owner = await createUser({ name: 'Olive Owner' })
  })
  afterEach(async () => { await app.close() })

  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const ago = (min: number) => new Date(Date.now() - min * 60_000)
  const join = async (designId: string, u: TestUser, role: 'collaborator' | 'viewer', over: { joinedAt?: Date; leftAt?: Date } = {}) => {
    const [m] = await db.insert(studioDesignMembers).values({ designId, userId: u.id, role, ...over }).returning()
    return m
  }
  const selfDelete = async (u: TestUser) => {
    await db.insert(userAuthMethods).values({ userId: u.id, type: 'email', identifier: u.email!, credentialHash: await bcrypt.hash('pw-1234', 4) })
    return app.inject({ method: 'DELETE', url: '/api/auth/account', payload: { password: 'pw-1234' }, headers: as(u) })
  }
  const designOf = async (id: string) => (await db.select().from(studioDesigns).where(eq(studioDesigns.id, id)))[0]
  const membership = async (designId: string, userId: string) =>
    db.select().from(studioDesignMembers).where(and(eq(studioDesignMembers.designId, designId), eq(studioDesignMembers.userId, userId)))

  it("owner deletion hands over and keeps a collaborator's paid package", async () => {
    const d = await createDesign(owner)
    const viewer = await createUser()
    const early = await createUser({ name: 'Cal Early' })
    const late = await createUser()
    await join(d.id, viewer, 'viewer', { joinedAt: ago(90) })
    await join(d.id, early, 'collaborator', { joinedAt: ago(60) })
    await join(d.id, late, 'collaborator', { joinedAt: ago(30) })
    // The collaborator paid for the hat; the owner paid for the shoes
    const hat = await entitle(d, await addRevision(d, 'hat'), { userId: early.id })
    const shoes = await entitle(d, await addRevision(d, 'feet'))
    for (const [e, key] of [[hat.entitlement, 'designs/x/final/hat/package.zip'], [shoes.entitlement, 'designs/x/final/feet/package.zip']] as const) {
      await store.put(key, Buffer.from(`PK-${e.category}`), 'application/zip')
      await db.update(studioEntitlements).set({ packageKey: key }).where(eq(studioEntitlements.id, e.id))
    }
    // The owner's prompt, message and an open invite (sent by the owner) on the design
    await db.insert(studioJobs).values({ designId: d.id, type: 'prompt', status: 'done', payload: {}, userId: owner.id })
    await db.insert(studioMessages).values({ designId: d.id, role: 'user', text: 'a hat', userId: owner.id })
    const [invite] = await db.insert(studioDesignInvites).values({
      designId: d.id, email: 'new@test.dev', role: 'viewer', token: `t-${d.id}`, invitedBy: owner.id, expiresAt: new Date(Date.now() + 86400_000),
    }).returning()

    expect((await selfDelete(owner)).statusCode).toBe(204)
    expect(await db.query.users.findFirst({ where: eq(users.id, owner.id) })).toBeUndefined()

    expect((await designOf(d.id)).ownerId).toBe(early.id)
    const [m] = await membership(d.id, early.id)
    expect(m.leftAt).not.toBeNull()
    // The others stay on it
    expect((await membership(d.id, late.id))[0].leftAt).toBeNull()
    expect((await membership(d.id, viewer.id))[0].leftAt).toBeNull()
    for (const [cat, n] of [['hat', 1], ['feet', 1]] as const) {
      const got = await app.inject({ method: 'GET', url: `${S}/designs/${d.id}/pieces/${cat}/revisions/${n}/package`, headers: as(early) })
      expect(got.statusCode).toBe(200)
      expect(got.body).toBe(`PK-${cat}`)
    }
    expect((await db.select().from(studioPayments).where(eq(studioPayments.id, hat.payment.id)))[0].userId).toBe(early.id)
    expect((await db.select().from(studioPayments).where(eq(studioPayments.id, shoes.payment.id)))[0].userId).toBeNull()
    // The design's history stays; the invite is the new owner's to manage
    expect(await db.select().from(studioJobs).where(eq(studioJobs.designId, d.id))).toHaveLength(3)
    expect(await db.select().from(studioMessages).where(eq(studioMessages.designId, d.id))).toHaveLength(1)
    const [i] = await db.select().from(studioDesignInvites).where(eq(studioDesignInvites.id, invite.id))
    expect(i).toMatchObject({ invitedBy: early.id, cancelledAt: null })
    const inv = await app.inject({ method: 'GET', url: `${S}/designs/${d.id}`, headers: as(early) })
    expect(inv.statusCode).toBe(200)
  })

  it('only viewers: the earliest viewer becomes owner', async () => {
    const d = await createDesign(owner)
    const first = await createUser()
    const second = await createUser()
    await join(d.id, second, 'viewer', { joinedAt: ago(10) })
    await join(d.id, first, 'viewer', { joinedAt: ago(20) })
    // A collaborator who left doesn't count
    await join(d.id, await createUser(), 'collaborator', { joinedAt: ago(30), leftAt: ago(25) })
    expect((await selfDelete(owner)).statusCode).toBe(204)
    expect((await designOf(d.id)).ownerId).toBe(first.id)
    expect((await membership(d.id, second.id))[0].leftAt).toBeNull()
  })

  it('no members: the design is deleted as before', async () => {
    const d = await createDesign(owner)
    const other = await createDesign(owner, { name: 'Shared' })
    const c = await createUser()
    await join(other.id, c, 'collaborator')
    // Only a member who left, and an open invite: not shared any more
    await join(d.id, await createUser(), 'viewer', { leftAt: new Date() })
    await db.insert(studioDesignInvites).values({
      designId: d.id, email: 'x@test.dev', role: 'viewer', token: `t-${d.id}`, invitedBy: owner.id, expiresAt: new Date(Date.now() + 86400_000),
    })
    expect((await selfDelete(owner)).statusCode).toBe(204)
    expect(await designOf(d.id)).toBeUndefined()
    expect((await designOf(other.id)).ownerId).toBe(c.id)
  })

  it('admin deleting a user hands over too', async () => {
    const d = await createDesign(owner)
    const c = await createUser()
    await join(d.id, c, 'collaborator')
    const admin = await createUser({ role: 'admin' })
    const r = await app.inject({ method: 'DELETE', url: `/api/admin/users/${owner.id}`, headers: as(admin) })
    expect(r.statusCode).toBe(204)
    expect((await designOf(d.id)).ownerId).toBe(c.id)
  })

  it('the new owner gets a studio_owner notification', async () => {
    const d = await createDesign(owner, { name: 'Neon cap' })
    const c = await createUser()
    await join(d.id, c, 'collaborator')
    expect((await selfDelete(owner)).statusCode).toBe(204)
    const rows = await db.select().from(notifications).where(eq(notifications.userId, c.id))
    expect(rows.map((n) => [n.kind, n.data])).toEqual([['studio_owner', { designId: d.id, designName: 'Neon cap' }]])
  })

  it('handOverDesigns counts the designs it handed over, and a failed notification fails nothing', async () => {
    const a = await createDesign(owner)
    const b = await createDesign(owner)
    await createDesign(owner)
    const c = await createUser()
    await join(a.id, c, 'collaborator')
    await join(b.id, c, 'viewer')
    // The notifications table refuses writes: the hand-over still goes through
    await db.execute(`CREATE OR REPLACE FUNCTION no_notify() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'nope'; END $$ LANGUAGE plpgsql`)
    await db.execute('CREATE TRIGGER no_notify BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION no_notify()')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const n = await db.transaction(async (tx) => {
        const n = await handOverDesigns(tx, owner.id, new Date())
        await tx.delete(users).where(eq(users.id, owner.id))
        return n
      })
      expect(n).toBe(2)
      expect(logged).toHaveBeenCalledWith('[notifications] owner failed:', expect.stringContaining('nope'))
    } finally {
      logged.mockRestore()
      await db.execute('DROP TRIGGER no_notify ON notifications')
    }
    expect((await designOf(a.id)).ownerId).toBe(c.id)
    expect((await designOf(b.id)).ownerId).toBe(c.id)
    expect(await db.select().from(studioDesigns)).toHaveLength(2)
  })
})
