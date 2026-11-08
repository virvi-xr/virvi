import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { studioLessons, studioRatings } from '../db/schema.js'
import type { Exec } from './quota.js'

/**
 * Lessons for the agent (LIV-142): short instructions per design kind that an admin writes, or asks Claude to draft
 * from a batch of 👎s, then approves. Nothing is live until approved; an approved lesson that is on goes with every new
 * prompt of its kind (the job's `lessons`, which the worker adds to its instructions). The live lessons of a kind are
 * bounded so prompts don't balloon.
 */

export const LESSON_KINDS = ['wearable', 'emote', 'scene'] as const
export type LessonKind = typeof LESSON_KINDS[number]
export const LESSON_MAX = 500
/** The live lessons of one kind, all together. */
export const LESSONS_TOTAL_MAX = 4000

export type Lesson = typeof studioLessons.$inferSelect

export class LessonError extends Error {
  constructor(public status: number, public code: string) { super(code) }
}

export const isLessonKind = (k: unknown): k is LessonKind => (LESSON_KINDS as readonly unknown[]).includes(k)

const live = (l: Pick<Lesson, 'status' | 'enabled'>) => l.status === 'approved' && l.enabled

/** The texts sent with a new prompt of this kind, oldest first. */
export async function liveLessons(kind: string, exec: Exec = db): Promise<string[]> {
  const rows = await exec.select({ text: studioLessons.text }).from(studioLessons)
    .where(and(eq(studioLessons.kind, kind), eq(studioLessons.status, 'approved'), eq(studioLessons.enabled, true)))
    .orderBy(asc(studioLessons.createdAt), asc(studioLessons.id))
  return rows.map((r) => r.text)
}

export function publicLesson(l: Lesson) {
  return {
    id: l.id, kind: l.kind, text: l.text, status: l.status, enabled: l.enabled, live: live(l), drafted: l.drafted,
    sourceRatingIds: l.sourceRatingIds, createdBy: l.createdBy, updatedBy: l.updatedBy, approvedBy: l.approvedBy,
    approvedAt: l.approvedAt, createdAt: l.createdAt, updatedAt: l.updatedAt,
  }
}

/** Every lesson, newest first, with how much of each kind's room the live ones use. */
export async function listLessons(kind: LessonKind | null) {
  const rows = await db.select().from(studioLessons)
    .where(kind ? eq(studioLessons.kind, kind) : undefined)
    .orderBy(desc(studioLessons.createdAt), desc(studioLessons.id))
  const used = Object.fromEntries(LESSON_KINDS.map((k) => [k, 0])) as Record<LessonKind, number>
  for (const l of await db.select().from(studioLessons)) if (live(l) && isLessonKind(l.kind)) used[l.kind] += l.text.length
  return { lessons: rows.map(publicLesson), used, limit: LESSONS_TOTAL_MAX, lessonMax: LESSON_MAX }
}

/** A lesson's text as stored: trimmed, 1 to LESSON_MAX characters; null when it isn't. */
export function lessonText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.trim().replace(/\s+/g, ' ')
  return t && t.length <= LESSON_MAX ? t : null
}

/** The 👎s a lesson came from: all of them of `kind`. */
async function checkSources(kind: LessonKind, ids: string[]) {
  if (!ids.length) return
  const rows = await db.select({ id: studioRatings.id, kind: studioRatings.kind, rating: studioRatings.rating }).from(studioRatings)
    .where(inArray(studioRatings.id, ids))
  if (rows.length !== ids.length || rows.some((r) => r.kind !== kind || r.rating !== 'down')) throw new LessonError(400, 'unknown_ratings')
}

export async function createLesson(
  adminId: string, input: { kind: LessonKind; text: string; sourceRatingIds: string[]; drafted: 'admin' | 'claude' }, now: Date,
) {
  await checkSources(input.kind, input.sourceRatingIds)
  const [l] = await db.insert(studioLessons).values({
    kind: input.kind, text: input.text, sourceRatingIds: input.sourceRatingIds, drafted: input.drafted,
    createdBy: adminId, updatedBy: adminId, createdAt: now, updatedAt: now,
  }).returning()
  return publicLesson(l)
}

/**
 * An edit, a switch on or off, or approving a draft. A change that would put the kind's live lessons past
 * LESSONS_TOTAL_MAX is refused (lessons_too_long). An approved lesson stays approved: it can't go back to a draft.
 */
export async function updateLesson(
  id: string, adminId: string, change: { text?: string; enabled?: boolean; approve?: boolean }, now: Date,
) {
  return db.transaction(async (tx) => {
    const [l] = await tx.select().from(studioLessons).where(eq(studioLessons.id, id)).for('update')
    if (!l) throw new LessonError(404, 'lesson_not_found')
    const next = {
      text: change.text ?? l.text,
      enabled: change.enabled ?? l.enabled,
      status: change.approve ? 'approved' : l.status,
    }
    if (live(next)) {
      // One change to a kind's live lessons at a time, so two approvals can't both fit in the room one of them leaves
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`studio-lessons:${l.kind}`}))`)
      const others = await tx.select({ text: studioLessons.text }).from(studioLessons)
        .where(and(eq(studioLessons.kind, l.kind), eq(studioLessons.status, 'approved'), eq(studioLessons.enabled, true), ne(studioLessons.id, l.id)))
      if (others.reduce((n, o) => n + o.text.length, 0) + next.text.length > LESSONS_TOTAL_MAX) throw new LessonError(409, 'lessons_too_long')
    }
    const [u] = await tx.update(studioLessons).set({
      ...next, updatedBy: adminId, updatedAt: now,
      ...(change.approve && l.status !== 'approved' ? { approvedBy: adminId, approvedAt: now } : {}),
    }).where(eq(studioLessons.id, id)).returning()
    return publicLesson(u)
  })
}

/** Discarding a draft, or removing a lesson for good. */
export async function deleteLesson(id: string): Promise<boolean> {
  return (await db.delete(studioLessons).where(eq(studioLessons.id, id)).returning({ id: studioLessons.id })).length > 0
}

