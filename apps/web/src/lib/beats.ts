/** Dashboard BEATs (LIV-11): the shapes the host API returns, form rules, the review step, actions and plain-language errors. */
import {
  BEAT_CARD_MIN_CENTS, BEAT_CLAIM_GRACE_MS, BEAT_DESCRIPTION_MAX, BEAT_IMAGE_MIN_PX, BEAT_LOCATION_MAX, BEAT_MIN_PRESENT_DEFAULT_MINUTES,
  BEAT_MIN_PRESENT_MAX_MINUTES, BEAT_NAME_MAX, BEAT_SUPPLY_CAP_DEFAULT, BEAT_SUPPLY_CAP_MAX,
  type BeatChain, type BeatClaimStatus, type BeatLocation, type BeatLocationType, type BeatStatus, type PublicBeat,
} from '@virvixr/shared'
import { formatCredit } from './studio'
import { shortWallet } from './studio-people'

export type { PublicBeat, BeatStatus, BeatClaimStatus, BeatLocation, BeatLocationType }

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
  /** The claim's id, for removing it while claims are held for review. */
  id: string
  wallet: string
  displayName: string | null
  status: BeatClaimStatus | string
  claimedAt: string | null
  mintedAt: string | null
  txUrl: string | null
  /** Sent again to `wallet` in place of a compromised wallet (an admin's reissue). */
  reissued: boolean
  reissueTxUrl: string | null
}

// ── Copy ─────────────────────────────────────────────────────────────────────

export const BEATS_UNAVAILABLE = "BEATs aren't available yet."
/** For a host who can't create BEATs yet (the test phase): who to ask. */
export const CREATE_CLOSED = 'Only Virvi can create BEATs for now. Contact us to try one:'
/** Shown above the BEATs while the network isn't set up (`not_configured`). */
export const BEATS_NETWORK_UNAVAILABLE = 'BEATs on this network are temporarily unavailable. Existing BEATs are safe.'
export const BEAT_TEST_BADGE = 'Test BEAT (practice network)'
export const BEAT_IMAGE_HINT = `Square, at least ${BEAT_IMAGE_MIN_PX} × ${BEAT_IMAGE_MIN_PX}`
export const BEAT_NO_REFUND = "You pay for the cap up front. Unclaimed BEATs aren't refunded."
/** Under a BEAT that has started: what can no longer change, and why (it goes on Polygon at the start). */
export const BEAT_FROZEN_NOTE = "This BEAT has started, so its name, description, Tradeable setting, location and times are locked: they're part of the token now. Your artwork is copied when you pay (and again if you change it), so deleting the original from your media library doesn't change the BEAT."
/** The note shows once the BEAT has started (live or ended). */
export const beatLocked = (b: Pick<PublicBeat, 'status'>) => b.status === 'live' || b.status === 'ended'
export const GENERIC_ERROR = 'Something went wrong. Try again.'

// Form help (plain-ux I4)
export const TRADEABLE_HINT = "Holders can send it to other wallets. You can't change this once the BEAT starts."
export const SUPPLY_HINT = 'The most BEATs that can be claimed. You pay for this many up front. You can raise it later, never lower it.'
export const PAID_SUPPLY_HINT = "The supply can't be changed after paying. To allow more BEATs, use Raise cap."
export const MINUTES_HINT = '0 means anyone who agrees can claim once it starts.'
export const HOLD_LABEL = 'Check claims before they are sent'
export const HOLD_HINT = "Claims wait for you to press Send on this page, so you can remove any you don't recognise first. If you don't, they're sent anyway 24 hours after the end."
export const LOCATION_SCENE_ONLY = 'People claim this BEAT in your Virvi scene. Ways to claim in person or on other platforms are coming.'
export const LOCATION_TYPE_LABELS: Record<BeatLocationType, string> = { scene: 'In my Virvi scenes', online: 'Online, on another platform', in_person: 'In person' }

// Artwork (fix round I-3: the art is frozen at payment, and again after each image change)
export const ART_FAILED = "We couldn't use this BEAT's image for the token: it may have been deleted, or it can't be read. Pick another image with Change image. Nothing is sent until it works."
export const ART_PENDING = "We're preparing this BEAT's artwork for the token. This happens by itself."

export const STATUS_LABELS: Record<BeatStatus, string> = { draft: 'Draft', paid: 'Paid', live: 'Live', ended: 'Ended', cancelled: 'Cancelled' }
/** What each status means, for the docs and the detail page. */
export const STATUS_HELP: Record<BeatStatus, string> = {
  draft: "Created, not paid for yet. Choose Pay when you're ready.",
  paid: 'Paid, waiting for its start.',
  live: 'Running now.',
  ended: 'Over. Visitors who stayed long enough can still claim for 24 hours.',
  cancelled: 'Cancelled and refunded.',
}
export const CLAIM_STATUS_LABELS: Record<BeatClaimStatus, string> = {
  present: 'Attending', claimed: 'Claimed', minting: 'Sending', minted: 'Delivered', failed: 'Failed', removed: 'Removed by you',
}
/** A claimed claim waiting for the host's Send. */
export const HELD_LABEL = 'Waiting for your Send'

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
  /** Host review: claims wait for the host's Send. */
  holdMints: boolean
  location: LocationInput
}

/** The "Where is it?" fields as typed (empty strings for the unused ones). */
export interface LocationInput {
  type: BeatLocationType
  platform: string; url: string
  venue: string; city: string; country: string; address: string; mapUrl: string
}

export const blankLocation = (): LocationInput => ({ type: 'scene', platform: '', url: '', venue: '', city: '', country: '', address: '', mapUrl: '' })

export function locationToInput(l: BeatLocation | null | undefined): LocationInput {
  if (!l) return blankLocation()
  return {
    type: l.type, platform: l.platform ?? '', url: l.url ?? '', venue: l.venue ?? '', city: l.city ?? '', country: l.country ?? '',
    address: l.address ?? '', mapUrl: l.mapUrl ?? '',
  }
}

/** The body's `location`: only the fields of its type, trimmed. */
export function locationBody(l: LocationInput) {
  if (l.type === 'online') return { type: l.type, platform: l.platform.trim(), url: l.url.trim() }
  if (l.type === 'in_person') {
    return {
      type: l.type, venue: l.venue.trim(), city: l.city.trim(), country: l.country.trim(),
      ...(l.address.trim() ? { address: l.address.trim() } : {}), ...(l.mapUrl.trim() ? { mapUrl: l.mapUrl.trim() } : {}),
    }
  }
  return { type: 'scene' as const }
}

const isWebUrl = (v: string) => {
  try { const u = new URL(v); return u.protocol === 'https:' || u.protocol === 'http:' } catch { return false }
}

/** Why the location can't be saved, or null. */
function locationError(l: LocationInput): string | null {
  const M = BEAT_LOCATION_MAX
  const long = (v: string, max: number) => [...v.trim()].length > max
  if (l.type === 'online') {
    if (!l.platform.trim()) return 'Add the platform name.'
    if (long(l.platform, M.platform)) return `The platform name can be up to ${M.platform} characters.`
    if (!l.url.trim()) return 'Add the event link.'
    if (long(l.url, M.url) || !isWebUrl(l.url.trim())) return 'The event link must be a web address starting with https://.'
  }
  if (l.type === 'in_person') {
    if (!l.venue.trim()) return 'Add the venue name.'
    if (!l.city.trim()) return 'Add the city or region.'
    if (!l.country.trim()) return 'Add the country.'
    if (long(l.venue, M.venue) || long(l.city, M.city) || long(l.country, M.country) || long(l.address, M.address)) return 'One of the place fields is too long.'
    if (l.mapUrl.trim() && (long(l.mapUrl, M.mapUrl) || !isWebUrl(l.mapUrl.trim()))) return 'The map link must be a web address starting with https://.'
  }
  return null
}

/** A location as a line for the detail page. */
export function locationLine(l: BeatLocation): string {
  if (l.type === 'online') return `Online, on ${l.platform ?? 'another platform'}`
  if (l.type === 'in_person') return [l.venue, l.address, l.city, l.country].filter(Boolean).join(', ')
  return l.label ? `In Virvi: ${l.label}` : 'In your Virvi scenes'
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
    holdMints: false, location: blankLocation(),
  }
}

/** The edit form's starting values: the BEAT as it is. The media id isn't returned, so the artwork stays unless changed. */
export function beatToInput(b: PublicBeat): BeatInput {
  return {
    name: b.name, description: b.description, imageMediaId: null, imageUrl: b.imageUrl || null, startsAt: toLocalInput(b.startsAt), endsAt: toLocalInput(b.endsAt),
    sceneIds: [...b.sceneIds], minPresentMinutes: Math.round(b.minPresentSeconds / 60), supplyCap: b.supplyCap, tradeable: b.tradeable,
    holdMints: b.holdMints, location: locationToInput(b.location),
  }
}

export type BeatField = 'name' | 'description' | 'image' | 'window' | 'minutes' | 'scenes' | 'cap' | 'location' | 'pay' | 'form'
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
  const where = locationError(f.location)
  if (where) return { field: 'location', message: where }
  return null
}

/** The order of the form's fields, so a refusal can focus the first one that's wrong (plain-ux I13). */
export const FIELD_IDS: Record<Exclude<BeatField, 'pay' | 'form'>, string> = {
  name: 'beat-name', description: 'beat-description', image: 'beat-image', window: 'beat-starts', minutes: 'beat-minutes',
  scenes: 'beat-scenes', cap: 'beat-cap', location: 'beat-location',
}

/** The body POST /api/beats takes. */
export function beatBody(f: BeatInput) {
  return {
    name: f.name.trim(), description: f.description.trim(), imageMediaId: f.imageMediaId, startsAt: fromLocalInput(f.startsAt), endsAt: fromLocalInput(f.endsAt),
    sceneIds: f.sceneIds, minPresentMinutes: f.minPresentMinutes, supplyCap: f.supplyCap, tradeable: f.tradeable, holdMints: f.holdMints,
    location: locationBody(f.location),
  }
}

/**
 * The body PATCH /api/beats/:id takes. A paid BEAT's supply can't change (a raise is a top-up), so it isn't sent;
 * Tradeable and the rest can change until the start. The artwork goes only when a new one was picked.
 */
export function beatEditBody(f: BeatInput, status: BeatStatus) {
  const { imageMediaId, supplyCap, ...rest } = beatBody(f)
  return {
    ...rest,
    ...(imageMediaId ? { imageMediaId } : {}),
    ...(status === 'draft' ? { supplyCap } : {}),
  }
}

/** The review step's summary of what is fixed once it starts (plain-ux I4). */
export function reviewSummary(b: Pick<PublicBeat, 'supplyCap' | 'tradeable' | 'sceneIds' | 'startsAt' | 'holdMints'>): string {
  const scenes = `${b.sceneIds.length} ${b.sceneIds.length === 1 ? 'scene' : 'scenes'}`
  return [`Supply cap ${b.supplyCap}`, `Tradeable: ${b.tradeable ? 'Yes' : 'No'}`, scenes, `Starts ${formatWhen(b.startsAt)}`, ...(b.holdMints ? ['You check claims before they are sent'] : [])].join(' · ')
}

/** The form fields an edit touches. A minimum-time error comes back as `bad_window`, so the minutes clear that too. */
const PATCH_FIELDS: Partial<Record<keyof BeatInput, BeatField[]>> = {
  name: ['name'], description: ['description'], imageMediaId: ['image'], imageUrl: ['image'], startsAt: ['window'], endsAt: ['window'],
  minPresentMinutes: ['minutes', 'window'], sceneIds: ['scenes'], supplyCap: ['cap'], location: ['location'],
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
  bad_name: { field: 'name', message: `Give the BEAT a name of 1 to ${BEAT_NAME_MAX} characters.` },
  bad_description: { field: 'description', message: `The description can be up to ${BEAT_DESCRIPTION_MAX} characters.` },
  bad_location: { field: 'location', message: 'Check where the event is.' },
  bad_window: { field: 'window', message: 'Check the start, the end and the minimum time.' },
  overlap: { field: 'window', message: 'Another BEAT is already running in one of those scenes at that time.' },
  bad_scenes: { field: 'scenes', message: 'Pick 1 to 20 different scenes.' },
  bad_image: { field: 'image', message: `Pick a square image of at least ${BEAT_IMAGE_MIN_PX} by ${BEAT_IMAGE_MIN_PX} pixels from your library.` },
  bad_cap: { field: 'cap', message: `Supply must be 1 to ${BEAT_SUPPLY_CAP_MAX}.` },
  bad_request: { field: 'form', message: 'Check the form and try again.' },
  forbidden: { field: 'form', message: "You can't run events in every one of those scenes." },
  locked: { field: 'form', message: "This BEAT has started, so it can't be changed any more." },
  too_late: { field: 'form', message: 'This BEAT has already started.' },
  conflict: { field: 'form', message: 'This BEAT just changed. Reload the page and try again.' },
  not_live: { field: 'form', message: "This BEAT hasn't started, so there's nothing to send yet." },
  not_held: { field: 'form', message: 'These claims are already being sent.' },
  not_removable: { field: 'form', message: 'Only a claim that is waiting to be sent can be removed.' },
  not_found: { field: 'form', message: 'BEAT not found.' },
  not_configured: { field: 'form', message: "BEATs aren't set up yet. Try again later." },
  insufficient_credit: { field: 'pay', message: "Your Virvi credit doesn't cover this. Pay by card instead." },
  below_minimum: { field: 'pay', message: `Card payments start at $${(BEAT_CARD_MIN_CENTS / 100).toFixed(2)}. Add more BEATs, or pay with credit.` },
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
  if (!known) return { field: 'form', message: isNetworkError(err) ? NETWORK_ERROR : GENERIC_ERROR }
  return { field: known.field, message: e?.body?.message?.trim() || known.message }
}

export const NETWORK_ERROR = "Couldn't reach Virvi. Check your connection and try again."
/** A request that never got an answer (fetch rejects with a TypeError). */
function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError || /failed to fetch|network/i.test((err as Error | null)?.message ?? '')
}

/** A failed call's code, for the small grey line under a message. */
export const errorCode = (err: unknown): string | null => (err as { body?: { error?: string } } | null)?.body?.error ?? null

// ── Review ───────────────────────────────────────────────────────────────────

export type ReviewMethod = 'card' | 'credit' | 'test'
const METHOD_LABELS: Record<ReviewMethod, string> = { card: 'Pay with card', credit: 'Use credit', test: 'Create test BEAT' }

/** The review step: the quote's lines and total, the no-refund sentence, the ways to pay, and the credit when it isn't enough. */
export function reviewModel(q: BeatQuote, o: { test: boolean; creditCents: number }) {
  const methods: ReviewMethod[] = o.test ? ['test'] : o.creditCents >= q.cents ? ['card', 'credit'] : ['card']
  return {
    lines: q.lines.map((l) => ({ label: l.label, amount: formatCredit(l.cents) })),
    total: formatCredit(q.cents),
    note: BEAT_NO_REFUND,
    buttons: methods.map((method) => ({ method, label: METHOD_LABELS[method] })),
    credit: !o.test && o.creditCents > 0 && o.creditCents < q.cents ? `Your Virvi credit: ${formatCredit(o.creditCents)}, not enough for this BEAT.` : null,
  }
}

/** A pay button's label while it's working (plain-ux M15). */
export const PAY_BUSY: Record<ReviewMethod, string> = { card: 'Opening Stripe…', credit: 'Paying…', test: 'Creating…' }

/** An API path with the BEAT id encoded (the id comes from the page's `?id=`). */
export const beatApiPath = (beatId: string, sub?: string) => `/api/beats/${encodeURIComponent(beatId)}${sub ? `/${sub}` : ''}`
export const sceneBeatsPath = (sceneId: string) => `/api/scenes/${encodeURIComponent(sceneId)}/beats`

/** The body checkout and cap take: a test BEAT sends no method (the server records it as a test payment). */
export const payBody = (method: ReviewMethod) => (method === 'test' ? {} : { method })

// ── Detail ───────────────────────────────────────────────────────────────────

export type BeatAction = 'pay' | 'edit' | 'change_image' | 'send' | 'cancel' | 'raise_cap' | 'end_early'

/**
 * What the host can do now: pay a draft; edit before the start (a draft any time, nothing once frozen); after the start,
 * change only the image when the art couldn't be made; Send held claims; cancel a paid BEAT before the start, or a
 * draft at any time; raise the cap once paid and before the end; end early while live. `payable` false (the network
 * isn't set up) drops Pay and Raise cap.
 */
export function beatActions(b: PublicBeat, now: Date, o: { payable?: boolean } = {}): BeatAction[] {
  const t = now.getTime()
  const beforeStart = new Date(b.startsAt).getTime() > t
  const beforeEnd = new Date(b.endsAt).getTime() > t
  const out: BeatAction[] = []
  if (b.status === 'draft' && beforeStart) out.push('pay')
  if (!b.frozen && (b.status === 'draft' || (b.status === 'paid' && beforeStart))) out.push('edit')
  else if (b.artStatus === 'failed' && (b.status === 'paid' || b.status === 'live' || b.status === 'ended')) out.push('change_image')
  if (b.mintsHeldUntil && b.heldClaims > 0 && (b.status === 'live' || b.status === 'ended')) out.push('send')
  if (b.status === 'draft' || (b.status === 'paid' && beforeStart)) out.push('cancel')
  if ((b.status === 'paid' || b.status === 'live') && beforeEnd) out.push('raise_cap')
  if (b.status === 'live') out.push('end_early')
  return o.payable === false ? out.filter((a) => a !== 'pay' && a !== 'raise_cap') : out
}

export const ACTION_LABELS: Record<BeatAction, string> = {
  pay: 'Pay', edit: 'Edit', change_image: 'Change image', send: 'Send claimed BEATs', cancel: 'Cancel', raise_cap: 'Raise cap', end_early: 'End early',
}

/** A cancelled paid BEAT is refunded the way it was paid (card, or Virvi credit); the detail doesn't say which. */
export const BEAT_REFUND_NOTE = "You'll get a full refund."

/** The question asked before an action that can't be undone, or null. A paid (non-test) BEAT's cancel promises the refund. */
export function confirmBeatAction(a: BeatAction, b?: Pick<PublicBeat, 'status' | 'test' | 'heldClaims'>): string | null {
  if (a === 'cancel') return b?.status === 'paid' && !b.test ? `Cancel this BEAT? ${BEAT_REFUND_NOTE}` : b?.status === 'draft' ? 'Delete this draft?' : 'Cancel this BEAT?'
  if (a === 'end_early') return 'End this BEAT now? Claims already made are still sent.'
  if (a === 'send') {
    const n = b?.heldClaims ?? 0
    return `Send ${n === 1 ? 'the 1 BEAT' : `the ${n} BEATs`} claimed so far? They go to the visitors' wallets and can't be taken back. Claims made after this wait for another Send.`
  }
  return null
}

/** What the page says after a cancel (plain-ux M10). */
export function cancelledNote(b: Pick<PublicBeat, 'test'>, wasPaid: boolean): string {
  if (!wasPaid || b.test) return 'Cancelled.'
  return 'Cancelled. Your refund is on its way: to your card (it can take a few days), or straight back to your Virvi credit if you paid with credit.'
}

/** The counts against the cap, with the words the page uses (plain-ux M8). */
export function beatCounts(b: PublicBeat) {
  const { claimed, minting, minted, failed } = b.counts
  return { claimed, minting, minted, failed, used: claimed + minting + minted + failed, cap: b.supplyCap }
}
export const COUNT_LABELS = { claimed: 'Claimed (waiting to send)', minting: 'Sending', minted: 'Delivered', failed: 'Failed', cap: 'Cap' } as const
export const COUNTS_NOTE = "Failed claims are retried automatically. A wallet that can't accept BEATs stays failed."

/** A time with the date, in the browser's time zone. */
export function formatWhen(iso: string, withZone = false): string {
  // dateStyle/timeStyle can't be combined with timeZoneName (browsers throw "Invalid option"), so the zone uses the field options
  return new Date(iso).toLocaleString(undefined, withZone
    ? { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }
    : { dateStyle: 'medium', timeStyle: 'short' })
}

/** The window as one line, in the browser's time zone, named once at the end. */
export function beatWindow(b: Pick<PublicBeat, 'startsAt' | 'endsAt'>): string {
  return `${formatWhen(b.startsAt)} – ${formatWhen(b.endsAt, true)}`
}

/** Until when visitors can claim: 24 hours after the end. */
export const claimUntil = (b: Pick<PublicBeat, 'endsAt'>) => new Date(new Date(b.endsAt).getTime() + BEAT_CLAIM_GRACE_MS).toISOString()

/** True while this claim waits for the host's Send (as the server judges it: claimed after the last Send). */
export function claimantHeld(c: Pick<BeatClaimant, 'status' | 'claimedAt'>, b: Pick<PublicBeat, 'mintsHeldUntil' | 'mintsReleasedAt'>): boolean {
  if (!b.mintsHeldUntil || c.status !== 'claimed') return false
  return !b.mintsReleasedAt || !c.claimedAt || new Date(c.claimedAt).getTime() > new Date(b.mintsReleasedAt).getTime()
}

/** A claimant's row: the short wallet (the full one for its title), the name as typed, the status and the tx link if any. */
export function claimantRow(c: BeatClaimant, b?: Pick<PublicBeat, 'mintsHeldUntil' | 'mintsReleasedAt'>) {
  const held = !!b && claimantHeld(c, b)
  return {
    short: shortWallet(c.wallet), wallet: c.wallet, name: c.displayName,
    status: held ? HELD_LABEL : CLAIM_STATUS_LABELS[c.status as BeatClaimStatus] ?? c.status, txUrl: c.txUrl,
    held, reissued: c.reissued, reissueTxUrl: c.reissueTxUrl,
  }
}

/** The claims that took a BEAT (not visitors still attending, nor removed ones). */
const CLAIMED: string[] = ['claimed', 'minting', 'minted', 'failed']
export const hasClaimed = (c: Pick<BeatClaimant, 'status'>) => CLAIMED.includes(c.status)

/** The list's heading (plain-ux I3): everyone tracking, and how many of them claimed. */
export function claimantsHeading(list: BeatClaimant[]): string {
  const claimed = list.filter(hasClaimed).length
  const attending = list.filter((c) => c.status === 'present').length
  return `Attendees (${list.length}): ${claimed} claimed, ${attending} still attending`
}

/** What "Copy wallets that claimed" copies: the full wallet of every claim that took a BEAT, one per line. */
export const claimantWallets = (list: BeatClaimant[]) => list.filter(hasClaimed).map((c) => c.wallet).join('\n')

// ── Back from Stripe ─────────────────────────────────────────────────────────

/** Stripe sends the host back to `/beats?id=<id>&payment=<payment id>`, or `&payment=cancelled`. */
export const PAYMENT_CANCELLED = 'cancelled'
export const PAYMENT_POLL_MS = 3_000
export const PAYMENT_SLOW_MS = 5 * 60_000

/**
 * What the page says after Stripe: cancelled; received and waiting for the webhook (the BEAT is still a draft, or a cap
 * raise hasn't reached `waitCap`); or received. `settled` false means poll again.
 */
export function paymentNote(param: string | null, b: PublicBeat, waitCap: number | null, startedAt: number, now: Date): { text: string; settled: boolean } | null {
  if (!param) return null
  if (param === PAYMENT_CANCELLED) return { text: "Payment cancelled. You haven't been charged. Choose Pay to try again.", settled: true }
  if (b.status === 'cancelled') return null
  const waiting = b.status === 'draft' || (waitCap !== null && b.supplyCap < waitCap)
  if (!waiting) return { text: 'Payment received.', settled: true }
  return now.getTime() - startedAt > PAYMENT_SLOW_MS
    ? { text: "Stripe hasn't confirmed your payment yet. This can take a few minutes. If it is still waiting after 10 minutes, contact support@virvi.io and quote this BEAT's name. Don't pay again.", settled: false }
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
