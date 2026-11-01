import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { studioDesigns, studioJobs, studioRenders, studioSetRenders } from '../db/schema.js'
import { config } from '../config.js'
import { authenticate } from '../middleware/auth.js'
import { getSubscription } from '../integrations/stripe.js'
import { getStudioStore, jobFileKey, uploadKey } from '../studio/store.js'
import { verifyRenderFrame, framePath } from '../studio/render-urls.js'
import { quoteFinalize, QuoteError } from '../studio/pricing.js'
import { addUpload, deleteUpload, findUpload, UploadError, UPLOAD_LIMITS } from '../studio/uploads.js'
import { GiftCodeError, redeemGiftCode } from '../studio/gift-codes.js'
import { isPaused } from '../studio/scope.js'
import { currentRevisions, emotesFor, freeFixesLeft, queueFinalizeRenders, recordCheck, requestSetRender } from '../studio/sets.js'
import { createFinalizeCheckout, createTopupCheckout, entitlementFor, giftsFor, queueFinalize, reportMistake, PaymentError } from '../studio/payments.js'
import {
  BASE_EMOTES, BODY_SHAPES, OUTFITS, OWN_EMOTE, WEARABLE_CATEGORIES, setViewKey,
  designDetail, openDesignCount, publicDesign, queuePrompt, requestOrbit, requestRender, usage, type Design, type View,
} from '../studio/designs.js'

/**
 * The dashboard's Design Studio API. A design belongs to its owner alone: anyone else gets 404. Files never leave
 * through here, only signed render-frame URLs (render-urls.ts).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_PROMPT = 4000
const MAX_NAME = 120
const AGENTS = ['claude', 'codex', 'grok']
const REPORT_MIN = 10
const REPORT_MAX = 2000
const MAX_PACKS = 10

async function studioOn(_request: FastifyRequest, reply: FastifyReply) {
  if (!config.studioEnabled) return reply.status(404).send({ error: 'not_found' })
}

const paymentsOff = (reply: FastifyReply) => reply.status(503).send({ error: 'Payments are not available', code: 'payments_unavailable' })

/** Checkout failures as the page sees them. */
function checkoutRefusal(reply: FastifyReply, err: unknown) {
  if (err instanceof QuoteError) return quoteRefusal(reply, err)
  if (err instanceof PaymentError) return reply.status(err.status).send({ error: err.code, code: err.code })
  throw err
}

const notFound = (reply: FastifyReply) => reply.status(404).send({ error: 'design_not_found' })

async function ownDesign(request: FastifyRequest): Promise<Design | null> {
  const id = (request.params as { id: string }).id
  if (!UUID.test(id)) return null
  const [d] = await db.select().from(studioDesigns).where(and(eq(studioDesigns.id, id), eq(studioDesigns.ownerId, request.user.id)))
  return d ?? null
}

/** Agent check shared by create and update. */
function agentError(agent: unknown): string | null {
  return AGENTS.includes(agent as string) ? null : 'agent must be claude, codex or grok'
}

/** A quote refusal as the page sees it: an unknown piece is the caller's mistake, the rest are the design's state. */
export function quoteRefusal(reply: FastifyReply, err: QuoteError) {
  return reply.status(err.code === 'unknown_piece' ? 400 : 409).send({ error: err.code, code: err.code, categories: err.categories })
}

/** New work: refused for an account whose studio access the owner paused (it can still finalize and download). */
async function notPaused(request: FastifyRequest, reply: FastifyReply) {
  if (await isPaused(request.user.id)) {
    return reply.status(403).send({ error: 'Your studio access is paused', code: 'studio_paused' })
  }
}

async function openLimit(userId: string) {
  return (await getSubscription(userId)).limits.studioOpenDesigns
}

export default async function studioRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate, studioOn] }
  const work = { preHandler: [authenticate, studioOn, notPaused] }

  // Not behind notPaused: a paused account may still redeem. Guessing is slow: 10 tries an hour per account.
  app.post('/api/studio/gift-codes/redeem', {
    ...auth,
    config: { rateLimit: { max: 10, timeWindow: '1 hour', hook: 'preHandler', keyGenerator: (r: FastifyRequest) => r.user.id } },
  }, async (request, reply) => {
    const b = (request.body ?? {}) as { code?: unknown }
    if (typeof b.code !== 'string' || b.code.length > 100) return reply.status(400).send({ error: 'code must be text' })
    try {
      return await redeemGiftCode(request.user.id, b.code, new Date())
    } catch (err) {
      if (err instanceof GiftCodeError) return reply.status(err.status).send({ error: err.code })
      throw err
    }
  })

  app.get('/api/studio/usage', auth, async (request) => {
    return { ...await usage(request.user.id, await openLimit(request.user.id), new Date()), paused: await isPaused(request.user.id) }
  })

  app.post('/api/studio/designs', work, async (request, reply) => {
    const b = (request.body ?? {}) as { kind?: unknown; agent?: unknown; name?: unknown }
    const err = agentError(b.agent)
    if (err) return reply.status(400).send({ error: err })
    if (b.kind !== 'wearable' && b.kind !== 'emote') return reply.status(400).send({ error: 'kind must be wearable or emote' })
    if (b.name !== undefined && (typeof b.name !== 'string' || !b.name.trim() || b.name.length > MAX_NAME)) {
      return reply.status(400).send({ error: `name must be 1-${MAX_NAME} characters` })
    }
    if ((await openDesignCount(request.user.id)) >= (await openLimit(request.user.id))) {
      return reply.status(403).send({ error: 'Your plan has no room for another open design', code: 'open_design_limit' })
    }
    const [d] = await db.insert(studioDesigns).values({
      ownerId: request.user.id,
      name: typeof b.name === 'string' ? b.name.trim() : b.kind === 'emote' ? 'Untitled emote' : 'Untitled design',
      kind: b.kind,
      agent: b.agent as string,
    }).returning()
    return reply.status(201).send(publicDesign(d))
  })

  app.get('/api/studio/designs', auth, async (request) => {
    const archived = (request.query as { archived?: string }).archived === 'true'
    const rows = await db.select().from(studioDesigns)
      .where(and(eq(studioDesigns.ownerId, request.user.id), archived ? isNotNull(studioDesigns.archivedAt) : isNull(studioDesigns.archivedAt)))
      .orderBy(desc(studioDesigns.createdAt))
    return rows.map(publicDesign)
  })

  app.get('/api/studio/designs/:id', auth, async (request, reply) => {
    const d = await ownDesign(request)
    if (!d) return notFound(reply)
    return designDetail(d, new Date())
  })

  app.patch('/api/studio/designs/:id', auth, async (request, reply) => {
    const d = await ownDesign(request)
    if (!d) return notFound(reply)
    const b = (request.body ?? {}) as { name?: unknown; agent?: unknown; archived?: unknown }
    const set: Partial<typeof studioDesigns.$inferInsert> = {}
    if (b.name !== undefined) {
      if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > MAX_NAME) return reply.status(400).send({ error: `name must be 1-${MAX_NAME} characters` })
      set.name = b.name.trim()
    }
    if (b.agent !== undefined) {
      const err = agentError(b.agent)
      if (err) return reply.status(400).send({ error: err })
      set.agent = b.agent as string
    }
    if (b.archived !== undefined) {
      if (typeof b.archived !== 'boolean') return reply.status(400).send({ error: 'archived must be true or false' })
      if (!b.archived && d.archivedAt && (await openDesignCount(request.user.id)) >= (await openLimit(request.user.id))) {
        return reply.status(403).send({ error: 'Your plan has no room for another open design', code: 'open_design_limit' })
      }
      set.archivedAt = b.archived ? (d.archivedAt ?? new Date()) : null
    }
    const [updated] = Object.keys(set).length
      ? await db.update(studioDesigns).set(set).where(eq(studioDesigns.id, d.id)).returning()
      : [d]
    return publicDesign(updated)
  })

  app.post('/api/studio/designs/:id/prompts', work, async (request, reply) => {
    const d = await ownDesign(request)
    if (!d) return notFound(reply)
    const b = (request.body ?? {}) as { text?: unknown; selectedSlots?: unknown; continue?: unknown; fixChecks?: unknown }
    const cont = b.continue === true
    const fixChecks = b.fixChecks === true
    if (fixChecks) {
      const r = await queuePrompt(d, { text: null, selectedSlots: null, continue: false, fixChecks: true }, new Date())
      if (!r.ok) return reply.status(r.status).send(r.body)
      return reply.status(202).send({ jobId: r.jobId })
    }
    if (!cont && (typeof b.text !== 'string' || !b.text.trim() || b.text.length > MAX_PROMPT)) {
      return reply.status(400).send({ error: `text must be 1-${MAX_PROMPT} characters` })
    }
    let slots: string[] | null = null
    if (b.selectedSlots != null) {
      if (d.kind !== 'wearable') return reply.status(400).send({ error: 'only a wearable design has slots' })
      if (!Array.isArray(b.selectedSlots) || !b.selectedSlots.length
        || !b.selectedSlots.every((s) => (WEARABLE_CATEGORIES as readonly string[]).includes(s))) {
        return reply.status(400).send({ error: 'selectedSlots must be wearable categories' })
      }
      slots = [...new Set(b.selectedSlots as string[])]
    }
    const r = await queuePrompt(d, { text: cont ? null : (b.text as string).trim(), selectedSlots: slots, continue: cont }, new Date())
    if (!r.ok) return reply.status(r.status).send(r.body)
    return reply.status(202).send({ jobId: r.jobId })
  })

  app.get('/api/studio/designs/:id/finalize', auth, async (request, reply) => {
    const d = await ownDesign(request)
    if (!d) return notFound(reply)
    try {
      return await quoteFinalize(d, null, [], await giftsFor(request.user.id, d.id, new Date()))
    } catch (err) {
      if (err instanceof QuoteError) return quoteRefusal(reply, err)
      throw err
    }
  })

  app.post('/api/studio/designs/:id/finalize', auth, async (request, reply) => {
    const d = await ownDesign(request)
    if (!d) return notFound(reply)
    if (!config.stripeSecretKey) return paymentsOff(reply)
    const b = (request.body ?? {}) as { categories?: unknown; reports?: unknown }
    let categories: string[] | null = null
    if (b.categories != null) {
      if (!Array.isArray(b.categories) || !b.categories.length || !b.categories.every((c) => typeof c === 'string' && /^[a-z_]{1,32}$/.test(c))) {
        return reply.status(400).send({ error: 'categories must be piece categories' })
      }
      categories = [...new Set(b.categories as string[])]
    }
    const reports: Record<string, string> = {}
    if (b.reports != null) {
      if (typeof b.reports !== 'object' || Array.isArray(b.reports)) return reply.status(400).send({ error: 'reports must map a category to what was wrong' })
      for (const [category, text] of Object.entries(b.reports as Record<string, unknown>)) {
        if (!/^[a-z_]{1,32}$/.test(category) || typeof text !== 'string' || text.trim().length < REPORT_MIN || text.length > REPORT_MAX) {
          return reply.status(400).send({ error: `a report must be ${REPORT_MIN}-${REPORT_MAX} characters` })
        }
        reports[category] = text.trim()
      }
    }
    try {
      return await createFinalizeCheckout(d, { id: request.user.id, email: request.user.email ?? null }, categories, reports, new Date())
    } catch (err) {
      return checkoutRefusal(reply, err)
    }
  })

  app.post('/api/studio/designs/:id/pieces/:category/revisions/:number/report', auth, async (request, reply) => {
    const d = await ownDesign(request)
    if (!d) return notFound(reply)
    if (!config.stripeSecretKey) return paymentsOff(reply)
    const { category, number } = request.params as { category: string; number: string }
    if (!/^[a-z_]{1,32}$/.test(category) || !/^[1-9][0-9]{0,5}$/.test(number)) return reply.status(400).send({ error: 'unknown revision' })
    const text = (request.body as { text?: unknown } | null)?.text
    if (typeof text !== 'string' || text.trim().length < REPORT_MIN || text.length > REPORT_MAX) {
      return reply.status(400).send({ error: `a report must be ${REPORT_MIN}-${REPORT_MAX} characters` })
    }
    try {
      return await reportMistake(d, category, Number(number), text.trim(), new Date())
    } catch (err) {
      return checkoutRefusal(reply, err)
    }
  })

  /** The piece's paid revision from the route params, or the refusal already sent. */
  async function paidRevision(request: FastifyRequest, reply: FastifyReply) {
    const d = await ownDesign(request)
    if (!d) return void notFound(reply)
    const { category, number } = request.params as { category: string; number: string }
    if (!/^[a-z_]{1,32}$/.test(category) || !/^[1-9][0-9]{0,5}$/.test(number)) return void reply.status(400).send({ error: 'unknown revision' })
    const found = await entitlementFor(d.id, category, Number(number))
    if (!found) return void reply.status(402).send({ error: 'This revision has not been paid for', code: 'not_paid' })
    return { d, ...found }
  }

  // The only route a model file leaves by: the paid revision's package, to its owner
  app.get('/api/studio/designs/:id/pieces/:category/revisions/:number/package', auth, async (request, reply) => {
    const paid = await paidRevision(request, reply)
    if (!paid) return reply
    const { e, name } = paid
    if (e.status !== 'ready' || !e.packageKey) return reply.status(409).send({ error: e.status, code: e.status })
    const obj = await getStudioStore().getStream(e.packageKey)
    if (!obj) return reply.status(404).send({ error: 'package_missing', code: 'package_missing' })
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || e.category
    const { number } = request.params as { number: string }
    if (obj.length !== undefined) reply.header('Content-Length', obj.length)
    return reply
      .type('application/zip')
      .header('Content-Disposition', `attachment; filename="${slug}-r${number}.zip"`)
      .header('Cache-Control', 'private, no-store')
      .send(obj.body)
  })

  app.post('/api/studio/designs/:id/pieces/:category/revisions/:number/package/retry', auth, async (request, reply) => {
    const paid = await paidRevision(request, reply)
    if (!paid) return reply
    if (paid.e.status !== 'failed') return reply.status(409).send({ error: 'not_failed', code: 'not_failed' })
    const [jobId] = await queueFinalize(paid.d.id, [paid.e.id], new Date())
    return reply.status(202).send({ jobId })
  })

  app.post('/api/studio/topups', work, async (request, reply) => {
    if (!config.stripeSecretKey) return paymentsOff(reply)
    const packs = (request.body as { packs?: unknown } | null)?.packs ?? 1
    if (!Number.isInteger(packs) || (packs as number) < 1 || (packs as number) > MAX_PACKS) {
      return reply.status(400).send({ error: `packs must be 1-${MAX_PACKS}` })
    }
    try {
      return await createTopupCheckout({ id: request.user.id, email: request.user.email ?? null }, packs as number, new Date())
    } catch (err) {
      return checkoutRefusal(reply, err)
    }
  })

  // Files for the agent: the body is the file's bytes, whatever type the browser says (its bytes decide)
  await app.register(async (files) => {
    files.removeAllContentTypeParsers()
    files.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: UPLOAD_LIMITS.modelBytes + 1024 }, (_req, body, done) => done(null, body))
    files.post('/api/studio/designs/:id/uploads', { ...work, bodyLimit: UPLOAD_LIMITS.modelBytes + 1024 }, async (request, reply) => {
      const d = await ownDesign(request)
      if (!d) return notFound(reply)
      const name = (request.query as { name?: unknown }).name
      try {
        return reply.status(201).send(await addUpload(d, typeof name === 'string' ? name : '', Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0)))
      } catch (err) {
        if (err instanceof UploadError) return reply.status(err.status).send({ error: err.code, code: err.code })
        throw err
      }
    })
  })

  app.get('/api/studio/designs/:id/uploads/:uploadId', auth, async (request, reply) => {
    const d = await ownDesign(request)
    const uploadId = (request.params as { uploadId: string }).uploadId
    const u = d && UUID.test(uploadId) ? await findUpload(d.id, uploadId) : null
    const obj = u ? await getStudioStore().get(uploadKey(u.designId, u.id)) : null
    if (!u || !obj) return reply.status(404).send({ error: 'upload_not_found' })
    return reply.type(u.contentType).header('Cache-Control', 'private, max-age=3600').header('X-Content-Type-Options', 'nosniff').send(obj.body)
  })

  app.delete('/api/studio/designs/:id/uploads/:uploadId', auth, async (request, reply) => {
    const d = await ownDesign(request)
    const uploadId = (request.params as { uploadId: string }).uploadId
    if (!d || !UUID.test(uploadId) || !(await deleteUpload(d.id, uploadId))) return reply.status(404).send({ error: 'upload_not_found' })
    return reply.status(204).send()
  })

  app.post('/api/studio/designs/:id/renders', work, async (request, reply) => {
    const d = await ownDesign(request)
    if (!d) return notFound(reply)
    const b = (request.body ?? {}) as { category?: unknown; bodyShape?: unknown; outfit?: unknown; emote?: unknown; mode?: unknown }
    if (b.mode !== undefined && (b.mode !== 'orbit' || d.kind === 'emote')) return reply.status(400).send({ error: 'unknown mode' })
    const categoryOk = d.kind === 'emote' ? b.category === 'emote' : (WEARABLE_CATEGORIES as readonly string[]).includes(b.category as string)
    if (!categoryOk) return reply.status(400).send({ error: 'unknown category' })
    if (!(BODY_SHAPES as readonly unknown[]).includes(b.bodyShape)) return reply.status(400).send({ error: 'bodyShape must be male or female' })
    if (b.mode === 'orbit') {
      const r = await requestOrbit(d, b.category as string, b.bodyShape as View['bodyShape'], new Date())
      return r ?? reply.status(404).send({ error: 'piece_not_found' })
    }
    if (!(OUTFITS as readonly unknown[]).includes(b.outfit)) return reply.status(400).send({ error: 'unknown outfit' })
    const emote = b.emote ?? null
    if (emote !== null && (d.kind === 'emote' || !(BASE_EMOTES as readonly unknown[]).includes(emote))) {
      return reply.status(400).send({ error: 'unknown emote' })
    }
    const view = { bodyShape: b.bodyShape, outfit: b.outfit, emote } as View
    const r = await requestRender(d, b.category as string, view, new Date())
    if (!r) return reply.status(404).send({ error: 'piece_not_found' })
    return r
  })

  // An emote view with every piece worn: a base emote for a wearable design, the design's own (null) for an emote
  app.post('/api/studio/designs/:id/set-renders', work, async (request, reply) => {
    const d = await ownDesign(request)
    if (!d) return notFound(reply)
    const b = (request.body ?? {}) as { bodyShape?: unknown; outfit?: unknown; emote?: unknown }
    if (!(BODY_SHAPES as readonly unknown[]).includes(b.bodyShape)) return reply.status(400).send({ error: 'bodyShape must be male or female' })
    if (!(OUTFITS as readonly unknown[]).includes(b.outfit)) return reply.status(400).send({ error: 'unknown outfit' })
    const emote = b.emote ?? null
    if (d.kind === 'emote' ? emote !== null : !(BASE_EMOTES as readonly unknown[]).includes(emote)) {
      return reply.status(400).send({ error: 'unknown emote' })
    }
    const r = await requestSetRender(d, { bodyShape: b.bodyShape, outfit: b.outfit, emote } as View, new Date())
    if (!r) return reply.status(404).send({ error: 'piece_not_found' })
    return r.status === 'queued' ? { status: 'queued' } : r
  })

  /** An emote named in a check or report: a base emote for a wearable design, `own` (or null) for an emote design. */
  const checkedEmote = (d: Design, emote: unknown): string | null =>
    d.kind === 'emote' ? (emote == null || emote === OWN_EMOTE ? OWN_EMOTE : null)
      : emotesFor(d.kind).includes(emote as string) ? emote as string : null

  app.post('/api/studio/designs/:id/emote-checks', work, async (request, reply) => {
    const d = await ownDesign(request)
    if (!d) return notFound(reply)
    const b = (request.body ?? {}) as { emote?: unknown; bodyShape?: unknown; state?: unknown }
    const emote = checkedEmote(d, b.emote)
    if (!emote) return reply.status(400).send({ error: 'unknown emote' })
    if (!(BODY_SHAPES as readonly unknown[]).includes(b.bodyShape)) return reply.status(400).send({ error: 'bodyShape must be male or female' })
    // Clipping is reported through /clipping, which also queues the fix
    if (b.state !== 'fine') return reply.status(400).send({ error: 'state must be fine' })
    const revisions = await currentRevisions(d.id)
    if (!revisions) return reply.status(404).send({ error: 'piece_not_found' })
    await recordCheck(d.id, revisions, emote, b.bodyShape as string, 'fine')
    return reply.status(204).send()
  })

  // "I see clipping": a free fix in the server's words, for an emote view the person has seen
  app.post('/api/studio/designs/:id/clipping', work, async (request, reply) => {
    const d = await ownDesign(request)
    if (!d) return notFound(reply)
    const b = (request.body ?? {}) as { emote?: unknown; bodyShape?: unknown; outfit?: unknown }
    const emote = checkedEmote(d, b.emote)
    if (!emote) return reply.status(400).send({ error: 'unknown emote' })
    if (!(BODY_SHAPES as readonly unknown[]).includes(b.bodyShape)) return reply.status(400).send({ error: 'bodyShape must be male or female' })
    if (!(OUTFITS as readonly unknown[]).includes(b.outfit)) return reply.status(400).send({ error: 'unknown outfit' })
    const fix = { emote, bodyShape: b.bodyShape, outfit: b.outfit } as { emote: string; bodyShape: View['bodyShape']; outfit: View['outfit'] }
    const revisions = await currentRevisions(d.id)
    const key = setViewKey(d.kind, { bodyShape: fix.bodyShape, outfit: fix.outfit, emote: d.kind === 'emote' ? null : emote } as View)
    const [seen] = revisions ? await db.select({ id: studioSetRenders.id }).from(studioSetRenders).where(and(
      eq(studioSetRenders.designId, d.id), eq(studioSetRenders.revisions, revisions), eq(studioSetRenders.viewKey, key),
      eq(studioSetRenders.status, 'ready'))) : []
    if (!seen) return reply.status(409).send({ error: 'not_seen', code: 'not_seen' })
    if (await freeFixesLeft(d.id, emote) <= 0) return reply.status(409).send({ error: 'clipping_fix_limit', code: 'clipping_fix_limit' })
    const r = await queuePrompt(d, { text: null, selectedSlots: null, continue: false, fixClipping: fix }, new Date())
    if (!r.ok) return reply.status(r.status).send(r.body)
    await recordCheck(d.id, revisions, emote, fix.bodyShape, 'clipping')
    return reply.status(202).send({ jobId: r.jobId })
  })

  // Opening Finalize: every emote on both bodies, so the checklist fills while the person looks
  app.post('/api/studio/designs/:id/finalize-renders', work, async (request, reply) => {
    const d = await ownDesign(request)
    if (!d) return notFound(reply)
    return { queued: await queueFinalizeRenders(d, new Date()) }
  })

  // The signed token is the authority: no bearer. Every check failing is the same 403. A wildcard, not :token, because
  // tokens pass Fastify's 100-character parameter limit.
  // One view is 36 frames: a page loads hundreds a minute, so frames get their own, higher limit
  app.get('/api/studio/render-frames/*', { preHandler: studioOn, schema: { hide: true }, config: { rateLimit: { max: 3000, timeWindow: '1 minute' } } }, async (request, reply) => {
    const f = verifyRenderFrame((request.params as { '*': string })['*'], new Date())
    const forbidden = () => reply.status(403).send({ error: 'forbidden' })
    if (!f || !UUID.test(f.jobId) || !UUID.test(f.designId) || !UUID.test(f.revisionId)) return forbidden()
    if (!/^[a-z_]+$/.test(f.category) || !/^[a-z0-9-]+$/.test(f.viewKey)) return forbidden()
    const [job] = await db.select({ designId: studioJobs.designId }).from(studioJobs).where(eq(studioJobs.id, f.jobId))
    if (!job || job.designId !== f.designId) return forbidden()
    // An emote view's token names its set render row (the design's, not a piece revision's)
    const [render] = f.category === 'set'
      ? await db.select({ frames: studioSetRenders.frames }).from(studioSetRenders)
        .where(and(eq(studioSetRenders.id, f.revisionId), eq(studioSetRenders.designId, f.designId), eq(studioSetRenders.viewKey, f.viewKey),
          eq(studioSetRenders.jobId, f.jobId), eq(studioSetRenders.status, 'ready')))
      : await db.select({ frames: studioRenders.frames }).from(studioRenders)
        .where(and(eq(studioRenders.revisionId, f.revisionId), eq(studioRenders.viewKey, f.viewKey), eq(studioRenders.jobId, f.jobId), eq(studioRenders.status, 'ready')))
    if (!render || f.frame >= render.frames) return forbidden()
    const obj = await getStudioStore().get(jobFileKey(f.designId, f.jobId, framePath(f)))
    if (!obj) return reply.status(404).send({ error: 'frame_not_found' })
    return reply.type('image/webp').header('Cache-Control', 'private, max-age=3600').send(obj.body)
  })
}
