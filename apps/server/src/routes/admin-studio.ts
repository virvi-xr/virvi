import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../middleware/auth.js'
import { isUuid } from '../auth/scene-from.js'
import { dismissFlag, listFlags, pauseUser, resumeUser } from '../studio/scope.js'
import { approveReport, declineReport, heldReports, PaymentError } from '../studio/payments.js'
import { createGiftCode, disableGiftCode, GiftCodeError, listGiftCodes } from '../studio/gift-codes.js'
import { declineManaRefund, listManaRefunds, manaRefundQuote, recordManaRefundSent, type ManaRefundStatus } from '../studio/mana/refunds.js'
import { listManaTransfers, markTransferReturned, settleTransferByHand, type ManaTransferStatus } from '../studio/mana/settle.js'
import { requireAdmin } from '../auth/admin.js'
import { decodeCursor, DESIGN_KINDS, listAdminDesigns } from '../studio/admin-designs.js'
import { lastFullWeek, listDownRatings, markRating, parseWeek, weekDigest } from '../studio/rating-review.js'
import { TAG_KEYS } from '../studio/ratings.js'
import { createLesson, deleteLesson, isLessonKind, LessonError, lessonText, listLessons, updateLesson } from '../studio/lessons.js'
import { DRAFT_BATCH_MAX, draftingAvailable, draftLesson } from '../studio/lesson-drafts.js'

const TX_HASH = /^0x[0-9a-fA-F]{64}$/
const REFUND_STATUSES: ManaRefundStatus[] = ['requested', 'sent', 'declined']
const TRANSFER_STATUSES: ManaTransferStatus[] = ['unmatched', 'matched', 'settled_by_hand', 'returned']
const MAX_NOTE = 500
const MAX_QUERY = 200

/** A refusal from the payment code as the page sees it. */
function refusal(reply: FastifyReply, err: unknown) {
  if (err instanceof PaymentError) return reply.status(err.status).send({ error: err.code, code: err.code })
  throw err
}

/** The transfer named by the :txHash/:logIndex params, or null. */
function transferKey(request: FastifyRequest): { txHash: string; logIndex: number } | null {
  const { txHash, logIndex } = request.params as { txHash: string; logIndex: string }
  if (!TX_HASH.test(txHash) || !/^(0|[1-9][0-9]{0,5})$/.test(logIndex)) return null
  return { txHash, logIndex: Number(logIndex) }
}


export default async function adminStudioRoutes(app: FastifyInstance) {
  // Admins only (the database's role: src/auth/admin.ts): the Studio admin page
  const admin = { preHandler: [authenticate, requireAdmin] }

  // Everyone's designs, trial ones included, to open and help with (Virvi support, on the design's own page)
  app.get('/api/admin/studio/designs', admin, async (request, reply) => {
    const { q, kind, cursor } = request.query as { q?: unknown; kind?: unknown; cursor?: unknown }
    if (q !== undefined && (typeof q !== 'string' || q.length > MAX_QUERY)) return reply.status(400).send({ error: `q must be at most ${MAX_QUERY} characters` })
    if (kind !== undefined && kind !== '' && !(DESIGN_KINDS as readonly unknown[]).includes(kind)) {
      return reply.status(400).send({ error: 'kind must be wearable, emote or scene' })
    }
    const at = cursor === undefined || cursor === '' ? null : typeof cursor === 'string' ? decodeCursor(cursor) : null
    if (cursor !== undefined && cursor !== '' && !at) return reply.status(400).send({ error: 'unknown cursor' })
    return listAdminDesigns({ q: q as string | undefined, kind: (kind as string | undefined) || null, cursor: at })
  })

  // 👎 revisions to review (LIV-142), newest first
  app.get('/api/admin/studio/ratings', admin, async (request, reply) => {
    const q = request.query as Record<string, unknown>
    const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null)
    const kind = text(q.kind)
    if (kind && !(DESIGN_KINDS as readonly string[]).includes(kind)) return reply.status(400).send({ error: 'kind must be wearable, emote or scene' })
    const tag = text(q.tag)
    if (tag && !(TAG_KEYS as string[]).includes(tag)) return reply.status(400).send({ error: 'unknown tag' })
    const agent = text(q.agent)
    const model = text(q.model)
    if ((agent && agent.length > MAX_QUERY) || (model && model.length > MAX_QUERY)) return reply.status(400).send({ error: 'agent and model must be short' })
    const handled = q.handled === 'true' ? true : q.handled === 'false' ? false : null
    if (q.handled !== undefined && q.handled !== '' && handled === null) return reply.status(400).send({ error: 'handled must be true or false' })
    const cursor = text(q.cursor)
    const at = cursor ? decodeCursor(cursor) : null
    if (cursor && !at) return reply.status(400).send({ error: 'unknown cursor' })
    return listDownRatings({ kind, agent, model, tag, handled }, at, new Date())
  })

  app.patch('/api/admin/studio/ratings/:id', admin, async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!isUuid(id)) return reply.status(404).send({ error: 'rating_not_found' })
    const b = (request.body ?? {}) as { handled?: unknown; autoCheck?: unknown }
    if ((b.handled !== undefined && typeof b.handled !== 'boolean') || (b.autoCheck !== undefined && typeof b.autoCheck !== 'boolean')) {
      return reply.status(400).send({ error: 'handled and autoCheck must be true or false' })
    }
    if (b.handled === undefined && b.autoCheck === undefined) return reply.status(400).send({ error: 'nothing to change' })
    const r = await markRating(id, request.user.id, { handled: b.handled as boolean | undefined, autoCheck: b.autoCheck as boolean | undefined }, new Date())
    return r ?? reply.status(404).send({ error: 'rating_not_found' })
  })

  // The weekly ratings digest: `week` is its Monday (YYYY-MM-DD, UTC); without it, the last full week
  app.get('/api/admin/studio/digest', admin, async (request, reply) => {
    const raw = (request.query as { week?: unknown }).week
    const week = raw === undefined || raw === '' ? lastFullWeek(new Date()) : parseWeek(raw)
    if (!week) return reply.status(400).send({ error: 'week must be a Monday, as YYYY-MM-DD' })
    return weekDigest(week)
  })

  // Lessons for the agent, per design kind: drafted, edited, approved, switched off (LIV-142)
  const lessonRefusal = (reply: FastifyReply, err: unknown) => {
    if (err instanceof LessonError) return reply.status(err.status).send({ error: err.code, code: err.code })
    throw err
  }
  const ratingIds = (raw: unknown, max: number): string[] | null =>
    Array.isArray(raw) && raw.length <= max && raw.every(isUuid) ? [...new Set(raw as string[])] : null

  app.get('/api/admin/studio/lessons', admin, async (request, reply) => {
    const kind = (request.query as { kind?: unknown }).kind
    if (kind !== undefined && kind !== '' && !isLessonKind(kind)) return reply.status(400).send({ error: 'kind must be wearable, emote or scene' })
    return { ...await listLessons(isLessonKind(kind) ? kind : null), drafting: draftingAvailable() }
  })

  app.post('/api/admin/studio/lessons', admin, async (request, reply) => {
    const b = (request.body ?? {}) as { kind?: unknown; text?: unknown; sourceRatingIds?: unknown }
    if (!isLessonKind(b.kind)) return reply.status(400).send({ error: 'kind must be wearable, emote or scene' })
    const text = lessonText(b.text)
    if (!text) return reply.status(400).send({ error: 'text must be 1-500 characters' })
    const sources = b.sourceRatingIds === undefined ? [] : ratingIds(b.sourceRatingIds, DRAFT_BATCH_MAX)
    if (!sources) return reply.status(400).send({ error: 'sourceRatingIds must be rating ids' })
    try {
      return reply.status(201).send(await createLesson(request.user.id, { kind: b.kind, text, sourceRatingIds: sources, drafted: 'admin' }, new Date()))
    } catch (err) {
      return lessonRefusal(reply, err)
    }
  })

  // "Draft a lesson": Claude drafts one from the chosen 👎s (one kind); it is saved as a draft for the admin to edit
  app.post('/api/admin/studio/lessons/draft', admin, async (request, reply) => {
    const ids = ratingIds((request.body as { ratingIds?: unknown } | null)?.ratingIds, DRAFT_BATCH_MAX)
    if (!ids?.length) return reply.status(400).send({ error: `ratingIds must be 1-${DRAFT_BATCH_MAX} rating ids` })
    try {
      const { kind, text } = await draftLesson(ids)
      return reply.status(201).send(await createLesson(request.user.id, { kind, text, sourceRatingIds: ids, drafted: 'claude' }, new Date()))
    } catch (err) {
      return lessonRefusal(reply, err)
    }
  })

  app.patch('/api/admin/studio/lessons/:id', admin, async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!isUuid(id)) return reply.status(404).send({ error: 'lesson_not_found' })
    const b = (request.body ?? {}) as { text?: unknown; enabled?: unknown; status?: unknown }
    const text = b.text === undefined ? undefined : lessonText(b.text)
    if (text === null) return reply.status(400).send({ error: 'text must be 1-500 characters' })
    if (b.enabled !== undefined && typeof b.enabled !== 'boolean') return reply.status(400).send({ error: 'enabled must be true or false' })
    if (b.status !== undefined && b.status !== 'approved') return reply.status(400).send({ error: "status can only become 'approved'" })
    try {
      return await updateLesson(id, request.user.id, { text, enabled: b.enabled as boolean | undefined, approve: b.status === 'approved' }, new Date())
    } catch (err) {
      return lessonRefusal(reply, err)
    }
  })

  app.delete('/api/admin/studio/lessons/:id', admin, async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!isUuid(id) || !(await deleteLesson(id))) return reply.status(404).send({ error: 'lesson_not_found' })
    return reply.status(204).send()
  })

  app.get('/api/admin/studio/flags', admin, async (request) => {
    const status = (request.query as { status?: string }).status === 'closed' ? 'closed' : 'open'
    return { flags: await listFlags(status, new Date()) }
  })

  app.post('/api/admin/studio/flags/:id/dismiss', admin, async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!isUuid(id) || !(await dismissFlag(id, request.user.id, new Date()))) return reply.status(404).send({ error: 'flag_not_found' })
    return reply.status(204).send()
  })

  app.post('/api/admin/studio/users/:userId/pause', admin, async (request, reply) => {
    const { userId } = request.params as { userId: string }
    if (!isUuid(userId) || !(await pauseUser(userId, request.user.id, new Date()))) return reply.status(404).send({ error: 'user_not_found' })
    return reply.status(204).send()
  })

  app.delete('/api/admin/studio/users/:userId/pause', admin, async (request, reply) => {
    const { userId } = request.params as { userId: string }
    if (!isUuid(userId)) return reply.status(404).send({ error: 'user_not_found' })
    await resumeUser(userId)
    return reply.status(204).send()
  })

  app.get('/api/admin/studio/reports', admin, async () => ({ reports: await heldReports(new Date()) }))

  app.post('/api/admin/studio/reports/:id/approve', admin, async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!isUuid(id)) return reply.status(404).send({ error: 'report_not_found' })
    try {
      return await approveReport(id, request.user.id, new Date())
    } catch (err) {
      if (err instanceof PaymentError) return reply.status(err.status).send({ error: err.code, code: err.code })
      throw err
    }
  })

  app.post('/api/admin/studio/reports/:id/decline', admin, async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!isUuid(id) || !(await declineReport(id, request.user.id, new Date()))) return reply.status(409).send({ error: 'not_in_review', code: 'not_in_review' })
    return reply.status(204).send()
  })

  // MANA back on request (src/studio/mana/refunds.ts): the owner sends it from their own wallet, or declines
  app.get('/api/admin/studio/mana-refunds', admin, async (request, reply) => {
    const status = (request.query as { status?: string }).status ?? 'requested'
    if (!REFUND_STATUSES.includes(status as ManaRefundStatus)) return reply.status(400).send({ error: 'unknown status' })
    return { refunds: await listManaRefunds(status as ManaRefundStatus) }
  })

  app.get('/api/admin/studio/mana-refunds/:id/quote', admin, async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!isUuid(id)) return reply.status(404).send({ error: 'not_found', code: 'not_found' })
    try {
      return await manaRefundQuote(id, new Date())
    } catch (err) {
      return refusal(reply, err)
    }
  })

  app.post('/api/admin/studio/mana-refunds/:id/sent', admin, async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!isUuid(id)) return reply.status(404).send({ error: 'not_found', code: 'not_found' })
    const b = (request.body ?? {}) as { txHash?: unknown; amountWei?: unknown }
    if (typeof b.txHash !== 'string' || !TX_HASH.test(b.txHash)) return reply.status(400).send({ error: 'txHash must be a 0x-prefixed 32-byte hex transaction hash' })
    if (typeof b.amountWei !== 'string' || !/^[1-9][0-9]{0,40}$/.test(b.amountWei)) return reply.status(400).send({ error: 'amountWei must be a positive whole number of wei' })
    try {
      return await recordManaRefundSent(id, b.txHash, BigInt(b.amountWei), request.user.id, new Date())
    } catch (err) {
      return refusal(reply, err)
    }
  })

  app.post('/api/admin/studio/mana-refunds/:id/decline', admin, async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!isUuid(id)) return reply.status(404).send({ error: 'not_found', code: 'not_found' })
    try {
      return await declineManaRefund(id, request.user.id, new Date())
    } catch (err) {
      return refusal(reply, err)
    }
  })

  // MANA transfers that matched no payment (src/studio/mana/settle.ts): settled by hand, or sent back
  app.get('/api/admin/studio/mana-transfers', admin, async (request, reply) => {
    const status = (request.query as { status?: string }).status ?? 'unmatched'
    if (!TRANSFER_STATUSES.includes(status as ManaTransferStatus)) return reply.status(400).send({ error: 'unknown status' })
    return { transfers: await listManaTransfers(status as ManaTransferStatus) }
  })

  app.post('/api/admin/studio/mana-transfers/:txHash/:logIndex/settle', admin, async (request, reply) => {
    const key = transferKey(request)
    if (!key) return reply.status(404).send({ error: 'transfer_not_found', code: 'transfer_not_found' })
    const b = (request.body ?? {}) as { paymentId?: unknown; note?: unknown }
    if (!isUuid(b.paymentId)) return reply.status(400).send({ error: 'paymentId must be a payment id' })
    if (b.note !== undefined && b.note !== null && (typeof b.note !== 'string' || b.note.length > MAX_NOTE)) {
      return reply.status(400).send({ error: `note must be text of at most ${MAX_NOTE} characters` })
    }
    try {
      return await settleTransferByHand(key.txHash, key.logIndex, b.paymentId, request.user.id, typeof b.note === 'string' ? b.note.trim() || null : null, new Date())
    } catch (err) {
      return refusal(reply, err)
    }
  })

  app.post('/api/admin/studio/mana-transfers/:txHash/:logIndex/returned', admin, async (request, reply) => {
    const key = transferKey(request)
    if (!key) return reply.status(404).send({ error: 'transfer_not_found', code: 'transfer_not_found' })
    const returnTxHash = ((request.body ?? {}) as { returnTxHash?: unknown }).returnTxHash
    if (typeof returnTxHash !== 'string' || !TX_HASH.test(returnTxHash)) {
      return reply.status(400).send({ error: 'returnTxHash must be a 0x-prefixed 32-byte hex transaction hash' })
    }
    try {
      return await markTransferReturned(key.txHash, key.logIndex, returnTxHash, request.user.id, new Date())
    } catch (err) {
      return refusal(reply, err)
    }
  })

  app.post('/api/admin/studio/gift-codes', admin, async (request, reply) => {
    const b = (request.body ?? {}) as Record<string, unknown>
    const expiresAt = b.expiresAt === undefined || b.expiresAt === null ? null : typeof b.expiresAt === 'string' ? new Date(b.expiresAt) : undefined
    const note = b.note === undefined || b.note === null ? null : typeof b.note === 'string' ? b.note : undefined
    if (typeof b.prompts !== 'number' || typeof b.finalizes !== 'number' || typeof b.maxUses !== 'number' || expiresAt === undefined || note === undefined || (expiresAt && isNaN(expiresAt.getTime()))) {
      return reply.status(400).send({ error: 'invalid' })
    }
    try {
      const made = await createGiftCode(request.user.id, { prompts: b.prompts, finalizes: b.finalizes, maxUses: b.maxUses, expiresAt, note }, new Date())
      return reply.status(201).send(made)
    } catch (err) {
      if (err instanceof GiftCodeError) return reply.status(err.status).send({ error: err.code })
      throw err
    }
  })

  app.get('/api/admin/studio/gift-codes', admin, async () => ({ codes: await listGiftCodes() }))

  app.post('/api/admin/studio/gift-codes/:id/off', admin, async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!isUuid(id) || !(await disableGiftCode(id, new Date()))) return reply.status(404).send({ error: 'code_not_found' })
    return reply.status(204).send()
  })
}
