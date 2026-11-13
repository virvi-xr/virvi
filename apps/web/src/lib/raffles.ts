/** Dashboard Raffles tab (LIV-55): the shapes the host API returns, form rules and plain-language errors. */
import {
  AUTO_SNAPSHOT_MINUTES, MIN_PRESENT_DEFAULT_MINUTES, RAFFLE_RULES_TEMPLATE, RAFFLE_WINNERS_MAX,
} from '@virvixr/shared'
import type { RaffleMode, RaffleStatus } from '@virvixr/shared'

export type { RaffleMode, RaffleStatus }

/** One raffle as the host sees it (GET /api/scenes/:sceneId/raffles and /api/raffles/:id). */
export interface HostRaffle {
  id: string
  sceneId: string
  name: string
  prize: string
  rules: string | null
  winnersCount: number
  mode: RaffleMode
  minPresentMinutes: number
  autoSnapshotMinutes: number | null
  status: RaffleStatus
  entryCount: number
  openedAt: string | null
  endedAt: string | null
}

/** An entry; a removed entrant has no name or wallet. */
export interface RaffleEntryRow { id: string; displayName: string | null; wallet: string | null; secondsPresent: number; lastSeenAt: string | null; createdAt: string }
export interface RaffleSnapshotRow { id: string; takenAt: string; trigger: 'manual' | 'auto'; entryIds: string[] }
/** A winner; a removed (withdrawn or deleted) entrant has no name or wallet. */
export interface RaffleWinner { entryId: string; displayName: string | null; wallet: string | null; deleted?: true }
export interface RaffleDrawRow { id: string; drawnAt: string; mode: RaffleMode; algorithm: string; snapshotIds: string[]; poolSize: number; winners: RaffleWinner[] }
export interface RaffleDetail { raffle: HostRaffle; entries: RaffleEntryRow[]; snapshots: RaffleSnapshotRow[]; draws: RaffleDrawRow[] }

export interface RaffleInput {
  name: string
  prize: string
  winnersCount: number
  mode: RaffleMode
  minPresentMinutes: number
  autoSnapshotMinutes: number | null
  rules: string
  acceptHostTerms: boolean
}

export const AUTO_SNAPSHOT_CHOICES: readonly (number | null)[] = [null, ...AUTO_SNAPSHOT_MINUTES]
export const MODE_LABELS: Record<RaffleMode, string> = { one_per_person: 'One entry per person', weighted: 'Weighted by time present' }
export const STATUS_LABELS: Record<RaffleStatus, string> = { draft: 'Draft', open: 'Open', drawn: 'Drawn', closed: 'Closed', cancelled: 'Cancelled' }

export function blankRaffle(): RaffleInput {
  return { name: '', prize: '', winnersCount: 1, mode: 'one_per_person', minPresentMinutes: MIN_PRESENT_DEFAULT_MINUTES, autoSnapshotMinutes: null, rules: '', acceptHostTerms: false }
}

/** The rules template with the prize, winners and host filled in. */
export function fillRules(prize: string, winners: number, host: string): string {
  return RAFFLE_RULES_TEMPLATE
    .replace('{prize}', () => prize.trim() || '…')
    .replace('{winners}', () => String(winners))
    .replace('{host}', () => host)
}

/** The host name the rules show: the signed-in user's display name, else the scene's name. */
export function rulesHost(displayName: string | null | undefined, sceneName: string): string {
  return displayName?.trim() || sceneName
}

/** Why the form can't be sent yet, or null. A new raffle needs the terms ticked; an edit doesn't. */
export function raffleFormError(f: RaffleInput, opts: { editing?: boolean } = {}): string | null {
  if (!f.name.trim()) return 'Give the raffle a name.'
  if (!f.prize.trim()) return 'Say what the prize is.'
  if (!Number.isInteger(f.winnersCount) || f.winnersCount < 1 || f.winnersCount > RAFFLE_WINNERS_MAX) return `Pick 1 to ${RAFFLE_WINNERS_MAX} winners.`
  if (!opts.editing && !f.acceptHostTerms) return 'Accept the host terms to run a raffle.'
  return null
}

/** The body POST /api/scenes/:sceneId/raffles takes. */
export function raffleBody(f: RaffleInput) {
  return {
    name: f.name.trim(), prize: f.prize.trim(), winnersCount: f.winnersCount, mode: f.mode, minPresentMinutes: f.minPresentMinutes,
    autoSnapshotMinutes: f.autoSnapshotMinutes, rules: f.rules.trim() || null, acceptHostTerms: f.acceptHostTerms,
  }
}

/** The edit form's starting values: the raffle as it is (its host terms were accepted when it was created). */
export function raffleToInput(r: HostRaffle): RaffleInput {
  return {
    name: r.name, prize: r.prize, winnersCount: r.winnersCount, mode: r.mode, minPresentMinutes: r.minPresentMinutes,
    autoSnapshotMinutes: r.autoSnapshotMinutes, rules: r.rules ?? '', acceptHostTerms: true,
  }
}

/** The body PATCH /api/raffles/:raffleId takes: the create fields, less the host terms. */
export function editBody(f: RaffleInput) {
  const { acceptHostTerms: _terms, ...body } = raffleBody(f)
  return body
}

/** How many winners a spin picks unless the host changes it: all of them first, then one replacement per re-spin. */
export function spinCountDefault(winnersCount: number, drawsSoFar: number): number {
  return drawsSoFar > 0 ? 1 : winnersCount
}

/** The body POST /api/raffles/:raffleId/draw takes; the snapshots go only when some are left out (else all are used). */
export function drawBody(count: number, chosen: string[], all: string[]): { count: number; snapshotIds?: string[] } {
  const everyOne = chosen.length === all.length && all.every((id) => chosen.includes(id))
  return everyOne ? { count } : { count, snapshotIds: chosen }
}

/** The question asked before an action that ends a raffle, or null for one that needs none. */
export function confirmAction(action: 'open' | 'snapshot' | 'draw' | 'close' | 'cancel'): string | null {
  if (action === 'close') return 'Close this raffle? No more spins can be made.'
  if (action === 'cancel') return 'Cancel this raffle? It will end without a draw.'
  return null
}

/** Which buttons a raffle in this status shows. */
export function raffleActions(status: RaffleStatus): Array<'open' | 'snapshot' | 'draw' | 'close' | 'cancel'> {
  switch (status) {
    case 'draft': return ['open', 'cancel']
    case 'open': return ['snapshot', 'draw', 'close', 'cancel']
    case 'drawn': return ['snapshot', 'draw', 'close']
    default: return []
  }
}

const ERRORS: Record<string, string> = {
  empty_pool: 'Nobody qualifies yet: take a snapshot while entrants are in the scene.',
  mode_locked: "The draw mode can't change after a snapshot.",
  bad_snapshots: 'Pick snapshots of this raffle.',
  bad_count: 'Pick how many winners this spin draws, from 1 to the raffle\'s number of winners.',
  raffle_already_active: 'This scene already has a raffle running. Close it first.',
  draw_in_progress: 'A draw just happened. Wait a few seconds.',
  bad_status: "That can't be done in this raffle's current state.",
  raffle_not_found: 'Raffle not found.',
  host_terms_required: 'Accept the host terms to run a raffle.',
  name_required: 'Give the raffle a name.',
  prize_required: 'Say what the prize is.',
  rules_too_long: 'The rules are too long.',
  winners_out_of_range: `Pick 1 to ${RAFFLE_WINNERS_MAX} winners.`,
  bad_mode: 'Pick one entry per person or weighted by time present.',
  min_present_out_of_range: 'The minimum time present is 0 to 120 minutes.',
  bad_auto_snapshot: `Automatic snapshots are off or every ${AUTO_SNAPSHOT_MINUTES.join(', ')} minutes.`,
  forbidden: "You can't run raffles in this scene.",
}

/** A short message for a failed raffle call (an Error whose message is the server's error code). */
export function raffleErrorMessage(err: unknown): string {
  const e = err as { message?: string; body?: { message?: string } } | null
  const code = e?.message ?? ''
  return ERRORS[code] ?? e?.body?.message ?? 'Something went wrong. Try again.'
}

export const REMOVED_ENTRANT = 'Removed entrant'

/** What a winner shows as: the name and wallet, or "Removed entrant" with neither. */
export function winnerLabel(w: RaffleWinner): { name: string; wallet: string | null } {
  if (w.deleted || w.displayName === null) return { name: REMOVED_ENTRANT, wallet: null }
  return { name: w.displayName, wallet: w.wallet }
}

/** What an entry shows as: the name and wallet, or "Removed entrant" with neither. */
export function entryLabel(e: RaffleEntryRow): { name: string; wallet: string | null } {
  if (e.displayName === null) return { name: REMOVED_ENTRANT, wallet: null }
  return { name: e.displayName, wallet: e.wallet }
}

/** Minutes present, to one decimal ("4.5"), whole numbers bare. */
export function minutesPresent(seconds: number): string {
  const m = Math.round(seconds / 6) / 10
  return String(m)
}
