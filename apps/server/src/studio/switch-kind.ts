import { and, eq, sql } from 'drizzle-orm'
import { studioDesigns, studioEntitlements, studioJobs, studioMessages, studioPieces, studioSetRenders } from '../db/schema.js'
import { modelFor, promptLimits } from './designs.js'
import { liveLessons } from './lessons.js'
import { pricingFacts } from './pricing.js'
import { uploadPaths } from './uploads.js'
import type { Exec } from './quota.js'

/** The kinds a design can switch between (LIV-183). Scene designs never switch. */
export const SWITCHABLE_KINDS = ['wearable', 'emote'] as const
export type SwitchableKind = typeof SWITCHABLE_KINDS[number]

export const switchedText = (kind: SwitchableKind) =>
  `This design is now ${kind === 'emote' ? 'an emote' : 'a wearable'} design. Building it now.`
export const cantSwitchText = (from: string, to: SwitchableKind) =>
  `This ${from} design already has its ${from === 'emote' ? 'emote' : 'pieces'}, so it can’t become ${to === 'emote' ? 'an emote' : 'a wearable'} design. Start a new ${to} design for that.`

type PromptJob = {
  id: string; designId: string; userId: string | null; byAdminId: string | null
  payload: unknown
}

/**
 * Why a prompt job's request to switch its design to `to` can't be applied, or null when it can: the design is a
 * wearable or emote design of the other kind, it has no pieces and nothing paid for (so nothing of the old kind is
 * left), and the request came from the person's own words (their prompt was scope-checked, or support sent it), never
 * from a switched job's rerun or the server's own prompts.
 */
export async function switchBlock(job: PromptJob, kind: string, to: SwitchableKind, exec: Exec): Promise<'kind' | 'not_asked' | 'has_pieces' | null> {
  if (!SWITCHABLE_KINDS.includes(kind as SwitchableKind) || kind === to) return 'kind'
  const payload = job.payload as { check?: boolean; switchedFrom?: string }
  if (payload.switchedFrom || !(payload.check || job.byAdminId)) return 'not_asked'
  const [{ pieces }] = await exec.select({ pieces: sql<number>`count(*)::int` }).from(studioPieces).where(eq(studioPieces.designId, job.designId))
  const [{ paid }] = await exec.select({ paid: sql<number>`count(*)::int` }).from(studioEntitlements).where(eq(studioEntitlements.designId, job.designId))
  return pieces > 0 || paid > 0 ? 'has_pieces' : null
}

/**
 * Switches the design to `to` and queues the same request again as that kind, free: it isn't counted, isn't checked
 * again (it already was) and can't switch again. Says so in the conversation. Set renders made under the old kind go.
 * Returns the new job's id; the caller starts the worker once the transaction commits.
 */
export async function switchAndRequeue(job: PromptJob, from: string, to: SwitchableKind, exec: Exec, now: Date): Promise<string> {
  const [d] = await exec.update(studioDesigns).set({ kind: to, status: 'building', lastJobAt: now })
    .where(eq(studioDesigns.id, job.designId)).returning()
  await exec.delete(studioSetRenders).where(eq(studioSetRenders.designId, job.designId))
  await exec.insert(studioMessages).values({ designId: job.designId, role: 'system', text: switchedText(to), jobId: job.id })
  const old = job.payload as Record<string, unknown>
  const lessons = await liveLessons(to, exec)
  const [next] = await exec.insert(studioJobs).values({
    designId: job.designId,
    type: 'prompt',
    payload: {
      type: 'prompt',
      kind: to,
      agent: d.agent,
      model: modelFor(d.agent),
      prompt: old.prompt,
      selectedSlots: null,
      limits: promptLimits(d.agent, to),
      render: null,
      uploads: await uploadPaths(d.id, exec),
      check: false,
      switchedFrom: from,
      ...(lessons.length ? { lessons } : {}),
      pricing: pricingFacts(to),
    },
    counted: false,
    countedDay: null,
    countedFrom: null,
    userId: job.userId,
    byAdminId: job.byAdminId,
  }).returning({ id: studioJobs.id })
  return next.id
}

export const isSwitchableKind = (k: unknown): k is SwitchableKind => SWITCHABLE_KINDS.includes(k as SwitchableKind)
