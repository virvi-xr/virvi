/** Raffle constants, copy and name cleaning (LIV-55). Defined once here; the server, dashboard and scenes import them. */

export const RAFFLE_CONSENT_VERSION = 1
export const CHECKIN_INTERVAL_MS = 30_000
export const PRESENT_WINDOW_MS = 60_000
export const CHECKIN_CAP_SECONDS = 45
export const CHECKIN_MIN_GAP_MS = 20_000
export const DRAW_COOLDOWN_MS = 15_000
export const RAFFLE_WINNERS_MAX = 20
export const MIN_PRESENT_DEFAULT_MINUTES = 5
export const MIN_PRESENT_MAX_MINUTES = 120
export const AUTO_SNAPSHOT_MINUTES = [5, 10, 15, 30] as const
export const RAFFLE_RETENTION_DAYS = 30
export const AUTO_CLOSE_AFTER_DRAW_DAYS = 7
export const AUTO_CLOSE_AFTER_OPEN_DAYS = 30
export const WHEEL_MAX_NAMES = 60
export const DRAW_ALGORITHM = 'v1'

export type RaffleStatus = 'draft' | 'open' | 'drawn' | 'closed' | 'cancelled'
export type RaffleMode = 'one_per_person' | 'weighted'

const DISPLAY_NAME_MAX = 40

export function raffleConsentText(): string {
  return 'Your display name (or a shortened wallet address if you have no name) will be shown on the raffle wheel to everyone in this scene, and your name and wallet will be shared with the host so they can deliver your prize. You can withdraw until the draw.'
}

export const RAFFLE_HOST_TERMS =
  "This raffle is free to enter and needs no purchase. I'm responsible for following the giveaway and sweepstakes rules where I and my entrants live, and for delivering prizes."

export const RAFFLE_RULES_TEMPLATE = `Official rules. Prize: {prize}. Winners: {winners}. Host: {host}.
Eligibility: anyone 18 or older with a verified wallet, where not prohibited by law.
How to enter: entry is free. Enter in the scene. No purchase is needed.
How winners are picked: a random draw among entrants who were present in the host's snapshots. The algorithm is published at /docs/raffles.
Prizes: the host delivers each prize to the winning wallet within 30 days.
Withdrawal: you can withdraw your entry any time before the draw.`

/** 0x1234…abcd, lower-cased. */
export function shortWallet(wallet: string): string {
  const w = wallet.toLowerCase()
  return `${w.slice(0, 6)}…${w.slice(-4)}`
}

/** Control characters out, trimmed, at most 40 characters; the wallet stands in when nothing is left. Markup is kept: UIs render it as text. */
export function cleanDisplayName(raw: string | null | undefined, wallet: string): string {
  const cleaned = Array.from((raw ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim())
    .slice(0, DISPLAY_NAME_MAX)
    .join('')
    .trim()
  return cleaned || shortWallet(wallet)
}

/** What visitors may see of a raffle: no entrant names or wallets. Sent in `raffle_changed` and to scenes. */
export interface PublicRaffle {
  id: string
  sceneId: string
  name: string
  prize: string
  rules: string | null
  status: RaffleStatus
  winnersCount: number
  entryCount: number
}

/** One spin, for the wheel: at most WHEEL_MAX_NAMES names (always including the winners), `more` for the rest of the pool. */
export interface PublicDraw {
  drawId: string
  raffleId: string
  names: string[]
  more: number
  /** In draw order: the wheel lands on the first. */
  winners: { entryId: string; displayName: string }[]
}
