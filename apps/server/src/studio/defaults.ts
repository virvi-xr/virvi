import { db } from '../db/connection.js'
import { studioKindDefaults } from '../db/schema.js'
import { LESSON_KINDS, type LessonKind } from './lessons.js'
import { modelFor } from './designs.js'

/**
 * The agent a new design of each kind starts on (LIV-142), set by an admin from the 👍 rates; the model follows from
 * the agent (designs.ts modelFor). Never changed automatically, and a design keeps the agent it was made with. A kind
 * with no default keeps the page's own.
 */

/** The agents a default can name: not Grok, which new designs are no longer offered (the web's RETIRED_AGENTS). */
export const DEFAULT_AGENTS = ['claude', 'codex'] as const

export async function kindDefaults(): Promise<Record<LessonKind, string | null>> {
  const rows = await db.select().from(studioKindDefaults)
  return Object.fromEntries(LESSON_KINDS.map((k) => [k, rows.find((r) => r.kind === k)?.agent ?? null])) as Record<LessonKind, string | null>
}

/** Each kind's default as the admin page shows it: the agent, its model now, and who set it when. */
export async function kindDefaultsDetail() {
  const rows = await db.select().from(studioKindDefaults)
  return Object.fromEntries(LESSON_KINDS.map((k) => {
    const r = rows.find((x) => x.kind === k)
    return [k, r ? { agent: r.agent, model: modelFor(r.agent), updatedBy: r.updatedBy, updatedAt: r.updatedAt } : null]
  }))
}

export async function setKindDefault(kind: LessonKind, agent: string, adminId: string, now: Date) {
  await db.insert(studioKindDefaults).values({ kind, agent, updatedBy: adminId, updatedAt: now })
    .onConflictDoUpdate({ target: studioKindDefaults.kind, set: { agent, updatedBy: adminId, updatedAt: now } })
}
