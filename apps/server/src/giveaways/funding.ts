import { and, eq, inArray, sql } from 'drizzle-orm'
import { GIVEAWAY_GAS_PER_ITEM } from '@virvixr/shared'
import { config } from '../config.js'
import { db } from '../db/connection.js'
import { giveawayItems, giveaways, giveawayTxs } from '../db/schema.js'
import { getSubscription, PAID_TIERS } from '../integrations/stripe.js'
import { isVirviAdmin } from '../auth/admin.js'
import { GIVEAWAY_TRANSFER_GAS, giveawayChainClient } from './chain.js'

/**
 * Who pays for a giveaway's gas, and how much of its wallet's POL is the host's (LIV-194). All amounts are wei (bigint).
 * Gas the tank covered comes out of Virvi's top-ups first; what Virvi topped up and hasn't spent is never the host's.
 */

export type GiveawayRow = typeof giveaways.$inferSelect
/**
 * The parts of topUpsWei that may not be in the wallet yet: `pendingTopUpsWei` from top-ups signed but not settled
 * (status 'sending' or 'sent'), `replacedTopUpsWei` from ones whose outcome is unknown (status 'replaced').
 */
export interface GiveawayAccounting {
  topUpsWei: bigint; pendingTopUpsWei: bigint; replacedTopUpsWei: bigint; coveredGasWei: bigint; returnedWei: bigint; virviUnspentWei: bigint
}
export interface GiveawayFunding {
  balanceWei: string; withdrawableWei: string; transferGasWei: string; claimsCovered: number; covered: boolean; tankMissing: boolean
  lowGas: boolean; held: boolean
}
type Exec = Pick<typeof db, 'select'>

/** Fewer claims' worth of gas than this (when the host pays their own gas) shows a low-balance warning. */
export const LOW_GAS_CLAIMS = 10

/**
 * Is this user paying, as the gas tank sees it: an active subscription on a paid tier (decided as the assistant does),
 * a Virvi admin, or a server without billing (self-hosted).
 */
export async function ownerIsPaid(ownerId: string): Promise<boolean> {
  if (!config.billingEnabled) return true
  if (await isVirviAdmin(ownerId)) return true
  const sub = await getSubscription(ownerId)
  return sub.status === 'active' && (PAID_TIERS as readonly string[]).includes(sub.tier)
}

/**
 * Top-ups from the tank, the fees of confirmed mints whose gas the tank covered, and what returns sent back to the tank
 * (value plus their fee, which the float paid). Conservative wherever an outcome isn't known yet:
 * - a top-up counts as received from the moment it is signed (any status but failed), so the balance can never hold
 *   tank POL that this doesn't count (a withdraw, return or delete-finish also waits for it: `unsettledTopUp`);
 * - a return counts as sent once confirmed or 'replaced' (outcome unknown), so neither allows a second return;
 * - a replaced covered mint's fee is never counted.
 */
export async function accounting(giveawayId: string, exec: Exec = db): Promise<GiveawayAccounting> {
  const t = giveawayTxs
  const [row] = await exec.select({
    topUps: sql<string>`coalesce(sum(${t.valueWei}) filter (where ${t.kind} = 'topup' and ${t.status} <> 'failed'), 0)::text`,
    pendingTopUps: sql<string>`coalesce(sum(${t.valueWei}) filter (where ${t.kind} = 'topup' and ${t.status} in ('sending', 'sent')), 0)::text`,
    replacedTopUps: sql<string>`coalesce(sum(${t.valueWei}) filter (where ${t.kind} = 'topup' and ${t.status} = 'replaced'), 0)::text`,
    coveredGas: sql<string>`coalesce(sum(${t.feeWei}) filter (where ${t.kind} = 'mint' and ${t.covered} and ${t.status} = 'confirmed'), 0)::text`,
    returned: sql<string>`coalesce(sum(${t.valueWei} + coalesce(${t.feeWei}, 0)) filter (where ${t.kind} = 'return' and ${t.status} in ('confirmed', 'replaced')), 0)::text`,
  }).from(t).where(eq(t.giveawayId, giveawayId))
  const topUpsWei = BigInt(row?.topUps ?? '0')
  const pendingTopUpsWei = BigInt(row?.pendingTopUps ?? '0')
  const replacedTopUpsWei = BigInt(row?.replacedTopUps ?? '0')
  const coveredGasWei = BigInt(row?.coveredGas ?? '0')
  const returnedWei = BigInt(row?.returned ?? '0')
  const spent = coveredGasWei + returnedWei
  return { topUpsWei, pendingTopUpsWei, replacedTopUpsWei, coveredGasWei, returnedWei, virviUnspentWei: topUpsWei > spent ? topUpsWei - spent : 0n }
}

/** Whether a top-up into this giveaway's wallet is signed but not yet settled (sending or sent). */
export async function unsettledTopUp(giveawayId: string, exec: Exec = db): Promise<boolean> {
  const [row] = await exec.select({ id: giveawayTxs.id }).from(giveawayTxs).where(and(
    eq(giveawayTxs.giveawayId, giveawayId), eq(giveawayTxs.kind, 'topup'), inArray(giveawayTxs.status, ['sending', 'sent']),
  )).limit(1)
  return !!row
}

/**
 * The id of a replaced transfer (top-up, withdraw or return) of this giveaway whose outcome is still unknown, or null.
 * While one is there the wallet's split between the host and Virvi is uncertain: nothing is withdrawable, and the
 * wallet sends no withdraw, return or uncovered mint until a human (or a late receipt) settles it.
 */
export async function replacedHold(giveawayId: string, exec: Exec = db): Promise<string | null> {
  const [row] = await exec.select({ id: giveawayTxs.id }).from(giveawayTxs).where(and(
    eq(giveawayTxs.giveawayId, giveawayId), eq(giveawayTxs.status, 'replaced'), inArray(giveawayTxs.kind, ['topup', 'withdraw', 'return']),
  )).limit(1)
  return row?.id ?? null
}

/** The host's share of the balance: max(0, balance − Virvi's unspent float). */
export function withdrawableWei(balance: bigint, acc: GiveawayAccounting): bigint {
  return balance > acc.virviUnspentWei ? balance - acc.virviUnspentWei : 0n
}

/** The wallet's balance (0 for a giveaway without one). */
export async function walletBalance(g: GiveawayRow): Promise<bigint> {
  return g.walletAddress ? giveawayChainClient(g.chain).balanceWei(g.walletAddress) : 0n
}

/** What the Drops page shows about a giveaway's gas. Reads the chain (balance, fees); throws its GiveawayRpcError. */
export async function fundingView(g: GiveawayRow): Promise<GiveawayFunding> {
  const client = giveawayChainClient(g.chain)
  const [balance, fees, acc, paid, held, [items]] = await Promise.all([
    walletBalance(g), client.feeData(), accounting(g.id), ownerIsPaid(g.ownerId), replacedHold(g.id),
    db.select({ n: sql<number>`count(*)::int` }).from(giveawayItems).where(eq(giveawayItems.giveawayId, g.id)),
  ])
  const perClaim = GIVEAWAY_GAS_PER_ITEM * BigInt(Math.max(1, items?.n ?? 0)) * fees.maxFeePerGas
  const claimsCovered = perClaim > 0n ? Number(balance / perClaim) : 0
  const covered = paid && !!config.giveaways.gasKey
  return {
    balanceWei: balance.toString(),
    // Nothing is the host's to send while a replaced transfer's outcome is unknown
    withdrawableWei: held ? '0' : withdrawableWei(balance, acc).toString(),
    transferGasWei: (GIVEAWAY_TRANSFER_GAS * fees.maxFeePerGas).toString(),
    claimsCovered,
    covered,
    tankMissing: paid && !config.giveaways.gasKey,
    lowGas: !covered && claimsCovered < LOW_GAS_CLAIMS,
    held: !!held,
  }
}
