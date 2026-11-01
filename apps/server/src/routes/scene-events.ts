import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import type { SceneEventsResponse } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { events, eventSceneLinks } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess, hasScope } from '../auth/permissions.js'
import { fromParam } from '../auth/scene-from.js'

/** The events linked to a scene, for the headset's Events tab (and anyone who can edit the scene). */
export default async function sceneEventRoutes(app: FastifyInstance) {
  app.get<{ Params: { sceneId: string } }>(
    '/api/scenes/:sceneId/events',
    { preHandler: [authenticate], config: { scenePass: { sceneFrom: fromParam('sceneId'), ar: true as const } } },
    async (request, reply) => {
      const sceneId = await fromParam('sceneId')(request)
      if (!sceneId) return reply.status(404).send({ error: 'not_found' })
      const access = await getSceneAccess(actorFromClaims(request.user), sceneId)
      if (!hasScope(access, 'scene.edit')) return reply.status(404).send({ error: 'not_found' })

      const rows = await db
        .select({ id: events.id, name: events.name, startTime: events.startTime, endTime: events.endTime })
        .from(eventSceneLinks)
        .innerJoin(events, eq(events.id, eventSceneLinks.eventId))
        .where(eq(eventSceneLinks.sceneId, sceneId))

      const now = Date.now()
      const items = rows.map((r) => ({
        id: r.id,
        name: r.name,
        startTime: r.startTime ? r.startTime.toISOString() : null,
        endTime: r.endTime ? r.endTime.toISOString() : null,
        live: !!r.startTime && r.startTime.getTime() <= now && (!r.endTime || r.endTime.getTime() > now),
      }))
      // Live first, then upcoming by start, then the rest (past, then undated).
      const rank = (e: (typeof items)[number]) =>
        e.live ? 0 : e.startTime && new Date(e.startTime).getTime() > now ? 1 : e.startTime ? 2 : 3
      items.sort((a, b) => rank(a) - rank(b) || (a.startTime ?? '').localeCompare(b.startTime ?? '') || a.name.localeCompare(b.name))
      const body: SceneEventsResponse = { events: items }
      return reply.send(body)
    },
  )
}
