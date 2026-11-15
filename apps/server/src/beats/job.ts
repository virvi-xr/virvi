import { Transaction } from 'ethers'
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, notInArray, or, sql } from 'drizzle-orm'
import {
  BEAT_CHAINS, BEAT_CHAIN_INFO, BEAT_CLAIM_GRACE_MS, BEAT_FEE_BUMP_PERCENT, BEAT_JOB_EVERY_MS, BEAT_MAX_BATCH,
  BEAT_REPRICE_AFTER_MS, BEAT_SEND_MAX_ATTEMPTS, type BeatChain,
} from '@virvixr/shared'
import { config } from '../config.js'
import { db } from '../db/connection.js'
import { beatClaims, beatMintBatches, beatPayments, beats } from '../db/schema.js'
import { withLock } from '../errors/jobs.js'
import { recordJobFailure } from '../errors/record.js'
import { BEAT_RECEIVER_GAS } from './abi.js'
import { BeatRevert, BeatRpcError, beatChainClient, beatInterface, type BeatCall, type BeatChainClient, type BeatLog, type BeatSigned } from './chain.js'
import { BeatError } from './errors.js'
import { lockBeat } from './lock.js'
import { sweepBeatPayments } from './payments.js'

/**
 * The BEAT minting job (LIV-11): every BEAT_JOB_EVERY_MS, on one instance (session advisory lock 'beat-minter', so no
 * transaction stays open while it waits on a chain), it moves BEAT statuses on and turns paid BEATs and claimed
 * attendances into transactions on each chain that has a client.
 *
 * Per chain, at most one transaction is open (`sending` or `sent`). Each tick reconciles it first (receipt with the
 * chain's confirmations, a nonce taken by a hash we lost, a crash before the broadcast, a reprice after
 * BEAT_REPRICE_AFTER_MS), and only sends the next one (create, then mint, then close) once nothing is open and the
 * minter has gas. A batch is written with its signed raw tx before it is broadcast, so a crash never loses a nonce.
 *
 * Logs carry BEAT ids, batch ids and counts only: never wallets or display names.
 */

type Batch = typeof beatMintBatches.$inferSelect
export type BeatPauseReason = 'low_gas' | 'no_client' | 'id_conflict' | null
/** sent: new transactions broadcast; confirmed: batches confirmed; failed: batches and claims that became failed;
 * paused: the chains paused after the tick (no client, low gas or an id conflict). */
export type BeatTickResult = { sent: number; confirmed: number; failed: number; paused: BeatChain[] }

// ── In-memory state (reset on restart) ───────────────────────────────────────

const pauses = new Map<BeatChain, BeatPauseReason>()
/** Ruling 4: after a mint batch reverts on chain (InsufficientGas, or any revert), the BEAT's next batches take at most
 * half of that batch's size, down to 1. Kept until restart. */
const maxBatch = new Map<string, number>()
/** Ruling 5: wallets (lower case) of a batch whose estimate reverted, to be sent one at a time. Per BEAT. */
const singles = new Map<string, Set<string>>()
/** BEATs already reported as unable to go live (their create payment isn't paid), so it's reported once. */
const reportedNotPaid = new Set<string>()
/** BEATs whose create estimate reverted (other than BeatExists), already reported once. */
const reportedCreateRevert = new Set<string>()
/** Chains whose node refused a transaction this tick for insufficient funds, or whose balance can't pay for the next
 * batch: they stay paused for low gas even when the balance is above BEAT_MIN_GAS_POL. Cleared at each chain pass. */
const shortOfFunds = new Set<BeatChain>()
/** Per chain, what the job last learnt of a transaction's cost, for the admin's low-gas top-up: the max fee per gas it
 * last signed with (any kind), and the gas limit and size of the largest mint batch it signed. */
const lastFee = new Map<BeatChain, bigint>()
const mintGas = new Map<BeatChain, { gasLimit: bigint; wallets: number }>()

export const beatJobTestHooks: {
  afterInsert?: (batchId: string) => Promise<void>
  /** Runs after a plan is signed and before its batch is recorded (tests interleave other writers here). */
  beforeInsert?: (plan: { kind: 'create' | 'mint' | 'close'; beatId: string }) => Promise<void>
} = {}

/** Tests: forget the in-memory pauses, batch caps and single-wallet flags. */
export function resetBeatJobState(): void {
  pauses.clear()
  maxBatch.clear()
  singles.clear()
  reportedNotPaid.clear()
  reportedCreateRevert.clear()
  shortOfFunds.clear()
  lastFee.clear()
  mintGas.clear()
}

/** Whether a chain's minting is paused, and why. Set each tick; `id_conflict` stays until restart or clearBeatPause. */
export function beatPaused(chain: BeatChain): { paused: boolean; reason: BeatPauseReason } {
  const reason = pauses.get(chain) ?? null
  return { paused: reason !== null, reason }
}

/** The admin action that lifts a pause (an `id_conflict` once it has been looked into). */
export function clearBeatPause(chain: BeatChain): void {
  pauses.delete(chain)
}

/** Remembers a signed transaction's fees, and a mint's gas per wallet (the largest batch seen gives the best figure). */
function noteCost(chain: BeatChain, kind: Batch['kind'], gasLimit: bigint, maxFeePerGas: bigint, wallets: number): void {
  lastFee.set(chain, maxFeePerGas)
  if (kind === 'mint' && wallets > 0 && wallets >= (mintGas.get(chain)?.wallets ?? 0)) mintGas.set(chain, { gasLimit, wallets })
}

/**
 * What one full BEAT_MAX_BATCH mint batch would cost at the fees the job last signed with: the largest mint it signed,
 * scaled up per wallet (an upper bound, since the batch's fixed overhead is scaled too). Null until the job has signed
 * a mint on this chain since it started.
 */
export function beatBatchCostWei(chain: BeatChain): bigint | null {
  const fee = lastFee.get(chain)
  const gas = mintGas.get(chain)
  if (fee === undefined || !gas) return null
  const n = BigInt(gas.wallets)
  return ((gas.gasLimit * BigInt(BEAT_MAX_BATCH) + n - 1n) / n) * fee
}

const setPause = (chain: BeatChain, reason: BeatPauseReason) => {
  if (pauses.get(chain) === 'id_conflict' && reason !== 'id_conflict') return
  if (reason) pauses.set(chain, reason)
  else pauses.delete(chain)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const lc = (s: string) => s.toLowerCase()

/** A loggable error message. Drizzle's "Failed query" messages list the parameters (wallets), so those log the cause. */
export function safeErr(err: unknown): string {
  if (err instanceof BeatRpcError || err instanceof BeatRevert) return err.message
  if (err instanceof Error) {
    if (/^Failed query/.test(err.message)) {
      const cause = (err as { cause?: { message?: string; code?: string } }).cause
      return `query failed${cause?.code ? ` (${cause.code})` : ''}${cause?.message ? `: ${cause.message}` : ''}`
    }
    return err.message
  }
  return String(err)
}

const rpcCode = (err: unknown) => (err instanceof BeatRpcError ? err.code : 'UNKNOWN_ERROR')
/** The node refused for lack of POL (chain.ts turns ethers' code and the node's "insufficient funds" message into this). */
const noFunds = (err: unknown) => rpcCode(err) === 'INSUFFICIENT_FUNDS'

/** Pauses the chain for low gas until a later tick finds enough POL. Nothing is counted against any batch or claim. */
function shortOf(chain: BeatChain): void {
  shortOfFunds.add(chain)
  setPause(chain, 'low_gas')
}

/**
 * Claim failure reasons that are final for that wallet, so they never hold a BEAT open: the contract skipped or the
 * wallet's receiver hook refused it (`receiver_rejected`, `ERC1155InvalidReceiver`), or the BEAT is already closed on
 * chain (`BeatClosedError`), or an admin gave up on it so the BEAT can close (`given_up`). Every other reason
 * (send_failed, reverted, InsufficientGas, unknown, ...) can succeed on an admin's retry, so a BEAT with such a claim
 * isn't closed.
 */
export const BEAT_FINAL_FAIL_REASONS = ['receiver_rejected', 'ERC1155InvalidReceiver', 'BeatClosedError', 'given_up'] as const
/** The reason an admin's give-up writes; retryFailedClaims leaves these claims failed. */
export const BEAT_GIVEN_UP = 'given_up'

/** A claim that failed for a reason an admin's retry could still mint (not in BEAT_FINAL_FAIL_REASONS). */
export const retryableFailed = and(
  eq(beatClaims.status, 'failed'),
  sql`coalesce(${beatClaims.failReason}, '') not in (${sql.join(BEAT_FINAL_FAIL_REASONS.map((x) => sql`${x}`), sql`, `)})`,
)!

function decodeCall(data: string): BeatCall {
  const tx = beatInterface.parseTransaction({ data })
  switch (tx?.name) {
    case 'createBeat': return { kind: 'create', tokenId: tx.args[0], tradeable: tx.args[1] }
    case 'mintTo': return { kind: 'mint', tokenId: tx.args[0], wallets: [...tx.args[1]] }
    case 'closeBeat': return { kind: 'close', tokenId: tx.args[0] }
  }
  throw new Error('BEAT batch holds an unknown call')
}

function fail(job: string, message: string, owner: string | null): void {
  console.error(`[beats] ${message}`)
  recordJobFailure(job, new Error(message), { owner })
}

/** Deletes the batch's delete-requested claims that aren't minted, and unlinks the minted ones (the wallet stays: it is
 * public on chain). Run whenever a batch settles. */
async function settleDeletes(tx: Pick<typeof db, 'update' | 'delete'>, batchId: string): Promise<void> {
  await tx.delete(beatClaims).where(and(eq(beatClaims.batchId, batchId), eq(beatClaims.deleteRequested, true), sql`${beatClaims.status} <> 'minted'`))
  await tx.update(beatClaims).set({ userId: null, displayName: null })
    .where(and(eq(beatClaims.batchId, batchId), eq(beatClaims.deleteRequested, true), eq(beatClaims.status, 'minted')))
}

async function freeze(tx: Pick<typeof db, 'update'>, beatId: string, now: Date): Promise<void> {
  await tx.update(beats).set({ frozenAt: now }).where(and(eq(beats.id, beatId), isNull(beats.frozenAt)))
}

// ── Statuses ─────────────────────────────────────────────────────────────────

/**
 * paid → live at starts_at, under the BEAT's lock (so it serialises with cancel and refunds), and only while its create
 * payment is paid: a BEAT whose payment was refunded stays paid and is reported once. live → ended at ends_at.
 */
async function advanceStatuses(now: Date): Promise<void> {
  const due = await db.select({ id: beats.id }).from(beats).where(and(eq(beats.status, 'paid'), lte(beats.startsAt, now)))
  for (const { id } of due) {
    const outcome = await db.transaction(async (tx) => {
      await lockBeat(tx, id)
      const [row] = await tx.select().from(beats).where(eq(beats.id, id)).for('update')
      if (!row || row.status !== 'paid' || row.startsAt > now) return 'skip'
      const [pay] = row.paymentId ? await tx.select({ status: beatPayments.status }).from(beatPayments).where(eq(beatPayments.id, row.paymentId)) : []
      if (pay?.status !== 'paid') return 'not_paid'
      await tx.update(beats).set({ status: 'live', updatedAt: now }).where(and(eq(beats.id, id), eq(beats.status, 'paid')))
      return 'live'
    })
    if (outcome === 'live') console.log(`[beats] BEAT ${id} is live`)
    if (outcome === 'not_paid' && !reportedNotPaid.has(id)) {
      reportedNotPaid.add(id)
      fail('beat_go_live', `BEAT ${id} can't go live: its create payment isn't paid`, id)
    }
  }
  const ended = await db.update(beats).set({ status: 'ended', updatedAt: now })
    .where(and(eq(beats.status, 'live'), lte(beats.endsAt, now))).returning({ id: beats.id })
  for (const { id } of ended) console.log(`[beats] BEAT ${id} ended`)
}

// ── The tick ─────────────────────────────────────────────────────────────────

/** One pass of the job. On an instance that doesn't win the lock it does nothing and returns zeros. */
export async function runBeatTick(now = new Date()): Promise<BeatTickResult> {
  const out = await withLock('beat-minter', () => tick(now))
  return out ?? { sent: 0, confirmed: 0, failed: 0, paused: [] }
}

async function tick(now: Date): Promise<BeatTickResult> {
  const r: BeatTickResult = { sent: 0, confirmed: 0, failed: 0, paused: [] }
  try {
    await sweepBeatPayments(now)
  } catch (err) {
    console.error('[beats] payment sweep failed:', safeErr(err))
  }
  try {
    await advanceStatuses(now)
  } catch (err) {
    console.error('[beats] status pass failed:', safeErr(err))
  }
  for (const chain of BEAT_CHAINS) {
    const client = beatChainClient(chain)
    if (!client) setPause(chain, 'no_client')
    else {
      try {
        await runChain(client, now, r)
      } catch (err) {
        console.error(`[beats] ${chain} pass failed:`, safeErr(err))
      }
    }
    if (beatPaused(chain).paused) r.paused.push(chain)
  }
  return r
}

async function runChain(client: BeatChainClient, now: Date, r: BeatTickResult): Promise<void> {
  const chain = client.chain
  if (pauses.get(chain) === 'no_client') pauses.delete(chain)
  shortOfFunds.delete(chain)
  const [open] = await db.select().from(beatMintBatches)
    .where(and(eq(beatMintBatches.chain, chain), inArray(beatMintBatches.status, ['sending', 'sent'])))
    .orderBy(asc(beatMintBatches.nonce)).limit(1)
  const settled = open ? await reconcile(client, open, now, r) : true
  const balance = await client.balanceWei()
  const low = shortOfFunds.has(chain) || balance < config.beats.minGasWei
  setPause(chain, low ? 'low_gas' : null)
  if (!settled || low || pauses.get(chain) === 'id_conflict') return
  await sendNext(client, now, r, balance)
}

// ── Reconciling the open transaction ─────────────────────────────────────────

/** Moves the open batch on. True once it is settled (confirmed or failed), so the chain is free for the next send. */
async function reconcile(client: BeatChainClient, b: Batch, now: Date, r: BeatTickResult): Promise<boolean> {
  const need = BEAT_CHAIN_INFO[b.chain].confirmations
  for (const hash of [...b.txHashes].reverse()) {
    const rc = await client.receipt(hash)
    if (!rc) continue
    // Depth counts the blocks after the inclusion block (as studioMana does), so it is one block stricter than the
    // constant read as ethers' confirmations(): Amoy waits for 6 blocks including the inclusion one, Polygon for 31
    if ((await client.latestBlock()) - rc.blockNumber < need) return false
    if (rc.ok) await confirmBatch(client, b, hash, rc.logs, now, r)
    else await revertedBatch(client, b, now, r)
    return true
  }
  if ((await client.nonce('latest')) > b.nonce) {
    await unminedBatch(client, b, now, r, { lastError: 'replaced', unminted: 'claimed' })
    return true
  }
  if (b.status === 'sending') {
    if (b.nextAttemptAt && b.nextAttemptAt > now) return false
    return (await broadcastBatch(client, b, b.rawTx!, now, r)) === 'gave_up'
  }
  if (b.sentAt && now.getTime() - b.sentAt.getTime() >= BEAT_REPRICE_AFTER_MS) {
    return (await reprice(client, b, now, r)) === 'gave_up'
  }
  return false
}

/**
 * Broadcasts a batch's raw tx and marks it sent. NONCE_EXPIRED (the nonce is used: the next tick reconciles it) and
 * REPLACEMENT_UNDERPRICED (an earlier signing of this nonce is still pending) count as sent. INSUFFICIENT_FUNDS pauses
 * the chain for low gas and counts nothing. Any other failure leaves it `sending` with a backoff of 2^attempts minutes;
 * at BEAT_SEND_MAX_ATTEMPTS it gives up.
 */
async function broadcastBatch(client: BeatChainClient, b: Batch, raw: string, now: Date, r: BeatTickResult): Promise<'sent' | 'retry' | 'gave_up'> {
  let code: string | null = null
  try {
    await client.broadcast(raw)
  } catch (err) {
    code = rpcCode(err)
    if (noFunds(err)) {
      // Not the batch's fault: it stays `sending` with its nonce and claims, uncounted, and goes again once there's gas
      shortOf(b.chain)
      const t = Transaction.from(raw)
      noteCost(b.chain, b.kind, t.gasLimit, t.maxFeePerGas ?? 0n, b.wallets?.length ?? 0)
      await db.update(beatMintBatches).set({ lastError: code, nextAttemptAt: null }).where(eq(beatMintBatches.id, b.id))
      console.warn(`[beats] batch ${b.id} refused for insufficient funds; ${b.chain} paused for low gas`)
      return 'retry'
    }
    if (code !== 'NONCE_EXPIRED' && code !== 'REPLACEMENT_UNDERPRICED') {
      const attempts = b.attempts + 1
      // Never accepted by any broadcast: no node has it, and reconcile checked its nonce isn't used
      const neverSent = b.sentAt === null && b.txHashes.length <= 1
      if (attempts >= BEAT_SEND_MAX_ATTEMPTS && neverSent) {
        await db.update(beatMintBatches).set({ attempts }).where(eq(beatMintBatches.id, b.id))
        // Unsent: the next transaction takes its nonce again
        await unminedBatch(client, b, now, r, { lastError: `unsent:${code}`, unminted: 'failed' })
        fail(`beat_${b.kind}`, `BEAT ${b.kind} batch ${b.id} (BEAT ${b.beatId}) not sent after ${attempts} attempts (${code})`, b.beatId)
        return 'gave_up'
      }
      // A batch that was broadcast before may still be pending somewhere, so it stays open and keeps its nonce: it's
      // reported once at the max, keeps being rebroadcast (backoff capped), and settles by a receipt or the nonce check
      if (attempts === BEAT_SEND_MAX_ATTEMPTS) {
        fail(`beat_${b.kind}`, `BEAT ${b.kind} batch ${b.id} (BEAT ${b.beatId}) not rebroadcast after ${attempts} attempts (${code}); it stays open at nonce ${b.nonce}`, b.beatId)
      }
      const wait = 2 ** Math.min(attempts, BEAT_SEND_MAX_ATTEMPTS) * 60_000
      await db.update(beatMintBatches).set({
        attempts, lastError: code, nextAttemptAt: new Date(now.getTime() + wait),
      }).where(eq(beatMintBatches.id, b.id))
      console.warn(`[beats] batch ${b.id} broadcast failed (${code}), attempt ${attempts}`)
      return 'retry'
    }
  }
  // Accepted: a fresh failure budget for any later rebroadcast or reprice
  await db.update(beatMintBatches).set({ status: 'sent', sentAt: now, attempts: 0, nextAttemptAt: null, ...(code ? { lastError: code } : {}) })
    .where(eq(beatMintBatches.id, b.id))
  return 'sent'
}

/** Re-signs the same nonce with fees raised by BEAT_FEE_BUMP_PERCENT (and at least the node's), keeping the gas limit. */
async function reprice(client: BeatChainClient, b: Batch, now: Date, r: BeatTickResult): Promise<'sent' | 'retry' | 'gave_up'> {
  const old = Transaction.from(b.rawTx!)
  const call = decodeCall(old.data)
  const bump = (x: bigint) => (x * BigInt(100 + BEAT_FEE_BUMP_PERCENT) + 99n) / 100n
  const max = (a: bigint, c: bigint) => (a > c ? a : c)
  const node = await client.sign(call, b.nonce, undefined, old.gasLimit)
  const tip = max(bump(old.maxPriorityFeePerGas ?? 0n), node.fees.maxPriorityFeePerGas)
  const maxFee = max(max(bump(old.maxFeePerGas ?? 0n), node.fees.maxFeePerGas), tip)
  const signed: BeatSigned = tip === node.fees.maxPriorityFeePerGas && maxFee === node.fees.maxFeePerGas
    ? node
    : await client.sign(call, b.nonce, { maxFeePerGas: maxFee, maxPriorityFeePerGas: tip }, old.gasLimit)
  // Recorded before the broadcast, so a crash after it never loses the hash
  const [next] = await db.update(beatMintBatches).set({
    rawTx: signed.raw, txHash: signed.hash, txHashes: sql`array_append(${beatMintBatches.txHashes}, ${signed.hash})`,
    status: 'sending', nextAttemptAt: null,
  }).where(eq(beatMintBatches.id, b.id)).returning()
  console.log(`[beats] batch ${b.id} repriced at nonce ${b.nonce}`)
  return broadcastBatch(client, next, signed.raw, now, r)
}

/** A receipt with enough confirmations: the batch is confirmed and its claims minted, or skipped by the contract. */
async function confirmBatch(client: BeatChainClient, b: Batch, hash: string, logs: BeatLog[], now: Date, r: BeatTickResult): Promise<void> {
  let minted = 0
  let skipped = 0
  await db.transaction(async (tx) => {
    await tx.update(beatMintBatches).set({ status: 'confirmed', txHash: hash, confirmedAt: now }).where(eq(beatMintBatches.id, b.id))
    if (!b.beatId) return
    if (b.kind === 'create') {
      await tx.update(beats).set({ createdOnChainTx: hash, createdOnChainAt: now }).where(eq(beats.id, b.beatId))
      return
    }
    if (b.kind === 'close') {
      await tx.update(beats).set({ closedOnChainAt: now }).where(eq(beats.id, b.beatId))
      return
    }
    await lockBeat(tx, b.beatId)
    const rejected = new Set(client.skippedIn(logs).map(lc))
    const rows = await tx.select({ id: beatClaims.id, wallet: beatClaims.wallet }).from(beatClaims)
      .where(and(eq(beatClaims.batchId, b.id), eq(beatClaims.status, 'minting')))
    const skip = rows.filter((c) => rejected.has(lc(c.wallet))).map((c) => c.id)
    const ok = rows.filter((c) => !rejected.has(lc(c.wallet))).map((c) => c.id)
    if (skip.length) await tx.update(beatClaims).set({ status: 'failed', failReason: 'receiver_rejected' }).where(inArray(beatClaims.id, skip))
    if (ok.length) {
      await tx.update(beatClaims).set({ status: 'minted', mintTx: hash, mintedAt: now, failReason: null }).where(inArray(beatClaims.id, ok))
      await freeze(tx, b.beatId, now)
    }
    await settleDeletes(tx, b.id)
    minted = ok.length
    skipped = skip.length
  })
  r.confirmed++
  r.failed += skipped
  console.log(`[beats] batch ${b.id} (${b.kind}, BEAT ${b.beatId}) confirmed${b.kind === 'mint' ? `: ${minted} minted, ${skipped} skipped` : ''}`)
}

/**
 * A receipt that reverted. The receipt doesn't say why, so:
 * - a mint of several wallets goes back to `claimed` and the BEAT's next batches take at most half as many (ruling 4:
 *   InsufficientGas splits; any other cause is found by the smaller batch's estimate);
 * - a mint of one wallet fails that claim, with the reason a fresh estimate gives (or 'reverted');
 * - a create whose id now exists on chain was beaten to it: the chain pauses with id_conflict;
 * - anything else is failed and reported, and the next tick tries again.
 */
async function revertedBatch(client: BeatChainClient, b: Batch, now: Date, r: BeatTickResult): Promise<void> {
  const wallets = b.wallets ?? []
  if (b.kind === 'mint' && b.beatId && wallets.length > 1) {
    const half = Math.max(1, Math.floor(wallets.length / 2))
    maxBatch.set(b.beatId, Math.min(half, maxBatch.get(b.beatId) ?? BEAT_MAX_BATCH))
    await db.transaction(async (tx) => {
      await tx.update(beatMintBatches).set({ status: 'failed', lastError: 'reverted' }).where(eq(beatMintBatches.id, b.id))
      await tx.update(beatClaims).set({ status: 'claimed' }).where(and(eq(beatClaims.batchId, b.id), eq(beatClaims.status, 'minting')))
      await settleDeletes(tx, b.id)
    })
    console.warn(`[beats] batch ${b.id} (BEAT ${b.beatId}) reverted; ${wallets.length} claims retry in batches of ${half}`)
    r.failed++
    return
  }
  if (b.kind === 'mint') {
    let reason = 'reverted'
    try {
      await client.estimate(decodeCall(Transaction.from(b.rawTx!).data))
    } catch (err) {
      if (err instanceof BeatRevert) reason = err.name
    }
    await db.transaction(async (tx) => {
      await tx.update(beatMintBatches).set({ status: 'failed', lastError: `reverted:${reason}` }).where(eq(beatMintBatches.id, b.id))
      await tx.update(beatClaims).set({ status: 'failed', failReason: reason }).where(and(eq(beatClaims.batchId, b.id), eq(beatClaims.status, 'minting')))
      await settleDeletes(tx, b.id)
    })
    console.warn(`[beats] batch ${b.id} (BEAT ${b.beatId}) reverted (${reason}); its claim failed`)
    r.failed += 2 // the batch and its claim
    return
  }
  await db.update(beatMintBatches).set({ status: 'failed', lastError: 'reverted' }).where(eq(beatMintBatches.id, b.id))
  r.failed++
  if (b.kind === 'create' && (await client.exists(BigInt(b.tokenId)))) {
    pauses.set(b.chain, 'id_conflict')
    fail('beat_create', `BEAT ${b.beatId} create reverted: token id ${b.tokenId} on ${b.chain} already exists. Minting is paused.`, b.beatId)
    return
  }
  fail(`beat_${b.kind}`, `BEAT ${b.kind} batch ${b.id} (BEAT ${b.beatId}) reverted on chain`, b.beatId)
}

/**
 * A batch that will never get a receipt of ours: its nonce was used by another transaction (`replaced`), or it was
 * never sent (`unsent:*`). The chain says what happened: each wallet's isMinted (minted ones are marked minted, the rest
 * go to `unminted`), the id's existence for a create.
 */
async function unminedBatch(
  client: BeatChainClient, b: Batch, now: Date, r: BeatTickResult, o: { lastError: string; unminted: 'claimed' | 'failed' },
): Promise<void> {
  const tokenId = BigInt(b.tokenId)
  if (b.kind === 'mint' && b.beatId) {
    const beatId = b.beatId
    const rows = await db.select({ id: beatClaims.id, wallet: beatClaims.wallet }).from(beatClaims)
      .where(and(eq(beatClaims.batchId, b.id), eq(beatClaims.status, 'minting')))
    const done: string[] = []
    const rest: string[] = []
    for (const c of rows) (await client.isMinted(tokenId, c.wallet) ? done : rest).push(c.id)
    await db.transaction(async (tx) => {
      await tx.update(beatMintBatches).set({ status: 'failed', lastError: o.lastError }).where(eq(beatMintBatches.id, b.id))
      if (done.length) {
        await lockBeat(tx, beatId)
        await tx.update(beatClaims).set({ status: 'minted', mintedAt: now, failReason: null }).where(inArray(beatClaims.id, done))
        await freeze(tx, beatId, now)
      }
      if (rest.length) {
        await tx.update(beatClaims).set(o.unminted === 'failed' ? { status: 'failed', failReason: 'send_failed' } : { status: 'claimed' })
          .where(inArray(beatClaims.id, rest))
      }
      await settleDeletes(tx, b.id)
    })
    r.failed++
    if (o.unminted === 'failed') r.failed += rest.length
    console.warn(`[beats] batch ${b.id} (BEAT ${beatId}) ${o.lastError}: ${done.length} minted, ${rest.length} ${o.unminted}`)
    return
  }
  // Only a replaced nonce can have carried our create; an unsent one never left us, so an existing id there is someone
  // else's and the next create's estimate reports it as a conflict
  const created = b.kind === 'create' && b.beatId && o.lastError === 'replaced' ? await client.exists(tokenId) : false
  await db.transaction(async (tx) => {
    await tx.update(beatMintBatches).set({ status: 'failed', lastError: o.lastError }).where(eq(beatMintBatches.id, b.id))
    // Our create landed under a hash whose receipt we can't see: the newest one we signed stands for it
    if (created) await tx.update(beats).set({ createdOnChainTx: b.txHashes.at(-1) ?? b.txHash, createdOnChainAt: now }).where(eq(beats.id, b.beatId!))
  })
  r.failed++
  console.warn(`[beats] batch ${b.id} (${b.kind}, BEAT ${b.beatId}) ${o.lastError}${created ? '; the BEAT exists on chain' : ''}`)
}

// ── Sending the next transaction ─────────────────────────────────────────────

type Plan =
  | { kind: 'create'; beatId: string; call: BeatCall; codeCount: 0 }
  | { kind: 'close'; beatId: string; call: BeatCall; codeCount: 0 }
  | { kind: 'mint'; beatId: string; call: BeatCall & { kind: 'mint' }; claimIds: string[]; codeCount: number; single: boolean }

/** How many tries a tick makes at finding something that estimates; a failed estimate costs nothing on chain. */
const PLANS_PER_TICK = 50
/** How many plans found stale at insert (a claim locked by delete-my-data, say) a tick re-plans before it ends. */
const STALE_PLANS_PER_TICK = 3

async function sendNext(client: BeatChainClient, now: Date, r: BeatTickResult, balance: bigint): Promise<void> {
  const skip = new Set<string>()
  let stale = 0
  for (let i = 0; i < PLANS_PER_TICK; i++) {
    const plan = await nextPlan(client, skip, now)
    if (!plan) return
    const out = await trySend(client, plan, skip, now, r, balance)
    if (out === 'stop') return
    if (out === 'stale' && ++stale >= STALE_PLANS_PER_TICK) return
  }
}

/** The claims that keep a BEAT from being closed: pending ones, and failed ones an admin's retry could still mint. */
const holdsClose = sql`exists (select 1 from beat_claims c where c.beat_id = ${beats.id} and (c.status in ('claimed', 'minting')
  or (c.status = 'failed' and coalesce(c.fail_reason, '') not in (${sql.join(BEAT_FINAL_FAIL_REASONS.map((x) => sql`${x}`), sql`, `)}))))`

/**
 * Priority:
 * (a) a create for the oldest BEAT not yet on chain that is paid or live, or ended with claims still to mint or still
 *     inside its claim grace (one that ended before its create could go out, say while the minter was out of gas);
 * (b) a mint for the BEAT with the oldest claimed claim;
 * (c) a close for an ended BEAT past its grace with no claim pending or retryable (BEAT_FINAL_FAIL_REASONS);
 * (d) a close for a cancelled BEAT that exists on chain, so nothing can be minted into it.
 */
async function nextPlan(client: BeatChainClient, skip: Set<string>, now: Date): Promise<Plan | null> {
  const chain = client.chain
  const notSkipped = (col: typeof beats.id) => (skip.size ? notInArray(col, [...skip]) : undefined)

  const [create] = await db.select({ id: beats.id, tokenId: beats.tokenId, tradeable: beats.tradeable }).from(beats)
    .innerJoin(beatPayments, eq(beatPayments.id, beats.paymentId))
    .where(and(
      eq(beats.chain, chain), isNull(beats.createdOnChainTx), isNotNull(beats.tokenId),
      or(
        inArray(beats.status, ['paid', 'live']),
        and(eq(beats.status, 'ended'), or(
          gt(beats.endsAt, new Date(now.getTime() - BEAT_CLAIM_GRACE_MS)),
          sql`exists (select 1 from beat_claims c where c.beat_id = ${beats.id} and c.status in ('claimed', 'minting', 'failed'))`,
        )),
      ),
      eq(beatPayments.status, 'paid'), notSkipped(beats.id),
    )).orderBy(asc(beats.createdAt)).limit(1)
  if (create) return { kind: 'create', beatId: create.id, codeCount: 0, call: { kind: 'create', tokenId: BigInt(create.tokenId!), tradeable: create.tradeable } }

  const [oldest] = await db.select({ beatId: beatClaims.beatId, tokenId: beats.tokenId }).from(beatClaims)
    .innerJoin(beats, eq(beats.id, beatClaims.beatId))
    .where(and(
      eq(beats.chain, chain), inArray(beats.status, ['live', 'ended']), isNotNull(beats.createdOnChainTx), isNull(beats.closedOnChainAt),
      eq(beatClaims.status, 'claimed'), notSkipped(beats.id),
    )).orderBy(asc(beatClaims.claimedAt), asc(beatClaims.id)).limit(1)
  if (oldest) return mintPlan(client, oldest.beatId, BigInt(oldest.tokenId!))

  const [close] = await db.select({ id: beats.id, tokenId: beats.tokenId }).from(beats)
    .where(and(
      eq(beats.chain, chain), eq(beats.status, 'ended'), lte(beats.endsAt, new Date(now.getTime() - BEAT_CLAIM_GRACE_MS)),
      isNotNull(beats.createdOnChainTx), isNull(beats.closedOnChainAt), notSkipped(beats.id), sql`not ${holdsClose}`,
    )).orderBy(asc(beats.endsAt)).limit(1)
  if (close) return { kind: 'close', beatId: close.id, codeCount: 0, call: { kind: 'close', tokenId: BigInt(close.tokenId!) } }

  // Nothing is minted into a cancelled BEAT, so its claims don't hold it open
  const [cancelled] = await db.select({ id: beats.id, tokenId: beats.tokenId }).from(beats)
    .where(and(
      eq(beats.chain, chain), eq(beats.status, 'cancelled'), isNotNull(beats.createdOnChainTx), isNull(beats.closedOnChainAt),
      isNotNull(beats.tokenId), notSkipped(beats.id),
    )).orderBy(asc(beats.updatedAt)).limit(1)
  if (cancelled) return { kind: 'close', beatId: cancelled.id, codeCount: 0, call: { kind: 'close', tokenId: BigInt(cancelled.tokenId!) } }
  return null
}

/**
 * Up to 200 claimed claims (or the BEAT's ruling-4 cap) in claim order. Wallets flagged by ruling 5 go first, one at a
 * time. Otherwise the plain wallets (no code) go together, and only when there are none does the first wallet with code
 * go, alone (Review Focus 1: a receiver hook can't take a batch down with it).
 */
async function mintPlan(client: BeatChainClient, beatId: string, tokenId: bigint): Promise<Plan | null> {
  const flagged = singles.get(beatId)
  if (flagged?.size) {
    const rows = await db.select({ id: beatClaims.id, wallet: beatClaims.wallet }).from(beatClaims)
      .where(and(eq(beatClaims.beatId, beatId), eq(beatClaims.status, 'claimed'), inArray(sql`lower(${beatClaims.wallet})`, [...flagged])))
      .orderBy(asc(beatClaims.claimedAt), asc(beatClaims.id)).limit(1)
    if (rows.length) {
      const c = rows[0]
      flagged.delete(lc(c.wallet))
      return {
        kind: 'mint', beatId, single: true, claimIds: [c.id], codeCount: (await client.codeAt(c.wallet)) ? 1 : 0,
        call: { kind: 'mint', tokenId, wallets: [c.wallet] },
      }
    }
    singles.delete(beatId)
  }
  const limit = Math.min(BEAT_MAX_BATCH, maxBatch.get(beatId) ?? BEAT_MAX_BATCH)
  const rows = await db.select({ id: beatClaims.id, wallet: beatClaims.wallet }).from(beatClaims)
    .where(and(eq(beatClaims.beatId, beatId), eq(beatClaims.status, 'claimed')))
    .orderBy(asc(beatClaims.claimedAt), asc(beatClaims.id)).limit(limit)
  if (!rows.length) return null
  const code: boolean[] = []
  for (let i = 0; i < rows.length; i += 20) code.push(...await Promise.all(rows.slice(i, i + 20).map((c) => client.codeAt(c.wallet))))
  const plain = rows.filter((_, i) => !code[i])
  const pick = plain.length ? plain : [rows[0]]
  return {
    kind: 'mint', beatId, single: pick.length === 1, claimIds: pick.map((c) => c.id), codeCount: plain.length ? 0 : 1,
    call: { kind: 'mint', tokenId, wallets: pick.map((c) => c.wallet) },
  }
}

/**
 * Estimates, signs, records and broadcasts one plan. 'stop' once a transaction is open (or the chain paused); 'stale'
 * when the plan's BEAT or claims changed before it was recorded. A batch the balance can't pay for (gas limit × max fee)
 * is never recorded or sent: the chain pauses for low gas and its claims stay claimed.
 */
async function trySend(
  client: BeatChainClient, plan: Plan, skip: Set<string>, now: Date, r: BeatTickResult, balance: bigint,
): Promise<'stop' | 'next' | 'stale'> {
  let estimate: bigint
  try {
    estimate = await client.estimate(plan.call)
  } catch (err) {
    if (noFunds(err)) { shortOf(client.chain); return 'stop' }
    if (!(err instanceof BeatRevert)) throw err
    return estimateReverted(client, plan, err.name, skip, now, r)
  }
  const gasLimit = (estimate + BEAT_RECEIVER_GAS * BigInt(plan.codeCount)) * 110n / 100n
  const nonce = await nextNonce(client)
  let signed: BeatSigned
  try {
    signed = await client.sign(plan.call, nonce, undefined, gasLimit)
  } catch (err) {
    if (noFunds(err)) { shortOf(client.chain); return 'stop' }
    throw err
  }
  noteCost(client.chain, plan.kind, signed.gasLimit, signed.fees.maxFeePerGas, plan.kind === 'mint' ? plan.call.wallets.length : 0)
  // Signing only fixes the fees; nothing has been recorded or sent, so stopping here costs nothing
  if (balance < signed.gasLimit * signed.fees.maxFeePerGas) {
    shortOf(client.chain)
    console.warn(`[beats] ${client.chain} minter can't pay for the next ${plan.kind} batch; paused for low gas`)
    return 'stop'
  }
  await beatJobTestHooks.beforeInsert?.({ kind: plan.kind, beatId: plan.beatId })
  const batch = await insertBatch(client.chain, plan, signed, nonce, now)
  if (!batch) {
    // The BEAT or its claims changed since they were read: read again. A create that's no longer due is skipped; a
    // close isn't, since what held it (a retried claim, say) is planned ahead of it
    if (plan.kind === 'create') skip.add(plan.beatId)
    return 'stale'
  }
  await beatJobTestHooks.afterInsert?.(batch.id)
  const sent = await broadcastBatch(client, batch, signed.raw, now, r)
  if (sent === 'sent') r.sent++
  const count = plan.kind === 'mint' ? `, ${plan.claimIds.length} claims` : ''
  console.log(`[beats] batch ${batch.id} (${plan.kind}, BEAT ${plan.beatId}${count}) at nonce ${nonce}: ${sent}`)
  return 'stop'
}

async function estimateReverted(
  client: BeatChainClient, plan: Plan, name: string, skip: Set<string>, now: Date, r: BeatTickResult,
): Promise<'stop' | 'next'> {
  if (plan.kind === 'create') {
    if (name === 'BeatExists') {
      // Ours when an earlier create of ours for this BEAT went out (its receipt was lost); anyone else's is a conflict
      // Only a batch whose nonce could have carried our create counts: confirmed, sent, or replaced (never unsent or
      // reverted on chain)
      const [mine] = await db.select().from(beatMintBatches)
        .where(and(
          eq(beatMintBatches.beatId, plan.beatId), eq(beatMintBatches.kind, 'create'),
          sql`(${beatMintBatches.status} in ('confirmed', 'sent') or (${beatMintBatches.status} = 'failed' and ${beatMintBatches.lastError} = 'replaced'))`,
        )).orderBy(asc(beatMintBatches.createdAt)).limit(1)
      if (mine) {
        await db.update(beats).set({ createdOnChainTx: mine.status === 'confirmed' ? mine.txHash ?? mine.txHashes.at(-1) : mine.txHashes.at(-1) ?? mine.txHash, createdOnChainAt: now }).where(eq(beats.id, plan.beatId))
        console.warn(`[beats] BEAT ${plan.beatId} already exists on chain from batch ${mine.id}`)
        return 'next'
      }
      pauses.set(client.chain, 'id_conflict')
      fail('beat_create', `BEAT ${plan.beatId}: token id ${plan.call.tokenId} on ${client.chain} already exists. Minting is paused.`, plan.beatId)
      return 'stop'
    }
    skip.add(plan.beatId)
    if (!reportedCreateRevert.has(plan.beatId)) {
      reportedCreateRevert.add(plan.beatId)
      fail('beat_create', `BEAT ${plan.beatId} create estimate reverted (${name})`, plan.beatId)
    } else console.warn(`[beats] BEAT ${plan.beatId} create estimate reverted (${name})`)
    return 'next'
  }
  if (plan.kind === 'close') {
    skip.add(plan.beatId)
    if (name === 'BeatClosedError') {
      await db.update(beats).set({ closedOnChainAt: now }).where(eq(beats.id, plan.beatId))
      return 'next'
    }
    fail('beat_close', `BEAT ${plan.beatId} close estimate reverted (${name})`, plan.beatId)
    return 'next'
  }
  if (plan.single) {
    await db.update(beatClaims).set({ status: 'failed', failReason: name })
      .where(and(eq(beatClaims.id, plan.claimIds[0]), eq(beatClaims.status, 'claimed')))
    r.failed++
    console.warn(`[beats] BEAT ${plan.beatId}: a claim failed at estimate (${name})`)
    return 'next'
  }
  // Ruling 5: one of these wallets makes the batch revert; send them one at a time to find it
  const set = singles.get(plan.beatId) ?? new Set<string>()
  for (const w of plan.call.wallets) set.add(lc(w))
  singles.set(plan.beatId, set)
  console.warn(`[beats] BEAT ${plan.beatId}: a batch of ${plan.call.wallets.length} failed at estimate (${name}); sending them one at a time`)
  return 'next'
}

/** max(the chain's pending nonce, the last used nonce + 1). A batch that gave up unsent never used its nonce. */
async function nextNonce(client: BeatChainClient): Promise<number> {
  const pending = await client.nonce('pending')
  const [row] = await db.select({ n: sql<string | null>`max(${beatMintBatches.nonce})::text` }).from(beatMintBatches).where(and(
    eq(beatMintBatches.chain, client.chain),
    sql`not (${beatMintBatches.status} = 'failed' and coalesce(${beatMintBatches.lastError}, '') like 'unsent:%')`,
  ))
  const last = row?.n == null ? -1 : Number(row.n)
  return Math.max(pending, last + 1)
}

/**
 * Records the batch (`sending`, with its signed raw tx and hash) and sets its claims `minting`, in one transaction,
 * before anything is broadcast. Null when the plan is stale: a claim is no longer claimed (or is locked by a delete), a
 * create's BEAT is no longer due (taken under the BEAT's lock, so it serialises with cancel), or a close is now held by
 * a claim (under the BEAT's lock, so it serialises with retryFailedClaims).
 */
async function insertBatch(chain: BeatChain, plan: Plan, signed: BeatSigned, nonce: number, now: Date): Promise<Batch | null> {
  return db.transaction(async (tx) => {
    if (plan.kind === 'create') {
      await lockBeat(tx, plan.beatId)
      const [row] = await tx.select({ status: beats.status, created: beats.createdOnChainTx, pay: beatPayments.status }).from(beats)
        .leftJoin(beatPayments, eq(beatPayments.id, beats.paymentId)).where(eq(beats.id, plan.beatId))
      // An ended BEAT may still be created (its claims wait on it); the plan checked it still has claims or grace left
      if (!row || !(row.status === 'paid' || row.status === 'live' || row.status === 'ended') || row.created || row.pay !== 'paid') return null
    }
    if (plan.kind === 'close') {
      // Under the BEAT's lock, as retryFailedClaims: a retry that landed after the plan was read holds the close
      await lockBeat(tx, plan.beatId)
      const [held] = await tx.select({ id: beats.id }).from(beats).where(and(eq(beats.id, plan.beatId), holdsClose))
      if (held) return null
    }
    if (plan.kind === 'mint') {
      const got = await tx.select({ id: beatClaims.id }).from(beatClaims)
        .where(and(inArray(beatClaims.id, plan.claimIds), eq(beatClaims.status, 'claimed'))).for('update', { skipLocked: true })
      if (got.length !== plan.claimIds.length) return null
    }
    // A batch that gave up unsent may hold this nonce; the chain never saw it, so the new one takes its place
    await tx.delete(beatMintBatches).where(and(eq(beatMintBatches.chain, chain), eq(beatMintBatches.nonce, nonce), eq(beatMintBatches.status, 'failed')))
    const [batch] = await tx.insert(beatMintBatches).values({
      chain, kind: plan.kind, beatId: plan.beatId, tokenId: Number(plan.call.tokenId),
      wallets: plan.kind === 'mint' ? plan.call.wallets : null,
      nonce, txHash: signed.hash, rawTx: signed.raw, txHashes: [signed.hash], status: 'sending', createdAt: now,
    }).returning()
    if (plan.kind === 'mint') {
      await tx.update(beatClaims).set({ status: 'minting', batchId: batch.id, failReason: null }).where(inArray(beatClaims.id, plan.claimIds))
    }
    return batch
  })
}

// ── Admin and start-up ───────────────────────────────────────────────────────

/**
 * The admin's retry: failed claims (of one BEAT, or all) go back to `claimed` without their fail reason. Claims of a
 * BEAT already closed on chain (or whose close is in flight) can never be minted, so they stay failed and are counted
 * in `skippedClosed`.
 */
export async function retryFailedClaims(beatId?: string): Promise<{ retried: number; skippedClosed: number }> {
  // Given-up claims stay failed: the admin chose to let the BEAT close without them
  const notGivenUp = sql`coalesce(${beatClaims.failReason}, '') <> ${BEAT_GIVEN_UP}`
  const scope = (id: string) => and(eq(beatClaims.status, 'failed'), eq(beatClaims.beatId, id), notGivenUp)
  const ids = await db.selectDistinct({ id: beatClaims.beatId }).from(beatClaims)
    .where(and(eq(beatClaims.status, 'failed'), notGivenUp, beatId ? eq(beatClaims.beatId, beatId) : undefined))
  let retried = 0
  let skippedClosed = 0
  for (const { id } of ids) {
    // Under the BEAT's lock, as a close's insert: either the close is recorded first (and this sees it in flight), or
    // these claims are back to claimed first (and the close's insert sees them and waits)
    await db.transaction(async (tx) => {
      await lockBeat(tx, id)
      const [shut] = await tx.select({ id: beats.id }).from(beats).where(and(eq(beats.id, id), or(
        isNotNull(beats.closedOnChainAt),
        sql`exists (select 1 from beat_mint_batches m where m.beat_id = ${beats.id} and m.kind = 'close' and m.status in ('sending', 'sent'))`,
      )))
      if (shut) {
        const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(beatClaims).where(scope(id))
        skippedClosed += n?.n ?? 0
        return
      }
      const rows = await tx.update(beatClaims).set({ status: 'claimed', failReason: null }).where(scope(id)).returning({ id: beatClaims.id })
      retried += rows.length
    })
  }
  return { retried, skippedClosed }
}

/**
 * The admin's give-up: an ended BEAT past its claim grace that is held open by claims failed for a retryable reason gets
 * those claims marked `given_up` (final), so the next tick closes it. Under the BEAT's lock, as retry and a close's
 * insert. 404 for an unknown BEAT, 409 `too_early` unless it has ended and its grace is over.
 */
export async function giveUpFailedClaims(beatId: string, now: Date): Promise<{ givenUp: number }> {
  return db.transaction(async (tx) => {
    await lockBeat(tx, beatId)
    const [row] = await tx.select({ status: beats.status, endsAt: beats.endsAt }).from(beats).where(eq(beats.id, beatId))
    if (!row) throw new BeatError(404, 'not_found', 'BEAT not found.')
    if (row.status !== 'ended' || row.endsAt.getTime() + BEAT_CLAIM_GRACE_MS > now.getTime()) {
      throw new BeatError(409, 'too_early', 'Only a BEAT that ended and is past its claim grace can be closed this way.')
    }
    const rows = await tx.update(beatClaims).set({ failReason: BEAT_GIVEN_UP })
      .where(and(eq(beatClaims.beatId, beatId), retryableFailed)).returning({ id: beatClaims.id })
    console.log(`[beats] BEAT ${beatId}: an admin gave up on ${rows.length} failed claims`)
    return { givenUp: rows.length }
  })
}

/** Runs the tick every BEAT_JOB_EVERY_MS (the first 30 s after boot). Returns a stopper. */
export function startBeatJobs(): () => void {
  let running = false
  const run = async () => {
    if (running) return
    running = true
    try {
      await runBeatTick(new Date())
    } catch (err) {
      console.error('[beats] minting tick failed:', safeErr(err))
    } finally {
      running = false
    }
  }
  const every = setInterval(run, BEAT_JOB_EVERY_MS)
  every.unref()
  const first = setTimeout(run, 30_000)
  first.unref()
  return () => { clearInterval(every); clearTimeout(first) }
}
