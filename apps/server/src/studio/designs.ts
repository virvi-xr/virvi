import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { listUploads, publicUpload, uploadPaths } from './uploads.js'
import { db } from '../db/connection.js'
import { studioDesigns, studioFinalizeCredits, studioJobs, studioPayments, studioMessages, studioPieces, studioRenders, studioRevisions } from '../db/schema.js'
import { config } from '../config.js'
import { reservePrompt, promptStatus, TRIAL_DAY } from './quota.js'
import { recordTrialEvent, recordTrialBlocked } from '../auth/trial-events.js'
import { ensureWorker } from './machines.js'
import { failJobs } from './results.js'
import { publishStudio } from './events.js'
import { signRenderFrame, frameUrlExpiry } from './render-urls.js'
import { finalizedRevisions } from './payments.js'
import { creditBalance } from './credit.js'
import type { Exec } from './quota.js'
import { setDetail } from './sets.js'
import { SCENE_ORBIT_KEY, SCENE_PROMPT_LIMITS, SCALE_KEY, TOUR_KEY } from './scene.js'
import { designRevisions } from './ratings.js'

/** What the dashboard's studio routes share: limits, view keys, the design detail, and queuing prompts and renders. */

export type Design = typeof studioDesigns.$inferSelect
export type View = { bodyShape: 'male' | 'female'; outfit: 'default' | 'outfit-2' | 'outfit-3'; emote: null | typeof BASE_EMOTES[number] }

export const PROMPT_LIMITS = { timeoutSec: 1500, maxTurns: 80, costCeilingUsd: 3 }
/** The outcomes a free Continue may follow: the agent stopped at a limit with its work in hand. */
export const CONTINUABLE = ['ceiling', 'turns']

export function modelFor(agent: string): string {
  return agent === 'codex' ? config.studioCodexModel : agent === 'grok' ? config.studioGrokModel : config.studioClaudeModel
}

/** Grok counts each tool call as a turn, so it gets more of them. */
export function promptLimits(agent: string, kind = 'wearable'): typeof PROMPT_LIMITS {
  if (kind === 'scene') return SCENE_PROMPT_LIMITS
  return agent === 'grok' ? { ...PROMPT_LIMITS, maxTurns: 150 } : PROMPT_LIMITS
}
export const RENDER_LIMITS = { timeoutSec: 300, maxTurns: 80, costCeilingUsd: 3 }
export const CONTINUE_TEXT = 'Continue where you stopped.'
/** What the agent sees before a Virvi admin's own words, so it knows support wrote them, not the designer. */
export const SUPPORT_PREFIX = '[Virvi support] '
const TYPED_PREFIX = /^(\s*\[\s*virvi\s+support\s*\]\s*)+/i
/** An owner's words as the agent gets them: a "[Virvi support]" they typed at the start is dropped, so only support's prompts carry it. */
export const ownerWords = (text: string) => text.replace(TYPED_PREFIX, '').trim()
export const START_FAILED = 'The studio machine could not start.'
export const fixChecksText = (categories: string[]) =>
  `Fix every FAIL the checker reported for: ${categories.join(', ')}. Change nothing else.`

/** `categories`: the pieces worn in the view the person saw, when it was Finalize's selection (sets.ts wornRevisions). */
export type FixClipping = { emote: string; bodyShape: View['bodyShape']; outfit: View['outfit']; categories?: string[] }
const OUTFIT_LABELS: Record<string, string> = { default: 'default', 'outfit-2': 'outfit 2', 'outfit-3': 'outfit 3' }
/** What the person's clipping report says in the conversation. */
export const clippingText = (kind: string, f: FixClipping) =>
  `It clips in the ${kind === 'emote' ? 'emote' : f.emote} (${f.bodyShape}, ${OUTFIT_LABELS[f.outfit]} outfit). Please fix it.`
/** What the agent is told: only what passes through, nothing else. */
export const clippingInstruction = (kind: string, f: FixClipping) => kind === 'emote'
  ? `Fix the clipping in the emote on the ${f.bodyShape} body with the ${OUTFIT_LABELS[f.outfit]} outfit: find where the arms, hands or props pass through the body or the base outfit’s clothes, and change only the parts of the animation that do. Change nothing else.`
  : `Fix the clipping in the ${f.emote} emote on the ${f.bodyShape} body with the ${OUTFIT_LABELS[f.outfit]} outfit: find which piece passes through the body, the base outfit’s clothes or another piece, and change only the parts that do. Change nothing else.`

export const WEARABLE_CATEGORIES = [
  'eyebrows', 'eyes', 'facial_hair', 'hair', 'mouth', 'upper_body', 'lower_body', 'feet', 'earring', 'eyewear', 'hat',
  'helmet', 'mask', 'tiara', 'top_head', 'hands_wear', 'skin',
] as const
export const BODY_SHAPES = ['male', 'female'] as const
export const OUTFITS = ['default', 'outfit-2', 'outfit-3'] as const
export const BASE_EMOTES = ['idle', 'wave', 'dance', 'clap', 'walk', 'run', 'jump'] as const
/** An emote design's emote view plays its own animation. */
export const OWN_EMOTE = 'own'
/** Inspect's frames: the eye-level ring, then the whole sphere (CONTRACT.md, `orbit-<bodyShape>`). */
export const ORBIT_RING = 24
export const ORBIT_FRAMES = 122

/** The contract's view key, `<mode>-<bodyShape>-<outfit>[-<emote>]`: the one place it is made. */
export function viewKey(kind: string, view: View): string {
  if (kind === 'scene') return SCALE_KEY
  return `${kind === 'emote' ? 'emote' : 'spin'}-${view.bodyShape}-${view.outfit}${view.emote ? `-${view.emote}` : ''}`
}

export const orbitKey = (bodyShape: View['bodyShape']) => `orbit-${bodyShape}`
/** Inspect's view key: a scene piece has no body shape. */
export const orbitKeyFor = (kind: string, bodyShape: View['bodyShape']) => kind === 'scene' ? SCENE_ORBIT_KEY : orbitKey(bodyShape)

/** An emote view with every piece worn: `walk-<bodyShape>-<outfit>-<emote>`, `own` for an emote design. */
export function setViewKey(kind: string, view: View): string {
  if (kind === 'scene') return TOUR_KEY
  return `walk-${view.bodyShape}-${view.outfit}-${kind === 'emote' ? OWN_EMOTE : view.emote}`
}

/** The set of piece revisions a design-level view belongs to: the latest revision ids, sorted and joined. */
export function revisionsKey(pieces: { latestRevisionId: string | null }[]): string {
  return pieces.map((p) => p.latestRevisionId).filter((x): x is string => !!x).sort().join(',')
}

/**
 * How far a design is finalized: `pieceCount` pieces have a revision, `finalizedPieces` of them have been paid for at
 * some revision (a later revision of a finalized piece keeps it finalized). `finalizedAt` is when the first was.
 */
export type FinalizedCount = { finalizedPieces: number; pieceCount: number }
const NONE: FinalizedCount = { finalizedPieces: 0, pieceCount: 0 }

export function publicDesign(d: Design, counts: FinalizedCount = NONE) {
  return {
    id: d.id, name: d.name, kind: d.kind, agent: d.agent, status: d.status, archivedAt: d.archivedAt, lastJobAt: d.lastJobAt,
    finalizedAt: d.finalizedAt, finalizedPieces: counts.finalizedPieces, pieceCount: counts.pieceCount, createdAt: d.createdAt,
  }
}

/** Each design's FinalizedCount, in one query. */
export async function finalizedCounts(designIds: string[], exec: Exec = db): Promise<Map<string, FinalizedCount>> {
  if (!designIds.length) return new Map()
  const rows = await exec.select({
    designId: studioPieces.designId,
    pieceCount: sql<number>`count(*)::int`,
    finalizedPieces: sql<number>`count(*) FILTER (WHERE EXISTS (SELECT 1 FROM studio_entitlements e
      WHERE e.design_id = studio_pieces.design_id AND e.category = studio_pieces.category))::int`,
  }).from(studioPieces)
    .where(and(inArray(studioPieces.designId, designIds), isNotNull(studioPieces.latestRevisionId)))
    .groupBy(studioPieces.designId)
  return new Map(rows.map((r) => [r.designId, { finalizedPieces: r.finalizedPieces, pieceCount: r.pieceCount }]))
}

/** publicDesign for each design, with how far it is finalized. */
export async function publicDesigns(rows: Design[]) {
  const counts = await finalizedCounts(rows.map((d) => d.id))
  return rows.map((d) => publicDesign(d, counts.get(d.id)))
}

/**
 * Closed: paid for (finalizedAt) with no piece left that could be finalized now. A piece counts once it is finalized
 * at some revision; one the checker blocks, or with no revision yet, can't be paid for, so it doesn't hold the design
 * open (everything ticked closes a design as it always did). A partly finalized design with payable pieces left is
 * still open (LIV-81: it counts toward the open-design limit).
 */
const fullyFinalized = sql`(studio_designs.finalized_at IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM studio_pieces p JOIN studio_revisions r ON r.id = p.latest_revision_id
  WHERE p.design_id = studio_designs.id AND (r.checker->>'pass') IS DISTINCT FROM 'false'
    AND NOT EXISTS (SELECT 1 FROM studio_entitlements e WHERE e.design_id = p.design_id AND e.category = p.category)))`

export async function openDesignCount(userId: string): Promise<number> {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(studioDesigns)
    .where(and(eq(studioDesigns.ownerId, userId), isNull(studioDesigns.archivedAt), sql`NOT ${fullyFinalized}`))
  return n
}

export async function totalDesignCount(userId: string): Promise<number> {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(studioDesigns).where(eq(studioDesigns.ownerId, userId))
  return n
}

/** Free-finalize credits left, and how many are held by checkouts still open. */
async function freeFinalizes(userId: string, now: Date) {
  const [bal] = await db.select({ balance: studioFinalizeCredits.balance }).from(studioFinalizeCredits)
    .where(eq(studioFinalizeCredits.userId, userId))
  const [held] = await db.select({ n: sql<number>`coalesce(sum(${studioPayments.giftsHeld}), 0)::int` }).from(studioPayments)
    .where(and(eq(studioPayments.userId, userId), eq(studioPayments.kind, 'finalize'), eq(studioPayments.status, 'pending'),
      gt(studioPayments.expiresAt, now)))
  return { available: bal?.balance ?? 0, held: held.n }
}

export async function usage(userId: string, limit: number, now: Date) {
  const s = await promptStatus(userId, now)
  return {
    plan: s.plan,
    promptsLeft: s.left,
    credits: s.credits,
    giftedPrompts: s.gifted,
    freeFinalizes: await freeFinalizes(userId, now),
    left: s.left,
    trial: s.trial,
    allowance: s.allowance,
    resetsAt: s.resetsAt,
    // A trial's 2 designs are a total, archived ones included
    openDesigns: s.trial ? await totalDesignCount(userId) : await openDesignCount(userId),
    openDesignLimit: Number.isFinite(limit) ? limit : null,
    topup: { cents: config.studioPrices.topupCents, prompts: config.studioPrices.topupPrompts },
    creditCents: await creditBalance(userId), // Virvi credit, in USD cents
    mana: !!config.studioMana.recipient, // Pay with MANA is offered
  }
}

export async function designDetail(d: Design, now: Date) {
  const pieces = await db.select().from(studioPieces).where(eq(studioPieces.designId, d.id)).orderBy(asc(studioPieces.createdAt))
  const revIds = pieces.map((p) => p.latestRevisionId).filter((x): x is string => !!x)
  const revs = revIds.length ? await db.select().from(studioRevisions).where(inArray(studioRevisions.id, revIds)) : []
  const renders = revIds.length ? await db.select().from(studioRenders).where(inArray(studioRenders.revisionId, revIds)) : []
  const expires = frameUrlExpiry(now)
  const finalized = await finalizedRevisions(d.id)
  const messages = await db.select().from(studioMessages).where(eq(studioMessages.designId, d.id))
    .orderBy(asc(studioMessages.createdAt), asc(studioMessages.id))
  const [active] = await db.select({
    id: studioJobs.id, type: studioJobs.type, status: studioJobs.status,
    fixClipping: sql<FixClipping | null>`${studioJobs.payload}->'fixClipping'`,
  }).from(studioJobs)
    .where(and(eq(studioJobs.designId, d.id), inArray(studioJobs.status, ['queued', 'taken'])))
    .orderBy(sql`CASE WHEN ${studioJobs.type} = 'prompt' THEN 0 ELSE 1 END`, asc(studioJobs.createdAt))
    .limit(1)
  const [last] = await db.select({ jobId: studioJobs.id, status: studioJobs.status, result: studioJobs.result }).from(studioJobs)
    .where(and(eq(studioJobs.designId, d.id), eq(studioJobs.type, 'prompt')))
    .orderBy(desc(studioJobs.createdAt))
    .limit(1)
  return {
    design: publicDesign(d, (await finalizedCounts([d.id])).get(d.id)),
    pieces: pieces.map((p) => {
      const rev = revs.find((r) => r.id === p.latestRevisionId)
      const views: Record<string, { status: string; frames: number; urls: string[]; renderedAt: Date; pending?: boolean }> = {}
      for (const r of renders.filter((r) => r.revisionId === rev?.id)) {
        views[r.viewKey] = {
          status: r.status,
          frames: r.frames,
          renderedAt: r.createdAt,
          // an Inspect view whose whole sphere is still rendering behind its ring
          ...(r.viewKey.startsWith('orbit-') ? { pending: !!r.pendingJobId } : {}),
          urls: r.status === 'ready'
            ? Array.from({ length: r.frames }, (_, frame) => signRenderFrame(
              { designId: d.id, revisionId: r.revisionId, viewKey: r.viewKey, category: p.category, frame, jobId: r.jobId }, expires))
            : [],
        }
      }
      return {
        id: p.id,
        category: p.category,
        name: p.name,
        revision: rev ? { number: rev.number, changeKind: rev.changeKind, checker: rev.checker, createdAt: rev.createdAt } : null,
        renders: views,
        finalized: finalized.filter((f) => f.category === p.category).map(({ category: _c, ...f }) => f),
      }
    }),
    // `support`: a Virvi admin wrote it (shown as Virvi support); who, is for the audit, not the page
    messages: messages.map((m) => ({
      id: m.id, role: m.role, agent: m.agent, text: m.text, proposal: m.proposal, jobId: m.jobId, createdAt: m.createdAt, support: !!m.byAdminId,
    })),
    uploads: (await listUploads(d.id)).map(publicUpload),
    activeJob: active ?? null,
    set: await setDetail(d, now),
    // Each agent reply that changed pieces, and the owner's 👍 / 👎 of it (LIV-142)
    revisions: await designRevisions(d.id, d.ownerId),
    lastPrompt: last
      ? { jobId: last.jobId, outcome: (last.result as { outcome?: string } | null)?.outcome ?? null, status: last.status }
      : null,
  }
}

type Refusal = { status: number; body: Record<string, unknown> }
class Refused extends Error {
  constructor(public r: Refusal) { super(String(r.body.code ?? r.body.error)) }
}

/** After a job is committed: make sure a machine will take it, or fail it plainly (refunding a counted prompt). */
export async function startWorker(designId: string, jobId: string, now: Date): Promise<void> {
  try {
    await ensureWorker(designId)
  } catch (err) {
    console.error('[studio] worker start failed:', err instanceof Error ? err.message : err)
    await failJobs([jobId], START_FAILED, now)
  }
}

/**
 * `byAdminId`: a Virvi admin helping on the owner's design (Virvi support). Their prompt takes nothing from anyone's
 * allowance, gifts, credits or trial quota, and the cost ceiling doesn't stop it; the per-prompt limits, one prompt at
 * a time and an archived design's refusal still apply. The job and the message record the admin.
 *
 * `feedbackFor`: the owner's "Try again with this feedback" on a 👎'd revision (LIV-142), in their own words: free (no
 * allowance, gift or credit; past the cost ceiling it is refused), once per revision.
 */
export async function queuePrompt(
  design: Design,
  input: {
    text: string | null; selectedSlots: string[] | null; continue: boolean; fixChecks?: boolean; fixClipping?: FixClipping; byAdminId?: string
    feedbackFor?: string
  },
  now: Date,
): Promise<{ ok: true; jobId: string } | ({ ok: false } & Refusal)> {
  let jobId: string
  let trialPrompt = false
  try {
    jobId = await db.transaction(async (tx) => {
      // One prompt at a time: lock the design, then check; the partial unique index backs this up
      const [d] = await tx.select().from(studioDesigns).where(eq(studioDesigns.id, design.id)).for('update')
      if (d.archivedAt) throw new Refused({ status: 409, body: { error: 'archived', code: 'archived' } })
      const [open] = await tx.select({ id: studioJobs.id }).from(studioJobs)
        .where(and(eq(studioJobs.designId, d.id), eq(studioJobs.type, 'prompt'), inArray(studioJobs.status, ['queued', 'taken'])))
      if (open) throw new Refused({ status: 409, body: { error: 'busy', code: 'busy' } })
      if (input.continue) {
        const [last] = await tx.select({ result: studioJobs.result }).from(studioJobs)
          .where(and(eq(studioJobs.designId, d.id), eq(studioJobs.type, 'prompt')))
          .orderBy(desc(studioJobs.createdAt)).limit(1)
        if (!CONTINUABLE.includes((last?.result as { outcome?: string } | null)?.outcome ?? '')) {
          throw new Refused({ status: 409, body: { error: 'nothing_to_continue', code: 'nothing_to_continue' } })
        }
      }
      let fixText: string | null = null
      if (input.fixChecks) {
        // Fixing what the checker failed is the agent's job, so it doesn't use the allowance
        const failing = await tx.select({ category: studioPieces.category, checker: studioRevisions.checker }).from(studioPieces)
          .innerJoin(studioRevisions, eq(studioRevisions.id, studioPieces.latestRevisionId))
          .where(eq(studioPieces.designId, d.id))
          .orderBy(asc(studioPieces.category))
        const categories = failing.filter((p) => (p.checker as { pass?: boolean } | null)?.pass === false).map((p) => p.category)
        if (!categories.length) throw new Refused({ status: 409, body: { error: 'nothing_to_fix', code: 'nothing_to_fix' } })
        fixText = fixChecksText(categories)
      }
      if (input.feedbackFor) {
        const [tried] = await tx.select({ id: studioJobs.id }).from(studioJobs).where(eq(studioJobs.feedbackFor, input.feedbackFor))
        if (tried) throw new Refused({ status: 409, body: { error: 'already_tried', code: 'already_tried' } })
      }
      // A clipping report is the agent's mistake too: free, in the server's words. Support's prompts are never counted.
      const support = input.byAdminId ?? null
      const feedback = input.feedbackFor ?? null
      const counted = !support && !feedback && !input.continue && !input.fixChecks && !input.fixClipping
      const r = support ? { ok: true as const, day: null, from: null }
        : await reservePrompt(d.ownerId, now, { counted, ...(feedback ? { gifts: false } : {}) }, tx)
      if (!r.ok) {
        const s = await promptStatus(d.ownerId, now)
        if (s.trial && (r.reason === 'allowance' || r.reason === 'cost_ceiling')) throw new Refused({ status: 403, body: { error: 'account_required', action: 'more_prompts' } })
        if (r.reason === 'trial_busy') {
          throw new Refused({ status: 429, body: { error: 'trial_busy', message: 'Free tries are busy right now — create an account to keep going.' } })
        }
        throw new Refused({ status: 429, body: { error: r.reason, code: r.reason, resetsAt: s.resetsAt } })
      }
      trialPrompt = r.day === TRIAL_DAY
      const fix = input.fixClipping
      const text = input.continue ? CONTINUE_TEXT : fix ? clippingText(d.kind, fix) : fixText ?? input.text!
      await tx.insert(studioMessages).values({ designId: d.id, role: 'user', text, byAdminId: support })
      // Support's own words reach the agent marked as theirs; never scope-checked (that is for the designer's words)
      const ownWords = !input.continue && !fix && !fixText
      const prompt = fix ? clippingInstruction(d.kind, fix) : !ownWords ? text : support ? `${SUPPORT_PREFIX}${ownerWords(text)}` : ownerWords(text)
      const [job] = await tx.insert(studioJobs).values({
        designId: d.id,
        type: 'prompt',
        payload: {
          type: 'prompt',
          kind: d.kind,
          agent: d.agent,
          model: modelFor(d.agent),
          prompt,
          selectedSlots: input.selectedSlots,
          limits: promptLimits(d.agent, d.kind),
          render: null,
          uploads: await uploadPaths(d.id, tx),
          // the user's own words; Continue and fixing the checks are the server's (a try-again is the owner's)
          check: counted || !!feedback,
          ...(fix ? { fixClipping: fix } : {}),
        },
        counted,
        countedDay: r.day,
        countedFrom: r.from,
        byAdminId: support,
        feedbackFor: feedback,
      }).returning({ id: studioJobs.id })
      await tx.update(studioDesigns).set({ status: 'building', lastJobAt: now }).where(eq(studioDesigns.id, d.id))
      return job.id
    })
  } catch (err) {
    if (err instanceof Refused) {
      if (err.r.body.error === 'account_required') recordTrialBlocked(design.ownerId, String(err.r.body.action ?? 'more_prompts'))
      return { ok: false, ...err.r }
    }
    if ((err as { code?: string }).code === '23505') {
      if ((err as { constraint_name?: string }).constraint_name === 'studio_jobs_feedback_for_uq') return { ok: false, status: 409, body: { error: 'already_tried', code: 'already_tried' } }
      return { ok: false, status: 409, body: { error: 'busy', code: 'busy' } }
    }
    throw err
  }
  if (trialPrompt) recordTrialEvent('prompt', design.ownerId)
  await publishStudio(design.id, { type: 'job', jobId, status: 'queued' })
  await startWorker(design.id, jobId, now)
  return { ok: true, jobId }
}

const renderPayload = (kind: string, render: Record<string, unknown>) => ({
  type: 'render', kind, agent: null, model: null, prompt: null, selectedSlots: null, limits: RENDER_LIMITS, render,
})

/** Queues the whole Inspect sphere behind a ring, in the background, as the job that will replace the ring's frames. */
export async function queueFullOrbit(
  exec: Exec, design: { id: string; kind: string }, revisionId: string, category: string, bodyShape: View['bodyShape'],
): Promise<string> {
  const [job] = await exec.insert(studioJobs).values({
    designId: design.id,
    type: 'render',
    background: true,
    payload: renderPayload(design.kind, { categories: [category], bodyShape, mode: 'orbit', ring: false }),
  }).returning({ id: studioJobs.id })
  await exec.update(studioRenders).set({ pendingJobId: job.id })
    .where(and(eq(studioRenders.revisionId, revisionId), eq(studioRenders.viewKey, orbitKeyFor(design.kind, bodyShape))))
  return job.id
}

/**
 * Inspect: a piece alone from every angle. A missing view queues the eye-level ring (shown as soon as it lands) and
 * the rest of the sphere behind it, in the background. A ring whose sphere never came gets the sphere queued again.
 */
export async function requestOrbit(
  design: Design,
  category: string,
  bodyShape: View['bodyShape'],
  now: Date,
): Promise<{ status: 'ready'; frames: number; urls: string[] } | { status: 'queued' } | null> {
  const [piece] = await db.select().from(studioPieces)
    .where(and(eq(studioPieces.designId, design.id), eq(studioPieces.category, category)))
  if (!piece?.latestRevisionId) return null
  const revisionId = piece.latestRevisionId
  const key = orbitKeyFor(design.kind, bodyShape)
  const queued = await db.transaction(async (tx) => {
    await tx.select({ id: studioDesigns.id }).from(studioDesigns).where(eq(studioDesigns.id, design.id)).for('update')
    const [row] = await tx.select().from(studioRenders)
      .where(and(eq(studioRenders.revisionId, revisionId), eq(studioRenders.viewKey, key)))
    if (row?.status === 'ready') {
      if (row.frames < ORBIT_FRAMES && !row.pendingJobId) return { ready: row, jobId: await queueFullOrbit(tx, design, revisionId, category, bodyShape) }
      return { ready: row }
    }
    if (row?.status === 'queued') return {}
    const [ring] = await tx.insert(studioJobs).values({
      designId: design.id,
      type: 'render',
      payload: renderPayload(design.kind, { categories: [category], bodyShape, mode: 'orbit', ring: true }),
    }).returning({ id: studioJobs.id })
    await tx.insert(studioRenders).values({ revisionId, viewKey: key, jobId: ring.id, status: 'queued', frames: 0 })
      .onConflictDoUpdate({ target: [studioRenders.revisionId, studioRenders.viewKey], set: { jobId: ring.id, status: 'queued', frames: 0 } })
    await queueFullOrbit(tx, design, revisionId, category, bodyShape)
    await tx.update(studioDesigns).set({ lastJobAt: now }).where(eq(studioDesigns.id, design.id))
    return { jobId: ring.id }
  })
  if (queued.jobId) {
    await publishStudio(design.id, { type: 'job', jobId: queued.jobId, status: 'queued' })
    await startWorker(design.id, queued.jobId, now)
  }
  if (!queued.ready) return { status: 'queued' }
  const r = queued.ready
  const expires = frameUrlExpiry(now)
  return {
    status: 'ready',
    frames: r.frames,
    urls: Array.from({ length: r.frames }, (_, frame) => signRenderFrame(
      { designId: design.id, revisionId: r.revisionId, viewKey: r.viewKey, category, frame, jobId: r.jobId }, expires)),
  }
}

export async function requestRender(
  design: Design,
  category: string,
  view: View,
  now: Date,
): Promise<{ status: 'ready'; frames: number; urls: string[] } | { status: 'queued' } | null> {
  const [piece] = await db.select().from(studioPieces)
    .where(and(eq(studioPieces.designId, design.id), eq(studioPieces.category, category)))
  if (!piece?.latestRevisionId) return null
  const key = viewKey(design.kind, view)
  const queued = await db.transaction(async (tx) => {
    await tx.select({ id: studioDesigns.id }).from(studioDesigns).where(eq(studioDesigns.id, design.id)).for('update')
    const [row] = await tx.select().from(studioRenders)
      .where(and(eq(studioRenders.revisionId, piece.latestRevisionId!), eq(studioRenders.viewKey, key)))
    if (row?.status === 'ready') return { ready: row }
    if (row?.status === 'queued') return { already: true as const }
    const [job] = await tx.insert(studioJobs).values({
      designId: design.id,
      type: 'render',
      payload: renderPayload(design.kind, { categories: [category], ...view }),
    }).returning({ id: studioJobs.id })
    await tx.insert(studioRenders).values({ revisionId: piece.latestRevisionId!, viewKey: key, jobId: job.id, status: 'queued', frames: 0 })
      .onConflictDoUpdate({ target: [studioRenders.revisionId, studioRenders.viewKey], set: { jobId: job.id, status: 'queued', frames: 0 } })
    await tx.update(studioDesigns).set({ lastJobAt: now }).where(eq(studioDesigns.id, design.id))
    return { jobId: job.id }
  })
  if ('ready' in queued && queued.ready) {
    const r = queued.ready
    const expires = frameUrlExpiry(now)
    return {
      status: 'ready',
      frames: r.frames,
      urls: Array.from({ length: r.frames }, (_, frame) => signRenderFrame(
        { designId: design.id, revisionId: r.revisionId, viewKey: r.viewKey, category, frame, jobId: r.jobId }, expires)),
    }
  }
  if ('jobId' in queued && queued.jobId) {
    await publishStudio(design.id, { type: 'job', jobId: queued.jobId, status: 'queued' })
    await startWorker(design.id, queued.jobId, now)
  }
  return { status: 'queued' }
}
