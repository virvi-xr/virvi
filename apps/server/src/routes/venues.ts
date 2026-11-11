import type { FastifyInstance, FastifyReply } from 'fastify'
import { and, eq, inArray } from 'drizzle-orm'
import { VENUE_ROLE_SCOPES, isVenueRole } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { scenes, venues } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { isSceneDeleted, liveSceneIds } from '../scenes/live.js'
import { actorFromClaims } from '../auth/actor.js'
import { getBookingGrant, getSceneAccess, isFullAccess } from '../auth/permissions.js'
import {
  type CreateVenueInput,
  VenueError,
  addGrant,
  bookingsForActor,
  cancelBooking,
  createBooking,
  createVenue,
  getBookingWithVenue,
  getGrant,
  listGrants,
  revokeGrant,
  updateGrant,
  updateVenue,
} from '../venues/service.js'

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof VenueError) return reply.status(err.status).send({ error: err.message })
  throw err
}

export default async function venueRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  const actorOf = (request: { user: any }) => actorFromClaims(request.user)

  /** Admin, or owner of the scene. */
  async function canManageScene(request: { user: any }, sceneId: string) {
    const access = await getSceneAccess(actorOf(request), sceneId)
    return isFullAccess(access)
  }

  /** Crew management: admins/owners always; grant holders only via a `crew` grant on this very booking. */
  async function crewAccess(request: { user: any }, bookingId: string, targetRole?: string) {
    const booking = await getBookingWithVenue(bookingId)
    const actor = actorOf(request)
    const access = await getSceneAccess(actor, booking.venue.sceneId)
    if (isFullAccess(access)) return { booking, grant: null }
    const grant = await getBookingGrant(actor, bookingId)
    if (!grant || !grant.scopes.includes('crew')) throw new VenueError(403, 'You cannot manage crew for this booking')
    if (targetRole === 'host' && grant.role !== 'host') throw new VenueError(403, 'Only the host can change the host')
    return { booking, grant }
  }

  /** A grant holder (not full access) may only hand out scopes they hold themselves, and only the host may hand out `crew`. */
  function assertGrantable(caller: { role: string; scopes: string[] } | null, scopes: unknown) {
    if (!caller || !Array.isArray(scopes)) return
    if (scopes.some((sc) => !caller.scopes.includes(sc) || (sc === 'crew' && caller.role !== 'host'))) {
      throw new VenueError(403, 'forbidden')
    }
  }

  /** Scopes a grant would end up with: the explicit list, else the role's defaults. */
  const requestedScopes = (role: unknown, scopes: unknown) =>
    scopes !== undefined ? scopes : isVenueRole(role) ? VENUE_ROLE_SCOPES[role] : undefined

  app.post<{ Body: Record<string, any> }>('/api/venues', async (request, reply) => {
    try {
      if (!(await canManageScene(request, request.body?.sceneId))) return reply.status(403).send({ error: 'Forbidden' })
      return reply.status(201).send({ venue: await createVenue(request.body as CreateVenueInput) })
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.get('/api/venues', async (_request, reply) => {
    // A deleted scene's venue (LIV-83) is unlisted while it's deleted
    const listed = await db.query.venues.findMany({ where: and(eq(venues.isListed, true), inArray(venues.sceneId, liveSceneIds())) })
    return reply.send({ venues: listed })
  })

  app.get('/api/venues/bookings/mine', async (request, reply) => {
    const actor = actorOf(request)
    if (!actor.userId || !actor.verified) return reply.send({ bookings: [] })
    return reply.send({ bookings: await bookingsForActor(actor.userId, actor.wallet) })
  })

  app.get<{ Params: { venueId: string } }>('/api/venues/:venueId', async (request, reply) => {
    const venue = await db.query.venues.findFirst({ where: eq(venues.id, request.params.venueId) })
    // Unlisted venues are visible only to people with some access to the venue's scene.
    if (!venue || (await isSceneDeleted(venue.sceneId)) || (!venue.isListed && (await getSceneAccess(actorOf(request), venue.sceneId)).level === 'none')) {
      return reply.status(404).send({ error: 'Venue not found' })
    }
    return reply.send({ venue })
  })

  app.patch<{ Params: { venueId: string }; Body: Record<string, any> }>('/api/venues/:venueId', async (request, reply) => {
    try {
      const venue = await db.query.venues.findFirst({ where: eq(venues.id, request.params.venueId) })
      if (!venue) return reply.status(404).send({ error: 'Venue not found' })
      if (!(await canManageScene(request, venue.sceneId))) return reply.status(403).send({ error: 'Forbidden' })
      return reply.send({ venue: await updateVenue(venue.id, request.body ?? {}) })
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.post<{ Params: { venueId: string }; Body: Record<string, any> }>('/api/venues/:venueId/bookings', async (request, reply) => {
    // Admin-only until self-serve booking + payments (sub-project 5).
    const actor = actorOf(request)
    if (!(actor.role === 'admin' && actor.verified)) return reply.status(403).send({ error: 'Only admins can create bookings right now' })
    try {
      const result = await createBooking({ ...(request.body as any), venueId: request.params.venueId, createdByUserId: request.user.id })
      return reply.status(201).send(result)
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.post<{ Params: { bookingId: string } }>('/api/venues/bookings/:bookingId/cancel', async (request, reply) => {
    const actor = actorOf(request)
    if (!(actor.role === 'admin' && actor.verified)) return reply.status(403).send({ error: 'Forbidden' })
    try {
      return reply.send({ booking: await cancelBooking(request.params.bookingId) })
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.get<{ Params: { bookingId: string } }>('/api/venues/bookings/:bookingId/grants', async (request, reply) => {
    try {
      await crewAccess(request, request.params.bookingId)
      return reply.send({ grants: await listGrants(request.params.bookingId) })
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.post<{ Params: { bookingId: string }; Body: Record<string, any> }>('/api/venues/bookings/:bookingId/grants', async (request, reply) => {
    try {
      const { grant: caller } = await crewAccess(request, request.params.bookingId)
      assertGrantable(caller, requestedScopes(request.body?.role, request.body?.scopes))
      const grant = await addGrant({ ...(request.body as any), bookingId: request.params.bookingId, grantedByUserId: request.user.id })
      return reply.status(201).send({ grant })
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.patch<{ Params: { grantId: string }; Body: Record<string, any> }>('/api/venues/grants/:grantId', async (request, reply) => {
    try {
      const grant = await getGrant(request.params.grantId)
      const { grant: caller } = await crewAccess(request, grant.bookingId, grant.role)
      if (caller && caller.id === grant.id) throw new VenueError(403, 'forbidden')
      assertGrantable(caller, requestedScopes(request.body?.role, request.body?.scopes))
      return reply.send({ grant: await updateGrant(grant.id, request.body ?? {}) })
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.delete<{ Params: { grantId: string } }>('/api/venues/grants/:grantId', async (request, reply) => {
    try {
      const grant = await getGrant(request.params.grantId)
      await crewAccess(request, grant.bookingId, grant.role)
      await revokeGrant(grant.id)
      return reply.status(204).send()
    } catch (err) {
      return fail(reply, err)
    }
  })
}
