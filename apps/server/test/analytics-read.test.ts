import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { analyticsEvents, analyticsHeatmapDaily, analyticsPositions, analyticsRollupHourly, analyticsScenes, analyticsSessions, analyticsCopresenceDaily, sceneRoles } from '../src/db/schema.js'
import { visitorHash } from '../src/analytics/hash.js'
import { resetEmoteLabelCache } from '../src/analytics/labels.js'
import { setDeleteMyDataLimiter } from '../src/routes/analytics-read.js'
import { TokenBucketLimiter } from '../src/analytics/limiter.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, randomWallet, createScene, tokenFor } from './helpers/factories.js'
import { createAnalyticsScene, insertSession } from './helpers/analytics.js'
import { createSetup } from './helpers/setups.js'

describe('analytics read API', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    setDeleteMyDataLimiter(new TokenBucketLimiter())
    app = await testApp()
  })
  afterEach(() => app.close())

  const get = (u: any, url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${tokenFor(u)}` } })

  async function owned() {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const s = await createAnalyticsScene()
    await createSetup(s.id, scene.id)
    return { owner, s }
  }

  it('summary and timeseries come from rollups; strangers get 403', async () => {
    const { owner, s } = await owned()
    const h = new Date(Date.now() - 2 * 3600_000)
    h.setUTCMinutes(0, 0, 0)
    await db.insert(analyticsRollupHourly).values([
      { sceneId: s.id, hour: h, sessions: 3, uniqueVisitors: 2, peakConcurrency: 2, dwellAvgSec: 100, interactions: { door: 2 }, countries: { DE: 3 } },
      { sceneId: s.id, hour: new Date(h.getTime() + 3600_000), sessions: 1, uniqueVisitors: 1, peakConcurrency: 1, dwellAvgSec: 300, interactions: { door: 1, bar: 4 }, countries: { US: 1 } },
    ])
    await insertSession(s.id, { visitorHash: 'A', startedAt: h })
    await insertSession(s.id, { visitorHash: 'B', startedAt: h })
    await insertSession(s.id, { visitorHash: 'A', startedAt: new Date(h.getTime() + 3600_000) })
    const sum = await get(owner, `/api/analytics/locations/${s.id}/summary`)
    expect(sum.statusCode).toBe(200)
    expect(sum.json()).toMatchObject({ sessions: 4, uniqueVisitors: 2, peakConcurrency: 2, dwellAvgSec: 150, interactions: { door: 3, bar: 4 }, countries: { DE: 3, US: 1 } })
    const ts = await get(owner, `/api/analytics/locations/${s.id}/timeseries?bucket=hour`)
    expect(ts.json().points).toHaveLength(2)
    const stranger = await createUser()
    expect((await get(stranger, `/api/analytics/locations/${s.id}/summary`)).statusCode).toBe(403)
  })

  it('summary labels emotes and folds pre-naming entity:<n> targets into one row', async () => {
    const { owner, s } = await owned()
    resetEmoteLabelCache()
    const urn = 'urn:decentraland:matic:collections-v2:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:0'
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ pointers: [urn], metadata: { name: 'Cool Dance' } }]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const h = new Date(Date.now() - 2 * 3600_000)
      h.setUTCMinutes(0, 0, 0)
      await db.insert(analyticsRollupHourly).values([
        { sceneId: s.id, hour: h, sessions: 1, uniqueVisitors: 1, peakConcurrency: 1, dwellAvgSec: 10, interactions: { 'entity:539': 2, Door: 1 }, emotes: { wave: 1, [urn]: 2 } },
        { sceneId: s.id, hour: new Date(h.getTime() + 3600_000), sessions: 1, uniqueVisitors: 1, peakConcurrency: 1, dwellAvgSec: 10, interactions: { 'entity:541': 3 }, emotes: { [urn]: 1 } },
      ])
      const res = await get(owner, `/api/analytics/locations/${s.id}/summary`)
      expect(res.statusCode).toBe(200)
      expect(res.json().interactions).toEqual({ 'Unnamed objects (older data)': 5, Door: 1 })
      expect(res.json().emotes).toEqual({ wave: 1, [urn]: 3 })
      expect(res.json().emoteLabels).toEqual({ wave: 'Wave', [urn]: 'Cool Dance' })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('summary resolves names only for the 50 most used emotes', async () => {
    const { owner, s } = await owned()
    resetEmoteLabelCache()
    const urn = (i: number) => `urn:decentraland:matic:collections-v2:0x${String(i).padStart(40, '0')}:0`
    const emotes = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [urn(i), i + 1]))
    const fetchMock = vi.fn(async (_u: string, init: RequestInit) => new Response(JSON.stringify(JSON.parse(init.body as string).pointers.map((p: string) => ({ pointers: [p], metadata: { name: 'N' } }))), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const h = new Date(Date.now() - 2 * 3600_000)
      h.setUTCMinutes(0, 0, 0)
      await db.insert(analyticsRollupHourly).values({ sceneId: s.id, hour: h, sessions: 1, uniqueVisitors: 1, peakConcurrency: 1, dwellAvgSec: 10, emotes })
      const res = await get(owner, `/api/analytics/locations/${s.id}/summary`)
      expect(res.statusCode).toBe(200)
      const sent = fetchMock.mock.calls.flatMap((c: any) => JSON.parse(c[1].body).pointers)
      expect(new Set(sent)).toEqual(new Set(Array.from({ length: 50 }, (_, i) => urn(i + 10))))
      expect(Object.keys(res.json().emoteLabels)).toHaveLength(60)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('summary still answers when the catalyst is down', async () => {
    const { owner, s } = await owned()
    resetEmoteLabelCache()
    const urn = 'urn:decentraland:matic:collections-v2:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:0'
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('down'))))
    try {
      const h = new Date(Date.now() - 2 * 3600_000)
      h.setUTCMinutes(0, 0, 0)
      await db.insert(analyticsRollupHourly).values({ sceneId: s.id, hour: h, sessions: 1, uniqueVisitors: 1, peakConcurrency: 1, dwellAvgSec: 10, emotes: { [urn]: 2 } })
      const res = await get(owner, `/api/analytics/locations/${s.id}/summary`)
      expect(res.statusCode).toBe(200)
      expect(res.json().emotes).toEqual({ [urn]: 2 })
      expect(res.json().emoteLabels).toEqual({ [urn]: '0xaaaa…aaaa:0' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects invalid date ranges', async () => {
    const { owner, s } = await owned()
    expect((await get(owner, `/api/analytics/locations/${s.id}/summary?from=nope`)).statusCode).toBe(400)
  })

  it('live returns current sessions with their latest position only', async () => {
    const { owner, s } = await owned()
    const live = await insertSession(s.id, { lastSeenAt: new Date() })
    await insertSession(s.id, { lastSeenAt: new Date(Date.now() - 5 * 60_000) })
    await db.insert(analyticsPositions).values([
      { sceneId: s.id, sessionId: live.id, seq: 1, occurredAt: new Date(Date.now() - 6000), x: 1, y: 0, z: 1 },
      { sceneId: s.id, sessionId: live.id, seq: 2, occurredAt: new Date(Date.now() - 3000), x: 2, y: 0, z: 3 },
    ])
    expect((await get(owner, `/api/analytics/locations/${s.id}/live`)).json()).toEqual({ count: 1, positions: [{ x: 2, z: 3 }] })
  })

  it('heatmap sums cells over the range', async () => {
    const { owner, s } = await owned()
    const today = new Date().toISOString().slice(0, 10)
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10)
    await db.insert(analyticsHeatmapDaily).values([
      { sceneId: s.id, day: today, cellX: 3, cellZ: 4, dwellSec: 10, visits: 1 },
      { sceneId: s.id, day: yesterday, cellX: 3, cellZ: 4, dwellSec: 5, visits: 2 },
    ])
    expect((await get(owner, `/api/analytics/locations/${s.id}/heatmap`)).json().cells).toEqual([{ x: 3, z: 4, dwellSec: 15, visits: 3 }])
  })

  it('turning wallet visibility off removes revealed identities; only managers may change it', async () => {
    const { owner, s } = await owned()
    await db.update(analyticsScenes).set({ walletVisibility: true }).where(eq(analyticsScenes.id, s.id))
    await insertSession(s.id, { wallet: '0xabc', displayName: 'Ana' })
    const viewerUser = await createUser()
    const deny = await app.inject({ method: 'PATCH', url: `/api/analytics/locations/${s.id}`, payload: { walletVisibility: false }, headers: { authorization: `Bearer ${tokenFor(viewerUser)}` } })
    expect(deny.statusCode).toBe(403)
    const res = await app.inject({ method: 'PATCH', url: `/api/analytics/locations/${s.id}`, payload: { walletVisibility: false }, headers: { authorization: `Bearer ${tokenFor(owner)}` } })
    expect(res.statusCode).toBe(200)
    const [row] = await db.select().from(analyticsSessions)
    expect(row).toMatchObject({ wallet: null, displayName: null })
    expect(row.visitorHash).toBeTruthy()
  })

  it('sessions are paged with a cursor', async () => {
    const { owner, s } = await owned()
    for (let i = 0; i < 3; i++) await insertSession(s.id, { startedAt: new Date(Date.now() - (i + 1) * 60_000) })
    const p1 = (await get(owner, `/api/analytics/locations/${s.id}/sessions?limit=2`)).json()
    expect(p1.sessions).toHaveLength(2)
    expect(p1.sessions[0]).not.toHaveProperty('visitorHash')
    expect(p1.sessions[0]).toHaveProperty('userId')
    const all = await db.select().from(analyticsSessions)
    const body = JSON.stringify(p1)
    for (const r of all) expect(body).not.toContain(r.visitorHash)
    const p2 = (await get(owner, `/api/analytics/locations/${s.id}/sessions?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`)).json()
    expect(p2.sessions).toHaveLength(1)
    expect(p2.nextCursor).toBeNull()
  })

  it('locations lists only scenes the user can read', async () => {
    const { owner, s } = await owned()
    await createAnalyticsScene()
    expect((await get(owner, '/api/analytics/locations')).json().scenes.map((x: any) => x.id)).toEqual([s.id])
  })

  it('day buckets count distinct visitors per day, not summed hourly uniques', async () => {
    const { owner, s } = await owned()
    const day = new Date()
    day.setUTCHours(0, 0, 0, 0)
    day.setUTCDate(day.getUTCDate() - 1)
    for (const h of [1, 5, 9]) {
      const hour = new Date(day.getTime() + h * 3600_000)
      await db.insert(analyticsRollupHourly).values({ sceneId: s.id, hour, sessions: 1, uniqueVisitors: 1, peakConcurrency: 1, dwellAvgSec: 10 })
      await insertSession(s.id, { visitorHash: 'SAME', startedAt: hour })
    }
    const ts = await get(owner, `/api/analytics/locations/${s.id}/timeseries?bucket=day`)
    expect(ts.json().points).toHaveLength(1)
    expect(ts.json().points[0]).toMatchObject({ sessions: 3, uniqueVisitors: 1 })
  })

  it('live positions are ordered by x then z', async () => {
    const { owner, s } = await owned()
    for (const [x, z] of [[5, 1], [1, 9], [1, 2]]) {
      const sess = await insertSession(s.id, { lastSeenAt: new Date() })
      await db.insert(analyticsPositions).values({ sceneId: s.id, sessionId: sess.id, seq: 1, occurredAt: new Date(), x, y: 0, z })
    }
    expect((await get(owner, `/api/analytics/locations/${s.id}/live`)).json().positions).toEqual([{ x: 1, z: 2 }, { x: 1, z: 9 }, { x: 5, z: 1 }])
  })

  it('rejects a sessions cursor whose id is not a UUID', async () => {
    const { owner, s } = await owned()
    const res = await get(owner, `/api/analytics/locations/${s.id}/sessions?cursor=${encodeURIComponent(new Date().toISOString() + '|not-a-uuid')}`)
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid cursor' })
  })

  it('rejects ranges longer than 400 days', async () => {
    const { owner, s } = await owned()
    const to = new Date()
    const from = new Date(to.getTime() - 401 * 86400_000)
    for (const p of ['summary', 'timeseries', 'heatmap']) {
      expect((await get(owner, `/api/analytics/locations/${s.id}/${p}?from=${from.toISOString()}&to=${to.toISOString()}`)).statusCode).toBe(400)
    }
  })

  it('locations rows carry the tenure scene id, parcels and whether the reader may manage', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const s = await createAnalyticsScene({ baseParcel: '10,20', parcels: ['10,20', '11,20'] })
    await createSetup(s.id, scene.id)
    const [row] = (await get(owner, '/api/analytics/locations')).json().scenes
    expect(row).toMatchObject({ id: s.id, virviSceneId: scene.id, baseParcel: '10,20', parcels: ['10,20', '11,20'], canManage: true })
  })

  it('a viewer role reads the location but may not manage it', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const s = await createAnalyticsScene()
    await createSetup(s.id, scene.id)
    const wallet = randomWallet()
    const viewer = await createUser({ wallet })
    await db.insert(sceneRoles).values({ sceneId: scene.id, walletAddress: wallet, userId: viewer.id, role: 'viewer', grantedByUserId: owner.id })
    const [row] = (await get(viewer, '/api/analytics/locations')).json().scenes
    expect(row).toMatchObject({ id: s.id, virviSceneId: scene.id, canManage: false })
  })

  it("an ended tenure's host only sees data from inside that tenure, and live is empty", async () => {
    const owner = await createUser()
    const lapsedAt = new Date(Date.now() - 2 * 86400_000)
    lapsedAt.setUTCHours(12, 0, 0, 0)
    const startedAt = new Date(lapsedAt.getTime() - 3 * 86400_000)
    const { scene } = await createScene(owner)
    const s = await createAnalyticsScene()
    await createSetup(s.id, scene.id, { startedAt, endedAt: lapsedAt })
    const before = new Date(lapsedAt.getTime() - 3 * 3600_000)
    const after = new Date(lapsedAt.getTime() + 3 * 3600_000)
    const earlier = new Date(startedAt.getTime() - 3 * 3600_000)
    await db.insert(analyticsRollupHourly).values([
      { sceneId: s.id, hour: earlier, sessions: 11, uniqueVisitors: 11, peakConcurrency: 9, dwellAvgSec: 10 },
      { sceneId: s.id, hour: before, sessions: 2, uniqueVisitors: 1, peakConcurrency: 1, dwellAvgSec: 10 },
      { sceneId: s.id, hour: after, sessions: 5, uniqueVisitors: 5, peakConcurrency: 5, dwellAvgSec: 10 },
    ])
    await insertSession(s.id, { visitorHash: 'EARLIER', startedAt: earlier, lastSeenAt: earlier })
    await insertSession(s.id, { visitorHash: 'OLD', startedAt: before, lastSeenAt: before })
    await insertSession(s.id, { visitorHash: 'NEW', startedAt: after, lastSeenAt: after })
    const live = await insertSession(s.id, { visitorHash: 'LIVE', lastSeenAt: new Date() })
    await db.insert(analyticsPositions).values({ sceneId: s.id, sessionId: live.id, seq: 1, occurredAt: new Date(), x: 1, y: 0, z: 1 })
    const lapsedDay = lapsedAt.toISOString().slice(0, 10)
    const dayBefore = new Date(lapsedAt.getTime() - 86400_000).toISOString().slice(0, 10)
    await db.insert(analyticsHeatmapDaily).values([
      { sceneId: s.id, day: new Date(startedAt.getTime() - 86400_000).toISOString().slice(0, 10), cellX: 3, cellZ: 3, dwellSec: 5, visits: 1 },
      { sceneId: s.id, day: dayBefore, cellX: 1, cellZ: 1, dwellSec: 7, visits: 1 },
      { sceneId: s.id, day: lapsedDay, cellX: 2, cellZ: 2, dwellSec: 9, visits: 1 },
    ])
    const q = `from=${new Date(lapsedAt.getTime() - 5 * 86400_000).toISOString()}&to=${new Date().toISOString()}`
    expect((await get(owner, `/api/analytics/locations/${s.id}/summary?${q}`)).json()).toMatchObject({ sessions: 2, uniqueVisitors: 1, peakConcurrency: 1 })
    const ts = (await get(owner, `/api/analytics/locations/${s.id}/timeseries?bucket=hour&${q}`)).json()
    expect(ts.points.map((p: any) => p.sessions)).toEqual([2])
    expect((await get(owner, `/api/analytics/locations/${s.id}/heatmap?${q}`)).json().cells).toEqual([{ x: 1, z: 1, dwellSec: 7, visits: 1 }])
    expect((await get(owner, `/api/analytics/locations/${s.id}/live`)).json()).toEqual({ count: 0, positions: [] })
    const sessions = (await get(owner, `/api/analytics/locations/${s.id}/sessions`)).json().sessions
    expect(sessions).toHaveLength(1)
    expect(new Date(sessions[0].startedAt).getTime()).toBe(before.getTime())
    const [row] = (await get(owner, '/api/analytics/locations')).json().scenes
    expect(row).toMatchObject({ id: s.id, virviSceneId: scene.id, canManage: false })
  })

  it('delete-my-data removes the visitor everywhere using each scene salt', async () => {
    const W = '0x00000000000000000000000000000000000000d1'
    const me = await createUser({ wallet: W })
    const a = await createAnalyticsScene()
    const b = await createAnalyticsScene()
    for (const sc of [a, b]) {
      const h = visitorHash(sc.salt, W)
      const sess = await insertSession(sc.id, { visitorHash: h })
      await db.insert(analyticsEvents).values({ sceneId: sc.id, sessionId: sess.id, seq: 0, visitorHash: h, type: 'custom', occurredAt: new Date() })
      await db.insert(analyticsPositions).values({ sceneId: sc.id, sessionId: sess.id, seq: 1, occurredAt: new Date(), x: 1, y: 0, z: 1 })
      await db.insert(analyticsCopresenceDaily).values({ sceneId: sc.id, day: '2026-10-01', visitorA: h, visitorB: 'other', overlapSec: 400 })
      await insertSession(sc.id, { visitorHash: 'someone-else' })
    }
    const res = await app.inject({ method: 'POST', url: '/api/analytics/me/delete', headers: { authorization: `Bearer ${tokenFor(me)}` } })
    expect(res.json().deleted).toEqual({ sessions: 2, events: 2, positions: 2, copresence: 2 })
    expect(await db.select().from(analyticsSessions)).toHaveLength(2)
  })

  it('delete-my-data deletes events by the deleted sessions\' ids', async () => {
    const W = '0x00000000000000000000000000000000000000d2'
    const me = await createUser({ wallet: W })
    const sc = await createAnalyticsScene()
    const sess = await insertSession(sc.id, { visitorHash: visitorHash(sc.salt, W) })
    // Keyed by session id (session_id index), not a visitor_hash scan.
    await db.insert(analyticsEvents).values({ sceneId: sc.id, sessionId: sess.id, seq: 0, visitorHash: 'not-the-hash', type: 'custom', occurredAt: new Date() })
    const res = await app.inject({ method: 'POST', url: '/api/analytics/me/delete', headers: { authorization: `Bearer ${tokenFor(me)}` } })
    expect(res.json().deleted).toMatchObject({ sessions: 1, events: 1 })
    expect(await db.select().from(analyticsEvents)).toHaveLength(0)
  })

  it('delete-my-data is limited to 3 requests per hour per user', async () => {
    const me = await createUser({ wallet: '0x00000000000000000000000000000000000000d3' })
    const other = await createUser({ wallet: '0x00000000000000000000000000000000000000d4' })
    const del = (u: any) => app.inject({ method: 'POST', url: '/api/analytics/me/delete', headers: { authorization: `Bearer ${tokenFor(u)}` } })
    for (let i = 0; i < 3; i++) expect((await del(me)).statusCode).toBe(200)
    const r = await del(me)
    expect(r.statusCode).toBe(429)
    expect(r.json().retryAfter).toBeGreaterThan(0)
    expect((await del(other)).statusCode).toBe(200)
  })
})
