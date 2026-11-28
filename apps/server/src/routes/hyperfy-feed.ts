import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { HUD_VERSION_HEADER, HYPERFY_FEED, checkHyperfyAnalyticsBatch, type HyperfyFeedResponse } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { hyperfyWorlds, sceneElements, scenes } from '../db/schema.js'
import { runClickRules } from '../rules/rules.js'
import { elementChanged } from './scenes.js'
import { findWorldByKey, newerAppVersion } from '../hyperfy/worlds.js'
import { recordHyperfyBatch } from '../hyperfy/analytics.js'
import { createHash } from 'node:crypto'
import { sceneSnapshot } from '../hyperfy/snapshot.js'
import { feedShowings } from '../hyperfy/showings.js'
import { longPoll } from '../http/long-poll.js'
import { TokenBucketLimiter } from '../analytics/limiter.js'

let holdMs: number = HYPERFY_FEED.holdMs

// Per IP, checked before the key: a world polls about 3 times a minute, plus bursts on edits and errors.
export const FEED_LIMIT = { capacity: 120, refillPerSec: 2 }
let limiter = new TokenBucketLimiter()
// Per world: every visitor's clicks together
export const RULE_CLICK_LIMIT = { capacity: 60, refillPerSec: 10 }
const clickLimiter = new TokenBucketLimiter()
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Test hook. */
export function setFeedLimiter(l: TokenBucketLimiter): void {
  limiter = l
}

/** Test hook. */
export function setFeedHoldMs(ms: number): void {
  holdMs = ms
}

export default async function hyperfyFeedRoutes(app: FastifyInstance) {
  app.post(
    '/api/hyperfy/analytics',
    { logLevel: 'warn' }, // world-key auth; default rate limit stays
    async (request, reply) => {
      const auth = request.headers.authorization
      const world = auth?.startsWith('Bearer ') ? await findWorldByKey(auth.slice(7)) : null
      if (!world) return reply.status(401).send({ error: 'invalid_world_key' })
      const checked = checkHyperfyAnalyticsBatch(request.body, Date.now())
      if (!checked.ok) return reply.status(400).send({ error: checked.error })
      return reply.send(await recordHyperfyBatch(world, checked.batch))
    },
  )

  // Click rules (LIV-196): the world's app passes on its visitors' clicks (it limits each visitor; this limits the world)
  app.post<{ Body: { elementId?: unknown } }>(
    '/api/hyperfy/rule-click',
    { logLevel: 'warn', config: { rateLimit: false } },
    async (request, reply) => {
      const auth = request.headers.authorization
      const world = auth?.startsWith('Bearer ') ? await findWorldByKey(auth.slice(7)) : null
      if (!world) return reply.status(401).send({ error: 'invalid_world_key' })
      const limit = clickLimiter.take(`world:${world.id}`, 1, RULE_CLICK_LIMIT.capacity, RULE_CLICK_LIMIT.refillPerSec)
      if (!limit.ok) return reply.status(429).send({ error: 'rate_limited', retryAfter: Math.ceil(limit.retryAfterMs / 1000) })
      const elementId = request.body?.elementId
      if (typeof elementId !== 'string' || !UUID.test(elementId)) return reply.status(400).send({ error: 'bad_element' })
      const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, world.sceneId), columns: { activePresetId: true, deletedAt: true } })
      if (!scene?.activePresetId || scene.deletedAt) return reply.status(404).send({ error: 'Scene not found' })
      const el = await db.query.sceneElements.findFirst({ where: and(eq(sceneElements.id, elementId), eq(sceneElements.presetId, scene.activePresetId)), columns: { id: true } })
      if (!el) return reply.status(404).send({ error: 'Element not found' })
      const ran = await runClickRules({
        sceneId: world.sceneId, presetId: scene.activePresetId, elementId,
        // A Hyperfy visitor has no Virvi identity here: the changes go out, and no one is named for them
        actor: { userId: null, wallet: null, via: 'in_world' },
        elementChanged: (e) => elementChanged(e),
      })
      return reply.send({ ran })
    },
  )

  app.get<{ Querystring: { since?: string } }>(
    '/api/hyperfy/feed',
    // World-key auth with its own per-IP limit (bad keys included); keep the key-bearing polls out of per-request logs.
    { logLevel: 'warn', config: { rateLimit: false } },
    async (request, reply) => {
      const limit = limiter.take(`ip:${request.ip}`, 1, FEED_LIMIT.capacity, FEED_LIMIT.refillPerSec)
      if (!limit.ok) return reply.status(429).send({ error: 'rate_limited', retryAfter: Math.ceil(limit.retryAfterMs / 1000) })
      const auth = request.headers.authorization
      const world = auth?.startsWith('Bearer ') ? await findWorldByKey(auth.slice(7)) : null
      if (!world) return reply.status(401).send({ error: 'invalid_world_key' })

      const now = Date.now()
      // Which Virvi app release the world runs (LIV-33); a change is written straight away, not on the lastSeen throttle
      const appVersion = newerAppVersion(world.appVersion, request.headers[HUD_VERSION_HEADER])
      if (appVersion !== world.appVersion || !world.lastSeenAt || now - world.lastSeenAt.getTime() >= HYPERFY_FEED.lastSeenThrottleMs) {
        await db.update(hyperfyWorlds).set({ lastSeenAt: new Date(now), appVersion }).where(eq(hyperfyWorlds.id, world.id))
      }

      const { sceneId } = world
      return longPoll(request, reply, sceneId, request.query.since, holdMs, async () => {
        const snap = await sceneSnapshot(sceneId)
        if (!snap) return null
        const showings = await feedShowings(snap.scene)
        // Showings change the version; the clock doesn't, or every poll would look like news.
        const version = showings.length
          ? createHash('sha256').update(snap.version).update(JSON.stringify(showings)).digest('hex')
          : snap.version
        const body: HyperfyFeedResponse = { v: HYPERFY_FEED.version, version, scene: snap.scene, showings, serverTime: Date.now() }
        return { version, body }
      })
    },
  )
}
