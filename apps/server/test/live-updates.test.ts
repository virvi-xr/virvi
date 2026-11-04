import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { scenePresets } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, createElement, createInstance, tokenFor, testApp, randomWallet } from './helpers/factories.js'
import { startGameServer, joinScene, serverRoom } from './helpers/game-server.js'
import { initBus } from '../src/realtime/bus.js'

describe('REST edits broadcast live updates to scene rooms', () => {
  let gs: Awaited<ReturnType<typeof startGameServer>>
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    gs = await startGameServer()
    app = await testApp()
  })
  afterEach(async () => {
    await app.close()
    await gs.stop()
  })

  it('role-less wallet and guest sessions join content-only: init + live upserts', async () => {
    const host = await createUser()
    const { scene, preset } = await createScene(host)
    // A verified wallet with no relation to the scene, and a platform-auth guest token.
    const visitor = await createUser({ role: 'viewer', email: null, wallet: randomWallet() })
    const guestToken = tokenFor(visitor, { id: 'guest:abc', wallet: null, verified: false, guest: true })
    const v = await joinScene(gs.url, scene.id, tokenFor(visitor))
    const g = await joinScene(gs.url, scene.id, guestToken)
    for (const c of [v, g]) expect((await c.waitFor('scene_preset_update')).action).toBe('init')
    const created = await app.inject({
      method: 'POST',
      url: `/api/presets/${preset.id}/elements`,
      headers: { authorization: `Bearer ${tokenFor(host)}` },
      payload: { type: 'image', name: 'Poster', properties: { textureSrc: 'https://cdn.virvi.io/u1/a.png' } },
    })
    expect(created.statusCode).toBe(201)
    for (const c of [v, g]) {
      expect(await c.waitFor('scene_preset_update')).toMatchObject({ action: 'upsert', element: 'image' })
    }
  })

  it('element and instance create/update/delete reach the room as upserts and deletes', async () => {
    const host = await createUser()
    const { scene, preset } = await createScene(host)
    const headers = { authorization: `Bearer ${tokenFor(host)}` }
    const c = await joinScene(gs.url, scene.id, tokenFor(host))
    expect((await c.waitFor('scene_preset_update')).action).toBe('init')

    const created = await app.inject({
      method: 'POST',
      url: `/api/presets/${preset.id}/elements`,
      headers,
      payload: { type: 'image', name: 'Poster', properties: { textureSrc: 'https://cdn.virvi.io/u1/a.png' } },
    })
    expect(created.statusCode).toBe(201)
    const elementId = created.json().element.id
    let msg = await c.waitFor('scene_preset_update')
    expect(msg).toMatchObject({
      action: 'upsert',
      element: 'image',
      elementData: { sk: elementId, textureSrc: 'https://cdn.virvi.io/u1/a.png', instances: [] },
    })

    const inst = await app.inject({
      method: 'POST',
      url: `/api/elements/${elementId}/instances`,
      headers,
      payload: { position: { x: 4, y: 5, z: 6 } },
    })
    expect(inst.statusCode).toBe(201)
    const instanceId = inst.json().instance.id
    msg = await c.waitFor('scene_preset_update')
    expect(msg.action).toBe('upsert')
    expect(msg.elementData.instances).toHaveLength(1)
    expect(msg.elementData.instances[0]).toMatchObject({ sk: instanceId, position: { x: 4, y: 5, z: 6 } })

    const moved = await app.inject({
      method: 'PUT',
      url: `/api/instances/${instanceId}`,
      headers,
      payload: { position: { x: 7, y: 8, z: 9 } },
    })
    expect(moved.statusCode).toBe(200)
    msg = await c.waitFor('scene_preset_update')
    expect(msg.action).toBe('upsert')
    expect(msg.elementData.instances[0].position).toEqual({ x: 7, y: 8, z: 9 })

    const renamed = await app.inject({ method: 'PUT', url: `/api/elements/${elementId}`, headers, payload: { name: 'Big Poster' } })
    expect(renamed.statusCode).toBe(200)
    msg = await c.waitFor('scene_preset_update')
    expect(msg).toMatchObject({ action: 'upsert', element: 'image', elementData: { sk: elementId, name: 'Big Poster' } })

    const instDel = await app.inject({ method: 'DELETE', url: `/api/instances/${instanceId}`, headers })
    expect(instDel.statusCode).toBe(204)
    msg = await c.waitFor('scene_preset_update')
    expect(msg.action).toBe('upsert')
    expect(msg.elementData.instances).toHaveLength(0)

    const elDel = await app.inject({ method: 'DELETE', url: `/api/elements/${elementId}`, headers })
    expect(elDel.statusCode).toBe(204)
    msg = await c.waitFor('scene_preset_update')
    expect(msg).toEqual({ action: 'delete', element: 'image', id: elementId })
  })

  it('deleting all instances of an element reaches the room as one upsert with none left', async () => {
    const host = await createUser()
    const { scene, preset } = await createScene(host)
    const headers = { authorization: `Bearer ${tokenFor(host)}` }
    const element = await createElement(preset.id, { type: 'image', name: 'Poster', properties: { textureSrc: 'https://cdn.virvi.io/u1/a.png' } })
    for (let i = 0; i < 3; i++) await createInstance(element.id)
    const c = await joinScene(gs.url, scene.id, tokenFor(host))
    const init = await c.waitFor('scene_preset_update')
    expect(init.action).toBe('init')
    const res = await app.inject({ method: 'DELETE', url: `/api/elements/${element.id}/instances`, headers })
    expect(res.json()).toEqual({ deleted: 3 })
    // One update for the whole set: the first one after the delete already has no instances left
    const msg = await c.waitFor('scene_preset_update')
    expect(msg).toMatchObject({ action: 'upsert', element: 'image', elementData: { sk: element.id, instances: [] } })
  })

  it('edits to a preset that is not active are not broadcast', async () => {
    const host = await createUser()
    const { scene } = await createScene(host)
    const [other] = await db.insert(scenePresets).values({ sceneId: scene.id, name: 'Other' }).returning()
    const c = await joinScene(gs.url, scene.id, tokenFor(host))
    await c.waitFor('scene_preset_update') // init

    const res = await app.inject({
      method: 'POST',
      url: `/api/presets/${other.id}/elements`,
      headers: { authorization: `Bearer ${tokenFor(host)}` },
      payload: { type: 'image', name: 'Hidden', properties: { textureSrc: 'https://cdn.virvi.io/u1/b.png' } },
    })
    expect(res.statusCode).toBe(201)
    await c.expectNone('scene_preset_update', 300)
  })

  it('making a preset live switches everyone in the scene, visitors included (REST and PUT scene)', async () => {
    const host = await createUser()
    const { scene } = await createScene(host)
    const headers = { authorization: `Bearer ${tokenFor(host)}` }
    const [concert] = await db.insert(scenePresets).values({ sceneId: scene.id, name: 'Concert' }).returning()
    const visitor = await createUser({ role: 'viewer', email: null, wallet: randomWallet() })
    const v = await joinScene(gs.url, scene.id, tokenFor(visitor))
    await v.waitFor('scene_preset_update') // init
    expect((await app.inject({ method: 'POST', url: `/api/presets/${concert.id}/activate`, headers })).statusCode).toBe(200)
    expect((await v.waitFor('scene_change_preset')).scenePreset).toMatchObject({ sk: concert.id })
    const [day] = await db.insert(scenePresets).values({ sceneId: scene.id, name: 'Day' }).returning()
    await app.inject({ method: 'PUT', url: `/api/scenes/${scene.id}`, headers, payload: { activePresetId: day.id } })
    expect((await v.waitFor('scene_change_preset')).scenePreset).toMatchObject({ sk: day.id })
  })

  it('new, renamed and deleted presets reach editors live, but not visitors', async () => {
    const host = await createUser()
    const { scene, preset } = await createScene(host)
    const headers = { authorization: `Bearer ${tokenFor(host)}` }
    const h = await joinScene(gs.url, scene.id, tokenFor(host))
    const visitor = await createUser({ role: 'viewer', email: null, wallet: randomWallet() })
    const v = await joinScene(gs.url, scene.id, tokenFor(visitor))
    for (const c of [h, v]) await c.waitFor('scene_preset_update') // init

    const made = (await app.inject({ method: 'POST', url: `/api/scenes/${scene.id}/presets`, headers, payload: { name: 'Concert', fromPresetId: preset.id } })).json().preset
    expect(await h.waitFor('scene_presets_changed')).toMatchObject({ action: 'upsert', preset: { id: made.id, name: 'Concert' } })
    await app.inject({ method: 'PATCH', url: `/api/presets/${made.id}`, headers, payload: { name: 'Gig' } })
    expect(await h.waitFor('scene_presets_changed')).toMatchObject({ action: 'upsert', preset: { id: made.id, name: 'Gig' } })
    await app.inject({ method: 'DELETE', url: `/api/presets/${made.id}`, headers })
    expect(await h.waitFor('scene_presets_changed')).toEqual({ action: 'delete', presetId: made.id })
    await v.expectNone('scene_presets_changed', 300)
  })

  it('element delete requires scene edit access', async () => {
    const host = await createUser()
    const stranger = await createUser()
    const { preset } = await createScene(host)
    const created = await app.inject({
      method: 'POST',
      url: `/api/presets/${preset.id}/elements`,
      headers: { authorization: `Bearer ${tokenFor(host)}` },
      payload: { type: 'image', name: 'Poster' },
    })
    const elementId = created.json().element.id
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/elements/${elementId}`,
      headers: { authorization: `Bearer ${tokenFor(stranger)}` },
    })
    expect(res.statusCode).toBe(403)
    const missing = await app.inject({
      method: 'DELETE',
      url: `/api/elements/00000000-0000-0000-0000-000000000000`,
      headers: { authorization: `Bearer ${tokenFor(host)}` },
    })
    expect(missing.statusCode).toBe(404)
  })

  it('element changes do not invalidate the room access cache', async () => {
    const host = await createUser()
    const { scene, preset } = await createScene(host)
    const c = await joinScene(gs.url, scene.id, tokenFor(host))
    await c.waitFor('scene_preset_update') // init
    await c.waitFor('venue_access') // sent on join
    const room = serverRoom(c.room.roomId)
    const generation = room.accessGeneration
    await app.inject({
      method: 'POST',
      url: `/api/presets/${preset.id}/elements`,
      headers: { authorization: `Bearer ${tokenFor(host)}` },
      payload: { type: 'image', name: 'Poster' },
    })
    expect((await c.waitFor('scene_preset_update')).action).toBe('upsert')
    expect(room.accessGeneration).toBe(generation)
    await c.expectNone('venue_access', 200)
  })

  it('a failed publish never fails the REST write', async () => {
    const host = await createUser()
    const { preset } = await createScene(host)
    initBus({ publish: () => Promise.reject(new Error('redis down')) })
    const res = await app.inject({
      method: 'POST',
      url: `/api/presets/${preset.id}/elements`,
      headers: { authorization: `Bearer ${tokenFor(host)}` },
      payload: { type: 'image', name: 'Poster' },
    })
    expect(res.statusCode).toBe(201)
  })
})
