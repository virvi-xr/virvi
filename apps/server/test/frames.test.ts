import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { defaultFrame } from '@virvixr/shared'
import { db } from '../src/db/connection.js'
import { sceneElements, users } from '../src/db/schema.js'
import { issueTrialSession } from '../src/auth/trial.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, createElement, tokenFor } from './helpers/factories.js'
import { startGameServer, joinScene } from './helpers/game-server.js'

/** Frames around images and video screens (LIV-129): saved in the element's properties, checked, sent live, copied. */
const propsOf = async (id: string) => (await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, id) }))!.properties as Record<string, any>

describe('saving frames', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(() => app.close())
  const as = (u: any) => ({ authorization: `Bearer ${tokenFor(u)}` })

  it('an image takes a frame (stored tidied, beside its other properties), and it can be switched off and removed', async () => {
    const owner = await createUser()
    const { preset } = await createScene(owner)
    const el = await createElement(preset.id, { type: 'image', properties: { textureSrc: 'https://cdn.virvi.io/a.png' } })
    const frame = { enabled: true, style: 'classic', color: '#C9A227', thickness: 8 }
    const res = await app.inject({ method: 'PUT', url: `/api/elements/${el.id}`, headers: as(owner), payload: { properties: { textureSrc: 'https://cdn.virvi.io/a.png', frame } } })
    expect(res.statusCode).toBe(200)
    expect(res.json().element.properties.frame).toEqual({ ...frame, color: '#c9a227' })
    expect(await propsOf(el.id)).toEqual({ textureSrc: 'https://cdn.virvi.io/a.png', frame: { ...frame, color: '#c9a227' } })

    const off = await app.inject({ method: 'PUT', url: `/api/elements/${el.id}`, headers: as(owner), payload: { properties: { textureSrc: 'https://cdn.virvi.io/a.png', frame: { ...frame, enabled: false } } } })
    expect(off.statusCode).toBe(200)
    expect((await propsOf(el.id)).frame).toMatchObject({ enabled: false, style: 'classic' })

    const gone = await app.inject({ method: 'PUT', url: `/api/elements/${el.id}`, headers: as(owner), payload: { properties: { textureSrc: 'https://cdn.virvi.io/a.png', frame: null } } })
    expect(gone.statusCode).toBe(200)
    expect(await propsOf(el.id)).toEqual({ textureSrc: 'https://cdn.virvi.io/a.png' })
  })

  it('a video screen takes one too, and a new image can be made with one', async () => {
    const owner = await createUser()
    const { preset } = await createScene(owner)
    const el = await createElement(preset.id, { type: 'video' })
    const res = await app.inject({ method: 'PUT', url: `/api/elements/${el.id}`, headers: as(owner), payload: { properties: { ...(el.properties as object), frame: defaultFrame('gallery') } } })
    expect(res.statusCode).toBe(200)
    expect((await propsOf(el.id)).frame).toEqual(defaultFrame('gallery'))
    const made = await app.inject({ method: 'POST', url: `/api/presets/${preset.id}/elements`, headers: as(owner), payload: { type: 'image', name: 'P', properties: { textureSrc: 'x.png', frame: { enabled: true, style: 'thin' } } } })
    expect(made.statusCode).toBe(201)
    expect((await propsOf(made.json().element.id)).frame).toEqual(defaultFrame('thin'))
  })

  it('refuses a frame it could not draw, with the reason, and leaves the element as it was', async () => {
    const owner = await createUser()
    const { preset } = await createScene(owner)
    const el = await createElement(preset.id, { type: 'image', properties: { textureSrc: 'a.png' } })
    const bad = await app.inject({ method: 'PUT', url: `/api/elements/${el.id}`, headers: as(owner), payload: { properties: { textureSrc: 'b.png', frame: { enabled: true, style: 'ornate' } } } })
    expect([bad.statusCode, bad.json()]).toEqual([400, { error: 'bad_frame', message: 'Choose a frame style: Thin, Classic or Gallery.' }])
    expect(await propsOf(el.id)).toEqual({ textureSrc: 'a.png' })
    const thick = await app.inject({ method: 'PUT', url: `/api/elements/${el.id}`, headers: as(owner), payload: { properties: { frame: { enabled: true, style: 'thin', thickness: 50 } } } })
    expect(thick.statusCode).toBe(400)
    const made = await app.inject({ method: 'POST', url: `/api/presets/${preset.id}/elements`, headers: as(owner), payload: { type: 'image', name: 'P', properties: { frame: 'gold' } } })
    expect(made.statusCode).toBe(400)
  })

  it('ad spaces and other items stay unframed', async () => {
    const owner = await createUser()
    const { preset } = await createScene(owner)
    const ad = await createElement(preset.id, { type: 'ad_space', properties: { shape: '16:9', formats: 'both' } })
    const res = await app.inject({ method: 'PUT', url: `/api/elements/${ad.id}`, headers: as(owner), payload: { properties: { shape: '16:9', formats: 'both', frame: defaultFrame() } } })
    expect([res.statusCode, res.json()]).toEqual([400, { error: 'bad_frame', message: 'Only images and video screens can have a frame.' }])
    const model = await app.inject({ method: 'POST', url: `/api/presets/${preset.id}/elements`, headers: as(owner), payload: { type: 'model', name: 'M', properties: { frame: defaultFrame() } } })
    expect(model.statusCode).toBe(400)
  })

  it('a frame resent as it was (an AR app saving another property) is not checked again', async () => {
    const owner = await createUser()
    const { preset } = await createScene(owner)
    // Stored before the rules (or by hand): the HUD and AR apps send it back with the rest
    const el = await createElement(preset.id, { type: 'video', properties: { liveSrc: 'a', frame: { enabled: true, style: 'thin', thickness: 99 } } })
    const res = await app.inject({ method: 'PUT', url: `/api/elements/${el.id}`, headers: as(owner), payload: { properties: { liveSrc: 'b', frame: { enabled: true, style: 'thin', thickness: 99 } } } })
    expect(res.statusCode).toBe(200)
  })

  it('a trial frames the images on its own scene', async () => {
    const u = await createUser({ email: null })
    await db.update(users).set({ isTrial: true, trialLastActiveAt: new Date() }).where(eq(users.id, u.id))
    const s = issueTrialSession(app, { id: u.id, displayName: u.displayName, role: 'creator', trialLastActiveAt: new Date() })
    const { preset } = await createScene(u)
    const el = await createElement(preset.id, { type: 'image', properties: { textureSrc: 'a.png' } })
    const res = await app.inject({ method: 'PUT', url: `/api/elements/${el.id}`, headers: { authorization: `Bearer ${s.accessToken}` }, payload: { properties: { textureSrc: 'a.png', frame: defaultFrame() } } })
    expect(res.statusCode).toBe(200)
    expect((await propsOf(el.id)).frame).toEqual(defaultFrame())
  })

  it('a duplicated preset keeps its frames', async () => {
    const owner = await createUser()
    const { scene, preset } = await createScene(owner)
    await createElement(preset.id, { type: 'image', name: 'Framed', properties: { textureSrc: 'a.png', frame: defaultFrame('classic') } })
    const made = await app.inject({ method: 'POST', url: `/api/scenes/${scene.id}/presets`, headers: as(owner), payload: { name: 'Copy', fromPresetId: preset.id } })
    expect(made.statusCode).toBe(201)
    const copy = await db.query.sceneElements.findFirst({ where: eq(sceneElements.presetId, made.json().preset.id) })
    expect((copy!.properties as any).frame).toEqual(defaultFrame('classic'))
  })
})

describe('frames reach the scene live', () => {
  let gs: Awaited<ReturnType<typeof startGameServer>>
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); gs = await startGameServer(); app = await testApp() })
  afterEach(async () => { await app.close(); await gs.stop() })

  it('saving a frame sends the element to visitors, frame and all, as other image edits are', async () => {
    const host = await createUser()
    const { scene, preset } = await createScene(host)
    const el = await createElement(preset.id, { type: 'image', properties: { textureSrc: 'https://cdn.virvi.io/a.png' } })
    const c = await joinScene(gs.url, scene.id, tokenFor(host))
    expect((await c.waitFor('scene_preset_update')).action).toBe('init')
    const res = await app.inject({
      method: 'PUT', url: `/api/elements/${el.id}`, headers: { authorization: `Bearer ${tokenFor(host)}` },
      payload: { properties: { textureSrc: 'https://cdn.virvi.io/a.png', frame: defaultFrame('gallery') } },
    })
    expect(res.statusCode).toBe(200)
    expect(await c.waitFor('scene_preset_update')).toMatchObject({
      action: 'upsert', element: 'image', elementData: { sk: el.id, textureSrc: 'https://cdn.virvi.io/a.png', frame: defaultFrame('gallery') },
    })
  })

  it('a frame in a new scene load comes with the image', async () => {
    const host = await createUser()
    const { scene, preset } = await createScene(host)
    await createElement(preset.id, { type: 'image', properties: { textureSrc: 'a.png', frame: defaultFrame() } })
    const c = await joinScene(gs.url, scene.id, tokenFor(host))
    const init = await c.waitFor('scene_preset_update')
    expect(init.scenePreset.images[0]).toMatchObject({ textureSrc: 'a.png', frame: defaultFrame() })
  })
})
