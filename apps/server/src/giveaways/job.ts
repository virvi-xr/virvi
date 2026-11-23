import { Transaction, Wallet, parseEther, type BaseWallet } from 'ethers'
import { and, asc, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm'
import { GIVEAWAY_CHAINS, GIVEAWAY_GAS_PER_ITEM, GIVEAWAY_MAX_CLAIMS_PER_TX, type GiveawayChain, type GiveawayFailReason, type GiveawayPauseReason } from '@virvixr/shared'
import { config } from '../config.js'
import { db } from '../db/connection.js'
import { giveawayClaimMints, giveawayClaims, giveaways, giveawayTxs } from '../db/schema.js'
import { withLock } from '../errors/jobs.js'
import { logSafe } from '../errors/log-safe.js'
import { recordJobFailure } from '../errors/record.js'
import {
  GIVEAWAY_TRANSFER_GAS, GiveawayRevert, GiveawayRpcError, collectionInterface, giveawayChainClient, revertReason,
  type GiveawayChainClient, type GiveawayFees, type GiveawayReceipt,
} from './chain.js'
import { accounting, ownerIsPaid, type GiveawayRow } from './funding.js'
import { mintCheck, type GiveawayMintCheck } from './host.js'
import { giveawaySigner } from './keys.js'

/**
 * The giveaway minting job (LIV-194): every config.giveaways.jobEveryMs, on one instance (advisory lock
 * 'giveaway-minter'), it moves each chain's giveaway transactions on. Per pass and chain:
 *
 * 1. Reconciles every open transaction (`sending` with a signed raw tx, or `sent`): broadcasts what was signed but not
 *    sent (a crash between the two), confirms by receipt (3 blocks deep on Polygon, 1 on Amoy), notices a nonce used
 *    elsewhere, and reprices after 3 minutes (same nonce and gas limit, fees +15%).
 * 2. Signs the host send-backs (`withdraw` rows sendBack queued without a raw tx), never touching Virvi's float.
 * 3. Mints queued claims: one issueTokens per collection contract, up to GIVEAWAY_MAX_CLAIMS_PER_TX claims, from the
 *    giveaway's own wallet, topping a paid owner's wallet up from the gas tank when it is short.
 * 4. Returns Virvi's unspent float to the tank when a giveaway ends or is deleted, and finishes deletes.
 *
 * Every wallet has at most one open transaction: a new one is signed only under the giveaway row's lock (which sendBack
 * takes too) when nothing else from that wallet is open, and its row (raw tx and hash) is written before the broadcast.
 * RPC failures never fail a transaction that may have left: it stays open with its nonce until a receipt or the nonce
 * settles it. Logs carry ids and counts only.
 */

export const GIVEAWAY_REPRICE_AFTER_MS = 3 * 60_000
export const GIVEAWAY_FEE_BUMP_PERCENT = 15
export const GIVEAWAY_RPC_FAILS_BEFORE_PAUSE = 10
/** Blocks after the receipt's block before a transaction counts as confirmed. */
const CONFIRMATIONS: Record<GiveawayChain, number> = { polygon: 3, 'polygon-amoy': 1 }
/** A top-up brings the wallet to this many claims' worth of gas, at most TOPUP_MAX_WEI. */
const TOPUP_CLAIMS = 50n
const TOPUP_MAX_WEI = parseEther('5')
const TANK_LOW_REPORT_MS = 60 * 60_000
/** A broadcast refused this many times in a row is reported (once); the row stays open and keeps trying. */
const BROADCAST_REPORT_AT = 5
const BACKOFF_MAX_EXP = 6
const OPEN = ['sending', 'sent'] as const
const QUEUED = ['waiting', 'minting'] as const

export type GiveawayJobDeps = { client: (chain: GiveawayChain) => GiveawayChainClient }
type TxRow = typeof giveawayTxs.$inferSelect
type Exec = Pick<typeof db, 'select' | 'update' | 'insert' | 'delete' | 'execute'>

// ── In-memory state (one instance runs the job) ──────────────────────────────

const rpcFails = new Map<GiveawayChain, number>()
/** An RPC failure this pass that didn't end the pass (a giveaway's step, a broadcast). */
const rpcTrouble = new Set<GiveawayChain>()
const tankLowReportedAt = new Map<GiveawayChain, number>()
/** Failures already reported (job failure), cleared when the same step next succeeds. */
const reported = new Set<string>()
/** Giveaways whose batch failed at estimate for an unknown reason: their next mints go one claim at a time. */
const singles = new Set<string>()

export function resetGiveawayJobState(): void {
  rpcFails.clear()
  rpcTrouble.clear()
  tankLowReportedAt.clear()
  reported.clear()
  singles.clear()
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const minBig = (a: bigint, b: bigint) => (a < b ? a : b)
const maxBig = (a: bigint, b: bigint) => (a > b ? a : b)
const lc = (s: string) => s.toLowerCase()
const bump = (x: bigint) => (x * BigInt(100 + GIVEAWAY_FEE_BUMP_PERCENT) + 99n) / 100n

/** A loggable error message: drizzle's "Failed query" messages list the parameters (wallets), so those log the cause. */
function safeErr(err: unknown): string {
  if (err instanceof GiveawayRpcError || err instanceof GiveawayRevert) return err.message
  if (err instanceof Error) {
    if (/^Failed query/.test(err.message)) {
      const cause = (err as { cause?: { code?: string } }).cause
      return `query failed${cause?.code ? ` (${cause.code})` : ''}`
    }
    return logSafe(err.message)
  }
  return 'unknown error'
}

/** Reports a failure once (until `succeeded(key)`). */
function reportOnce(key: string, job: string, message: string, owner: string | null = null): void {
  if (reported.has(key)) return
  reported.add(key)
  recordJobFailure(job, new Error(message), { owner })
}
const succeeded = (key: string) => reported.delete(key)

/** Runs one step; an RPC failure marks the chain's pass troubled (toward rpc_down), anything else is logged and reported. */
async function step(chain: GiveawayChain, key: string, what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    succeeded(key)
  } catch (err) {
    if (err instanceof GiveawayRpcError) {
      rpcTrouble.add(chain)
      console.warn(`[giveaways] ${what}: ${safeErr(err)}`)
      return
    }
    console.error(`[giveaways] ${what} failed: ${safeErr(err)}`)
    reportOnce(key, 'giveaway_job', `Giveaway job: ${what} failed (${safeErr(err)})`)
  }
}

/** Sets (or clears, with null) a giveaway's pause; a pause that doesn't change keeps its pausedAt. */
async function setPause(id: string, reason: GiveawayPauseReason | null, now: Date): Promise<void> {
  await db.update(giveaways).set({ pausedReason: reason, pausedAt: reason ? now : null, updatedAt: now })
    .where(and(eq(giveaways.id, id), sql`${giveaways.pausedReason} is distinct from ${reason}`))
}

async function openFrom(exec: Pick<typeof db, 'select'>, chain: GiveawayChain, address: string, except?: string): Promise<boolean> {
  const [row] = await exec.select({ id: giveawayTxs.id }).from(giveawayTxs).where(and(
    eq(giveawayTxs.chain, chain), eq(giveawayTxs.fromAddress, address), inArray(giveawayTxs.status, [...OPEN]),
    except ? ne(giveawayTxs.id, except) : undefined,
  )).limit(1)
  return !!row
}

/** max(the chain's pending nonce, the last nonce this sender used + 1). */
async function nextNonce(client: GiveawayChainClient, address: string): Promise<number> {
  const pending = await client.nonce(address, 'pending')
  const [row] = await db.select({ n: sql<string | null>`max(${giveawayTxs.nonce})::text` }).from(giveawayTxs).where(and(
    eq(giveawayTxs.chain, client.chain), eq(giveawayTxs.fromAddress, address), isNotNull(giveawayTxs.nonce),
    or(inArray(giveawayTxs.status, ['sent', 'confirmed']), and(eq(giveawayTxs.status, 'failed'), isNotNull(giveawayTxs.feeWei))),
  ))
  return Math.max(pending, row?.n == null ? 0 : Number(row.n) + 1)
}

function tankWallet(): Wallet | null {
  return config.giveaways.gasKey ? new Wallet(config.giveaways.gasKey) : null
}

async function giveawayOf(id: string | null): Promise<GiveawayRow | null> {
  if (!id) return null
  return (await db.select().from(giveaways).where(eq(giveaways.id, id)))[0] ?? null
}

/** Who signs a row: the tank for a top-up, the giveaway's own wallet otherwise. */
async function signerFor(t: TxRow): Promise<BaseWallet> {
  if (t.kind === 'topup') {
    const tank = tankWallet()
    if (!tank) throw new Error(`top-up ${t.id} is open but no gas tank key is set`)
    return tank
  }
  const g = await giveawayOf(t.giveawayId)
  if (!g?.walletKeyEnc) throw new Error(`tx ${t.id} has no giveaway wallet to sign with`)
  return giveawaySigner(g.walletKeyEnc)
}

/**
 * Each claim's status from its mint rows: `sent` (with sentAt) once every row is sent, `minting` while any row is minting
 * or sent, `waiting` otherwise. Only claims still queued move.
 */
async function settleClaims(exec: Exec, claimIds: string[], now: Date): Promise<void> {
  if (!claimIds.length) return
  const unsent = sql`exists (select 1 from giveaway_claim_mints m where m.claim_id = ${giveawayClaims.id} and m.status <> 'sent')`
  const started = sql`exists (select 1 from giveaway_claim_mints m where m.claim_id = ${giveawayClaims.id} and m.status in ('minting', 'sent'))`
  await exec.update(giveawayClaims).set({
    status: sql`case when not ${unsent} then 'sent' when ${started} then 'minting' else 'waiting' end`,
    sentAt: sql`case when not ${unsent} then ${now.toISOString()}::timestamptz else ${giveawayClaims.sentAt} end`,
  }).where(and(inArray(giveawayClaims.id, claimIds), inArray(giveawayClaims.status, [...QUEUED])))
}

/** Fails queued claims and their mint rows not yet sent. */
async function failClaims(exec: Exec, claimIds: string[], reason: GiveawayFailReason): Promise<void> {
  if (!claimIds.length) return
  await exec.update(giveawayClaims).set({ status: 'failed', failReason: reason })
    .where(and(inArray(giveawayClaims.id, claimIds), inArray(giveawayClaims.status, [...QUEUED])))
  await exec.update(giveawayClaimMints).set({ status: 'failed' })
    .where(and(inArray(giveawayClaimMints.claimId, claimIds), inArray(giveawayClaimMints.status, ['waiting', 'minting'])))
}

/** Puts a mint transaction's rows back in the queue. */
async function requeueMints(exec: Exec, txId: string, now: Date): Promise<void> {
  const rows = await exec.update(giveawayClaimMints).set({ status: 'waiting', txId: null })
    .where(and(eq(giveawayClaimMints.txId, txId), eq(giveawayClaimMints.status, 'minting'))).returning({ claimId: giveawayClaimMints.claimId })
  await settleClaims(exec, rows.map((r) => r.claimId), now)
}

/** Refreshes the items' stored supply and minter state (the visitor open check reads them). */
async function refreshItems(client: GiveawayChainClient, g: GiveawayRow): Promise<GiveawayMintCheck[] | null> {
  try {
    return await mintCheck(g, client)
  } catch (err) {
    if (!(err instanceof GiveawayRpcError)) throw err
    rpcTrouble.add(client.chain)
    return null
  }
}

function reportTankLow(chain: GiveawayChain, now: Date): void {
  const last = tankLowReportedAt.get(chain)
  if (last !== undefined && now.getTime() - last < TANK_LOW_REPORT_MS) return
  tankLowReportedAt.set(chain, now.getTime())
  recordJobFailure('giveaway_tank_low', new Error(`The giveaway gas tank on ${chain} is at its floor; top-ups are paused`))
}

// ── The pass ─────────────────────────────────────────────────────────────────

/** One pass of the job, on the instance holding the 'giveaway-minter' lock (a no-op elsewhere or when giveaways are off). */
export async function runGiveawayJob(now = new Date(), deps: GiveawayJobDeps = { client: giveawayChainClient }): Promise<void> {
  if (!config.giveaways.enabled) return
  await withLock('giveaway-minter', () => pass(now, deps))
}

async function pass(now: Date, deps: GiveawayJobDeps): Promise<void> {
  try {
    await dropPresentClaims(now)
  } catch (err) {
    console.error(`[giveaways] present claim cleanup failed: ${safeErr(err)}`)
  }
  for (const chain of GIVEAWAY_CHAINS) {
    rpcTrouble.delete(chain)
    let rpcErr: GiveawayRpcError | null = null
    try {
      await runChain(deps.client(chain), now)
      succeeded(`chain:${chain}`)
    } catch (err) {
      if (err instanceof GiveawayRpcError) rpcErr = err
      else {
        console.error(`[giveaways] ${chain} pass failed: ${safeErr(err)}`)
        reportOnce(`chain:${chain}`, 'giveaway_job', `Giveaway ${chain} pass failed: ${safeErr(err)}`)
      }
    }
    if (!rpcErr && rpcTrouble.has(chain)) rpcErr = new GiveawayRpcError('pass', 'NETWORK_ERROR', true)
    try {
      await countRpc(chain, rpcErr, now)
    } catch (err) {
      console.error(`[giveaways] ${chain} rpc pause update failed: ${safeErr(err)}`)
    }
  }
}

/** A pass with RPC failures counts toward rpc_down (pausing the chain's giveaways once at the limit); a clean one resets it. */
async function countRpc(chain: GiveawayChain, rpcErr: GiveawayRpcError | null, now: Date): Promise<void> {
  if (!rpcErr) {
    rpcFails.delete(chain)
    await db.update(giveaways).set({ pausedReason: null, pausedAt: null, updatedAt: now })
      .where(and(eq(giveaways.chain, chain), eq(giveaways.pausedReason, 'rpc_down')))
    return
  }
  const n = (rpcFails.get(chain) ?? 0) + 1
  rpcFails.set(chain, n)
  console.warn(`[giveaways] ${chain} RPC trouble, pass ${n} in a row`)
  if (n < GIVEAWAY_RPC_FAILS_BEFORE_PAUSE) return
  await db.update(giveaways).set({ pausedReason: 'rpc_down', pausedAt: now, updatedAt: now })
    .where(and(eq(giveaways.chain, chain), isNull(giveaways.deletedAt), isNull(giveaways.pausedReason)))
  if (n === GIVEAWAY_RPC_FAILS_BEFORE_PAUSE) {
    recordJobFailure('giveaway_rpc', new Error(`Giveaway ${chain} RPC failed ${n} passes in a row (${safeErr(rpcErr)}); giveaways are paused`))
  }
}

async function runChain(client: GiveawayChainClient, now: Date): Promise<void> {
  await reconcileAll(client, now)
  await signWithdraws(client, now)
  await mintAll(client, now)
  await endsAndDeletes(client, now)
}

/** `present` claims of giveaways that ended or are being deleted can never be claimed: they go. */
async function dropPresentClaims(now: Date): Promise<void> {
  const gone = await db.delete(giveawayClaims).where(and(
    eq(giveawayClaims.status, 'present'),
    inArray(giveawayClaims.giveawayId, db.select({ id: giveaways.id }).from(giveaways)
      .where(or(lte(giveaways.endsAt, now), eq(giveaways.deleteState, 'returning')))),
  )).returning({ id: giveawayClaims.id })
  if (gone.length) console.log(`[giveaways] removed ${gone.length} unclaimed check-ins of ended giveaways`)
}

// ── 1. Reconciling open transactions ─────────────────────────────────────────

async function reconcileAll(client: GiveawayChainClient, now: Date): Promise<void> {
  const open = await db.select().from(giveawayTxs)
    .where(and(eq(giveawayTxs.chain, client.chain), inArray(giveawayTxs.status, [...OPEN]), isNotNull(giveawayTxs.rawTx)))
    .orderBy(sql`${giveawayTxs.nonce} asc nulls last`, asc(giveawayTxs.createdAt))
  const bySender = new Map<string, TxRow[]>()
  for (const t of open) bySender.set(lc(t.fromAddress), [...(bySender.get(lc(t.fromAddress)) ?? []), t])
  for (const rows of bySender.values()) {
    await step(client.chain, `tx:${rows[0].id}`, `tx ${rows[0].id}`, async () => {
      for (const t of rows) if (!(await reconcile(client, t, now))) return
    })
  }
}

/** Moves one open transaction on. True once it is settled (confirmed or failed). */
async function reconcile(client: GiveawayChainClient, t: TxRow, now: Date): Promise<boolean> {
  // The nonce is read before the receipts: if it was used before we looked, a mined hash of ours shows a receipt
  const latestNonce = await client.nonce(t.fromAddress, 'latest')
  const hashes = [...new Set([...(t.txHashes ?? []), ...(t.txHash ? [t.txHash] : [])])]
  for (const hash of hashes.reverse()) {
    const rc = await client.receipt(hash)
    if (!rc) continue
    if ((await client.latestBlock()) - rc.blockNumber < CONFIRMATIONS[t.chain]) return false
    if (rc.ok) await confirmed(client, t, hash, rc, now)
    else await reverted(client, t, hash, rc, now)
    return true
  }
  if (t.nonce !== null && latestNonce > t.nonce) {
    await replaced(t, now)
    return true
  }
  if (t.status === 'sending') {
    if (t.nextAttemptAt && t.nextAttemptAt > now) {
      // Still waiting out a failed broadcast's backoff: the RPC trouble goes on counting
      if (t.attempts > 0) rpcTrouble.add(t.chain)
      return false
    }
    await broadcast(client, t, t.rawTx!, now)
    return false
  }
  if (t.sentAt && now.getTime() - t.sentAt.getTime() >= GIVEAWAY_REPRICE_AFTER_MS) await reprice(client, t, now)
  return false
}

/**
 * Sends a signed transaction and marks it sent. "Nonce too low" and "replacement underpriced" count as sent (the nonce
 * or an earlier signing is on its way; reconcile settles it). A refusal for lack of funds waits for gas (low_gas). Any
 * other RPC failure, the RPC being down or not, keeps the row `sending` with its nonce and a backoff: it may have left.
 */
async function broadcast(client: GiveawayChainClient, t: TxRow, raw: string, now: Date): Promise<void> {
  let code: string | null = null
  try {
    await client.broadcast(raw)
  } catch (err) {
    if (!(err instanceof GiveawayRpcError)) throw err
    code = err.code
    if (code !== 'NONCE_EXPIRED' && code !== 'REPLACEMENT_UNDERPRICED') {
      if (code === 'INSUFFICIENT_FUNDS') {
        await db.update(giveawayTxs).set({ lastError: code, nextAttemptAt: null }).where(eq(giveawayTxs.id, t.id))
        if (t.giveawayId) await setPause(t.giveawayId, 'low_gas', now)
        if (t.kind === 'topup') reportTankLow(t.chain, now)
        console.warn(`[giveaways] tx ${t.id} refused for insufficient funds`)
        return
      }
      rpcTrouble.add(t.chain)
      const attempts = t.attempts + 1
      const wait = 2 ** Math.min(attempts, BACKOFF_MAX_EXP) * 60_000
      await db.update(giveawayTxs).set({ attempts, lastError: code, nextAttemptAt: new Date(now.getTime() + wait) }).where(eq(giveawayTxs.id, t.id))
      if (attempts === BROADCAST_REPORT_AT) {
        recordJobFailure('giveaway_broadcast', new Error(`Giveaway ${t.kind} tx ${t.id} not broadcast after ${attempts} attempts (${code}); it stays open at nonce ${t.nonce}`))
      }
      console.warn(`[giveaways] tx ${t.id} broadcast failed (${code}), attempt ${attempts}`)
      return
    }
  }
  await db.update(giveawayTxs).set({ status: 'sent', sentAt: now, attempts: 0, nextAttemptAt: null, ...(code ? { lastError: code } : {}) })
    .where(and(eq(giveawayTxs.id, t.id), inArray(giveawayTxs.status, [...OPEN])))
}

/**
 * Re-signs the same nonce with fees 15% up (and at least the node's), keeping the gas limit and the value. When the
 * higher fee would no longer fit (a mint or transfer within the wallet's balance, a withdraw beside Virvi's float) it
 * keeps waiting on the one it sent.
 */
async function reprice(client: GiveawayChainClient, t: TxRow, now: Date): Promise<void> {
  const old = Transaction.from(t.rawTx!)
  const node = await client.feeData()
  const tip = maxBig(bump(old.maxPriorityFeePerGas ?? 0n), node.maxPriorityFeePerGas)
  const maxFee = maxBig(maxBig(bump(old.maxFeePerGas ?? 0n), node.maxFeePerGas), tip)
  const fees: GiveawayFees = { maxFeePerGas: maxFee, maxPriorityFeePerGas: tip }
  const signer = await signerFor(t)
  let signed: { raw: string; hash: string }
  if (t.kind === 'mint') {
    // A replacement the wallet can't cover would be refused for funds while the earlier signing still waits: keep that one
    if (old.gasLimit * maxFee > (await client.balanceWei(t.fromAddress))) return
    const call = collectionInterface.decodeFunctionData('issueTokens', old.data)
    const wallets = (call[0] as string[]).map(String)
    const itemIds = (call[1] as bigint[]).map((i) => i.toString())
    signed = await client.signMint(signer, old.to!, wallets, itemIds, t.nonce!, fees, old.gasLimit)
  } else {
    const fee = GIVEAWAY_TRANSFER_GAS * maxFee
    if (t.kind !== 'topup') {
      const g = await giveawayOf(t.giveawayId)
      const [balance, acc] = await Promise.all([client.balanceWei(t.fromAddress), g ? accounting(g.id) : null])
      const room = t.kind === 'withdraw' ? balance - (acc?.virviUnspentWei ?? 0n) : balance
      if (old.value + fee > room) return
    }
    signed = await client.signTransfer(signer, old.to!, old.value, t.nonce!, fees)
  }
  // Recorded before the broadcast, so a crash after it never loses the hash
  const [next] = await db.update(giveawayTxs).set({
    rawTx: signed.raw, txHash: signed.hash, txHashes: sql`array_append(coalesce(${giveawayTxs.txHashes}, '{}'::text[]), ${signed.hash})`,
    status: 'sending', attempts: 0, nextAttemptAt: null,
  }).where(and(eq(giveawayTxs.id, t.id), eq(giveawayTxs.status, 'sent'))).returning()
  if (!next) return
  console.log(`[giveaways] tx ${t.id} repriced at nonce ${t.nonce}`)
  await broadcast(client, next, signed.raw, now)
}

/** A receipt deep enough: the transaction is confirmed and, for a mint, its claims' rows sent with their token ids. */
async function confirmed(client: GiveawayChainClient, t: TxRow, hash: string, rc: GiveawayReceipt, now: Date): Promise<void> {
  const done = await db.transaction(async (tx) => {
    const [row] = await tx.update(giveawayTxs).set({ status: 'confirmed', confirmedAt: now, feeWei: rc.feeWei.toString(), txHash: hash, lastError: null })
      .where(and(eq(giveawayTxs.id, t.id), inArray(giveawayTxs.status, [...OPEN]))).returning({ id: giveawayTxs.id })
    if (!row || t.kind !== 'mint') return !!row
    const rows = await tx.select({ claimId: giveawayClaimMints.claimId, wallet: giveawayClaims.wallet }).from(giveawayClaimMints)
      .innerJoin(giveawayClaims, eq(giveawayClaims.id, giveawayClaimMints.claimId))
      .where(and(eq(giveawayClaimMints.txId, t.id), eq(giveawayClaimMints.status, 'minting')))
    const tokens = new Map<string, string[]>()
    for (const i of rc.issues) tokens.set(lc(i.beneficiary), [...(tokens.get(lc(i.beneficiary)) ?? []), i.tokenId])
    let missing = 0
    for (const r of rows) {
      const ids = tokens.get(lc(r.wallet)) ?? []
      if (!ids.length) missing++
      await tx.update(giveawayClaimMints).set({ status: 'sent', tokenIds: ids })
        .where(and(eq(giveawayClaimMints.claimId, r.claimId), eq(giveawayClaimMints.txId, t.id)))
    }
    await settleClaims(tx, rows.map((r) => r.claimId), now)
    if (missing) console.warn(`[giveaways] mint ${t.id} confirmed without Issue logs for ${missing} of ${rows.length} claims`)
    console.log(`[giveaways] mint ${t.id} confirmed for ${rows.length} claims (giveaway ${t.giveawayId})`)
    return true
  })
  if (done && t.kind === 'mint') {
    const g = await giveawayOf(t.giveawayId)
    if (g) await refreshItems(client, g)
  }
  if (done && t.kind !== 'mint') console.log(`[giveaways] ${t.kind} ${t.id} confirmed (giveaway ${t.giveawayId})`)
}

/**
 * A mined revert. A mint's claims go back in the queue, and the fresh minter check says why: a lost minter or approval
 * pauses the giveaway, a supply change lets the next mint fail what can't be covered. A revert with no such reason
 * fails the claims (reverted) rather than spend gas on it again.
 */
async function reverted(client: GiveawayChainClient, t: TxRow, hash: string, rc: GiveawayReceipt, now: Date): Promise<void> {
  const g = t.kind === 'mint' ? await giveawayOf(t.giveawayId) : null
  // Read before anything is written: an RPC failure here leaves the transaction to settle on the next pass
  const checks = g ? await mintCheck(g, client) : null
  const why: { pause: GiveawayPauseReason | null; unknown: boolean } = { pause: null, unknown: t.kind !== 'mint' }
  await db.transaction(async (tx) => {
    const [row] = await tx.update(giveawayTxs).set({ status: 'failed', feeWei: rc.feeWei.toString(), txHash: hash, lastError: 'reverted' })
      .where(and(eq(giveawayTxs.id, t.id), inArray(giveawayTxs.status, [...OPEN]))).returning({ id: giveawayTxs.id })
    if (!row || !g || !checks) return
    const mine = checks.filter((c) => lc(c.contractAddress) === lc(t.contractAddress ?? ''))
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(giveawayClaimMints).where(eq(giveawayClaimMints.txId, t.id))
    const bad = mine.find((c) => c.state === 'not_approved') ?? mine.find((c) => c.state === 'not_minter')
    const short = mine.some((c) => c.state === 'sold_out' || c.remaining < n)
    if (bad || short) {
      if (bad) why.pause = bad.state as GiveawayPauseReason
      await requeueMints(tx, t.id, now)
      return
    }
    why.unknown = true
    const failed = await tx.select({ claimId: giveawayClaimMints.claimId }).from(giveawayClaimMints).where(eq(giveawayClaimMints.txId, t.id))
    await failClaims(tx, failed.map((r) => r.claimId), 'reverted')
  })
  if (why.pause && g) await setPause(g.id, why.pause, now)
  console.warn(`[giveaways] ${t.kind} ${t.id} reverted (giveaway ${t.giveawayId})${why.pause ? `; paused ${why.pause}` : ''}`)
  if (why.unknown) {
    recordJobFailure('giveaway_revert', new Error(`Giveaway ${t.kind} tx ${t.id} (giveaway ${t.giveawayId}) reverted on chain`))
  }
}

/** The nonce was used by a transaction we have no receipt for: ours never landed. A mint's claims are queued again. */
async function replaced(t: TxRow, now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.update(giveawayTxs).set({ status: 'failed', lastError: 'replaced' })
      .where(and(eq(giveawayTxs.id, t.id), inArray(giveawayTxs.status, [...OPEN]))).returning({ id: giveawayTxs.id })
    if (row && t.kind === 'mint') await requeueMints(tx, t.id, now)
  })
  console.warn(`[giveaways] ${t.kind} ${t.id} lost its nonce to another transaction`)
  recordJobFailure('giveaway_replaced', new Error(`Giveaway ${t.kind} tx ${t.id} (giveaway ${t.giveawayId}) was replaced: its nonce was used by another transaction`))
}

// ── 2. Host send-backs ───────────────────────────────────────────────────────

/** Signs the `withdraw` rows sendBack queued (no raw tx yet), then broadcasts them. */
async function signWithdraws(client: GiveawayChainClient, now: Date): Promise<void> {
  const rows = await db.select().from(giveawayTxs).where(and(
    eq(giveawayTxs.chain, client.chain), eq(giveawayTxs.kind, 'withdraw'), eq(giveawayTxs.status, 'sending'), isNull(giveawayTxs.rawTx),
  )).orderBy(asc(giveawayTxs.createdAt))
  for (const r of rows) {
    await step(client.chain, `withdraw:${r.id}`, `withdraw ${r.id}`, async () => {
      const signed = await signWithdraw(client, r)
      if (signed) await broadcast(client, signed, signed.rawTx!, now)
    })
  }
}

/**
 * Under the giveaway row's lock (sendBack takes it too), with nothing else open from the wallet: the value is re-checked
 * at today's fees so value + fee fits in the balance less Virvi's unspent float, lowered to what fits, or the row fails
 * (nothing_to_send) when nothing does. Then it is signed and written, before any broadcast.
 */
async function signWithdraw(client: GiveawayChainClient, r: TxRow): Promise<TxRow | null> {
  return db.transaction(async (tx) => {
    const [g] = r.giveawayId ? await tx.select().from(giveaways).where(eq(giveaways.id, r.giveawayId)).for('update') : []
    const [cur] = await tx.select().from(giveawayTxs).where(eq(giveawayTxs.id, r.id)).for('update')
    if (!cur || cur.status !== 'sending' || cur.rawTx) return null
    if (!g?.walletKeyEnc || g.walletAddress !== cur.fromAddress) {
      await tx.update(giveawayTxs).set({ status: 'failed', lastError: 'no_wallet' }).where(eq(giveawayTxs.id, cur.id))
      return null
    }
    if (await openFrom(tx, cur.chain, cur.fromAddress, cur.id)) return null
    const [balance, fees, acc] = await Promise.all([client.balanceWei(cur.fromAddress), client.feeData(), accounting(g.id)])
    const fits = balance - acc.virviUnspentWei - GIVEAWAY_TRANSFER_GAS * fees.maxFeePerGas
    const value = minBig(BigInt(cur.valueWei), fits)
    if (value <= 0n) {
      await tx.update(giveawayTxs).set({ status: 'failed', lastError: 'nothing_to_send' }).where(eq(giveawayTxs.id, cur.id))
      console.log(`[giveaways] withdraw ${cur.id} has nothing left to send`)
      return null
    }
    const nonce = await nextNonce(client, cur.fromAddress)
    const s = await client.signTransfer(giveawaySigner(g.walletKeyEnc), cur.toAddress, value, nonce, fees)
    const [row] = await tx.update(giveawayTxs).set({
      nonce, rawTx: s.raw, txHash: s.hash, txHashes: [s.hash], valueWei: value.toString(),
    }).where(eq(giveawayTxs.id, cur.id)).returning()
    if (value < BigInt(cur.valueWei)) console.log(`[giveaways] withdraw ${cur.id} lowered to fit beside the float`)
    return row
  })
}

// ── 3. Minting ───────────────────────────────────────────────────────────────

async function mintAll(client: GiveawayChainClient, now: Date): Promise<void> {
  const due = await db.selectDistinct({ g: giveaways }).from(giveaways)
    .innerJoin(giveawayClaims, eq(giveawayClaims.giveawayId, giveaways.id))
    .innerJoin(giveawayClaimMints, eq(giveawayClaimMints.claimId, giveawayClaims.id))
    .where(and(
      eq(giveaways.chain, client.chain), eq(giveaways.enabled, true), isNull(giveaways.deletedAt), isNull(giveaways.deleteState),
      isNotNull(giveaways.walletAddress), isNotNull(giveaways.walletKeyEnc),
      inArray(giveawayClaims.status, [...QUEUED]), eq(giveawayClaimMints.status, 'waiting'),
    ))
  for (const { g } of due) await step(client.chain, `mint:${g.id}`, `giveaway ${g.id} mint`, () => mintNext(client, g, now))
}

type Queued = { claimId: string; wallet: string; contractAddress: string }

async function queuedRows(g: GiveawayRow): Promise<Queued[]> {
  return db.select({ claimId: giveawayClaimMints.claimId, wallet: giveawayClaims.wallet, contractAddress: giveawayClaimMints.contractAddress })
    .from(giveawayClaimMints).innerJoin(giveawayClaims, eq(giveawayClaims.id, giveawayClaimMints.claimId))
    .where(and(eq(giveawayClaims.giveawayId, g.id), inArray(giveawayClaims.status, [...QUEUED]), eq(giveawayClaimMints.status, 'waiting')))
    .orderBy(asc(giveawayClaims.claimedAt), asc(giveawayClaims.id))
}

/**
 * The giveaway's next mint, when nothing is open from its wallet: the minter check (a failure pauses it), claims past
 * the remaining supply failed (sold_out), then one batch for one contract signed under the row lock. A wallet short of
 * gas gets a top-up from the tank when its owner is paid, or is paused low_gas.
 */
async function mintNext(client: GiveawayChainClient, g: GiveawayRow, now: Date): Promise<void> {
  const from = g.walletAddress!
  if (await openFrom(db, g.chain, from)) return
  const checks = await mintCheck(g, client)
  let queued = await queuedRows(g)
  const contracts = [...new Set(queued.map((q) => lc(q.contractAddress)))].sort()
  const involved = checks.filter((c) => contracts.includes(lc(c.contractAddress)))
  const bad = involved.find((c) => c.state === 'not_approved') ?? involved.find((c) => c.state === 'not_minter')
  if (bad) {
    await setPause(g.id, bad.state as GiveawayPauseReason, now)
    console.log(`[giveaways] giveaway ${g.id} paused: ${bad.state}`)
    return
  }
  for (const contract of contracts) {
    const items = involved.filter((c) => lc(c.contractAddress) === contract).sort((a, b) => (BigInt(a.itemId) < BigInt(b.itemId) ? -1 : 1))
    const rows = queued.filter((q) => lc(q.contractAddress) === contract)
    if (!items.length || !rows.length) continue
    const supply = Math.min(...items.map((i) => (i.state === 'sold_out' ? 0 : i.remaining)))
    const over = rows.slice(supply).map((r) => r.claimId)
    if (over.length) {
      await db.transaction((tx) => failClaims(tx, over, 'sold_out'))
      console.log(`[giveaways] giveaway ${g.id}: ${over.length} claims failed sold out`)
      queued = queued.filter((q) => !over.includes(q.claimId))
    }
    const batch = rows.slice(0, Math.min(supply, singles.has(g.id) ? 1 : GIVEAWAY_MAX_CLAIMS_PER_TX))
    if (!batch.length) continue
    await mintBatch(client, g, batch, items.map((i) => i.itemId), now)
    return
  }
}

async function mintBatch(client: GiveawayChainClient, g: GiveawayRow, batch: Queued[], itemIds: string[], now: Date): Promise<void> {
  const from = g.walletAddress!
  const contract = batch[0].contractAddress
  const wallets: string[] = []
  const ids: string[] = []
  for (const b of batch) for (const i of itemIds) { wallets.push(b.wallet); ids.push(i) }
  const [paid, acc] = await Promise.all([ownerIsPaid(g.ownerId), accounting(g.id)])
  const signer = giveawaySigner(g.walletKeyEnc!)
  const claimIds = batch.map((b) => b.claimId)

  type Outcome = { kind: 'busy' } | { kind: 'signed'; row: TxRow } | { kind: 'revert'; err: GiveawayRevert } | { kind: 'low'; need: bigint; balance: bigint }
  const out: Outcome = await db.transaction(async (tx): Promise<Outcome> => {
    const [locked] = await tx.select().from(giveaways).where(eq(giveaways.id, g.id)).for('update')
    if (!locked || !locked.enabled || locked.deletedAt || locked.deleteState) return { kind: 'busy' }
    if (await openFrom(tx, g.chain, from)) return { kind: 'busy' }
    const still = await tx.select({ claimId: giveawayClaimMints.claimId }).from(giveawayClaimMints).where(and(
      inArray(giveawayClaimMints.claimId, claimIds), eq(giveawayClaimMints.contractAddress, contract), eq(giveawayClaimMints.status, 'waiting'),
    )).for('update')
    if (still.length !== batch.length) return { kind: 'busy' }
    const nonce = await nextNonce(client, from)
    let signed: Awaited<ReturnType<GiveawayChainClient['signMint']>>
    try {
      signed = await client.signMint(signer, contract, wallets, ids, nonce)
    } catch (err) {
      if (err instanceof GiveawayRevert) return { kind: 'revert', err }
      if (err instanceof GiveawayRpcError && err.code === 'INSUFFICIENT_FUNDS') {
        const fees = await client.feeData()
        return { kind: 'low', need: GIVEAWAY_GAS_PER_ITEM * BigInt(wallets.length) * fees.maxFeePerGas, balance: await client.balanceWei(from) }
      }
      throw err
    }
    const need = signed.gasLimit * signed.fees.maxFeePerGas
    const balance = await client.balanceWei(from)
    // The signed transaction is dropped unsent: its nonce stays free
    if (balance * 10n < need * 12n) return { kind: 'low', need, balance }
    const [row] = await tx.insert(giveawayTxs).values({
      giveawayId: g.id, chain: g.chain, kind: 'mint', fromAddress: from, toAddress: contract, contractAddress: contract,
      nonce, rawTx: signed.raw, txHash: signed.hash, txHashes: [signed.hash], status: 'sending',
      covered: paid && acc.topUpsWei > 0n,
    }).returning()
    await tx.update(giveawayClaimMints).set({ status: 'minting', txId: row.id })
      .where(and(inArray(giveawayClaimMints.claimId, claimIds), eq(giveawayClaimMints.contractAddress, contract)))
    await settleClaims(tx, claimIds, now)
    return { kind: 'signed', row }
  })

  if (out.kind === 'busy') return
  if (out.kind === 'signed') {
    singles.delete(g.id)
    await setPause(g.id, null, now)
    console.log(`[giveaways] giveaway ${g.id}: mint ${out.row.id} signed for ${batch.length} claims`)
    await broadcast(client, out.row, out.row.rawTx!, now)
    return
  }
  if (out.kind === 'revert') {
    const reason = revertReason(out.err)
    if (reason === 'not_minter' || reason === 'not_approved') {
      await setPause(g.id, reason, now)
    } else if (reason !== 'sold_out') {
      // An unknown revert at estimate: try the claims one at a time; a single one that still reverts fails
      if (batch.length > 1) singles.add(g.id)
      else {
        await db.transaction((tx) => failClaims(tx, claimIds, 'reverted'))
        reportOnce(`revert:${g.id}`, 'giveaway_revert', `Giveaway ${g.id}: a claim's mint reverts at estimate (${out.err.reason}); the claim failed`, g.ownerId)
      }
    }
    console.warn(`[giveaways] giveaway ${g.id}: mint of ${batch.length} claims reverts at estimate (${reason ?? 'unknown'})`)
    return
  }
  const result = await topUp(client, g, paid, out.need / BigInt(batch.length), out.balance, now)
  await setPause(g.id, result === 'low_gas' ? 'low_gas' : null, now)
}

/**
 * Tops a paid owner's giveaway wallet up from the tank to 50 claims' worth of gas (at most 5 POL), if the tank stays at
 * or above its floor. 'low_gas' when that can't happen (not paid, no tank, tank at its floor); 'waiting' when a top-up is
 * already on its way or the tank is busy with another.
 */
async function topUp(
  client: GiveawayChainClient, g: GiveawayRow, paid: boolean, perClaim: bigint, balance: bigint, now: Date,
): Promise<'low_gas' | 'waiting' | 'sent'> {
  const tank = tankWallet()
  if (!paid || !tank) return 'low_gas'
  const [pending] = await db.select({ id: giveawayTxs.id }).from(giveawayTxs)
    .where(and(eq(giveawayTxs.giveawayId, g.id), eq(giveawayTxs.kind, 'topup'), inArray(giveawayTxs.status, [...OPEN]))).limit(1)
  if (pending || (await openFrom(db, g.chain, tank.address))) return 'waiting'
  const want = perClaim * TOPUP_CLAIMS - balance
  const amount = minBig(want, TOPUP_MAX_WEI)
  if (amount <= 0n) return 'low_gas'
  const [tankBalance, fees] = await Promise.all([client.balanceWei(tank.address), client.feeData()])
  if (tankBalance - amount - GIVEAWAY_TRANSFER_GAS * fees.maxFeePerGas < config.giveaways.tankMinWeiByChain[g.chain]) {
    reportTankLow(g.chain, now)
    return 'low_gas'
  }
  const nonce = await nextNonce(client, tank.address)
  const s = await client.signTransfer(tank, g.walletAddress!, amount, nonce, fees)
  const [row] = await db.insert(giveawayTxs).values({
    giveawayId: g.id, chain: g.chain, kind: 'topup', fromAddress: tank.address, toAddress: g.walletAddress!, valueWei: amount.toString(),
    nonce, rawTx: s.raw, txHash: s.hash, txHashes: [s.hash], status: 'sending',
  }).returning()
  console.log(`[giveaways] giveaway ${g.id}: top-up ${row.id} from the tank`)
  await broadcast(client, row, s.raw, now)
  return 'sent'
}

// ── 4. Ends and deletes ──────────────────────────────────────────────────────

/**
 * Giveaways being deleted, and ended ones with a confirmed top-up not yet followed by a confirmed return: Virvi's
 * unspent float, less the transfer's gas, goes back to the tank once nothing is open from the wallet (an ended one also
 * waits for its queued claims). A delete with nothing left to return is finished: deletedAt set, the key dropped.
 */
async function endsAndDeletes(client: GiveawayChainClient, now: Date): Promise<void> {
  const toppedUpSinceReturn = sql`exists (select 1 from giveaway_txs t where t.giveaway_id = ${giveaways.id} and t.kind = 'topup' and t.status = 'confirmed'
    and not exists (select 1 from giveaway_txs r where r.giveaway_id = ${giveaways.id} and r.kind = 'return' and r.status = 'confirmed' and r.created_at > t.created_at))`
  const rows = await db.select().from(giveaways).where(and(
    eq(giveaways.chain, client.chain), isNull(giveaways.deletedAt),
    or(eq(giveaways.deleteState, 'returning'), and(lte(giveaways.endsAt, now), toppedUpSinceReturn)),
  ))
  let fees: GiveawayFees | null = null
  const feesOnce = async () => (fees ??= await client.feeData())
  for (const g of rows) {
    await step(client.chain, `end:${g.id}`, `giveaway ${g.id} end`, () => endOne(client, g, feesOnce, now))
  }
}

async function endOne(client: GiveawayChainClient, g: GiveawayRow, feesOnce: () => Promise<GiveawayFees>, now: Date): Promise<void> {
  const deleting = g.deleteState === 'returning'
  if (g.walletAddress && (await openFrom(db, g.chain, g.walletAddress))) return
  if (!deleting) {
    const [q] = await db.select({ id: giveawayClaims.id }).from(giveawayClaims)
      .where(and(eq(giveawayClaims.giveawayId, g.id), inArray(giveawayClaims.status, [...QUEUED]))).limit(1)
    if (q) return
  } else {
    // A deleted giveaway mints nothing more: what is still queued fails as ended
    const q = await db.select({ id: giveawayClaims.id }).from(giveawayClaims)
      .where(and(eq(giveawayClaims.giveawayId, g.id), inArray(giveawayClaims.status, [...QUEUED])))
    if (q.length) {
      await db.transaction((tx) => failClaims(tx, q.map((r) => r.id), 'ended'))
      console.log(`[giveaways] giveaway ${g.id} deleted with ${q.length} queued claims; they failed`)
    }
  }
  if (g.walletAddress && g.walletKeyEnc) {
    const acc = await accounting(g.id)
    const fees = await feesOnce()
    const gas = GIVEAWAY_TRANSFER_GAS * fees.maxFeePerGas
    if (acc.virviUnspentWei > gas) {
      const balance = await client.balanceWei(g.walletAddress)
      const avail = minBig(acc.virviUnspentWei, balance)
      if (avail > gas) {
        const tank = tankWallet()
        if (!tank) {
          reportOnce(`no-tank:${g.id}`, 'giveaway_job', `Giveaway ${g.id} holds Virvi's float but no gas tank key is set to return it to`)
          return
        }
        await sendReturn(client, g, tank.address, avail - gas, fees, now)
        return
      }
    }
  }
  if (deleting) {
    const [done] = await db.update(giveaways).set({ deletedAt: now, walletKeyEnc: null, enabled: false, updatedAt: now })
      .where(and(eq(giveaways.id, g.id), isNull(giveaways.deletedAt))).returning({ id: giveaways.id })
    if (done) console.log(`[giveaways] giveaway ${g.id} deleted`)
  }
}

async function sendReturn(client: GiveawayChainClient, g: GiveawayRow, to: string, value: bigint, fees: GiveawayFees, now: Date): Promise<void> {
  const row = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(giveaways).where(eq(giveaways.id, g.id)).for('update')
    if (!locked?.walletKeyEnc || locked.deletedAt || (await openFrom(tx, g.chain, g.walletAddress!))) return null
    const nonce = await nextNonce(client, g.walletAddress!)
    const s = await client.signTransfer(giveawaySigner(locked.walletKeyEnc), to, value, nonce, fees)
    const [r] = await tx.insert(giveawayTxs).values({
      giveawayId: g.id, chain: g.chain, kind: 'return', fromAddress: g.walletAddress!, toAddress: to, valueWei: value.toString(),
      nonce, rawTx: s.raw, txHash: s.hash, txHashes: [s.hash], status: 'sending',
    }).returning()
    return r
  })
  if (!row) return
  console.log(`[giveaways] giveaway ${g.id}: return ${row.id} to the tank`)
  await broadcast(client, row, row.rawTx!, now)
}

// ── Start ────────────────────────────────────────────────────────────────────

/** Runs a pass every config.giveaways.jobEveryMs (the first 30 s after boot), only when giveaways are on. Returns a stopper. */
export function startGiveawayJob(): () => void {
  if (!config.giveaways.enabled) return () => {}
  let running = false
  const run = async () => {
    if (running) return
    running = true
    try {
      await runGiveawayJob(new Date())
    } catch (err) {
      console.error(`[giveaways] minting pass failed: ${safeErr(err)}`)
    } finally {
      running = false
    }
  }
  const every = setInterval(run, config.giveaways.jobEveryMs)
  every.unref()
  const first = setTimeout(run, 30_000)
  first.unref()
  return () => { clearInterval(every); clearTimeout(first) }
}
