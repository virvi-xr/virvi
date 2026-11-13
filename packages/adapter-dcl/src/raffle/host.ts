/**
 * The host HUD's Raffle tab (LIV-55): which raffle it shows, who is present now, and short error text.
 * Pure (no @dcl/sdk), so it is unit-tested. Creating and editing raffles stay on the dashboard.
 */
import { PRESENT_WINDOW_MS } from '@virvixr/shared'
import { friendlyEditError } from '../edit-errors.js'
import { errorCodeOf } from './card.js'

export interface HUDRaffle {
  id: string
  name: string
  status: string
  entryCount: number
  /** Entrants who checked in within PRESENT_WINDOW_MS. */
  presentNow: number
}

/** The scene's running (open or drawn) raffle, else its newest draft (the list is newest first); null for neither. */
export function pickHostRaffle<T extends { status: string }>(list: T[]): T | null {
  return list.find((r) => r.status === 'open' || r.status === 'drawn') ?? list.find((r) => r.status === 'draft') ?? null
}

export function presentNow(entries: { lastSeenAt: string | null }[], now: number): number {
  return entries.filter((e) => e.lastSeenAt && now - Date.parse(e.lastSeenAt) <= PRESENT_WINDOW_MS).length
}

const HOST_ERRORS: Record<string, string> = {
  empty_pool: 'Nobody qualifies yet: take a snapshot while entrants are in the scene.',
  draw_in_progress: 'A draw just happened. Wait a few seconds.',
  raffle_already_active: 'This scene already has a raffle running. Close it first.',
  bad_status: "That can't be done in this raffle's current state.",
  bad_snapshots: 'Those snapshots are not from this raffle.',
  raffle_not_found: 'That raffle no longer exists.',
  forbidden: "You can't run raffles in this scene.",
}

export function raffleHostError(err: unknown, opts: { connected?: boolean } = {}): string {
  const code = errorCodeOf(err)
  if (code && HOST_ERRORS[code]) return HOST_ERRORS[code]
  return friendlyEditError(err, opts)
}

export const STATUS_LABEL: Record<string, string> = { draft: 'Draft', open: 'Open', drawn: 'Drawn', closed: 'Closed', cancelled: 'Cancelled' }
