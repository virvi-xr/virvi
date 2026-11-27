import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { hyperfyWorlds, sceneDeployments, scenes } from '../src/db/schema.js'
import { createWorldKey } from '../src/hyperfy/worlds.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, createElement, createInstance, tokenFor, type TestUser } from './helpers/factories.js'

/** LIV-37: the getting-started checklist, worked out from what the account has done. */
describe('onboarding', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(() => app.close())

  const get = async (u: TestUser) => (await app.inject({ method: 'GET', url: '/api/me/onboarding', headers: { authorization: `Bearer ${tokenFor(u)}` } })).json()
  const done = async (u: TestUser) => Object.fromEntries((await get(u)).steps.map((s: any) => [s.id, s.done]))

  it('walks create → content → deploy → live from real data', async () => {
    const u = await createUser()
    expect(await get(u)).toMatchObject({ complete: false, sceneId: null, dismissedAt: null })
    expect(await done(u)).toEqual({ create: false, content: false, deploy: false, live: false })

    const { scene, preset } = await createScene(u)
    expect(await done(u)).toEqual({ create: true, content: false, deploy: false, live: false })
    expect((await get(u)).sceneId).toBe(scene.id)

    const el = await createElement(preset.id, { type: 'image' })
    expect((await done(u)).content).toBe(false) // an item with no copy placed isn't in the scene yet
    await createInstance(el.id)
    expect((await done(u)).content).toBe(true)

    await db.insert(sceneDeployments).values({ sceneId: scene.id, platform: 'decentraland', status: 'deployed', deploymentType: 'world', target: {} })
    expect(await done(u)).toEqual({ create: true, content: true, deploy: true, live: false })

    await db.update(scenes).set({ dclHudSeenAt: new Date() }).where(eq(scenes.id, scene.id))
    expect(await get(u)).toMatchObject({ complete: true })
  })

  it('a Hyperfy world counts as deployed, and as live once it has polled', async () => {
    const u = await createUser()
    const { scene } = await createScene(u)
    const k = createWorldKey()
    const [w] = await db.insert(hyperfyWorlds).values({ sceneId: scene.id, ownerId: u.id, name: 'W', keyHash: k.hash, keyPrefix: k.prefix }).returning()
    expect(await done(u)).toMatchObject({ deploy: true, live: false })
    await db.update(hyperfyWorlds).set({ lastSeenAt: new Date() }).where(eq(hyperfyWorlds.id, w.id))
    expect((await done(u)).live).toBe(true)
  })

  it("only the account's own scenes count, and a scene in Trash doesn't", async () => {
    const u = await createUser()
    const other = await createUser()
    await createScene(other)
    expect((await done(u)).create).toBe(false)
    const { scene } = await createScene(u)
    await db.update(scenes).set({ deletedAt: new Date() }).where(eq(scenes.id, scene.id))
    expect((await done(u)).create).toBe(false)
  })

  it('dismissing hides it, and it can be shown again', async () => {
    const u = await createUser()
    const auth = { authorization: `Bearer ${tokenFor(u)}` }
    const hidden = await app.inject({ method: 'POST', url: '/api/me/onboarding/dismiss', headers: auth, payload: {} })
    expect(hidden.statusCode).toBe(200)
    expect(hidden.json().dismissedAt).toBeTruthy()
    const back = await app.inject({ method: 'POST', url: '/api/me/onboarding/dismiss', headers: auth, payload: { dismissed: false } })
    expect(back.json().dismissedAt).toBeNull()
    expect((await app.inject({ method: 'POST', url: '/api/me/onboarding/dismiss', headers: auth, payload: { dismissed: 'yes' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/api/me/onboarding' })).statusCode).toBe(401)
  })

  it('admins see where new accounts stop, as counts only', async () => {
    const admin = await createUser({ role: 'admin' })
    const a = await createUser()
    const b = await createUser()
    await createUser()
    const { preset } = await createScene(a)
    await createInstance((await createElement(preset.id)).id)
    await createScene(b)
    await app.inject({ method: 'POST', url: '/api/me/onboarding/dismiss', headers: { authorization: `Bearer ${tokenFor(b)}` }, payload: {} })
    const res = await app.inject({ method: 'GET', url: '/api/admin/onboarding?days=30', headers: { authorization: `Bearer ${tokenFor(admin)}` } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      days: 30, accounts: 3, dismissed: 1,
      steps: [{ id: 'create', accounts: 2 }, { id: 'content', accounts: 1 }, { id: 'deploy', accounts: 0 }, { id: 'live', accounts: 0 }],
    })
    expect((await app.inject({ method: 'GET', url: '/api/admin/onboarding', headers: { authorization: `Bearer ${tokenFor(a)}` } })).statusCode).toBe(403)
  })
})
