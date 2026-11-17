import { ZeroAddress, type JsonRpcProvider } from 'ethers'
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm'
import { BEAT_CHAIN_INFO, type BeatChain } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { beatHoldings, beatIndexCursors, beats } from '../db/schema.js'
import { beatInterface } from './chain.js'

/**
 * Who holds each BEAT (LIV-185): beat_holdings is built from the BEAT contract's ERC-1155 transfer logs, read in
 * chunks up to the chain's confirmations behind the head, so a reorg never needs undoing. Wallets and contracts are
 * stored lower case; the zero address is never a holder, and a balance of 0 has no row.
 */

export type BeatTransfer = { contract: string; tokenId: bigint; from: string; to: string; value: bigint; blockNumber: number }

export interface BeatLogReader {
  latestBlock(): Promise<number>
  transfers(contract: string, fromBlock: number, toBlock: number): Promise<BeatTransfer[]>
  /** The block a transaction is in, or null when it isn't found. */
  txBlock(hash: string): Promise<number | null>
}

export const INDEX_CHUNK_BLOCKS = 2000
const MAX_CHUNKS_PER_RUN = 20

const SINGLE_TOPIC = beatInterface.getEvent('TransferSingle')!.topicHash
const BATCH_TOPIC = beatInterface.getEvent('TransferBatch')!.topicHash

export function rpcLogReader(provider: JsonRpcProvider): BeatLogReader {
  return {
    latestBlock: () => provider.getBlockNumber(),
    async txBlock(hash) {
      return (await provider.getTransactionReceipt(hash))?.blockNumber ?? null
    },
    async transfers(contract, fromBlock, toBlock) {
      const logs = await provider.getLogs({ address: contract, fromBlock, toBlock, topics: [[SINGLE_TOPIC, BATCH_TOPIC]] })
      const out: BeatTransfer[] = []
      for (const log of logs) {
        const parsed = beatInterface.parseLog({ topics: [...log.topics], data: log.data })
        if (!parsed) continue
        const base = { contract: log.address.toLowerCase(), from: String(parsed.args.from), to: String(parsed.args.to), blockNumber: log.blockNumber }
        if (parsed.name === 'TransferSingle') {
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

async function applyIn(tx: Tx, chain: BeatChain, transfers: BeatTransfer[]): Promise<void> {
  for (const t of transfers) {
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
export async function applyTransfers(chain: BeatChain, transfers: BeatTransfer[]): Promise<void> {
  await db.transaction((tx) => applyIn(tx, chain, transfers))
}

/**
 * Brings beat_holdings up to the chain's head minus its confirmations, for every contract that has a BEAT created on
 * chain. A contract's first run starts at the block of its earliest create transaction (skipped this round when that
 * block can't be found, never read from block 0). Each chunk and its cursor move are one transaction.
 */
export async function indexBeatHoldings(chain: BeatChain, reader: BeatLogReader): Promise<{ contracts: number; transfers: number; toBlock: number | null }> {
  const contractExpr = sql<string>`lower(${beats.contractAddress})`
  const contracts = (await db.selectDistinct({ contract: contractExpr })
    .from(beats)
    .where(and(eq(beats.chain, chain), isNotNull(beats.tokenId), isNotNull(beats.contractAddress)))).map((r) => r.contract)
  if (contracts.length === 0) return { contracts: 0, transfers: 0, toBlock: null }

  const safeHead = (await reader.latestBlock()) - BEAT_CHAIN_INFO[chain].confirmations
  let indexed = 0
  let total = 0
  let lastTo: number | null = null

  for (const contract of contracts) {
    const [cursor] = await db.select().from(beatIndexCursors).where(and(eq(beatIndexCursors.chain, chain), eq(beatIndexCursors.contract, contract)))
    let last: number
    if (cursor) {
      last = cursor.lastBlock
    } else {
      const [first] = await db.select({ tx: beats.createdOnChainTx }).from(beats)
        .where(and(eq(beats.chain, chain), isNotNull(beats.tokenId), isNotNull(beats.createdOnChainTx), sql`lower(${beats.contractAddress}) = ${contract}`))
        .orderBy(asc(beats.createdAt)).limit(1)
      const block = first?.tx ? await reader.txBlock(first.tx) : null
      if (block === null) continue
      last = block - 1
    }
    indexed++
    for (let chunk = 0; chunk < MAX_CHUNKS_PER_RUN; chunk++) {
      const toBlock = Math.min(last + INDEX_CHUNK_BLOCKS, safeHead)
      if (toBlock <= last) break
      const transfers = await reader.transfers(contract, last + 1, toBlock)
      await db.transaction(async (tx) => {
        await applyIn(tx, chain, transfers)
        await tx.insert(beatIndexCursors).values({ chain, contract, lastBlock: toBlock })
          .onConflictDoUpdate({ target: [beatIndexCursors.chain, beatIndexCursors.contract], set: { lastBlock: toBlock, updatedAt: sql`now()` } })
      })
      total += transfers.length
      last = toBlock
      lastTo = lastTo === null ? toBlock : Math.max(lastTo, toBlock)
    }
  }
  return { contracts: indexed, transfers: total, toBlock: lastTo }
}
