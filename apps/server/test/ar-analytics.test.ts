import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { analyticsScenes, analyticsSessions, locationSetups } from '../src/db/schema.js'
import { runRollups } from '../src/analytics/jobs.js'
import { AR_ANALYTICS_LIMIT, setArAnalyticsLimiter } from '../src/routes/ar-feed.js'
import { TokenBucketLimiter } from '../src/analytics/limiter.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, testApp, tokenFor, type TestUser } from './helpers/factories.js'

const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })

describe('POST /api/ar/spaces/:id/analytics', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let owner: TestUser
  let sceneId: string
  let spaceId: string

  beforeEach(async () => {
    await resetDb()
    setArAnalyticsLimiter(new TokenBucketLimiter())
    app = await testApp()
    owner = await createUser()
    sceneId = (await createScene(owner)).scene.id
    spaceId = (await app.inject({ method: 'POST', url: `/api/scenes/${sceneId}/ar/spaces`, headers: as(owner), payload: { name: 'Arcade' } })).json().id
  })
  afterEach(async () => {
    await app.close()
  })

  const publish = () => app.inject({ method: 'PUT', url: `/api/ar/spaces/${spaceId}`, headers: as(owner), payload: { published: true } })
  const post = (body: Record<string, unknown>) => app.inject({ method: 'POST', url: `/api/ar/spaces/${spaceId}/analytics`, payload: body })
  const T = Date.now() - 60_000
  const batch = (extra: Record<string, unknown> = { platform: 'ar-quest' }) => ({
    v: 1,
    ...extra,
    events: [
      { type: 'enter', playerId: 'p1', t: T },
      { type: 'leave', playerId: 'p1', t: T + 12_000 },
    ],
  })

  it('records an enter and a leave as an ar-quest session', async () => {
    await publish()
    const res = await post(batch())
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ accepted: 2 })
    const [scene] = await db.select().from(analyticsScenes)
    expect(scene).toMatchObject({ kind: 'ar', locationKey: `ar:${spaceId}`, realm: 'ar', title: 'Arcade', virviSceneId: sceneId })
    const [s] = await db.select().from(analyticsSessions)
    expect(s).toMatchObject({ platform: 'ar-quest', verified: false, isGuest: true, durationSec: 12 })

    // The dashboard reads a location from the hour after its setup began (as for Hyperfy worlds); back-date the
    // setup so this visit's hour counts.
    await db.update(locationSetups).set({ startedAt: new Date(T - 3 * 3600_000) })
    // What the dashboard reads: the location summary, built from the hourly rollups.
    await runRollups(new Date())
    const summary = await app.inject({
      method: 'GET',
      url: `/api/analytics/locations/${scene.id}/summary?from=${new Date(T - 3600_000).toISOString()}&to=${new Date(Date.now() + 3600_000).toISOString()}`,
      headers: as(owner),
    })
    expect(summary.statusCode).toBe(200)
    expect(summary.json()).toMatchObject({ sessions: 1, platforms: { 'ar-quest': 1 } })
  })

  it('refuses an unpublished space', async () => {
    expect((await post(batch())).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/ar/spaces/00000000-0000-0000-0000-000000000000/analytics', payload: batch() })).statusCode).toBe(404)
    expect(await db.select().from(analyticsSessions)).toHaveLength(0)
  })

  it('answers 404 for a space id that is not a uuid', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/ar/spaces/not-a-uuid/analytics', payload: batch() })
    expect([res.statusCode, res.json().error]).toEqual([404, 'not_found'])
  })

  it('accepts the iPhone app as ar-ios', async () => {
    await publish()
    const res = await post(batch({ platform: 'ar-ios' }))
    expect(res.statusCode).toBeLessThan(300)
    expect((await db.select().from(analyticsSessions)).length).toBeGreaterThan(0)
  })

  it('refuses other platforms', async () => {
    await publish()
    for (const extra of [{ platform: 'hyperfy' }, { platform: 'ar-android' }, {}]) {
      const res = await post(batch(extra))
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'bad_platform' })
    }
    expect(await db.select().from(analyticsSessions)).toHaveLength(0)
  })

  it('limits each IP', async () => {
    await publish()
    expect(AR_ANALYTICS_LIMIT).toEqual({ capacity: 60, refillPerSec: 1 })
    // Leave this IP two tokens.
    const limiter = new TokenBucketLimiter()
    limiter.take('ip:127.0.0.1', AR_ANALYTICS_LIMIT.capacity - 2, AR_ANALYTICS_LIMIT.capacity, AR_ANALYTICS_LIMIT.refillPerSec)
    setArAnalyticsLimiter(limiter)
    expect((await post(batch())).statusCode).toBe(200)
    expect((await post(batch())).statusCode).toBe(200)
    const res = await post(batch())
    expect(res.statusCode).toBe(429)
    expect(res.json().error).toBe('rate_limited')
  })
})
