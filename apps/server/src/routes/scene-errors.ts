import type { FastifyInstance } from 'fastify'
import { eq, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { scenes } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess } from '../auth/permissions.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const WINDOW_DAYS = 7
const MAX_SIGNATURES = 20
const TITLE_MAX = 200

/** A scene's recent errors for the people who can see the scene: signatures only, never who hit them, request ids or stacks. */
export default async function sceneErrorRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get<{ Params: { sceneId: string } }>('/api/scenes/:sceneId/errors', async (request, reply) => {
    const { sceneId } = request.params
    if (!UUID.test(sceneId)) return reply.status(404).send({ error: 'Scene not found' })

    const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId), columns: { id: true } })
    if (!scene) return reply.status(404).send({ error: 'Scene not found' })

    // The scene route's own gate, minus venue crew: they see only their booking, not the owner's errors
    const access = await getSceneAccess(actorFromClaims(request.user), sceneId)
    if (access.level === 'none' || access.level === 'grant') return reply.status(403).send({ error: 'Forbidden' })

    const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString()
    const rows = (await db.execute(sql`
      SELECT s.id AS signature, COALESCE(s.message, s.signature) AS title,
             SUM(e.count)::int AS count, MAX(e.occurred_at) AS last_seen_at,
             (ARRAY_AGG(e.status ORDER BY e.occurred_at DESC))[1] AS status
      FROM error_events e
      JOIN error_signatures s ON s.id = e.signature_id
      WHERE e.scene_id = ${sceneId} AND e.occurred_at >= ${since}::timestamptz
      GROUP BY s.id, s.message, s.signature
      ORDER BY MAX(e.occurred_at) DESC
      LIMIT ${MAX_SIGNATURES}
    `)) as unknown as Array<{ signature: string; title: string; count: number; last_seen_at: string | Date; status: number | null }>

    return reply.send({
      errors: rows.map((r) => ({
        signature: r.signature,
        title: String(r.title).slice(0, TITLE_MAX),
        count: Number(r.count),
        lastSeenAt: new Date(r.last_seen_at).toISOString(),
        status: r.status ?? null,
      })),
    })
  })
}
