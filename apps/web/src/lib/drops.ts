/** Dashboard Drops (LIV-194): automatic giveaways as the host API returns them, and the page's plain-language labels. */
import {
  giveawayTxUrl,
  type GiveawayChain, type GiveawayClaimStatus, type GiveawayMintState, type GiveawayPauseReason, type HostGiveaway,
} from '@virvixr/shared'
import { plural } from './format'
import { shortWallet } from './studio-people'

export type { HostGiveaway }

/** GET /api/giveaways/availability (answers even while giveaways are off). */
export interface GiveawayAvailability { enabled: boolean; gasCovered: boolean }

/** One row of GET /api/giveaways. `counts` is there when the server sends claim counts with the list. */
export type GiveawaySummary = Pick<HostGiveaway,
  'id' | 'name' | 'chain' | 'enabled' | 'walletAddress' | 'builderUrl' | 'startsAt' | 'endsAt' | 'claimCap' | 'minPresentSeconds' | 'pausedReason' | 'deleteState'
> & { createdAt: string; counts?: Partial<Record<GiveawayClaimStatus, number>> }

/** One of the host's own items, from GET /api/giveaways/creator-items. */
export interface CreatorItem { contractAddress: string; itemId: string; name: string; thumbnail: string | null; rarity: string | null; available: number }

/** One row of GET /api/giveaways/:id/claims. `wallet` is already short. */
export interface GiveawayClaimRow {
  id: string; wallet: string | null; status: GiveawayClaimStatus; failReason: string | null
  claimedAt: string | null; sentAt: string | null; txUrl: string | null; txUrls: string[]
}
export interface GiveawayClaimsPage { claims: GiveawayClaimRow[]; nextCursor: string | null }

/** POST /api/giveaways/:id/send-back. */
export interface GiveawaySendBack { txId: string; valueWei: string; toWallet: string }

// ── Copy ─────────────────────────────────────────────────────────────────────

export const GIVEAWAYS_OFF = "Automatic giveaways aren't switched on yet."
export const SEND_BACK_FIRST = 'Send back the POL first.'
export const GENERIC_ERROR = 'Something went wrong. Try again.'
export const TEST_BADGE = 'Test'

const PAUSE_TEXT: Record<GiveawayPauseReason, string> = {
  low_gas: 'not enough POL for gas',
  not_minter: 'an item needs the minter step',
  not_approved: 'an item is waiting for curation',
  rpc_down: "Polygon isn't answering",
}

export const CLAIM_STATUS_LABELS: Record<GiveawayClaimStatus, string> = {
  present: 'In the scene', waiting: 'Waiting', minting: 'Sending', sent: 'Sent', failed: 'Failed',
}

// ── Amounts ──────────────────────────────────────────────────────────────────

const WEI = /^\d+$/
const weiOf = (v: string): bigint => (WEI.test(v) ? BigInt(v) : BigInt(0))

/** A wei amount as POL with 4 decimals, rounded down (never more than is there); anything unreadable is 0. */
export function formatPol(wei: string): string {
  const units = weiOf(wei) / BigInt(100000000000000) // 10^14: 4 decimals of 10^18
  const whole = units / BigInt(10000)
  const frac = (units % BigInt(10000)).toString().padStart(4, '0')
  return `${whole}.${frac}`
}

export const polIsZero = (wei: string) => weiOf(wei) === BigInt(0)

/** "about 40 claims". */
export const claimsCoveredLabel = (n: number) => `about ${plural(n, 'claim')}`

/** The funding card's lines, and the low-gas warning when there is one. */
export function fundingLines(f: HostGiveaway['funding']): { lines: string[]; warning: string | null } {
  if (f.covered) {
    const lines = ['Gas is covered by your plan.']
    if (!polIsZero(f.withdrawableWei)) lines.push(`You also have ${formatPol(f.withdrawableWei)} POL here.`)
    return { lines, warning: null }
  }
  const lines = f.tankMissing
    ? ["Gas cover isn't set up on this server yet. Send POL to the address above."]
    : [`Send POL to the address above. It covers ${claimsCoveredLabel(f.claimsCovered)}.`]
  return { lines, warning: f.lowGas ? `Running low: ${claimsCoveredLabel(f.claimsCovered)} left.` : null }
}

// ── Items and status ─────────────────────────────────────────────────────────

export type Tone = 'neutral' | 'success' | 'warning' | 'danger'

/** An item's minter check as a step for the host. `builder` asks for the Builder link next to it. */
export function mintStep(state: GiveawayMintState | null, wallet: string | null): { tone: Tone; text: string; builder: boolean } {
  switch (state) {
    case 'ready': return { tone: 'success', text: 'Can mint ✓', builder: false }
    case 'not_minter': return { tone: 'warning', text: `Add ${wallet ? shortWallet(wallet) : 'the giveaway wallet'} as a minter in the Builder`, builder: true }
    case 'not_approved': return { tone: 'warning', text: 'Waiting for curation', builder: false }
    case 'sold_out': return { tone: 'danger', text: 'Sold out', builder: false }
    default: return { tone: 'neutral', text: 'Not checked yet', builder: false }
  }
}

/** The list's and the status bar's status: Off, On, Paused: {reason}, Ended (or Deleting while its POL goes back). */
export function giveawayStatus(
  g: Pick<HostGiveaway, 'enabled' | 'pausedReason' | 'endsAt' | 'deleteState'>, now: number,
): { label: string; tone: Tone } {
  if (g.deleteState === 'returning') return { label: 'Deleting', tone: 'neutral' }
  if (g.endsAt && Date.parse(g.endsAt) <= now) return { label: 'Ended', tone: 'neutral' }
  if (!g.enabled) return { label: 'Off', tone: 'neutral' }
  if (g.pausedReason) return { label: `Paused: ${PAUSE_TEXT[g.pausedReason] ?? 'check the giveaway'}`, tone: 'warning' }
  return { label: 'On', tone: 'success' }
}

/** Polygonscan's page for an address on the giveaway's chain. */
export function giveawayAddressUrl(chain: GiveawayChain, address: string): string {
  return `${new URL(giveawayTxUrl(chain, '0')).origin}/address/${address}`
}

// ── Errors ───────────────────────────────────────────────────────────────────

type ApiErr = { body?: { error?: string; message?: string; items?: unknown } } | null

export const errorCodeOf = (err: unknown): string | null => (err as ApiErr)?.body?.error ?? null

/** A refused call in the host's words: the server's own message, with a few of ours. */
export function dropsError(err: unknown): string {
  const code = errorCodeOf(err)
  if (code === 'send_back_first') return SEND_BACK_FIRST
  if (code === 'giveaways_off') return GIVEAWAYS_OFF
  return (err as ApiErr)?.body?.message?.trim() || GENERIC_ERROR
}

/** A `not_ready` refusal's failing items, each as "{name}: {step}". */
export function notReadyLines(err: unknown, items: HostGiveaway['items'], wallet: string | null): string[] {
  if (errorCodeOf(err) !== 'not_ready') return []
  const failing = (err as ApiErr)?.body?.items
  if (!Array.isArray(failing)) return []
  return failing.map((f: { contractAddress?: string; itemId?: string; state?: GiveawayMintState }) => {
    const known = items.find((i) => i.itemId === f.itemId && i.contractAddress?.toLowerCase() === f.contractAddress?.toLowerCase())
    return `${known?.name || `Item ${f.itemId}`}: ${mintStep(f.state ?? null, wallet).text}`
  })
}
