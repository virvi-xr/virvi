// Studio tools: read the user's designs, usage and finalize quotes, start a design, and send a prompt. Sending a
// prompt is paid (it uses the user's Studio allowance), so it is only ever offered as a confirmation card. Finalizing
// is never called here: open_finalize (local.ts) links to the page that does it.
import { z } from 'zod'
import { id, pick } from './read.js'
import { get } from './write.js'
import type { Before, ToolCtx, ToolDef } from './types.js'

type Obj = Record<string, any>
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v : [])

/** The prompt route's own limit (MAX_PROMPT in routes/studio.ts). */
const MAX_PROMPT = 4000
const KINDS = ['wearable', 'emote', 'scene'] as const
const AGENTS = ['claude', 'codex', 'grok'] as const
/** A design's kind as the user says it: a scene design is a building (with its furniture). */
const KIND_WORD: Record<(typeof KINDS)[number], string> = { wearable: 'a wearable', emote: 'an emote', scene: 'a building' }

export const NO_PROMPTS = 'No Studio prompts left. They reset at midnight UTC, or the user can buy more.'
export const FIX_CHECKS_FREE = "This one is free: fixing what the checker found doesn't use your prompts."
const BUY_PROMPTS = { label: 'Buy Studio prompts', href: '/studio' }

const designArgs = z.object({ designId: id() })
const none = z.object({})
const prompts = (n: number) => `${n} prompt${n === 1 ? '' : 's'}`

/** The line a prompt card shows: which allowance it uses, in the order the server spends them (daily, gifted, bought). */
export function promptCost(u: Obj): { detail: string } | { blocked: string; link: typeof BUY_PROMPTS } {
  const left = Number(u.promptsLeft) || 0
  const credits = Number(u.credits) || 0
  const gifted = Number(u.giftedPrompts) || 0
  const daily = left - credits - gifted
  if (daily > 0) return { detail: `Uses 1 of your ${prompts(daily)} left today.` }
  if (gifted > 0) return { detail: `Uses 1 gifted prompt (${gifted} left).` }
  if (credits > 0) return { detail: `Uses 1 bought prompt (${credits} left).` }
  return { blocked: NO_PROMPTS, link: BUY_PROMPTS }
}

const design = async (ctx: ToolCtx, designId: string): Promise<Obj> => (await get(ctx, `/api/studio/designs/${designId}`)).design ?? {}

export const STUDIO_TOOLS: ToolDef<any>[] = [
  {
    name: 'list_designs',
    description: "The user's Studio designs (their own and ones shared with them): wearables, emotes and buildings (kind scene).",
    input: none,
    effect: 'read',
    call: () => ({ method: 'GET', url: '/api/studio/designs' }),
    label: () => 'List your Studio designs',
    summarize: (res) => list(res).map((d) => pick(d, ['id', 'name', 'kind', 'status'])),
  },
  {
    name: 'get_design',
    description:
      "One Studio design: its pieces and their latest revision (with the checker's result), its last 5 revisions, the job running now (activeJob, null when none) and how the last prompt ended (lastPrompt).",
    input: designArgs,
    effect: 'read',
    call: (a) => ({ method: 'GET', url: `/api/studio/designs/${a.designId}` }),
    label: () => 'Read the Studio design',
    summarize: (res) => {
      const r = (res ?? {}) as Obj
      return {
        ...pick(r.design, ['id', 'name', 'kind', 'status']),
        pieces: list(r.pieces).map((p) => ({
          ...pick(p, ['category', 'name']),
          revision: p.revision ? { ...pick(p.revision, ['number', 'changeKind']), checker: pick(p.revision.checker, ['pass', 'failures', 'warnings']) } : null,
        })),
        revisions: list(r.revisions).slice(-5).map((v) => pick(v, ['jobId', 'categories', 'current'])),
        activeJob: r.activeJob ? pick(r.activeJob, ['type', 'status', 'phase', 'progress', 'createdAt']) : null,
        lastPrompt: r.lastPrompt ?? null,
      }
    },
  },
  {
    name: 'get_studio_usage',
    description: "The user's Studio prompts left (today's plus gifted plus bought), when today's reset, and their free finalizes.",
    input: none,
    effect: 'read',
    call: () => ({ method: 'GET', url: '/api/studio/usage' }),
    label: () => 'Check your Studio prompts',
    summarize: (res) => pick(res as Obj, ['promptsLeft', 'giftedPrompts', 'credits', 'resetsAt', 'freeFinalizes']),
  },
  {
    name: 'create_design',
    description:
      "Start a new Studio design: a wearable, an emote, or a building with furniture (kind scene). It is empty until a prompt is sent. agent is left out unless the user names one.",
    input: z.object({ kind: z.enum(KINDS), name: z.string().trim().min(1).max(80), agent: z.enum(AGENTS).optional() }),
    effect: 'write',
    call: async (a, ctx) => {
      const agent = a.agent ?? (await get(ctx, '/api/studio/defaults')).agents?.[a.kind] ?? 'claude'
      return { method: 'POST', url: '/api/studio/designs', body: { kind: a.kind, name: a.name, agent } }
    },
    // Undoing a create would be a delete (archive), which the assistant doesn't do
    before: async (): Promise<Before> => ({ undo: null, after: (res) => pick(res as Obj, ['id', 'name']), orgName: null }),
    label: (a) => `Start ${KIND_WORD[a.kind as (typeof KINDS)[number]]} design "${a.name}"`,
    summarize: (res) => pick(res as Obj, ['id', 'name', 'kind', 'agent', 'status']),
  },
  {
    name: 'send_studio_prompt',
    description:
      "Send a prompt to a Studio design's agent: text (what to make or change), or fixChecks: true to have it fix what the checker found (free). Exactly one of them. selectedSlots (wearables only) are the wearable categories it should work on. The user sees a card with its cost and confirms it first.",
    input: z
      .object({
        designId: id(),
        text: z.string().trim().min(1).max(MAX_PROMPT).optional(),
        fixChecks: z.boolean().optional(),
        selectedSlots: z.array(z.string().max(32)).min(1).max(20).optional(),
      })
      .refine((a) => (a.text !== undefined) !== (a.fixChecks === true), 'Give exactly one of text or fixChecks: true.'),
    effect: 'paid',
    call: (a) => ({
      method: 'POST',
      url: `/api/studio/designs/${a.designId}/prompts`,
      body: a.fixChecks ? { fixChecks: true } : pick(a, ['text', 'selectedSlots']),
    }),
    // The design must be the user's to work on: the route's refusal otherwise
    before: async (a, ctx): Promise<Before> => {
      await design(ctx, a.designId)
      return { undo: null, after: (res) => pick(res as Obj, ['jobId']), orgName: null }
    },
    preview: async (a, ctx) => {
      const name = (await design(ctx, a.designId)).name
      const cost = a.fixChecks ? { detail: FIX_CHECKS_FREE } : promptCost(await get(ctx, '/api/studio/usage'))
      return 'blocked' in cost ? cost : { detail: `"${name}": ${cost.detail}` }
    },
    label: () => 'Send a Studio prompt',
    summarize: (res) => pick(res as Obj, ['jobId']),
  },
  {
    name: 'get_finalize_quote',
    description:
      "What finalizing a Studio design's pieces would cost now: each line's price in cents (gift: paid by a free finalize), the total, Virvi credit applied and what is due. The assistant never finalizes: use open_finalize to link the user to it.",
    input: designArgs,
    effect: 'read',
    call: (a) => ({ method: 'GET', url: `/api/studio/designs/${a.designId}/finalize` }),
    label: () => 'Check the finalize price',
    summarize: (res) => {
      const q = (res ?? {}) as Obj
      return {
        ...pick(q, ['totalCents', 'creditCents', 'dueCents', 'giftsUsed', 'blocked', 'notes']),
        lines: list(q.lines).map((l) => pick(l, ['category', 'pieceName', 'revisionNumber', 'priceKind', 'amountCents', 'waived', 'gift', 'creditCents'])),
      }
    },
  },
]
