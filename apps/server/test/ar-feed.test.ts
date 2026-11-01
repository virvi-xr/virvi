import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { AR_FEED } from '@virvixr/shared'
import { db } from '../src/db/connection.js'
import { arMarkers } from '../src/db/schema.js'
import { initBus, publishSceneTouched } from '../src/realtime/bus.js'
import { issueScenePass } from '../src/auth/scene-pass.js'
import { AR_FEED_LIMIT, setArFeedHoldMs, setArFeedLimiter } from '../src/routes/ar-feed.js'
import { TokenBucketLimiter } from '../src/analytics/limiter.js'
import { resetDb } from './helpers/db.js'
import { createElement, createScene, createUser, randomWallet, testApp, tokenFor, type TestUser } from './helpers/factories.js'

const { LocalPresence } = createRequire(import.meta.url)('colyseus') as any

const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('AR marker lookup and space feed', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let owner: TestUser
  let sceneId: string
  let presetId: string
  let spaceId: string
  let markerId: string
  let code: string

  beforeEach(async () => {
    await resetDb()
    initBus(new LocalPresence())
    setArFeedLimiter(new TokenBucketLimiter())
    app = await testApp()
    owner = await createUser()
    const { scene, preset } = await createScene(owner)
    sceneId = scene.id
    presetId = preset.id
    const space = (await app.inject({ method: 'POST', url: `/api/scenes/${sceneId}/ar/spaces`, headers: as(owner), payload: { name: 'Arcade' } })).json()
    spaceId = space.id
    const marker = (await app.inject({ method: 'POST', url: `/api/ar/floors/${space.floors[0].id}/markers`, headers: as(owner), payload: { whereText: 'By the door' } })).json()
    markerId = marker.id
    code = marker.code
  })
  afterEach(async () => {
    setArFeedHoldMs(AR_FEED.holdMs)
    await app.close()
  })

  const publish = () => app.inject({ method: 'PUT', url: `/api/ar/spaces/${spaceId}`, headers: as(owner), payload: { published: true } })
  const lookup = (c = code, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url: `/api/ar/markers/by-code/${c}`, headers })
  const feed = (since?: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: `/api/ar/spaces/${spaceId}/feed${since ? `?since=${since}` : ''}`, headers })

  it('looks up a published marker by code, any case', async () => {
    await publish()
    for (const c of [code, code.toLowerCase()]) {
      const res = await lookup(c)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ spaceId, markerId, spaceName: 'Arcade', whereText: 'By the door' })
      expect(res.json().floorId).toEqual(expect.any(String))
    }
    expect((await lookup('ZZZZZZZ')).statusCode).toBe(404)
    expect((await lookup('nope')).statusCode).toBe(404)
  })

  it('hides an unpublished space from visitors', async () => {
    expect((await lookup()).statusCode).toBe(404)
    expect((await feed()).statusCode).toBe(404)
    expect((await lookup(code, as(owner))).statusCode).toBe(200)
    expect((await feed(undefined, as(owner))).statusCode).toBe(200)
    // A signed-in stranger is a visitor.
    const stranger = await createUser()
    expect((await lookup(code, as(stranger))).statusCode).toBe(404)
    expect((await feed(undefined, as(stranger))).statusCode).toBe(404)
    // A bad token is an error, not a visitor.
    expect((await feed(undefined, { authorization: 'Bearer nope' })).statusCode).toBe(401)
  })

  it("holds a scene pass to the space's own scene", async () => {
    await publish()
    const other = await createScene(owner, 'Other')
    const pass = (sid: string) => ({ authorization: `Bearer ${issueScenePass(app, owner as any, owner.wallet ?? '0x0', { sceneId: sid, locationId: null }).accessToken}` })
    expect((await feed(undefined, pass(sceneId))).statusCode).toBe(200)
    expect((await lookup(code, pass(sceneId))).statusCode).toBe(200)
    expect((await feed(undefined, pass(other.scene.id))).statusCode).toBe(403)
    expect((await lookup(code, pass(other.scene.id))).statusCode).toBe(403)
  })

  it('the feed returns the space and the scene', async () => {
    await publish()
    await createElement(presetId, { type: 'image', name: 'Pic', properties: { textureSrc: 'https://x/a.png' } })
    const res = await feed()
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.v).toBe(1)
    expect(body.version).toMatch(/^[0-9a-f]{64}$/)
    expect(body.space.sceneId).toBeUndefined()
    expect(body.space.floors[0].markers[0].code).toBe(code)
    expect(body.scene.images).toHaveLength(1)
  })

  it('the feed holds until the scene changes', async () => {
    await publish()
    const el = await createElement(presetId, { type: 'image', name: 'Pic', properties: { textureSrc: 'https://x/a.png' } })
    const { version } = (await feed()).json()
    setArFeedHoldMs(2000)
    const started = Date.now()
    const held = feed(version)
    await sleep(200)
    const edit = await app.inject({ method: 'PUT', url: `/api/elements/${el.id}`, headers: as(owner), payload: { properties: { textureSrc: 'https://x/b.png' } } })
    expect(edit.statusCode).toBe(200)
    const res = await held
    expect(Date.now() - started).toBeLessThan(1500)
    expect(res.statusCode).toBe(200)
    expect(res.json().version).not.toBe(version)
  })

  it('the feed wakes on a space edit', async () => {
    await publish()
    const { version } = (await feed()).json()
    setArFeedHoldMs(2000)
    const started = Date.now()
    const held = feed(version)
    await sleep(200)
    await db.update(arMarkers).set({ poseX: 1, poseY: 2, poseZ: 3, headingDeg: 90 }).where(eq(arMarkers.id, markerId))
    await publishSceneTouched(sceneId)
    const res = await held
    expect(Date.now() - started).toBeLessThan(1500)
    expect(res.json().version).not.toBe(version)
    expect(res.json().space.floors[0].markers[0].pose).toEqual({ x: 1, y: 2, z: 3, headingDeg: 90 })
  })

  it('unpublishing ends a visitor\'s hold with 404', async () => {
    await publish()
    const { version } = (await feed()).json()
    setArFeedHoldMs(2000)
    const held = feed(version)
    await sleep(200)
    await app.inject({ method: 'PUT', url: `/api/ar/spaces/${spaceId}`, headers: as(owner), payload: { published: false } })
    expect((await held).statusCode).toBe(404)
  })

  it('rate-limits per IP', async () => {
    await publish()
    expect(AR_FEED_LIMIT).toEqual({ capacity: 120, refillPerSec: 2 })
    // Leave this IP two tokens.
    const limiter = new TokenBucketLimiter()
    limiter.take('ip:127.0.0.1', AR_FEED_LIMIT.capacity - 2, AR_FEED_LIMIT.capacity, AR_FEED_LIMIT.refillPerSec)
    setArFeedLimiter(limiter)
    expect((await feed()).statusCode).toBe(200)
    expect((await feed()).statusCode).toBe(200)
    const res = await feed()
    expect(res.statusCode).toBe(429)
    expect(res.json().error).toBe('rate_limited')
  })
})

describe('scene draft feed for headset builders', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let owner: TestUser
  let sceneId: string
  let presetId: string
  const SECRET = 'feed-headset-secret'

  beforeEach(async () => {
    await resetDb()
    initBus(new LocalPresence())
    setArFeedLimiter(new TokenBucketLimiter())
    app = await testApp()
    owner = await createUser({ wallet: randomWallet() })
    const { scene, preset } = await createScene(owner)
    sceneId = scene.id
    presetId = preset.id
  })
  afterEach(async () => {
    setArFeedHoldMs(AR_FEED.holdMs)
    await app.close()
  })

  const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
  const sceneFeed = (id: string, since?: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: `/api/ar/scenes/${id}/feed${since ? `?since=${since}` : ''}`, headers })

  /** Pair a personal headset to `u` and mint a pass for `forScene`. */
  async function scenePass(u: TestUser, forScene: string) {
    const { code } = (await app.inject({ method: 'POST', url: '/api/ar/pair', payload: { secretHash: sha256(SECRET), deviceName: 'Vision Pro' } })).json()
    expect((await app.inject({ method: 'POST', url: `/api/ar/pair/${code}/approve`, headers: as(u), payload: { kind: 'personal' } })).statusCode).toBe(200)
    const { deviceId } = (await app.inject({ method: 'POST', url: `/api/ar/pair/${code}/claim`, payload: { secret: SECRET } })).json()
    const minted = await app.inject({ method: 'POST', url: `/api/ar/devices/${deviceId}/pass`, payload: { secret: SECRET, sceneId: forScene } })
    expect(minted.statusCode).toBe(200)
    return { authorization: `Bearer ${minted.json().pass}` }
  }

  it('serves a scene feed to its builder with an AR pass', async () => {
    await createElement(presetId, { type: 'image', name: 'Pic', properties: { textureSrc: 'https://x/a.png' } })
    const pass = await scenePass(owner, sceneId)
    for (const headers of [pass, as(owner)]) {
      const res = await sceneFeed(sceneId, undefined, headers)
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.v).toBe(1)
      expect(body.version).toMatch(/^[0-9a-f]{64}$/)
      expect(body.scene.images).toHaveLength(1)
      expect(body.version).toBe(createHash('sha256').update(JSON.stringify({ scene: body.scene })).digest('hex'))
    }
  })

  it("hides a scene feed from a visitor and from another scene's pass", async () => {
    const other = await createScene(owner, 'Other')
    const stranger = await createUser()
    expect((await sceneFeed(sceneId)).statusCode).toBe(404)
    expect((await sceneFeed(sceneId, undefined, as(stranger))).statusCode).toBe(404)
    expect((await sceneFeed(sceneId, undefined, await scenePass(owner, other.scene.id))).statusCode).toBe(403)
  })

  it('holds until the scene changes when since matches', async () => {
    const el = await createElement(presetId, { type: 'image', name: 'Pic', properties: { textureSrc: 'https://x/a.png' } })
    const pass = await scenePass(owner, sceneId)
    const { version } = (await sceneFeed(sceneId, undefined, pass)).json()
    setArFeedHoldMs(2000)
    const started = Date.now()
    const held = sceneFeed(sceneId, version, pass)
    await sleep(200)
    const edit = await app.inject({ method: 'PUT', url: `/api/elements/${el.id}`, headers: as(owner), payload: { properties: { textureSrc: 'https://x/b.png' } } })
    expect(edit.statusCode).toBe(200)
    const res = await held
    expect(Date.now() - started).toBeLessThan(1500)
    expect(res.statusCode).toBe(200)
    expect(res.json().version).not.toBe(version)
  })
})
