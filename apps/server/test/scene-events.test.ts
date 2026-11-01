import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { db } from '../src/db/connection.js'
import { events, eventSceneLinks } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, randomWallet, testApp, tokenFor, type TestUser } from './helpers/factories.js'

const SECRET = 'headset-secret-events'
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
const H = 3600_000

describe('GET /api/scenes/:sceneId/events', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let owner: TestUser
  let stranger: TestUser
  let sceneId: string
  let otherSceneId: string
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
    owner = await createUser({ wallet: randomWallet() })
    stranger = await createUser({ wallet: randomWallet() })
    sceneId = (await createScene(owner, 'Mine')).scene.id
    otherSceneId = (await createScene(stranger, 'Theirs')).scene.id
    const now = Date.now()
    const mk = async (name: string, start: number | null, end: number | null, scene = sceneId) => {
      const [e] = await db.insert(events).values({ ownerId: owner.id, name, startTime: start === null ? null : new Date(now + start), endTime: end === null ? null : new Date(now + end) }).returning()
      await db.insert(eventSceneLinks).values({ eventId: e.id, sceneId: scene })
      return e
    }
    await mk('Undated', null, null)
    await mk('Later', 5 * H, 6 * H)
    await mk('Soon', 1 * H, 2 * H)
    await mk('Over', -3 * H, -2 * H)
    await mk('Live open-ended', -1 * H, null)
    await mk('Live', -1 * H, 1 * H)
    await mk('Elsewhere', -1 * H, 1 * H, otherSceneId)
  })
  afterEach(async () => { await app.close() })

  it('lists the events a scene is linked to, live first', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/scenes/${sceneId}/events`, headers: as(owner) })
    expect(res.statusCode).toBe(200)
    const list = res.json().events as Array<{ name: string; live: boolean; startTime: string | null; endTime: string | null; id: string }>
    expect(list.map((e) => e.name).sort()).toEqual(['Later', 'Live', 'Live open-ended', 'Over', 'Soon', 'Undated'])
    expect(list.map((e) => e.live)).toEqual([true, true, false, false, false, false])
    expect(list.slice(0, 2).map((e) => e.name).sort()).toEqual(['Live', 'Live open-ended'])
    expect(list.slice(2).map((e) => e.name)).toEqual(['Soon', 'Later', 'Over', 'Undated'])
    expect(Object.keys(list[0]).sort()).toEqual(['endTime', 'id', 'live', 'name', 'startTime'])
  })

  it('hides events from a caller who cannot edit the scene', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/scenes/${sceneId}/events`, headers: as(stranger) })
    expect([res.statusCode, res.json().error]).toEqual([404, 'not_found'])
  })

  it('takes a headset pass for its scene', async () => {
    const { code } = (await app.inject({ method: 'POST', url: '/api/ar/pair', payload: { secretHash: sha256(SECRET), deviceName: 'Vision Pro' } })).json()
    await app.inject({ method: 'POST', url: `/api/ar/pair/${code}/approve`, headers: as(owner), payload: { kind: 'personal' } })
    const deviceId = (await app.inject({ method: 'POST', url: `/api/ar/pair/${code}/claim`, payload: { secret: SECRET } })).json().deviceId
    const pass = async (id: string) => app.inject({ method: 'POST', url: `/api/ar/devices/${deviceId}/pass`, payload: { secret: SECRET, sceneId: id } })
    const headers = { authorization: `Bearer ${(await pass(sceneId)).json().pass}` }
    const ok = await app.inject({ method: 'GET', url: `/api/scenes/${sceneId}/events`, headers })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().events).toHaveLength(6)
    const wrong = await app.inject({ method: 'GET', url: `/api/scenes/${otherSceneId}/events`, headers })
    expect(wrong.statusCode).toBe(403)
  })
})
