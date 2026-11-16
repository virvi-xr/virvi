/** Dashboard BEATs (LIV-11): the shapes the host API returns, form rules, the review step, actions and plain-language errors. */
import {
  BEAT_DESCRIPTION_MAX, BEAT_IMAGE_MIN_PX, BEAT_MIN_PRESENT_DEFAULT_MINUTES, BEAT_MIN_PRESENT_MAX_MINUTES, BEAT_NAME_MAX, BEAT_SUPPLY_CAP_DEFAULT,
  BEAT_SUPPLY_CAP_MAX, type BeatChain, type BeatClaimStatus, type BeatStatus, type PublicBeat,
} from '@virvixr/shared'
import { formatCredit } from './studio'
import { shortWallet } from './studio-people'

export type { PublicBeat, BeatStatus, BeatClaimStatus }

/** GET /api/beats/availability (answers even while BEATs are dark). `reason` is 'not_configured' when BEATs are
 * switched on but the server's chain has no contract or minter key yet: they stay enabled (existing BEATs list and
 * open) with canCreate false, and create, checkout and top-ups refuse. */
export interface BeatAvailability { enabled: boolean; chain: BeatChain; test: boolean; canCreate: boolean; reason?: 'not_configured' | null }
/** GET /api/beats/:id/quote. */
export interface BeatQuote { cents: number; lines: { label: string; cents: number }[]; refundableUnclaimed: false }
/** POST /api/beats/:id/checkout and /cap: Stripe's page, or paid at once (credit, or a free test BEAT). */
export type BeatCheckoutResult = { url: string } | { paid: true }
/** GET /api/beats/:id/claimants. */
export interface BeatClaimant {
  wallet: string
  displayName: string | null
  status: BeatClaimStatus | string
  claimedAt: string | null
  mintedAt: string | null
  txUrl: string | null
}

// ── Copy ─────────────────────────────────────────────────────────────────────

export const BEATS_UNAVAILABLE = "BEATs aren't available yet."
/** Shown above the BEATs while the network isn't set up (`not_configured`). */
export const BEATS_NETWORK_UNAVAILABLE = 'BEATs on this network are temporarily unavailable. Existing BEATs are safe.'
export const BEAT_TEST_BADGE = 'Test (Polygon Amoy)'
export const BEAT_IMAGE_HINT = `Square, at least ${BEAT_IMAGE_MIN_PX} × ${BEAT_IMAGE_MIN_PX}`
export const BEAT_NO_REFUND = "You pay for the cap up front. Unclaimed BEATs aren't refunded."
export const BEAT_FROZEN_NOTE = 'Name, description and artwork are locked once the first BEAT is minted.'
export const GENERIC_ERROR = 'Something went wrong. Try again.'

export const STATUS_LABELS: Record<BeatStatus, string> = { draft: 'Draft', paid: 'Paid', live: 'Live', ended: 'Ended', cancelled: 'Cancelled' }
export const CLAIM_STATUS_LABELS: Record<BeatClaimStatus, string> = {
  present: 'Attending', claimed: 'Claimed', minting: 'Minting', minted: 'Minted', failed: 'Failed', removed: 'Removed',
}

// ── Links ────────────────────────────────────────────────────────────────────

/** A BEAT's page: `/beats?id=`, as scenes use `/scenes?id=` (the static export has one page for every id). */
export const beatHref = (id: string) => `/beats?id=${encodeURIComponent(id)}`
/** The create page, with a scene picked when it is opened from that scene. */
export const newBeatHref = (sceneId?: string) => (sceneId ? `/beats/new?scene=${encodeURIComponent(sceneId)}` : '/beats/new')

// ── Nav ──────────────────────────────────────────────────────────────────────

/** The BEATs nav item shows only once the server says BEATs are on; trials and scene passes never see it. */
export function beatsNavVisible(a: BeatAvailability | null, who: { trial: boolean; scenePass: boolean }): boolean {
  return !!a?.enabled && !who.trial && !who.scenePass
}

/** Whether hosts can pay now (a draft's supply, a cap raise): not while the network isn't set up. */
export const beatsPayable = (a: BeatAvailability) => a.enabled && a.reason !== 'not_configured'

// ── Form ─────────────────────────────────────────────────────────────────────

export interface BeatInput {
  name: string
  description: string
  imageMediaId: string | null
  /** For the preview only. */
  imageUrl: string | null
  /** `<input type="datetime-local">` values, in the browser's time zone. */
  startsAt: string
  endsAt: string
  sceneIds: string[]
  minPresentMinutes: number
  supplyCap: number
  tradeable: boolean
}

const pad = (n: number) => String(n).padStart(2, '0')

/** An ISO time as a datetime-local value in the browser's time zone. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** A datetime-local value as an ISO time ('' when it is empty or unreadable). */
export function fromLocalInput(v: string): string {
  const d = v ? new Date(v) : null
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : ''
}

/** A new BEAT: tomorrow at this hour for two hours, with the spec's defaults. */
export function blankBeat(now: Date, sceneId?: string | null): BeatInput {
  const start = new Date(now.getTime() + 24 * 3_600_000)
  start.setMinutes(0, 0, 0)
  const end = new Date(start.getTime() + 2 * 3_600_000)
  return {
    name: '', description: '', imageMediaId: null, imageUrl: null, startsAt: toLocalInput(start.toISOString()), endsAt: toLocalInput(end.toISOString()),
    sceneIds: sceneId ? [sceneId] : [], minPresentMinutes: BEAT_MIN_PRESENT_DEFAULT_MINUTES, supplyCap: BEAT_SUPPLY_CAP_DEFAULT, tradeable: false,
  }
}

/** The edit form's starting values: the BEAT as it is. The media id isn't returned, so the artwork stays unless changed. */
export function beatToInput(b: PublicBeat): BeatInput {
  return {
    name: b.name, description: b.description, imageMediaId: null, imageUrl: b.imageUrl || null, startsAt: toLocalInput(b.startsAt), endsAt: toLocalInput(b.endsAt),
    sceneIds: [...b.sceneIds], minPresentMinutes: Math.round(b.minPresentSeconds / 60), supplyCap: b.supplyCap, tradeable: b.tradeable,
  }
}

export type BeatField = 'name' | 'description' | 'image' | 'window' | 'minutes' | 'scenes' | 'cap' | 'pay' | 'form'
export interface FieldError { field: BeatField; message: string }

/** Why the form can't go to review yet, or null. `editing`: the artwork may stay as it is. */
export function beatFormError(f: BeatInput, opts: { editing?: boolean } = {}): FieldError | null {
  if (!f.name.trim()) return { field: 'name', message: 'Give the BEAT a name.' }
  if ([...f.name.trim()].length > BEAT_NAME_MAX) return { field: 'name', message: `The name can be up to ${BEAT_NAME_MAX} characters.` }
  if ([...f.description.trim()].length > BEAT_DESCRIPTION_MAX) return { field: 'description', message: `The description can be up to ${BEAT_DESCRIPTION_MAX} characters.` }
  if (!f.imageMediaId && !(opts.editing && f.imageUrl)) return { field: 'image', message: 'Pick an image.' }
  const s = fromLocalInput(f.startsAt)
  const e = fromLocalInput(f.endsAt)
  if (!s || !e) return { field: 'window', message: 'Pick a start and an end time.' }
  if (new Date(e).getTime() <= new Date(s).getTime()) return { field: 'window', message: 'The BEAT must end after it starts.' }
  if (!Number.isInteger(f.minPresentMinutes) || f.minPresentMinutes < 0 || f.minPresentMinutes > BEAT_MIN_PRESENT_MAX_MINUTES) {
    return { field: 'minutes', message: `Minimum time must be 0 to ${BEAT_MIN_PRESENT_MAX_MINUTES} minutes.` }
  }
  if (!f.sceneIds.length) return { field: 'scenes', message: 'Pick at least one scene.' }
  if (!Number.isInteger(f.supplyCap) || f.supplyCap < 1 || f.supplyCap > BEAT_SUPPLY_CAP_MAX) return { field: 'cap', message: `Supply must be 1 to ${BEAT_SUPPLY_CAP_MAX}.` }
  return null
}

/** The body POST /api/beats takes. */
export function beatBody(f: BeatInput) {
  return {
    name: f.name.trim(), description: f.description.trim(), imageMediaId: f.imageMediaId, startsAt: fromLocalInput(f.startsAt), endsAt: fromLocalInput(f.endsAt),
    sceneIds: f.sceneIds, minPresentMinutes: f.minPresentMinutes, supplyCap: f.supplyCap, tradeable: f.tradeable,
  }
}

/**
 * The body PATCH /api/beats/:id takes. A paid BEAT's supply and tradeable can't change (a raise is a top-up), so they
 * aren't sent; the artwork goes only when a new one was picked.
 */
export function beatEditBody(f: BeatInput, status: BeatStatus) {
  const { imageMediaId, supplyCap, tradeable, ...rest } = beatBody(f)
  return {
    ...rest,
    ...(imageMediaId ? { imageMediaId } : {}),
    ...(status === 'draft' ? { supplyCap, tradeable } : {}),
  }
}

/** The form fields an edit touches. A minimum-time error comes back as `bad_window`, so the minutes clear that too. */
const PATCH_FIELDS: Partial<Record<keyof BeatInput, BeatField[]>> = {
  name: ['name'], description: ['description'], imageMediaId: ['image'], imageUrl: ['image'], startsAt: ['window'], endsAt: ['window'],
  minPresentMinutes: ['minutes', 'window'], sceneIds: ['scenes'], supplyCap: ['cap'],
}
export function fieldsOfPatch(patch: Partial<BeatInput>): BeatField[] {
  return [...new Set((Object.keys(patch) as (keyof BeatInput)[]).flatMap((k) => PATCH_FIELDS[k] ?? []))]
}

/** A server refusal stays beside its field until the host edits that field. */
export function shownFieldError(error: FieldError | null, edited: ReadonlySet<BeatField>): FieldError | null {
  return error && !edited.has(error.field) ? error : null
}

// ── Server errors ────────────────────────────────────────────────────────────

/** Every code the create, edit and payment routes answer, the field it belongs beside, and a message if the server sends none. */
const ERRORS: Record<string, FieldError> = {
  bad_name: { field: 'name', message: `Give the BEAT a name of 1 to ${BEAT_NAME_MAX} characters, and a description of up to ${BEAT_DESCRIPTION_MAX}.` },
  bad_window: { field: 'window', message: 'Check the start, the end and the minimum time.' },
  overlap: { field: 'window', message: 'Another BEAT is already running in one of those scenes at that time.' },
  bad_scenes: { field: 'scenes', message: 'Pick 1 to 20 different scenes.' },
  bad_image: { field: 'image', message: `Pick a square image of at least ${BEAT_IMAGE_MIN_PX} by ${BEAT_IMAGE_MIN_PX} pixels from your library.` },
  bad_cap: { field: 'cap', message: `Supply must be 1 to ${BEAT_SUPPLY_CAP_MAX}.` },
  bad_request: { field: 'form', message: 'Check the form and try again.' },
  forbidden: { field: 'form', message: "You can't run events in every one of those scenes." },
  locked: { field: 'form', message: "This BEAT can't be changed any more." },
  too_late: { field: 'form', message: 'This BEAT has already started.' },
  conflict: { field: 'form', message: 'This BEAT just changed. Reload and try again.' },
  not_live: { field: 'form', message: "This BEAT isn't running right now." },
  not_found: { field: 'form', message: 'BEAT not found.' },
  insufficient_credit: { field: 'pay', message: "Your Virvi credit doesn't cover this. Pay by card instead." },
  stripe_error: { field: 'pay', message: "We couldn't reach the card processor. Try again." },
}

/**
 * A failed BEAT call as a message beside its field. The server's own message is plain copy written for this, so it is
 * shown when there is one; an unknown code (or no response) gets the generic message.
 */
export function beatFieldError(err: unknown): FieldError {
  const e = err as { message?: string; body?: { error?: string; message?: string } } | null
  const code = e?.body?.error ?? e?.message ?? ''
  const known = ERRORS[code]
  if (!known) return { field: 'form', message: GENERIC_ERROR }
  return { field: known.field, message: e?.body?.message?.trim() || known.message }
}

// ── Review ───────────────────────────────────────────────────────────────────

export type ReviewMethod = 'card' | 'credit' | 'test'
const METHOD_LABELS: Record<ReviewMethod, string> = { card: 'Pay with card', credit: 'Use credit', test: 'Create test BEAT' }

/** The review step: the quote's lines and total, the no-refund sentence, and the ways to pay. */
export function reviewModel(q: BeatQuote, o: { test: boolean; creditCents: number }) {
  const methods: ReviewMethod[] = o.test ? ['test'] : o.creditCents >= q.cents ? ['card', 'credit'] : ['card']
  return {
    lines: q.lines.map((l) => ({ label: l.label, amount: formatCredit(l.cents) })),
    total: formatCredit(q.cents),
    note: BEAT_NO_REFUND,
    buttons: methods.map((method) => ({ method, label: METHOD_LABELS[method] })),
  }
}

/** An API path with the BEAT id encoded (the id comes from the page's `?id=`). */
export const beatApiPath = (beatId: string, sub?: string) => `/api/beats/${encodeURIComponent(beatId)}${sub ? `/${sub}` : ''}`
export const sceneBeatsPath = (sceneId: string) => `/api/scenes/${encodeURIComponent(sceneId)}/beats`

/** The body checkout and cap take: a test BEAT sends no method (the server records it as a test payment). */
export const payBody = (method: ReviewMethod) => (method === 'test' ? {} : { method })

// ── Detail ───────────────────────────────────────────────────────────────────

export type BeatAction = 'pay' | 'edit' | 'cancel' | 'raise_cap' | 'end_early'

/**
 * What the host can do now: pay a draft; edit before the start (a draft any time, nothing once frozen); cancel before
 * the start; raise the cap once paid and before the end; end early while live. `payable` false (the network isn't set
 * up) drops Pay and Raise cap.
 */
export function beatActions(b: PublicBeat, now: Date, o: { payable?: boolean } = {}): BeatAction[] {
  const t = now.getTime()
  const beforeStart = new Date(b.startsAt).getTime() > t
  const beforeEnd = new Date(b.endsAt).getTime() > t
  const out: BeatAction[] = []
  if (b.status === 'draft' && beforeStart) out.push('pay')
  if (!b.frozen && (b.status === 'draft' || (b.status === 'paid' && beforeStart))) out.push('edit')
  if ((b.status === 'draft' || b.status === 'paid') && beforeStart) out.push('cancel')
  if ((b.status === 'paid' || b.status === 'live') && beforeEnd) out.push('raise_cap')
  if (b.status === 'live') out.push('end_early')
  return o.payable === false ? out.filter((a) => a !== 'pay' && a !== 'raise_cap') : out
}

export const ACTION_LABELS: Record<BeatAction, string> = { pay: 'Pay', edit: 'Edit', cancel: 'Cancel', raise_cap: 'Raise cap', end_early: 'End early' }

/** A cancelled paid BEAT is refunded the way it was paid (card, or Virvi credit); the detail doesn't say which. */
export const BEAT_REFUND_NOTE = "You'll get a full refund."

/** The question asked before an action that can't be undone, or null. A paid (non-test) BEAT's cancel promises the refund. */
export function confirmBeatAction(a: BeatAction, b?: Pick<PublicBeat, 'status' | 'test'>): string | null {
  if (a === 'cancel') return b?.status === 'paid' && !b.test ? `Cancel this BEAT? ${BEAT_REFUND_NOTE}` : 'Cancel this BEAT?'
  if (a === 'end_early') return 'End this BEAT now? Claims already made still mint.'
  return null
}

/** The counts against the cap. */
export function beatCounts(b: PublicBeat) {
  const { claimed, minting, minted, failed } = b.counts
  return { claimed, minting, minted, failed, used: claimed + minting + minted + failed, cap: b.supplyCap }
}

/** The window as one line, in the browser's time zone. */
export function beatWindow(b: Pick<PublicBeat, 'startsAt' | 'endsAt'>): string {
  return `${new Date(b.startsAt).toLocaleString()} – ${new Date(b.endsAt).toLocaleString()}`
}

/** A claimant's row: the short wallet (the full one for its title), the name as typed, the status and the tx link if any. */
export function claimantRow(c: BeatClaimant) {
  return {
    short: shortWallet(c.wallet), wallet: c.wallet, name: c.displayName,
    status: CLAIM_STATUS_LABELS[c.status as BeatClaimStatus] ?? c.status, txUrl: c.txUrl,
  }
}

/** What "Copy wallets" copies: every full wallet, one per line. */
export const claimantWallets = (list: BeatClaimant[]) => list.map((c) => c.wallet).join('\n')

// ── Back from Stripe ─────────────────────────────────────────────────────────

/** Stripe sends the host back to `/beats?id=<id>&payment=<payment id>`, or `&payment=cancelled`. */
export const PAYMENT_CANCELLED = 'cancelled'
export const PAYMENT_POLL_MS = 3_000
const PAYMENT_SLOW_MS = 2 * 60_000

/**
 * What the page says after Stripe: cancelled; received and waiting for the webhook (the BEAT is still a draft, or a cap
 * raise hasn't reached `waitCap`); or received. `settled` false means poll again.
 */
export function paymentNote(param: string | null, b: PublicBeat, waitCap: number | null, startedAt: number, now: Date): { text: string; settled: boolean } | null {
  if (!param) return null
  if (param === PAYMENT_CANCELLED) return { text: 'Payment cancelled.', settled: true }
  if (b.status === 'cancelled') return null
  const waiting = b.status === 'draft' || (waitCap !== null && b.supplyCap < waitCap)
  if (!waiting) return { text: 'Payment received.', settled: true }
  return now.getTime() - startedAt > PAYMENT_SLOW_MS
    ? { text: 'Stripe hasn’t confirmed the payment yet. This page will update when it does.', settled: false }
    : { text: 'Payment received. Confirming it…', settled: false }
}

/** Where a cap raise remembers the cap it waits for across the Stripe redirect (per BEAT). */
export const topupKey = (beatId: string) => `virvi.beat.topup.${beatId}`

/**
 * Re-reads the BEAT until it is `settled`, waiting `delayMs()` before each read. A failed read is skipped, never the end
 * of polling (a network blip after Stripe must not leave "Confirming it…" up for good). `stopped` ends it (unmount).
 */
export async function pollPayment(o: {
  load: () => Promise<PublicBeat>
  onBeat: (b: PublicBeat) => void
  settled: (b: PublicBeat) => boolean
  delayMs: () => number
  wait?: (ms: number) => Promise<void>
  stopped: () => boolean
}): Promise<void> {
  const wait = o.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  while (!o.stopped()) {
    await wait(o.delayMs())
    if (o.stopped()) return
    let b: PublicBeat
    try { b = await o.load() } catch { continue }
    if (o.stopped()) return
    o.onBeat(b)
    if (o.settled(b)) return
  }
}
