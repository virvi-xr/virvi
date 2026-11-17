import { describe, it, expect, beforeEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { ZeroAddress, getAddress, type JsonRpcProvider } from 'ethers'
import { beatInterface } from '../src/beats/chain.js'
import { db } from '../src/db/connection.js'
import { beatHoldings, beatIndexCursors, beats } from '../src/db/schema.js'
import { INDEX_CHUNK_BLOCKS, indexBeatHoldings, rpcLogReader, type BeatLogReader, type BeatTransfer } from '../src/beats/holdings.js'
import { resetDb } from './helpers/db.js'

const CONTRACT = '0x00000000000000000000000000000000000c0de1'
const A = '0x00000000000000000000000000000000000000aa'
const B = '0x00000000000000000000000000000000000000bb'

class FakeReader implements BeatLogReader {
  latest = 200
  createBlock: number | null = 100
  all: BeatTransfer[] = []
  calls: { contract: string; fromBlock: number; toBlock: number }[] = []
  async latestBlock() { return this.latest }
  async txBlock() { return this.createBlock }
  async transfers(contract: string, fromBlock: number, toBlock: number) {
    this.calls.push({ contract, fromBlock, toBlock })
    return this.all.filter((t) => t.blockNumber >= fromBlock && t.blockNumber <= toBlock)
  }
}
const tr = (from: string, to: string, blockNumber: number, tokenId = 7n, value = 1n): BeatTransfer => ({ contract: CONTRACT, tokenId, from, to, value, blockNumber })

async function seed(over: Partial<typeof beats.$inferInsert> = {}) {
  await db.insert(beats).values({
    chain: 'polygon', name: 'Night', description: '', tokenId: 7, status: 'live', contractAddress: CONTRACT, createdOnChainTx: '0xabc',
    startsAt: new Date(), endsAt: new Date(Date.now() + 3_600_000), ...over,
  })
}
const held = async (wallet: string, tokenId = 7) => (await db.select().from(beatHoldings)
  .where(and(eq(beatHoldings.wallet, wallet), eq(beatHoldings.tokenId, BigInt(tokenId))))).map((r) => r.balance)

describe('BEAT holdings index (LIV-185)', () => {
  beforeEach(async () => { await resetDb(); await seed() })

  it('a mint then a transfer leaves the buyer with 1 and the seller with no row', async () => {
    const r = new FakeReader()
    r.all = [tr(ZeroAddress, A, 105), tr(A, B, 110)]
    await indexBeatHoldings('polygon', r)
    expect(await held(A)).toEqual([])
    expect(await held(B)).toEqual(['1'])
    const rows = await db.select().from(beatHoldings)
    expect(rows).toHaveLength(1)
    expect(rows[0].contract).toBe(CONTRACT)
    expect(rows[0].wallet).toBe(B)
  })

  it('only reads up to latest minus confirmations and pages in 2000-block chunks', async () => {
    const r = new FakeReader()
    r.latest = 100 + 30 + 5000
    r.all = [tr(ZeroAddress, A, r.latest - 10)]
    await indexBeatHoldings('polygon', r)
    expect(r.calls.length).toBeGreaterThan(1)
    for (const c of r.calls) expect(c.toBlock - c.fromBlock).toBeLessThan(INDEX_CHUNK_BLOCKS)
    expect(r.calls.at(-1)!.toBlock).toBe(r.latest - 30)
    expect(await db.select().from(beatHoldings)).toHaveLength(0)
  })

  it('the cursor makes a second run read only new blocks', async () => {
    const r = new FakeReader()
    r.all = [tr(ZeroAddress, A, 105)]
    const first = await indexBeatHoldings('polygon', r)
    expect(first.toBlock).toBe(170)
    r.calls = []
    r.latest = 300
    await indexBeatHoldings('polygon', r)
    expect(r.calls[0].fromBlock).toBe(first.toBlock! + 1)
    expect(await held(A)).toEqual(['1'])
    const [cur] = await db.select().from(beatIndexCursors)
    expect(cur.lastBlock).toBe(270)
  })

  it('a batch transfer moves every id', async () => {
    await seed({ tokenId: 8 })
    const r = new FakeReader()
    r.all = [tr(ZeroAddress, A, 105, 7n, 1n), tr(ZeroAddress, A, 105, 8n, 3n), tr(A, B, 106, 7n, 1n), tr(A, B, 106, 8n, 2n)]
    await indexBeatHoldings('polygon', r)
    expect(await held(A, 7)).toEqual([])
    expect(await held(A, 8)).toEqual(['1'])
    expect(await held(B, 7)).toEqual(['1'])
    expect(await held(B, 8)).toEqual(['2'])
  })

  it('checksummed addresses in logs land on the lowercase row', async () => {
    const r = new FakeReader()
    r.all = [tr(ZeroAddress, getAddress(A), 105)]
    r.all[0].contract = getAddress(CONTRACT)
    await indexBeatHoldings('polygon', r)
    expect(await held(A)).toEqual(['1'])
  })

  it('a contract whose create tx block is unknown is skipped, not indexed from 0', async () => {
    const r = new FakeReader()
    r.createBlock = null
    const out = await indexBeatHoldings('polygon', r)
    expect(r.calls).toHaveLength(0)
    expect(out.toBlock).toBeNull()
    expect(await db.select().from(beatIndexCursors)).toHaveLength(0)
  })

  it('rpcLogReader decodes a TransferBatch into one transfer per id', async () => {
    const enc = beatInterface.encodeEventLog(beatInterface.getEvent('TransferBatch')!, [A, ZeroAddress, B, [7n, 8n], [1n, 2n]])
    const provider = { getLogs: async () => [{ address: getAddress(CONTRACT), blockNumber: 120, topics: enc.topics, data: enc.data }] } as unknown as JsonRpcProvider
    const got = await rpcLogReader(provider).transfers(CONTRACT, 100, 200)
    expect(got).toEqual([
      { contract: CONTRACT, tokenId: 7n, from: ZeroAddress, to: getAddress(B), value: 1n, blockNumber: 120 },
      { contract: CONTRACT, tokenId: 8n, from: ZeroAddress, to: getAddress(B), value: 2n, blockNumber: 120 },
    ])
  })
})
