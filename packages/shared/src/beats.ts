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

/**
 * The consent text's version, stored with each claim. Bump it whenever beatConsentText changes: a test pins each
 * version's text (apps/server/test/beats-shared.test.ts) and fails when the text changes without a bump.
 * 2: adds the 30-second check-ins and the permanent public record on Polygon (privacy I1).
 */
export const BEAT_CONSENT_VERSION = 2
export const BEAT_NAME_MAX = 60
export const BEAT_DESCRIPTION_MAX = 500
export const BEAT_SUPPLY_CAP_DEFAULT = 100
export const BEAT_SUPPLY_CAP_MAX = 5000
export const BEAT_MIN_PRESENT_DEFAULT_MINUTES = 5
export const BEAT_MIN_PRESENT_MAX_MINUTES = 120
export const BEAT_IMAGE_MIN_PX = 512
/** The default most claims of one BEAT from one network (BEAT_CLAIMS_PER_IP's default; ops may raise it). */
export const BEAT_CLAIMS_PER_NETWORK_DEFAULT = 3
/**
 * The privacy and docs wording of that limit. The web privacy page (a static export) and the docs (Markdown) can't
 * read the server's setting, so they say "a few" with the default; apps/server/test/beats-shared.test.ts ties them.
 */
export const beatClaimsPerNetworkText = (n: number = BEAT_CLAIMS_PER_NETWORK_DEFAULT) => `a few claims per network (currently ${n})`

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
  return `To track your attendance for the ${name} BEAT, Virvi stores your wallet address, your display name and how long you're here. The scene checks in every 30 seconds while you're in it. The hosts of this event will see your name, wallet and time. If you claim, your wallet, this BEAT and the time it was sent are recorded on Polygon, a public blockchain: anyone can see that record, and nobody can delete it. You can stop tracking at any time before you claim, which deletes what was stored.`
}

/**
 * Claim failure reasons that are final for that wallet: the wallet's receiver refused the token (`receiver_rejected`,
 * `ERC1155InvalidReceiver`), the BEAT is already closed on chain (`BeatClosedError`), or an admin stopped retrying
 * (`given_up`). Any other reason is retried.
 */
export const BEAT_FINAL_FAIL_REASONS = ['receiver_rejected', 'ERC1155InvalidReceiver', 'BeatClosedError', 'given_up'] as const

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

/** Where a BEAT's event is: in its Virvi scenes (the default), online on another platform, or in person. */
export const BEAT_LOCATION_TYPES = ['scene', 'online', 'in_person'] as const
export type BeatLocationType = (typeof BEAT_LOCATION_TYPES)[number]
/** Field limits for the location (characters). URLs must be http(s). */
export const BEAT_LOCATION_MAX = { platform: 60, url: 500, venue: 100, city: 80, country: 60, address: 200, mapUrl: 500 } as const
/**
 * A BEAT's location. `label` is the short text the token shows (Location): for `scene` it is made from the BEAT's
 * scenes (the scene's name with its World name or Genesis City coordinates) when it is saved. The other fields are null
 * where they don't apply. It locks at go-live with the rest of the metadata. Claiming happens only in Virvi scenes.
 */
export interface BeatLocation {
  type: BeatLocationType
  label: string | null
  platform: string | null
  url: string | null
  venue: string | null
  city: string | null
  country: string | null
  address: string | null
  mapUrl: string | null
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
  location: BeatLocation
  /**
   * On an earlier contract (the network's contract was replaced): kept as a record, but Virvi no longer sends, closes or
   * reissues it, visitors can't claim it and its cap can't be raised.
   */
  retired: boolean
}

/** What the host sees on a retired BEAT, and the message when they try to change it. */
export const BEAT_RETIRED_NOTE = "This BEAT is on an earlier version of Virvi's BEAT contract. It stays as a record, but visitors can't claim it now and nothing more is sent."


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
  /**
   * `final`: a failed claim that will never be retried (BEAT_FINAL_FAIL_REASONS); false otherwise. A `removed` claim was
   * taken out by the host before it was sent. `heldUntil`: a claimed claim the host is holding for review, and when it is
   * sent at the latest (the end plus the claim grace) if they don't send it sooner; null otherwise.
   */
  myClaim: { status: BeatClaimStatus; secondsPresent: number; txUrl: string | null; final: boolean; heldUntil: string | null } | null
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
 * - Unavailable: the BEAT isn't on the chain's configured contract (the chain has none now, or its contract was
 *   replaced and this BEAT is retired), so Virvi can't reissue it; the rest of the request can still finish;
 * - NotMintedTo: the contract never sent this BEAT to the old wallet (minted(id, old) is false);
 * - Withdrawn: an admin withdrew the file it was in.
 */
export type BeatReissueBlocker = 'NothingToReplace' | 'AlreadyReplaced' | 'AlreadyMinted' | 'ClaimOnNewWallet' | 'BeatOpen' | 'ChainUnavailable'
  | 'Unavailable' | 'NotMintedTo' | 'Withdrawn'
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
/** What the person says happened to the old wallet. For the reviewer only: both end in the same block (BEATs and the account). */
export const BEAT_REISSUE_LOSSES = ['lost', 'stolen'] as const
export type BeatReissueLoss = (typeof BEAT_REISSUE_LOSSES)[number]
export const BEAT_REISSUE_REASON_MAX = 1000
export const BEAT_REISSUE_NOTE_MAX = 1000
/** The most ids in one `reissue` call (VirviBeat.MAX_BATCH). */
export const BEAT_REISSUE_MAX_BATCH = 200

export type BeatKind = 'basic' | 'custom'

/** One BEAT a wallet holds, for the collection page (LIV-185). */
export interface CollectedBeat {
  tokenId: string
  contract: string
  chain: BeatChain
  kind: BeatKind
  /** The checksummed holder. */
  wallet: string
  quantity: number
  /** Minted to this wallet by a Virvi claim (or reissued to it); otherwise it was bought or sent. */
  earned: boolean
  name: string
  imageUrl: string | null
  place: string | null
  startsAt: string
  endsAt: string
  tradeable: boolean
  tokenUrl: string
  /** Only when earned. */
  mintTxUrl: string | null
  /** Only when earned and the claim isn't unlinked; never on the public endpoint. */
  claimedAt: string | null
}

/** The signed-in collection: the account's linked wallets and the BEATs they hold. */
export interface BeatCollection { wallets: string[]; beats: CollectedBeat[] }
/** The public page for one wallet. */
export interface WalletBeats { wallet: string; beats: CollectedBeat[] }
