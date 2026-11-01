import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AR_FEED, checkHyperfyAnalyticsBatch, type ArFeedResponse, type ArSceneFeedResponse, type ArMarkerLookup } from '@virvixr/shared'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess } from '../auth/permissions.js'
import { fromSpace, markerByCode, markerSceneByCode, mayBuild, spaceScene } from '../ar/access.js'
import { fromParam } from '../auth/scene-from.js'
import { sceneSnapshot } from '../hyperfy/snapshot.js'
import { arSpaceSnapshot } from '../ar/snapshot.js'
import { longPoll } from '../http/long-poll.js'
import { TokenBucketLimiter } from '../analytics/limiter.js'
import { getSpace } from '../ar/spaces.js'
import { AR_ANALYTICS_PLATFORMS, recordArBatch } from '../ar/analytics.js'
import { AR_REPORT_REASONS, createArReport } from '../ar/reports.js'

let holdMs: number = AR_FEED.holdMs

// Per IP: a headset polls about 3 times a minute, plus bursts on edits and errors.
export const AR_FEED_LIMIT = { capacity: 120, refillPerSec: 2 }
let limiter = new TokenBucketLimiter()

// Per IP: a headset flushes a batch every few seconds while someone is inside.
export const AR_ANALYTICS_LIMIT = { capacity: 60, refillPerSec: 1 }
let analyticsLimiter = new TokenBucketLimiter()

// Per IP: a visitor sends a report rarely; this stops a flood into the admin page and the support inbox.
export const AR_REPORT_LIMIT = { capacity: 5, refillPerSec: 5 / 3600 }
let reportLimiter = new TokenBucketLimiter()

/** Test hook. */
export function setArReportLimiter(l: TokenBucketLimiter): void {
  reportLimiter = l
}

/** Test hook. */
export function setArAnalyticsLimiter(l: TokenBucketLimiter): void {
  analyticsLimiter = l
}

/** Test hook. */
export function setArFeedLimiter(l: TokenBucketLimiter): void {
  limiter = l
}

/** Test hook. */
export function setArFeedHoldMs(ms: number): void {
  holdMs = ms
}

/**
 * Sign-in is optional here: no Authorization header is a visitor. A header is checked like any other, before
 * anything else is looked up (`authenticate`, which also holds a scene pass to this route's scene and refuses
 * the other kinds of pass). Returns false when `authenticate` already answered.
 *
 * A scene pass for another scene gets 403 here, not a visitor's answer: the headset must only send its pass for the
 * space it was minted for, and call other spaces with no Authorization header.
 */
async function signInIfPresent(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (!request.headers.authorization) return true
  await authenticate(request, reply)
  return !reply.sent
}

/** Whether the signed-in caller (if any) may build in the scene. */
async function isBuilder(request: FastifyRequest, sceneId: string): Promise<boolean> {
  if (!request.headers.authorization) return false
  return mayBuild(await getSceneAccess(actorFromClaims(request.user), sceneId))
}

export default async function arFeedRoutes(app: FastifyInstance) {
  app.get<{ Params: { code: string } }>(
    '/api/ar/markers/by-code/:code',
    { config: { scenePass: { sceneFrom: markerSceneByCode, ar: true } } },
    async (request, reply) => {
      if (!(await signInIfPresent(request, reply))) return
      const marker = await markerByCode(request.params.code)
      if (!marker) return reply.status(404).send({ error: 'not_found' })
      if (!marker.published && !(await isBuilder(request, marker.sceneId))) return reply.status(404).send({ error: 'not_found' })
      const body: ArMarkerLookup = {
        spaceId: marker.spaceId,
        floorId: marker.floorId,
        markerId: marker.markerId,
        spaceName: marker.spaceName,
        whereText: marker.whereText,
      }
      return reply.send(body)
    },
  )

  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    '/api/ar/spaces/:id/feed',
    // Its own per-IP limit (bad tokens included); keep polls out of per-request logs.
    { logLevel: 'warn', config: { rateLimit: false, scenePass: { sceneFrom: fromSpace, ar: true } } },
    async (request, reply) => {
      const limit = limiter.take(`ip:${request.ip}`, 1, AR_FEED_LIMIT.capacity, AR_FEED_LIMIT.refillPerSec)
      if (!limit.ok) return reply.status(429).send({ error: 'rate_limited', retryAfter: Math.ceil(limit.retryAfterMs / 1000) })
      if (!(await signInIfPresent(request, reply))) return
      const spaceId = request.params.id
      const sceneId = await spaceScene(spaceId)
      if (!sceneId) return reply.status(404).send({ error: 'not_found' })
      const builder = await isBuilder(request, sceneId)

      return longPoll(
        request,
        reply,
        sceneId,
        request.query.since,
        holdMs,
        async () => {
          const snap = await arSpaceSnapshot(spaceId)
          // Re-checked on every read, so unpublishing ends a visitor's hold with a 404.
          if (!snap || (!snap.space.published && !builder)) return null
          const body: ArFeedResponse = { v: AR_FEED.version, version: snap.version, space: snap.space, scene: snap.scene }
          return { version: snap.version, body }
        },
        'not_found',
      )
    },
  )

  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    '/api/ar/scenes/:id/feed',
    // Shares the space feed's per-IP limit; keep polls out of per-request logs.
    { logLevel: 'warn', config: { rateLimit: false, scenePass: { sceneFrom: fromParam('id'), ar: 'personal' } } },
    async (request, reply) => {
      const limit = limiter.take(`ip:${request.ip}`, 1, AR_FEED_LIMIT.capacity, AR_FEED_LIMIT.refillPerSec)
      if (!limit.ok) return reply.status(429).send({ error: 'rate_limited', retryAfter: Math.ceil(limit.retryAfterMs / 1000) })
      if (!(await signInIfPresent(request, reply))) return
      const sceneId = request.params.id
      // Builders only: a visitor, or a signed-in caller who may not build, gets the same 404 as a missing scene.
      if (!(await isBuilder(request, sceneId))) return reply.status(404).send({ error: 'not_found' })

      return longPoll(
        request,
        reply,
        sceneId,
        request.query.since,
        holdMs,
        async () => {
          const snap = await sceneSnapshot(sceneId)
          if (!snap) return null
          const version = createHash('sha256').update(JSON.stringify({ scene: snap.scene })).digest('hex')
          const body: ArSceneFeedResponse = { v: AR_FEED.version, version, scene: snap.scene }
          return { version, body }
        },
        'not_found',
      )
    },
  )

  app.post<{ Params: { id: string } }>(
    '/api/ar/spaces/:id/analytics',
    // Public for a published space; its own per-IP limit.
    { logLevel: 'warn', config: { rateLimit: false } },
    async (request, reply) => {
      const limit = analyticsLimiter.take(`ip:${request.ip}`, 1, AR_ANALYTICS_LIMIT.capacity, AR_ANALYTICS_LIMIT.refillPerSec)
      if (!limit.ok) return reply.status(429).send({ error: 'rate_limited', retryAfter: Math.ceil(limit.retryAfterMs / 1000) })
      const space = await getSpace(request.params.id)
      if (!space || !space.published) return reply.status(404).send({ error: 'not_found' })
      const { platform, ...rest } = (request.body ?? {}) as Record<string, unknown>
      if (typeof platform !== 'string' || !AR_ANALYTICS_PLATFORMS.has(platform)) return reply.status(400).send({ error: 'bad_platform' })
      const checked = checkHyperfyAnalyticsBatch(rest, Date.now())
      if (!checked.ok) return reply.status(400).send({ error: checked.error })
      return reply.send(await recordArBatch(space, platform, checked.batch))
    },
  )

  app.post<{ Params: { id: string } }>(
    '/api/ar/spaces/:id/report',
    // Public for a published space; its own per-IP limit. The IP is only the limiter's key: it is not stored.
    { logLevel: 'warn', config: { rateLimit: false } },
    async (request, reply) => {
      const limit = reportLimiter.take(`ip:${request.ip}`, 1, AR_REPORT_LIMIT.capacity, AR_REPORT_LIMIT.refillPerSec)
      if (!limit.ok) return reply.status(429).send({ error: 'rate_limited', retryAfter: Math.ceil(limit.retryAfterMs / 1000) })
      const space = await getSpace(request.params.id)
      if (!space || !space.published) return reply.status(404).send({ error: 'not_found' })
      const { reason, platform } = (request.body ?? {}) as Record<string, unknown>
      if (typeof reason !== 'string' || !AR_REPORT_REASONS.has(reason)) return reply.status(400).send({ error: 'bad_reason' })
      if (typeof platform !== 'string' || !AR_ANALYTICS_PLATFORMS.has(platform)) return reply.status(400).send({ error: 'bad_platform' })
      await createArReport(space, reason, platform)
      return reply.status(201).send({ ok: true })
    },
  )
}
