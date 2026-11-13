/**
 * The visitor's raffle card (LIV-55): its state, what it shows, and the check-in clock. Pure (no @dcl/sdk), so it is
 * unit-tested; RaffleOverlay.tsx draws it and raffle/connect.ts feeds it.
 */
import { CHECKIN_INTERVAL_MS, raffleConsentText, type PublicRaffle } from '@virvixr/shared'
import { httpStatusOf } from '../edit-errors.js'

export interface RaffleCard {
  /** The scene's running raffle, as `raffle_changed` sends it (null: none). */
  raffle: PublicRaffle | null
  /** A guest (no wallet): can see the raffle, can't enter. */
  guest: boolean
  entered: boolean
  won: boolean
  view: 'card' | 'consent' | 'rules'
  /** An enter or withdraw is on its way. */
  busy: boolean
  /** Why the last enter or withdraw didn't go through. */
  note: string | null
}

export type CardEvent =
  | { type: 'raffle'; raffle: PublicRaffle | null }
  /** The caller's entry, from GET …/raffle/current. */
  | { type: 'mine'; entered: boolean; won: boolean }
  | { type: 'enter' }
  | { type: 'confirm' }
  | { type: 'cancel' }
  | { type: 'entered' }
  | { type: 'withdraw' }
  | { type: 'withdrawn' }
  | { type: 'failed'; note: string }
  /** A draw happened; `won` is whether I'm among its winners. */
  | { type: 'drawn'; won: boolean }
  | { type: 'rules' }
  | { type: 'close' }

export type CardAction = 'enter' | 'confirm' | 'cancel' | 'withdraw' | 'rules' | 'close'

export const initialCard = (guest: boolean): RaffleCard => ({ raffle: null, guest, entered: false, won: false, view: 'card', busy: false, note: null })

const running = (r: PublicRaffle | null) => !!r && (r.status === 'open' || r.status === 'drawn')
const hasRules = (r: PublicRaffle | null) => !!r?.rules?.trim()

export function cardReducer(s: RaffleCard, e: CardEvent): RaffleCard {
  switch (e.type) {
    case 'raffle': {
      // Another raffle (or none): the last one's entry and views don't carry over
      if (!e.raffle || e.raffle.id !== s.raffle?.id) return { ...initialCard(s.guest), raffle: e.raffle }
      return { ...s, raffle: e.raffle, view: running(e.raffle) ? s.view : 'card' }
    }
    case 'mine':
      return { ...s, entered: e.entered, won: e.won }
    case 'enter':
      if (s.guest || s.busy || s.entered || s.raffle?.status !== 'open') return s
      return { ...s, view: 'consent', note: null }
    case 'confirm':
      if (s.view !== 'consent' || s.busy) return s
      return { ...s, busy: true }
    case 'cancel':
      return s.busy ? s : { ...s, view: 'card' }
    case 'entered':
      return { ...s, entered: true, busy: false, view: 'card', note: null }
    case 'withdraw':
      if (!s.entered || s.busy) return s
      return { ...s, busy: true, note: null }
    case 'withdrawn':
      return { ...s, entered: false, busy: false, view: 'card' }
    case 'failed':
      return { ...s, busy: false, view: 'card', note: e.note }
    case 'drawn': {
      // Entry closes at the first draw; the room's raffle_changed confirms it shortly after
      const raffle = s.raffle && s.raffle.status === 'open' ? { ...s.raffle, status: 'drawn' as const } : s.raffle
      return { ...s, raffle, won: s.won || e.won, view: s.view === 'consent' ? 'card' : s.view }
    }
    case 'rules':
      return hasRules(s.raffle) ? { ...s, view: 'rules' } : s
    case 'close':
      return { ...s, view: 'card' }
  }
}

export interface CardViewModel {
  visible: boolean
  title: string
  prize: string
  entries: string
  /** The status line under the prize. */
  line: string | null
  /** The consent or rules text, when that view is open. */
  body: string | null
  actions: { id: CardAction; label: string }[]
  note: string | null
}

export const WON_LINE = 'You won! The host will contact you about your prize.'

export function cardView(s: RaffleCard): CardViewModel {
  const r = s.raffle
  const base = { title: r?.name ?? '', prize: r ? `Prize: ${r.prize}` : '', entries: r ? `${r.entryCount} ${r.entryCount === 1 ? 'entry' : 'entries'}` : '', note: s.note }
  if (!r || !running(r)) return { ...base, visible: false, line: null, body: null, actions: [] }
  if (s.view === 'consent') {
    return { ...base, visible: true, line: null, body: raffleConsentText(), actions: s.busy ? [] : [{ id: 'confirm', label: 'Confirm' }, { id: 'cancel', label: 'Cancel' }] }
  }
  if (s.view === 'rules') return { ...base, visible: true, line: null, body: r.rules ?? '', actions: [{ id: 'close', label: 'Close' }] }
  const rules = hasRules(r) ? [{ id: 'rules' as const, label: 'Rules' }] : []
  const withdraw = s.entered && !s.busy ? [{ id: 'withdraw' as const, label: 'Withdraw' }] : []
  let line: string | null
  let main: { id: CardAction; label: string }[] = []
  if (s.won) line = WON_LINE
  else if (r.status === 'drawn') { line = 'Entries closed'; main = withdraw }
  else if (s.entered) { line = 'Entered ✓'; main = withdraw }
  else if (s.guest) line = 'Sign in with a wallet to enter'
  else { line = null; main = s.busy ? [] : [{ id: 'enter', label: 'Enter raffle' }] }
  return { ...base, visible: true, line, body: null, actions: [...main, ...rules] }
}

/** Check in while entered in a running raffle (winners too: a re-spin can use a later snapshot). */
export const checkInWanted = (s: RaffleCard) => s.entered && running(s.raffle)

/** Counts engine time (the platform has no timers): true once every CHECKIN_INTERVAL_MS while active. */
export class CheckInClock {
  private elapsedMs = 0
  tick(dtSeconds: number, active: boolean): boolean {
    if (!active) {
      this.elapsedMs = 0
      return false
    }
    this.elapsedMs += dtSeconds * 1000
    if (this.elapsedMs < CHECKIN_INTERVAL_MS) return false
    this.elapsedMs = 0
    return true
  }
  reset(): void {
    this.elapsedMs = 0
  }
}

/** The `error` code of a @virvixr/client error (`HTTP 409: {"error":"entry_closed"}`), if any. */
export function errorCodeOf(err: unknown): string | null {
  const m = /^HTTP \d+: ([\s\S]*)$/.exec(err instanceof Error ? err.message : String(err))
  if (!m) return null
  try {
    const code = (JSON.parse(m[1]) as { error?: unknown })?.error
    return typeof code === 'string' ? code : null
  } catch {
    return null
  }
}

const ENTRY_ERRORS: Record<string, string> = {
  entry_closed: 'Entries are closed.',
  wallet_required: 'Sign in with a wallet to enter.',
  scene_pass_required: 'Do this from inside the scene.',
  consent_required: 'Agree to the raffle terms to enter.',
  not_entered: "You're not in this raffle.",
  raffle_not_found: 'This raffle has ended.',
}

/** Text for a failed enter or withdraw. */
export function raffleEntryError(err: unknown): string {
  const code = errorCodeOf(err)
  if (code && ENTRY_ERRORS[code]) return ENTRY_ERRORS[code]
  if (httpStatusOf(err) === 429) return 'Too many tries. Wait a moment.'
  return 'Something went wrong. Try again.'
}

/** Names and other visitor text as plain text: a zero-width space after `<` keeps Decentraland's text from reading tags. */
export const plainText = (s: string) => s.replace(/</g, '<​')
