// Virvi Assistant shows (phase 2b): a user's saved checklists, one per event. Only ever the caller's own: another
// user's show id is 404 on every route. Item states are computed on each read (assistant/shows.ts).
import type { FastifyInstance, FastifyReply } from 'fastify'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { SHOW_ITEM_KINDS, type ShowItem, type ShowItemRef, type ShowView } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { assistantShows } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { guard } from './assistant.js'
import { isUuid, ownConversation } from '../assistant/conversations.js'
import { NOT_YOURS, REF_KEYS, SHOW_ITEMS_MAX, WEARABLE_EXAMPLE, computeShow, mayAttach, ownShow, parseWearable, showOrgId } from '../assistant/shows.js'

const SHOWS_LISTED = 50
const TEXT_MAX = 120

const createBody = z.object({
  title: z.string().trim().min(1).max(TEXT_MAX),
  startTime: z.iso.datetime({ offset: true }).optional(),
  conversationId: z.string().optional(),
  items: z.array(z.object({ kind: z.enum(SHOW_ITEM_KINDS), label: z.string().trim().min(1).max(TEXT_MAX) })).min(1).max(SHOW_ITEMS_MAX),
})

const SHOW_NOT_FOUND = { error: 'not_found', message: 'Show not found.' }
const bad = (reply: FastifyReply, message: string) => reply.status(400).send({ error: 'invalid_body', message })
const issues = (e: z.ZodError) => e.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ')

export default async function assistantShowRoutes(app: FastifyInstance) {
  // The same access as the conversations: an account session with the assistant available to it
  const auth = { preHandler: [authenticate, guard] }

  app.get<{ Querystring: { eventId?: string } }>('/api/assistant/shows', auth, async (request, reply) => {
    const { eventId } = request.query
    if (eventId !== undefined && !isUuid(eventId)) return bad(reply, 'eventId must be an id.')
    const rows = await db.select().from(assistantShows)
      .where(and(eq(assistantShows.userId, request.user.id), isNull(assistantShows.closedAt), eventId ? eq(assistantShows.eventId, eventId) : undefined))
      .orderBy(desc(assistantShows.updatedAt)).limit(SHOWS_LISTED)
    const shows: ShowView[] = []
    for (const row of rows) shows.push(await computeShow(request, row))
    return { shows }
  })

  app.get<{ Params: { showId: string } }>('/api/assistant/shows/:showId', auth, async (request, reply) => {
    const show = await ownShow(request.user.id, request.params.showId)
    if (!show) return reply.status(404).send(SHOW_NOT_FOUND)
    return computeShow(request, show)
  })

  app.post('/api/assistant/shows', auth, async (request, reply) => {
    const parsed = createBody.safeParse(request.body ?? {})
    if (!parsed.success) return bad(reply, issues(parsed.error))
    const { title, startTime, conversationId, items } = parsed.data
    if (conversationId !== undefined && !(await ownConversation(request.user.id, conversationId))) return reply.status(404).send({ error: 'not_found', message: NOT_YOURS })
    const [row] = await db.insert(assistantShows).values({
      userId: request.user.id,
      orgId: await showOrgId(request.user),
      conversationId: conversationId ?? null,
      title,
      startTime: startTime ? new Date(startTime) : null,
      items: items.map((i): ShowItem => ({ id: randomUUID(), kind: i.kind, label: i.label, ref: {} })),
    }).returning()
    return reply.status(201).send(await computeShow(request, row))
  })

  app.patch<{ Params: { showId: string; itemId: string } }>('/api/assistant/shows/:showId/items/:itemId', auth, async (request, reply) => {
    const show = await ownShow(request.user.id, request.params.showId)
    if (!show) return reply.status(404).send(SHOW_NOT_FOUND)
    const item = show.items.find((i) => i.id === request.params.itemId)
    if (!item) return reply.status(404).send({ error: 'not_found', message: "That item isn't in this show." })
    if (show.closedAt) return reply.status(409).send({ error: 'show_closed', message: 'This show is closed.' })

    const body = (request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body : {}) as Record<string, unknown>
    const hasRef = Object.hasOwn(body, 'ref')
    const hasWearable = Object.hasOwn(body, 'wearable')
    if (!hasRef && !hasWearable) return bad(reply, 'Give a ref or a wearable.')

    let ref: ShowItemRef | undefined
    if (hasRef) {
      const raw = body.ref
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad(reply, 'ref must be an object.')
      const allowed = REF_KEYS[item.kind]
      const entries = Object.entries(raw as Record<string, unknown>)
      for (const [key, value] of entries) {
        if (!(allowed as readonly string[]).includes(key)) return bad(reply, allowed.length ? `This item takes ${allowed.join(' or ')}.` : "This item doesn't take a ref.")
        if (!isUuid(value)) return bad(reply, `${key} must be an id.`)
      }
      // Each id through the owning route's own rule: someone else's row, or one that's gone, is the same 404
      for (const [key, value] of entries) {
        if (!(await mayAttach(request, key as keyof ShowItemRef, value as string))) return reply.status(404).send({ error: 'not_found', message: NOT_YOURS })
      }
      ref = Object.fromEntries(entries) as ShowItemRef
    }

    let wearable: ShowItem['wearable'] | null | undefined
    if (hasWearable) {
      if (item.kind !== 'wearable_published') return bad(reply, 'Only a wearable_published item takes a wearable.')
      if (body.wearable === null) wearable = null
      else {
        wearable = parseWearable(body.wearable)
        if (!wearable) return reply.status(400).send({ error: 'bad_wearable', message: WEARABLE_EXAMPLE })
      }
    }

    // Under the row's lock: a change sent at the same moment to another item isn't lost
    const updated = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(assistantShows).where(eq(assistantShows.id, show.id)).for('update')
      if (!current || current.closedAt) return null
      const items = current.items.map((i): ShowItem => {
        if (i.id !== item.id) return i
        const next: ShowItem = { ...i, ref: ref ?? i.ref ?? {} }
        if (wearable === null) delete next.wearable
        else if (wearable) next.wearable = wearable
        return next
      })
      // The event item's event is the show's: setting it sets the show's, clearing it clears it
      const eventId = item.kind === 'event' && ref ? (ref.eventId ?? null) : current.eventId
      return (await tx.update(assistantShows).set({ items, eventId, updatedAt: new Date() })
        .where(eq(assistantShows.id, show.id)).returning())[0]
    })
    if (!updated) return reply.status(409).send({ error: 'show_closed', message: 'This show is closed.' })
    return computeShow(request, updated)
  })

  app.post<{ Params: { showId: string } }>('/api/assistant/shows/:showId/close', auth, async (request, reply) => {
    const show = await ownShow(request.user.id, request.params.showId)
    if (!show) return reply.status(404).send(SHOW_NOT_FOUND)
    if (show.closedAt) return computeShow(request, show)
    const [closed] = await db.update(assistantShows).set({ closedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(assistantShows.id, show.id), eq(assistantShows.userId, request.user.id))).returning()
    return computeShow(request, closed)
  })
}
