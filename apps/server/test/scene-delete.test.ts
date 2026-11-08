import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import {
  arSpaces, eventSceneLinks, events, hyperfyWorlds, organizations, orgMembers, sceneCollaborators, sceneElementInstances, sceneElements,
  scenePresets, sceneRoles, scenes,
} from '../src/db/schema.js'
import type { HostingDeps } from '../src/hyperfy/hosting.js'
import { purgeDeletedScenes, PURGE_AFTER_DAYS } from '../src/scenes/deleted.js'
import { hashWorldKey } from '../src/hyperfy/worlds.js'
import { resetDb } from './helpers/db.js'
import { createElement, createInstance, createScene, createUser, randomWallet, testApp, tokenFor, type TestUser } from './helpers/factories.js'

// Fly, the worlds database and the bucket are faked: nothing here reaches Fly.
const fake = vi.hoisted(() => ({ deps: {} as Partial<HostingDeps>, destroyed: [] as string[], fail: false }))
vi.mock('../src/hyperfy/hosting.js', async (orig) => {
  const m = await orig<typeof import('../src/hyperfy/hosting.js')>()
  return {
    ...m,
    destroyHostedWorld: (id: string) => m.destroyHostedWorld(id, fake.deps),
    destroyHostedWorldsFor: (scope: Parameters<typeof m.destroyHostedWorldsFor>[0]) => m.destroyHostedWorldsFor(scope, fake.deps),
  }
})

function installFakes() {
  fake.destroyed = []
  fake.deps = {
    fly: {
      async deleteApp(name: string) {
        if (fake.fail) throw new Error('fly down')
        fake.destroyed.push(`deleteApp ${name}`)
      },
    } as unknown as HostingDeps['fly'],
    async dropWorldDatabase(slug: string) { fake.destroyed.push(`dropWorldDatabase ${slug}`) },
    async deleteWorldFiles(slug: string) { fake.destroyed.push(`deleteWorldFiles ${slug}`); return 0 },
    log: { info() {}, warn() {}, error() {} },
  }
}

const DAY = 24 * 3600_000

describe('deleting a scene (LIV-83)', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let owner: TestUser
  beforeEach(async () => {
    await resetDb()
    fake.fail = false
    installFakes()
    app = await testApp()
    owner = await createUser({ name: 'Owner' })
  })
  afterEach(() => app.close())

  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const call = (u: TestUser, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as 'GET', url, headers: as(u), ...(payload !== undefined ? { payload: payload as object } : {}) })
  const sceneRow = async (id: string) => (await db.select().from(scenes).where(eq(scenes.id, id)))[0]

  async function richScene() {
    const { scene, preset } = await createScene(owner, 'Gallery')
    const element = await createElement(preset.id, { type: 'image', name: 'Poster', properties: { src: 'https://cdn.example/p.png' } })
    const instance = await createInstance(element.id)
    const editor = await createUser()
    await db.insert(sceneCollaborators).values({ sceneId: scene.id, userId: editor.id, role: 'editor' })
    const [event] = await db.insert(events).values({ ownerId: owner.id, name: 'Opening', startTime: new Date(Date.now() + 2 * DAY), endTime: new Date(Date.now() + 2 * DAY + 3600_000) }).returning()
    await db.insert(eventSceneLinks).values({ eventId: event.id, sceneId: scene.id })
    const [space] = await db.insert(arSpaces).values({ sceneId: scene.id, name: 'Lobby', published: true }).returning()
    return { scene, preset, element, instance, editor, event, space }
  }

  it('hides the scene from the list, its routes, the Hyperfy feed and AR feeds; the dialog lists upcoming events', async () => {
    const s = await richScene()
    const plan = await call(owner, 'GET', `/api/scenes/${s.scene.id}/delete-plan`)
    expect(plan.statusCode, plan.body).toBe(200)
    expect(plan.json().upcomingEvents).toEqual([expect.objectContaining({ name: 'Opening', kind: 'event' })])

    const key = 'virviw_feedkey_0123456789'
    await db.insert(hyperfyWorlds).values({ sceneId: s.scene.id, ownerId: owner.id, name: 'Mine', keyHash: hashWorldKey(key), keyPrefix: key.slice(0, 12) })
    const feed = () => app.inject({ method: 'GET', url: '/api/hyperfy/feed', headers: { authorization: `Bearer ${key}` } })
    expect((await feed()).statusCode).toBe(200)

    const del = await call(owner, 'DELETE', `/api/scenes/${s.scene.id}`)
    expect(del.statusCode, del.body).toBe(200)
    expect(del.json().scene).toMatchObject({ id: s.scene.id, name: 'Gallery' })
    expect(new Date(del.json().scene.purgeAt).getTime() - new Date(del.json().scene.deletedAt).getTime()).toBe(PURGE_AFTER_DAYS * DAY)

    expect((await call(owner, 'GET', '/api/scenes')).json().scenes).toEqual([])
    expect((await call(s.editor, 'GET', '/api/scenes')).json().scenes).toEqual([])
    for (const [method, url, body] of [
      ['GET', `/api/scenes/${s.scene.id}`],
      ['PUT', `/api/scenes/${s.scene.id}`, { name: 'x' }],
      ['GET', `/api/scenes/${s.scene.id}/collaborators`],
      ['GET', `/api/scenes/${s.scene.id}/delete-plan`],
      ['DELETE', `/api/scenes/${s.scene.id}`],
      ['PUT', `/api/elements/${s.element.id}`, { name: 'x' }],
      ['PUT', `/api/instances/${s.instance.id}`, { position: { x: 0, y: 0, z: 0 } }],
      ['POST', `/api/presets/${s.preset.id}/elements`, { type: 'image', name: 'x' }],
    ] as const) {
      const res = await call(owner, method, url, body)
      expect(res.statusCode, `${method} ${url}`).toBe(404)
      expect(res.json()).toEqual({ error: 'Scene not found' })
    }
    // Signed out, a route still answers 401: no hint the id is a deleted scene
    expect((await app.inject({ method: 'GET', url: `/api/scenes/${s.scene.id}` })).statusCode).toBe(401)
    expect((await feed()).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: `/api/ar/spaces/${s.space.id}/feed` })).statusCode).toBe(404)
    // A platform admin gets nothing either
    const admin = await createUser({ role: 'admin' })
    expect((await call(admin, 'GET', `/api/scenes/${s.scene.id}`)).statusCode).toBe(404)
  })

  it('restore brings back every child row; a taken name gets " (restored)"', async () => {
    const s = await richScene()
    const count = async () => ({
      presets: (await db.select().from(scenePresets).where(eq(scenePresets.sceneId, s.scene.id))).length,
      elements: (await db.select().from(sceneElements).where(eq(sceneElements.presetId, s.preset.id))).length,
      instances: (await db.select().from(sceneElementInstances).where(eq(sceneElementInstances.elementId, s.element.id))).length,
      collaborators: (await db.select().from(sceneCollaborators).where(eq(sceneCollaborators.sceneId, s.scene.id))).length,
      events: (await db.select().from(eventSceneLinks).where(eq(eventSceneLinks.sceneId, s.scene.id))).length,
      spaces: (await db.select().from(arSpaces).where(eq(arSpaces.sceneId, s.scene.id))).length,
    })
    const before = await count()
    expect((await call(owner, 'DELETE', `/api/scenes/${s.scene.id}`)).statusCode).toBe(200)
    await createScene(owner, 'Gallery') // the name is taken meanwhile

    const listed = (await call(owner, 'GET', '/api/scenes/deleted')).json().scenes
    expect(listed).toEqual([expect.objectContaining({ id: s.scene.id, name: 'Gallery', removals: [] })])
    expect(new Date(listed[0].purgeAt).getTime()).toBeGreaterThan(Date.now() + 29 * DAY)

    const res = await call(owner, 'POST', `/api/scenes/${s.scene.id}/restore`)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().scene).toMatchObject({ id: s.scene.id, name: 'Gallery (restored)', deletedAt: null })
    expect(await count()).toEqual(before)
    expect((await call(owner, 'GET', `/api/scenes/${s.scene.id}`)).statusCode).toBe(200)
    expect((await call(owner, 'GET', '/api/scenes/deleted')).json().scenes).toEqual([])
    // Restoring twice: it isn't deleted any more
    expect((await call(owner, 'POST', `/api/scenes/${s.scene.id}/restore`)).statusCode).toBe(409)
  })

  it('co-hosts, editors and strangers get 403 deleting a live scene and 404 restoring a deleted one', async () => {
    const s = await richScene()
    const cohost = await createUser({ wallet: randomWallet() })
    await db.insert(sceneRoles).values({ sceneId: s.scene.id, walletAddress: cohost.wallet!, role: 'cohost', grantedByUserId: owner.id })
    const stranger = await createUser()
    for (const u of [cohost, s.editor, stranger]) {
      expect((await call(u, 'DELETE', `/api/scenes/${s.scene.id}`)).statusCode).toBe(403)
      expect((await call(u, 'GET', `/api/scenes/${s.scene.id}/delete-plan`)).statusCode).toBe(403)
    }
    expect((await call(owner, 'DELETE', `/api/scenes/${s.scene.id}`)).statusCode).toBe(200)
    for (const u of [cohost, s.editor, stranger]) {
      expect((await call(u, 'POST', `/api/scenes/${s.scene.id}/restore`)).statusCode).toBe(404)
      expect((await call(u, 'POST', `/api/scenes/${s.scene.id}/purge`, { name: 'Gallery' })).statusCode).toBe(404)
      expect((await call(u, 'GET', '/api/scenes/deleted')).json().scenes).toEqual([])
    }
    expect((await sceneRow(s.scene.id)).deletedAt).not.toBeNull()
  })

  it("an org admin can delete and restore an org scene, but not another member's personal scene", async () => {
    const admin = await createUser({ name: 'Admin' })
    const member = await createUser()
    const [org] = await db.insert(organizations).values({ name: 'Org', slug: `org-${Date.now()}`, billingOwnerId: owner.id }).returning()
    await db.insert(orgMembers).values([
      { orgId: org.id, userId: owner.id, role: 'owner' }, { orgId: org.id, userId: admin.id, role: 'admin' }, { orgId: org.id, userId: member.id, role: 'member' },
    ])
    const orgScene = (await createScene(owner, 'Org scene')).scene
    await db.update(scenes).set({ orgId: org.id }).where(eq(scenes.id, orgScene.id))
    const personal = (await createScene(owner, 'Personal')).scene

    expect((await call(member, 'DELETE', `/api/scenes/${orgScene.id}`)).statusCode).toBe(403)
    expect((await call(admin, 'DELETE', `/api/scenes/${personal.id}`)).statusCode).toBe(403)
    expect((await call(admin, 'DELETE', `/api/scenes/${orgScene.id}`)).statusCode).toBe(200)
    expect((await sceneRow(orgScene.id)).deletedBy).toBe(admin.id)
    expect((await call(admin, 'GET', '/api/scenes/deleted')).json().scenes.map((s: { id: string }) => s.id)).toEqual([orgScene.id])
    const restored = await call(admin, 'POST', `/api/scenes/${orgScene.id}/restore`)
    expect(restored.statusCode, restored.body).toBe(200)
    // Still the owner's org scene
    expect(await sceneRow(orgScene.id)).toMatchObject({ ownerId: owner.id, orgId: org.id, deletedAt: null })
  })

  it("deleting an organization soft-deletes its scenes; its admins then can restore one, which becomes the restorer's own", async () => {
    const platformAdmin = await createUser({ role: 'admin' })
    const orgAdmin = await createUser({ name: 'Org admin' })
    const member = await createUser()
    const [org] = await db.insert(organizations).values({ name: 'Org', slug: `org-${Date.now()}`, billingOwnerId: owner.id }).returning()
    await db.insert(orgMembers).values([
      { orgId: org.id, userId: owner.id, role: 'owner' }, { orgId: org.id, userId: orgAdmin.id, role: 'admin' }, { orgId: org.id, userId: member.id, role: 'member' },
    ])
    const { scene } = await createScene(owner, 'Org scene')
    await db.update(scenes).set({ orgId: org.id }).where(eq(scenes.id, scene.id))
    const [world] = await db.insert(hyperfyWorlds).values({
      sceneId: scene.id, ownerId: owner.id, name: 'Hosted', kind: 'hosted', keyHash: 'org-hash', keyPrefix: 'virviw_org', slug: 'org-world', flyApp: 'vlm-w-org-world', status: 'running',
    }).returning()

    expect((await call(platformAdmin, 'DELETE', `/api/admin/orgs/${org.id}`)).statusCode).toBe(204)
    const row = await sceneRow(scene.id)
    expect(row).toMatchObject({ orgId: null, deletedOrgId: org.id })
    expect(row.deletedAt).not.toBeNull()
    expect([...row.restorerIds!].sort()).toEqual([owner.id, orgAdmin.id].sort())
    // The hosted world stays up until the purge
    expect(fake.destroyed).toEqual([])
    expect((await db.select().from(hyperfyWorlds).where(eq(hyperfyWorlds.id, world.id)))).toHaveLength(1)

    expect((await call(member, 'POST', `/api/scenes/${scene.id}/restore`)).statusCode).toBe(404)
    expect((await call(orgAdmin, 'GET', '/api/scenes/deleted')).json().scenes).toEqual([expect.objectContaining({ id: scene.id, orgDeleted: true })])
    const res = await call(orgAdmin, 'POST', `/api/scenes/${scene.id}/restore`)
    expect(res.statusCode, res.body).toBe(200)
    expect(await sceneRow(scene.id)).toMatchObject({ ownerId: orgAdmin.id, orgId: null, deletedAt: null, restorerIds: null, deletedOrgId: null })
    expect((await call(orgAdmin, 'GET', '/api/scenes')).json().scenes.map((s: { id: string }) => s.id)).toEqual([scene.id])
  })

  it('the purge hard-deletes scenes past 30 days and destroys a hosted world left running; younger ones stay', async () => {
    const old = (await createScene(owner, 'Old')).scene
    const young = (await createScene(owner, 'Young')).scene
    await db.insert(hyperfyWorlds).values({
      sceneId: old.id, ownerId: owner.id, name: 'Hosted', kind: 'hosted', keyHash: 'old-hash', keyPrefix: 'virviw_old', slug: 'old-world', flyApp: 'vlm-w-old-world', status: 'running',
    })
    await db.update(scenes).set({ deletedAt: new Date(Date.now() - 31 * DAY) }).where(eq(scenes.id, old.id))
    await db.update(scenes).set({ deletedAt: new Date(Date.now() - 29 * DAY) }).where(eq(scenes.id, young.id))

    fake.fail = true
    expect(await purgeDeletedScenes(new Date())).toEqual({ purged: 0, failed: 1 })
    expect(await sceneRow(old.id)).toBeDefined()
    fake.fail = false
    expect(await purgeDeletedScenes(new Date())).toEqual({ purged: 1, failed: 0 })
    expect(fake.destroyed).toEqual(['deleteApp vlm-w-old-world', 'dropWorldDatabase old-world', 'deleteWorldFiles old-world'])
    expect(await sceneRow(old.id)).toBeUndefined()
    expect(await sceneRow(young.id)).toBeDefined()
  })

  it('"Delete forever now" needs the scene\'s name, then removes it for good', async () => {
    const { scene } = await createScene(owner, 'Gone')
    expect((await call(owner, 'POST', `/api/scenes/${scene.id}/purge`, { name: 'Gone' })).statusCode).toBe(409) // not deleted yet
    expect((await call(owner, 'DELETE', `/api/scenes/${scene.id}`)).statusCode).toBe(200)
    expect((await call(owner, 'POST', `/api/scenes/${scene.id}/purge`, { name: 'gone' })).statusCode).toBe(400)
    expect((await call(owner, 'POST', `/api/scenes/${scene.id}/purge`, { name: 'Gone' })).statusCode).toBe(204)
    expect(await sceneRow(scene.id)).toBeUndefined()
  })

})
