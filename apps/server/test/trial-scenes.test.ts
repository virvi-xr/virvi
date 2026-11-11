import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, createElement, tokenFor } from './helpers/factories.js'
import { db } from '../src/db/connection.js'
import { sceneCollaborators, sceneElements, scenes, users } from '../src/db/schema.js'
import { issueTrialSession } from '../src/auth/trial.js'
import { insertSceneWithDefaultPreset } from '../src/scenes/create.js'

describe('trial scenes', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { await app.close() })

  async function makeTrial(role = 'creator') {
    const u = await createUser({ email: null })
    await db.update(users).set({ isTrial: true, trialLastActiveAt: new Date() }).where(eq(users.id, u.id))
    const s = issueTrialSession(app, { id: u.id, displayName: u.displayName, role, trialLastActiveAt: new Date() })
    const own = await db.transaction((tx) => insertSceneWithDefaultPreset(tx, u.id, 'Trial scene'))
    return { u, h: { authorization: `Bearer ${s.accessToken}` }, ...own }
  }

  const call = (method: string, url: string, headers: Record<string, string>, payload?: unknown) =>
    app.inject({ method: method as any, url, headers, payload: payload as any })

  it('a trial reads, renames and edits its own scene', async () => {
    const t = await makeTrial()
    expect((await call('GET', `/api/scenes/${t.sceneId}`, t.h)).statusCode).toBe(200)
    const put = await call('PUT', `/api/scenes/${t.sceneId}`, t.h, { name: 'Mine' })
    expect([put.statusCode, put.json().scene.name]).toEqual([200, 'Mine'])
    expect((await call('POST', `/api/scenes/${t.sceneId}/presets`, t.h, { name: 'Night' })).statusCode).toBe(201)
    const el = await call('POST', `/api/presets/${t.presetId}/elements`, t.h, { type: 'model', name: 'Chair', properties: { modelSrc: 'https://cdn.test/chair.glb' } })
    expect(el.statusCode).toBe(201)
    const elementId = el.json().element.id
    const inst = await call('POST', `/api/elements/${elementId}/instances`, t.h, { position: { x: 1, y: 0, z: 1 } })
    expect(inst.statusCode).toBe(201)
    const instanceId = inst.json().instance.id
    expect((await call('PUT', `/api/instances/${instanceId}`, t.h, { position: { x: 2, y: 0, z: 2 } })).statusCode).toBe(200)
    expect((await call('DELETE', `/api/instances/${instanceId}`, t.h)).statusCode).toBe(204)
  })

  it('a trial lists only its own scenes', async () => {
    const t = await makeTrial()
    const b = await createUser()
    const { scene } = await createScene(b)
    await db.insert(sceneCollaborators).values({ sceneId: scene.id, userId: t.u.id, role: 'editor' })
    const res = await call('GET', '/api/scenes', t.h)
    expect(res.statusCode).toBe(200)
    expect(res.json().scenes.map((s: { id: string }) => s.id)).toEqual([t.sceneId])
  })

  it("a trial gets nothing on another account's scene", async () => {
    const t = await makeTrial()
    const b = await createUser()
    const { scene } = await createScene(b)
    await db.insert(sceneCollaborators).values({ sceneId: scene.id, userId: t.u.id, role: 'editor' })
    expect([403, 404]).toContain((await call('GET', `/api/scenes/${scene.id}`, t.h)).statusCode)
    expect([403, 404]).toContain((await call('PUT', `/api/scenes/${scene.id}`, t.h, { name: 'pwned' })).statusCode)
    const [after] = await db.select().from(scenes).where(eq(scenes.id, scene.id))
    expect(after.name).toBe(scene.name)
  })

  it('trial elements are model, image, video or sound', async () => {
    const t = await makeTrial()
    for (const type of ['ad_space', 'widget', 'custom', 'nft']) {
      const res = await call('POST', `/api/presets/${t.presetId}/elements`, t.h, { type, name: 'X' })
      expect([type, res.statusCode, res.json()]).toEqual([type, 403, { error: 'account_required', action: 'element_type' }])
    }
    for (const type of ['image', 'video', 'sound']) {
      expect((await call('POST', `/api/presets/${t.presetId}/elements`, t.h, { type, name: 'X' })).statusCode).toBe(201)
    }
    const model = await createElement(t.presetId, { type: 'model', name: 'M', properties: { modelSrc: 'https://cdn.test/m.glb' } })
    const res = await call('PUT', `/api/elements/${model.id}`, t.h, { type: 'ad_space' })
    expect([res.statusCode, res.json()]).toEqual([403, { error: 'account_required', action: 'element_type' }])
    const [after] = await db.select().from(sceneElements).where(eq(sceneElements.id, model.id))
    expect(after.type).toBe('model')
  })

  it("a trial can't place a room set", async () => {
    const t = await makeTrial()
    const modelSrc = 'https://cdn.test/room-sets/abc/set.glb'
    const res = await call('POST', `/api/presets/${t.presetId}/elements`, t.h, { type: 'model', name: 'Room', properties: { modelSrc } })
    expect([res.statusCode, res.json()]).toEqual([403, { error: 'account_required', action: 'room_set' }])
    const model = await createElement(t.presetId, { type: 'model', name: 'M', properties: { modelSrc: 'https://cdn.test/m.glb' } })
    const put = await call('PUT', `/api/elements/${model.id}`, t.h, { properties: { modelSrc } })
    expect([put.statusCode, put.json()]).toEqual([403, { error: 'account_required', action: 'room_set' }])
  })

  it('a trial edits an element whose type is locked or whose room set came from before; it only refuses new ones (LIV-138)', async () => {
    const t = await makeTrial()
    const locked = await createElement(t.presetId, { type: 'widget', name: 'Old widget', properties: { value: 1 } })
    const rename = await call('PUT', `/api/elements/${locked.id}`, t.h, { name: 'Renamed', type: 'widget' })
    expect([rename.statusCode, rename.json().element?.name]).toEqual([200, 'Renamed'])
    const bare = await call('PUT', `/api/elements/${locked.id}`, t.h, { name: 'Again' })
    expect(bare.statusCode).toBe(200)

    const model = await createElement(t.presetId, { type: 'model', name: 'M', properties: { modelSrc: 'https://cdn.test/m.glb' } })
    const toAd = await call('PUT', `/api/elements/${model.id}`, t.h, { type: 'ad_space' })
    expect([toAd.statusCode, toAd.json()]).toEqual([403, { error: 'account_required', action: 'element_type' }])

    const roomSrc = 'https://cdn.test/room-sets/abc/set.glb'
    const toRoom = await call('PUT', `/api/elements/${model.id}`, t.h, { properties: { modelSrc: roomSrc } })
    expect([toRoom.statusCode, toRoom.json()]).toEqual([403, { error: 'account_required', action: 'room_set' }])

    const room = await createElement(t.presetId, { type: 'model', name: 'Room', properties: { modelSrc: roomSrc } })
    const keep = await call('PUT', `/api/elements/${room.id}`, t.h, { name: 'Lobby', properties: { modelSrc: roomSrc } })
    expect([keep.statusCode, keep.json().element?.name]).toEqual([200, 'Lobby'])
  })

  it("a trial's actor never reaches admin", async () => {
    const t = await makeTrial('admin')
    await db.update(users).set({ role: 'admin' }).where(eq(users.id, t.u.id))
    const b = await createUser()
    const { scene } = await createScene(b)
    expect([403, 404]).toContain((await call('GET', `/api/scenes/${scene.id}`, t.h)).statusCode)
    expect([403, 404]).toContain((await call('DELETE', `/api/scenes/${scene.id}`, t.h)).statusCode)
    expect(await db.select({ id: scenes.id }).from(scenes).where(eq(scenes.id, scene.id))).toHaveLength(1)
    // An account still reads its own scene as before
    expect((await call('GET', `/api/scenes/${scene.id}`, { authorization: `Bearer ${tokenFor(b)}` })).statusCode).toBe(200)
  })
})
