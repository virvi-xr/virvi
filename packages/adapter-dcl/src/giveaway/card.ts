/**
 * The visitor's giveaway card (LIV-194): which state the scene's giveaway is in for me, and what the card shows. Pure
 * (no @dcl/sdk), so it is unit-tested; GiveawayOverlay.tsx draws it and giveaway/connect.ts feeds it. Modelled on the
 * BEAT card (beat/card.ts).
 */
import { shortWallet, type AvailableGiveaway, type VisitorGiveaway } from '@virvixr/shared'
import { httpStatusOf, isNetworkError } from '../edit-errors.js'
import { errorCodeOf } from '../raffle/card.js'
import { NETWORK_LINE, WORKING_LINE } from '../beat/card.js'

export { GuestNotice } from '../beat/card.js'

export type GiveawayCardState =
  | 'hidden'
  /** No wallet: the one-time "Connect a wallet" notice. */
  | 'guest'
  /** Not joined yet: what's free, and the consent notice. */
  | 'consent'
  /** Joined, short of the minimum time. */
  | 'present'
  /** Joined with the minimum time: Claim. */
  | 'ready'
  /** Claimed: `waiting` or `minting`. */
  | 'sending'
  | 'sent'
  | 'failed'

/** What the card adds to the server's giveaway: who I am here and what I'm doing on it. */
export interface GiveawayUi {
  /** No wallet: can't take part. */
  guest: boolean
  /** The guest notice for this giveaway has been shown. */
  noticeDone: boolean
  /** My wallet, for the consent notice (shown short). */
  wallet: string | null
  /** An agree or claim is on its way. */
  busy: boolean
  /** Why the last agree or claim didn't go through. */
  note: string | null
}

export const initialGiveawayUi = (guest: boolean, wallet: string | null): GiveawayUi =>
  ({ guest, noticeDone: false, wallet, busy: false, note: null })

export type GiveawayAction = 'agree' | 'claim' | 'view_tx'

export interface GiveawayViewModel {
  state: GiveawayCardState
  visible: boolean
  title: string
  /** On the test network: a small "Test" label. */
  test: boolean
  line: string | null
  /** The consent notice, before joining. */
  notice: string | null
  txUrl: string | null
  actions: { id: GiveawayAction; label: string }[]
  note: string | null
}

/** What the card can be given: the visitor's giveaway (HTTP), or for a guest the room's `giveaway_available`. */
export type CardGiveaway = VisitorGiveaway | AvailableGiveaway

const isVisitorGiveaway = (g: CardGiveaway): g is VisitorGiveaway => 'id' in g
/** One per giveaway: its id, or for a guest's announced giveaway (no id) its name. */
export const giveawayKey = (g: CardGiveaway | null): string | null => (g ? (isVisitorGiveaway(g) ? g.id : g.name) : null)

/** Seconds as m:ss. */
export function stayLeft(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const stayLine = (seconds: number) => `Stay ${stayLeft(seconds)} more to claim.`

export function giveawayState(g: CardGiveaway | null, ui: Pick<GiveawayUi, 'guest' | 'noticeDone'>): GiveawayCardState {
  if (!g) return 'hidden'
  if (ui.guest) return ui.noticeDone ? 'hidden' : 'guest'
  if (!isVisitorGiveaway(g)) return 'hidden'
  const c = g.claim
  if (!c) return 'consent'
  switch (c.status) {
    case 'present': return c.secondsPresent >= g.minPresentSeconds ? 'ready' : 'present'
    case 'waiting':
    case 'minting': return 'sending'
    case 'sent': return 'sent'
    case 'failed': return 'failed'
    default: return 'hidden'
  }
}

const FAIL_REASONS: Record<string, string> = { sold_out: 'this giveaway ran out.' }

export function giveawayCardView(g: CardGiveaway | null, ui: GiveawayUi): GiveawayViewModel {
  const state = giveawayState(g, ui)
  const base: GiveawayViewModel = {
    state, visible: state !== 'hidden', title: g?.name ?? '', test: !!g?.test, line: null, notice: null, txUrl: null, actions: [], note: ui.note,
  }
  if (!g) return base
  if (state === 'guest') return { ...base, line: `Connect a wallet to claim ${g.name}.` }
  if (state === 'hidden' || !isVisitorGiveaway(g)) return base
  const v = view(g, state, ui, base)
  // While an agree or claim is on its way the buttons go, and the card says it's working rather than look frozen
  if (ui.busy && v.actions.length) return { ...v, line: WORKING_LINE, actions: [] }
  return v
}

function view(g: VisitorGiveaway, state: GiveawayCardState, ui: GiveawayUi, base: GiveawayViewModel): GiveawayViewModel {
  const c = g.claim
  switch (state) {
    case 'consent': {
      const yours = ui.wallet ? `your wallet ${shortWallet(ui.wallet)}` : 'your wallet'
      return {
        ...base,
        line: `${g.name}: free ${g.items.map((i) => i.name).join(', ')}.`,
        notice: `Virvi will mint these to ${yours}. The host sees that this wallet claimed.`,
        actions: [{ id: 'agree', label: 'Agree and continue' }],
      }
    }
    case 'present':
      return { ...base, line: stayLine(g.minPresentSeconds - (c?.secondsPresent ?? 0)) }
    case 'ready':
      return { ...base, actions: [{ id: 'claim', label: 'Claim' }] }
    case 'sending':
      return { ...base, line: 'On its way.' }
    case 'sent': {
      const txUrl = c?.txUrl ?? null
      return { ...base, line: 'Sent ✓', txUrl, actions: txUrl ? [{ id: 'view_tx', label: 'View' }] : [] }
    }
    case 'failed':
      return { ...base, line: `Couldn't send: ${FAIL_REASONS[c?.failReason ?? ''] ?? 'something went wrong.'}` }
    default:
      return base
  }
}

/** Check in (rather than just read the giveaway) while joined and short of the minimum. */
export const checkInWanted = (g: CardGiveaway | null, ui: GiveawayUi) => giveawayState(g, ui) === 'present'

const GIVEAWAY_ERRORS: Record<string, string> = {
  wallet_required: 'Connect a wallet to claim.',
  wallet_blocked: "This wallet can't claim giveaways any more.",
  already_claimed: 'This wallet already claimed this giveaway.',
  claimed: "You've already claimed this giveaway.",
  too_soon: "You haven't been here long enough yet.",
  sold_out: 'This giveaway ran out.',
  closed: 'This giveaway is closed.',
  not_found: 'This giveaway is no longer here.',
  not_tracking: "You haven't joined this giveaway.",
  consent_outdated: 'This scene needs an update before you can claim. Ask the host to update it.',
  profile_required: 'Set up your Decentraland profile (an avatar) first, then come back to claim.',
  too_many_new_wallets: 'Too many new wallets have claimed from your network. Try again later.',
  scene_pass_required: 'Giveaways can only be claimed from inside the scene.',
  giveaways_off: "Giveaways aren't switched on here yet.",
}

/** `secondsLeft` from a too_soon refusal's body, if it carries one. */
function secondsLeftOf(err: unknown): number | null {
  const m = /^HTTP \d+: ([\s\S]*)$/.exec(err instanceof Error ? err.message : String(err))
  if (!m) return null
  try {
    const n = (JSON.parse(m[1]) as { secondsLeft?: unknown })?.secondsLeft
    return typeof n === 'number' && Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

/** Text for a failed agree or claim. */
export function giveawayError(err: unknown): string {
  const code = errorCodeOf(err)
  if (code === 'too_soon') {
    const left = secondsLeftOf(err)
    if (left !== null && left > 0) return stayLine(left)
  }
  if (code && GIVEAWAY_ERRORS[code]) return GIVEAWAY_ERRORS[code]
  if (httpStatusOf(err) === 429) return 'Too many tries. Wait a moment.'
  if (isNetworkError(err)) return NETWORK_LINE
  return 'Something went wrong. Try again.'
}
