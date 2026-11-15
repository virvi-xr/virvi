/** The admin BEATs page's data (GET /api/admin/beats, apps/server/src/routes/admin-beats.ts) and its pure helpers (LIV-11). */
import type { BeatChain } from '@virvixr/shared'

export type BeatPauseReason = 'low_gas' | 'no_client' | 'id_conflict' | null

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
}

export interface AdminBeatsOverview {
  chains: AdminBeatChain[]
  counts: { claimed: number; minting: number; failed: number }
  failed: Array<{ beatId: string; name: string; wallet: string; failReason: string | null }>
  batches: Array<{ id: string; chain: BeatChain; kind: string; tokenId: string; nonce: number; status: string; attempts: number; txUrl: string | null; createdAt: string }>
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

/** The minter's balance, or "Balance unavailable" (never 0) when it couldn't be read. */
export function balanceLabel(c: Pick<AdminBeatChain, 'balanceWei' | 'balanceError'>): string {
  return c.balanceError || c.balanceWei === null ? BALANCE_UNAVAILABLE : formatPol(c.balanceWei)
}

/** Why minting is paused on a chain, plainly, or null while it runs. */
export function pauseMessage(c: Pick<AdminBeatChain, 'paused' | 'reason'> & { missing?: string[] }): string | null {
  if (!c.paused) return null
  if (c.missing?.length) return `Not set up: set ${c.missing.join(' and ')}. Hosts can't pay for BEATs until then.`
  if (c.reason === 'low_gas') return 'Minting paused: top up the minter'
  if (c.reason === 'id_conflict') return 'Minting paused: a BEAT id already exists on chain. Check before clearing.'
  if (c.reason === 'no_client') return "Minting paused: the minter isn't set up"
  return 'Minting paused'
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
