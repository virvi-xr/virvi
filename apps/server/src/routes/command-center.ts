/**
 * Command Center Routes — Multi-world status and cross-world actions.
 *
 * GET   /api/command-center/:eventId/status   — Get current status for all worlds in event
 * POST  /api/command-center/:eventId/broadcast — Send an action to all worlds in event
 */

import { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { liveScene } from '../scenes/live.js'
import { db } from '../db/connection.js'
import {
  events,
  eventSceneLinks,
  scenes,
  sceneDeployments,
} from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { dispatchPlatformCallbacks } from '../integrations/platform-hooks.js'
import { getSceneAccess, isFullAccess } from '../auth/permissions.js'
import { actorFromClaims, type Actor } from '../auth/actor.js'

/** The scenes of `sceneIds` the actor fully controls; an event's links alone never grant a fan-out. */
export async function accessibleSceneIds(actor: Actor, sceneIds: string[]): Promise<string[]> {
  const checks = await Promise.all(sceneIds.map(async (id) => isFullAccess(await getSceneAccess(actor, id))))
  return sceneIds.filter((_, i) => checks[i])
}

export default async function commandCenterRoutes(app: FastifyInstance) {
  // ── Event Status ──────────────────────────────────────────────────────
  app.get(
    '/api/command-center/:eventId/status',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { eventId } = request.params as { eventId: string }

      const event = await db.query.events.findFirst({
        where: eq(events.id, eventId),
      })

      if (!event) {
        return reply.status(404).send({ error: 'Event not found' })
      }
      if (event.ownerId !== request.user.id && request.user.role !== 'admin') {
        return reply.status(404).send({ error: 'Event not found' })
      }

      // Get all scenes linked to event with latest deployment
      const links = await db
        .select({
          sceneId: scenes.id,
          sceneName: scenes.name,
          sceneThumbnailUrl: scenes.thumbnailUrl,
          activePreset: scenes.activePresetId,
        })
        .from(eventSceneLinks)
        .innerJoin(scenes, eq(eventSceneLinks.sceneId, scenes.id))
        .where(and(eq(eventSceneLinks.eventId, eventId), liveScene()))

      const worlds = await Promise.all(
        links.map(async (link) => {
          const deployment = await db.query.sceneDeployments.findFirst({
            where: eq(sceneDeployments.sceneId, link.sceneId),
            orderBy: (d, { desc }) => [desc(d.createdAt)],
          })

          return {
            sceneId: link.sceneId,
            sceneName: link.sceneName,
            sceneThumbnailUrl: link.sceneThumbnailUrl,
            platform: deployment?.platform || null,
            deploymentStatus: deployment?.status || null,
            deploymentType: deployment?.deploymentType || null,
            activePreset: link.activePreset,
          }
        }),
      )

      return reply.send({
        event: {
          id: event.id,
          name: event.name,
          startTime: event.startTime,
          endTime: event.endTime,
        },
        worlds,
        aggregate: {
          worldCount: worlds.length,
          deployedCount: worlds.filter((w) => w.deploymentStatus === 'deployed').length,
        },
      })
    },
  )

  // ── Cross-World Broadcast ─────────────────────────────────────────────
  app.post(
    '/api/command-center/:eventId/broadcast',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { eventId } = request.params as { eventId: string }
      const body = request.body as {
        action: Record<string, unknown>
        targetScenes?: string[] | 'all'
      }

      if (!body.action) {
        return reply.status(400).send({ error: 'Missing required field: action' })
      }

      const event = await db.query.events.findFirst({
        where: eq(events.id, eventId),
      })

      if (!event) {
        return reply.status(404).send({ error: 'Event not found' })
      }

      // Verify user owns the event
      if (event.ownerId !== request.user.id && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      // Get all scenes linked to event
      const links = await db
        .select({ sceneId: eventSceneLinks.sceneId })
        .from(eventSceneLinks)
        .where(and(eq(eventSceneLinks.eventId, eventId), liveScene()))

      let sceneIds = await accessibleSceneIds(actorFromClaims(request.user), links.map((l) => l.sceneId))

      // Filter to specific scenes if requested
      if (body.targetScenes && body.targetScenes !== 'all') {
        sceneIds = sceneIds.filter((id) => (body.targetScenes as string[]).includes(id))
      }

      // Fan out to all targeted scenes via HTTP callbacks
      const dispatched = await Promise.allSettled(
        sceneIds.map((sceneId) =>
          dispatchPlatformCallbacks(sceneId, {
            action: 'cross_world_update',
            eventId,
            ...body.action,
          }),
        ),
      )

      return reply.send({
        dispatched: sceneIds.length,
        sceneIds,
      })
    },
  )
}
