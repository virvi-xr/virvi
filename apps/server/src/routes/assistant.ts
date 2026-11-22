// Virvi Assistant (LIV-155): conversations, the streamed turn, plan approval and undo.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import type { AssistantAccess, AssistantActivityItem, AssistantPageContext, AssistantStreamEvent } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { assistantActions, assistantConversations, userAuthMethods, users } from '../db/schema.js'
import { config } from '../config.js'
import { authenticate } from '../middleware/auth.js'
import { assistantAccess, type AssistantAccessResult } from '../assistant/access.js'
import { actionView, approvePlan, cancelPlan, undoAction, undoPlan } from '../assistant/actions.js'
import { APPROVAL_TEXT, DEFAULT_TITLE, isUuid, messageViews, ownConversation } from '../assistant/conversations.js'
import { runTurn } from '../assistant/loop.js'
import { modelAvailable } from '../assistant/model.js'
import { untrusted } from '../assistant/redact.js'
import { openSse, type Sse } from '../assistant/sse.js'
import { needsCard, type ToolCtx } from '../assistant/tools/types.js'

const TEXT_MAX = 4000
const CONVERSATIONS_LISTED = 50
const ACTIVITY_DEFAULT = 50
const ACTIVITY_MAX = 100
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
export const CHANGED_MESSAGE = "This changed after the assistant's edit, so Undo would overwrite it."
const UNDO_ERRORS = {
  changed: { status: 409, message: CHANGED_MESSAGE },
  not_undoable: { status: 409, message: "This can't be undone." },
  expired: { status: 409, message: 'Undo is only available for 7 days after a change.' },
  not_found: { status: 404, message: 'Not found.' },
} as const

/** Conversations with a turn running: the server runs as one instance, so a Set is enough. */
const busy = new Set<string>()

/** Percentages only: the budget's dollars never leave the server. */
function publicAccess(a: AssistantAccessResult): AssistantAccess {
  if (a.state === 'ok') return { state: 'ok', budget: a.budget }
  if (a.state === 'locked') return { state: 'locked', reason: a.reason }
  return { state: 'hidden' }
}

const SESSION_ONLY = { error: 'assistant_session_only', message: 'The assistant works only when you are signed in to the dashboard.' }
const APPROVE_ERRORS = {
  invalid_token: { status: 403, message: "This approval isn't valid. Ask the assistant to propose the plan again." },
  expired: { status: 410, message: 'This plan expired. Ask again to get a fresh one.' },
  used: { status: 409, message: 'This plan already ran.' },
} as const
/** The same refusals for a card (one paid action): it is confirmed and sent, not approved and run. */
const CARD_APPROVE_ERRORS = {
  invalid_token: { status: 403, message: "This confirmation isn't valid. Ask the assistant again." },
  expired: { status: 410, message: 'This expired. Ask again.' },
  used: { status: 409, message: 'This was already sent.' },
} as const

/** Every route but /status: an API key is 403, hidden is 404, locked is 403. */
async function guard(request: FastifyRequest, reply: FastifyReply) {
  if (request.user.viaApiKey) return reply.status(403).send(SESSION_ONLY)
  const a = await assistantAccess(request.user)
  if (a.state === 'hidden') return reply.status(404).send({ error: 'assistant_unavailable' })
  if (a.state === 'locked') return reply.status(403).send({ error: 'assistant_locked', reason: a.reason })
}

/**
 * Undo only: the caller's own changes can still be undone after a downgrade or with the audience narrowed. The kill
 * switch and API keys still refuse; undoAction and undoPlan only ever find the caller's own rows.
 */
async function undoGuard(request: FastifyRequest, reply: FastifyReply) {
  if (request.user.viaApiKey) return reply.status(403).send(SESSION_ONLY)
  if (!config.assistantEnabled) return reply.status(404).send({ error: 'assistant_unavailable' })
}

/** The caller as the tools run them: their own email and wallets are theirs to see (redaction keeps them). */
async function toolCtx(app: FastifyInstance, request: FastifyRequest): Promise<ToolCtx> {
  const [me] = await db.select({ email: users.email }).from(users).where(eq(users.id, request.user.id))
  const wallets = await db.select({ w: userAuthMethods.identifier }).from(userAuthMethods)
    .where(and(eq(userAuthMethods.userId, request.user.id), eq(userAuthMethods.type, 'wallet')))
  return { app, request, user: request.user, self: { email: me?.email ?? request.user.email ?? null, wallets: wallets.map((r) => r.w) } }
}

const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : undefined)
/** The page the panel was opened on, kept to its known fields. */
function pageFrom(v: unknown): AssistantPageContext | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const path = str(o.path, 500)
  if (!path) return null
  const page: AssistantPageContext = { path }
  for (const k of ['sceneId', 'eventId', 'locationId'] as const) {
    const s = str(o[k], 100)
    if (s) page[k] = s
  }
  return page
}

async function planRows(userId: string, planId: string) {
  return db.select().from(assistantActions).where(and(eq(assistantActions.planId, planId), eq(assistantActions.userId, userId))).orderBy(assistantActions.step)
}

export default async function assistantRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate, guard] }
  const undoAuth = { preHandler: [authenticate, undoGuard] }
  // Per account, after sign-in; each route counts on its own. A route with a limit gets its own preHandler array: the
  // plugin adds its hook to that array, and a shared one would carry the limit onto every route using it.
  const perUser = (route: string) => ({ rateLimit: { max: config.assistantMessagesPerMinute, timeWindow: '1 minute', hook: 'preHandler' as const, keyGenerator: (r: FastifyRequest) => `${route}:${r.user.id}` } })

  // A trial gets 'hidden' (200), so the panel stays quiet instead of erroring
  app.get('/api/assistant/status', { preHandler: [authenticate], config: { trial: true } }, async (request) => {
    if (request.user.kind === 'trial' || request.user.trial || request.user.viaApiKey) return { state: 'hidden' } satisfies AssistantAccess
    return publicAccess(await assistantAccess(request.user))
  })

  app.get('/api/assistant/conversations', auth, async (request) => {
    const rows = await db.select().from(assistantConversations).where(eq(assistantConversations.userId, request.user.id))
      .orderBy(desc(assistantConversations.updatedAt)).limit(CONVERSATIONS_LISTED)
    return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt.toISOString() }))
  })

  // The user's own changes and paid runs, newest first. Rows are ordered by (created_at to the millisecond, id), the
  // precision `next` carries, and `next` is "<createdAt>_<id>" so rows made in the same millisecond are never skipped.
  // A plain ISO date also works for `before`. Same guard as Undo: a locked or hidden account can still see its history.
  app.get<{ Querystring: { before?: string; limit?: string } }>('/api/assistant/activity', undoAuth, async (request, reply) => {
    const { before, limit: limitRaw } = request.query
    const bad = (message: string) => reply.status(400).send({ error: 'invalid_query', message })
    let limit = ACTIVITY_DEFAULT
    if (limitRaw !== undefined) {
      if (!/^\d+$/.test(limitRaw) || +limitRaw < 1 || +limitRaw > ACTIVITY_MAX) return bad(`limit must be a whole number from 1 to ${ACTIVITY_MAX}.`)
      limit = +limitRaw
    }
    let cursor: { at: string; id: string | null } | null = null
    if (before !== undefined) {
      const [at, id, ...extra] = typeof before === 'string' ? before.split('_') : ['']
      const valid = !extra.length && (id === undefined ? /^\d{4}-\d{2}-\d{2}T/.test(at) && !Number.isNaN(Date.parse(at)) : ISO_MS.test(at) && isUuid(id))
      if (!valid) return bad('before must be an ISO date, or the next value from the previous page.')
      cursor = { at: id === undefined ? new Date(at).toISOString() : at, id: id ?? null }
    }
    const created = sql`date_trunc('milliseconds', ${assistantActions.createdAt})`
    const rows = await db.select().from(assistantActions)
      .where(and(
        eq(assistantActions.userId, request.user.id),
        inArray(assistantActions.effect, ['write', 'paid', 'public']),
        ne(assistantActions.status, 'awaiting_confirmation'),
        cursor
          ? cursor.id
            ? sql`(${created}, ${assistantActions.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
            : sql`${created} < ${cursor.at}::timestamptz`
          : undefined,
      ))
      .orderBy(desc(created), desc(assistantActions.id))
      // One more than the page: only a row past it means there is a next page
      .limit(limit + 1)
    const more = rows.length > limit
    const items: AssistantActivityItem[] = rows.slice(0, limit).map((r) => ({
      ...actionView(r), createdAt: r.createdAt.toISOString(), conversationId: r.conversationId, effect: r.effect,
    }))
    const last = items[items.length - 1]
    return { items, next: more && last ? `${last.createdAt}_${last.id}` : null }
  })

  app.post('/api/assistant/conversations', { preHandler: [authenticate, guard], config: perUser('assistant-conversation') }, async (request, reply) => {
    const [me] = await db.select({ activeOrgId: users.activeOrgId }).from(users).where(eq(users.id, request.user.id))
    const [row] = await db.insert(assistantConversations)
      .values({ userId: request.user.id, orgId: request.user.orgId ?? me?.activeOrgId ?? null, title: DEFAULT_TITLE }).returning()
    return reply.status(201).send({ id: row.id, title: row.title, updatedAt: row.updatedAt.toISOString() })
  })

  app.delete<{ Params: { conversationId: string } }>('/api/assistant/conversations/:conversationId', auth, async (request, reply) => {
    const conv = await ownConversation(request.user.id, request.params.conversationId)
    if (!conv) return reply.status(404).send({ error: 'not_found' })
    if (busy.has(conv.id)) return reply.status(409).send({ error: 'assistant_busy', message: 'Wait for the reply to finish, then try again.' })
    // Messages go with it (cascade); the action log stays, its conversation_id set to null
    await db.delete(assistantConversations).where(eq(assistantConversations.id, conv.id))
    return reply.status(204).send()
  })

  app.get<{ Params: { conversationId: string } }>('/api/assistant/conversations/:conversationId/messages', auth, async (request, reply) => {
    const conv = await ownConversation(request.user.id, request.params.conversationId)
    if (!conv) return reply.status(404).send({ error: 'not_found' })
    return messageViews(conv.id, request.user.id, (await toolCtx(app, request)).self)
  })

  app.post<{ Params: { conversationId: string } }>('/api/assistant/conversations/:conversationId/messages', {
    preHandler: [authenticate, guard],
    config: perUser('assistant-message'),
  }, async (request, reply) => {
    const conv = await ownConversation(request.user.id, request.params.conversationId)
    if (!conv) return reply.status(404).send({ error: 'not_found' })
    const body = (request.body ?? {}) as { text?: unknown; page?: unknown }
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text || text.length > TEXT_MAX) return reply.status(400).send({ error: 'invalid_text', message: `Write a message of 1 to ${TEXT_MAX} characters.` })
    const page = pageFrom(body.page)
    if (!page) return reply.status(400).send({ error: 'invalid_page', message: 'page.path is required.' })
    if (!modelAvailable()) return reply.status(503).send({ error: 'assistant_unconfigured' })
    if (busy.has(conv.id)) return reply.status(409).send({ error: 'assistant_busy', message: 'Wait for the reply to finish, then send again.' })

    busy.add(conv.id)
    let sse: Sse | null = null
    try {
      const ctx = await toolCtx(app, request)
      sse = openSse(request, reply)
      await runTurn(ctx, conv.id, text, page, sse.send, sse.signal)
    } finally {
      busy.delete(conv.id)
      sse?.close()
    }
    return reply
  })

  app.post<{ Params: { planId: string } }>('/api/assistant/plans/:planId/approve', auth, async (request, reply) => {
    const { planId } = request.params
    const rows = isUuid(planId) ? await planRows(request.user.id, planId) : []
    if (!rows.length) return reply.status(404).send({ error: 'not_found' })
    const body = (request.body ?? {}) as { token?: unknown; page?: unknown }
    if (typeof body.token !== 'string') return reply.status(400).send({ error: 'invalid_token' })
    const conversationId = rows[0].conversationId
    if (conversationId && busy.has(conversationId)) return reply.status(409).send({ error: 'assistant_busy', message: 'Wait for the reply to finish, then approve.' })

    if (conversationId) busy.add(conversationId)
    let sse: Sse | null = null
    try {
      const ctx = await toolCtx(app, request)
      // The stream opens with the first step, so a refused token is still an ordinary error response
      const send = (e: AssistantStreamEvent) => {
        sse ??= openSse(request, reply)
        sse.send(e)
      }
      const r = await approvePlan(ctx, planId, body.token, (action) => send({ type: 'action', action }))
      if ('error' in r && !sse) {
        const e = (needsCard(rows[0].effect) ? CARD_APPROVE_ERRORS : APPROVE_ERRORS)[r.error]
        return reply.status(e.status).send({ error: r.error, message: e.message })
      }
      const stream = sse ?? openSse(request, reply)
      sse = stream
      if (conversationId && modelAvailable() && !stream.signal.aborted) {
        const results = (await planRows(request.user.id, planId)).map((s) => ({
          step: s.step, label: s.label, orgName: s.orgName, status: s.status, error: s.error,
          result: s.resultSummary ? (JSON.parse(s.resultSummary) as unknown) : null,
        }))
        const page = pageFrom(body.page) ?? { path: '/scenes' }
        await runTurn(ctx, conversationId, `${APPROVAL_TEXT}\n${untrusted('plan_results', results)}`, page, stream.send, stream.signal, { approval: true })
      } else {
        stream.send({ type: 'done', messageId: null })
      }
    } finally {
      if (conversationId) busy.delete(conversationId)
      ;(sse as Sse | null)?.close()
    }
    return reply
  })

  app.post<{ Params: { planId: string } }>('/api/assistant/plans/:planId/cancel', auth, async (request, reply) => {
    const { planId } = request.params
    if (!isUuid(planId) || !(await planRows(request.user.id, planId)).length) return reply.status(404).send({ error: 'not_found' })
    await cancelPlan(request.user.id, planId)
    return reply.status(204).send()
  })

  app.post<{ Params: { actionId: string } }>('/api/assistant/actions/:actionId/undo', undoAuth, async (request, reply) => {
    const r = await undoAction(await toolCtx(app, request), request.params.actionId)
    // An action view has an `error` field of its own: tell the two apart by `id`
    if ('id' in r) return r
    const e = UNDO_ERRORS[r.error]
    return reply.status(e.status).send({ error: r.error, message: e.message })
  })

  app.post<{ Params: { planId: string } }>('/api/assistant/plans/:planId/undo', undoAuth, async (request, reply) => {
    const r = await undoPlan(await toolCtx(app, request), request.params.planId)
    if ('error' in r) return reply.status(404).send({ error: 'not_found' })
    if (r.refused) {
      const e = UNDO_ERRORS[r.refused.error]
      return reply.status(e.status).send({ error: r.refused.error, message: e.message, undone: r.undone, refused: r.refused.action })
    }
    return r.undone
  })
}
