import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { studioJobs, studioPieces, studioRatings, studioRevisions } from '../db/schema.js'
import type { Exec } from './quota.js'

/**
 * 👍 / 👎 on Design Studio revisions (LIV-142). A revision, here, is one agent reply that changed pieces: a prompt job
 * with studio_revisions rows. Its owner rates it, may change or clear it, and on a 👎 may say what's wrong (tags, a
 * sentence) and try again once, free, with that feedback. A 👎 is not a mistake report: it never refunds anything.
 */

export const RATING_TAGS = {
  mismatch: 'Doesn’t match what I asked',
  broken: 'Looks broken or clipping',
  size: 'Wrong size or position',
  quality: 'Low quality',
  slow: 'Too slow or cost too much',
  other: 'Something else',
} as const
export type RatingTag = keyof typeof RATING_TAGS
export const TAG_KEYS = Object.keys(RATING_TAGS) as RatingTag[]
export const NOTE_MAX = 500

/** How the try-again prompt says each tag, after "it ". */
const TAG_WORDS: Record<RatingTag, string> = {
  mismatch: 'doesn’t match what I asked',
  broken: 'looks broken or clips',
  size: 'is the wrong size or in the wrong place',
  quality: 'looks low quality',
  slow: 'took too long or cost too much',
  other: 'isn’t right',
}

/** Free try-agains one owner may send per UTC day, across their designs. */
export const TRY_AGAIN_DAILY = 3

/**
 * Why a 👎'd revision can't have its free try-again now, or null when it can. Only the design's latest revision gets
 * one, never a revision a try-again made (so they don't chain), once per revision, and TRY_AGAIN_DAILY a day per owner.
 * queuePrompt asks again inside its transaction, under the owner's lock, so concurrent asks can't pass it together.
 */
export async function tryAgainBlock(
  exec: Exec, designId: string, ownerId: string, jobId: string, now: Date,
): Promise<'already_tried' | 'not_latest' | 'not_retryable' | 'try_again_limit' | null> {
  const [tried] = await exec.select({ id: studioJobs.id }).from(studioJobs).where(eq(studioJobs.feedbackFor, jobId))
  if (tried) return 'already_tried'
  const [job] = await exec.select({ feedbackFor: studioJobs.feedbackFor }).from(studioJobs).where(eq(studioJobs.id, jobId))
  if (job?.feedbackFor) return 'not_retryable'
  if ((await latestRevisionJob(exec, designId)) !== jobId) return 'not_latest'
  if ((await tryAgainsToday(exec, ownerId, now)) >= TRY_AGAIN_DAILY) return 'try_again_limit'
  return null
}

/** The design's latest revision: the prompt job that most recently changed a piece. */
async function latestRevisionJob(exec: Exec, designId: string): Promise<string | null> {
  const rows = await exec.execute(sql`
    SELECT r.job_id FROM studio_revisions r JOIN studio_pieces p ON p.id = r.piece_id
    JOIN studio_jobs j ON j.id = r.job_id AND j.type = 'prompt'
    WHERE p.design_id = ${designId}
    ORDER BY r.created_at DESC, j.created_at DESC LIMIT 1`) as unknown as { job_id: string }[]
  return rows[0]?.job_id ?? null
}

async function tryAgainsToday(exec: Exec, ownerId: string, now: Date): Promise<number> {
  const day = now.toISOString().slice(0, 10)
  const rows = await exec.execute(sql`
    SELECT count(*)::int AS n FROM studio_jobs j JOIN studio_designs d ON d.id = j.design_id
    WHERE d.owner_id = ${ownerId} AND j.feedback_for IS NOT NULL AND j.created_at >= ${`${day}T00:00:00Z`}::timestamptz`) as unknown as { n: number }[]
  return rows[0]?.n ?? 0
}

/** Holds the owner's try-agains to one at a time until the transaction ends (the daily count stays true). */
export async function lockTryAgains(exec: Exec, ownerId: string): Promise<void> {
  await exec.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`studio-try-again:${ownerId}`}))`)
}

export type RatingInput = { rating: 'up' | 'down'; tags: RatingTag[]; note: string | null }

/** A rating body checked by hand; a 👍 keeps no tags or note. A string is why it was refused. */
export function parseRating(body: unknown): RatingInput | string {
  const b = (body ?? {}) as { rating?: unknown; tags?: unknown; note?: unknown }
  if (b.rating !== 'up' && b.rating !== 'down') return "rating must be 'up' or 'down'"
  if (b.rating === 'up') return { rating: 'up', tags: [], note: null }
  const tags = b.tags ?? []
  if (!Array.isArray(tags) || tags.length > TAG_KEYS.length || !tags.every((t) => (TAG_KEYS as unknown[]).includes(t))) {
    return `tags must be some of ${TAG_KEYS.join(', ')}`
  }
  if (b.note != null && (typeof b.note !== 'string' || b.note.length > NOTE_MAX)) return `note must be at most ${NOTE_MAX} characters`
  const note = typeof b.note === 'string' ? b.note.trim() || null : null
  return { rating: 'down', tags: TAG_KEYS.filter((t) => (tags as unknown[]).includes(t)), note }
}

/** The prompt "Try again with this feedback" sends, in the owner's voice, from their tags and note. */
export function feedbackText(pieces: string[], tags: RatingTag[], note: string | null): string {
  const what = pieces.length ? `your change to ${listOf(pieces)}` : 'that change'
  const said = tags.filter((t) => t !== 'other' || tags.length === 1).map((t) => TAG_WORDS[t])
  const head = said.length ? `I’m not happy with ${what}: it ${listOf(said)}.` : `I’m not happy with ${what}.`
  return `${head}${note ? ` ${note}` : ''} Please try again.`
}

const listOf = (xs: string[]) => xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`

export type RevisionView = {
  jobId: string
  categories: string[]
  rating: 'up' | 'down' | null
  tags: RatingTag[]
  note: string | null
  /** A 👎's free try-again: still to use, or used (null without a 👎, or when this revision can't have one). */
  tryAgain: 'available' | 'used' | null
  /** Every piece it changed is still at the revision it made (nothing changed them since): Finalize this pays for it. */
  current: boolean
}

/** The prompt jobs of a design that changed pieces, oldest first, with the pieces each changed. */
async function revisionJobs(designId: string, jobId?: string) {
  const rows = await db.select({ jobId: studioRevisions.jobId, category: studioPieces.category, name: studioPieces.name, createdAt: studioRevisions.createdAt })
    .from(studioRevisions)
    .innerJoin(studioPieces, eq(studioPieces.id, studioRevisions.pieceId))
    .innerJoin(studioJobs, and(eq(studioJobs.id, studioRevisions.jobId), eq(studioJobs.type, 'prompt')))
    .where(and(eq(studioPieces.designId, designId), jobId ? eq(studioRevisions.jobId, jobId) : undefined))
    .orderBy(asc(studioRevisions.createdAt), asc(studioPieces.category))
  const jobs = new Map<string, { categories: string[]; names: string[] }>()
  for (const r of rows) {
    const j = jobs.get(r.jobId) ?? { categories: [], names: [] }
    if (!j.categories.includes(r.category)) { j.categories.push(r.category); j.names.push(r.name) }
    jobs.set(r.jobId, j)
  }
  return jobs
}

/** Every revision of the design, with the owner's rating of it (what the conversation shows). */
export async function designRevisions(designId: string, ownerId: string, now = new Date()): Promise<RevisionView[]> {
  const jobs = await revisionJobs(designId)
  if (!jobs.size) return []
  const ids = [...jobs.keys()]
  // The job behind each piece's latest revision
  const latest = await db.select({ category: studioPieces.category, jobId: studioRevisions.jobId }).from(studioPieces)
    .innerJoin(studioRevisions, eq(studioRevisions.id, studioPieces.latestRevisionId))
    .where(eq(studioPieces.designId, designId))
  const ratings = await db.select().from(studioRatings)
    .where(and(eq(studioRatings.designId, designId), eq(studioRatings.userId, ownerId)))
  const retried = new Set((await db.select({ f: studioJobs.feedbackFor }).from(studioJobs)
    .where(and(eq(studioJobs.designId, designId), isNotNull(studioJobs.feedbackFor), inArray(studioJobs.feedbackFor, ids))))
    .map((r) => r.f))
  const views: RevisionView[] = []
  for (const jobId of ids) {
    const r = ratings.find((x) => x.jobId === jobId)
    const categories = jobs.get(jobId)!.categories
    const offer = retried.has(jobId) ? 'used'
      : r?.rating === 'down' && !(await tryAgainBlock(db, designId, ownerId, jobId, now)) ? 'available' : null
    views.push({
      jobId,
      categories,
      rating: (r?.rating as 'up' | 'down' | undefined) ?? null,
      tags: (r?.tags ?? []) as RatingTag[],
      note: r?.note ?? null,
      tryAgain: offer,
      current: categories.every((c) => latest.find((l) => l.category === c)?.jobId === jobId),
    })
  }
  return views
}

/** One revision of the design (a prompt job of it that changed pieces), with its piece names; null if it isn't one. */
export async function findRevision(designId: string, jobId: string) {
  const j = (await revisionJobs(designId, jobId)).get(jobId)
  if (!j) return null
  const [job] = await db.select().from(studioJobs).where(eq(studioJobs.id, jobId))
  return { job, ...j }
}

/** Rates a revision, or changes its rating: the revision's kind, agent, model, prompt and cost go with it. */
export async function rateRevision(
  design: { id: string; kind: string }, jobId: string, userId: string, input: RatingInput, now: Date,
): Promise<RevisionView | null> {
  const rev = await findRevision(design.id, jobId)
  if (!rev) return null
  const payload = (rev.job.payload ?? {}) as { agent?: string; model?: string; prompt?: string; kind?: string }
  const result = (rev.job.result ?? {}) as { agent?: string | null; model?: string | null; costUsd?: number | null }
  const values = {
    rating: input.rating, tags: input.tags, note: input.note,
    kind: payload.kind ?? design.kind,
    agent: result.agent ?? payload.agent ?? null,
    model: result.model ?? payload.model ?? null,
    prompt: typeof payload.prompt === 'string' ? payload.prompt.slice(0, 4000) : null,
    costUsd: typeof result.costUsd === 'number' ? result.costUsd : null,
    updatedAt: now,
  }
  await db.insert(studioRatings).values({ jobId, designId: design.id, userId, ...values, createdAt: now })
    .onConflictDoUpdate({ target: [studioRatings.jobId, studioRatings.userId], set: values })
  return (await designRevisions(design.id, userId)).find((r) => r.jobId === jobId) ?? null
}

export async function clearRating(designId: string, jobId: string, userId: string): Promise<boolean> {
  if (!(await findRevision(designId, jobId))) return false
  await db.delete(studioRatings).where(and(eq(studioRatings.jobId, jobId), eq(studioRatings.userId, userId)))
  return true
}

/** The owner's 👎 of the revision, if that is what it has now. */
export async function downRating(jobId: string, userId: string) {
  const [r] = await db.select().from(studioRatings)
    .where(and(eq(studioRatings.jobId, jobId), eq(studioRatings.userId, userId), eq(studioRatings.rating, 'down')))
  return r ?? null
}
