import type { FastifyInstance } from 'fastify'
import { eq, and, inArray } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { events, eventSceneLinks, eventGiveawayLinks, giveaways, scenePresets } from '../db/schema.js'
import { dropEventSchedules, eventPresetSchedules, syncEventSchedules } from '../scenes/preset-schedules.js'
import { eventShowings, releaseEventShowings, syncEventShowings } from '../scenes/showings.js'
import { authenticate } from '../middleware/auth.js'
import { getSceneAccess, isFullAccess } from '../auth/permissions.js'
import { actorFromClaims } from '../auth/actor.js'
import { isUuid } from '../auth/scene-from.js'

interface CreateEventBody {
  name: string
  description?: string
  startTime?: string
  endTime?: string
  timezone?: string
}

interface UpdateEventBody {
  name?: string
  description?: string
  startTime?: string
  endTime?: string
  timezone?: string
}

export default async function eventRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // ── GET /api/events — list user's events ──────────────────────────────────

  app.get('/api/events', async (request, reply) => {
    const userEvents = await db.query.events.findMany({
      where: eq(events.ownerId, request.user.id),
      orderBy: (e, { desc }) => [desc(e.updatedAt)],
    })
    return reply.send({ events: userEvents })
  })

  // ── POST /api/events — create event ───────────────────────────────────────

  app.post<{ Body: CreateEventBody }>('/api/events', async (request, reply) => {
    const { name, description, startTime, endTime, timezone } = request.body

    if (!name) {
      return reply.status(400).send({ error: 'name is required' })
    }

    const [event] = await db
      .insert(events)
      .values({
        ownerId: request.user.id,
        name,
        description: description || null,
        startTime: startTime ? new Date(startTime) : null,
        endTime: endTime ? new Date(endTime) : null,
        timezone: timezone || 'UTC',
      })
      .returning()

    return reply.status(201).send({ event })
  })

  // ── GET /api/events/:eventId — get event with linked scenes & giveaways ──

  app.get<{ Params: { eventId: string } }>(
    '/api/events/:eventId',
    async (request, reply) => {
      const { eventId } = request.params

      const event = await db.query.events.findFirst({
        where: eq(events.id, eventId),
        with: {
          sceneLinks: {
            with: { scene: true },
          },
          giveawayLinks: {
            with: { giveaway: true },
          },
        },
      })

      if (!event) return reply.status(404).send({ error: 'Event not found' })
      if (event.ownerId !== request.user.id && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      // Scheduled presets that follow this event, and the presets of its scenes to pick from (LIV-86)
      const sceneIds = event.sceneLinks.map((l) => l.sceneId)
      const scenePresetRows = sceneIds.length
        ? await db.select({ id: scenePresets.id, sceneId: scenePresets.sceneId, name: scenePresets.name }).from(scenePresets).where(inArray(scenePresets.sceneId, sceneIds))
        : []
      return reply.send({ event, presetSchedules: await eventPresetSchedules(eventId), scenePresets: scenePresetRows, showings: await eventShowings(eventId) })
    },
  )

  // ── PUT /api/events/:eventId — update event ──────────────────────────────

  app.put<{ Params: { eventId: string }; Body: UpdateEventBody }>(
    '/api/events/:eventId',
    async (request, reply) => {
      const { eventId } = request.params
      const { name, description, startTime, endTime, timezone } = request.body

      const event = await db.query.events.findFirst({ where: eq(events.id, eventId) })
      if (!event) return reply.status(404).send({ error: 'Event not found' })
      if (event.ownerId !== request.user.id && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      const updates: Record<string, unknown> = { updatedAt: new Date() }
      if (name !== undefined) updates.name = name
      if (description !== undefined) updates.description = description
      if (startTime !== undefined) updates.startTime = startTime ? new Date(startTime) : null
      if (endTime !== undefined) updates.endTime = endTime ? new Date(endTime) : null
      if (timezone !== undefined) updates.timezone = timezone

      const [updated] = await db.update(events).set(updates).where(eq(events.id, eventId)).returning()
      if (startTime !== undefined || endTime !== undefined || timezone !== undefined) {
        await syncEventSchedules(eventId)
        await syncEventShowings(eventId)
      }
      return reply.send({ event: updated })
    },
  )

  // ── DELETE /api/events/:eventId ───────────────────────────────────────────

  app.delete<{ Params: { eventId: string } }>(
    '/api/events/:eventId',
    async (request, reply) => {
      const { eventId } = request.params

      const event = await db.query.events.findFirst({ where: eq(events.id, eventId) })
      if (!event) return reply.status(404).send({ error: 'Event not found' })
      if (event.ownerId !== request.user.id && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      await releaseEventShowings(eventId) // paused, not deleted: their programmes stay
      await db.delete(events).where(eq(events.id, eventId))
      return reply.status(204).send()
    },
  )

  // ── POST /api/events/:eventId/link-scene ──────────────────────────────────

  app.post<{ Params: { eventId: string }; Body: { sceneId: string } }>(
    '/api/events/:eventId/link-scene',
    async (request, reply) => {
      const { eventId } = request.params
      const { sceneId } = request.body

      if (!sceneId) {
        return reply.status(400).send({ error: 'sceneId is required' })
      }

      const event = await db.query.events.findFirst({ where: eq(events.id, eventId) })
      if (!event) return reply.status(404).send({ error: 'Event not found' })
      if (event.ownerId !== request.user.id && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      // Linking pulls the scene into the event's broadcasts, so the caller must run the scene themselves.
      if (!isUuid(sceneId)) return reply.status(400).send({ error: 'sceneId must be a UUID' })
      if (!isFullAccess(await getSceneAccess(actorFromClaims(request.user), sceneId))) {
        return reply.status(404).send({ error: 'Scene not found' })
      }

      const [link] = await db
        .insert(eventSceneLinks)
        .values({ eventId, sceneId })
        .onConflictDoNothing()
        .returning()

      return reply.status(201).send({ link: link || { eventId, sceneId } })
    },
  )

  // ── POST /api/events/:eventId/link-giveaway ──────────────────────────────

  app.post<{ Params: { eventId: string }; Body: { giveawayId: string } }>(
    '/api/events/:eventId/link-giveaway',
    async (request, reply) => {
      const { eventId } = request.params
      const { giveawayId } = request.body

      if (!giveawayId) {
        return reply.status(400).send({ error: 'giveawayId is required' })
      }

      const event = await db.query.events.findFirst({ where: eq(events.id, eventId) })
      if (!event) return reply.status(404).send({ error: 'Event not found' })
      if (event.ownerId !== request.user.id && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      if (!isUuid(giveawayId)) return reply.status(400).send({ error: 'giveawayId must be a UUID' })
      const giveaway = await db.query.giveaways.findFirst({ where: eq(giveaways.id, giveawayId), columns: { ownerId: true } })
      if (!giveaway || (giveaway.ownerId !== request.user.id && request.user.role !== 'admin')) {
        return reply.status(404).send({ error: 'Giveaway not found' })
      }

      const [link] = await db
        .insert(eventGiveawayLinks)
        .values({ eventId, giveawayId })
        .onConflictDoNothing()
        .returning()

      return reply.status(201).send({ link: link || { eventId, giveawayId } })
    },
  )

  // ── DELETE /api/events/:eventId/unlink-scene/:sceneId ─────────────────────

  app.delete<{ Params: { eventId: string; sceneId: string } }>(
    '/api/events/:eventId/unlink-scene/:sceneId',
    async (request, reply) => {
      const { eventId, sceneId } = request.params

      const event = await db.query.events.findFirst({ where: eq(events.id, eventId) })
      if (!event) return reply.status(404).send({ error: 'Event not found' })
      if (event.ownerId !== request.user.id && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      await db
        .delete(eventSceneLinks)
        .where(
          and(
            eq(eventSceneLinks.eventId, eventId),
            eq(eventSceneLinks.sceneId, sceneId),
          ),
        )
      if (isUuid(sceneId)) {
        await dropEventSchedules(eventId, sceneId)
        await releaseEventShowings(eventId, sceneId)
      }

      return reply.status(204).send()
    },
  )

  // ── DELETE /api/events/:eventId/unlink-giveaway/:giveawayId ───────────────

  app.delete<{ Params: { eventId: string; giveawayId: string } }>(
    '/api/events/:eventId/unlink-giveaway/:giveawayId',
    async (request, reply) => {
      const { eventId, giveawayId } = request.params

      const event = await db.query.events.findFirst({ where: eq(events.id, eventId) })
      if (!event) return reply.status(404).send({ error: 'Event not found' })
      if (event.ownerId !== request.user.id && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      await db
        .delete(eventGiveawayLinks)
        .where(
          and(
            eq(eventGiveawayLinks.eventId, eventId),
            eq(eventGiveawayLinks.giveawayId, giveawayId),
          ),
        )

      return reply.status(204).send()
    },
  )
}
