import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../middleware/auth.js'
import { isUuid } from '../auth/scene-from.js'
import { dismissFlag, listFlags, pauseUser, resumeUser } from '../studio/scope.js'
import { approveReport, declineReport, heldReports, PaymentError } from '../studio/payments.js'
import { listWallForAdmin, setWallHidden } from '../studio/wall.js'
import { createGiftCode, disableGiftCode, GiftCodeError, listGiftCodes } from '../studio/gift-codes.js'
import { declineManaRefund, listManaRefunds, manaRefundQuote, recordManaRefundSent, type ManaRefundStatus } from '../studio/mana/refunds.js'
import { listManaTransfers, markTransferReturned, settleTransferByHand, type ManaTransferStatus } from '../studio/mana/settle.js'

const TX_HASH = /^0x[0-9a-fA-F]{64}$/
const REFUND_STATUSES: ManaRefundStatus[] = ['requested', 'sent', 'declined']
const TRANSFER_STATUSES: ManaTransferStatus[] = ['unmatched', 'matched', 'settled_by_hand', 'returned']
const MAX_NOTE = 500

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

/** Admins only: the Studio flags page (src/studio/scope.ts). Accounts that keep sending off-topic work, and pausing them. */
async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (request.user.role !== 'admin') {
    return reply.status(403).send({ error: 'Forbidden', message: 'Admin access required' })
  }
}

export default async function adminStudioRoutes(app: FastifyInstance) {
  const admin = { preHandler: [authenticate, requireAdmin] }

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

  // The wall of fame: every shown design, so a bad one can be hidden from the public wall.
  app.get('/api/admin/studio/wall', admin, async () => ({ entries: await listWallForAdmin(new Date()) }))

  app.post('/api/admin/studio/wall/:designId/hide', admin, async (request, reply) => {
    const { designId } = request.params as { designId: string }
    const { hidden } = (request.body ?? {}) as { hidden?: unknown }
    if (typeof hidden !== 'boolean') return reply.status(400).send({ error: 'hidden must be true or false' })
    if (!isUuid(designId) || !(await setWallHidden(designId, hidden, new Date()))) return reply.status(404).send({ error: 'design_not_found' })
    return { hidden }
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
