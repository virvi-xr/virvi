import type { StudioRevision } from './studio-ratings'
/**
 * Design Studio: the page's types (the server's JSON, from apps/server/src/routes/studio.ts and studio/*.ts), its
 * copy, and the pure decisions the studio pages make. Kept free of React so it tests in node.
 */
import { formatMana, walletRejected } from './mana'
import type { Tone } from '@/components/ui'
import { blockedCopy } from './trial'
import { VIEWER_NOTE, canAct } from './studio-people'

export type StudioKind = 'wearable' | 'emote' | 'scene'

/** What the new design picker offers, and what a design's kind is called. */
export const KIND_CHOICES: [StudioKind, string][] = [['wearable', 'Wearable'], ['emote', 'Emote'], ['scene', 'Building or furniture']]
export const kindLabel = (kind: string) => KIND_CHOICES.find(([k]) => k === kind)?.[1] ?? 'Wearable'
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
  creditCents?: number // Virvi credit, in USD cents
  mana?: boolean // Pay with MANA is on (the server has a recipient)
  trial?: boolean // a signed-out visitor's trial: `left` of `allowance` prompts in total, `openDesignLimit` designs
  left?: number
}

export type StudioDesign = {
  id: string
  name: string
  kind: StudioKind
  agent: string
  status: 'idle' | 'building' | string
  archivedAt: string | null
  lastJobAt: string | null
  finalizedAt: string | null // when the first piece was finalized
  /** Of the pieces with a revision (`pieceCount`), how many have been finalized at some revision. */
  finalizedPieces?: number
  pieceCount?: number
  createdAt: string
  /** The reader's role on it (LIV-159); a design shared with them also names its owner. */
  role?: DesignRole
  ownerName?: string | null
}

/** A person's role on a design (LIV-159): the owner, a collaborator (works on it) or a viewer (looks). */
export type DesignRole = 'owner' | 'collaborator' | 'viewer'

/** Someone on a design, the owner first (the server's `designMembers`). */
export type StudioMember = { userId: string; displayName: string | null; role: DesignRole; joinedAt: string }

/** `triangles`: a scene piece over its recommended triangle count (a warning, never a block). */
export type Checker = { pass: boolean; failures: number; warnings: number; triangles?: { count: number; limit: number } | null } | null

export type StudioView = {
  status: 'queued' | 'ready' | 'failed' | string; frames: number; urls: string[]; renderedAt: string
  pending?: boolean // an Inspect view whose whole sphere is still rendering behind its ring
}

export type FinalizedRevision = {
  revision: number
  kind: 'first' | 'revision'
  status: 'packaging' | 'ready' | 'failed' | string
  /** `amountCents`, `paymentId` and the report's id, credit and MANA are null on another member's line (theirs to see). */
  amountCents: number | null
  paymentId: string | null
  paidAt: string | null
  /** `manaCents`: the refund's MANA share (now Virvi credit), which may be asked back as MANA; `manaRefund`: that request's status. */
  report: {
    status: 'pending' | 'refunded' | 'waived' | 'in_review' | 'declined' | string; createdAt: string
    id?: string | null; manaCents?: number | null; creditedCents?: number | null; manaRefund?: 'requested' | 'sent' | 'declined' | string | null
  } | null
  reportableUntil: string | null
  /** The reader paid for it (LIV-159): its report's outcome, MANA back and the 3D Models link are theirs. */
  paidByMe?: boolean
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
  /** `note`: Virvi support's note to the people on the design; it starts no agent (the agent reads it with the next prompt) */
  role: 'user' | 'agent' | 'system' | 'note'
  agent: string | null
  text: string
  proposal: StudioProposal | null
  jobId: string | null
  createdAt: string
  /** A Virvi admin wrote it, helping on the design: shown as Virvi support, never as the owner's words. */
  support?: boolean
  /** Who wrote a person's message (LIV-159); null for the agent's, a system note and support's. */
  sender?: { userId: string; displayName: string | null } | null
}

/** Whose design a Virvi admin is helping on (the server sends it only to an admin who isn't the owner). */
export type StudioSupportView = { ownerId: string; ownerName: string | null; ownerEmail: string | null; trial: boolean }

/** A clipping fix's emote view (the server's `fixClipping`). */
export type FixClipping = { emote: string; bodyShape: 'male' | 'female'; outfit: string }

/** An emote view with every piece worn, rendered at `fps`. Its frame urls come from asking for it (`requestStudioSetRender`). */
export type StudioSetView = { status: 'queued' | 'ready' | 'failed' | string; frames: number; fps: number | null; renderedAt: string }

/** The emote step: views and checks for the pieces as they are now (`revisions`). */
export type StudioSet = {
  revisions: string
  views: Record<string, StudioSetView>
  checks: { emote: string; bodyShape: string; state: 'fine' | 'clipping' | string }[]
  freeFixesLeft: Record<string, number>
}

/** The owner's wall choice; `hidden` is an admin's call, which the owner cannot clear. */
export type WallState = { shown: boolean; hidden: boolean; marketplaceUrl: string | null }

export type StudioDetail = {
  design: StudioDesign
  wall: WallState
  pieces: StudioPiece[]
  messages: StudioMessage[]
  /** `senderName`: who sent the prompt running now (null for a render, or support's prompt). `phase` and `progress`: what
   *  the worker last reported (the last 5 progress lines), for clients that poll. */
  activeJob: { id: string; type: 'prompt' | 'render' | 'finalize' | string; status: string; createdAt?: string; fixClipping?: FixClipping | null; senderName?: string | null; phase?: string | null; progress?: string[] } | null
  set: StudioSet
  lastPrompt: { jobId: string; outcome: string | null; status: string } | null
  uploads: StudioUpload[]
  /** Present when a Virvi admin is viewing someone else's design (Virvi support). */
  support?: StudioSupportView
  /** Each agent reply that changed pieces, with the owner's 👍 / 👎 (LIV-142). */
  revisions?: StudioRevision[]
  /** The usual seconds from sending a prompt to the agent's first progress line; absent until the server knows. */
  typicalFirstReplySec?: number
  /** The reader's role (null for Virvi support), and everyone on the design, the owner first (LIV-159). */
  role?: DesignRole | null
  members?: StudioMember[]
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
  gift?: boolean // paid by a gift code: the whole line, or `giftCents` of it (a scene piece's cap)
  giftCents?: number
  admin?: boolean // free: the customer is a Virvi admin
}

/** What a line costs after its gift: a scene gift covers up to its cap, a wearable or emote gift the whole line. */
const afterGift = (l: QuoteLine) => l.admin ? 0 : l.gift ? Math.max(0, l.amountCents - (l.giftCents ?? l.amountCents)) : l.amountCents

/** How each kind of checkout line is named. */
const YOURS = 'The files are yours to edit, reuse and sell, in Decentraland or anywhere else.'

/** What Finalize gives you, for the Finalize dialog (the agent is told the same, with the prices). */
export function packageSummary(kind: StudioKind): string {
  if (kind === 'emote') return `The emote plays on both body shapes. You get the animation file, a thumbnail, renders and a short clip. ${YOURS}`
  if (kind === 'scene') return `Each piece comes with its 3D file, a thumbnail, renders and, for a building, a walk-through clip. ${YOURS}`
  return 'Each piece comes in male and female versions for one price, with its 3D files, the Builder upload, a thumbnail, '
    + `renders and a short clip. ${YOURS}`
}

export const PRICE_LABEL: Record<QuoteLine['priceKind'], string> = {
  first: 'First finalize',
  first_extra: 'Extra piece',
  revision: 'Revision',
  revision_extra: 'Revision',
}

/** Why a line costs less in the checkout: a Virvi admin's, or a gift's. */
export const lineNote = (l: QuoteLine): string | null => l.admin ? 'free (Virvi admin)' : giftNote(l)

/** How a gift line reads in the checkout: free, or how much it takes off. */
export function giftNote(l: QuoteLine): string | null {
  if (!l.gift) return null
  return afterGift(l) > 0 ? `${formatCents(l.giftCents ?? 0)} off (gift code)` : 'free (gift code)'
}

export type Quote = {
  pieces: { category: string; name: string; revisionNumber: number; state: 'payable' | 'entitled' | 'blocked' | 'none'; kind: 'first' | 'revision'; checker: Checker }[]
  lines: QuoteLine[]
  totalCents: number
  creditCents: number // Virvi credit applied
  dueCents: number // left to pay by card or MANA
  blocked: string[]
  giftsUsed: number
  reportsHeld: string[] // pieces whose mistake report would wait for the team rather than be waived
  notes: string[]
}

/** A MANA payment's quote (the server's studio/mana/quote.ts): send exactly `amountWei` of `token` to `recipient` before `expiresAt`. */
export type ManaQuote = {
  paymentId: string; amountWei: string; recipient: string; token: string; chainId: 137
  usdCents: number; usdPerMana: number; expiresAt: string
}

/** What a checkout answers: Stripe's page, granted outright (credit, gifts or waivers cover it), or a MANA quote. */
export type CheckoutResult = { url: string } | { granted: true; paymentId: string } | { mana: ManaQuote }
export type CheckoutMethod = 'card' | 'mana'

/** What the room sends (apps/server/src/studio/events.ts). */
export type StudioEvent =
  | { type: 'progress'; jobId: string; text: string }
  | { type: 'phase'; jobId: string; phase: string }
  | { type: 'job'; jobId: string; status: 'queued' | 'taken' | 'done' | 'failed'; outcome?: string; error?: string; senderName?: string | null }
  | { type: 'member_removed'; userId: string }
  /** A message that started no job (a Virvi support note) */
  | { type: 'message' }

export type RenderView = { bodyShape: 'male' | 'female'; outfit: 'default' | 'outfit-2' | 'outfit-3'; emote: string | null }

export const AGENTS: { id: StudioAgent; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'grok', label: 'Grok Build' },
]

/** Preselected on a new design: the cheapest agent to run. */
export const DEFAULT_AGENT: StudioAgent = 'codex'

/** Kept for designs already on them, but no longer offered: Grok's results weren't good enough. */
const RETIRED_AGENTS: StudioAgent[] = ['grok']

/** The agents a "Change agent" menu offers: all but the selected one and the retired ones. */
export const otherAgents = (value: string) => AGENTS.filter((a) => a.id !== value && !RETIRED_AGENTS.includes(a.id))

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

const TX_MISMATCH = "That payment didn't match this order. Contact support and we'll sort it out."

const UNSUPPORTED_FILE = 'That file type can’t be used. Upload an image (PNG, JPEG, WebP, GIF, TIFF, AVIF or SVG) or a 3D file (GLB, VRM, FBX, OBJ, STL or .blend).'
const FILE_TOO_LARGE = 'That file is too big: images can be up to 20 MB, 3D files up to 25 MB.'

/** A refused request in the page's words, keyed by the server's `code`. */
export function refusalMessage(
  err: { status?: number; body?: { code?: string; error?: string; message?: string; resetsAt?: string; categories?: string[]; emote?: string; action?: string } },
  now: Date,
): Refusal {
  const b = err.body ?? {}
  // A trial closed the sign-up sheet on an account-only action: the sheet's own words
  if (b.error === 'account_required' && typeof b.action === 'string') return { text: blockedCopy(b.action, {}).title }
  // The trial's shared daily budget is spent: the server's own words
  if (b.error === 'trial_busy' && b.message) return { text: b.message }
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
    case 'viewer':
      return { text: VIEWER_NOTE }
    case 'checkout_open':
      return { text: 'Someone else on this design has a checkout open for these pieces. It clears by itself in about half an hour.' }
    case 'clipping_fix_limit':
      return { text: `We’ve tried to fix the clipping in ${emoteLabel(b.emote === OWN_EMOTE ? 'emote' : 'wearable', b.emote ?? 'emote')} twice. Describe what you see in a prompt and the agent will take another look.` }
    case 'not_seen':
      return { text: 'Play that emote first, then report what you see.' }
    case 'open_design_limit':
      return { text: 'Your plan has room for one open design. A design with pieces left to finalize still counts. Archive it or finalize the rest, or upgrade.', action: 'settings' }
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
    case 'nothing_ready':
      return { text: 'No piece has finished packaging yet. Try again in a minute.' }
    case 'too_large':
      return { text: 'These files are too big to download together. Download each piece on its own.' }
    case 'rate_unavailable':
      return { text: 'MANA pricing is unavailable right now. Try again in a minute, or pay by card.' }
    case 'mana_unavailable':
      return { text: "MANA payments aren't available." }
    case 'mana_busy':
      return { text: 'MANA checkout is busy. Try again in a moment.' }
    case 'credit_busy':
      return { text: 'An open checkout is still holding your Virvi credit. Try again in a few minutes.' }
    case 'credit_spent':
      return { text: 'That credit has already been spent.' }
    case 'tx_mismatch':
    case 'tx_late':
      return { text: TX_MISMATCH }
    case 'tx_used':
      return { text: 'That transaction has already paid for something else.' }
    case 'tx_failed':
      return { text: 'That transaction failed on Polygon, so no MANA was sent. Try again.' }
    case 'tx_not_found':
      return { text: 'Polygon doesn’t know that transaction yet. Try again in a moment.' }
    case 'not_mana':
      return { text: 'Only a refund of a MANA payment can go back as MANA.' }
    case 'not_refunded':
      return { text: 'That revision hasn’t been refunded.' }
    case 'already_requested':
      return { text: 'You’ve already asked for that refund as MANA.' }
    case 'no_wallet':
      return { text: 'Link a wallet in Settings first, so we know where to send the MANA.', action: 'settings' }
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
  if (d.finalizedAt) {
    const left = (d.pieceCount ?? 0) > (d.finalizedPieces ?? 0)
    return { label: left ? `Finalized ${d.finalizedPieces ?? 0} of ${d.pieceCount}` : 'Finalized', tone: 'success' }
  }
  if (d.status === 'building') return { label: 'Agent working', tone: 'info' }
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

/** `$15.00`: Virvi credit always shows its cents. */
export const formatCredit = (cents: number) => `$${(cents / 100).toFixed(2)}`

/**
 * `free plan · 3 prompts left today`, plus `· 7 bought` with bought prompts, `· $15.00 credit` with Virvi credit and
 * `· 1 free finalize` with gifted ones.
 */
export function usageLine(u: StudioUsage): string {
  // A trial has one allowance, not a day's: the same words as the composer note
  if (u.trial || u.plan === 'trial') return `${u.promptsLeft} of ${u.allowance} free prompts left`
  const { available, held } = u.freeFinalizes
  return `${u.plan} plan · ${u.promptsLeft} prompts left today${u.credits > 0 ? ` · ${u.credits} bought` : ''}`
    + ((u.creditCents ?? 0) > 0 ? ` · ${formatCredit(u.creditCents!)} credit` : '')
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
  building: 'Agent working…',
  screening: 'Checking your request…',
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
    if (!('jobId' in e) || e.jobId !== jobId) continue
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

export type ComposerMode = 'send' | 'busy' | 'continue' | 'out' | 'archived' | 'paused' | 'viewer'

export const PAUSED_NOTE = 'Your studio access is paused, so you can’t send new messages. You can still finalize and download your designs. Contact support@virvi.io.'

/** After a cost or step-limit stop the person may press Continue (free) or send something new instead. */
export const canSend = (mode: ComposerMode) => mode === 'send' || mode === 'continue'

/** A job starting (maybe from another tab) or ending changes the design: re-read it. Progress doesn't. */
export const reloadsOn = (e: StudioEvent) =>
  e.type === 'message' || (e.type === 'job' && (e.status === 'queued' || e.status === 'done' || e.status === 'failed'))

/** Under the message box for a Virvi admin helping on someone else's design: no allowance meter, nothing is used. */
export const SUPPORT_NOTE = 'Messages you send as Virvi support are free: they don’t use their prompts or yours.'

export function composerState(detail: StudioDetail, usage: StudioUsage | null, now: Date): { mode: ComposerMode; note: string } {
  // The viewer's own pause: the server refuses new work then, Virvi support's included
  const paused = !!usage?.paused
  // Support: otherwise the usage the page has is the admin's own, which doesn't apply here
  if (detail.support) usage = null
  const note = detail.support ? SUPPORT_NOTE : !usage ? '' : usage.trial ? `${usage.promptsLeft} of ${usage.allowance} free prompts left` : `${usage.promptsLeft} prompts left today · ${usage.plan} plan`
  // A viewer has no box at all (LIV-159)
  if (!canAct(detail.role)) return { mode: 'viewer', note: VIEWER_NOTE }
  if (detail.design.archivedAt) {
    const owner = !detail.support && (detail.role ?? 'owner') === 'owner'
    return { mode: 'archived', note: owner ? 'This design is archived. Unarchive it to keep working on it.' : 'This design is archived. Only its owner can unarchive it.' }
  }
  if (paused) return { mode: 'paused', note: PAUSED_NOTE }
  if (detail.activeJob?.type === 'prompt') return { mode: 'busy', note: 'The agent is still working on your last message.' }
  if (detail.lastPrompt?.outcome === 'ceiling' || detail.lastPrompt?.outcome === 'turns') return { mode: 'continue', note }
  if (usage && usage.promptsLeft <= 0) return { mode: 'out', note: refusalMessage({ body: { code: 'allowance', resetsAt: usage.resetsAt } }, now).text }
  return { mode: 'send', note }
}

/** The newest ready render's first frame, or null while the design has none. */
export function latestRenderUrl(detail: Pick<StudioDetail, 'pieces'>): string | null {
  let best: { at: number; url: string } | null = null
  for (const p of detail.pieces) for (const v of Object.values(p.renders ?? {})) {
    if (v.status !== 'ready' || !v.urls?.length) continue
    const at = Date.parse(v.renderedAt)
    if (!best || at > best.at) best = { at, url: v.urls[0] }
  }
  return best?.url ?? null
}

/** What a trial is told when it has one free prompt left. */
export function trialNudge(usage: StudioUsage | null): string | null {
  return usage?.trial && usage.promptsLeft === 1 ? '1 free prompt left — create an account for 3 a day' : null
}

/** What the sign-up sheet names when a trial is asked to sign up from a design: its name and the revisions made so far. */
export function trialCtx(detail: Pick<StudioDetail, 'design' | 'pieces'>): { designName: string; revisions: number } {
  return { designName: detail.design.name, revisions: detail.pieces.reduce((n, p) => n + (p.revision?.number ?? 0), 0) }
}

/** The server's view key, `<mode>-<bodyShape>-<outfit>[-<emote>]` (apps/server/src/studio/designs.ts `viewKey`). */
export function viewKey(kind: string, view: RenderView): string {
  if (kind === 'scene') return 'scale'  // a furniture piece's turn beside the mannequin
  return `${kind === 'emote' ? 'emote' : 'spin'}-${view.bodyShape}-${view.outfit}${view.emote ? `-${view.emote}` : ''}`
}

const mod = (n: number, m: number) => ((n % m) + m) % m

export const EMOTES = ['idle', 'wave', 'dance', 'clap', 'walk', 'run', 'jump'] as const
/** An emote design's emote view plays its own animation. */
export const OWN_EMOTE = 'own'
export const STEPS = ['design', 'inspect', 'avatar', 'emotes', 'tour', 'scale', 'finalize'] as const
export type Step = typeof STEPS[number]
export const STEP_LABELS: Record<Step, string> = {
  design: 'Design', inspect: 'Inspect', avatar: 'On avatar', emotes: 'Emotes', tour: 'Walk-through', scale: 'Scale', finalize: 'Finalize',
}

/**
 * An emote design has nothing to inspect without the avatar. A scene design has no avatar or emotes: a building gets
 * its walk-through and furniture its scale view, once the design has one. `viewOnly` (a viewer, LIV-159): no
 * Finalize, which is work; the other steps show what is rendered.
 */
export function stepsFor(kind: string, categories: string[] = [], viewOnly = false): Step[] {
  const shown = (s: Step) => !viewOnly || s !== 'finalize'
  if (kind === 'scene') {
    const building = categories.includes('building')
    const furniture = categories.some((c) => c.startsWith('furniture_'))
    return STEPS.filter((s) => shown(s) && (s === 'design' || s === 'inspect' || s === 'finalize' || (s === 'tour' && building) || (s === 'scale' && furniture)))
  }
  return STEPS.filter((s) => shown(s) && s !== 'tour' && s !== 'scale' && (kind !== 'emote' || s !== 'inspect'))
}

/** The step a design opens on: On avatar, or Inspect for a scene design (it has no avatar). */
export const defaultStep = (kind: string): Step => kind === 'scene' ? 'inspect' : 'avatar'

/** The step to show: the one picked, while the design has it (a walk-through needs the building first). */
export const shownStep = (step: Step, kind: string, categories: string[], viewOnly = false): Step =>
  stepsFor(kind, categories, viewOnly).includes(step) ? step : defaultStep(kind)
/** The attach button's hint, with an example that fits the kind of design. */
export const uploadHint = (kind: string) =>
  `Images or 3D files for the agent. Say what each is for, like “put ${kind === 'scene' ? 'sign.png over the door' : 'logo.png on the chest'}”.`

/** The stage a step shows: a scene piece's Design step turns it as Inspect does, since a building has no scale view. */
export const stageFor = (step: Step, kind: string): Step => kind === 'scene' && step === 'design' ? 'inspect' : step

/** `the dance`, or `the emote` for an emote design's own. */
export const emoteLabel = (kind: string, emote: string) => kind === 'emote' || emote === OWN_EMOTE ? 'the emote' : `the ${emote}`

export const orbitKey = (bodyShape: string) => `orbit-${bodyShape}`
/** Inspect's view key: a scene piece has no body shape (apps/server/src/studio/designs.ts `orbitKeyFor`). */
export const orbitKeyFor = (kind: string, bodyShape: string) => kind === 'scene' ? 'orbit-scene' : orbitKey(bodyShape)

/** The server's emote view key, `walk-<bodyShape>-<outfit>-<emote|own>` (apps/server/src/studio/designs.ts `setViewKey`). */
export const setViewKey = (kind: string, view: RenderView) =>
  kind === 'scene' ? 'tour' : `walk-${view.bodyShape}-${view.outfit}-${kind === 'emote' ? OWN_EMOTE : view.emote}`

/** A scene piece's name for people: `building` → Building, `furniture_round_table` → Round table. */
export function pieceLabel(category: string): string {
  const words = category === 'building' ? 'building' : category.replace(/^furniture_/, '').replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** A piece over its recommended triangles: Decentraland only warns, so this is a note, never a block. */
export function triangleWarning(name: string, checker: Checker): string | null {
  const over = checker?.triangles
  if (!over) return null
  return `${name} has ${over.count.toLocaleString('en-US')} triangles, more than the ${over.limit.toLocaleString('en-US')} recommended. ` +
    'It still works in Decentraland, but a lighter piece leaves room for the rest of the scene.'
}

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

/** Under Inspect's frames: more angles on their way, a sphere that failed behind its ring, or nothing to say. */
export function inspectNote(view: StudioView | undefined): 'loading' | 'retry' | null {
  if (view?.status !== 'ready' || view.frames >= ORBIT_FRAMES) return null
  return view.pending ? 'loading' : 'retry'
}

export type EmoteState = 'unchecked' | 'fine' | 'clipping' | 'fixing'

/** The emotes a design is checked in: the base ones, or an emote design's own. */
export const checkedEmotes = (kind: string): string[] => kind === 'emote' ? [OWN_EMOTE] : kind === 'scene' ? [] : [...EMOTES]

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
  // A reported emote counts as checked while it is fixed too: the person looked at it
  const checked = rows.filter((r) => detail.set.checks.some((c) => c.emote === r.emote && c.bodyShape === r.bodyShape))
  return { rows, checkedCount: checked.length }
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
  scene: 'Finalize to add each piece to your 3D Models, ready to place in a scene, and get its GLB, thumbnail, renders, seats and check report.',
}

/** The strip under the preview: what finalizing unlocks, its price, and the pieces the checker blocks. */
export function finalizeStrip(quote: Quote | null, kind: StudioKind): { unlocks: string; button: string | null; blocked: string | null } {
  return {
    unlocks: UNLOCKS[kind] ?? UNLOCKS.wearable,
    button: quote && quote.lines.length > 0
      ? `Finalize · ${quote.lines.every((l) => l.admin) ? 'free (Virvi admin)' : formatCents(quote.totalCents)}` : null,
    blocked: quote?.blocked.length ? refusalMessage({ body: { code: 'checks_failed', categories: quote.blocked } }, new Date()).text : null,
  }
}

export const REPORT_MIN = 10
export const REPORT_MAX = 2000

export const reportOk = (text: string) => text.trim().length >= REPORT_MIN && text.length <= REPORT_MAX

/**
 * What the checkout is for: every payable piece (`categories` null), or the ticked ones. Only reports the server will
 * take are sent, and none for a piece left out.
 */
export function checkoutBody(reports: Record<string, string>, categories: string[] | null = null): { categories?: string[]; reports?: Record<string, string> } {
  const ok = Object.entries(reports).filter(([c, t]) => reportOk(t) && (!categories || categories.includes(c))).map(([c, t]) => [c, t.trim()] as const)
  return { ...(categories ? { categories } : {}), ...(ok.length ? { reports: Object.fromEntries(ok) } : {}) }
}

/** A piece in the Finalize dialog: ticked or not when `pickable`; otherwise disabled, with why. */
export type FinalizeChoice = { category: string; name: string; pickable: boolean; finalized: boolean; reason: string | null }

const CHOICE_REASON: Record<Quote['pieces'][number]['state'], string | null> = {
  payable: null,
  entitled: 'Finalized',
  blocked: 'Failed the checker. Ask the agent to fix it first.',
  none: 'Not built yet',
}

/** A checkbox per piece, in the quote's order. A finalized piece with a newer revision is pickable: that's a revision. */
export function finalizeChoices(quote: Quote): FinalizeChoice[] {
  return quote.pieces.map((p) => ({
    category: p.category, name: p.name, pickable: p.state === 'payable', finalized: p.state === 'entitled', reason: CHOICE_REASON[p.state] ?? null,
  }))
}

const payable = (quote: Quote) => quote.pieces.filter((p) => p.state === 'payable').map((p) => p.category)

/** Every payable piece ticked: what Finalize always paid for. */
export const initialSelection = (quote: Quote): string[] => payable(quote)

/** Ticks or unticks a piece; one that can't be finalized stays as it is. */
export function toggleSelection(selected: string[], category: string, quote: Quote): string[] {
  if (!payable(quote).includes(category)) return selected
  const next = selected.includes(category) ? selected.filter((c) => c !== category) : [...selected, category]
  return next.sort()
}

/** The ticked pieces the server is asked about, or null when they are every payable piece (the checkout as it always was). */
export function selectionCategories(selected: string[], quote: Quote): string[] | null {
  const all = payable(quote)
  const ticked = all.filter((c) => selected.includes(c))
  return ticked.length === all.length && all.length > 0 ? null : ticked
}

/** Why the dialog can't check out the selection, if it can't. */
export const selectionProblem = (selected: string[]): string | null =>
  selected.length ? null : 'Tick at least one piece to finalize.'

/** A mistake report goes with a revision line only, and only while its piece is ticked. */
export const canReport = (l: QuoteLine, selected: string[]) => l.priceKind.startsWith('revision') && selected.includes(l.category)

/** Finalize's selection while only some pieces are ticked, and its emote step (the chosen and finalized pieces worn). */
export type Worn = { categories: string[]; set: StudioSet }

/**
 * What the emote checklist and Emotes step show for Finalize's selection: null for every piece; 'none' with nothing
 * ticked; 'loading' until the selection's own set (`fetched`, keyed by its categories) is in. Never the whole set while
 * a selection is waiting, so no check is recorded against the wrong pieces.
 */
export type WornState = Worn | 'loading' | 'none' | null
export function wornState(chosen: string[] | null, fetched: { key: string; set: StudioSet } | null): WornState {
  if (!chosen) return null
  if (!chosen.length) return 'none'
  const key = chosen.join(',')
  return fetched?.key === key ? { categories: chosen, set: fetched.set } : 'loading'
}

/** The checkout page's quote refused: 'nothing_left' shows the nothing-left page (the ticked pieces were paid meanwhile). */
export function checkoutQuoteRefusal(err: { status?: number; body?: { code?: string; error?: string } }): 'nothing_left' | string {
  return err.body?.code === 'nothing_to_pay' ? 'nothing_left' : refusalMessage(err as never, new Date()).text
}

/** The design as the emote checklist and Emotes step see it: with the selection's set when there is one. */
export const wornDetail = (detail: StudioDetail, worn: Worn | null): StudioDetail => worn ? { ...detail, set: worn.set } : detail

/** Requests answered out of order: only the newest one's answer is used. */
export function latestOnly() {
  let n = 0
  return { next: () => ++n, isLatest: (id: number) => id === n }
}

/**
 * The dialog's total: a gift line is free, a reported line is waived, and waiving one changes no other line's price. A report on a piece
 * past its instant refunds (`reportsHeld`) is charged, and goes to the team.
 */
export const dialogTotal = (quote: Quote, reported: string[]) =>
  quote.lines.reduce((n, l) => n + (reported.includes(l.category) && !quote.reportsHeld?.includes(l.category) ? 0 : afterGift(l)), 0)

/**
 * The checkout page's sums: the dialog's total after gifts and waived reports, the Virvi credit applied to it (the
 * quote's credit, never more than the total) and what is left to pay.
 */
export function checkoutTotals(quote: Quote, reported: string[]): { totalCents: number; creditCents: number; dueCents: number } {
  const totalCents = dialogTotal(quote, reported)
  const creditCents = Math.min(quote.creditCents ?? 0, totalCents)
  return { totalCents, creditCents, dueCents: totalCents - creditCents }
}

/** What the checkout page pays for: a design's payable pieces (or some of them), or prompt top-up packs. */
export type CheckoutTarget = { kind: 'design'; designId: string; categories: string[] | null } | { kind: 'topup'; packs: number }

/** The checkout page's target from its query: `?design=<id>` with optional `&categories=a,b`, or `?topup=<packs>`. */
export function checkoutTarget(search: string): CheckoutTarget | null {
  const q = new URLSearchParams(search)
  const design = q.get('design')
  if (design) {
    if (!UUID.test(design)) return null
    const categories = (q.get('categories') ?? '').split(',').filter((c) => /^[a-z_]{1,32}$/.test(c))
    return { kind: 'design', designId: design, categories: categories.length ? categories : null }
  }
  const topup = q.get('topup')
  if (topup && /^[1-9][0-9]?$/.test(topup)) return { kind: 'topup', packs: Number(topup) }
  return null
}

export function checkoutHref(t: CheckoutTarget): string {
  if (t.kind === 'topup') return `/studio/checkout/?topup=${t.packs}`
  return `/studio/checkout/?design=${t.designId}${t.categories?.length ? `&categories=${t.categories.join(',')}` : ''}`
}

/** The dialog hands its mistake reports to the checkout page here (sessionStorage), keyed by design. */
export const checkoutReportsKey = (designId: string) => `virvi-studio-checkout-reports:${designId}`

/** Time left on a quote: `9:58`, never below `0:00`. */
export function countdown(expiresAt: string, now: Date): string {
  const s = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now.getTime()) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** A refunded revision's MANA-back: offered while its MANA share is credit and not yet asked for; afterwards, where it stands. */
export function manaBack(report: FinalizedRevision['report']): { offer: boolean; note: string | null } {
  const cents = report?.manaCents ?? 0
  if (!report || report.status !== 'refunded' || !(cents > 0) || !report.id) return { offer: false, note: null }
  switch (report.manaRefund ?? null) {
    case null: return { offer: true, note: null }
    case 'requested': return { offer: false, note: `We’ll send ${formatCredit(cents)} of MANA to your wallet. It can take a few days.` }
    case 'sent': return { offer: false, note: `We’ve sent ${formatCredit(cents)} of MANA to your wallet.` }
    case 'declined': return { offer: false, note: `We couldn’t send MANA back, so ${formatCredit(cents)} stays as Virvi credit.` }
    default: return { offer: false, note: null }
  }
}

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
    : f.kind !== 'revision' || !((f.amountCents ?? 0) > 0) ? 'none'
      : f.reportableUntil && new Date(f.reportableUntil).getTime() > now.getTime() ? 'open'
        : 'closed'
  return { download: f.status === 'ready', retry: f.status === 'failed', packaging: f.status === 'packaging', report }
}

/** Whether a paid revision's payer's own lines show (report outcome, MANA back, 3D Models): the reader paid, and isn't Virvi support. */
export const paidByReader = (f: Pick<FinalizedRevision, 'paidByMe'>, support: boolean) => !support && !!f.paidByMe

/**
 * The paid-downloads panel's header, from each paid piece's newest paid revision: how many are ready, still packaging
 * or failed, and whether "Download all" is offered (two or more pieces ready).
 */
export function paidSummary(pieces: StudioPiece[]): {
  paid: number; ready: number; packaging: number; failed: number; downloadAll: boolean; progress: string | null
} {
  const newest = pieces.filter((p) => p.finalized.length).map((p) => p.finalized.reduce((a, b) => (b.revision > a.revision ? b : a)))
  const ready = newest.filter((f) => f.status === 'ready').length
  const packaging = newest.filter((f) => f.status === 'packaging').length
  const failed = newest.filter((f) => f.status === 'failed').length
  return {
    paid: newest.length, ready, packaging, failed,
    downloadAll: ready >= 2,
    progress: packaging > 0 ? `${packaging} still packaging…` : null,
  }
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
  user: { id: string; email: string | null; gone: boolean } // gone: the reporter deleted their account
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

/** A MANA-back request waiting for the owner (apps/server/src/studio/mana/refunds.ts `listManaRefunds`). */
export type AdminManaRefund = {
  id: string
  user: { id: string; email: string | null; wallet: string | null }
  usdCents: number
  toAddress: string
  createdAt: string
}

/** What the owner sends for a refund request (the quote route). */
export type AdminManaRefundQuote = { amountWei: string; token: string; chainId: number; to: string; usdPerMana: number }

/** A MANA payment an unmatched transfer might belong to (apps/server/src/studio/mana/settle.ts `listManaTransfers`). */
export type AdminManaCandidate = {
  id: string
  user: { id: string; email: string | null }
  kind: string
  amountCents: number
  creditHeldCents: number
  manaAmountWei: string
  status: string
  createdAt: string
  expiresAt: string
}

export type AdminManaTransfer = {
  txHash: string
  logIndex: number
  fromAddress: string
  amountWei: string
  status: string
  createdAt: string
  candidates: AdminManaCandidate[]
}

export const TX_HASH = /^0x[0-9a-fA-F]{64}$/

/**
 * Unmatched transfers as the page lists them. The server already attaches the payments that might be each one; this
 * keeps those within 5% of the transfer's amount (the same rule, so a stale list can't offer a far-off payment) and
 * puts the nearest first.
 */
export function adminManaRows(transfers: AdminManaTransfer[]) {
  const big = (s: string) => BigInt(s)
  return transfers.map((t) => {
    const wei = big(t.amountWei)
    const off = (c: AdminManaCandidate) => { const d = big(c.manaAmountWei) - wei; return d < BigInt(0) ? -d : d }
    const candidates = t.candidates
      .filter((c) => off(c) * BigInt(100) <= wei * BigInt(5))
      .sort((a, b) => { const x = off(a), y = off(b); return x < y ? -1 : x > y ? 1 : 0 })
    return {
      ...t,
      key: `${t.txHash}:${t.logIndex}`,
      scanUrl: `https://polygonscan.com/tx/${t.txHash}`,
      mana: formatMana(t.amountWei),
      candidates,
    }
  })
}

const ADMIN_MANA_WORDS: Record<string, string> = {
  tx_mismatch: 'That transaction doesn’t hold this amount of MANA to this wallet.',
  already_decided: 'That request has already been decided.',
  not_unmatched: 'That transfer has already been dealt with.',
  already_paid: 'That payment is already paid.',
  payment_claimed: 'That payment is already claimed by another transaction.',
  not_open: 'That payment is no longer open.',
  tx_used: 'That transaction is already recorded against something else.',
  tx_failed: 'That transaction failed on Polygon.',
  tx_not_found: 'Polygon doesn’t know that transaction yet. Try again in a moment.',
}

/** A refused owner action in words for the owner (the customer wording says "contact support"). */
export function adminManaMessage(err: { status?: number; body?: { code?: string } }): string {
  const code = err.body?.code
  return (code && ADMIN_MANA_WORDS[code]) || refusalMessage(err, new Date()).text
}

/** What the owner sees when an action failed: their wallet's refusal, the server's coded refusal, else the error's own text. */
export function adminActionMessage(err: unknown): string {
  if (walletRejected(err)) return 'You cancelled it in your wallet. Nothing was sent.'
  const e = err as { message?: string; status?: number; body?: { code?: string } } | null
  if (e?.body?.code) return adminManaMessage(e)
  return e?.message || 'Something went wrong. Try again.'
}

/** A MANA refund that left the owner's wallet but isn't recorded yet. */
export type UnrecordedRefund = { id: string; txHash: string; amountWei: string }
export const UNRECORDED_REFUNDS_KEY = 'admin-mana-unrecorded-refunds'
type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>

/** The unrecorded sends kept in the browser; storage that is missing, blocked or holds junk reads as none. */
export function readUnrecordedRefunds(store: KeyValueStore | null): UnrecordedRefund[] {
  try {
    const list = JSON.parse(store?.getItem(UNRECORDED_REFUNDS_KEY) ?? '[]')
    if (!Array.isArray(list)) return []
    return list.filter((x): x is UnrecordedRefund => !!x && typeof x.id === 'string' && typeof x.txHash === 'string' && typeof x.amountWei === 'string')
  } catch {
    return []
  }
}

/** Keeps `entry` (or, with null, drops the request's entry) and returns the new list. Storage failures are ignored. */
export function writeUnrecordedRefund(store: KeyValueStore | null, id: string, entry: UnrecordedRefund | null): UnrecordedRefund[] {
  const next = readUnrecordedRefunds(store).filter((x) => x.id !== id)
  if (entry) next.push(entry)
  try { store?.setItem(UNRECORDED_REFUNDS_KEY, JSON.stringify(next)) } catch { /* private window or blocked storage */ }
  return next
}

type RemovableStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const unsentKey = (designId: string) => `virvi.unsent.${designId}`

/** Keeps a prompt that was not sent (the design was made, the prompt refused) for that design's page, whose composer
 *  shows it again. Session storage, not the URL: a prompt is up to 4000 characters and shouldn't sit in history or logs. */
export function keepUnsent(store: RemovableStore | null, designId: string, text: string, refusal: string): void {
  try { store?.setItem(unsentKey(designId), JSON.stringify({ text, refusal })) } catch { /* private window or blocked storage */ }
}

/** The unsent prompt (and why) `keepUnsent` kept for this design, once: it is removed as it is read. */
export function takeUnsent(store: RemovableStore | null, designId: string): { text: string; refusal: string } | null {
  try {
    const raw = store?.getItem(unsentKey(designId))
    if (raw == null) return null
    store!.removeItem(unsentKey(designId))
    const v = JSON.parse(raw) as { text?: unknown; refusal?: unknown }
    return typeof v?.text === 'string' && v.text ? { text: v.text, refusal: typeof v.refusal === 'string' ? v.refusal : '' } : null
  } catch {
    return null
  }
}

/** One shown design on the admin wall list, hidden ones included. */
export type AdminWallEntry = {
  designId: string; name: string; kind: StudioKind; creator: string; marketplaceUrl: string | null; shownAt: string
  hidden: boolean; ownerEmail: string | null
}
