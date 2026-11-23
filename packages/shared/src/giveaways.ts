/** Automatic wearable giveaway constants, types and links (LIV-194). Defined once here; the server and web import them. */

export const GIVEAWAY_CHAINS = ['polygon', 'polygon-amoy'] as const
export type GiveawayChain = (typeof GIVEAWAY_CHAINS)[number]

/** The consent text's version, stored with each claim. */
export const GIVEAWAY_CONSENT_VERSION = 1

/** `present`: consented and earning minutes. `waiting`: claimed and queued. */
export const GIVEAWAY_CLAIM_STATUSES = ['present', 'waiting', 'minting', 'sent', 'failed'] as const
export type GiveawayClaimStatus = (typeof GIVEAWAY_CLAIM_STATUSES)[number]

export const GIVEAWAY_PAUSE_REASONS = ['low_gas', 'not_minter', 'not_approved', 'rpc_down'] as const
export type GiveawayPauseReason = (typeof GIVEAWAY_PAUSE_REASONS)[number]

export const GIVEAWAY_FAIL_REASONS = ['sold_out', 'reverted', 'ended', 'replaced', 'item_removed'] as const
export type GiveawayFailReason = (typeof GIVEAWAY_FAIL_REASONS)[number]

/** The gas estimate per minted token, used for "claims covered". */
export const GIVEAWAY_GAS_PER_ITEM = 120_000n
export const GIVEAWAY_MAX_CLAIMS_PER_TX = 40
export const GIVEAWAY_JOB_EVERY_MS_DEFAULT = 15_000
/** A queued claim older than this shows "Still sending" on the card. */
export const GIVEAWAY_DELAYED_AFTER_MS = 10 * 60_000

const EXPLORER: Record<GiveawayChain, string> = {
  polygon: 'https://polygonscan.com',
  'polygon-amoy': 'https://amoy.polygonscan.com',
}

export function giveawayTxUrl(chain: GiveawayChain, hash: string): string {
  return `${EXPLORER[chain]}/tx/${hash}`
}

export function giveawayMarketplaceApi(chain: GiveawayChain): string {
  return chain === 'polygon' ? 'https://marketplace-api.decentraland.org' : 'https://marketplace-api.decentraland.zone'
}

/**
 * Where a host manages the collection. The Builder's per-collection URL uses its own collection id, which the contract
 * address doesn't give us, so this links the collections list; `contract` is kept so a deep link can be added later.
 */
export function giveawayBuilderUrl(chain: GiveawayChain, _contract?: string): string {
  return chain === 'polygon' ? 'https://decentraland.org/builder/collections' : 'https://decentraland.zone/builder/collections'
}

export interface VisitorGiveaway {
  id: string
  name: string
  items: { name: string; thumbnail: string | null; rarity: string | null }[]
  endsAt: string | null
  minPresentSeconds: number
  test: boolean
  /** `delayed`: queued, and either paused or claimed more than GIVEAWAY_DELAYED_AFTER_MS ago (the card says "Still sending"). */
  claim: null | { status: GiveawayClaimStatus; secondsPresent: number; txUrl: string | null; failReason: string | null; delayed: boolean }
}

/** The room's `giveaway_available` for guests (who can't use REST): the scene's open giveaway, name and test flag only. */
export interface AvailableGiveaway { name: string; test: boolean }

export type GiveawayMintState = 'ready' | 'not_minter' | 'not_approved' | 'sold_out'

/** What a host sees of one giveaway (never the wallet's key). */
export interface HostGiveaway {
  id: string
  name: string
  chain: GiveawayChain
  enabled: boolean
  walletAddress: string | null
  builderUrl: string
  startsAt: string | null
  endsAt: string | null
  claimCap: number | null
  minPresentSeconds: number
  pausedReason: GiveawayPauseReason | null
  pausedAt: string | null
  deleteState: 'returning' | null
  items: {
    id: string
    contractAddress: string | null
    itemId: string | null
    name: string | null
    thumbnail: string | null
    rarity: string | null
    mintState: GiveawayMintState | null
    remaining: number | null
    checkedAt: string | null
  }[]
  sceneIds: string[]
  /**
   * `withdrawableWei` is the host's share before the transfer's gas (`transferGasWei`); `held`: a replaced transaction's
   * outcome is unknown, so nothing is withdrawable until Virvi support settles it.
   */
  funding: {
    balanceWei: string; withdrawableWei: string; transferGasWei: string; claimsCovered: number; covered: boolean; tankMissing: boolean
    lowGas: boolean; held: boolean
  }
  counts: Record<GiveawayClaimStatus, number>
}
