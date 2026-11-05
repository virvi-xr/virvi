import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import { eq } from 'drizzle-orm'
import { HYPERFY_FEED, VideoSourceType } from '@virvixr/shared'
import { db } from '../src/db/connection.js'
import { hyperfyWorlds, scenes, screenShowings } from '../src/db/schema.js'
import { initBus, sceneFeedTopic } from '../src/realtime/bus.js'
import { createWorldKey } from '../src/hyperfy/worlds.js'
import { FEED_LIMIT, setFeedHoldMs, setFeedLimiter } from '../src/routes/hyperfy-feed.js'
import { TokenBucketLimiter } from '../src/analytics/limiter.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, createElement, tokenFor, testApp, type TestUser } from './helpers/factories.js'

const { LocalPresence } = createRequire(import.meta.url)('colyseus') as any

describe('GET /api/hyperfy/feed', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let presence: any
  let owner: TestUser
  let sceneId: string
  let presetId: string
  let elementId: string
  let key: string
  let worldId: string

  beforeEach(async () => {
    await resetDb()
    presence = new LocalPresence()
    initBus(presence)
    setFeedLimiter(new TokenBucketLimiter())
    app = await testApp()
    owner = await createUser()
    const { scene, preset } = await createScene(owner, 'World')
    sceneId = scene.id
    presetId = preset.id
    elementId = (await createElement(preset.id, { type: 'image', name: 'Pic', properties: { textureSrc: 'https://x/a.png' } })).id
    const k = createWorldKey()
    key = k.raw
    const [w] = await db.insert(hyperfyWorlds).values({ sceneId, ownerId: owner.id, name: 'W', keyHash: k.hash, keyPrefix: k.prefix }).returning()
    worldId = w.id
  })
  afterEach(async () => {
    setFeedHoldMs(HYPERFY_FEED.holdMs)
    vi.restoreAllMocks()
    await app.close()
  })

  const feed = (since?: string, k: string | null = key) =>
    app.inject({
      method: 'GET',
      url: `/api/hyperfy/feed${since ? `?since=${since}` : ''}`,
      headers: { ...(k ? { authorization: `Bearer ${k}` } : {}), 'x-virvi-app-version': '1' },
    })
  const edit = (url: string) =>
    app.inject({
      method: 'PUT',
      url: `/api/elements/${elementId}`,
      headers: { authorization: `Bearer ${tokenFor(owner)}` },
      payload: { properties: { textureSrc: url } },
    })
  const subscribers = () => presence.subscriptions[sceneFeedTopic(sceneId)]?.length ?? 0
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it('answers 401 invalid_world_key for a world that has ended', async () => {
    await db.update(hyperfyWorlds).set({ status: 'ended', kind: 'hosted' }).where(eq(hyperfyWorlds.id, worldId))
    const res = await app.inject({ method: 'GET', url: '/api/hyperfy/feed', headers: { authorization: `Bearer ${key}` } })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid_world_key' })
  })

  it('answers 401 invalid_world_key for a hosted world that failed (its cleanup may have partly failed)', async () => {
    await db.update(hyperfyWorlds).set({ status: 'failed', kind: 'hosted' }).where(eq(hyperfyWorlds.id, worldId))
    const res = await app.inject({ method: 'GET', url: '/api/hyperfy/feed', headers: { authorization: `Bearer ${key}` } })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid_world_key' })
  })

  it('answers at once without since, and when since is stale', async () => {
    const a = await feed()
    expect(a.statusCode).toBe(200)
    const body = a.json()
    expect(body).toMatchObject({ v: 1 })
    expect(body.version).toMatch(/^[0-9a-f]{64}$/)
    expect(body.scene.images).toHaveLength(1)
    const stale = await feed('0'.repeat(64))
    expect(stale.statusCode).toBe(200)
    expect(stale.json().version).toBe(body.version)
  })

  it('holds, then answers within 1 s of a REST edit with the new version', async () => {
    const { version } = (await feed()).json()
    const started = Date.now()
    const held = feed(version)
    await sleep(200)
    expect((await edit('https://x/b.png')).statusCode).toBe(200)
    const res = await held
    expect(Date.now() - started).toBeLessThan(1200)
    expect(res.statusCode).toBe(200)
    expect(res.json().version).not.toBe(version)
    expect(res.json().scene.images[0].textureSrc ?? JSON.stringify(res.json().scene)).toContain('b.png')
  })

  it('a poll that started before two quick edits returns the latest version', async () => {
    setFeedHoldMs(1500)
    const { version } = (await feed()).json()
    const held = feed(version)
    await sleep(100)
    await Promise.all([edit('https://x/b.png'), edit('https://x/c.png')])
    const res = await held
    expect(res.statusCode).toBe(200)
    expect(res.json().version).not.toBe(version)
    // The held poll may carry either edit; the next poll must then reach the latest at once, never hold on an old one.
    const latest = (await feed()).json()
    const started = Date.now()
    const next = await feed(res.json().version)
    if (res.json().version === latest.version) {
      // Already latest: the follow-up holds until the (short) hold ends and answers the same version.
      expect(next.json().version).toBe(latest.version)
    } else {
      expect(Date.now() - started).toBeLessThan(500)
      expect(next.json().version).toBe(latest.version)
    }
    expect(next.json().scene.images[0].textureSrc ?? JSON.stringify(next.json().scene)).toBe(latest.scene.images[0].textureSrc ?? JSON.stringify(latest.scene))
  })

  it('a touch that lands while the poll is subscribing is not lost', async () => {
    setFeedHoldMs(3000)
    const { version } = (await feed()).json()
    const subscribe = presence.subscribe.bind(presence)
    let fired = false
    presence.subscribe = async (topic: string, cb: (d: unknown) => void) => {
      // Edit (and publish its touch) before this subscription is in place.
      if (!fired && topic === sceneFeedTopic(sceneId)) {
        fired = true
        expect((await edit('https://x/b.png')).statusCode).toBe(200)
      }
      return subscribe(topic, cb)
    }
    const started = Date.now()
    const res = await feed(version)
    expect(fired).toBe(true)
    expect(Date.now() - started).toBeLessThan(1500)
    expect(res.json().version).not.toBe(version)
  })

  it('a failed subscribe answers 500 at once instead of holding', async () => {
    setFeedHoldMs(3000)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { version } = (await feed()).json()
    presence.subscribe = () => Promise.reject(new Error('presence down'))
    const started = Date.now()
    const res = await feed(version)
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'feed_failed' })
    expect(Date.now() - started).toBeLessThan(1000)
    errors.mockRestore()
  })

  it('a failed unsubscribe is logged, not thrown', async () => {
    setFeedHoldMs(200)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { version } = (await feed()).json()
    presence.unsubscribe = () => Promise.reject(new Error('presence down'))
    const res = await feed(version)
    expect(res.statusCode).toBe(200)
    await sleep(20)
    expect(errors).toHaveBeenCalled()
    expect((await feed()).statusCode).toBe(200)
  })

  it('a burst of polls from one IP gets 429, bad keys included', async () => {
    const codes: number[] = []
    for (let i = 0; i < FEED_LIMIT.capacity + 5; i++) codes.push((await feed(undefined, i % 2 ? key : 'virviw_nope')).statusCode)
    expect(codes.slice(0, FEED_LIMIT.capacity).every((c) => c === 200 || c === 401)).toBe(true)
    expect(codes[codes.length - 1]).toBe(429)
    const over = await feed(undefined, 'virviw_nope')
    expect(over.statusCode).toBe(429)
    expect(over.json().retryAfter).toBeGreaterThan(0)
  })

  it('answers unchanged after the hold', async () => {
    setFeedHoldMs(200)
    const { version } = (await feed()).json()
    const started = Date.now()
    const res = await feed(version)
    expect(Date.now() - started).toBeGreaterThanOrEqual(190)
    expect(res.statusCode).toBe(200)
    expect(res.json().version).toBe(version)
  })

  it('401 for a bad key and after rotate-key', async () => {
    expect((await feed(undefined, null)).statusCode).toBe(401)
    const bad = await feed(undefined, 'virviw_nope')
    expect(bad.statusCode).toBe(401)
    expect(bad.json()).toEqual({ error: 'invalid_world_key' })
    expect((await feed(undefined, 'something')).statusCode).toBe(401)
    const next = createWorldKey()
    await db.update(hyperfyWorlds).set({ keyHash: next.hash, keyPrefix: next.prefix }).where(eq(hyperfyWorlds.id, worldId))
    expect((await feed()).statusCode).toBe(401)
    expect((await feed(undefined, next.raw)).statusCode).toBe(200)
  })

  it('feed returns an empty snapshot for a scene with no active preset', async () => {
    await db.update(scenes).set({ activePresetId: null }).where(eq(scenes.id, sceneId))
    const res = await feed()
    expect(res.statusCode).toBe(200)
    expect(res.json().scene).toBeNull()
    expect(res.json().version).toMatch(/^[0-9a-f]{64}$/)
    expect(presetId).toBeTruthy()
  })

  it('feed subscriptions are released after timeout and after client abort', async () => {
    setFeedHoldMs(300)
    const { version } = (await feed()).json()
    const timed = feed(version)
    await sleep(100)
    expect(subscribers()).toBe(1)
    await timed
    expect(subscribers()).toBe(0)

    setFeedHoldMs(10_000)
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as { port: number }).port
    const ac = new AbortController()
    const p = fetch(`http://127.0.0.1:${port}/api/hyperfy/feed?since=${version}`, {
      headers: { authorization: `Bearer ${key}` },
      signal: ac.signal,
    }).catch(() => null)
    const start = Date.now()
    while (subscribers() === 0 && Date.now() - start < 3000) await sleep(20)
    expect(subscribers()).toBe(1)
    ac.abort()
    await p
    const t = Date.now()
    while (subscribers() > 0 && Date.now() - t < 3000) await sleep(20)
    expect(subscribers()).toBe(0)
  })

  it('lastSeenAt is updated, at most once a minute', async () => {
    const seen = async () => (await db.select().from(hyperfyWorlds).where(eq(hyperfyWorlds.id, worldId)))[0].lastSeenAt
    expect(await seen()).toBeNull()
    await feed()
    const first = await seen()
    expect(first).toBeInstanceOf(Date)
    await sleep(30)
    await feed()
    expect((await seen())!.getTime()).toBe(first!.getTime())
    const old = new Date(Date.now() - HYPERFY_FEED.lastSeenThrottleMs - 1000)
    await db.update(hyperfyWorlds).set({ lastSeenAt: old }).where(eq(hyperfyWorlds.id, worldId))
    await feed()
    expect((await seen())!.getTime()).toBeGreaterThan(old.getTime() + 30_000)
  })

  it('404 scene_not_found for a held poll within ~1 s of deleting the scene', async () => {
    const { version } = (await feed()).json()
    const held = feed(version)
    await sleep(200)
    const started = Date.now()
    const del = await app.inject({ method: 'DELETE', url: `/api/scenes/${sceneId}`, headers: { authorization: `Bearer ${tokenFor(owner)}` } })
    expect(del.statusCode).toBe(204)
    const res = await held
    expect(Date.now() - started).toBeLessThan(1000)
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'scene_not_found' })
  })

  describe('scheduled showings (LIV-87)', () => {
    const items = [{ url: 'https://cdn.example/film.mp4', duration: 5400, kind: 'video' as const }]
    let screenId: string
    beforeEach(async () => {
      screenId = (await createElement(presetId, { type: 'video', name: 'Screen', properties: { offType: VideoSourceType.SCHEDULED, playlist: [] } })).id
      await createElement(presetId, { type: 'video', name: 'Plain', properties: { offType: VideoSourceType.PLAYLIST, playlist: [] } })
      // Daily at 00:00 UTC, so one is always running or due within the window
      await db.insert(screenShowings).values({ sceneId, elementId: screenId, title: 'Film', items, recurrence: 'daily', startDate: '2020-01-01', startTime: '00:00', timezone: 'UTC' })
    })

    it('carries the showings of scheduled screens only, and the server clock', async () => {
      const before = Date.now()
      const body = (await feed()).json()
      expect(body.showings).toHaveLength(1)
      expect(body.showings[0].elementId).toBe(screenId)
      expect(body.showings[0].showings[0]).toMatchObject({ title: 'Film', items })
      expect(body.serverTime).toBeGreaterThanOrEqual(before)
      expect(body.serverTime).toBeLessThanOrEqual(Date.now())
    })

    it('the clock does not change the version, so a poll holds', async () => {
      setFeedHoldMs(200)
      const first = (await feed()).json()
      const again = (await feed(first.version)).json()
      expect(again.version).toBe(first.version)
    })

    it('a showing added through the API wakes a held poll with a new version', async () => {
      const { version } = (await feed()).json()
      const held = feed(version)
      await sleep(200)
      const started = Date.now()
      const res = await app.inject({
        method: 'POST',
        url: `/api/elements/${screenId}/showings`,
        headers: { authorization: `Bearer ${tokenFor(owner)}` },
        payload: { title: 'Late show', items: [{ url: 'https://cdn.example/late.mp4', duration: 600 }], recurrence: 'daily', startDate: '2020-01-01', startTime: '12:00', timezone: 'UTC' },
      })
      expect(res.statusCode).toBe(201)
      const body = (await held).json()
      expect(Date.now() - started).toBeLessThan(1000)
      expect(body.version).not.toBe(version)
      expect(body.showings[0].showings.some((s: { title?: string }) => s.title === 'Late show')).toBe(true)
    })
  })
})
