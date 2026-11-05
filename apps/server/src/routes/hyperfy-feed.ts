import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { HYPERFY_FEED, checkHyperfyAnalyticsBatch, type HyperfyFeedResponse } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { hyperfyWorlds } from '../db/schema.js'
import { findWorldByKey } from '../hyperfy/worlds.js'
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
      if (!world.lastSeenAt || now - world.lastSeenAt.getTime() >= HYPERFY_FEED.lastSeenThrottleMs) {
        await db.update(hyperfyWorlds).set({ lastSeenAt: new Date(now) }).where(eq(hyperfyWorlds.id, world.id))
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
