/** The admin BEATs page's data (GET /api/admin/beats, apps/server/src/routes/admin-beats.ts) and its pure helpers (LIV-11). */
import { BEAT_MAX_BATCH, type BeatChain } from '@virvixr/shared'

export type BeatPauseReason = 'low_gas' | 'no_client' | 'id_conflict' | 'misconfigured' | 'high_fees' | 'rpc_down' | null

export interface AdminBeatChain {
  chain: BeatChain
  contract: string | null
  /** Null for the server's chain when it has no minter key or contract yet (see `missing`). */
  minter: string | null
  /** Wei, as a decimal string; null when the balance couldn't be read. */
  balanceWei: string | null
  balanceError: boolean
  paused: boolean
  reason: BeatPauseReason
  /** The settings this chain still needs before it can mint (empty once it's set up), e.g. BEAT_MINTER_KEY. */
  missing: string[]
  /** BEAT_MIN_GAS_POL, in wei. */
  minGasWei: string
  /** One full mint batch at the fees the job last signed with; null until the job has signed a mint since it started. */
  batchCostWei: string | null
  /** While paused for low gas (balance readable): the minimum plus batchCostWei (when known), less the balance. */
  topUpWei: string | null
}

export interface AdminBeatsOverview {
  chains: AdminBeatChain[]
  /** `failed` is what a retry could still send; given-up claims are counted apart. */
  counts: { claimed: number; minting: number; failed: number; givenUp: number }
  /** `retryable` false for a claim an admin gave up on (fail reason `given_up`), or of a `retired` BEAT (on a replaced
   * contract: shown, never retried). */
  failed: Array<{ beatId: string; name: string; wallet: string; failReason: string | null; retired?: boolean; retryable: boolean }>
  batches: Array<{ id: string; chain: BeatChain; kind: string; tokenId: string; nonce: number; status: string; attempts: number; txUrl: string | null; createdAt: string }>
  /** Ended BEATs past their claim grace that claims failed for a retryable reason keep open on chain: "Stop retrying and close" applies. */
  held: Array<{ beatId: string; name: string; retryable: number }>
}

export const BEATS_OFF = 'BEATs are off.'
export const BALANCE_UNAVAILABLE = 'Balance unavailable'

const WEI_PER_POL = BigInt(10) ** BigInt(18)
const PLACES = 4
const STEP = BigInt(10) ** BigInt(18 - PLACES)

/** Wei as POL with up to 4 decimals, cut rather than rounded (a balance never reads higher than it is): `1234567890123456789` → `1.2345 POL`. */
export function formatPol(wei: string): string {
  const w = BigInt(wei)
  const whole = w / WEI_PER_POL
  const frac = ((w % WEI_PER_POL) / STEP).toString().padStart(PLACES, '0').replace(/0+$/, '')
  return `${whole}${frac ? `.${frac}` : ''} POL`
}

/** Wei as POL with exactly 4 decimals, cut down (a balance) or rounded up (an amount to send, so it's never short). */
export function formatPol4(wei: string, round: 'down' | 'up' = 'down'): string {
  let units = BigInt(wei) / STEP
  if (round === 'up' && BigInt(wei) % STEP !== BigInt(0)) units += BigInt(1)
  const per = WEI_PER_POL / STEP
  return `${units / per}.${(units % per).toString().padStart(PLACES, '0')} POL`
}

/** A low-gas pause's figures: the balance, the minimum, and what to top up (the minimum plus one full batch when the
 * job knows its cost, else just the minimum). Null unless the chain is paused for low gas. */
export function lowGasDetail(c: Pick<AdminBeatChain, 'paused' | 'reason' | 'balanceWei' | 'balanceError' | 'minGasWei' | 'batchCostWei' | 'topUpWei'>): string | null {
  if (!c.paused || c.reason !== 'low_gas') return null
  const balance = c.balanceError || c.balanceWei === null ? `${BALANCE_UNAVAILABLE}.` : `Balance ${formatPol4(c.balanceWei)}.`
  const parts = [balance, `Minimum ${formatPol4(c.minGasWei)}.`]
  // Never "Top up 0.0000 POL": with nothing to suggest, the balance and the minimum stand alone
  if (c.topUpWei !== null && BigInt(c.topUpWei) > BigInt(0) && !(c.balanceError || c.balanceWei === null)) {
    const why = c.batchCostWei !== null ? `: the minimum plus one full ${BEAT_MAX_BATCH}-claim batch at current fees.` : ' to reach the minimum.'
    parts.push(`Top up ${formatPol4(c.topUpWei, 'up')}${why}`)
  }
  return parts.join(' ')
}

/** The minter's balance, or "Balance unavailable" (never 0) when it couldn't be read. */
export function balanceLabel(c: Pick<AdminBeatChain, 'balanceWei' | 'balanceError'>): string {
  return c.balanceError || c.balanceWei === null ? BALANCE_UNAVAILABLE : formatPol(c.balanceWei)
}

export const PAUSE_MESSAGES: Record<Exclude<BeatPauseReason, null>, string> = {
  low_gas: 'Minting is paused because the minter wallet is low on POL (the coin used for fees). Send POL on the Polygon network to the Minter address above (use the copy button). Minting restarts by itself once the balance is enough.',
  id_conflict: "Minting is stopped on purpose. Virvi and the contract disagree about which BEAT numbers are taken. Don't clear this yourself: ask a developer to check first. Clearing it restarts minting.",
  no_client: "The minter wallet isn't set up yet (a developer needs to add it to the server settings). Hosts can't pay for BEATs until then.",
  misconfigured: "Minting is paused because the server's settings don't match the contract: the network, the contract address or the minter's permission is wrong. Ask a developer to check the BEAT settings. Minting restarts by itself once they're right.",
  high_fees: 'Minting is paused because Polygon fees are unusually high right now. Nothing needs doing: minting restarts by itself when fees come down.',
  rpc_down: "Minting is paused because Virvi can't reach Polygon (the network connection, or RPC, keeps failing). It restarts by itself when the connection works again. If it lasts more than an hour, ask a developer to check the RPC setting.",
}

/** Why minting is paused on a chain, plainly, or null while it runs. A chain that isn't set up says so even unpaused. */
export function pauseMessage(c: Pick<AdminBeatChain, 'paused' | 'reason'> & { missing?: string[] }): string | null {
  if (c.missing?.length) return `${PAUSE_MESSAGES.no_client} Missing: ${c.missing.join(' and ')}.`
  if (!c.paused) return null
  return c.reason ? PAUSE_MESSAGES[c.reason] : 'Minting is paused.'
}

/** The Clear pause question (only for an id clash). */
export const clearPausePrompt = (label: string) => `Clear the pause on ${label}? Minting starts again. Only do this once a developer has checked.`

/** A failed claim's reason in plain words; the raw code stays for a developer (plain-ux I11). */
export function failReasonLabel(reason: string | null, retryable: boolean, retired = false): string {
  if (retired) return 'On an earlier contract (Virvi no longer sends it)'
  if (!retryable || reason === 'given_up') return 'You stopped retrying'
  if (reason === 'receiver_rejected' || reason === 'ERC1155InvalidReceiver') return "The visitor's wallet can't accept BEATs"
  if (reason === 'BeatClosedError') return 'The BEAT was already closed'
  return 'Network error (will retry)'
}

export const BATCHES_NOTE = 'Each row is one transaction Virvi sent to Polygon. Failed or stuck rows retry automatically.'
export const GIVEN_UP_NOTE = '(stopped retrying on purpose)'
export const giveUpPrompt = (name: string) => `Stop retrying ${name}'s failed claims and close this BEAT? Those visitors will never receive their BEAT. This can't be undone.`

/** An admin call's failure as plain text, keeping the code for a developer (plain-ux I10). */
export function adminError(err: unknown): { message: string; code: string | null } {
  const e = err as { status?: number; body?: { error?: string; message?: string } } | null
  const code = e?.body?.error ?? null
  return { message: 'Something went wrong. Try again, or ask a developer to check the server logs.', code: code ?? (e?.status ? `HTTP ${e.status}` : null) }
}

/** The overview, or 'off' when BEATs are off (the admin routes answer 404 while BEAT_ENABLED is off). */
export async function loadAdminBeats(api: { getAdminBeats: () => Promise<AdminBeatsOverview> }): Promise<AdminBeatsOverview | 'off'> {
  try {
    return await api.getAdminBeats()
  } catch (err: any) {
    if (err?.status === 404) return 'off'
    throw err
  }
}

/** Retry failed: every failed claim, or one BEAT's. Returns what to tell the admin, including the claims of BEATs
 * already closed on chain, which can't be minted any more. */
export async function retryFailed(
  api: { retryAdminBeatsFailed: (beatId?: string) => Promise<{ retried: number; skippedClosed: number }> }, beatId?: string,
): Promise<string> {
  const { retried, skippedClosed } = await api.retryAdminBeatsFailed(beatId)
  const closed = skippedClosed > 0 ? `${skippedClosed} on closed BEATs can't be retried.` : ''
  if (retried === 0) return closed || 'No failed claims to retry.'
  return [`${retried} failed ${retried === 1 ? 'claim' : 'claims'} will be sent again.`, closed].filter(Boolean).join(' ')
}

/** Lift a chain's id-conflict pause, once the clash has been looked into. */
export async function clearPause(api: { clearAdminBeatPause: (chain: BeatChain) => Promise<{ ok: boolean }> }, chain: BeatChain): Promise<void> {
  await api.clearAdminBeatPause(chain)
}

/** Stop retrying and close: the BEAT's retryable failed claims become final (given up), and the next tick closes it. */
export async function giveUp(api: { giveUpAdminBeat: (beatId: string) => Promise<{ givenUp: number }> }, beatId: string): Promise<string> {
  const { givenUp } = await api.giveUpAdminBeat(beatId)
  return `${givenUp} failed ${givenUp === 1 ? 'claim' : 'claims'} won't be retried. The BEAT closes on chain shortly.`
}
