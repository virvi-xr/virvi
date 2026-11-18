import { ZeroAddress, type JsonRpcProvider } from 'ethers'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { BEAT_CHAIN_INFO, type BeatChain } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { beatHoldings, beatIndexCursors, beats } from '../db/schema.js'
import { BEAT_REISSUED_TOPIC, beatInterface } from './chain.js'
import { isRangeRefused, smallerRange } from '../services/log-ranges.js'

/**
 * Who holds each BEAT (LIV-185): beat_holdings is built from the BEAT contract's ERC-1155 transfer logs, read in
 * chunks up to the chain's confirmations behind the head, so a reorg never needs undoing. Wallets and contracts are
 * stored lower case; the zero address is never a holder, and a balance of 0 has no row.
 */

export type BeatTransfer = { contract: string; tokenId: bigint; from: string; to: string; value: bigint; blockNumber: number }

/** A `Reissued` log: the contract keeps the old wallet's balance, so the old wallet's row is marked as replaced. */
export type BeatReissue = { kind: 'reissue'; contract: string; tokenId: bigint; from: string; to: string; blockNumber: number }
export type BeatEvent = BeatTransfer | BeatReissue

export interface BeatLogReader {
  latestBlock(): Promise<number>
  /** Transfers and reissues, in block and log order. */
  transfers(contract: string, fromBlock: number, toBlock: number): Promise<BeatEvent[]>
  /** The block a transaction is in, or null when it isn't found. */
  txBlock(hash: string): Promise<number | null>
}

export const INDEX_CHUNK_BLOCKS = 2000
export const MAX_CHUNKS_PER_RUN = 20

const SINGLE_TOPIC = beatInterface.getEvent('TransferSingle')!.topicHash
const BATCH_TOPIC = beatInterface.getEvent('TransferBatch')!.topicHash

export function rpcLogReader(provider: JsonRpcProvider): BeatLogReader {
  return {
    latestBlock: () => provider.getBlockNumber(),
    async txBlock(hash) {
      return (await provider.getTransactionReceipt(hash))?.blockNumber ?? null
    },
    async transfers(contract, fromBlock, toBlock) {
      const logs = await provider.getLogs({ address: contract, fromBlock, toBlock, topics: [[SINGLE_TOPIC, BATCH_TOPIC, BEAT_REISSUED_TOPIC]] })
      const out: BeatEvent[] = []
      for (const log of logs) {
        const parsed = beatInterface.parseLog({ topics: [...log.topics], data: log.data })
        if (!parsed) continue
        const base = { contract: log.address.toLowerCase(), from: String(parsed.args.from), to: String(parsed.args.to), blockNumber: log.blockNumber }
        if (parsed.name === 'Reissued') {
          out.push({ ...base, kind: 'reissue', tokenId: BigInt(parsed.args.id) })
        } else if (parsed.name === 'TransferSingle') {
          out.push({ ...base, tokenId: BigInt(parsed.args.id), value: BigInt(parsed.args.value) })
        } else if (parsed.name === 'TransferBatch') {
          const ids = parsed.args.ids as bigint[]
          const values = parsed.args[4] as bigint[]
          ids.forEach((id, i) => out.push({ ...base, tokenId: BigInt(id), value: BigInt(values[i]) }))
        }
      }
      return out
    },
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function applyIn(tx: Tx, chain: BeatChain, transfers: BeatEvent[]): Promise<void> {
  for (const t of transfers) {
    if ('kind' in t) {
      await tx.update(beatHoldings).set({ replacedBy: t.to.toLowerCase() })
        .where(and(eq(beatHoldings.chain, chain), eq(beatHoldings.contract, t.contract.toLowerCase()), eq(beatHoldings.tokenId, t.tokenId), eq(beatHoldings.wallet, t.from.toLowerCase())))
      continue
    }
    if (t.value <= 0n) continue
    const contract = t.contract.toLowerCase()
    const from = t.from.toLowerCase()
    const to = t.to.toLowerCase()
    if (from !== ZeroAddress) {
      await tx.update(beatHoldings)
        .set({ balance: sql`${beatHoldings.balance} - ${t.value.toString()}::numeric`, updatedBlock: t.blockNumber })
        .where(and(eq(beatHoldings.chain, chain), eq(beatHoldings.contract, contract), eq(beatHoldings.tokenId, t.tokenId), eq(beatHoldings.wallet, from)))
      await tx.delete(beatHoldings)
        .where(and(eq(beatHoldings.chain, chain), eq(beatHoldings.contract, contract), eq(beatHoldings.tokenId, t.tokenId), eq(beatHoldings.wallet, from), sql`${beatHoldings.balance} <= 0`))
    }
    if (to !== ZeroAddress) {
      await tx.insert(beatHoldings)
        .values({ chain, contract, tokenId: t.tokenId, wallet: to, balance: t.value.toString(), updatedBlock: t.blockNumber })
        .onConflictDoUpdate({
          target: [beatHoldings.chain, beatHoldings.contract, beatHoldings.tokenId, beatHoldings.wallet],
          set: { balance: sql`${beatHoldings.balance} + ${t.value.toString()}::numeric`, updatedBlock: t.blockNumber },
        })
    }
  }
}

/** Applies transfers in order, in one transaction. */
export async function applyTransfers(chain: BeatChain, transfers: BeatEvent[]): Promise<void> {
  await db.transaction((tx) => applyIn(tx, chain, transfers))
}

/**
 * Brings beat_holdings up to the chain's head minus its confirmations, for every contract that has a BEAT created on
 * chain. A contract's first run starts at the earliest block among its BEATs' create transactions (hashes that don't
 * resolve are ignored; skipped this round when none resolve, never read from block 0). Each chunk and its cursor move are one transaction.
 */
export async function indexBeatHoldings(chain: BeatChain, reader: BeatLogReader): Promise<{ contracts: number; transfers: number; toBlock: number | null }> {
  const contractExpr = sql<string>`lower(${beats.contractAddress})`
  const contracts = (await db.selectDistinct({ contract: contractExpr })
    .from(beats)
    .where(and(eq(beats.chain, chain), isNotNull(beats.tokenId), isNotNull(beats.contractAddress)))).map((r) => r.contract)
  if (contracts.length === 0) return { contracts: 0, transfers: 0, toBlock: null }

  const safeHead = (await reader.latestBlock()) - BEAT_CHAIN_INFO[chain].confirmations
  let indexed = 0
  let failed = 0
  let lastErr: unknown = null
  let total = 0
  let lastTo: number | null = null

  for (const contract of contracts) {
    // One contract's failure (a bad create tx, an RPC error on its logs) is logged and leaves the others to run
    try {
      const r = await indexContract(chain, reader, contract, safeHead)
      if (!r) continue
      indexed++
      total += r.transfers
      if (r.toBlock !== null) lastTo = lastTo === null ? r.toBlock : Math.max(lastTo, r.toBlock)
    } catch (err) {
      failed++
      lastErr = err
      console.error(`[beats] ${chain} holdings index failed for ${contract}:`, err instanceof Error ? err.message : err)
    }
  }
  // Every contract failing is an outage, not one bad contract: the sweep should see it, with the real error
  if (failed > 0 && failed === contracts.length) throw lastErr
  return { contracts: indexed, transfers: total, toBlock: lastTo }
}

/** One contract's catch-up; null when it has no resolvable start block yet. */
async function indexContract(chain: BeatChain, reader: BeatLogReader, contract: string, safeHead: number): Promise<{ transfers: number; toBlock: number | null } | null> {
  let total = 0
  let lastTo: number | null = null
  const [cursor] = await db.select().from(beatIndexCursors).where(and(eq(beatIndexCursors.chain, chain), eq(beatIndexCursors.contract, contract)))
  let last: number
  if (cursor) {
    last = cursor.lastBlock
  } else {
    // The on-chain create happens at payment, not at draft, so every BEAT's create block counts: start at the earliest.
    const creates = await db.select({ id: beats.id, tx: beats.createdOnChainTx }).from(beats)
      .where(and(eq(beats.chain, chain), isNotNull(beats.tokenId), isNotNull(beats.createdOnChainTx), sql`lower(${beats.contractAddress}) = ${contract}`))
    let block: number | null = null
    for (const c of creates) {
      const b = c.tx ? await reader.txBlock(c.tx) : null
      if (b === null) {
        console.warn(`[beats] ${chain} create tx for BEAT ${c.id} not found; ignoring it for the start block`)
        continue
      }
      block = block === null ? b : Math.min(block, b)
    }
    if (block === null) return null
    last = block - 1
  }
  // The range that last worked in this run, so a capped provider is asked for 2000 blocks once per run, not per chunk
  let size = INDEX_CHUNK_BLOCKS
  for (let chunk = 0; chunk < MAX_CHUNKS_PER_RUN; chunk++) {
    let toBlock = Math.min(last + size, safeHead)
    if (toBlock <= last) break
    let transfers: BeatEvent[]
    for (;;) {
      try {
        transfers = await reader.transfers(contract, last + 1, toBlock)
        break
      } catch (err) {
        const smaller = smallerRange(size)
        if (smaller === null || !isRangeRefused(err)) throw err
        size = smaller
        toBlock = Math.min(last + size, safeHead)
      }
    }
    // The cursor row is the lock: a run that finds it moved since it read it (another instance applied this chunk) stops.
    const moved = await db.transaction(async (tx) => {
      await tx.insert(beatIndexCursors).values({ chain, contract, lastBlock: last }).onConflictDoNothing()
      const [row] = await tx.select().from(beatIndexCursors)
        .where(and(eq(beatIndexCursors.chain, chain), eq(beatIndexCursors.contract, contract))).for('update')
      if (row.lastBlock !== last) return true
      await applyIn(tx, chain, transfers)
      await tx.update(beatIndexCursors).set({ lastBlock: toBlock, updatedAt: sql`now()` })
        .where(and(eq(beatIndexCursors.chain, chain), eq(beatIndexCursors.contract, contract)))
      return false
    })
    if (moved) break
    total += transfers.length
    last = toBlock
    lastTo = toBlock
  }
  return { transfers: total, toBlock: lastTo }
}
