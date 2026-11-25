/**
 * The visitor's BEAT card (LIV-11): which state a BEAT is in for me, and what the card shows. Pure (no @dcl/sdk), so
 * it is unit-tested; BeatOverlay.tsx draws it and beat/connect.ts feeds it.
 */
import { beatConsentText, type AvailableBeat, type VisitorBeat } from '@virvixr/shared'
import { httpStatusOf, isNetworkError } from '../edit-errors.js'
import { errorCodeOf } from '../raffle/card.js'

export type BeatCardState =
  | 'hidden'
  /** No wallet: the one-time "Sign in with a wallet" notice. */
  | 'guest'
  | 'offer'
  | 'consent'
  | 'tracking'
  | 'claimable'
  /** Claimed or minting (or held for the host's review). */
  | 'pending'
  | 'minted'
  | 'failed'
  /** The host took the claim out before it was sent. */
  | 'removed'
  | 'soldOut'
  /** Over, and I never reached the minimum. */
  | 'ended'

/** What the card adds to the server's BEAT: who I am here and what I'm doing on it. */
export interface BeatUi {
  /** No wallet: can't take part. */
  guest: boolean
  /** The guest notice for this BEAT has been shown (GuestNotice). */
  noticeDone: boolean
  view: 'card' | 'consent'
  /** An opt-in, stop or claim is on its way. */
  busy: boolean
  /** Why the last opt-in, stop or claim didn't go through. */
  note: string | null
}

export const initialBeatUi = (guest: boolean): BeatUi => ({ guest, noticeDone: false, view: 'card', busy: false, note: null })

export type BeatAction = 'track' | 'confirm' | 'cancel' | 'stop' | 'claim' | 'view_tx' | 'dismiss'

export interface BeatViewModel {
  state: BeatCardState
  visible: boolean
  title: string
  /** On the test network: a small "Test" label. */
  test: boolean
  line: string | null
  /** The consent text, while it is open. */
  body: string | null
  /** Minutes present against the minimum, while tracking. */
  progress: { fraction: number; label: string } | null
  txUrl: string | null
  actions: { id: BeatAction; label: string }[]
  note: string | null
}

/** The one phrase for "you need a wallet" (the guest notice, the no_wallet error and the server's message). */
export const GUEST_LINE = "Sign in to Decentraland with a wallet to earn this BEAT. Guests can't."
export const WORKING_LINE = 'Working…'
export const PRACTICE_LINE = 'This is a practice BEAT.'
export const STORED_LINE = 'Your wallet and name are still saved for this BEAT. Stop tracking to delete them.'
/** Auto-claim (LIV-180): added to the tracking line, and the start of the pending line. */
export const AUTO_CLAIM_TRACKING_LINE = "It's claimed for you once you've been here long enough."
export const AUTO_CLAIM_PENDING_LINE = 'Your BEAT is on its way.'

/** What the card can be given: the visitor's BEAT (HTTP), or for a guest the room's `beat_available` (name and test flag). */
export type CardBeat = VisitorBeat | AvailableBeat

const isVisitorBeat = (b: CardBeat): b is VisitorBeat => 'id' in b
/** One per BEAT: its id, or for a guest's announced BEAT (no id) its name. */
export const beatKey = (b: CardBeat | null): string | null => (b ? (isVisitorBeat(b) ? b.id : b.name) : null)

const minutes = (n: number) => `${n} ${n === 1 ? 'minute' : 'minutes'}`
const minMinutes = (b: VisitorBeat) => Math.max(1, Math.ceil(b.minPresentSeconds / 60))

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** A time as `6:00 PM UTC`. In UTC, named, because the scene runtime's own time zone isn't the visitor's. */
export function cardTime(iso: string): string {
  const d = new Date(iso)
  const h = d.getUTCHours()
  return `${h % 12 === 0 ? 12 : h % 12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'} UTC`
}
/** A date and time as `Nov 15, 6:00 PM UTC`. */
export const cardDateTime = (iso: string) => `${MONTHS[new Date(iso).getUTCMonth()]} ${new Date(iso).getUTCDate()}, ${cardTime(iso)}`

const CLOSING_SOON_MS = 2 * 3_600_000

/** The BEAT's state for me at `now` (ms), before the consent view is layered on. */
export function beatState(beat: CardBeat | null, now: number, ui: Pick<BeatUi, 'guest' | 'noticeDone'>): BeatCardState {
  if (!beat) return 'hidden'
  if (ui.guest) return ui.noticeDone ? 'hidden' : 'guest'
  if (!isVisitorBeat(beat)) return 'hidden'
  const c = beat.myClaim
  if (c?.status === 'minted') return 'minted'
  if (c?.status === 'claimed' || c?.status === 'minting') return 'pending'
  if (c?.status === 'failed') return 'failed'
  if (c?.status === 'removed') return 'removed'
  // The server's claimUntil is ends_at + BEAT_CLAIM_GRACE_MS: claiming stays open that long for whoever reached the minimum
  const over = now > Date.parse(beat.endsAt) || beat.status === 'ended'
  // After the end the card is only for visitors who took part (LIV-184): "All claimed" or "ended" tells anyone else nothing
  if (over && !c) return 'hidden'
  if (beat.soldOut) return 'soldOut'
  if (c && c.secondsPresent >= beat.minPresentSeconds && now >= Date.parse(beat.startsAt)) return now > Date.parse(beat.claimUntil) ? 'hidden' : 'claimable'
  if (over) return 'ended'
  return c ? 'tracking' : 'offer'
}

/** Stop tracking is offered whenever I'm tracking and haven't claimed: the consent promises it any time before a claim. */
export function stopAllowed(beat: CardBeat | null, now: number, ui: Pick<BeatUi, 'guest' | 'noticeDone'>): boolean {
  if (!beat || !isVisitorBeat(beat) || beat.myClaim?.status !== 'present') return false
  return ['tracking', 'claimable', 'soldOut', 'ended'].includes(beatState(beat, now, ui))
}

/** The offer: how long to stay, and before the start when it starts (time only counts from then). */
function offerLine(b: VisitorBeat, now: number): string {
  const stay = b.minPresentSeconds === 0 ? 'Be there to earn the BEAT.' : `Stay for ${minutes(minMinutes(b))} to earn the BEAT.`
  const parts = [stay]
  if (now < Date.parse(b.startsAt)) parts.push(`It starts at ${cardTime(b.startsAt)}, and your time counts once it starts.`)
  if (b.test) parts.push(PRACTICE_LINE)
  return parts.join(' ')
}

export function cardView(beat: CardBeat | null, now: number, ui: BeatUi = initialBeatUi(false)): BeatViewModel {
  let state = beatState(beat, now, ui)
  if (state === 'offer' && ui.view === 'consent') state = 'consent'
  const base: BeatViewModel = {
    state, visible: state !== 'hidden', title: beat?.name ?? '', test: !!beat?.test, line: null, body: null, progress: null, txUrl: null, actions: [], note: ui.note,
  }
  if (!beat) return base
  if (state === 'guest') return { ...base, line: GUEST_LINE, actions: [{ id: 'dismiss', label: 'OK' }] }
  if (state === 'hidden' || !isVisitorBeat(beat)) return base
  const v = view(beat, state, now, base)
  if (stopAllowed(beat, now, ui) && !v.actions.some((a) => a.id === 'stop')) v.actions.push({ id: 'stop', label: 'Stop tracking' })
  // While an opt-in, stop or claim is on its way the buttons go, and the card says it's working rather than look frozen
  if (ui.busy && v.actions.length) return { ...v, line: WORKING_LINE, actions: [] }
  return v
}

function view(beat: VisitorBeat, state: BeatCardState, now: number, base: BeatViewModel): BeatViewModel {
  const c = beat.myClaim
  switch (state) {
    case 'offer':
      return { ...base, line: offerLine(beat, now), actions: [{ id: 'track', label: 'Track my attendance' }] }
    case 'consent':
      return { ...base, body: beatConsentText(beat.name, { autoClaim: !!beat.autoClaim }), actions: [{ id: 'confirm', label: 'I agree' }, { id: 'cancel', label: 'Cancel' }] }
    case 'tracking': {
      const seconds = c?.secondsPresent ?? 0
      const progress = { fraction: Math.min(1, seconds / Math.max(1, beat.minPresentSeconds)), label: `${Math.floor(seconds / 60)} of ${minutes(minMinutes(beat))}` }
      const line = now < Date.parse(beat.startsAt)
        ? `This BEAT starts at ${cardTime(beat.startsAt)}. Your time counts once it starts.`
        : 'Time counts while the event is running.'
      return { ...base, line: beat.autoClaim ? `${line} ${AUTO_CLAIM_TRACKING_LINE}` : line, progress, actions: [] }
    }
    case 'claimable': {
      const closing = Date.parse(beat.claimUntil) - now < CLOSING_SOON_MS ? ` Claiming closes at ${cardTime(beat.claimUntil)}.` : ''
      return {
        ...base,
        line: `You've been here long enough. Claim your BEAT before ${cardDateTime(beat.claimUntil)}. Claiming sends it to your wallet, and it's recorded publicly on Polygon.${closing}`,
        actions: [{ id: 'claim', label: 'Claim your BEAT' }],
      }
    }
    case 'pending': {
      const held = c?.heldUntil
        ? `The host checks claims before they're sent. Your BEAT is sent once they do, by ${cardDateTime(c.heldUntil)} at the latest. You can leave the scene.`
        : null
      // On an auto-claim BEAT the claim may have happened on its own, so the card says so first
      if (beat.autoClaim) return { ...base, line: `${AUTO_CLAIM_PENDING_LINE} ${held ?? 'This usually takes a few minutes, and you can leave the scene.'}` }
      return { ...base, line: held ?? 'Sending your BEAT. This usually takes a few minutes, and you can leave the scene.' }
    }
    case 'minted': {
      const txUrl = c?.txUrl ?? null
      return { ...base, line: `Your ${beat.name} BEAT is in your wallet`, txUrl, actions: txUrl ? [{ id: 'view_tx', label: 'See it on Polygonscan' }] : [] }
    }
    case 'failed':
      return {
        ...base,
        line: c?.final
          ? "We couldn't send this BEAT to your wallet, and we've stopped trying. Please ask the event host for help."
          : "We couldn't send your BEAT yet. We'll keep trying, so check back later.",
      }
    case 'removed':
      return { ...base, line: "The event host removed your claim, so this BEAT won't be sent to you. Ask the host if you think this is a mistake." }
    case 'soldOut':
      return { ...base, line: c ? `All claimed. ${STORED_LINE}` : 'All claimed' }
    case 'ended':
      return { ...base, line: c ? `This BEAT has ended. ${STORED_LINE}` : 'This BEAT has ended.' }
    default:
      return base
  }
}

/** Check in (rather than just read the BEAT) while tracking and short of the minimum. */
export const checkInWanted = (beat: CardBeat | null, now: number, ui: BeatUi) => beatState(beat, now, ui) === 'tracking'

/** The guest notice: shown once per BEAT (beatKey) for the session (memory only), until dismissed or `showMs` of engine time. */
export class GuestNotice {
  private shownMs = new Map<string, number>()
  private finished = new Set<string>()
  constructor(private readonly showMs: number) {}
  done(beatId: string): boolean {
    return this.finished.has(beatId)
  }
  /** Count engine time for the BEAT whose notice is showing. */
  tick(beatId: string, dtSeconds: number): void {
    if (this.finished.has(beatId)) return
    const ms = (this.shownMs.get(beatId) ?? 0) + dtSeconds * 1000
    this.shownMs.set(beatId, ms)
    if (ms >= this.showMs) this.finished.add(beatId)
  }
  dismiss(beatId: string): void {
    this.finished.add(beatId)
  }
}

const BEAT_ERRORS: Record<string, string> = {
  no_wallet: GUEST_LINE,
  bad_consent: 'This scene needs an update before you can claim. Ask the host to update it.',
  too_late: 'This BEAT has ended.',
  too_early: "This BEAT hasn't opened yet.",
  not_started: "This event hasn't started yet. Claim once it starts.",
  not_yet: "You haven't been here long enough yet.",
  all_claimed: 'All of these BEATs have been claimed.',
  already_claimed: "You've already claimed this BEAT.",
  not_tracking: "You're not tracking this BEAT.",
  not_available: "You stopped tracking this BEAT, so you can't start again.",
  scene_pass_required: 'BEATs can only be earned from inside the scene.',
  profile_required: 'Set up your Decentraland profile (an avatar) first, then come back to collect this BEAT.',
  too_many_from_network: 'This BEAT has already been claimed the most times allowed from your network.',
  too_many_new_wallets: 'Too many new wallets have collected BEATs from your network. Try again later.',
  wallet_blocked: 'This wallet can no longer use Virvi.',
}

export const NETWORK_LINE = "Couldn't reach Virvi. Check your connection and try again."

/** Text for a failed opt-in, stop or claim (too_late on a claim means the grace has run out). */
export function beatError(err: unknown, action: 'track' | 'stop' | 'claim' = 'track'): string {
  const code = errorCodeOf(err)
  if (code === 'too_late' && action === 'claim') return 'The time to claim this BEAT is over.'
  if (code && BEAT_ERRORS[code]) return BEAT_ERRORS[code]
  if (httpStatusOf(err) === 429) return 'Too many tries. Wait a moment.'
  if (isNetworkError(err)) return NETWORK_LINE
  return 'Something went wrong. Try again.'
}
