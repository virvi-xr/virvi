import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { studioDesignMembers, studioEntitlements } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { memoryStudioStore, setStudioStore } from '../src/studio/store.js'
import { setMachineDeps } from '../src/studio/machines.js'
import { designRole, memberCount, memberIds } from '../src/studio/members.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { addRevision, createDesign, entitle, fakeFly } from './helpers/studio.js'

const S = '/api/studio'

describe('design roles', () => {
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

  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const join = async (designId: string, u: TestUser, role: 'collaborator' | 'viewer', over: { joinedAt?: Date; leftAt?: Date } = {}) => {
    const [m] = await db.insert(studioDesignMembers).values({ designId, userId: u.id, role, ...over }).returning()
    return m
  }
  const get = (u: TestUser, id: string) => app.inject({ method: 'GET', url: `${S}/designs/${id}`, headers: as(u) })
  const prompt = (u: TestUser, id: string) =>
    app.inject({ method: 'POST', url: `${S}/designs/${id}/prompts`, headers: as(u), payload: { text: 'a neon cap', selectedSlots: ['hat'] } })

  it('designRole: owner, collaborator, viewer; a left member and a stranger have none', async () => {
    const d = await createDesign(owner)
    const collab = await createUser()
    const viewer = await createUser()
    const left = await createUser()
    await join(d.id, collab, 'collaborator')
    await join(d.id, viewer, 'viewer')
    await join(d.id, left, 'collaborator', { leftAt: new Date() })
    expect(await designRole(d.id, owner.id)).toBe('owner')
    expect(await designRole(d.id, collab.id)).toBe('collaborator')
    expect(await designRole(d.id, viewer.id)).toBe('viewer')
    expect(await designRole(d.id, left.id)).toBeNull()
    expect(await designRole(d.id, (await createUser()).id)).toBeNull()
  })

  it('memberIds lists the owner first, then open members by when they joined; memberCount leaves the owner out', async () => {
    const d = await createDesign(owner)
    const a = await createUser()
    const b = await createUser()
    const gone = await createUser()
    await join(d.id, b, 'viewer', { joinedAt: new Date(Date.now() - 1000) })
    await join(d.id, a, 'collaborator')
    await join(d.id, gone, 'collaborator', { joinedAt: new Date(Date.now() - 5000), leftAt: new Date() })
    expect(await memberIds(d.id)).toEqual([owner.id, b.id, a.id])
    expect(await memberCount(d.id)).toBe(2)
  })

  it('a collaborator reads the design and prompts on it', async () => {
    const d = await createDesign(owner)
    const collab = await createUser({ name: 'Cora Collab' })
    await join(d.id, collab, 'collaborator')
    const res = await get(collab, d.id)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      role: 'collaborator',
      members: [
        { userId: owner.id, displayName: 'Olive Owner', role: 'owner' },
        { userId: collab.id, displayName: 'Cora Collab', role: 'collaborator' },
      ],
    })
    expect((await prompt(collab, d.id)).statusCode).toBe(202)
  })

  it('the owner sees role owner in the detail', async () => {
    const d = await createDesign(owner)
    expect((await get(owner, d.id)).json()).toMatchObject({ role: 'owner', members: [{ userId: owner.id, role: 'owner' }] })
  })

  it('a viewer reads the design but gets 403 viewer on a work route', async () => {
    const d = await createDesign(owner)
    const viewer = await createUser()
    await join(d.id, viewer, 'viewer')
    const res = await get(viewer, d.id)
    expect(res.statusCode).toBe(200)
    expect(res.json().role).toBe('viewer')
    const p = await prompt(viewer, d.id)
    expect(p.statusCode).toBe(403)
    expect(p.json()).toEqual({ error: 'viewer', code: 'viewer' })
    const r = await app.inject({ method: 'POST', url: `${S}/designs/${d.id}/renders`, headers: as(viewer), payload: {} })
    expect(r.statusCode).toBe(403)
  })

  it('a viewer downloads a ready package', async () => {
    const d = await createDesign(owner)
    const rev = await addRevision(d, 'hat')
    const { entitlement } = await entitle(d, rev)
    await store.put('designs/x/final/hat/package.zip', Buffer.from('PK-hat'), 'application/zip')
    await db.update(studioEntitlements).set({ packageKey: 'designs/x/final/hat/package.zip' }).where(eq(studioEntitlements.id, entitlement.id))
    const viewer = await createUser()
    await join(d.id, viewer, 'viewer')
    const got = await app.inject({ method: 'GET', url: `${S}/designs/${d.id}/pieces/hat/revisions/1/package`, headers: as(viewer) })
    expect(got.statusCode).toBe(200)
    expect(got.body).toBe('PK-hat')
  })

  it('a left member and a stranger get 404 on the design and on a prompt', async () => {
    const d = await createDesign(owner)
    const left = await createUser()
    await join(d.id, left, 'collaborator', { leftAt: new Date() })
    const stranger = await createUser()
    for (const u of [left, stranger]) {
      expect((await get(u, d.id)).statusCode).toBe(404)
      expect((await prompt(u, d.id)).statusCode).toBe(404)
    }
  })

  it('own-only routes hide from members: a collaborator renaming gets 404', async () => {
    const d = await createDesign(owner)
    const collab = await createUser()
    await join(d.id, collab, 'collaborator')
    const res = await app.inject({ method: 'PATCH', url: `${S}/designs/${d.id}`, headers: as(collab), payload: { name: 'Mine now' } })
    expect(res.statusCode).toBe(404)
  })

  it('the list shows a shared design with its role and owner, and it is not one of the collaborator’s open designs', async () => {
    const d = await createDesign(owner, { name: 'Shared cap' })
    const collab = await createUser()
    await join(d.id, collab, 'collaborator')
    const own = await createDesign(collab, { name: 'My own cap' })
    const list = (await app.inject({ method: 'GET', url: `${S}/designs`, headers: as(collab) })).json()
    expect(list).toHaveLength(2)
    expect(list.find((x: any) => x.id === d.id)).toMatchObject({ role: 'collaborator', ownerName: 'Olive Owner' })
    const mine = list.find((x: any) => x.id === own.id)
    expect(mine.role).toBe('owner')
    expect(mine).not.toHaveProperty('ownerName')
    const usage = (await app.inject({ method: 'GET', url: `${S}/usage`, headers: as(collab) })).json()
    expect(usage.openDesigns).toBe(1)
  })
})
