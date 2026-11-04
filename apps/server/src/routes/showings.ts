import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { asc, eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { sceneElements, screenShowings } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { canWriteElement, getSceneAccess } from '../auth/permissions.js'
import { utcToZoned } from '../scenes/schedule-time.js'
import { publishVenueEvent } from '../realtime/bus.js'
import { findShowingClash, parseShowingInput, presentShowing, resolveItems, ShowingError, specOfShowing, type ShowingRow } from '../scenes/showings.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NEW_ID = '00000000-0000-0000-0000-000000000000'

/**
 * Scheduled showings on a video screen (LIV-87), web only. Anyone who may edit the screen's playlist may manage its
 * showings: hosts, co-hosts and editors, and booking crew with the `playlist` scope on a screen of their booking.
 */
export default async function showingRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  type Screen = { id: string; type: string; presetId: string; clonedFromId: string | null; preset: { sceneId: string } }

  /** The screen, if the caller may manage its showings; otherwise the reply is sent and null comes back. */
  async function screenFor(request: FastifyRequest, reply: FastifyReply, elementId: string, mustBeVideo = true): Promise<Screen | null> {
    const el = UUID_RE.test(elementId)
      ? await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, elementId), with: { preset: { columns: { sceneId: true } } } })
      : undefined
    if (!el) { reply.status(404).send({ error: 'Element not found' }); return null }
    const access = await getSceneAccess(actorFromClaims(request.user), el.preset.sceneId)
    if (!canWriteElement(access, el, { propertyKeys: ['playlist'], fieldKeys: [] })) { reply.status(403).send({ error: 'Forbidden' }); return null }
    if (mustBeVideo && el.type !== 'video') { reply.status(400).send({ error: 'not_a_screen', message: 'Only video screens have showings.' }); return null }
    return el
  }

  async function ownShowing(request: FastifyRequest<{ Params: { showingId: string } }>, reply: FastifyReply): Promise<ShowingRow | null> {
    const { showingId } = request.params
    const row = UUID_RE.test(showingId) ? await db.query.screenShowings.findFirst({ where: eq(screenShowings.id, showingId) }) : undefined
    if (!row) { reply.status(404).send({ error: 'Showing not found' }); return null }
    // A screen changed to another type keeps its showings until they're deleted, so that must still work
    return (await screenFor(request, reply, row.elementId, request.method === 'PATCH')) ? row : null
  }

  /** Lengths resolved, then no overlap with the screen's other enabled showings. */
  async function prepare(elementId: string, body: Record<string, unknown>, base: ShowingRow | undefined, tx: Tx) {
    const input = parseShowingInput(body, base)
    const items = await resolveItems(input.items)
    const values = { ...input, items }
    if (values.enabled) {
      const clash = await findShowingClash(elementId, specOfShowing({ ...values, id: base?.id ?? NEW_ID }), new Date(), base?.id, tx)
      if (clash) {
        const local = utcToZoned(new Date(clash.at), values.timezone)
        const name = clash.row.id === (base?.id ?? NEW_ID) ? 'itself' : `"${clash.row.title ?? 'another showing'}"`
        throw new ShowingError(409, 'showing_overlap', `This runs into ${name} on ${local.date} at ${local.time}.`, clash.row.id === (base?.id ?? NEW_ID) ? {} : { showingId: clash.row.id })
      }
    }
    return values
  }

  type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
  /** Checks and writes for one screen one at a time: the screen's row is locked, so two saves can't both pass. */
  const locked = <T>(elementId: string, fn: (tx: Tx) => Promise<T>) =>
    db.transaction(async (tx) => {
      await tx.select({ id: sceneElements.id }).from(sceneElements).where(eq(sceneElements.id, elementId)).for('update')
      return fn(tx)
    })

  /** Players in the scene get the screen's new showings (after the write). Never fails the request. */
  const changed = (sceneId: string, elementId: string) =>
    publishVenueEvent({ type: 'showings_changed', sceneId, elementId }).catch((err) => console.error('[showings] publish failed:', err))

  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof ShowingError) return reply.status(e.status).send({ error: e.code, message: e.message, ...e.extra })
    throw e
  }

  app.get<{ Params: { elementId: string } }>('/api/elements/:elementId/showings', async (request, reply) => {
    const screen = await screenFor(request, reply, request.params.elementId, false)
    if (!screen) return reply
    const rows = await db.select().from(screenShowings).where(eq(screenShowings.elementId, screen.id)).orderBy(asc(screenShowings.createdAt))
    const now = new Date()
    return reply.send({ showings: rows.map((r) => presentShowing(r, now)) })
  })

  app.post<{ Params: { elementId: string } }>('/api/elements/:elementId/showings', async (request, reply) => {
    const screen = await screenFor(request, reply, request.params.elementId)
    if (!screen) return reply
    try {
      const row = await locked(screen.id, async (tx) => {
        const values = await prepare(screen.id, (request.body ?? {}) as Record<string, unknown>, undefined, tx)
        return (await tx.insert(screenShowings).values({ ...values, sceneId: screen.preset.sceneId, elementId: screen.id, createdBy: request.user.id }).returning())[0]
      })
      await changed(screen.preset.sceneId, screen.id)
      return reply.status(201).send({ showing: presentShowing(row, new Date()) })
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.patch<{ Params: { showingId: string } }>('/api/showings/:showingId', async (request, reply) => {
    const row = await ownShowing(request, reply)
    if (!row) return reply
    try {
      const updated = await locked(row.elementId, async (tx) => {
        // Re-read under the lock: an edit sent at the same moment may have changed it
        const current = await tx.query.screenShowings.findFirst({ where: eq(screenShowings.id, row.id) })
        if (!current) throw new ShowingError(404, 'not_found', 'Showing not found')
        const values = await prepare(row.elementId, (request.body ?? {}) as Record<string, unknown>, current, tx)
        return (await tx.update(screenShowings).set({ ...values, updatedAt: new Date() }).where(eq(screenShowings.id, row.id)).returning())[0]
      })
      await changed(row.sceneId, row.elementId)
      return reply.send({ showing: presentShowing(updated, new Date()) })
    } catch (e) {
      return fail(reply, e)
    }
  })

  app.delete<{ Params: { showingId: string } }>('/api/showings/:showingId', async (request, reply) => {
    const row = await ownShowing(request, reply)
    if (!row) return reply
    await db.delete(screenShowings).where(eq(screenShowings.id, row.id))
    await changed(row.sceneId, row.elementId)
    return reply.status(204).send()
  })
}
