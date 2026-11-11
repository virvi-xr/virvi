/**
 * Streaming Routes — Provision and manage HLS streaming servers.
 *
 * POST   /api/streaming/provision    — Provision a new streaming server
 * GET    /api/streaming              — List user's streaming servers
 * GET    /api/streaming/:id          — Get streaming server details
 * DELETE /api/streaming/:id          — Terminate a streaming server
 * GET    /api/streaming/:id/sessions — List sessions for a server
 * POST   /api/streaming/webhook      — Status callback from media server (internal)
 */

import { FastifyInstance } from 'fastify'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { eq, desc } from 'drizzle-orm'
import { db } from '../db/connection.js'
import {
  streamingServers,
  streamingSessions,
} from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { requireFeature } from '../middleware/feature-gate.js'
import { config } from '../config.js'
import { publishStreamStatus } from '../realtime/bus.js'
import { touchScenesPlayingStream } from '../streaming/live-status.js'
import { getSceneAccess, hasScope } from '../auth/permissions.js'
import { actorFromClaims } from '../auth/actor.js'
import { isUuid } from '../auth/scene-from.js'

const hlsBaseUrl = () => process.env.HLS_BASE_URL || 'http://localhost:8000/streams'
/** Public playback URL for a playback id (the stream key never appears in it: it is shown to every visitor). */
const playlistUrlFor = (playbackId: string) => `${hlsBaseUrl()}/${playbackId}/playlist.m3u8`

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * Media server → API auth (`X-Webhook-Key` = STREAMING_WEBHOOK_KEY). With no key configured the
 * endpoints are open only in single mode (one machine, local dev) and refuse in scalable and cloud mode, which
 * run behind public addresses.
 */
export function mediaServerAuth(headers: Record<string, unknown>): { ok: true } | { ok: false; status: 401 | 503; error: string } {
  const key = process.env.STREAMING_WEBHOOK_KEY
  if (!key) return config.mode !== 'single' ? { ok: false, status: 503, error: 'webhook_not_configured' } : { ok: true }
  const provided = headers['x-webhook-key']
  if (typeof provided !== 'string' || !safeEqual(provided, key)) return { ok: false, status: 401, error: 'Invalid webhook key' }
  return { ok: true }
}

export default async function streamingRoutes(app: FastifyInstance) {
  // ── Provision ─────────────────────────────────────────────────────────
  app.post(
    '/api/streaming/provision',
    { preHandler: [authenticate, requireFeature('streaming')] },
    async (request, reply) => {
      if (!config.streamingEnabled) {
        return reply.status(403).send({ error: 'Streaming is not enabled on this instance' })
      }

      const body = request.body as {
        name: string
        region?: string
        sceneId?: string
      }

      if (!body.name) {
        return reply.status(400).send({ error: 'Missing required field: name' })
      }

      if (body.sceneId != null) {
        const allowed = isUuid(body.sceneId) && hasScope(await getSceneAccess(actorFromClaims(request.user), body.sceneId), 'scene.edit')
        if (!allowed) return reply.status(404).send({ error: 'Scene not found' })
      }

      const streamKey = randomBytes(16).toString('hex')
      const playbackId = randomBytes(16).toString('hex')
      const ingestUrl = process.env.RTMP_INGEST_URL || 'rtmp://localhost:1935/live'

      const [server] = await db
        .insert(streamingServers)
        .values({
          ownerId: request.user.id,
          name: body.name,
          type: 'shared',
          status: 'ready',
          rtmpUrl: `${ingestUrl}/${streamKey}`,
          streamKey,
          playbackId,
          hlsPlaylistUrl: playlistUrlFor(playbackId),
          region: body.region || 'us-east-1',
          sceneId: body.sceneId || null,
        })
        .returning()

      return reply.status(201).send({
        server,
        instructions: {
          rtmpUrl: server.rtmpUrl,
          streamKey,
          hlsPlaylistUrl: server.hlsPlaylistUrl,
          howTo: 'In OBS/Streamlabs: set Server to the rtmpUrl (without stream key), set Stream Key to the streamKey value.',
        },
      })
    },
  )

  // ── List User's Servers ───────────────────────────────────────────────
  app.get(
    '/api/streaming',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const servers = await db
        .select()
        .from(streamingServers)
        .where(eq(streamingServers.ownerId, request.user.id))
        .orderBy(desc(streamingServers.createdAt))

      return reply.send({ servers })
    },
  )

  // ── Get Server Details ────────────────────────────────────────────────
  app.get(
    '/api/streaming/:id',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const server = await db.query.streamingServers.findFirst({
        where: eq(streamingServers.id, id),
      })

      if (!server || (server.ownerId !== request.user.id && request.user.role !== 'admin')) {
        return reply.status(404).send({ error: 'Streaming server not found' })
      }

      return reply.send({ server })
    },
  )

  // ── Terminate Server ──────────────────────────────────────────────────
  app.delete(
    '/api/streaming/:id',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const server = await db.query.streamingServers.findFirst({
        where: eq(streamingServers.id, id),
      })

      if (!server) {
        return reply.status(404).send({ error: 'Streaming server not found' })
      }

      if (server.ownerId !== request.user.id && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      // For dedicated servers with provisioned infrastructure, log a warning.
      // The actual destroy call depends on the provider (Fly.io API, Docker API,
      // ECS, etc.) which requires provider-specific implementation.
      if (server.type === 'dedicated' && server.infrastructureId) {
        request.log.warn(
          { infrastructureId: server.infrastructureId },
          'Infrastructure destroy not implemented for provider — manual cleanup may be needed',
        )
      }

      await db
        .update(streamingServers)
        .set({ status: 'terminated' })
        .where(eq(streamingServers.id, id))

      await db
        .delete(streamingServers)
        .where(eq(streamingServers.id, id))

      return reply.status(204).send()
    },
  )

  // ── List Sessions ─────────────────────────────────────────────────────
  app.get(
    '/api/streaming/:id/sessions',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const server = await db.query.streamingServers.findFirst({ where: eq(streamingServers.id, id) })
      if (!server || (server.ownerId !== request.user.id && request.user.role !== 'admin')) {
        return reply.status(404).send({ error: 'Streaming server not found' })
      }

      const sessions = await db
        .select()
        .from(streamingSessions)
        .where(eq(streamingSessions.serverId, id))
        .orderBy(desc(streamingSessions.startedAt))
        .limit(50)

      return reply.send({ sessions })
    },
  )

  // ── Authorize a publish (from media server) ───────────────────────────
  app.post('/api/streaming/authorize', async (request, reply) => {
    const auth = mediaServerAuth(request.headers as Record<string, unknown>)
    if (!auth.ok) return reply.status(auth.status).send({ error: auth.error })
    const streamKey = (request.body as { streamKey?: unknown } | undefined)?.streamKey
    if (typeof streamKey !== 'string' || !streamKey) return reply.status(400).send({ error: 'streamKey is required' })
    const [row] = await db
      .select({ id: streamingServers.id, playbackId: streamingServers.playbackId })
      .from(streamingServers)
      .where(eq(streamingServers.streamKey, streamKey))
      .limit(1)
    if (!row) return reply.status(403).send({ error: 'unknown_key' })
    if (!row.playbackId) return reply.status(403).send({ error: 'unknown_key' })
    // The media server writes HLS under the playback id
    return reply.send({ ok: true, playbackId: row.playbackId })
  })

  // ── Keys the API thinks are live (media server startup sweep) ─────────
  app.get('/api/streaming/live-keys', async (request, reply) => {
    const auth = mediaServerAuth(request.headers as Record<string, unknown>)
    if (!auth.ok) return reply.status(auth.status).send({ error: auth.error })
    const rows = await db
      .select({ streamKey: streamingServers.streamKey })
      .from(streamingServers)
      .where(eq(streamingServers.status, 'live'))
    return reply.send({ streamKeys: rows.flatMap((r) => (r.streamKey ? [r.streamKey] : [])) })
  })

  // ── Webhook (from media server) ───────────────────────────────────────
  // Not authenticated via JWT — uses shared webhook key instead
  app.post('/api/streaming/webhook', async (request, reply) => {
    const auth = mediaServerAuth(request.headers as Record<string, unknown>)
    if (!auth.ok) return reply.status(auth.status).send({ error: auth.error })

    const body = request.body as {
      streamKey: string
      status: 'live' | 'offline'
      timestamp?: number
    }

    if (!body.streamKey || !body.status) {
      return reply.status(400).send({ error: 'Missing streamKey or status' })
    }

    // Find the streaming server by stream key
    const [server] = await db
      .select()
      .from(streamingServers)
      .where(eq(streamingServers.streamKey, body.streamKey))
      .limit(1)

    if (!server) {
      return reply.status(404).send({ error: 'Unknown stream key' })
    }

    if (body.status === 'live') {
      // Update server status
      await db
        .update(streamingServers)
        // The provisioned playback URL is the truth; the media server's reported URL is ignored
        .set({ status: 'live' })
        .where(eq(streamingServers.id, server.id))

      // Create a new session record
      await db.insert(streamingSessions).values({
        serverId: server.id,
      })

      // If linked to a scene, broadcast video status to the Colyseus room
      // This triggers the scene's video elements to show the live stream
      if (server.sceneId) {
        const { dispatchPlatformCallbacks } = await import('../integrations/platform-hooks.js')
        dispatchPlatformCallbacks(server.sceneId, {
          action: 'video_status',
          isLive: true,
          url: server.hlsPlaylistUrl,
        }).catch(() => {})
      }
      if (server.hlsPlaylistUrl) await publishStreamStatus({ playlistUrl: server.hlsPlaylistUrl, live: true })
      if (server.hlsPlaylistUrl) await touchScenesPlayingStream(server.hlsPlaylistUrl)
    } else {
      // Stream went offline
      await db
        .update(streamingServers)
        .set({ status: 'offline' })
        .where(eq(streamingServers.id, server.id))

      // End the current session
      const [session] = await db
        .select()
        .from(streamingSessions)
        .where(eq(streamingSessions.serverId, server.id))
        .orderBy(desc(streamingSessions.startedAt))
        .limit(1)

      if (session && !session.endedAt) {
        const duration = Math.floor(
          (Date.now() - session.startedAt.getTime()) / 1000,
        )
        await db
          .update(streamingSessions)
          .set({ endedAt: new Date(), durationSeconds: duration })
          .where(eq(streamingSessions.id, session.id))
      }

      // Notify scene that stream is offline
      if (server.sceneId) {
        const { dispatchPlatformCallbacks } = await import('../integrations/platform-hooks.js')
        dispatchPlatformCallbacks(server.sceneId, {
          action: 'video_status',
          isLive: false,
        }).catch(() => {})
      }
      if (server.hlsPlaylistUrl) await publishStreamStatus({ playlistUrl: server.hlsPlaylistUrl, live: false })
      if (server.hlsPlaylistUrl) await touchScenesPlayingStream(server.hlsPlaylistUrl)
    }

    return reply.send({ ok: true })
  })
}
