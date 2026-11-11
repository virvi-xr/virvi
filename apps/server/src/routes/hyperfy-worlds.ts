/**
 * Hyperfy worlds: connect your own, or have Virvi host one on Fly.
 *
 * POST   /api/hyperfy/worlds                — Connect a world (kind 'self', default; returns its key once) or host one
 *                                             (kind 'hosted'; 202 with the admin code once)
 * GET    /api/hyperfy/worlds?sceneId=       — List a scene's worlds
 * PATCH  /api/hyperfy/worlds/:id            — Rename a world (name only: its slug and address stay), change its end date (hosted) or switch its scene
 * POST   /api/hyperfy/worlds/:id/restore    — Bring an ended hosted world back (within retention, if a slot is free)
 * POST   /api/hyperfy/worlds/:id/admin-code — Reveal a hosted world's admin code
 * POST   /api/hyperfy/worlds/:id/rotate-key — Replace the key; returns the new one once
 * DELETE /api/hyperfy/worlds/:id            — Disconnect or destroy a world
 * GET    /api/hyperfy/slots                 — The caller's hosted-world slots
 *
 * Self-run worlds never consult hyperfyHosting() and don't count toward TIER_LIMITS.
 */

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { and, asc, eq, ne } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { hyperfyWorlds } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { requireFeature } from '../middleware/feature-gate.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess, isFullAccess } from '../auth/permissions.js'
import { createWorldKey, worldSummary, type HyperfyWorldRow } from '../hyperfy/worlds.js'
import {
  createHostedWorld,
  destroyHostedWorld,
  restoreHostedWorld,
  revealAdminCode,
  rotateHostedWorldKey,
  switchHostedWorldScene,
  HostingError,
} from '../hyperfy/hosting.js'
import { hostedWorldSlots } from '../hyperfy/slots.js'
import { hyperfyHosting } from '../services/hyperfy/infrastructure.js'

// Same depth from src/routes (dev, tests) and dist/routes (Docker): apps/server/<src|dist>/routes -> repo root.
const APP_HYP = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../packages/hyperfy-app/dist/virvi.hyp')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_NAME = 100

const hasFullAccess = async (request: FastifyRequest, sceneId: string) =>
  UUID.test(sceneId) && isFullAccess(await getSceneAccess(actorFromClaims(request.user), sceneId))

/** A world the caller has full access to the scene of; null otherwise (callers answer 404). */
async function worldForCaller(request: FastifyRequest, id: string): Promise<HyperfyWorldRow | null> {
  if (!UUID.test(id)) return null
  const [world] = await db.select().from(hyperfyWorlds).where(eq(hyperfyWorlds.id, id))
  if (!world || !(await hasFullAccess(request, world.sceneId))) return null
  return world
}

const HOSTING_STATUS: Record<string, number> = {
  world_limit_reached: 403,
  world_not_found: 404,
  world_not_running: 409,
  not_restorable: 409,
  world_update_failed: 502,
}

/** Answers a HostingError with its status and message; anything else is rethrown. */
function hostingFailure(reply: FastifyReply, err: unknown) {
  if (!(err instanceof HostingError)) throw err
  const body: Record<string, unknown> = { error: err.code, message: err.message }
  if (err.slots) Object.assign(body, slotsBody(err.slots))
  return reply.status(HOSTING_STATUS[err.code] ?? 500).send(body)
}

/** JSON has no Infinity: an unlimited plan reports `limit: null`. */
const slotsBody = ({ used, limit }: { used: number; limit: number }) => ({ used, limit: Number.isFinite(limit) ? limit : null })

const unavailable = (reply: FastifyReply) =>
  reply.status(503).send({ error: 'hyperfy_hosting_unavailable', message: 'Hosted Hyperfy worlds are not available on this server' })

/** An ISO date string (or null to clear). Returns undefined when it isn't one. */
function parseEndsAt(value: unknown): Date | null | undefined {
  if (value === null) return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

export default async function hyperfyWorldRoutes(app: FastifyInstance) {
  // Only connecting needs a plan that can deploy; an owner who downgrades can still list, rotate a leaked key or remove a world.
  const createPreHandler = [authenticate, requireFeature('deployment')]
  const preHandler = [authenticate]

  // Public: the built Virvi app, to drop into a Hyperfy world. Read per request so a rebuilt file is served without a restart.
  app.get('/api/hyperfy/app.hyp', async (request, reply) => {
    let file: Buffer
    try {
      file = await readFile(APP_HYP)
    } catch (err) {
      request.log.error({ err, path: APP_HYP }, 'hyperfy app.hyp is missing; run the @virvixr/hyperfy-app build')
      return reply.code(503).send({ error: 'app_unavailable' })
    }
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', 'attachment; filename="virvi.hyp"')
      .send(file)
  })

  app.post<{ Body: { sceneId?: string; name?: string; kind?: string; endsAt?: string | null } }>(
    '/api/hyperfy/worlds',
    { preHandler: createPreHandler },
    async (request, reply) => {
      const sceneId = String(request.body?.sceneId ?? '')
      const name = String(request.body?.name ?? '').trim()
      const kind = request.body?.kind ?? 'self'
      const endsAt = request.body?.endsAt === undefined ? null : parseEndsAt(request.body.endsAt)
      if (!name || name.length > MAX_NAME) return reply.status(400).send({ error: 'name is required (up to 100 characters)' })
      if (kind !== 'self' && kind !== 'hosted') return reply.status(400).send({ error: "kind must be 'self' or 'hosted'" })
      if (!(await hasFullAccess(request, sceneId))) return reply.status(404).send({ error: 'Scene not found' })

      if (kind === 'hosted') {
        if (!hyperfyHosting().available) return unavailable(reply)
        if (endsAt === undefined || (endsAt && endsAt.getTime() <= Date.now())) {
          return reply.status(400).send({ error: 'endsAt must be a future ISO date, or null' })
        }
        try {
          const { world, adminCode } = await createHostedWorld({ ownerId: request.user.id, sceneId, name, endsAt })
          return reply.status(202).send({ world, adminCode })
        } catch (err) {
          return hostingFailure(reply, err)
        }
      }

      if (request.body?.endsAt != null) return reply.status(400).send({ error: 'not_hosted', message: 'Only hosted worlds have an end date' })
      const key = createWorldKey()
      const [world] = await db
        .insert(hyperfyWorlds)
        .values({ sceneId, ownerId: request.user.id, name, keyHash: key.hash, keyPrefix: key.prefix })
        .returning()
      return reply.status(201).send({ world: worldSummary(world), key: key.raw })
    },
  )

  // Read-only, so the wizard's Where step can show it to a trial
  app.get('/api/hyperfy/slots', { preHandler, config: { trial: true } }, async (request) => ({
    ...slotsBody(await hostedWorldSlots(request.user.id)),
    hostingAvailable: hyperfyHosting().available,
  }))

  app.patch<{ Params: { id: string }; Body: { name?: unknown; endsAt?: string | null; sceneId?: string } }>(
    '/api/hyperfy/worlds/:id',
    { preHandler },
    async (request, reply) => {
      const found = await worldForCaller(request, request.params.id)
      if (!found) return reply.status(404).send({ error: 'World not found' })
      const body = request.body ?? {}
      if (body.name === undefined && body.endsAt === undefined && body.sceneId === undefined) {
        return reply.status(400).send({ error: 'name, endsAt or sceneId is required' })
      }

      let name: string | undefined
      if (body.name !== undefined) {
        name = typeof body.name === 'string' ? body.name.trim() : ''
        if (!name || name.length > MAX_NAME) {
          return reply.status(400).send({ error: 'bad_name', message: `A Hyperfy world name is required (up to ${MAX_NAME} characters)` })
        }
      }

      let endsAt: Date | null | undefined
      if (body.endsAt !== undefined) {
        if (found.kind !== 'hosted') return reply.status(400).send({ error: 'not_hosted', message: 'Only hosted worlds have an end date' })
        if (found.status === 'ended' || (found.endsAt && found.endsAt.getTime() <= Date.now())) {
          return reply.status(409).send({ error: 'already_ended', message: 'This world has ended; restore it instead' })
        }
        endsAt = parseEndsAt(body.endsAt)
        if (endsAt === undefined || (endsAt && endsAt.getTime() <= Date.now())) {
          return reply.status(400).send({ error: 'endsAt must be a future ISO date, or null' })
        }
      }
      if (body.sceneId !== undefined && !(await hasFullAccess(request, String(body.sceneId)))) {
        return reply.status(404).send({ error: 'Scene not found' })
      }

      if (body.sceneId !== undefined && body.sceneId !== found.sceneId) {
        if (found.kind === 'hosted') await switchHostedWorldScene(found.id, body.sceneId)
        else await db.update(hyperfyWorlds).set({ sceneId: body.sceneId }).where(eq(hyperfyWorlds.id, found.id))
      }
      if (endsAt !== undefined) {
        // Not an ended world: the sweep may have ended it since the check above.
        const updated = await db
          .update(hyperfyWorlds)
          .set({ endsAt })
          .where(and(eq(hyperfyWorlds.id, found.id), ne(hyperfyWorlds.status, 'ended')))
          .returning({ id: hyperfyWorlds.id })
        if (!updated.length) return reply.status(409).send({ error: 'already_ended', message: 'This world has ended; restore it instead' })
      }
      // The display name only: a hosted world's slug, address and Fly app were fixed when it was made.
      if (name !== undefined && name !== found.name) await db.update(hyperfyWorlds).set({ name }).where(eq(hyperfyWorlds.id, found.id))
      const [world] = await db.select().from(hyperfyWorlds).where(eq(hyperfyWorlds.id, found.id))
      return { world: worldSummary(world) }
    },
  )

  app.post<{ Params: { id: string } }>('/api/hyperfy/worlds/:id/restore', { preHandler }, async (request, reply) => {
    const found = await worldForCaller(request, request.params.id)
    if (!found) return reply.status(404).send({ error: 'World not found' })
    if (found.kind !== 'hosted') return reply.status(409).send({ error: 'not_restorable', message: "This world can't be restored" })
    if (!hyperfyHosting().available) return unavailable(reply)
    try {
      return { world: worldSummary(await restoreHostedWorld(found.id)) }
    } catch (err) {
      return hostingFailure(reply, err)
    }
  })

  app.post<{ Params: { id: string } }>('/api/hyperfy/worlds/:id/admin-code', { preHandler }, async (request, reply) => {
    const found = await worldForCaller(request, request.params.id)
    if (!found) return reply.status(404).send({ error: 'World not found' })
    try {
      return { adminCode: await revealAdminCode(found.id) }
    } catch (err) {
      return hostingFailure(reply, err)
    }
  })

  app.get<{ Querystring: { sceneId?: string } }>('/api/hyperfy/worlds', { preHandler }, async (request, reply) => {
    const sceneId = request.query.sceneId
    if (!sceneId) return reply.status(400).send({ error: 'sceneId is required' })
    if (!(await hasFullAccess(request, sceneId))) return reply.status(404).send({ error: 'Scene not found' })
    const rows = await db.select().from(hyperfyWorlds).where(eq(hyperfyWorlds.sceneId, sceneId)).orderBy(asc(hyperfyWorlds.createdAt))
    return { worlds: rows.map(worldSummary) }
  })

  app.post<{ Params: { id: string } }>('/api/hyperfy/worlds/:id/rotate-key', { preHandler }, async (request, reply) => {
    const found = await worldForCaller(request, request.params.id)
    if (!found) return reply.status(404).send({ error: 'World not found' })
    if (found.kind === 'hosted') {
      try {
        const { key } = await rotateHostedWorldKey(found.id)
        const [world] = await db.select().from(hyperfyWorlds).where(eq(hyperfyWorlds.id, found.id))
        return { world: worldSummary(world), key }
      } catch (err) {
        return hostingFailure(reply, err)
      }
    }
    const key = createWorldKey()
    const [world] = await db
      .update(hyperfyWorlds)
      .set({ keyHash: key.hash, keyPrefix: key.prefix })
      .where(eq(hyperfyWorlds.id, found.id))
      .returning()
    return { world: worldSummary(world), key: key.raw }
  })

  app.delete<{ Params: { id: string } }>('/api/hyperfy/worlds/:id', { preHandler }, async (request, reply) => {
    const found = await worldForCaller(request, request.params.id)
    if (!found) return reply.status(404).send({ error: 'World not found' })
    if (found.kind === 'hosted') {
      try {
        await destroyHostedWorld(found.id)
      } catch (err) {
        return hostingFailure(reply, err)
      }
    } else {
      await db.delete(hyperfyWorlds).where(eq(hyperfyWorlds.id, found.id))
    }
    return { deleted: true }
  })
}
