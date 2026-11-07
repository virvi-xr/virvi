import type { FastifyInstance } from 'fastify'
import { and, count, desc, eq } from 'drizzle-orm'
import { layoutFootprint, validateLayout } from '@virvixr/shared'
import { config } from '../config.js'
import { db } from '../db/connection.js'
import { roomScans, users } from '../db/schema.js'
import { deviceForScanUpload, devicePersonal } from '../ar/devices.js'
import { recordTrialBlocked } from '../auth/trial-events.js'
import { authenticate } from '../middleware/auth.js'
import { boundScene, isUuid } from '../auth/scene-from.js'
import { plotForLayout } from '../room-scan/plot.js'

/**
 * Room scans: a personal headset uploads its scanned layout (layout JSON only, never images), with an AR pass or with
 * its headset secret; the owner lists, reads and deletes them from their account. Every route answers 404 to anyone
 * but the owner. A trial lists, reads and deletes its own, and its headset uploads with the secret (it gets no pass).
 */
export const SHARED_DEVICE_MESSAGE = 'Room scans need a personal headset. This one is shared.'

/** A scan's layout JSON is small; a bigger upload body is refused (413) before parsing. */
export const ROOM_SCAN_BODY_LIMIT = 1_048_576

type SavedScan = { id: string; name: string; createdAt: Date }

/**
 * Validates and stores a scan for `userId`. A trial holds at most TRIAL_ROOM_SCANS at once: the count and the insert
 * run in one transaction holding the user's row lock, so uploads at once with one slot left can't both pass.
 */
export async function saveRoomScan(userId: string, name: unknown, layout: unknown): Promise<{ status: 201; scan: SavedScan } | { status: 400 | 401 | 403; body: Record<string, unknown> }> {
  if (typeof name !== 'string' || name.length < 1 || name.length > 120) {
    return { status: 400, body: { error: 'invalid_name', message: 'Name must be 1 to 120 characters' } }
  }
  const checked = validateLayout(layout)
  if (!checked.ok) {
    if (checked.errors.some((e) => e.includes('empty_scan'))) return { status: 400, body: { error: 'empty_scan' } }
    return { status: 400, body: { error: 'invalid_layout', errors: checked.errors } }
  }
  const scan = await db.transaction(async (tx) => {
    const [owner] = await tx.select({ isTrial: users.isTrial }).from(users).where(eq(users.id, userId)).for('update')
    // The approver's row went (the trial sweep, an account deletion) after the headset was checked: nothing to save to
    if (!owner) return 'gone' as const
    if (owner.isTrial) {
      const [{ held }] = await tx.select({ held: count() }).from(roomScans).where(eq(roomScans.userId, userId))
      if (held >= config.trialRoomScans) return null
    }
    const [row] = await tx
      .insert(roomScans)
      .values({ userId, name, source: checked.layout.rooms[0].anchor.source, layout: checked.layout, plot: plotForLayout(checked.layout) })
      .returning({ id: roomScans.id, name: roomScans.name, createdAt: roomScans.createdAt })
    return row
  })
  if (scan === 'gone') return { status: 401, body: { error: 'device_revoked' } }
  if (!scan) {
    recordTrialBlocked(userId, 'more_scans')
    return { status: 403, body: { error: 'account_required', action: 'more_scans' } }
  }
  return { status: 201, scan }
}

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
      const saved = await saveRoomScan(request.user.id, name, layout)
      if (saved.status !== 201) return reply.status(saved.status).send(saved.body)
      return reply.status(201).send({ scan: saved.scan })
    },
  )

  // The headset secret is the auth (no bearer): a trial's headset mints no pass, so this is how it scans. The scan
  // always goes to the headset's approver; the body is capped before it is buffered.
  app.post<{ Params: { id: string }; Body: { secret?: unknown; name?: unknown; layout?: unknown } }>(
    '/api/ar/devices/:id/room-scans',
    { bodyLimit: ROOM_SCAN_BODY_LIMIT, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { secret, name, layout } = request.body ?? {}
      if (typeof secret !== 'string' || secret.length < 1 || secret.length > 256) return reply.status(400).send({ error: 'Missing field: secret' })
      const device = await deviceForScanUpload(request.params.id, secret)
      if (device === 'personal_only') return reply.status(403).send({ error: 'personal_only' })
      if (typeof device === 'string') return reply.status(401).send({ error: device })
      const saved = await saveRoomScan(device.userId, name, layout)
      if (saved.status !== 201) return reply.status(saved.status).send(saved.body)
      return reply.status(201).send({ scan: saved.scan })
    },
  )

  app.get('/api/room-scans', { preHandler: [authenticate], config: { trial: true } }, async (request) => {
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

  app.get<{ Params: { id: string } }>('/api/room-scans/:id', { preHandler: [authenticate], config: { trial: true } }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.status(404).send({ error: 'not_found' })
    const [scan] = await db.select().from(roomScans).where(and(eq(roomScans.id, request.params.id), eq(roomScans.userId, request.user.id)))
    if (!scan) return reply.status(404).send({ error: 'not_found' })
    return { scan }
  })

  app.delete<{ Params: { id: string } }>('/api/room-scans/:id', { preHandler: [authenticate], config: { trial: true } }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.status(404).send({ error: 'not_found' })
    const deleted = await db
      .delete(roomScans)
      .where(and(eq(roomScans.id, request.params.id), eq(roomScans.userId, request.user.id)))
      .returning({ id: roomScans.id })
    if (!deleted.length) return reply.status(404).send({ error: 'not_found' })
    return reply.status(204).send()
  })
}
