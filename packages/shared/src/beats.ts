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
/** The most wallets in one mint (the contract allows 200; 100 keeps the every-wallet-as-code gas budget near 19M). */
export const BEAT_MAX_BATCH = 100
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

/** Stripe's smallest card charge in USD cents. A card payment below it is refused (`below_minimum`); credit pays any amount. */
export const BEAT_CARD_MIN_CENTS = 50

/** The smallest supply above `fromCap` whose raise costs at least BEAT_CARD_MIN_CENTS (null when none up to `maxCap`). */
export function beatMinCardTopupCap(fromCap: number, p: BeatPriceSettings, maxCap = BEAT_SUPPLY_CAP_MAX): number | null {
  for (let cap = fromCap + 1; cap <= maxCap; cap++) if (beatTopupCents(fromCap, cap, p) >= BEAT_CARD_MIN_CENTS) return cap
  return null
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
  /** Host review: claims wait for the host's Send (POST /api/beats/:id/release) or until `mintsHeldUntil`. */
  holdMints: boolean
  /** When the host pressed Send, or null. */
  mintsReleasedAt: string | null
  /** While claims are held: when they go out anyway (ends_at + the claim grace); null when nothing is held. */
  mintsHeldUntil: string | null
  /** The end the host scheduled, when they ended it early (endsAt is then the actual end); else null. */
  scheduledEndsAt: string | null
  /** Held claims waiting for the host's Send (claimed after the last Send, or all while none was pressed). */
  heldClaims: number
  /**
   * The frozen token art: `frozen` (copied), `pending` (not yet: before payment, or a copy being retried) or `failed`
   * (it can't be made: the image is gone or isn't usable; the host picks another, which stays possible until the BEAT
   * is on chain). The BEAT isn't put on chain, and nothing is minted, until it is `frozen`.
   */
  artStatus: 'pending' | 'frozen' | 'failed'
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

// ── Reissue (LIV-11): a BEAT sent again to a new wallet when the old one was compromised ────────────────────────────

/**
 * A reissue request's state:
 * - `pending`: the person asked; an admin hasn't reviewed it;
 * - `approved` / `rejected`: reviewed (with an optional note, shown to the person). Approval blocks the old wallet from
 *   signing in to Virvi (and ends its sessions); a rejection lifts that block again;
 * - `proposed`: an admin prepared the Safe transaction files; waiting for the Safe's signers and the chain;
 * - `done`: every proposed BEAT was reissued on chain (confirmed); the old wallet is unlinked and stays blocked;
 * - `cancelled`: the person withdrew it while it was pending;
 * - `withdrawn`: an admin voided it (approved or proposed, before its files landed); the person may file again.
 */
export type BeatReissueStatus = 'pending' | 'approved' | 'rejected' | 'proposed' | 'done' | 'cancelled' | 'withdrawn'
/** The states in which an account has an open request (it may have only one). */
export const BEAT_REISSUE_OPEN: readonly BeatReissueStatus[] = ['pending', 'approved', 'proposed']
/**
 * One BEAT of a request: in a proposed file, left out (with its blockers), reissued on chain, reissued on chain but
 * its claim couldn't move because another claim holds the new wallet (`clash`, an admin alert), or withdrawn.
 */
export type BeatReissueItemState = 'proposed' | 'skipped' | 'reissued' | 'clash' | 'withdrawn'
/** One Safe Transaction Builder file (one Safe transaction): proposed, done (all its ids reissued) or voided. */
export type BeatReissueFileStatus = 'proposed' | 'done' | 'voided'
/**
 * Why a BEAT can't be reissued now:
 * - NothingToReplace: tradeable, and the old wallet no longer holds a copy (the contract would revert);
 * - AlreadyReplaced: the old wallet was already replaced for this BEAT;
 * - AlreadyMinted: the new wallet was already minted this BEAT;
 * - ClaimOnNewWallet: another claim on this BEAT already uses the new wallet;
 * - BeatOpen: the BEAT is still running (reissue once it has ended);
 * - ChainUnavailable: the chain couldn't be read (no client, or the RPC failed);
 * - Withdrawn: an admin withdrew the file it was in.
 */
export type BeatReissueBlocker = 'NothingToReplace' | 'AlreadyReplaced' | 'AlreadyMinted' | 'ClaimOnNewWallet' | 'BeatOpen' | 'ChainUnavailable' | 'Withdrawn'
/**
 * Red flags the admin queue raises on a request:
 * - new_wallet_recent: the new wallet was linked less than 7 days before the request was filed;
 * - new_wallet_linked_by_old_wallet: the new wallet was linked by a session signed in with the old wallet;
 * - recent_cancel: another request of the account was cancelled in the last 30 days;
 * - earlier_reissue: the account already had a reissue done;
 * - follow_up_reissue: the old wallet is the new wallet of a reissue done in the last 30 days;
 * - clash: a BEAT was reissued on chain but its claim couldn't move (another claim holds the new wallet).
 */
export type BeatReissueFlag = 'new_wallet_recent' | 'new_wallet_linked_by_old_wallet' | 'recent_cancel' | 'earlier_reissue' | 'follow_up_reissue' | 'clash'
/** How a session signed in (the `am` token claim); `unknown` for tokens issued before it was recorded. */
export type SignInMethod = 'wallet' | 'email' | 'oauth' | 'unknown'
export const BEAT_REISSUE_REASON_MAX = 1000
export const BEAT_REISSUE_NOTE_MAX = 1000
/** The most ids in one `reissue` call (VirviBeat.MAX_BATCH). */
export const BEAT_REISSUE_MAX_BATCH = 200
