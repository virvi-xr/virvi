/**
 * The visitor's BEAT card (LIV-11): which state a BEAT is in for me, and what the card shows. Pure (no @dcl/sdk), so
 * it is unit-tested; BeatOverlay.tsx draws it and beat/connect.ts feeds it.
 */
import { beatConsentText, type VisitorBeat } from '@virvixr/shared'
import { httpStatusOf } from '../edit-errors.js'
import { errorCodeOf } from '../raffle/card.js'

export type BeatCardState =
  | 'hidden'
  /** No wallet: the one-time "Connect a wallet" notice. */
  | 'guest'
  | 'offer'
  | 'consent'
  | 'tracking'
  | 'claimable'
  /** Claimed or minting. */
  | 'pending'
  | 'minted'
  | 'failed'
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

export const GUEST_LINE = 'Connect a wallet to earn this BEAT'

const minutes = (n: number) => `${n} ${n === 1 ? 'minute' : 'minutes'}`
const minMinutes = (b: VisitorBeat) => Math.max(1, Math.ceil(b.minPresentSeconds / 60))

/** The BEAT's state for me at `now` (ms), before the consent view is layered on. */
export function beatState(beat: VisitorBeat | null, now: number, ui: Pick<BeatUi, 'guest' | 'noticeDone'>): BeatCardState {
  if (!beat) return 'hidden'
  if (ui.guest) return ui.noticeDone ? 'hidden' : 'guest'
  const c = beat.myClaim
  if (c?.status === 'minted') return 'minted'
  if (c?.status === 'claimed' || c?.status === 'minting') return 'pending'
  if (c?.status === 'failed') return 'failed'
  // The server's claimUntil is ends_at + BEAT_CLAIM_GRACE_MS: claiming stays open that long for whoever reached the minimum
  const over = now > Date.parse(beat.endsAt) || beat.status === 'ended'
  if (beat.soldOut) return 'soldOut'
  if (c && c.secondsPresent >= beat.minPresentSeconds) return now > Date.parse(beat.claimUntil) ? 'hidden' : 'claimable'
  if (over) return 'ended'
  return c ? 'tracking' : 'offer'
}

export function cardView(beat: VisitorBeat | null, now: number, ui: BeatUi = initialBeatUi(false)): BeatViewModel {
  let state = beatState(beat, now, ui)
  if (state === 'offer' && ui.view === 'consent') state = 'consent'
  const base: BeatViewModel = {
    state, visible: state !== 'hidden', title: beat?.name ?? '', test: !!beat?.test, line: null, body: null, progress: null, txUrl: null, actions: [], note: ui.note,
  }
  if (!beat) return base
  const name = beat.name
  const idle = !ui.busy
  switch (state) {
    case 'hidden':
      return base
    case 'guest':
      return { ...base, line: GUEST_LINE, actions: [{ id: 'dismiss', label: 'OK' }] }
    case 'offer':
      return { ...base, line: `Attend for ${minutes(minMinutes(beat))} to earn the ${name} BEAT`, actions: idle ? [{ id: 'track', label: 'Track my attendance' }] : [] }
    case 'consent':
      return { ...base, body: beatConsentText(name), actions: idle ? [{ id: 'confirm', label: 'Confirm' }, { id: 'cancel', label: 'Cancel' }] : [] }
    case 'tracking': {
      const seconds = beat.myClaim?.secondsPresent ?? 0
      const progress = { fraction: Math.min(1, seconds / Math.max(1, beat.minPresentSeconds)), label: `${Math.floor(seconds / 60)} of ${minutes(minMinutes(beat))}` }
      return { ...base, progress, actions: idle ? [{ id: 'stop', label: 'Stop tracking' }] : [] }
    }
    case 'claimable':
      return { ...base, actions: idle ? [{ id: 'claim', label: 'Claim your BEAT' }] : [] }
    case 'pending':
      return { ...base, line: 'Sending your BEAT…' }
    case 'minted': {
      const txUrl = beat.myClaim?.txUrl ?? null
      return { ...base, line: `Your ${name} BEAT is in your wallet`, txUrl, actions: txUrl ? [{ id: 'view_tx', label: 'View on Polygonscan' }] : [] }
    }
    case 'failed':
      return { ...base, line: "We couldn't send your BEAT yet. We'll retry." }
    case 'soldOut':
      return { ...base, line: 'All claimed' }
    case 'ended':
      return { ...base, line: 'This BEAT has ended.' }
  }
}

/** Check in (rather than just read the BEAT) while tracking and short of the minimum. */
export const checkInWanted = (beat: VisitorBeat | null, now: number, ui: BeatUi) => beatState(beat, now, ui) === 'tracking'

/** The guest notice: shown once per BEAT for the session (memory only), until dismissed or `showMs` of engine time. */
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
  no_wallet: 'Connect a wallet to earn this BEAT.',
  bad_consent: 'Agree to the terms to track your attendance.',
  too_late: 'This BEAT has ended.',
  too_early: "This BEAT hasn't opened yet.",
  not_yet: "You haven't been here long enough yet.",
  all_claimed: 'All of these BEATs have been claimed.',
  already_claimed: "You've already claimed this BEAT.",
  not_tracking: "You're not tracking this BEAT.",
  not_available: "You can't track this BEAT again.",
  scene_pass_required: 'BEATs can only be earned from inside the scene.',
}

/** Text for a failed opt-in, stop or claim (too_late on a claim means the grace has run out). */
export function beatError(err: unknown, action: 'track' | 'stop' | 'claim' = 'track'): string {
  const code = errorCodeOf(err)
  if (code === 'too_late' && action === 'claim') return 'The time to claim this BEAT is over.'
  if (code && BEAT_ERRORS[code]) return BEAT_ERRORS[code]
  if (httpStatusOf(err) === 429) return 'Too many tries. Wait a moment.'
  return 'Something went wrong. Try again.'
}
