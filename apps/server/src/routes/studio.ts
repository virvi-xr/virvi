import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { recordTrialBlocked } from '../auth/trial-events.js'
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { studioDesignMembers, studioDesigns, studioJobs, studioPayments, studioRenders, studioSetRenders, studioUploads, users } from '../db/schema.js'
import { config } from '../config.js'
import { isTrialUser } from '../studio/quota.js'
import { authenticate } from '../middleware/auth.js'
import { STUDIO_ROUTE_SCENE_PASS } from '../auth/scene-from.js'
import { getSubscription } from '../integrations/stripe.js'
import { getStudioStore, jobFileKey, uploadKey } from '../studio/store.js'
import { verifyRenderFrame, framePath } from '../studio/render-urls.js'
import { isVirviAdmin, quoteFinalize, QuoteError } from '../studio/pricing.js'
import { isAdminRequest } from '../auth/admin.js'
import { addUpload, deleteUpload, findUpload, UploadError, UPLOAD_LIMITS } from '../studio/uploads.js'
import { GiftCodeError, redeemGiftCode } from '../studio/gift-codes.js'
import { isPaused } from '../studio/scope.js'
import { designMembers, designRole, type DesignRole } from '../studio/members.js'
import { helpWithPrompt, PromptHelpError } from '../studio/prompt-help.js'
import { EXCLUDE_MAX, IDEAS_COUNT_MAX, IDEA_ID, IDEA_MOVES, IDEA_PLAYBACKS, findIdea, pickIdeas, retiredIdeas, type IdeaMove, type IdeaPlayback, type IdeaQuery } from '../studio/prompt-ideas.js'
import { warmDesign } from '../studio/warm.js'
import { emotesFor, freeFixesLeft, hasBuilding, queueFinalizeRenders, recordCheck, requestSetRender, setDetail, TOUR_VIEW, wornRevisions } from '../studio/sets.js'
import { isFurniture, SCENE_CATEGORY } from '../studio/scene.js'
import { createFinalizeCheckout, createTopupCheckout, creditFor, entitlementFor, giftsFor, queueFinalize, readyPackages, reportMistake, PaymentError, type CheckoutMethod } from '../studio/payments.js'
import { storedZip } from '../studio/zip.js'
import { kindDefaults } from '../studio/defaults.js'
import { clearRating, downRating, feedbackText, findRevision, parseRating, rateRevision, type RatingTag } from '../studio/ratings.js'
import { reportManaTx } from '../studio/mana/settle.js'
import { requestManaRefund } from '../studio/mana/refunds.js'
import {
  BASE_EMOTES, BODY_SHAPES, OUTFITS, OWN_EMOTE, WEARABLE_CATEGORIES, setViewKey,
  designDetail, openDesignCount, ownerWords, totalDesignCount, publicDesign, publicDesigns, queuePrompt, requestOrbit, requestRender, usage, type Design, type FixClipping, type View,
} from '../studio/designs.js'

/**
 * The dashboard's Design Studio API. Each design route needs a role on the design (studio/members.ts): `view` (any
 * role), `work` (owner or collaborator: a viewer gets 403 viewer) or `own` (the owner). Anyone without a role gets 404,
 * except a Virvi admin helping on the routes that say so (Virvi support: `allowAdmin`). Files never leave through here,
 * only signed render-frame URLs (render-urls.ts) and a paid revision's package.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_PROMPT = 4000
const MAX_NAME = 120
const AGENTS = ['claude', 'codex', 'grok']
const REPORT_MIN = 10
const REPORT_MAX = 2000
const MAX_PACKS = 10
// A prompt help's answers to its own quick-pick questions
const HELP_ANSWERS_MAX = 10
const HELP_ANSWER_MAX = 80
const HELP_ANSWER_ID = /^[a-z0-9_-]{1,40}$/

async function studioOn(_request: FastifyRequest, reply: FastifyReply) {
  if (!config.studioEnabled) return reply.status(404).send({ error: 'not_found' })
}

const paymentsOff = (reply: FastifyReply) => reply.status(503).send({ error: 'Payments are not available', code: 'payments_unavailable' })

/** A checkout's way to pay: card (Stripe, the default) or MANA; undefined for anything else. */
function checkoutMethod(raw: unknown): CheckoutMethod | undefined {
  if (raw == null) return 'card'
  return raw === 'card' || raw === 'mana' ? raw : undefined
}

/** Checkout failures as the page sees them. */
function checkoutRefusal(reply: FastifyReply, err: unknown) {
  if (err instanceof QuoteError) return quoteRefusal(reply, err)
  if (err instanceof PaymentError) return reply.status(err.status).send({ error: err.code, code: err.code })
  throw err
}

const notFound = (reply: FastifyReply) => reply.status(404).send({ error: 'design_not_found' })

/** A file-name slug of a piece's or design's name. */
const slugOf = (name: string, fallback: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || fallback

/** "Download all" holds the packages in memory while it zips them: past this, download them one by one. */
const DOWNLOAD_ALL_MAX_BYTES = 500 * 1024 * 1024

/**
 * A design the request may use: its role on it (null for support), and whether it is a Virvi admin helping on someone
 * else's (support).
 */
type Access = { d: Design; role: DesignRole | null; support: boolean }
/** What a route needs: to see the design (any role), to work on it (owner, collaborator) or to own it. */
type Need = 'view' | 'work' | 'own'
/** A viewer on a work route: refused 403 viewer, not hidden. */
const VIEWER = 'viewer' as const
/** The routes a Virvi admin may use on anyone's design: reading it, prompting, renders and checks, finalizing, packages. */
const SUPPORT = { allowAdmin: true }

const NEEDED: Record<Need, readonly DesignRole[]> = { view: ['owner', 'collaborator', 'viewer'], work: ['owner', 'collaborator'], own: ['owner'] }

/** Whether the request may help on other people's designs: the same admin check as every admin route. */
const canSupport = isAdminRequest

/**
 * The design in the route's :id, if the request's role meets the need; else support (allowAdmin, a Virvi admin), else
 * VIEWER (a viewer on a work route) or null (404: no such design, no role, or an own route).
 */
async function designAccess(request: FastifyRequest, opts: { need: Need; allowAdmin?: boolean }): Promise<Access | typeof VIEWER | null> {
  const id = (request.params as { id: string }).id
  if (!UUID.test(id)) return null
  const [d] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, id))
  if (!d) return null
  const role = d.ownerId === request.user.id ? 'owner' : await designRole(d.id, request.user.id)
  if (role && NEEDED[opts.need].includes(role)) return { d, role, support: false }
  if (opts.allowAdmin && await canSupport(request)) return { d, role: null, support: true }
  return role === 'viewer' && opts.need === 'work' ? VIEWER : null
}

/** designAccess's refusal: 403 viewer, or the stranger's 404. */
const refused = (reply: FastifyReply, a: typeof VIEWER | null) =>
  a === VIEWER ? reply.status(403).send({ error: 'viewer', code: 'viewer' }) : notFound(reply)

/** The owner's design, for the routes that stay the owner's alone (rename, archive, agent, members). */
async function ownDesign(request: FastifyRequest): Promise<Design | null> {
  const a = await designAccess(request, { need: 'own' })
  return a && a !== VIEWER ? a.d : null
}

/** What the page shows a Virvi admin helping on someone else's design: whose it is. */
async function supportView(d: Design) {
  const [u] = await db.select({ displayName: users.displayName, email: users.email, isTrial: users.isTrial }).from(users).where(eq(users.id, d.ownerId))
  return { ownerId: d.ownerId, ownerName: u?.displayName ?? null, ownerEmail: u?.email ?? null, trial: !!u?.isTrial }
}

const OPEN_LIMIT = 'Your plan has no room for another open design. Designs with pieces left to finalize count as open: finalize or archive one to make room.'
const CATEGORY = /^[a-z_]{1,32}$/
const BAD_CATEGORIES = 'categories must be piece categories'

/**
 * A chosen set of pieces: a list in a body, or `a,b` in a query. Absent (or an empty query) is null, every piece;
 * undefined is a malformed one.
 */
function chosenCategories(raw: unknown, from: 'body' | 'query'): string[] | null | undefined {
  if (raw == null || (from === 'query' && raw === '')) return null
  const list = from === 'query' ? (typeof raw === 'string' ? raw.split(',') : null) : raw
  if (!Array.isArray(list) || !list.length || !list.every((c) => typeof c === 'string' && CATEGORY.test(c))) return undefined
  return [...new Set(list as string[])]
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
  if (await isTrialUser(userId)) return config.trialDesigns
  return (await getSubscription(userId)).limits.studioOpenDesigns
}

export default async function studioRoutes(app: FastifyInstance) {
  // Every customer route takes the studio scene's pass too (and no other scene pass).
  const routeConfig = { scenePass: STUDIO_ROUTE_SCENE_PASS }
  const auth = { preHandler: [authenticate, studioOn], config: routeConfig }
  const work = { preHandler: [authenticate, studioOn, notPaused], config: routeConfig }
  // The routes a signed-out trial visitor may use (`trial: true`); everything else answers them 403 account_required.
  const trialRoute = { scenePass: STUDIO_ROUTE_SCENE_PASS, trial: true as const }
  const trialAuth = { ...auth, config: trialRoute }
  const trialWork = { ...work, config: trialRoute }

  // Not behind notPaused: a paused account may still redeem. Guessing is slow: 10 tries an hour per account.
  app.post('/api/studio/gift-codes/redeem', {
    ...auth,
    config: { ...auth.config, rateLimit: { max: 10, timeWindow: '1 hour', hook: 'preHandler', keyGenerator: (r: FastifyRequest) => r.user.id } },
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

  app.get('/api/studio/usage', trialAuth, async (request) => {
    return { ...await usage(request.user.id, await openLimit(request.user.id), new Date()), paused: await isPaused(request.user.id) }
  })

  app.post('/api/studio/designs', trialWork, async (request, reply) => {
    const b = (request.body ?? {}) as { kind?: unknown; agent?: unknown; name?: unknown }
    const err = agentError(b.agent)
    if (err) return reply.status(400).send({ error: err })
    if (b.kind !== 'wearable' && b.kind !== 'emote' && b.kind !== 'scene') return reply.status(400).send({ error: 'kind must be wearable, emote or scene' })
    if (b.name !== undefined && (typeof b.name !== 'string' || !b.name.trim() || b.name.length > MAX_NAME)) {
      return reply.status(400).send({ error: `name must be 1-${MAX_NAME} characters` })
    }
    if (await isTrialUser(request.user.id)) {
      if ((await totalDesignCount(request.user.id)) >= config.trialDesigns) {
        recordTrialBlocked(request.user.id, 'more_designs')
        return reply.status(403).send({ error: 'account_required', action: 'more_designs' })
      }
    } else if ((await openDesignCount(request.user.id)) >= (await openLimit(request.user.id))) {
      return reply.status(403).send({ error: OPEN_LIMIT, code: 'open_design_limit' })
    }
    const [d] = await db.insert(studioDesigns).values({
      ownerId: request.user.id,
      name: typeof b.name === 'string' ? b.name.trim() : b.kind === 'emote' ? 'Untitled emote' : b.kind === 'scene' ? 'Untitled scene piece' : 'Untitled design',
      kind: b.kind,
      agent: b.agent as string,
    }).returning()
    return reply.status(201).send(publicDesign(d))
  })

  // The person's own designs and the ones shared with them (an open membership), each with their role; a shared one
  // names its owner. Shared designs are never the person's open or total designs (studio/designs.ts counts by owner).
  app.get('/api/studio/designs', trialAuth, async (request) => {
    const archived = (request.query as { archived?: string }).archived === 'true'
    const uid = request.user.id
    const shared = await db.select({ designId: studioDesignMembers.designId, role: studioDesignMembers.role }).from(studioDesignMembers)
      .where(and(eq(studioDesignMembers.userId, uid), isNull(studioDesignMembers.leftAt)))
    const roles = new Map(shared.map((m) => [m.designId, m.role as DesignRole]))
    const mine = eq(studioDesigns.ownerId, uid)
    const rows = await db.select().from(studioDesigns)
      .where(and(roles.size ? or(mine, inArray(studioDesigns.id, [...roles.keys()])) : mine,
        archived ? isNotNull(studioDesigns.archivedAt) : isNull(studioDesigns.archivedAt)))
      .orderBy(desc(studioDesigns.createdAt))
    const ownerIds = [...new Set(rows.filter((d) => d.ownerId !== uid).map((d) => d.ownerId))]
    const names = new Map(ownerIds.length
      ? (await db.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, ownerIds))).map((u) => [u.id, u.displayName])
      : [])
    return (await publicDesigns(rows)).map((p, i) => rows[i].ownerId === uid
      ? { ...p, role: 'owner' as const }
      : { ...p, role: roles.get(p.id)!, ownerName: names.get(rows[i].ownerId) ?? null })
  })

  app.get('/api/studio/designs/:id', trialAuth, async (request, reply) => {
    const a = await designAccess(request, { need: 'view', ...SUPPORT })
    if (!a || a === VIEWER) return refused(reply, a)
    // `role`: the reader's (null for support); `members`: everyone on it, the owner first. The ratings shown are the
    // reader's own; support sees the owner's.
    const detail = { ...await designDetail(a.d, new Date(), a.support ? a.d.ownerId : request.user.id), role: a.role, members: await designMembers(a.d.id) }
    return a.support ? { ...detail, support: await supportView(a.d) } : detail
  })

  app.patch('/api/studio/designs/:id', trialAuth, async (request, reply) => {
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
      if (!b.archived && d.archivedAt && !(await isTrialUser(request.user.id)) && (await openDesignCount(request.user.id)) >= (await openLimit(request.user.id))) {
        return reply.status(403).send({ error: OPEN_LIMIT, code: 'open_design_limit' })
      }
      set.archivedAt = b.archived ? (d.archivedAt ?? new Date()) : null
    }
    const [updated] = Object.keys(set).length
      ? await db.update(studioDesigns).set(set).where(eq(studioDesigns.id, d.id)).returning()
      : [d]
    return (await publicDesigns([updated]))[0]
  })

  app.post('/api/studio/designs/:id/prompts', trialWork, async (request, reply) => {
    const a = await designAccess(request, { need: 'work', ...SUPPORT })
    if (!a || a === VIEWER) return refused(reply, a)
    const d = a.d
    const byAdminId = a.support ? request.user.id : undefined
    const b = (request.body ?? {}) as { text?: unknown; selectedSlots?: unknown; continue?: unknown; fixChecks?: unknown; ideaId?: unknown }
    // The example prompt the words came from: one of this kind's ideas. It only says what to retire, never reaches the agent
    if (b.ideaId != null && (typeof b.ideaId !== 'string' || findIdea(b.ideaId)?.kind !== d.kind)) {
      return reply.status(400).send({ error: 'ideaId must be one of the example prompts for this kind' })
    }
    const cont = b.continue === true
    const fixChecks = b.fixChecks === true
    if (fixChecks) {
      const r = await queuePrompt(d, { text: null, selectedSlots: null, continue: false, fixChecks: true, byAdminId, senderId: request.user.id }, new Date())
      if (!r.ok) return reply.status(r.status).send(r.body)
      return reply.status(202).send({ jobId: r.jobId })
    }
    if (!cont && (typeof b.text !== 'string' || !ownerWords(b.text) || b.text.length > MAX_PROMPT)) {
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
    const ideaId = !cont && typeof b.ideaId === 'string' ? b.ideaId : undefined
    const r = await queuePrompt(d, { text: cont ? null : (b.text as string).trim(), selectedSlots: slots, continue: cont, byAdminId, ideaId, senderId: request.user.id }, new Date())
    if (!r.ok) return reply.status(r.status).send(r.body)
    return reply.status(202).send({ jobId: r.jobId })
  })

  // Example prompts for the first message, following the chips, from the ideas nobody has used yet (prompt-ideas.ts).
  // Who may read them is who may send a prompt. `exclude`: the ids the viewer already saw this visit.
  app.get('/api/studio/designs/:id/prompt-ideas', trialAuth, async (request, reply) => {
    const a = await designAccess(request, { need: 'work', ...SUPPORT })
    if (!a || a === VIEWER) return refused(reply, a)
    const q = request.query as { count?: string; exclude?: string; slots?: string; mode?: string; move?: string; playback?: string }
    const count = q.count == null ? 3 : Number(q.count)
    if (!Number.isInteger(count) || count < 1 || count > IDEAS_COUNT_MAX) return reply.status(400).send({ error: `count must be 1-${IDEAS_COUNT_MAX}` })
    const list = (raw: string | undefined) => (raw ? raw.split(',') : [])
    const slots = list(q.slots)
    if (!slots.every((s) => (WEARABLE_CATEGORIES as readonly string[]).includes(s))) return reply.status(400).send({ error: 'slots must be wearable categories' })
    if (q.mode != null && !['slots', 'outfit', 'unsure'].includes(q.mode)) return reply.status(400).send({ error: 'mode must be slots, outfit or unsure' })
    if (q.move && !(IDEA_MOVES as readonly string[]).includes(q.move)) return reply.status(400).send({ error: `move must be ${IDEA_MOVES.join(', ')}` })
    if (q.playback && !(IDEA_PLAYBACKS as readonly string[]).includes(q.playback)) return reply.status(400).send({ error: 'playback must be loop or once' })
    const kind = a.d.kind
    if (kind !== 'wearable' && kind !== 'emote') return { ideas: [], more: false }
    const query: IdeaQuery = kind === 'wearable'
      ? { kind, mode: (q.mode as 'slots' | 'outfit' | 'unsure' | undefined) ?? 'slots', slots: [...new Set(slots)] }
      : { kind, move: (q.move || null) as IdeaMove | null, playback: (q.playback || null) as IdeaPlayback | null }
    // The latest ids when past the cap; anything that isn't an id can't match one, so it is dropped
    const exclude = new Set(list(q.exclude).filter((id) => IDEA_ID.test(id)).slice(-EXCLUDE_MAX))
    const r = pickIdeas(query, { retired: await retiredIdeas(), exclude, count })
    return { ideas: r.ideas.map((i) => ({ id: i.id, text: i.text })), more: r.more }
  })

  // "Improve my prompt": a rewrite of the draft and a few quick-pick questions, never sent to the agent. Who may use it
  // is who may send a prompt (support too); it has its own daily limit per account, apart from the prompt allowance.
  app.post('/api/studio/designs/:id/prompt-help', trialWork, async (request, reply) => {
    const a = await designAccess(request, { need: 'work', ...SUPPORT })
    if (!a || a === VIEWER) return refused(reply, a)
    const b = (request.body ?? {}) as { text?: unknown; selectedSlots?: unknown; answers?: unknown }
    if (typeof b.text !== 'string' || !ownerWords(b.text) || b.text.length > MAX_PROMPT) {
      return reply.status(400).send({ error: `text must be 1-${MAX_PROMPT} characters` })
    }
    let slots: string[] | null = null
    if (b.selectedSlots != null) {
      if (a.d.kind !== 'wearable') return reply.status(400).send({ error: 'only a wearable design has slots' })
      if (!Array.isArray(b.selectedSlots) || !b.selectedSlots.length
        || !b.selectedSlots.every((s) => (WEARABLE_CATEGORIES as readonly string[]).includes(s))) {
        return reply.status(400).send({ error: 'selectedSlots must be wearable categories' })
      }
      slots = [...new Set(b.selectedSlots as string[])]
    }
    let answers: Record<string, string> | null = null
    if (b.answers != null) {
      const entries = typeof b.answers === 'object' && !Array.isArray(b.answers) ? Object.entries(b.answers as object) : null
      if (!entries || entries.length > HELP_ANSWERS_MAX
        || !entries.every(([k, v]) => HELP_ANSWER_ID.test(k) && typeof v === 'string' && v.trim() && v.length <= HELP_ANSWER_MAX)) {
        return reply.status(400).send({ error: `answers must be at most ${HELP_ANSWERS_MAX} short answers` })
      }
      answers = Object.fromEntries(entries.map(([k, v]) => [k, (v as string).trim()]))
    }
    try {
      return await helpWithPrompt(request.user.id, { kind: a.d.kind as 'wearable' | 'emote' | 'scene', text: ownerWords(b.text), selectedSlots: slots, answers }, new Date())
    } catch (err) {
      if (err instanceof PromptHelpError) return reply.status(err.status).send({ error: err.code })
      throw err
    }
  })

  // Starting the design's machine while the person writes a prompt (studio/warm.ts): who may is who may send one. It
  // answers 204 whether it warmed or there was no point, so the page never shows anything for it.
  app.post('/api/studio/designs/:id/warm', trialWork, async (request, reply) => {
    const a = await designAccess(request, { need: 'work', ...SUPPORT })
    if (!a || a === VIEWER) return refused(reply, a)
    await warmDesign(a.d, { support: a.support, userId: request.user.id }, new Date())
    return reply.status(204).send()
  })

  // 👍 / 👎 on a revision (an agent reply that changed pieces, named by its job): by the owner or a collaborator, each
  // their own. Support sees the
  // ratings in the design detail but doesn't rate (LIV-142).
  app.put('/api/studio/designs/:id/revisions/:jobId/rating', trialAuth, async (request, reply) => {
    const a = await designAccess(request, { need: 'work' })
    if (!a || a === VIEWER) return refused(reply, a)
    const d = a.d
    const { jobId } = request.params as { jobId: string }
    if (!UUID.test(jobId)) return notFound(reply)
    const input = parseRating(request.body)
    if (typeof input === 'string') return reply.status(400).send({ error: input })
    const r = await rateRevision(d, jobId, request.user.id, input, new Date())
    return r ?? reply.status(404).send({ error: 'revision_not_found' })
  })

  app.delete('/api/studio/designs/:id/revisions/:jobId/rating', trialAuth, async (request, reply) => {
    const a = await designAccess(request, { need: 'work' })
    if (!a || a === VIEWER) return refused(reply, a)
    const d = a.d
    const { jobId } = request.params as { jobId: string }
    if (!UUID.test(jobId)) return notFound(reply)
    if (!(await clearRating(d.id, jobId, request.user.id))) return reply.status(404).send({ error: 'revision_not_found' })
    return reply.status(204).send()
  })

  // "Try again with this feedback": a 👎'd revision's one free prompt, built from its tags and note
  app.post('/api/studio/designs/:id/revisions/:jobId/try-again', trialWork, async (request, reply) => {
    const a = await designAccess(request, { need: 'work' })
    if (!a || a === VIEWER) return refused(reply, a)
    const d = a.d
    const { jobId } = request.params as { jobId: string }
    if (!UUID.test(jobId)) return notFound(reply)
    const rev = await findRevision(d.id, jobId)
    if (!rev) return reply.status(404).send({ error: 'revision_not_found' })
    const down = await downRating(jobId, request.user.id)
    if (!down) return reply.status(409).send({ error: 'not_rated_down', code: 'not_rated_down' })
    const text = feedbackText(rev.names, down.tags as RatingTag[], down.note)
    const r = await queuePrompt(d, { text, selectedSlots: null, continue: false, feedbackFor: jobId, senderId: request.user.id }, new Date())
    if (!r.ok) return reply.status(r.status).send(r.body)
    return reply.status(202).send({ jobId: r.jobId })
  })

  // The agent a new design of each kind starts on, when an admin set one (null: the page's own default)
  app.get('/api/studio/defaults', trialAuth, async () => ({ agents: await kindDefaults() }))

  app.get('/api/studio/designs/:id/finalize', trialAuth, async (request, reply) => {
    // Support's quote is an admin's: every line free
    const a = await designAccess(request, { need: 'work', ...SUPPORT })
    if (!a || a === VIEWER) return refused(reply, a)
    const d = a.d
    // The dialog re-quotes as pieces are ticked: the total, free finalizes and first-piece prices are the server's
    const categories = chosenCategories((request.query as { categories?: unknown }).categories, 'query')
    if (categories === undefined) return reply.status(400).send({ error: BAD_CATEGORIES })
    try {
      const admin = await isVirviAdmin(request.user.id)
      const now = new Date()
      return await quoteFinalize(d, categories, [], admin ? 0 : await giftsFor(request.user.id, d.id, now), undefined,
        { admin, credit: admin ? 0 : await creditFor(request.user.id, d.id, now) })
    } catch (err) {
      if (err instanceof QuoteError) return quoteRefusal(reply, err)
      throw err
    }
  })

  app.post('/api/studio/designs/:id/finalize', auth, async (request, reply) => {
    const a = await designAccess(request, { need: 'work', ...SUPPORT })
    if (!a || a === VIEWER) return refused(reply, a)
    const d = a.d
    const b = (request.body ?? {}) as { categories?: unknown; reports?: unknown; method?: unknown }
    if (a.support) {
      // A Virvi admin finalizing for the owner: free, granted at once, the owner's as if they had paid
      const chosen = chosenCategories(b.categories, 'body')
      if (chosen === undefined) return reply.status(400).send({ error: BAD_CATEGORIES })
      try {
        return await createFinalizeCheckout(d, { id: d.ownerId, email: null }, chosen, {}, new Date(), 'card', { byAdminId: request.user.id })
      } catch (err) {
        return checkoutRefusal(reply, err)
      }
    }
    const method = checkoutMethod(b.method)
    if (!method) return reply.status(400).send({ error: "method must be 'card' or 'mana'" })
    // an admin's finalize is granted without Stripe, and MANA doesn't use Stripe, so neither waits on it being set up
    if (method === 'card' && !config.stripeSecretKey && !(await isVirviAdmin(request.user.id))) return paymentsOff(reply)
    const categories = chosenCategories(b.categories, 'body')
    if (categories === undefined) return reply.status(400).send({ error: BAD_CATEGORIES })
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
      return await createFinalizeCheckout(d, { id: request.user.id, email: request.user.email ?? null }, categories, reports, new Date(), method)
    } catch (err) {
      return checkoutRefusal(reply, err)
    }
  })

  app.post('/api/studio/designs/:id/pieces/:category/revisions/:number/report', trialAuth, async (request, reply) => {
    const a = await designAccess(request, { need: 'work' })
    if (!a || a === VIEWER) return refused(reply, a)
    const d = a.d
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
  async function paidRevision(request: FastifyRequest, reply: FastifyReply, need: Need) {
    const a = await designAccess(request, { need, ...SUPPORT })
    if (!a || a === VIEWER) return void refused(reply, a)
    const d = a.d
    const { category, number } = request.params as { category: string; number: string }
    if (!/^[a-z_]{1,32}$/.test(category) || !/^[1-9][0-9]{0,5}$/.test(number)) return void reply.status(400).send({ error: 'unknown revision' })
    const found = await entitlementFor(d.id, category, Number(number))
    if (!found) return void reply.status(402).send({ error: 'This revision has not been paid for', code: 'not_paid' })
    return { d, ...found }
  }

  // "Download all": every piece's newest ready package in one zip, to anyone on the design. With the route below, the only ways
  // a model file leaves.
  app.get('/api/studio/designs/:id/packages', auth, async (request, reply) => {
    const a = await designAccess(request, { need: 'view', ...SUPPORT })
    if (!a || a === VIEWER) return refused(reply, a)
    const d = a.d
    const ready = await readyPackages(d.id)
    if (!ready.length) return reply.status(409).send({ error: 'nothing_ready', code: 'nothing_ready' })
    const files: { name: string; data: Buffer }[] = []
    let total = 0
    for (const p of ready) {
      const obj = await getStudioStore().get(p.packageKey)
      if (!obj) return reply.status(404).send({ error: 'package_missing', code: 'package_missing' })
      total += obj.body.length
      if (total > DOWNLOAD_ALL_MAX_BYTES) return reply.status(413).send({ error: 'too_large', code: 'too_large' })
      // Two pieces can share a name; the category keeps their files apart
      const base = slugOf(p.name, p.category)
      const name = files.some((f) => f.name.startsWith(`${base}-r`)) ? `${base}-${p.category.replace(/_/g, '-')}` : base
      files.push({ name: `${name}-r${p.number}.zip`, data: obj.body })
    }
    const zip = storedZip(files)
    return reply
      .type('application/zip')
      .header('Content-Length', zip.length)
      .header('Content-Disposition', `attachment; filename="${slugOf(d.name, 'design')}.zip"`)
      .header('Cache-Control', 'private, no-store')
      .send(zip)
  })

  // The paid revision's package, to anyone on the design
  app.get('/api/studio/designs/:id/pieces/:category/revisions/:number/package', auth, async (request, reply) => {
    const paid = await paidRevision(request, reply, 'view')
    if (!paid) return reply
    const { e, name } = paid
    if (e.status !== 'ready' || !e.packageKey) return reply.status(409).send({ error: e.status, code: e.status })
    const obj = await getStudioStore().getStream(e.packageKey)
    if (!obj) return reply.status(404).send({ error: 'package_missing', code: 'package_missing' })
    const slug = slugOf(name, e.category)
    const { number } = request.params as { number: string }
    if (obj.length !== undefined) reply.header('Content-Length', obj.length)
    return reply
      .type('application/zip')
      .header('Content-Disposition', `attachment; filename="${slug}-r${number}.zip"`)
      .header('Cache-Control', 'private, no-store')
      .send(obj.body)
  })

  app.post('/api/studio/designs/:id/pieces/:category/revisions/:number/package/retry', auth, async (request, reply) => {
    const paid = await paidRevision(request, reply, 'work')
    if (!paid) return reply
    if (paid.e.status !== 'failed') return reply.status(409).send({ error: 'not_failed', code: 'not_failed' })
    const [jobId] = await queueFinalize(paid.d.id, [paid.e.id], new Date())
    return reply.status(202).send({ jobId })
  })

  app.post('/api/studio/topups', work, async (request, reply) => {
    const b = (request.body ?? {}) as { packs?: unknown; method?: unknown }
    const method = checkoutMethod(b.method)
    if (!method) return reply.status(400).send({ error: "method must be 'card' or 'mana'" })
    if (method === 'card' && !config.stripeSecretKey) return paymentsOff(reply)
    const packs = b.packs ?? 1
    if (!Number.isInteger(packs) || (packs as number) < 1 || (packs as number) > MAX_PACKS) {
      return reply.status(400).send({ error: `packs must be 1-${MAX_PACKS}` })
    }
    try {
      return await createTopupCheckout({ id: request.user.id, email: request.user.email ?? null }, packs as number, new Date(), method)
    } catch (err) {
      return checkoutRefusal(reply, err)
    }
  })

  // A payment's state, for the page to poll while a MANA transaction confirms
  app.get('/api/studio/payments/:paymentId', auth, async (request, reply) => {
    const id = (request.params as { paymentId: string }).paymentId
    const [pay] = UUID.test(id)
      ? await db.select({
        status: studioPayments.status, method: studioPayments.method, expiresAt: studioPayments.expiresAt, manaTxHash: studioPayments.manaTxHash,
      }).from(studioPayments).where(and(eq(studioPayments.id, id), eq(studioPayments.userId, request.user.id)))
      : []
    if (!pay) return reply.status(404).send({ error: 'not_found', code: 'not_found' })
    return pay
  })

  // The customer's page reports the transaction that pays a MANA payment
  app.post('/api/studio/payments/:paymentId/mana-tx', auth, async (request, reply) => {
    const id = (request.params as { paymentId: string }).paymentId
    if (!UUID.test(id)) return reply.status(404).send({ error: 'not_found', code: 'not_found' })
    const txHash = ((request.body ?? {}) as { txHash?: unknown }).txHash
    if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return reply.status(400).send({ error: 'txHash must be a 0x-prefixed 32-byte hex transaction hash' })
    }
    try {
      return await reportManaTx(request.user.id, id, txHash, new Date())
    } catch (err) {
      return checkoutRefusal(reply, err)
    }
  })

  // A refunded mistake report's MANA share, asked back as MANA (the owner sends it by hand). Not behind notPaused:
  // a paused account may still have its money back.
  app.post('/api/studio/mana-refunds', auth, async (request, reply) => {
    const reportId = ((request.body ?? {}) as { reportId?: unknown }).reportId
    if (typeof reportId !== 'string' || !UUID.test(reportId)) return reply.status(400).send({ error: 'reportId must be a report id' })
    try {
      return reply.status(201).send(await requestManaRefund(request.user.id, reportId, new Date()))
    } catch (err) {
      return checkoutRefusal(reply, err)
    }
  })

  // Files for the agent: the body is the file's bytes, whatever type the browser says (its bytes decide)
  await app.register(async (files) => {
    files.removeAllContentTypeParsers()
    files.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: UPLOAD_LIMITS.modelBytes + 1024 }, (_req, body, done) => done(null, body))
    files.post('/api/studio/designs/:id/uploads', { ...trialWork, bodyLimit: UPLOAD_LIMITS.modelBytes + 1024 }, async (request, reply) => {
      const a = await designAccess(request, { need: 'work' })
      if (!a || a === VIEWER) return refused(reply, a)
      const d = a.d
      const name = (request.query as { name?: unknown }).name
      // A trial's files total TRIAL_UPLOAD_BYTES across all its designs; more takes an account
      if (request.user.trial) {
        const [used] = await db.select({ bytes: sql<number>`coalesce(sum(${studioUploads.size}), 0)::int` }).from(studioUploads)
          .innerJoin(studioDesigns, eq(studioDesigns.id, studioUploads.designId)).where(eq(studioDesigns.ownerId, request.user.id))
        const incoming = Buffer.isBuffer(request.body) ? request.body.length : 0
        if ((used?.bytes ?? 0) + incoming > config.trialUploadBytes) {
          recordTrialBlocked(request.user.id, 'upload_more')
          return reply.status(403).send({ error: 'account_required', action: 'upload_more' })
        }
      }
      try {
        return reply.status(201).send(await addUpload(d, typeof name === 'string' ? name : '', Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0)))
      } catch (err) {
        if (err instanceof UploadError) return reply.status(err.status).send({ error: err.code, code: err.code })
        throw err
      }
    })
  })

  app.get('/api/studio/designs/:id/uploads/:uploadId', trialAuth, async (request, reply) => {
    const a = await designAccess(request, { need: 'view', ...SUPPORT })
    if (!a || a === VIEWER) return refused(reply, a)
    const uploadId = (request.params as { uploadId: string }).uploadId
    const u = UUID.test(uploadId) ? await findUpload(a.d.id, uploadId) : null
    const obj = u ? await getStudioStore().get(uploadKey(u.designId, u.id)) : null
    if (!u || !obj) return reply.status(404).send({ error: 'upload_not_found' })
    return reply.type(u.contentType).header('Cache-Control', 'private, max-age=3600').header('X-Content-Type-Options', 'nosniff').send(obj.body)
  })

  app.delete('/api/studio/designs/:id/uploads/:uploadId', trialAuth, async (request, reply) => {
    const a = await designAccess(request, { need: 'work' })
    if (!a || a === VIEWER) return refused(reply, a)
    const uploadId = (request.params as { uploadId: string }).uploadId
    if (!UUID.test(uploadId) || !(await deleteUpload(a.d.id, uploadId))) return reply.status(404).send({ error: 'upload_not_found' })
    return reply.status(204).send()
  })

  app.post('/api/studio/designs/:id/renders', trialWork, async (request, reply) => {
    const a = await designAccess(request, { need: 'work', ...SUPPORT })
    if (!a || a === VIEWER) return refused(reply, a)
    const d = a.d
    const b = (request.body ?? {}) as { category?: unknown; bodyShape?: unknown; outfit?: unknown; emote?: unknown; mode?: unknown }
    if (d.kind === 'scene') {
      // Inspect for any scene piece; the scale turn for furniture (a building has the walk-through instead)
      if (typeof b.category !== 'string' || !SCENE_CATEGORY.test(b.category)) return reply.status(400).send({ error: 'unknown category' })
      if (b.mode !== 'orbit' && !(b.mode === 'scale' && isFurniture(b.category))) return reply.status(400).send({ error: 'unknown mode' })
      const r = b.mode === 'orbit'
        ? await requestOrbit(d, b.category, 'male', new Date())
        : await requestRender(d, b.category, TOUR_VIEW, new Date())
      return r ?? reply.status(404).send({ error: 'piece_not_found' })
    }
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
  app.post('/api/studio/designs/:id/set-renders', trialWork, async (request, reply) => {
    const a = await designAccess(request, { need: 'work', ...SUPPORT })
    if (!a || a === VIEWER) return refused(reply, a)
    const d = a.d
    const b = (request.body ?? {}) as { bodyShape?: unknown; outfit?: unknown; emote?: unknown; categories?: unknown }
    if (d.kind === 'scene') {  // the building's walk-through, the one design-level view a scene design has
      if (!(await hasBuilding(d.id))) return reply.status(404).send({ error: 'no_building' })
      const r = await requestSetRender(d, TOUR_VIEW, new Date())
      if (!r) return reply.status(404).send({ error: 'piece_not_found' })
      return r.status === 'queued' ? { status: 'queued' } : r
    }
    if (!(BODY_SHAPES as readonly unknown[]).includes(b.bodyShape)) return reply.status(400).send({ error: 'bodyShape must be male or female' })
    if (!(OUTFITS as readonly unknown[]).includes(b.outfit)) return reply.status(400).send({ error: 'unknown outfit' })
    const emote = b.emote ?? null
    if (d.kind === 'emote' ? emote !== null : !(BASE_EMOTES as readonly unknown[]).includes(emote)) {
      return reply.status(400).send({ error: 'unknown emote' })
    }
    // Finalize's selection: only the chosen and finalized pieces are worn
    const categories = chosenCategories(b.categories, 'body')
    if (categories === undefined) return reply.status(400).send({ error: BAD_CATEGORIES })
    const r = await requestSetRender(d, { bodyShape: b.bodyShape, outfit: b.outfit, emote } as View, new Date(), { categories })
    if (!r) return reply.status(404).send({ error: 'piece_not_found' })
    return r.status === 'queued' ? { status: 'queued' } : r
  })

  /** An emote named in a check or report: a base emote for a wearable design, `own` (or null) for an emote design. */
  const checkedEmote = (d: Design, emote: unknown): string | null =>
    d.kind === 'emote' ? (emote == null || emote === OWN_EMOTE ? OWN_EMOTE : null)
      : emotesFor(d.kind).includes(emote as string) ? emote as string : null

  app.post('/api/studio/designs/:id/emote-checks', trialWork, async (request, reply) => {
    const a = await designAccess(request, { need: 'work', ...SUPPORT })
    if (!a || a === VIEWER) return refused(reply, a)
    const d = a.d
    const b = (request.body ?? {}) as { emote?: unknown; bodyShape?: unknown; state?: unknown; categories?: unknown }
    const emote = checkedEmote(d, b.emote)
    if (!emote) return reply.status(400).send({ error: 'unknown emote' })
    if (!(BODY_SHAPES as readonly unknown[]).includes(b.bodyShape)) return reply.status(400).send({ error: 'bodyShape must be male or female' })
    // Clipping is reported through /clipping, which also queues the fix
    if (b.state !== 'fine') return reply.status(400).send({ error: 'state must be fine' })
    const categories = chosenCategories(b.categories, 'body')
    if (categories === undefined) return reply.status(400).send({ error: BAD_CATEGORIES })
    const { revisions } = await wornRevisions(d.id, categories)
    if (!revisions) return reply.status(404).send({ error: 'piece_not_found' })
    await recordCheck(d.id, revisions, emote, b.bodyShape as string, 'fine')
    return reply.status(204).send()
  })

  // "I see clipping": a free fix in the server's words, for an emote view the person has seen
  app.post('/api/studio/designs/:id/clipping', trialWork, async (request, reply) => {
    const a = await designAccess(request, { need: 'work', ...SUPPORT })
    if (!a || a === VIEWER) return refused(reply, a)
    const d = a.d
    const b = (request.body ?? {}) as { emote?: unknown; bodyShape?: unknown; outfit?: unknown; categories?: unknown }
    const emote = checkedEmote(d, b.emote)
    if (!emote) return reply.status(400).send({ error: 'unknown emote' })
    if (!(BODY_SHAPES as readonly unknown[]).includes(b.bodyShape)) return reply.status(400).send({ error: 'bodyShape must be male or female' })
    if (!(OUTFITS as readonly unknown[]).includes(b.outfit)) return reply.status(400).send({ error: 'unknown outfit' })
    const chosen = chosenCategories(b.categories, 'body')
    if (chosen === undefined) return reply.status(400).send({ error: BAD_CATEGORIES })
    // The view seen was Finalize's selection: the fix looks at the same pieces worn
    const { revisions, categories } = await wornRevisions(d.id, chosen)
    const fix: FixClipping = { emote, bodyShape: b.bodyShape as View['bodyShape'], outfit: b.outfit as View['outfit'], ...(categories ? { categories } : {}) }
    const key = setViewKey(d.kind, { bodyShape: fix.bodyShape, outfit: fix.outfit, emote: d.kind === 'emote' ? null : emote } as View)
    const [seen] = revisions ? await db.select({ id: studioSetRenders.id }).from(studioSetRenders).where(and(
      eq(studioSetRenders.designId, d.id), eq(studioSetRenders.revisions, revisions), eq(studioSetRenders.viewKey, key),
      eq(studioSetRenders.status, 'ready'))) : []
    if (!seen) return reply.status(409).send({ error: 'not_seen', code: 'not_seen' })
    if (await freeFixesLeft(d.id, emote) <= 0) return reply.status(409).send({ error: 'clipping_fix_limit', code: 'clipping_fix_limit' })
    const r = await queuePrompt(d, { text: null, selectedSlots: null, continue: false, fixClipping: fix, byAdminId: a.support ? request.user.id : undefined, senderId: request.user.id }, new Date())
    if (!r.ok) return reply.status(r.status).send(r.body)
    await recordCheck(d.id, revisions, emote, fix.bodyShape, 'clipping')
    return reply.status(202).send({ jobId: r.jobId })
  })

  // Opening Finalize: every emote on both bodies, so the checklist fills while the person looks
  app.post('/api/studio/designs/:id/finalize-renders', work, async (request, reply) => {
    const a = await designAccess(request, { need: 'work', ...SUPPORT })
    if (!a || a === VIEWER) return refused(reply, a)
    const d = a.d
    const categories = chosenCategories((request.body as { categories?: unknown } | null)?.categories, 'body')
    if (categories === undefined) return reply.status(400).send({ error: BAD_CATEGORIES })
    return { queued: await queueFinalizeRenders(d, new Date(), categories) }
  })

  // The emote step for Finalize's selection (`?categories=a,b`): views and checks of the chosen and finalized pieces
  // worn together. Without it, the whole set's, as the design detail has it.
  app.get('/api/studio/designs/:id/set', trialAuth, async (request, reply) => {
    const a = await designAccess(request, { need: 'view', ...SUPPORT })
    if (!a || a === VIEWER) return refused(reply, a)
    const d = a.d
    const categories = chosenCategories((request.query as { categories?: unknown }).categories, 'query')
    if (categories === undefined) return reply.status(400).send({ error: BAD_CATEGORIES })
    return setDetail(d, new Date(), undefined, categories)
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
