/**
 * Deleting a scene (LIV-83): soft delete with a 30-day restore, and what the delete shuts down or removes.
 *
 * GET    /api/scenes/deleted                                   — the caller's Recently deleted list, with purge dates and removals
 * GET    /api/scenes/:sceneId/delete-plan                      — the delete dialog: what's running, upcoming events
 * DELETE /api/scenes/:sceneId                                  — soft delete; body { remove?: string[] } (ids from the plan)
 * POST   /api/scenes/:sceneId/restore                          — bring it back within the 30 days
 * POST   /api/scenes/:sceneId/purge                            — "Delete forever now"; body { name } must match the scene's
 * POST   /api/scenes/:sceneId/removals/:removalId/retry        — run a failed (or unsigned) removal again
 * GET    /api/scenes/:sceneId/removals/:removalId/sign         — what the owner's wallet signs for a removal
 * POST   /api/scenes/:sceneId/removals/:removalId/signature    — that signature; Virvi sends it and finishes the removal
 *
 * Every route here is for the people mayManageDeletion allows (owner, org owner/admin, platform admin; a trial for its own
 * scene); anyone else gets 404 for a deleted scene (never a hint it exists) and 403 for a live one. Trials may delete,
 * restore and purge their own scenes as they could delete before; the removal routes need an account (a trial has
 * nothing deployed).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { and, arrayContains, asc, eq, gt, inArray, isNotNull, or } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { bookings, eventSceneLinks, events, orgMembers, organizations, sceneRemovals, scenes, venues } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { isUuid } from '../auth/scene-from.js'
import { HostingError } from '../hyperfy/hosting.js'
import {
  hardDeleteScene, mayManageDeletion, purgeAtOf, restoreScene, sceneForDeletion, softDeleteScene,
} from '../scenes/deleted.js'
import {
  publicRemoval, removalOptions, removalsOf, RemovalError, runRemoval, signRequestFor, startRemovals, submitRemovalSignature, type Removal,
} from '../scenes/removals.js'
import { sceneLimitError } from './scenes.js'

const NOT_FOUND = { error: 'Scene not found' }

/** Upcoming events and bookings the dialog warns about: they're suspended while the scene is deleted. */
async function upcomingEvents(sceneId: string, now = new Date()) {
  const linked = await db
    .select({ id: events.id, name: events.name, startsAt: events.startTime, endsAt: events.endTime })
    .from(eventSceneLinks)
    .innerJoin(events, eq(events.id, eventSceneLinks.eventId))
    .where(and(eq(eventSceneLinks.sceneId, sceneId), or(gt(events.startTime, now), gt(events.endTime, now))))
    .orderBy(asc(events.startTime))
  const booked = await db
    .select({ id: bookings.id, name: bookings.title, startsAt: bookings.startsAt, endsAt: bookings.endsAt })
    .from(bookings)
    .innerJoin(venues, eq(venues.id, bookings.venueId))
    .where(and(eq(venues.sceneId, sceneId), gt(bookings.endsAt, now), inArray(bookings.status, ['pending', 'confirmed', 'live'])))
    .orderBy(asc(bookings.startsAt))
  return [...linked.map((e) => ({ ...e, kind: 'event' as const })), ...booked.map((b) => ({ ...b, kind: 'booking' as const }))]
}

export default async function sceneDeleteRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  /**
   * The scene and whether the caller may manage its deletion; replies itself (404/403) and returns null otherwise.
   * `deleted`: the state the route needs (a live scene to delete, a deleted one to restore or purge).
   */
  async function managed(request: FastifyRequest<{ Params: { sceneId: string } }>, reply: FastifyReply, deleted: boolean) {
    const { sceneId } = request.params
    const scene = isUuid(sceneId) ? await sceneForDeletion(sceneId) : null
    if (!scene) {
      reply.status(404).send(NOT_FOUND)
      return null
    }
    const allowed = await mayManageDeletion(actorFromClaims(request.user), scene)
    // A deleted scene is 404 to anyone else, and to the delete routes for live scenes (it's already gone from them)
    if (scene.deletedAt && (!allowed || !deleted)) {
      reply.status(404).send(NOT_FOUND)
      return null
    }
    if (!allowed) {
      reply.status(403).send({ error: 'Forbidden' })
      return null
    }
    if (!scene.deletedAt && deleted) {
      reply.status(409).send({ error: 'not_deleted', message: 'This scene is not deleted.' })
      return null
    }
    return scene
  }

  const removalReply = (reply: FastifyReply, err: unknown) => {
    if (err instanceof RemovalError) return reply.status(err.status).send({ error: err.code, message: err.message })
    throw err
  }

  async function removalOf(request: FastifyRequest<{ Params: { sceneId: string; removalId: string } }>, reply: FastifyReply): Promise<Removal | null> {
    if (!(await managed(request, reply, true))) return null
    const { sceneId, removalId } = request.params
    const r = isUuid(removalId)
      ? await db.query.sceneRemovals.findFirst({ where: and(eq(sceneRemovals.id, removalId), eq(sceneRemovals.sceneId, sceneId)) })
      : undefined
    if (!r) {
      reply.status(404).send({ error: 'not_found' })
      return null
    }
    return r
  }

  app.get('/api/scenes/deleted', { config: { trial: true } }, async (request, reply) => {
    const actor = actorFromClaims(request.user)
    if (!actor.userId) return reply.send({ scenes: [] })
    const me = actor.userId
    const adminOf = actor.trial || !actor.verified
      ? []
      : (await db.select({ orgId: orgMembers.orgId }).from(orgMembers).where(and(eq(orgMembers.userId, me), inArray(orgMembers.role, ['owner', 'admin'])))).map((m) => m.orgId)
    const mine = actor.trial || !actor.verified
      ? eq(scenes.ownerId, me)
      : or(eq(scenes.ownerId, me), arrayContains(scenes.restorerIds, [me]), ...(adminOf.length ? [inArray(scenes.orgId, adminOf)] : []))
    const rows = await db
      .select({ id: scenes.id, name: scenes.name, thumbnailUrl: scenes.thumbnailUrl, orgId: scenes.orgId, orgName: organizations.name, deletedAt: scenes.deletedAt, deletedOrgId: scenes.deletedOrgId })
      .from(scenes)
      .leftJoin(organizations, eq(organizations.id, scenes.orgId))
      .where(and(isNotNull(scenes.deletedAt), mine))
      .orderBy(asc(scenes.deletedAt))
    const removals = await removalsOf(rows.map((r) => r.id))
    return reply.send({
      scenes: rows.map((s) => ({
        ...s,
        purgeAt: purgeAtOf(s.deletedAt!),
        orgDeleted: !s.orgId && !!s.deletedOrgId,
        removals: removals.filter((r) => r.sceneId === s.id).map(publicRemoval),
      })),
    })
  })

  app.get<{ Params: { sceneId: string } }>('/api/scenes/:sceneId/delete-plan', { config: { trial: true } }, async (request, reply) => {
    const scene = await managed(request, reply, false)
    if (!scene) return reply
    return reply.send({
      scene: { id: scene.id, name: scene.name },
      purgeAt: purgeAtOf(new Date()),
      running: await removalOptions(scene.id),
      upcomingEvents: await upcomingEvents(scene.id),
    })
  })

  app.delete<{ Params: { sceneId: string }; Body: { remove?: unknown } | null }>(
    '/api/scenes/:sceneId',
    { config: { trial: true } },
    async (request, reply) => {
      const scene = await managed(request, reply, false)
      if (!scene) return reply
      const raw = request.body?.remove
      if (raw !== undefined && (!Array.isArray(raw) || !raw.every(isUuid))) return reply.status(400).send({ error: 'bad_remove', message: 'remove must be a list of ids' })
      const remove = (raw as string[] | undefined) ?? []
      if (remove.length && request.user.trial) return reply.status(403).send({ error: 'account_required', action: 'remove_deployments' })
      const now = new Date()
      if (!(await softDeleteScene(scene.id, request.user.id, now))) return reply.status(404).send(NOT_FOUND)
      // The scene is deleted whatever happens to these: a failure is listed with Retry
      const removals = remove.length ? await startRemovals(scene.id, remove, request.user.id) : []
      return reply.send({
        scene: { id: scene.id, name: scene.name, deletedAt: now, purgeAt: purgeAtOf(now) },
        removals: removals.map(publicRemoval),
      })
    },
  )

  app.post<{ Params: { sceneId: string } }>('/api/scenes/:sceneId/restore', { config: { trial: true, deletedScene: true } }, async (request, reply) => {
    const scene = await managed(request, reply, true)
    if (!scene) return reply
    // A scene of a deleted organization becomes the restorer's own: their plan's scene limit applies
    const newOwner = !scene.orgId && scene.deletedOrgId ? request.user.id : scene.ownerId
    const limit = await sceneLimitError(newOwner)
    if (limit) return reply.status(403).send(limit)
    const restored = await restoreScene(scene.id, request.user.id)
    if (!restored) return reply.status(404).send(NOT_FOUND)
    const removals = (await removalsOf([scene.id])).filter((r) => r.status === 'done')
    return reply.send({ scene: restored, notRestored: removals.map(publicRemoval) })
  })

  app.post<{ Params: { sceneId: string }; Body: { name?: unknown } | null }>(
    '/api/scenes/:sceneId/purge',
    { config: { trial: true, deletedScene: true } },
    async (request, reply) => {
      const scene = await managed(request, reply, true)
      if (!scene) return reply
      if (request.body?.name !== scene.name) return reply.status(400).send({ error: 'name_mismatch', message: "Type the scene's name to delete it forever." })
      try {
        await hardDeleteScene(scene.id)
      } catch (err) {
        if (err instanceof HostingError) return reply.status(409).send({ error: err.code, message: err.message })
        throw err
      }
      return reply.status(204).send()
    },
  )

  app.post<{ Params: { sceneId: string; removalId: string } }>(
    '/api/scenes/:sceneId/removals/:removalId/retry',
    { config: { deletedScene: true } },
    async (request, reply) => {
      const r = await removalOf(request, reply)
      if (!r) return reply
      if (r.status === 'done') return reply.send({ removal: publicRemoval(r) })
      return reply.send({ removal: publicRemoval(await runRemoval(r)) })
    },
  )

  app.get<{ Params: { sceneId: string; removalId: string } }>(
    '/api/scenes/:sceneId/removals/:removalId/sign',
    { config: { deletedScene: true } },
    async (request, reply) => {
      const r = await removalOf(request, reply)
      if (!r) return reply
      try {
        return reply.send(await signRequestFor(r))
      } catch (err) {
        return removalReply(reply, err)
      }
    },
  )

  app.post<{ Params: { sceneId: string; removalId: string }; Body: { chain?: unknown; timestamp?: unknown } | null }>(
    '/api/scenes/:sceneId/removals/:removalId/signature',
    { config: { deletedScene: true } },
    async (request, reply) => {
      const r = await removalOf(request, reply)
      if (!r) return reply
      try {
        return reply.send({ removal: publicRemoval(await submitRemovalSignature(r, request.user.id, request.body ?? {})) })
      } catch (err) {
        return removalReply(reply, err)
      }
    },
  )
}
