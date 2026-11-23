import { and, eq, sql } from 'drizzle-orm'
import { GIVEAWAY_GAS_PER_ITEM } from '@virvixr/shared'
import { config } from '../config.js'
import { db } from '../db/connection.js'
import { giveawayItems, giveaways, giveawayTxs } from '../db/schema.js'
import { getSubscription, PAID_TIERS } from '../integrations/stripe.js'
import { isVirviAdmin } from '../auth/admin.js'
import { giveawayChainClient } from './chain.js'

/**
 * Who pays for a giveaway's gas, and how much of its wallet's POL is the host's (LIV-194). All amounts are wei (bigint).
 * Gas the tank covered comes out of Virvi's top-ups first; what Virvi topped up and hasn't spent is never the host's.
 */

export type GiveawayRow = typeof giveaways.$inferSelect
export interface GiveawayAccounting { topUpsWei: bigint; coveredGasWei: bigint; virviUnspentWei: bigint }
export interface GiveawayFunding {
  balanceWei: string; withdrawableWei: string; claimsCovered: number; covered: boolean; tankMissing: boolean; lowGas: boolean
}

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

/** Confirmed top-ups from the tank, and the fees of confirmed mints whose gas the tank covered. */
export async function accounting(giveawayId: string): Promise<GiveawayAccounting> {
  const [row] = await db.select({
    topUps: sql<string>`coalesce(sum(${giveawayTxs.valueWei}) filter (where ${giveawayTxs.kind} = 'topup'), 0)::text`,
    coveredGas: sql<string>`coalesce(sum(${giveawayTxs.feeWei}) filter (where ${giveawayTxs.kind} = 'mint' and ${giveawayTxs.covered}), 0)::text`,
  }).from(giveawayTxs).where(and(eq(giveawayTxs.giveawayId, giveawayId), eq(giveawayTxs.status, 'confirmed')))
  const topUpsWei = BigInt(row?.topUps ?? '0')
  const coveredGasWei = BigInt(row?.coveredGas ?? '0')
  return { topUpsWei, coveredGasWei, virviUnspentWei: topUpsWei > coveredGasWei ? topUpsWei - coveredGasWei : 0n }
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
  const [balance, fees, acc, paid, [items]] = await Promise.all([
    walletBalance(g), client.feeData(), accounting(g.id), ownerIsPaid(g.ownerId),
    db.select({ n: sql<number>`count(*)::int` }).from(giveawayItems).where(eq(giveawayItems.giveawayId, g.id)),
  ])
  const perClaim = GIVEAWAY_GAS_PER_ITEM * BigInt(Math.max(1, items?.n ?? 0)) * fees.maxFeePerGas
  const claimsCovered = perClaim > 0n ? Number(balance / perClaim) : 0
  const covered = paid && !!config.giveaways.gasKey
  return {
    balanceWei: balance.toString(),
    withdrawableWei: withdrawableWei(balance, acc).toString(),
    claimsCovered,
    covered,
    tankMissing: paid && !config.giveaways.gasKey,
    lowGas: !covered && claimsCovered < LOW_GAS_CLAIMS,
  }
}
