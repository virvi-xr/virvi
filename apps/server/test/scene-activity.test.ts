import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { sceneActivity, sceneRoles } from '../src/db/schema.js'
import { FOLD_MS, listSceneActivity, recordSceneActivity } from '../src/scenes/activity.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, createElement, createInstance, tokenFor, randomWallet } from './helpers/factories.js'
import { startGameServer, joinScene } from './helpers/game-server.js'

/** The scene activity log (LIV-32): who changed what in a scene, and when. */

const rowsOf = async (sceneId: string) => (await listSceneActivity(sceneId)).entries

describe('scene activity log', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(() => app.close())
  const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, token: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as any, headers: { authorization: `Bearer ${token}` } })

  it('records element, instance, settings and preset changes made in the dashboard, newest first, with who made them', async () => {
    const host = await createUser({ wallet: randomWallet(), name: 'Hana' })
    const { scene, preset } = await createScene(host)
    const t = tokenFor(host)
    const created = (await call('POST', `/api/presets/${preset.id}/elements`, t, { type: 'image', name: 'Poster' })).json().element
    await call('PUT', `/api/elements/${created.id}`, t, { name: 'Big poster' })
    const inst = (await call('POST', `/api/elements/${created.id}/instances`, t, { position: { x: 1, y: 0, z: 1 } })).json().instance
    await call('DELETE', `/api/instances/${inst.id}`, t)
    await call('PUT', `/api/scenes/${scene.id}`, t, { name: 'Night Club' })
    const p2 = (await call('POST', `/api/scenes/${scene.id}/presets`, t, { name: 'Late' })).json().preset
    await call('POST', `/api/presets/${p2.id}/activate`, t)
    await call('DELETE', `/api/elements/${created.id}`, t)

    const entries = await rowsOf(scene.id)
    expect(entries.map((e) => e.action)).toEqual([
      'element.deleted', 'preset.activated', 'preset.created', 'scene.updated',
      'instance.removed', 'instance.added', 'element.updated', 'element.created',
    ])
    expect(entries.every((e) => e.via === 'dashboard' && e.actor.name === 'Hana')).toBe(true)
    expect(entries.find((e) => e.action === 'element.updated')).toMatchObject({ subject: { type: 'image', id: created.id, name: 'Big poster' }, detail: { changed: ['name'] } })
    expect(entries.find((e) => e.action === 'scene.updated')!.detail).toEqual({ changed: ['name'], from: 'Venue Scene' })
    expect(entries.find((e) => e.action === 'element.deleted')!.subject.name).toBe('Big poster')
  })

  it('folds repeat edits of one thing by one person within a minute into one row', async () => {
    const host = await createUser()
    const { scene, preset } = await createScene(host)
    const el = await createElement(preset.id, { type: 'model', name: 'Couch' })
    const actor = { userId: host.id, wallet: null, via: 'in_world' as const }
    const t0 = new Date('2026-11-26T10:00:00Z')
    await recordSceneActivity(scene.id, actor, 'instance.updated', { type: 'model', id: el.id, name: 'Couch' }, undefined, t0)
    await recordSceneActivity(scene.id, actor, 'instance.updated', { type: 'model', id: el.id, name: 'Couch' }, undefined, new Date(t0.getTime() + 30_000))
    await recordSceneActivity(scene.id, actor, 'instance.updated', { type: 'model', id: el.id, name: 'Couch' }, undefined, new Date(t0.getTime() + 80_000))
    let entries = await rowsOf(scene.id)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ count: 3, firstAt: t0.toISOString(), at: new Date(t0.getTime() + 80_000).toISOString() })

    // A gap longer than the window, another person, or another thing: a new row
    await recordSceneActivity(scene.id, actor, 'instance.updated', { type: 'model', id: el.id }, undefined, new Date(t0.getTime() + 80_000 + FOLD_MS + 1))
    const other = await createUser()
    await recordSceneActivity(scene.id, { userId: other.id, wallet: null, via: 'in_world' }, 'instance.updated', { type: 'model', id: el.id }, undefined, new Date(t0.getTime() + 80_000 + FOLD_MS + 2))
    entries = await rowsOf(scene.id)
    expect(entries.map((e) => e.count)).toEqual([1, 1, 3])
  })

  it('never fails the change it records, and skips a change nobody can be named for', async () => {
    const host = await createUser()
    const { scene } = await createScene(host)
    await recordSceneActivity(scene.id, { userId: null, wallet: null, via: 'in_world' }, 'element.updated', {})
    await expect(recordSceneActivity('00000000-0000-0000-0000-000000000000', { userId: host.id, wallet: null, via: 'dashboard' }, 'element.updated', {})).resolves.toBeUndefined()
    expect(await rowsOf(scene.id)).toEqual([])
  })

  it('records collaborator and wallet role changes', async () => {
    const host = await createUser({ wallet: randomWallet() })
    const { scene } = await createScene(host)
    const t = tokenFor(host)
    const friend = await createUser({ email: 'pal@example.com', name: 'Pal' })
    expect((await call('POST', `/api/scenes/${scene.id}/collaborators`, t, { email: 'pal@example.com', role: 'viewer' })).statusCode).toBe(201)
    await call('PUT', `/api/scenes/${scene.id}/collaborators/${friend.id}`, t, { role: 'editor' })
    await call('DELETE', `/api/scenes/${scene.id}/collaborators/${friend.id}`, t)
    const w = randomWallet()
    await call('POST', `/api/scenes/${scene.id}/roles`, t, { wallet: w, role: 'editor' })
    await call('POST', `/api/scenes/${scene.id}/roles`, t, { wallet: w, role: 'editor' }) // no change: no row
    await call('POST', `/api/scenes/${scene.id}/roles`, t, { wallet: w, role: 'cohost' })
    await call('DELETE', `/api/scenes/${scene.id}/roles/${w}`, t)
    await call('DELETE', `/api/scenes/${scene.id}/roles/${w}`, t) // already gone: no row

    const entries = (await rowsOf(scene.id)).reverse()
    expect(entries.map((e) => [e.action, e.detail])).toEqual([
      ['collaborator.added', { role: 'viewer' }],
      ['collaborator.changed', { role: 'editor', from: 'viewer' }],
      ['collaborator.removed', { role: 'editor' }],
      ['role.granted', { role: 'editor' }],
      ['role.granted', { role: 'cohost', from: 'editor' }],
      ['role.revoked', { role: 'cohost' }],
    ])
    expect(entries[0].subject).toEqual({ type: 'user', id: friend.id, name: 'Pal' })
    expect(entries[3].subject).toMatchObject({ type: 'wallet', id: w })
  })

  it('only the host and co-hosts can read the log; it pages back with a cursor', async () => {
    const host = await createUser({ wallet: randomWallet() })
    const { scene } = await createScene(host)
    const [co, ed, stranger] = await Promise.all([1, 2, 3].map(() => createUser({ wallet: randomWallet() })))
    await db.insert(sceneRoles).values([
      { sceneId: scene.id, walletAddress: co.wallet!, userId: co.id, role: 'cohost' },
      { sceneId: scene.id, walletAddress: ed.wallet!, userId: ed.id, role: 'editor' },
    ])
    const base = new Date('2026-11-20T00:00:00Z').getTime()
    for (let i = 0; i < 5; i++) {
      await recordSceneActivity(scene.id, { userId: host.id, wallet: null, via: 'dashboard' }, 'preset.created', { type: 'preset', id: `p${i}`, name: `P${i}` }, undefined, new Date(base + i * 1000))
    }
    for (const u of [ed, stranger]) expect((await call('GET', `/api/scenes/${scene.id}/activity`, tokenFor(u))).statusCode).toBe(403)
    const first = await call('GET', `/api/scenes/${scene.id}/activity?limit=2`, tokenFor(co))
    expect(first.statusCode).toBe(200)
    const page1 = first.json()
    expect(page1.more).toBe(true)
    expect(page1.entries.map((e: any) => e.subject.name)).toEqual(['P4', 'P3'])
    const last = page1.entries[1]
    const page2 = (await call('GET', `/api/scenes/${scene.id}/activity?limit=2&before=${encodeURIComponent(`${last.at},${last.id}`)}`, tokenFor(host))).json()
    expect(page2.entries.map((e: any) => e.subject.name)).toEqual(['P2', 'P1'])
    expect((await call('GET', `/api/scenes/${scene.id}/activity?before=nope`, tokenFor(host))).statusCode).toBe(400)
  })

  it('a deleted scene keeps its log until it is purged, and records the delete and the restore', async () => {
    const host = await createUser()
    const { scene } = await createScene(host)
    const t = tokenFor(host)
    expect((await call('DELETE', `/api/scenes/${scene.id}`, t)).statusCode).toBe(200)
    expect((await call('POST', `/api/scenes/${scene.id}/restore`, t)).statusCode).toBe(200)
    expect((await rowsOf(scene.id)).map((e) => e.action)).toEqual(['scene.restored', 'scene.deleted'])
  })
})

describe('scene activity from the scene room', () => {
  let gs: Awaited<ReturnType<typeof startGameServer>>
  beforeEach(async () => {
    await resetDb()
    gs = await startGameServer()
  })
  afterEach(() => gs.stop())

  const until = async (fn: () => Promise<boolean>) => {
    for (let i = 0; i < 50; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 20)) }
    throw new Error('timed out')
  }

  it('in-world edits and deletes are recorded as in-world, with the name the thing had', async () => {
    const owner = await createUser()
    const { scene, preset } = await createScene(owner)
    const el = await createElement(preset.id, { type: 'model', name: 'Couch' })
    const inst = await createInstance(el.id)
    const c = await joinScene(gs.url, scene.id, tokenFor(owner))
    await c.waitFor('scene_preset_update') // init
    c.room.send('scene_preset_update', { action: 'update', element: 'model', instance: true, elementData: { sk: el.id }, instanceData: { sk: inst.id, position: { x: 2, y: 0, z: 2 } } })
    await c.waitFor('scene_preset_update_ack')
    c.room.send('scene_preset_update', { action: 'delete', element: 'model', elementData: { sk: el.id } })
    await c.waitFor('scene_preset_update_ack')
    await until(async () => (await db.select().from(sceneActivity).where(eq(sceneActivity.sceneId, scene.id))).length === 2)
    const entries = await rowsOf(scene.id)
    expect(entries.map((e) => [e.action, e.via, e.subject.name])).toEqual([
      ['element.deleted', 'in_world', 'Couch'],
      ['instance.updated', 'in_world', 'Couch'],
    ])
  })
})
