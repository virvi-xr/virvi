import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { scenes, sceneCollaborators } from '../src/db/schema.js'
import { STATE_MAX_KEYS } from '../src/scenes/state.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, testApp, tokenFor, type TestUser } from './helpers/factories.js'
import { startGameServer, joinScene } from './helpers/game-server.js'

/** Scene state (LIV-158): REST, the room's init and changes, who may write, and the limits. */
const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })

describe('scene state over REST', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { await app.close() })

  it('editors set, read and delete keys; strangers get 403', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    const { scene } = await createScene(owner)
    const url = (k = '') => `/api/scenes/${scene.id}/state${k ? `/${k}` : ''}`
    expect((await app.inject({ method: 'PUT', url: url('doors'), headers: as(owner), payload: { value: { open: true, at: 3 } } })).statusCode).toBe(200)
    expect((await app.inject({ method: 'PUT', url: url('score'), headers: as(owner), payload: { value: 0 } })).statusCode).toBe(200)
    const got = await app.inject({ method: 'GET', url: url(), headers: as(owner) })
    expect(got.json()).toMatchObject({ state: { doors: { open: true, at: 3 }, score: 0 }, writes: 'staff', limits: { keys: STATE_MAX_KEYS, valueBytes: 4096 } })
    expect((await app.inject({ method: 'GET', url: url(), headers: as(stranger) })).statusCode).toBe(403)
    expect((await app.inject({ method: 'PUT', url: url('x'), headers: as(stranger), payload: { value: 1 } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'DELETE', url: url('score'), headers: as(owner) })).statusCode).toBe(204)
    expect((await app.inject({ method: 'DELETE', url: url('score'), headers: as(owner) })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: url(), headers: as(owner) })).json().state).toEqual({ doors: { open: true, at: 3 } })
  })

  it('refuses bad keys, missing or oversized values, and more than the key limit', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const put = (k: string, payload: unknown) => app.inject({ method: 'PUT', url: `/api/scenes/${scene.id}/state/${k}`, headers: as(owner), payload: payload as any })
    expect((await put('bad%20key', { value: 1 })).json().error).toBe('bad_key')
    expect((await put('ok', {})).json().error).toBe('bad_value')
    expect((await put('ok', { value: 'x'.repeat(5000) })).json().error).toBe('value_too_large')
    for (let i = 0; i < STATE_MAX_KEYS; i++) expect((await put(`k${i}`, { value: i })).statusCode).toBe(200)
    const over = await put('one-more', { value: 1 })
    expect(over.statusCode).toBe(409)
    expect(over.json().error).toBe('too_many_keys')
    // Overwriting an existing key is still fine at the limit
    expect((await put('k0', { value: 'again' })).statusCode).toBe(200)
  })

  it('state-settings switches who may write, editors only', async () => {
    const owner = await createUser()
    const viewer = await createUser()
    const { scene } = await createScene(owner)
    await db.insert(sceneCollaborators).values({ sceneId: scene.id, userId: viewer.id, role: 'viewer' })
    const set = (u: TestUser, writes: unknown) => app.inject({ method: 'PUT', url: `/api/scenes/${scene.id}/state-settings`, headers: as(u), payload: { writes } as any })
    expect((await set(owner, 'anyone')).statusCode).toBe(400)
    expect((await set(owner, 'everyone')).json()).toEqual({ writes: 'everyone' })
    expect((await db.query.scenes.findFirst({ where: eq(scenes.id, scene.id) }))!.stateWrites).toBe('everyone')
    expect((await set(viewer, 'staff')).statusCode).toBe(403)
  })
})

describe('scene state in the room', () => {
  let gs: Awaited<ReturnType<typeof startGameServer>>
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); gs = await startGameServer(); app = await testApp() })
  afterEach(async () => { await app.close(); await gs.stop() })

  it('sends the state on join, and every copy hears an editor change; visitors are refused until writes are open', async () => {
    const owner = await createUser()
    const visitor = await createUser()
    const { scene } = await createScene(owner)
    await app.inject({ method: 'PUT', url: `/api/scenes/${scene.id}/state/round`, headers: as(owner), payload: { value: 1 } })
    const host = await joinScene(gs.url, scene.id, tokenFor(owner))
    const guest = await joinScene(gs.url, scene.id, tokenFor(visitor))
    expect((await host.waitFor('scene_state_init')).state).toEqual({ round: 1 })
    expect((await guest.waitFor('scene_state_init')).state).toEqual({ round: 1 })

    host.room.send('scene_state_set', { ref: 'a1', key: 'round', value: 2 })
    expect(await host.waitFor('scene_state_ack')).toEqual({ ref: 'a1', ok: true })
    // Everyone hears it, the sender too
    expect(await guest.waitFor('scene_state')).toEqual({ key: 'round', value: 2, deleted: false })
    expect(await host.waitFor('scene_state')).toEqual({ key: 'round', value: 2, deleted: false })

    guest.room.send('scene_state_set', { ref: 'g1', key: 'round', value: 99 })
    expect(await guest.waitFor('scene_state_ack')).toMatchObject({ ref: 'g1', ok: false, error: 'forbidden' })

    await db.update(scenes).set({ stateWrites: 'everyone' }).where(eq(scenes.id, scene.id))
    guest.room.send('scene_state_set', { ref: 'g2', key: 'clicks', value: 1 })
    expect(await guest.waitFor('scene_state_ack')).toEqual({ ref: 'g2', ok: true })
    expect(await host.waitFor('scene_state')).toEqual({ key: 'clicks', value: 1, deleted: false })
    expect(await guest.waitFor('scene_state')).toEqual({ key: 'clicks', value: 1, deleted: false })

    guest.room.send('scene_state_set', { ref: 'g3', key: 'bad key', value: 1 })
    expect(await guest.waitFor('scene_state_ack')).toMatchObject({ ref: 'g3', ok: false, error: 'bad_key' })

    host.room.send('scene_state_delete', { ref: 'd1', key: 'round' })
    expect(await host.waitFor('scene_state_ack')).toEqual({ ref: 'd1', ok: true })
    // A REST change reaches the room too
    await app.inject({ method: 'DELETE', url: `/api/scenes/${scene.id}/state/clicks`, headers: as(owner) })
    const changes = [await guest.waitFor('scene_state'), await guest.waitFor('scene_state')]
    expect(changes).toEqual([
      { key: 'round', value: null, deleted: true },
      { key: 'clicks', value: null, deleted: true },
    ])
  })
})
