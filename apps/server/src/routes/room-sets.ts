import type { FastifyInstance, FastifyReply } from 'fastify'
import { authenticate } from '../middleware/auth.js'
import { isUuid } from '../auth/scene-from.js'
import { DEFAULT_ROOM_SET_OPTIONS, type RoomSetOptions } from '../room-scan/build-glb.js'
import { createRoomSetAsset, generateRoomSet, getRoomSet, loadOwnedScan, parseRoomSetOptions, RoomSetError, updateRoomSet } from '../room-scan/sets.js'

/**
 * Room sets: wizard previews of a scan, library assets made from a scan, and reading, restyling or nudging a set later.
 * Every route answers 404 to anyone but the owner.
 */
type PreviewQuery = { style?: string; wallColor?: string; floorColor?: string; ceiling?: string; furniture?: string }

const flag = (v: string | undefined, fallback: boolean) => (v === undefined ? fallback : v === 'true' || v === '1')

/** Preview options from the query string: missing fields take the defaults; null when a given one is invalid. */
function previewOptions(q: PreviewQuery): RoomSetOptions | null {
  const d = DEFAULT_ROOM_SET_OPTIONS
  return parseRoomSetOptions({
    style: q.style ?? d.style,
    wallColor: q.wallColor ?? d.wallColor,
    floorColor: q.floorColor ?? d.floorColor,
    ceiling: flag(q.ceiling, d.ceiling),
    furniture: flag(q.furniture, d.furniture),
  })
}

function refuse(reply: FastifyReply, err: unknown) {
  if (err instanceof RoomSetError) return reply.status(err.status).send({ error: err.code })
  throw err
}

export default async function roomSetRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: PreviewQuery }>(
    '/api/room-scans/:id/preview.glb',
    // A trial previews its own scans in the wizard (nothing is stored); making or placing a room set needs an account
    { preHandler: [authenticate], config: { trial: true } },
    async (request, reply) => {
      const scan = isUuid(request.params.id) ? await loadOwnedScan(request.user.id, request.params.id) : null
      if (!scan) return reply.status(404).send({ error: 'not_found' })
      const options = previewOptions(request.query ?? {})
      if (!options) return reply.status(400).send({ error: 'invalid_options' })
      try {
        const out = await generateRoomSet(scan.layout, options, [])
        return reply
          .header('content-type', 'model/gltf-binary')
          .header('cache-control', 'private, no-store')
          .header('x-triangles', String(out.triangles))
          .header('access-control-expose-headers', 'X-Triangles')
          .send(out.glb)
      } catch (err) {
        return refuse(reply, err)
      }
    },
  )

  app.post<{ Body: { scanId?: unknown; name?: unknown; options?: unknown } }>(
    '/api/room-sets/asset',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { scanId, name, options } = request.body ?? {}
      if (typeof name !== 'string' || name.trim().length < 1 || name.length > 120) {
        return reply.status(400).send({ error: 'invalid_name', message: 'Name must be 1 to 120 characters' })
      }
      if (!isUuid(scanId)) return reply.status(404).send({ error: 'not_found' })
      const parsed = parseRoomSetOptions(options)
      if (!parsed) return reply.status(400).send({ error: 'invalid_options' })
      try {
        const { asset, set } = await createRoomSetAsset(request.user.id, scanId, name.trim(), parsed)
        return reply.status(201).send({ asset, set })
      } catch (err) {
        return refuse(reply, err)
      }
    },
  )

  app.get<{ Params: { id: string } }>('/api/room-sets/:id', { preHandler: [authenticate] }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.status(404).send({ error: 'not_found' })
    try {
      return { set: await getRoomSet(request.user.id, request.params.id) }
    } catch (err) {
      return refuse(reply, err)
    }
  })

  app.put<{ Params: { id: string }; Body: { options?: unknown; nudges?: unknown; snap?: unknown } }>(
    '/api/room-sets/:id',
    { preHandler: [authenticate] },
    async (request, reply) => {
      if (!isUuid(request.params.id)) return reply.status(404).send({ error: 'not_found' })
      const { options, nudges, snap } = request.body ?? {}
      try {
        return { set: await updateRoomSet(request.user.id, request.params.id, { options, nudges, snap }) }
      } catch (err) {
        return refuse(reply, err)
      }
    },
  )
}
