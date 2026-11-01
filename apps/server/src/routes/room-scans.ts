import type { FastifyInstance } from 'fastify'
import { and, desc, eq } from 'drizzle-orm'
import { layoutFootprint, validateLayout } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { roomScans } from '../db/schema.js'
import { devicePersonal } from '../ar/devices.js'
import { authenticate } from '../middleware/auth.js'
import { boundScene, isUuid } from '../auth/scene-from.js'
import { plotForLayout } from '../room-scan/plot.js'

/**
 * Room scans: a personal headset uploads its scanned layout (layout JSON only, never images); the owner lists, reads
 * and deletes them from their account. Every route answers 404 to anyone but the owner.
 */
export const SHARED_DEVICE_MESSAGE = 'Room scans need a personal headset. This one is shared.'

/** A scan's layout JSON is small; a bigger upload body is refused (413) before parsing. */
export const ROOM_SCAN_BODY_LIMIT = 1_048_576

export default async function roomScanRoutes(app: FastifyInstance) {
  // The headset's pass is bound to its space's scene, so the resolver accepts the pass's own scene.
  app.post<{ Body: { name?: unknown; layout?: unknown } }>(
    '/api/ar/room-scans',
    { bodyLimit: ROOM_SCAN_BODY_LIMIT, preHandler: [authenticate], config: { scenePass: { ar: true, sceneFrom: boundScene } } },
    async (request, reply) => {
      const { name, layout } = request.body ?? {}
      if (typeof name !== 'string' || name.length < 1 || name.length > 120) {
        return reply.status(400).send({ error: 'invalid_name', message: 'Name must be 1 to 120 characters' })
      }
      if (!(await devicePersonal(request.user.deviceId))) {
        return reply.status(403).send({ error: 'shared_device', message: SHARED_DEVICE_MESSAGE })
      }
      const checked = validateLayout(layout)
      if (!checked.ok) {
        if (checked.errors.some((e) => e.includes('empty_scan'))) return reply.status(400).send({ error: 'empty_scan' })
        return reply.status(400).send({ error: 'invalid_layout', errors: checked.errors })
      }
      const [scan] = await db
        .insert(roomScans)
        .values({ userId: request.user.id, name, source: checked.layout.rooms[0].anchor.source, layout: checked.layout, plot: plotForLayout(checked.layout) })
        .returning({ id: roomScans.id, name: roomScans.name, createdAt: roomScans.createdAt })
      return reply.status(201).send({ scan })
    },
  )

  app.get('/api/room-scans', { preHandler: [authenticate] }, async (request) => {
    const rows = await db.select().from(roomScans).where(eq(roomScans.userId, request.user.id)).orderBy(desc(roomScans.createdAt), desc(roomScans.id))
    return {
      scans: rows.map((s) => ({
        id: s.id,
        name: s.name,
        source: s.source,
        roomCount: s.layout.rooms.length,
        footprint: layoutFootprint(s.layout),
        plot: s.plot ?? plotForLayout(s.layout),
        createdAt: s.createdAt,
      })),
    }
  })

  app.get<{ Params: { id: string } }>('/api/room-scans/:id', { preHandler: [authenticate] }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.status(404).send({ error: 'not_found' })
    const [scan] = await db.select().from(roomScans).where(and(eq(roomScans.id, request.params.id), eq(roomScans.userId, request.user.id)))
    if (!scan) return reply.status(404).send({ error: 'not_found' })
    return { scan }
  })

  app.delete<{ Params: { id: string } }>('/api/room-scans/:id', { preHandler: [authenticate] }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.status(404).send({ error: 'not_found' })
    const deleted = await db
      .delete(roomScans)
      .where(and(eq(roomScans.id, request.params.id), eq(roomScans.userId, request.user.id)))
      .returning({ id: roomScans.id })
    if (!deleted.length) return reply.status(404).send({ error: 'not_found' })
    return reply.status(204).send()
  })
}
