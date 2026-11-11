import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import type { RoomScanLayout } from '@virvixr/shared'
import { resetDb } from './helpers/db.js'
import { testApp, createUser } from './helpers/factories.js'
import { db } from '../src/db/connection.js'
import { assetLibraryItems, catalogPacks, roomScans, trialEvents, users } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { issueTrialSession } from '../src/auth/trial.js'
import { flushTrialEvents } from '../src/auth/trial-events.js'
import { setTurnstileFetch } from '../src/auth/turnstile.js'
import { insertSceneWithDefaultPreset } from '../src/scenes/create.js'
import { wallsFromOutline } from '../src/room-scan/geometry.js'

const layout = (): RoomScanLayout => {
  const floor: Array<[number, number]> = [[0, 0], [4, 0], [4, 3], [0, 3]]
  return {
    version: 1,
    rooms: [{ label: 'Room', floor, floorY: 0, ceilingHeight: 2.5, walls: wallsFromOutline(floor), objects: [],
      anchor: { source: 'quest-mruk', roomId: 'r', floorAnchorId: null, floorPose: { position: [0, 0, 0], yaw: 0 } } }],
  }
}

describe('trial wizard', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { setTurnstileFetch(null); await app.close() })

  async function makeTrial() {
    const u = await createUser({ email: null })
    await db.update(users).set({ isTrial: true, trialLastActiveAt: new Date() }).where(eq(users.id, u.id))
    const s = issueTrialSession(app, { id: u.id, displayName: u.displayName, role: 'creator', trialLastActiveAt: new Date() })
    return { u, h: { authorization: `Bearer ${s.accessToken}` } }
  }
  const get = (url: string, headers: Record<string, string>) => app.inject({ method: 'GET', url, headers })

  it('a trial loads the wizard', async () => {
    const t = await makeTrial()
    await db.transaction((tx) => insertSceneWithDefaultPreset(tx, t.u.id, 'Mine'))
    const cat = await get('/api/wizard/catalog', t.h)
    expect(cat.statusCode).toBe(200)
    expect(Array.isArray(cat.json().themes)).toBe(true)
    expect(cat.json().themes.length).toBeGreaterThan(0)
    const opt = await get('/api/wizard/options', t.h)
    expect(opt.statusCode).toBe(200)
    expect(opt.json().trial).toBe(true)
    expect(opt.json().scenes).toEqual({ used: 1, limit: null })
  })

  it("a trial's save is account_required", async () => {
    const t = await makeTrial()
    const res = await app.inject({
      method: 'POST', url: '/api/wizard/scenes', headers: t.h,
      payload: { name: 'S', plot: { width: 1, depth: 1, base: { x: 0, y: 0 } }, spawn: { x: 1, z: 1 }, items: [] },
    })
    expect([res.statusCode, res.json()]).toEqual([403, { error: 'account_required', action: 'POST /api/wizard/scenes' }])
  })

  it('a trial sees only its own room scans and previews them', async () => {
    const t = await makeTrial()
    const b = await createUser()
    const [mine] = await db.insert(roomScans).values({ userId: t.u.id, name: 'Mine', source: 'quest-mruk', layout: layout() }).returning()
    const [theirs] = await db.insert(roomScans).values({ userId: b.id, name: 'Theirs', source: 'quest-mruk', layout: layout() }).returning()
    const list = await get('/api/room-scans', t.h)
    expect(list.statusCode).toBe(200)
    expect(list.json().scans.map((s: { id: string }) => s.id)).toEqual([mine.id])
    expect((await get(`/api/room-scans/${mine.id}`, t.h)).statusCode).toBe(200)
    expect((await get(`/api/room-scans/${theirs.id}`, t.h)).statusCode).toBe(404)
    const own = await get(`/api/room-scans/${mine.id}/preview.glb`, t.h)
    expect(own.statusCode).toBe(200)
    expect(own.headers['content-type']).toContain('model/gltf-binary')
    expect((await get(`/api/room-scans/${theirs.id}/preview.glb`, t.h)).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: `/api/room-scans/${theirs.id}`, headers: t.h })).statusCode).toBe(404)
    expect((await db.select().from(roomScans).where(eq(roomScans.id, theirs.id)))).toHaveLength(1)
    expect((await app.inject({ method: 'DELETE', url: `/api/room-scans/${mine.id}`, headers: t.h })).statusCode).toBe(204)
  })

  it("a trial's asset browse shows public assets only", async () => {
    const t = await makeTrial()
    const b = await createUser()
    await db.insert(catalogPacks).values({ id: 'p', name: 'p', source: 'test', license: 'x', attribution: 'x', sourceUrl: 'x', enabled: true })
    const [pub] = await db.insert(assetLibraryItems).values({ name: 'Public', storageKey: 'k/pub', packId: 'p', isPublic: true }).returning()
    const [priv] = await db.insert(assetLibraryItems).values({ name: 'B private', storageKey: 'k/priv', isPublic: false, uploadedBy: b.id }).returning()
    const all = await get('/api/assets', t.h)
    expect(all.statusCode).toBe(200)
    expect(all.json().assets.map((a: { id: string }) => a.id)).toEqual([pub.id])
    const mine = await get('/api/assets?mine=all', t.h)
    expect(mine.statusCode).toBe(200)
    expect(mine.json().assets.map((a: { id: string }) => a.id)).not.toContain(priv.id)
    expect((await get(`/api/assets/${priv.id}`, t.h)).statusCode).toBe(404)
    expect((await get(`/api/assets/${pub.id}`, t.h)).statusCode).toBe(200)
    expect((await get('/api/assets/categories', t.h)).statusCode).toBe(200)
  })

  it('a trial reads its Hyperfy slots', async () => {
    const t = await makeTrial()
    const res = await get('/api/hyperfy/slots', t.h)
    expect(res.statusCode).toBe(200)
    expect(res.json().used).toBe(0)
  })

  it('the trial start records its entry', async () => {
    const saved = config.turnstileSecretKey
    ;(config as any).turnstileSecretKey = 'test-secret'
    setTurnstileFetch((async () => new Response(JSON.stringify({ success: true }))) as unknown as typeof fetch)
    try {
      const start = (entry: unknown, n: string) => app.inject({
        method: 'POST', url: '/api/auth/trial', headers: { 'x-forwarded-for': `10.9.0.${n}` },
        payload: { turnstileToken: 'tok', deviceId: `device-entry-${n}`.padEnd(20, 'x'), entry },
      })
      const scene = await start('scene', '1')
      expect(scene.statusCode).toBe(201)
      const studio = await start('studio', '2')
      const junk = await start('nope', '3')
      const none = await start(undefined, '4')
      await flushTrialEvents()
      const actionOf = async (id: string) =>
        (await db.select().from(trialEvents).where(and(eq(trialEvents.userId, id), eq(trialEvents.kind, 'started'))))[0]?.action
      expect(await actionOf(scene.json().user.id)).toBe('scene')
      expect(await actionOf(studio.json().user.id)).toBe('studio')
      expect(await actionOf(junk.json().user.id)).toBeNull()
      expect(await actionOf(none.json().user.id)).toBeNull()
    } finally { ;(config as any).turnstileSecretKey = saved }
  })
})
