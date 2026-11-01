import { and, eq, inArray, max, or, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { studioDesigns, studioEntitlements, studioJobs, studioMessages, studioPieces, studioRenders, studioRevisions, studioSetRenders } from '../db/schema.js'
import { checkFilePath, jobFileKey } from './store.js'
import { recordCost, refundPrompt, utcDay, type Exec, type PromptSource } from './quota.js'
import { publishStudio } from './events.js'
import { ORBIT_FRAMES, orbitKey, queueFullOrbit, revisionsKey, type FixClipping, type View } from './designs.js'
import { requestSetRender } from './sets.js'
import { DECLINED_NOTE, SCOPE_CATEGORIES, logScopeEvent, maybeFlag, offTopicIsFree, offTopicNote } from './scope.js'

/** A worker's Result, as apps/studio-worker/CONTRACT.md defines it (only the fields Virvi reads are typed). */
export type ContractResult = {
  jobId?: string
  outcome: 'ok' | 'needs_input' | 'no_change' | 'off_topic' | 'declined' | 'ceiling' | 'turns' | 'timeout' | 'error'
  agent?: string | null
  model?: string | null
  skillsSha?: string | null
  wallSec?: number | null
  tokens?: Record<string, number> | null
  costUsd?: number | null
  reply?: string | null
  proposal?: unknown
  pieces: ContractPiece[]
  error?: string | null
  scope?: { by: 'check' | 'agent'; category: string; note: string } | null // on off_topic and declined
  set?: { viewKey: string; frames: number; fps: number } | null // a set render job's emote view
}

export type ContractPiece = {
  category: string
  changed?: boolean
  changeKind?: string
  meta?: Record<string, unknown>
  checker?: { pass: boolean; failures: number; warnings: number; triangles?: { count: number; limit: number } | null } | null
  files?: string[]
  renders?: Record<string, number>
  finalize?: Record<string, unknown> | null // a finalize job's check summary for the piece
}

const OUTCOMES = ['ok', 'needs_input', 'no_change', 'off_topic', 'declined', 'ceiling', 'turns', 'timeout', 'error'] as const
const CATEGORY = /^[a-z_]+$/
const VIEW_KEY = /^[a-z0-9-]+$/

/** Checks a posted Result by hand; returns it typed, or why it is refused. */
export function parseResult(body: unknown): { ok: true; result: ContractResult } | { ok: false; reason: string } {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'result is not an object' }
  const r = body as Record<string, unknown>
  if (!OUTCOMES.includes(r.outcome as never)) return { ok: false, reason: 'unknown outcome' }
  if (!Array.isArray(r.pieces)) return { ok: false, reason: 'pieces is not a list' }
  if (r.costUsd != null && (typeof r.costUsd !== 'number' || !Number.isFinite(r.costUsd) || r.costUsd < 0)) {
    return { ok: false, reason: 'costUsd is not a cost' }
  }
  if (r.reply != null && typeof r.reply !== 'string') return { ok: false, reason: 'reply is not text' }
  if (r.error != null && typeof r.error !== 'string') return { ok: false, reason: 'error is not text' }
  if (r.outcome === 'off_topic' || r.outcome === 'declined') {
    const sc = r.scope as Record<string, unknown> | null | undefined
    if (!sc || typeof sc !== 'object' || (sc.by !== 'check' && sc.by !== 'agent')
      || typeof sc.category !== 'string' || !SCOPE_CATEGORIES.includes(sc.category) || typeof sc.note !== 'string') {
      return { ok: false, reason: 'scope is malformed' }
    }
  }
  if (r.set != null) {
    const st = r.set as Record<string, unknown>
    if (typeof st !== 'object' || typeof st.viewKey !== 'string' || !VIEW_KEY.test(st.viewKey)
      || !Number.isInteger(st.frames) || (st.frames as number) < 0 || (st.frames as number) > 999
      || typeof st.fps !== 'number' || !Number.isFinite(st.fps) || st.fps <= 0 || st.fps > 60) {
      return { ok: false, reason: 'set is malformed' }
    }
  }
  for (const p of r.pieces as unknown[]) {
    if (!p || typeof p !== 'object') return { ok: false, reason: 'a piece is not an object' }
    const piece = p as Record<string, unknown>
    if (typeof piece.category !== 'string' || !CATEGORY.test(piece.category)) return { ok: false, reason: 'a piece has no category' }
    if (piece.files != null) {
      if (!Array.isArray(piece.files)) return { ok: false, reason: 'files is not a list' }
      for (const f of piece.files) {
        const c = typeof f === 'string' ? checkFilePath(f) : { ok: false as const, reason: 'file is not a path' }
        if (!c.ok) return { ok: false, reason: `${String(f).slice(0, 80)}: ${c.reason}` }
      }
    }
    if (piece.renders != null) {
      if (typeof piece.renders !== 'object' || Array.isArray(piece.renders)) return { ok: false, reason: 'renders is not a map' }
      for (const [k, v] of Object.entries(piece.renders)) {
        if (!VIEW_KEY.test(k) || !Number.isInteger(v) || (v as number) < 0 || (v as number) > 999) return { ok: false, reason: 'a render is malformed' }
      }
    }
    if (piece.meta != null && (typeof piece.meta !== 'object' || Array.isArray(piece.meta))) return { ok: false, reason: 'meta is not an object' }
    if (piece.finalize != null && (typeof piece.finalize !== 'object' || Array.isArray(piece.finalize))) return { ok: false, reason: 'finalize is not an object' }
  }
  return { ok: true, result: r as unknown as ContractResult }
}

const SUPERSEDED = 'superseded: the pieces changed before it ran'

/**
 * After a prompt changed pieces: renders still waiting for the old pieces would render the new ones under the old
 * key, where nobody sees them, and hold up the current ones. Fails them before a worker takes them.
 */
async function cancelSupersededRenders(designId: string, superseded: string[], exec: Exec, now: Date): Promise<void> {
  const revisions = revisionsKey(await exec.select({ latestRevisionId: studioPieces.latestRevisionId }).from(studioPieces)
    .where(eq(studioPieces.designId, designId)))
  const pieceJobs = superseded.length
    ? sql`OR id IN (SELECT job_id FROM studio_renders WHERE revision_id IN (${sql.join(superseded.map((r) => sql`${r}`), sql`, `)})
        UNION SELECT pending_job_id FROM studio_renders WHERE revision_id IN (${sql.join(superseded.map((r) => sql`${r}`), sql`, `)}))`
    : sql``
  const cancelled = await exec.update(studioJobs)
    .set({ status: 'failed', result: { outcome: 'error', error: SUPERSEDED, pieces: [] }, finishedAt: now })
    .where(and(eq(studioJobs.designId, designId), eq(studioJobs.type, 'render'), eq(studioJobs.status, 'queued'),
      sql`((${studioJobs.payload}->'render'->>'set' = 'true' AND ${studioJobs.payload}->>'revisions' IS DISTINCT FROM ${revisions}) ${pieceJobs})`))
    .returning({ id: studioJobs.id })
  const ids = cancelled.map((j) => j.id)
  if (!ids.length) return
  await exec.update(studioRenders).set({ status: 'failed' }).where(and(inArray(studioRenders.jobId, ids), eq(studioRenders.status, 'queued')))
  await exec.update(studioRenders).set({ pendingJobId: null }).where(inArray(studioRenders.pendingJobId, ids))
  await exec.update(studioSetRenders).set({ status: 'failed' }).where(inArray(studioSetRenders.jobId, ids))
}

export const packagingFailedText = (name: string) => `Packaging ${name} failed. You can try again at no charge.`

/** The entitlements a finalize job was packaging, with their piece names. */
async function finalizeEntitlements(jobId: string, exec: Exec) {
  return exec.select({ e: studioEntitlements, name: studioPieces.name }).from(studioEntitlements)
    .innerJoin(studioRevisions, eq(studioRevisions.id, studioEntitlements.revisionId))
    .innerJoin(studioPieces, eq(studioPieces.id, studioRevisions.pieceId))
    .where(eq(studioEntitlements.jobId, jobId))
}

/** Plain words for the page when an outcome has no reply of its own. */
function systemNote(r: ContractResult, refunded: boolean): string | null {
  switch (r.outcome) {
    case 'error':
      return `Something went wrong: ${r.error || 'the worker gave no reason'}.${refunded ? ' Your prompt was not counted.' : ''}`
    case 'ceiling':
      return 'The agent stopped at this prompt’s cost limit. Press Continue to carry on where it stopped: it doesn’t use a prompt.'
    case 'turns':
      return 'The agent stopped at this prompt’s step limit. Press Continue to carry on where it stopped: it doesn’t use a prompt.'
    case 'timeout':
      return 'The agent ran out of time on this prompt.'
    case 'off_topic': // the fixed words only: the model's note is never shown
      return offTopicNote(r.scope?.category ?? 'other', !refunded)
    case 'declined':
      return DECLINED_NOTE
    default:
      return null
  }
}

/** The design is idle again once no prompt is waiting or running. */
export async function settleDesign(designId: string, exec: Exec = db): Promise<void> {
  await exec.update(studioDesigns).set({ status: 'idle' }).where(and(
    eq(studioDesigns.id, designId),
    sql`NOT EXISTS (SELECT 1 FROM studio_jobs j WHERE j.design_id = ${designId} AND j.type = 'prompt' AND j.status IN ('queued', 'taken'))`,
  ))
}

/**
 * Applies a worker's Result once: the job is claimed with a conditional update, so a retried post (or a post after
 * the sweep failed the job) changes nothing and answers 'already'.
 */
export async function applyResult(jobId: string, result: ContractResult, now: Date): Promise<'applied' | 'already'> {
  const status = result.outcome === 'error' ? 'failed' : 'done'
  const job = await db.transaction(async (tx) => {
    const [job] = await tx.update(studioJobs)
      .set({ status, result, finishedAt: now })
      .where(and(eq(studioJobs.id, jobId), eq(studioJobs.status, 'taken')))
      .returning()
    if (!job) return null
    const [design] = await tx.select().from(studioDesigns).where(eq(studioDesigns.id, job.designId))
    const day = job.countedDay ?? utcDay(now)

    if (job.type === 'prompt') {
      const payload = job.payload as { agent?: string }
      const agent = result.agent ?? payload.agent ?? null
      if (result.reply || result.proposal) {
        await tx.insert(studioMessages).values({
          designId: job.designId, role: 'agent', agent, text: result.reply ?? '', jobId: job.id, proposal: result.proposal ?? null,
        })
      }
      const superseded: string[] = []
      for (const p of result.pieces) {
        if (!p.files?.length) continue
        const name = typeof p.meta?.name === 'string' && p.meta.name.trim() ? p.meta.name.trim().slice(0, 200) : p.category
        const [piece] = await tx.insert(studioPieces).values({ designId: job.designId, category: p.category, name })
          .onConflictDoUpdate({ target: [studioPieces.designId, studioPieces.category], set: { name } })
          .returning()
        const [{ n }] = await tx.select({ n: max(studioRevisions.number) }).from(studioRevisions).where(eq(studioRevisions.pieceId, piece.id))
        const [rev] = await tx.insert(studioRevisions).values({
          pieceId: piece.id,
          number: (n ?? 0) + 1,
          jobId: job.id,
          changeKind: p.changeKind ?? 'design',
          meta: p.meta ?? {},
          checker: p.checker ?? null,
          files: p.files,
        }).returning()
        if (piece.latestRevisionId) superseded.push(piece.latestRevisionId)
        await tx.update(studioPieces).set({ latestRevisionId: rev.id }).where(eq(studioPieces.id, piece.id))
        const views = Object.entries(p.renders ?? {}).filter(([, frames]) => frames > 0)
        if (views.length) {
          await tx.insert(studioRenders)
            .values(views.map(([viewKey, frames]) => ({ revisionId: rev.id, viewKey, jobId: job.id, frames, status: 'ready' })))
            .onConflictDoNothing()
        }
        // The prompt rendered Inspect's ring; the rest of the sphere follows in the background
        const ring = p.renders?.[orbitKey('male')] ?? 0
        if (design && ring > 0 && ring < ORBIT_FRAMES) await queueFullOrbit(tx, design, rev.id, p.category, 'male')
      }
      if (result.pieces.some((p) => p.files?.length)) await cancelSupersededRenders(job.designId, superseded, tx, now)
      if (design) await recordCost(design.ownerId, day, result.costUsd ?? 0, tx)
      const refunded = (job.counted || job.countedFrom === 'gift') && !!design && (result.outcome === 'error'
        || (result.outcome === 'off_topic' && await offTopicIsFree(tx, design.ownerId, now)))
      if (refunded) await refundPrompt(design!.ownerId, day, job.countedFrom as PromptSource | null, tx)
      const note = systemNote(result, refunded)
      if (note) await tx.insert(studioMessages).values({ designId: job.designId, role: 'system', text: note, jobId: job.id })
      if ((result.outcome === 'off_topic' || result.outcome === 'declined') && result.scope && design) {
        await logScopeEvent(tx, {
          userId: design.ownerId, designId: design.id, jobId: job.id, by: result.scope.by, category: result.scope.category,
          note: result.scope.note, message: String((job.payload as { prompt?: unknown }).prompt ?? ''),
        })
      }
    } else if (job.type === 'finalize') {
      // Each paid piece is ready once its package was uploaded; the rest failed and can be retried for free
      for (const { e, name } of await finalizeEntitlements(job.id, tx)) {
        const path = `final/${e.category}/package.zip`
        const piece = result.pieces.find((p) => p.category === e.category && p.files?.includes(path))
        if (piece) {
          const checks = piece.finalize && typeof piece.finalize === 'object' && !Array.isArray(piece.finalize) ? piece.finalize : null
          await tx.update(studioEntitlements).set({ status: 'ready', packageKey: jobFileKey(job.designId, job.id, path), checks })
            .where(eq(studioEntitlements.id, e.id))
        } else {
          await tx.update(studioEntitlements).set({ status: 'failed' }).where(eq(studioEntitlements.id, e.id))
          await tx.insert(studioMessages).values({ designId: job.designId, role: 'system', text: packagingFailedText(name), jobId: job.id })
        }
      }
    } else {
      const rows = await tx.select({ id: studioRenders.id, viewKey: studioRenders.viewKey, category: studioPieces.category, jobId: studioRenders.jobId })
        .from(studioRenders)
        .innerJoin(studioRevisions, eq(studioRevisions.id, studioRenders.revisionId))
        .innerJoin(studioPieces, eq(studioPieces.id, studioRevisions.pieceId))
        .where(or(eq(studioRenders.jobId, job.id), eq(studioRenders.pendingJobId, job.id)))
      for (const row of rows) {
        const frames = result.pieces.find((p) => p.category === row.category)?.renders?.[row.viewKey] ?? 0
        const ready = result.outcome !== 'error' && frames > 0
        if (row.jobId !== job.id) {
          // The full Inspect sphere: its frames replace the ring's, and a failure leaves the ring as it is
          await tx.update(studioRenders).set(ready ? { jobId: job.id, frames, status: 'ready', pendingJobId: null } : { pendingJobId: null })
            .where(eq(studioRenders.id, row.id))
          continue
        }
        await tx.update(studioRenders).set({ status: ready ? 'ready' : 'failed', frames: ready ? frames : 0 })
          .where(eq(studioRenders.id, row.id))
      }
      for (const row of await tx.select().from(studioSetRenders).where(eq(studioSetRenders.jobId, job.id))) {
        const s = result.set
        const ready = result.outcome !== 'error' && s?.viewKey === row.viewKey && s.frames > 0
        await tx.update(studioSetRenders).set(ready ? { status: 'ready', frames: s!.frames, fps: s!.fps } : { status: 'failed', frames: 0 })
          .where(eq(studioSetRenders.id, row.id))
      }
    }
    await settleDesign(job.designId, tx)
    return job
  })
  if (!job) return 'already'
  const fix = (job.payload as { fixClipping?: FixClipping }).fixClipping
  if (job.type === 'prompt' && fix && result.outcome === 'ok') {
    // A clipping fix renders the emote it fixed again straight away, for the new pieces
    const [d] = await db.select().from(studioDesigns).where(eq(studioDesigns.id, job.designId))
    if (d) {
      await requestSetRender(d, { bodyShape: fix.bodyShape, outfit: fix.outfit, emote: d.kind === 'emote' ? null : fix.emote } as View, now)
        .catch((err) => console.error('[studio] fix re-render failed:', err instanceof Error ? err.message : err))
    }
  }
  if (result.outcome === 'off_topic' || result.outcome === 'declined') {
    const [d] = await db.select({ ownerId: studioDesigns.ownerId }).from(studioDesigns).where(eq(studioDesigns.id, job.designId))
    if (d) await maybeFlag(d.ownerId, now).catch((err) => console.error('[studio] flag check failed:', err instanceof Error ? err.message : err))
  }
  await publishStudio(job.designId, {
    type: 'job', jobId: job.id, status, outcome: result.outcome, ...(result.error ? { error: result.error } : {}),
  })
  return 'applied'
}

/** Fails jobs that will never get a result (machine never started, or stopped answering), once each. */
export async function failJobs(
  jobIds: string[],
  error: string,
  now: Date,
): Promise<number> {
  if (!jobIds.length) return 0
  let n = 0
  for (const id of jobIds) {
    const r = await db.transaction(async (tx) => {
      const [job] = await tx.update(studioJobs)
        .set({ status: 'failed', result: { outcome: 'error', error, pieces: [] }, finishedAt: now })
        .where(and(eq(studioJobs.id, id), inArray(studioJobs.status, ['queued', 'taken'])))
        .returning()
      if (!job) return null
      const [design] = await tx.select().from(studioDesigns).where(eq(studioDesigns.id, job.designId))
      if (job.type === 'prompt') {
        if ((job.counted || job.countedFrom === 'gift') && design) await refundPrompt(design.ownerId, job.countedDay ?? utcDay(now), job.countedFrom as PromptSource | null, tx)
        await tx.insert(studioMessages).values({
          designId: job.designId, role: 'system', jobId: job.id,
          text: `${error}${job.counted ? ' Your prompt was not counted.' : ''}`,
        })
      } else if (job.type === 'finalize') {
        for (const { e, name } of await finalizeEntitlements(job.id, tx)) {
          await tx.update(studioEntitlements).set({ status: 'failed' }).where(eq(studioEntitlements.id, e.id))
          await tx.insert(studioMessages).values({ designId: job.designId, role: 'system', text: packagingFailedText(name), jobId: job.id })
        }
      } else {
        await tx.update(studioRenders).set({ status: 'failed' }).where(eq(studioRenders.jobId, job.id))
        await tx.update(studioRenders).set({ pendingJobId: null }).where(eq(studioRenders.pendingJobId, job.id))
        await tx.update(studioSetRenders).set({ status: 'failed' }).where(eq(studioSetRenders.jobId, job.id))
      }
      await settleDesign(job.designId, tx)
      return job
    })
    if (!r) continue
    n++
    await publishStudio(r.designId, { type: 'job', jobId: r.id, status: 'failed', outcome: 'error', error })
  }
  return n
}
