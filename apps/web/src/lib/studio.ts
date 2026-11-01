/**
 * Design Studio: the page's types (the server's JSON, from apps/server/src/routes/studio.ts and studio/*.ts), its
 * copy, and the pure decisions the studio pages make. Kept free of React so it tests in node.
 */
import type { Tone } from '@/components/ui'

export type StudioKind = 'wearable' | 'emote'
export type StudioAgent = 'claude' | 'codex' | 'grok'

export type StudioUsage = {
  plan: string
  promptsLeft: number
  credits: number
  allowance: number
  resetsAt: string
  openDesigns: number
  openDesignLimit: number | null
  topup: { cents: number; prompts: number }
  paused: boolean
  giftedPrompts: number
  freeFinalizes: { available: number; held: number }
}

export type StudioDesign = {
  id: string
  name: string
  kind: StudioKind
  agent: string
  status: 'idle' | 'building' | string
  archivedAt: string | null
  lastJobAt: string | null
  finalizedAt: string | null
  createdAt: string
}

export type Checker = { pass: boolean; failures: number; warnings: number } | null

export type StudioView = { status: 'queued' | 'ready' | 'failed' | string; frames: number; urls: string[]; renderedAt: string }

export type FinalizedRevision = {
  revision: number
  kind: 'first' | 'revision'
  status: 'packaging' | 'ready' | 'failed' | string
  amountCents: number
  paymentId: string
  paidAt: string | null
  report: { status: 'pending' | 'refunded' | 'waived' | 'in_review' | 'declined' | string; createdAt: string } | null
  reportableUntil: string | null
}

export type StudioPiece = {
  id: string
  category: string
  name: string
  revision: { number: number; changeKind: string; checker: Checker; createdAt: string } | null
  renders: Record<string, StudioView>
  finalized: FinalizedRevision[]
}

export type StudioProposal = { slots: { category: string; recommended: boolean; reason?: string }[] }

export type StudioMessage = {
  id: string
  role: 'user' | 'agent' | 'system'
  agent: string | null
  text: string
  proposal: StudioProposal | null
  jobId: string | null
  createdAt: string
}

/** A clipping fix's emote view (the server's `fixClipping`). */
export type FixClipping = { emote: string; bodyShape: 'male' | 'female'; outfit: string }

/** An emote view with every piece worn, rendered at `fps`. */
export type StudioSetView = StudioView & { fps: number | null }

/** The emote step: views and checks for the pieces as they are now (`revisions`). */
export type StudioSet = {
  revisions: string
  views: Record<string, StudioSetView>
  checks: { emote: string; bodyShape: string; state: 'fine' | 'clipping' | string }[]
  freeFixesLeft: Record<string, number>
}

export type StudioDetail = {
  design: StudioDesign
  pieces: StudioPiece[]
  messages: StudioMessage[]
  activeJob: { id: string; type: 'prompt' | 'render' | 'finalize' | string; status: string; fixClipping?: FixClipping | null } | null
  set: StudioSet
  lastPrompt: { jobId: string; outcome: string | null; status: string } | null
  uploads: StudioUpload[]
}

/** A file the owner gave the agent (the server's `publicUpload`). */
export type StudioUpload = { id: string; name: string; kind: 'image' | 'model'; contentType: string; size: number; createdAt: string }

export type QuoteLine = {
  category: string
  revisionId: string
  revisionNumber: number
  pieceName: string
  priceKind: 'first' | 'first_extra' | 'revision' | 'revision_extra'
  amountCents: number
  waived: boolean
  held?: boolean
  gift?: boolean // free through a gift code
}

export type Quote = {
  pieces: { category: string; name: string; revisionNumber: number; state: 'payable' | 'entitled' | 'blocked' | 'none'; kind: 'first' | 'revision'; checker: Checker }[]
  lines: QuoteLine[]
  totalCents: number
  blocked: string[]
  giftsUsed: number
  reportsHeld: string[] // pieces whose mistake report would wait for the team rather than be waived
  notes: string[]
}

/** What the room sends (apps/server/src/studio/events.ts). */
export type StudioEvent =
  | { type: 'progress'; jobId: string; text: string }
  | { type: 'phase'; jobId: string; phase: string }
  | { type: 'job'; jobId: string; status: 'queued' | 'taken' | 'done' | 'failed'; outcome?: string; error?: string }

export type RenderView = { bodyShape: 'male' | 'female'; outfit: 'default' | 'outfit-2' | 'outfit-3'; emote: string | null }

export const AGENTS: { id: StudioAgent; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'grok', label: 'Grok Build' },
]

/** Preselected on a new design: the cheapest agent to run. */
export const DEFAULT_AGENT: StudioAgent = 'codex'

/** The agents a "Change agent" menu offers: all but the selected one. */
export const otherAgents = (value: string) => AGENTS.filter((a) => a.id !== value)

export const agentLabel = (id: string | null | undefined) => AGENTS.find((a) => a.id === id)?.label ?? id ?? 'Agent'

/** `upper_body` → `upper body`. */
export const categoryLabel = (category: string) => category.replace(/_/g, ' ')

function joinAnd(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** `2900` → `$29`, `1950` → `$19.50`. */
export function formatCents(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`
}

/** Time left until `resetsAt`: `3 h 20 min`, or `20 min` under an hour. */
export function untilReset(resetsAt: string, now: Date): string {
  const mins = Math.max(0, Math.round((new Date(resetsAt).getTime() - now.getTime()) / 60_000))
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`
}

export type Refusal = { text: string; action?: 'topup' | 'settings' | 'fix' }

const UNSUPPORTED_FILE = 'That file type can’t be used. Upload an image (PNG, JPEG, WebP, GIF, TIFF, AVIF or SVG) or a 3D file (GLB, VRM, FBX, OBJ, STL or .blend).'
const FILE_TOO_LARGE = 'That file is too big: images can be up to 20 MB, 3D files up to 25 MB.'

/** A refused request in the page's words, keyed by the server's `code`. */
export function refusalMessage(
  err: { status?: number; body?: { code?: string; resetsAt?: string; categories?: string[]; emote?: string } },
  now: Date,
): Refusal {
  const b = err.body ?? {}
  switch (b.code) {
    case 'allowance':
      return {
        text: `You’ve used today’s prompts. More at midnight UTC${b.resetsAt ? ` (in ${untilReset(b.resetsAt, now)})` : ''}.`,
        action: 'topup',
      }
    case 'cost_ceiling':
      return { text: 'The studio needs a rest for today. Come back tomorrow.' }
    case 'busy':
      return { text: 'The agent is still working on your last message.' }
    case 'clipping_fix_limit':
      return { text: `We’ve tried to fix the clipping in ${emoteLabel(b.emote === OWN_EMOTE ? 'emote' : 'wearable', b.emote ?? 'emote')} twice. Describe what you see in a prompt and the agent will take another look.` }
    case 'not_seen':
      return { text: 'Play that emote first, then report what you see.' }
    case 'open_design_limit':
      return { text: 'Your plan has room for one open design. Archive or finalize the one you have, or upgrade.', action: 'settings' }
    case 'checks_failed':
      return {
        text: `${joinAnd((b.categories ?? []).map(categoryLabel)) || 'A piece'} failed the checker. Ask the agent to fix it: it doesn’t use a prompt.`,
        action: 'fix',
      }
    case 'payments_unavailable':
      return { text: 'Payments aren’t available right now.' }
    case 'stripe_error':
      return { text: 'Stripe didn’t answer. Try again in a moment.' }
    case 'free_finalize_busy':
      return { text: 'Your free finalize is held by another checkout. Try again in a few minutes.' }
    case 'unsupported_file':
      return { text: UNSUPPORTED_FILE }
    case 'file_too_large':
      return { text: FILE_TOO_LARGE }
    case 'image_too_large':
      return { text: 'That image has more pixels than the studio can use (64 megapixels at most). Save a smaller copy and try again.' }
    case 'too_many_uploads':
      return { text: 'A design holds up to 12 files. Remove one to add another.' }
    default:
      // The server's own body-size limit answers 413 without a code
      return { text: err.status === 413 ? FILE_TOO_LARGE : 'Something went wrong. Try again.' }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The design id of `/studio/<id>/`: the static export has one page for every design, so the id comes from the URL. */
export function designIdFromPath(pathname: string, param?: string): string | null {
  if (param && param !== '_' && UUID.test(param)) return param
  const m = /^\/studio\/([^/]+)\/?$/.exec(pathname)
  return m && UUID.test(m[1]) ? m[1] : null
}

/** Signed frame URLs last at least an hour: the page re-reads the design every 45 minutes it stays open. */
export const FRAME_REFRESH_MS = 45 * 60_000

export const refreshDue = (fetchedAt: number, now: number) => now - fetchedAt >= FRAME_REFRESH_MS

export function designBadge(d: StudioDesign): { label: string; tone: Tone } {
  if (d.archivedAt) return { label: 'Archived', tone: 'neutral' }
  if (d.finalizedAt) return { label: 'Finalized', tone: 'success' }
  if (d.status === 'building') return { label: 'Building', tone: 'info' }
  return { label: 'Draft', tone: 'violet' }
}

/** `5 min ago`, `3 h ago`, `2 days ago`. */
export function relativeTime(iso: string, now: Date): string {
  const mins = Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  if (mins < 24 * 60) return `${Math.floor(mins / 60)} h ago`
  const days = Math.floor(mins / (24 * 60))
  return `${days} ${days === 1 ? 'day' : 'days'} ago`
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** `free plan · 3 prompts left today`, plus `· 7 bought` with bought prompts and `· 1 free finalize` with gifted ones. */
export function usageLine(u: StudioUsage): string {
  const { available, held } = u.freeFinalizes
  return `${u.plan} plan · ${u.promptsLeft} prompts left today${u.credits > 0 ? ` · ${u.credits} bought` : ''}`
    + (available > 0 ? ` · ${plural(available, 'free finalize', 'free finalizes')}` : '')
    + (held > 0 ? ` · ${plural(held, 'free finalize', 'free finalizes')} held by an open checkout` : '')
}

/** A refused gift-code redemption in the page's words (the server answers `{ error: code }`, 429 when rate-limited). */
export function giftRedeemMessage(err: { status?: number; body?: { error?: string } }): string {
  if (err.status === 429) return 'Too many tries. Try again in an hour.'
  switch (err.body?.error) {
    case 'unknown_code': return "That code isn't right. Check it and try again."
    case 'code_off': return 'That code has been turned off.'
    case 'code_expired': return 'That code has expired.'
    case 'code_used_up': return 'That code has been used up.'
    case 'already_redeemed': return "You've already used that code."
  }
  return err.status === 400 ? "That code isn't right. Check it and try again." : 'Something went wrong. Try again.'
}

/** `Added 20 prompts and 1 free finalize.`; a zero part is left out. */
export function giftRedeemSuccess(g: { prompts: number; finalizes: number }): string {
  const parts = [
    ...(g.prompts > 0 ? [plural(g.prompts, 'prompt', 'prompts')] : []),
    ...(g.finalizes > 0 ? [plural(g.finalizes, 'free finalize', 'free finalizes')] : []),
  ]
  return `Added ${parts.join(' and ')}.`
}

const PHASES: Record<string, string> = {
  building: 'Building…',
  checking: 'Running the checks…',
  rendering: 'Rendering the preview…',
  saving: 'Saving…',
  packaging: 'Packaging your files…',
}

/** A worker path (`/work/…`, `/opt/…`, `/tmp/…`) shortened to its last segment. */
const shortenPaths = (text: string) => text.replace(/\/(?:work|opt|tmp)\/\S+/g, (p) => p.split('/').filter(Boolean).pop() ?? p)

/**
 * The line under the "agent is working" bubble: the job's newest event the page shows. The agent's notes show; its
 * commands (`Running: …`) don't; a phase shows in plain words.
 */
export function progressFor(events: StudioEvent[], jobId: string): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.jobId !== jobId) continue
    if (e.type === 'progress' && e.text.trim() && !e.text.startsWith('Running:')) return shortenPaths(e.text.trim())
    if (e.type === 'phase' && PHASES[e.phase]) return PHASES[e.phase]
  }
  return null
}

export const initialTicks = (proposal: StudioProposal) =>
  new Set(proposal.slots.filter((s) => s.recommended).map((s) => s.category))

/** The ticked slots in the proposal's order: the server refuses an empty `selectedSlots`, so none ticked can't build. */
export function slotSelection(proposal: StudioProposal, ticked: Set<string>): { canBuild: boolean; slots: string[] } {
  const slots = proposal.slots.map((s) => s.category).filter((c) => ticked.has(c))
  return { canBuild: slots.length > 0, slots }
}

/** When to re-read the design: often while a job runs and the room is down, rarely while the room carries it. */
export function nextPoll(detail: StudioDetail, connected: boolean): number | null {
  if (!detail.activeJob) return null
  return connected ? 30_000 : 5_000
}

export type ComposerMode = 'send' | 'busy' | 'continue' | 'out' | 'archived' | 'paused'

export const PAUSED_NOTE = 'Your studio access is paused, so you can’t send new messages. You can still finalize and download your designs. Contact support@virvi.io.'

/** After a cost or step-limit stop the person may press Continue (free) or send something new instead. */
export const canSend = (mode: ComposerMode) => mode === 'send' || mode === 'continue'

/** A job starting (maybe from another tab) or ending changes the design: re-read it. Progress doesn't. */
export const reloadsOn = (e: StudioEvent) =>
  e.type === 'job' && (e.status === 'queued' || e.status === 'done' || e.status === 'failed')

export function composerState(detail: StudioDetail, usage: StudioUsage | null, now: Date): { mode: ComposerMode; note: string } {
  const note = usage ? `${usage.promptsLeft} prompts left today · ${usage.plan} plan` : ''
  if (detail.design.archivedAt) return { mode: 'archived', note: 'This design is archived. Unarchive it to keep working on it.' }
  if (usage?.paused) return { mode: 'paused', note: PAUSED_NOTE }
  if (detail.activeJob?.type === 'prompt') return { mode: 'busy', note: 'The agent is still working on your last message.' }
  if (detail.lastPrompt?.outcome === 'ceiling' || detail.lastPrompt?.outcome === 'turns') return { mode: 'continue', note }
  if (usage && usage.promptsLeft <= 0) return { mode: 'out', note: refusalMessage({ body: { code: 'allowance', resetsAt: usage.resetsAt } }, now).text }
  return { mode: 'send', note }
}

/** The server's view key, `<mode>-<bodyShape>-<outfit>[-<emote>]` (apps/server/src/studio/designs.ts `viewKey`). */
export function viewKey(kind: string, view: RenderView): string {
  return `${kind === 'emote' ? 'emote' : 'spin'}-${view.bodyShape}-${view.outfit}${view.emote ? `-${view.emote}` : ''}`
}

const mod = (n: number, m: number) => ((n % m) + m) % m

export const EMOTES = ['idle', 'wave', 'dance', 'clap', 'walk', 'run', 'jump'] as const
/** An emote design's emote view plays its own animation. */
export const OWN_EMOTE = 'own'
export const STEPS = ['design', 'inspect', 'avatar', 'emotes', 'finalize'] as const
export type Step = typeof STEPS[number]
export const STEP_LABELS: Record<Step, string> = { design: 'Design', inspect: 'Inspect', avatar: 'On avatar', emotes: 'Emotes', finalize: 'Finalize' }

/** An emote design has nothing to inspect without the avatar. */
export const stepsFor = (kind: string): Step[] => STEPS.filter((s) => kind !== 'emote' || s !== 'inspect')

/** `the dance`, or `the emote` for an emote design's own. */
export const emoteLabel = (kind: string, emote: string) => kind === 'emote' || emote === OWN_EMOTE ? 'the emote' : `the ${emote}`

export const orbitKey = (bodyShape: string) => `orbit-${bodyShape}`

/** The server's emote view key, `walk-<bodyShape>-<outfit>-<emote|own>` (apps/server/src/studio/designs.ts `setViewKey`). */
export const setViewKey = (kind: string, view: RenderView) =>
  `walk-${view.bodyShape}-${view.outfit}-${kind === 'emote' ? OWN_EMOTE : view.emote}`

/** Inspect's grid: 24 columns round, and on screen seven rows from straight down (0°) to straight up (180°). */
export const ORBIT_COLS = 24
export const ORBIT_FRAMES = 122
const ORBIT_ROWS = [90, 60, 120, 30, 150] // the worker's row order (CONTRACT.md `orbit-<bodyShape>`)
const SCREEN_ROWS = [0, 30, 60, 90, 120, 150, 180]
export const EYE_LEVEL_ROW = 3

const gridFrame = (deg: number, col: number) => deg === 0 ? 120 : deg === 180 ? 121 : ORBIT_ROWS.indexOf(deg) * ORBIT_COLS + col

/** The frame for an on-screen row and column, or the nearest row's that has rendered (with only the ring, the ring). */
export function orbitFrame(row: number, col: number, frames: number): number {
  const order = SCREEN_ROWS.map((_, r) => r).sort((a, b) => Math.abs(a - row) - Math.abs(b - row) || b - a)
  for (const r of order) {
    const i = gridFrame(SCREEN_ROWS[r], col)
    if (i < frames) return i
  }
  return 0
}

/** Where a drag lands: one width is a full turn (the item turns with the cursor), one height spans top to bottom. */
export function orbitDrag(start: { row: number; col: number }, dx: number, dy: number, width: number, height: number): { row: number; col: number } {
  const col = width > 0 ? mod(start.col - Math.round((dx / width) * ORBIT_COLS), ORBIT_COLS) : start.col
  const steps = height > 0 ? Math.round((dy / height) * (SCREEN_ROWS.length - 1)) : 0
  return { row: Math.max(0, Math.min(SCREEN_ROWS.length - 1, start.row - steps)), col }
}

export type EmoteState = 'unchecked' | 'fine' | 'clipping' | 'fixing'

/** The emotes a design is checked in: the base ones, or an emote design's own. */
export const checkedEmotes = (kind: string): string[] => kind === 'emote' ? [OWN_EMOTE] : [...EMOTES]

/** Where an emote stands on a body shape: being fixed, said to clip, looks fine, or not looked at yet. */
export function emoteState(detail: StudioDetail, emote: string, bodyShape: string): EmoteState {
  if (detail.activeJob?.type === 'prompt' && detail.activeJob.fixClipping?.emote === emote) return 'fixing'
  const c = detail.set.checks.find((x) => x.emote === emote && x.bodyShape === bodyShape)
  return c?.state === 'fine' || c?.state === 'clipping' ? c.state : 'unchecked'
}

/** Finalize's checklist: every emote on both body shapes, and how many the person has looked at. */
export function emoteChecklist(detail: StudioDetail): { rows: { emote: string; bodyShape: 'male' | 'female'; state: EmoteState }[]; checkedCount: number } {
  const rows = checkedEmotes(detail.design.kind).flatMap((emote) => (['male', 'female'] as const)
    .map((bodyShape) => ({ emote, bodyShape, state: emoteState(detail, emote, bodyShape) })))
  return { rows, checkedCount: rows.filter((r) => r.state === 'fine' || r.state === 'clipping').length }
}

/** The frame a drag lands on: one stage width is one full turn, and the item turns the way the cursor moves. */
export function frameAt(start: number, dx: number, width: number, frames: number): number {
  if (!(width > 0) || !(frames > 0)) return start
  return mod(start - Math.round((dx / width) * frames), frames)
}

export type StageState =
  | { kind: 'frames'; urls: string[]; renderedAt: string }
  | { kind: 'rendering' }
  | { kind: 'empty'; text: string }

/** What the stage shows for a piece's view: its frames, a render in progress, or plain words, never a broken image. */
export function stageState(piece: StudioPiece | undefined, key: string, pending: Set<string>): StageState {
  if (!piece) return { kind: 'empty', text: 'The agent hasn’t built anything yet. Describe what you want on the left.' }
  const view = piece.renders[key]
  if (view?.status === 'ready' && view.urls.length > 0) return { kind: 'frames', urls: view.urls, renderedAt: view.renderedAt }
  if (pending.has(key) || view?.status === 'queued') return { kind: 'rendering' }
  if (view) return { kind: 'empty', text: 'That view didn’t render. Pick it again to retry.' }
  return { kind: 'empty', text: 'This view hasn’t been rendered yet.' }
}

/** A piece tab's status: any running prompt may change any piece. */
export function pieceTabStatus(piece: StudioPiece, detail: StudioDetail): 'ready' | 'building' | 'new' {
  if (detail.activeJob?.type === 'prompt') return 'building'
  return piece.revision ? 'ready' : 'new'
}

const UNLOCKS: Record<StudioKind, string> = {
  wearable: 'Finalize to get the GLBs, thumbnail, Builder settings, listing text, curation report, renders and a promo clip.',
  emote: 'Finalize to get the GLB, thumbnail, emote report, renders and a promo clip.',
}

/** The strip under the preview: what finalizing unlocks, its price, and the pieces the checker blocks. */
export function finalizeStrip(quote: Quote | null, kind: StudioKind): { unlocks: string; button: string | null; blocked: string | null } {
  return {
    unlocks: UNLOCKS[kind] ?? UNLOCKS.wearable,
    button: quote && quote.lines.length > 0 ? `Finalize · ${formatCents(quote.totalCents)}` : null,
    blocked: quote?.blocked.length ? refusalMessage({ body: { code: 'checks_failed', categories: quote.blocked } }, new Date()).text : null,
  }
}

export const REPORT_MIN = 10
export const REPORT_MAX = 2000

export const reportOk = (text: string) => text.trim().length >= REPORT_MIN && text.length <= REPORT_MAX

/** The checkout covers every payable piece; only reports the server will take are sent. */
export function checkoutBody(reports: Record<string, string>): { reports?: Record<string, string> } {
  const ok = Object.entries(reports).filter(([, t]) => reportOk(t)).map(([c, t]) => [c, t.trim()] as const)
  return ok.length ? { reports: Object.fromEntries(ok) } : {}
}

/**
 * The dialog's total: a gift line is free, a reported line is waived, and waiving one changes no other line's price. A report on a piece
 * past its instant refunds (`reportsHeld`) is charged, and goes to the team.
 */
export const dialogTotal = (quote: Quote, reported: string[]) =>
  quote.lines.reduce((n, l) => n + (l.gift || (reported.includes(l.category) && !quote.reportsHeld?.includes(l.category)) ? 0 : l.amountCents), 0)

export const HELD_REPORT_COPY = 'Your report is with our team. If it’s approved, this revision is refunded in full.'

/** Where a mistake report stands, when it isn't simply refunded. */
export function reportCopy(status: string): string | null {
  if (status === 'in_review' || status === 'approving') return HELD_REPORT_COPY
  if (status === 'declined') return 'Our team reviewed your report and this revision wasn’t refunded.'
  return null
}

/** Stripe's return URL carries `?payment=`: until the webhook grants it, the page says what is happening. */
const BANNER_SLOW_MS = 2 * 60_000

export type PaymentBanner = { kind: 'packaging' | 'ready' | 'failed' | 'slow'; text: string }

export function paymentBanner(searchPayment: string | null, detail: StudioDetail, startedAt: number, now: Date): PaymentBanner | null {
  if (!searchPayment) return null
  const fresh = detail.pieces.flatMap((p) => p.finalized).filter((f) => f.paymentId === searchPayment)
  if (!fresh.length) {
    return now.getTime() - startedAt > BANNER_SLOW_MS
      ? { kind: 'slow', text: 'Stripe hasn’t confirmed the payment yet. This page will update when it does.' }
      : { kind: 'packaging', text: 'Payment received. Packaging your files…' }
  }
  if (fresh.some((f) => f.status === 'packaging')) return { kind: 'packaging', text: 'Payment received. Packaging your files…' }
  if (fresh.some((f) => f.status === 'failed')) return { kind: 'failed', text: 'Packaging didn’t finish. Try again below: it’s free.' }
  return { kind: 'ready', text: 'Your files are ready below.' }
}

/** What a paid revision offers: its package (download, packaging or a free retry), and a mistake report while open. */
export function revisionActions(f: FinalizedRevision, now: Date): {
  download: boolean; retry: boolean; packaging: boolean; report: 'open' | 'done' | 'closed' | 'none'
} {
  const report = f.report ? 'done'
    : f.kind !== 'revision' || !(f.amountCents > 0) ? 'none'
      : f.reportableUntil && new Date(f.reportableUntil).getTime() > now.getTime() ? 'open'
        : 'closed'
  return { download: f.status === 'ready', retry: f.status === 'failed', packaging: f.status === 'packaging', report }
}

/**
 * Whether a view button says "Rendering…": its view is rendering, and it is either the button last picked or a view
 * other than the one shown. The shown view's other selected buttons (Male, Default under Dance) share its key but
 * didn't ask for it.
 */
export function viewButtonRendering<K extends keyof RenderView>(
  dim: K, value: RenderView[K], current: RenderView, lastPicked: keyof RenderView | null, rendering: (v: RenderView) => boolean,
): boolean {
  const next = { ...current, [dim]: value }
  return rendering(next) && (dim === lastPicked || current[dim] !== value)
}

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'tif', 'tiff', 'avif', 'svg']
const MODEL_EXTS = ['glb', 'vrm', 'fbx', 'obj', 'stl', 'blend']
const MB = 1024 * 1024

/** The file picker's accept list. */
export const UPLOAD_ACCEPT = [...IMAGE_EXTS, ...MODEL_EXTS].map((e) => `.${e}`).join(',')

/** What's wrong with a file before it's sent, by its name and size (the server checks its contents). */
export function uploadProblem(file: { name: string; size: number }): string | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(file.name)?.[1]?.toLowerCase() ?? ''
  const image = IMAGE_EXTS.includes(ext)
  if (!image && !MODEL_EXTS.includes(ext)) return UNSUPPORTED_FILE
  if (file.size > (image ? 20 : 25) * MB) return FILE_TOO_LARGE
  return null
}

/** `900 B`, `47 KB`, `3.2 MB`. */
export function formatBytesShort(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < MB) return `${Math.round(n / 1024)} KB`
  return `${(n / MB).toFixed(1)} MB`
}

/** A flagged account on the admin Studio flags page (the server's `listFlags`). */
export type AdminStudioFlag = {
  id: string
  status: 'open' | 'dismissed' | string
  openedAt: string
  closedAt: string | null
  user: { id: string; email: string | null; plan: string }
  paused: boolean
  events: { by: 'check' | 'agent' | string; category: string; note: string; message: string; designId: string | null; createdAt: string }[]
}

/** A mistake report past the piece's instant refunds, waiting for the owner (the server's `heldReports`). */
export type AdminMistakeReport = {
  id: string
  text: string
  refundCents: number
  createdAt: string
  user: { id: string; email: string | null }
  designId: string
  piece: { category: string; name: string }
  revisionNumber: number
  request: string
  before: string | null // a signed frame of the revision before, and of this one
  after: string | null
}

/** The words the user sees for each kind of turn-down (apps/server/src/studio/scope.ts CATEGORY_WORDS). */
export const SCOPE_CATEGORY_WORDS: Record<string, string> = {
  coding: 'coding help', writing: 'writing', research: 'research', chat: 'general chat', other: 'other work',
}

const dayFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

/** "3 turn-downs since Oct 28 · general chat, coding help": its events, the oldest one's day, and their kinds. */
export function flagSummary(flag: AdminStudioFlag): string {
  const n = flag.events.length
  const oldest = flag.events.reduce((min, e) => (e.createdAt < min ? e.createdAt : min), flag.events[0]?.createdAt ?? flag.openedAt)
  const kinds = [...new Set(flag.events.map((e) => SCOPE_CATEGORY_WORDS[e.category] ?? e.category))]
  return `${n} turn-down${n === 1 ? '' : 's'} since ${dayFmt.format(new Date(oldest))}${kinds.length ? ` · ${kinds.join(', ')}` : ''}`
}

/** One gift code in the admin list (the server's `listGiftCodes`); the full code is shown only when it's made. */
export type AdminGiftCode = {
  id: string
  hint: string
  note: string | null
  prompts: number
  finalizes: number
  maxUses: number
  uses: number
  expiresAt: string | null
  disabledAt: string | null
  createdAt: string
  redemptions: { email: string | null; name: string | null; at: string }[]
}

/** Where a gift code stands, in the order that matters to the admin. */
export function giftCodeStatus(c: Pick<AdminGiftCode, 'disabledAt' | 'expiresAt' | 'uses' | 'maxUses'>, now: Date): 'Off' | 'Expired' | 'Used up' | 'Active' {
  if (c.disabledAt) return 'Off'
  if (c.expiresAt && new Date(c.expiresAt) <= now) return 'Expired'
  if (c.uses >= c.maxUses) return 'Used up'
  return 'Active'
}
