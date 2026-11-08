import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { studioJobs, studioPieces, studioRatings, studioRevisions } from '../db/schema.js'

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
  /** A 👎's free try-again: still to use, or used (null without a 👎). */
  tryAgain: 'available' | 'used' | null
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
export async function designRevisions(designId: string, ownerId: string): Promise<RevisionView[]> {
  const jobs = await revisionJobs(designId)
  if (!jobs.size) return []
  const ids = [...jobs.keys()]
  const ratings = await db.select().from(studioRatings)
    .where(and(eq(studioRatings.designId, designId), eq(studioRatings.userId, ownerId)))
  const retried = new Set((await db.select({ f: studioJobs.feedbackFor }).from(studioJobs)
    .where(and(eq(studioJobs.designId, designId), isNotNull(studioJobs.feedbackFor), inArray(studioJobs.feedbackFor, ids))))
    .map((r) => r.f))
  return ids.map((jobId) => {
    const r = ratings.find((x) => x.jobId === jobId)
    return {
      jobId,
      categories: jobs.get(jobId)!.categories,
      rating: (r?.rating as 'up' | 'down' | undefined) ?? null,
      tags: (r?.tags ?? []) as RatingTag[],
      note: r?.note ?? null,
      tryAgain: retried.has(jobId) ? 'used' : r?.rating === 'down' ? 'available' : null,
    }
  })
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
