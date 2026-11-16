/** BEAT constants, copy, pricing and links (LIV-11). Defined once here; the server, dashboard and scenes import them. */

export const BEAT_CHAINS = ['polygon-amoy', 'polygon'] as const
export type BeatChain = (typeof BEAT_CHAINS)[number]

export const BEAT_CHAIN_INFO: Record<BeatChain, { chainId: number; confirmations: number; explorer: string; label: string }> = {
  'polygon-amoy': { chainId: 80002, confirmations: 5, explorer: 'https://amoy.polygonscan.com', label: 'Polygon Amoy (test)' },
  polygon: { chainId: 137, confirmations: 30, explorer: 'https://polygonscan.com', label: 'Polygon' },
}

export type BeatStatus = 'draft' | 'paid' | 'live' | 'ended' | 'cancelled'
/** `removed`: a host took the claim out before it was sent (hold for review); it frees its supply and can't be claimed again. */
export type BeatClaimStatus = 'present' | 'claimed' | 'minting' | 'minted' | 'failed' | 'removed'

export const BEAT_CONSENT_VERSION = 1
export const BEAT_NAME_MAX = 60
export const BEAT_DESCRIPTION_MAX = 500
export const BEAT_SUPPLY_CAP_DEFAULT = 100
export const BEAT_SUPPLY_CAP_MAX = 5000
export const BEAT_MIN_PRESENT_DEFAULT_MINUTES = 5
export const BEAT_MIN_PRESENT_MAX_MINUTES = 120
export const BEAT_IMAGE_MIN_PX = 512
export const BEAT_MAX_BATCH = 200
export const BEAT_CLAIM_GRACE_MS = 24 * 3_600_000
/** The card shows, and opt-in is allowed, this long before `starts_at`. Time only counts inside the window. */
export const BEAT_CARD_LEAD_MS = 30 * 60_000
export const BEAT_RETENTION_DAYS = 30
export const BEAT_JOB_EVERY_MS = 60_000
export const BEAT_SEND_MAX_ATTEMPTS = 5
export const BEAT_REPRICE_AFTER_MS = 10 * 60_000
export const BEAT_FEE_BUMP_PERCENT = 25

export function beatConsentText(name: string): string {
  return `To track your attendance for the ${name} BEAT, Virvi stores your wallet address and display name for this BEAT. The hosts of this event will see them, and your wallet is needed to send you the token. You can stop tracking at any time before you claim.`
}

export interface BeatPriceSettings { baseCents: number; includedMints: number; extraMintCents: number }

/** The base price covers `includedMints`; each mint beyond that costs `extraMintCents`. */
export function beatPriceCents(cap: number, p: BeatPriceSettings): number {
  return p.baseCents + p.extraMintCents * Math.max(0, cap - p.includedMints)
}

/** What raising the supply cap from `fromCap` to `toCap` costs on top of what was paid. */
export function beatTopupCents(fromCap: number, toCap: number, p: BeatPriceSettings): number {
  return beatPriceCents(toCap, p) - beatPriceCents(fromCap, p)
}

export function beatTxUrl(chain: BeatChain, hash: string): string {
  return `${BEAT_CHAIN_INFO[chain].explorer}/tx/${hash}`
}

export function beatAddressUrl(chain: BeatChain, address: string): string {
  return `${BEAT_CHAIN_INFO[chain].explorer}/address/${address}`
}

export function beatTokenUrl(chain: BeatChain, contract: string, tokenId: string): string {
  return `${BEAT_CHAIN_INFO[chain].explorer}/token/${contract}?a=${tokenId}`
}

export interface PublicBeat {
  id: string
  chain: BeatChain
  tokenId: string | null
  name: string
  description: string
  imageUrl: string
  startsAt: string
  endsAt: string
  minPresentSeconds: number
  supplyCap: number
  tradeable: boolean
  status: BeatStatus
  sceneIds: string[]
  counts: { claimed: number; minting: number; minted: number; failed: number }
  frozen: boolean
  test: boolean
}

/** The room's `beat_available` on join (for guests, who can't use REST): the scene's BEAT in its card window. */
export interface AvailableBeat { name: string; test: boolean }

export interface VisitorBeat {
  id: string
  name: string
  imageUrl: string
  startsAt: string
  endsAt: string
  minPresentSeconds: number
  status: BeatStatus
  soldOut: boolean
  claimUntil: string
  /** On Polygon Amoy, the test network: the card shows a "Test" label. */
  test: boolean
  myClaim: { status: BeatClaimStatus; secondsPresent: number; txUrl: string | null } | null
}
