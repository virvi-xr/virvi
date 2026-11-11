import { canAct } from './studio-people'
import { agentLabel, kindLabel, type ComposerMode, type Quote, type StudioAgent, type StudioDetail, type StudioKind, type StudioMessage } from './studio'

/**
 * 👍 / 👎 on Design Studio revisions (LIV-142), and what admins do with them: labels, which message a rating sits under,
 * Finalize this, and the admin page's queue, digest, lessons and per-kind default agent.
 */

export const RATING_TAGS = [
  ['mismatch', 'Doesn’t match what I asked'],
  ['broken', 'Looks broken or clipping'],
  ['size', 'Wrong size or position'],
  ['quality', 'Low quality'],
  ['slow', 'Too slow or cost too much'],
  ['other', 'Something else'],
] as const
export type RatingTag = typeof RATING_TAGS[number][0]
export const tagLabel = (t: string) => RATING_TAGS.find(([k]) => k === t)?.[1] ?? t
export const NOTE_MAX = 500

export const THANKS = 'Thanks, this helps us improve.'
export const TRY_AGAIN = 'Try again with this feedback'
export const TRY_AGAIN_NOTE = 'Free: it doesn’t use a prompt. One try per revision.'
export const UP_PROMPT = 'Glad it worked. What next?'

/** One agent reply that changed pieces (the server's `revisions`), and the owner's rating of it. */
export type StudioRevision = {
  jobId: string
  categories: string[]
  rating: 'up' | 'down' | null
  tags: RatingTag[]
  note: string | null
  tryAgain: 'available' | 'used' | null
  /** Every piece it changed is still at the revision it made: Finalize this would pay for this revision. */
  current?: boolean
}

/**
 * The revision whose rating sits under this message: a revision is shown under the last message of its job (the
 * agent's reply, or the note that followed it), once.
 */
export function revisionUnder(m: Pick<StudioMessage, 'id' | 'jobId'>, detail: Pick<StudioDetail, 'messages'> & { revisions?: StudioRevision[] }): StudioRevision | null {
  if (!m.jobId) return null
  const rev = detail.revisions?.find((r) => r.jobId === m.jobId)
  if (!rev) return null
  const last = [...detail.messages].reverse().find((x) => x.jobId === m.jobId && x.role !== 'user')
  return last?.id === m.id ? rev : null
}

/** Whether a 👎's free try-again can go now: it doesn't use a prompt, so being out of prompts doesn't stop it. */
export const canTryAgain = (mode: ComposerMode, running: boolean) => !running && (mode === 'send' || mode === 'continue' || mode === 'out')

/** Whether the reader rates: the owner and collaborators do (each their own); Virvi support sees the owner's rating and doesn't, nor does a viewer. */
export const canRate = (detail: Pick<StudioDetail, 'support' | 'role'>) => !detail.support && canAct(detail.role)

/** What a rating says to someone who can't change it (support). */
export function ratingSummary(r: Pick<StudioRevision, 'rating' | 'tags' | 'note'>): string | null {
  if (!r.rating) return null
  if (r.rating === 'up') return 'The owner rated this 👍'
  const tags = r.tags.map(tagLabel).join(', ')
  return `The owner rated this 👎${tags ? `: ${tags}` : ''}${r.note ? `. “${r.note}”` : ''}`
}

/** The body for a rating: a 👍 sends no tags or note; a 👎 its tags in a fixed order and a trimmed note. */
export function ratingBody(rating: 'up' | 'down', tags: string[] = [], note = ''): { rating: 'up' | 'down'; tags?: RatingTag[]; note?: string | null } {
  if (rating === 'up') return { rating }
  return { rating, tags: RATING_TAGS.map(([k]) => k).filter((k) => tags.includes(k)), note: note.trim() || null }
}

/** "Finalize this": the revision's pieces that can be ticked now, or null when none can (no offer then). */
export function finalizeThis(categories: string[], quote: Quote | null): string[] | null {
  if (!quote) return null
  const payable = quote.pieces.filter((p) => p.state === 'payable').map((p) => p.category)
  const mine = categories.filter((c) => payable.includes(c)).sort()
  return mine.length ? mine : null
}

export const CHANGED_LATER = 'This was changed later — finalize uses the latest version.'
export const FINALIZE_BUSY = 'You can finalize once the agent finishes.'

/**
 * What a 👍 offers besides Keep going: Finalize this with the revision's pieces ticked, only while every piece it
 * changed is still at it (else a note that finalize uses the latest version); disabled with a reason while the agent
 * works; nothing when none of its pieces can be finalized now.
 */
export function finalizeOffer(rev: Pick<StudioRevision, 'categories' | 'current'>, quote: Quote | null, busy: boolean):
  | { kind: 'finalize'; categories: string[] } | { kind: 'busy'; categories: string[]; note: string } | { kind: 'changed'; note: string } | { kind: 'none' } {
  if (rev.current === false) return { kind: 'changed', note: CHANGED_LATER }
  const categories = finalizeThis(rev.categories, quote)
  if (!categories) return { kind: 'none' }
  return busy ? { kind: 'busy', categories, note: FINALIZE_BUSY } : { kind: 'finalize', categories }
}

/** The agent a new design starts on: the admin's default for the kind, else the page's own. */
export function startingAgent(kind: StudioKind, defaults: Partial<Record<StudioKind, string | null>> | null, fallback: StudioAgent): StudioAgent {
  const d = defaults?.[kind]
  return d === 'claude' || d === 'codex' || d === 'grok' ? d : fallback
}

// ── The admin page ───────────────────────────────────────────────────────────

export type AdminRating = {
  id: string; jobId: string; tags: string[]; note: string | null; kind: string; agent: string | null; model: string | null
  prompt: string | null; costUsd: number | null; reply: string | null; handledAt: string | null; handledBy: string | null; autoCheck: boolean
  createdAt: string; updatedAt: string
  design: { id: string; name: string }
  owner: { id: string; name: string | null; email: string | null; trial: boolean }
  pieces: { category: string; name: string; number: number; views: { viewKey: string; url: string }[] }[]
}
export type ReviewFilters = { kind?: string; agent?: string; model?: string; tag?: string; handled?: '' | 'true' | 'false'; cursor?: string | null }

/** The queue's query string: each filter only when set. */
export function ratingsQuery(f: ReviewFilters): string {
  const p = new URLSearchParams()
  for (const k of ['kind', 'agent', 'model', 'tag', 'handled', 'cursor'] as const) {
    const v = f[k]
    if (v) p.set(k, v.trim())
  }
  const s = p.toString()
  return s ? `?${s}` : ''
}

/** Draft a lesson takes 👎s of one kind: the kind of the ticked ones, or why it can't. */
export function draftKind(ticked: Pick<AdminRating, 'kind'>[]): { kind: string } | { problem: string } {
  if (!ticked.length) return { problem: 'Tick the 👎s to draft a lesson from.' }
  const kinds = [...new Set(ticked.map((r) => r.kind))]
  if (kinds.length > 1) return { problem: 'Tick 👎s of one kind: a lesson is for wearables, emotes or scene pieces.' }
  if (ticked.length > 30) return { problem: 'Tick at most 30.' }
  return { kind: kinds[0] }
}

export const whoLabel = (agent: string | null, model: string | null) => `${agentLabel(agent)}${model ? ` · ${model}` : ''}`
export const costLabel = (usd: number | null) => (usd == null ? 'cost unknown' : `$${usd.toFixed(2)}`)

export type RateRow = { agent: string | null; model: string | null; up: number; down: number; total: number; rate: number; enough: boolean }
export type KindRates = { kind: string; rows: RateRow[]; leader: { agent: string | null; model: string | null; rate: number } | null }

export const pct = (x: number) => `${Math.round(x * 100)}%`
/** A row of the 👍 rates: its share, or that there aren't enough ratings yet to judge it. */
export const rateLabel = (r: RateRow, minSample: number) =>
  r.enough ? `${pct(r.rate)} 👍 of ${r.total}` : `${r.total} of ${minSample} ratings: not enough ratings yet`
/** A kind's line: who leads, or that nobody can be named yet. */
export function leaderLine(k: KindRates): string {
  if (!k.rows.length) return `${kindLabel(k.kind)}: no ratings yet`
  return k.leader ? `${kindLabel(k.kind)}: ${whoLabel(k.leader.agent, k.leader.model)} leads at ${pct(k.leader.rate)} 👍` : `${kindLabel(k.kind)}: not enough ratings yet to name a leader`
}

export type Digest = {
  week: string; from: string; to: string; minSample: number
  totals: { up: number; down: number }
  counts: { kind: string; agent: string | null; model: string | null; up: number; down: number }[]
  topTags: { tag: string; label: string; count: number }[]
  worstDesigns: { id: string; name: string | null; kind: string | null; up: number; down: number }[]
  notes: { id: string; designId: string; kind: string; agent: string | null; model: string | null; tags: string[]; note: string }[]
  autoCheckGroups: { tag: string; label: string; kind: string; count: number; ratingIds: string[] }[]
  rates: KindRates[]
}

/** The Monday (UTC) of the week holding `d`, as YYYY-MM-DD. */
export function weekStartOf(d: Date): string {
  const day = (d.getUTCDay() + 6) % 7
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10)
}
/** The week `n` weeks from `week` (a Monday). */
export const shiftWeek = (week: string, n: number) => new Date(Date.parse(`${week}T00:00:00Z`) + n * 7 * 86400_000).toISOString().slice(0, 10)
/** The last week that has ended: what the digest opens on. */
export const lastFullWeek = (now: Date) => shiftWeek(weekStartOf(now), -1)
const weekFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
/** "Nov 2 – Nov 8, 2026". */
export function weekLabel(week: string): string {
  const from = new Date(`${week}T00:00:00Z`)
  const to = new Date(from.getTime() + 6 * 86400_000)
  return `${weekFmt.format(from).replace(/, \d{4}$/, '')} – ${weekFmt.format(to)}`
}

export type AdminLesson = {
  id: string; kind: string; text: string; status: 'draft' | 'approved'; enabled: boolean; live: boolean; drafted: 'admin' | 'claude'
  sourceRatingIds: string[]; createdAt: string; updatedAt: string; approvedAt: string | null
}
export type LessonsList = { lessons: AdminLesson[]; used: Record<string, number>; limit: number; lessonMax: number; drafting: boolean }

/** A lesson's state in the list. */
export const lessonState = (l: Pick<AdminLesson, 'status' | 'enabled'>) =>
  l.status === 'draft' ? 'Draft: not sent to the agent' : l.enabled ? 'Live: sent with every new prompt' : 'Off'

/** Whether a lesson, with `text`, fits its kind's room for live lessons (its own live text counted once). */
export function lessonFits(list: Pick<LessonsList, 'used' | 'limit'>, l: Pick<AdminLesson, 'kind' | 'live' | 'text'>, text: string): boolean {
  return (list.used[l.kind] ?? 0) - (l.live ? l.text.length : 0) + text.trim().length <= list.limit
}

/** "Copy as skill lesson": the markdown bullet for dcl-avatar-skills' lessons.md. */
export const skillLesson = (kind: string, text: string) => `- **${kindLabel(kind)}:** ${text.trim()}`

export type KindDefault = { agent: string; model: string; updatedBy: string | null; updatedAt: string } | null
export type KindDefaults = { defaults: Record<string, KindDefault>; rates: KindRates[]; ratesDays: number; minSample: number; agents: string[] }
