import { describe, it, expect, beforeEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { ZeroAddress, getAddress, type JsonRpcProvider } from 'ethers'
import { beatInterface } from '../src/beats/chain.js'
import { db } from '../src/db/connection.js'
import { beatHoldings, beatIndexCursors, beats } from '../src/db/schema.js'
import { INDEX_CHUNK_BLOCKS, indexBeatHoldings, rpcLogReader, type BeatLogReader, type BeatEvent, type BeatTransfer } from '../src/beats/holdings.js'
import { resetDb } from './helpers/db.js'

const CONTRACT = '0x00000000000000000000000000000000000c0de1'
const A = '0x00000000000000000000000000000000000000aa'
const B = '0x00000000000000000000000000000000000000bb'

class FakeReader implements BeatLogReader {
  latest = 200
  createBlock: number | null = 100
  all: BeatEvent[] = []
  calls: { contract: string; fromBlock: number; toBlock: number }[] = []
  async latestBlock() { return this.latest }
  txBlocks: Record<string, number | null> = {}
  async txBlock(hash: string) { return hash in this.txBlocks ? this.txBlocks[hash] : this.createBlock }
  async transfers(contract: string, fromBlock: number, toBlock: number): Promise<BeatEvent[]> {
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

  it('a provider that refuses wide log ranges gets smaller ones, down to 10 blocks, and still indexes', async () => {
    const r = new FakeReader()
    r.latest = 100 + 30 + 40
    r.all = [tr(ZeroAddress, A, 105)]
    const plain = r.transfers.bind(r)
    r.transfers = async (c, from, to) => {
      if (to - from + 1 > 10) throw new Error('Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.')
      return plain(c, from, to)
    }
    await indexBeatHoldings('polygon', r)
    expect(await held(A)).toEqual(['1'])
    expect(r.calls.every((c) => c.toBlock - c.fromBlock < 10)).toBe(true)
  })

  it('an error that is not about the range is not retried with smaller ranges', async () => {
    const r = new FakeReader()
    let n = 0
    r.transfers = async () => { n++; throw new Error('server unreachable') }
    await expect(indexBeatHoldings('polygon', r)).rejects.toThrow('server unreachable')
    expect(n).toBe(1)
  })

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

  it('starts at the earliest create block even when the earlier-drafted BEAT was created on chain later', async () => {
    await resetDb()
    await seed({ tokenId: 7, createdOnChainTx: '0xlate', createdAt: new Date(Date.now() - 86_400_000) })
    await seed({ tokenId: 8, createdOnChainTx: '0xearly', createdAt: new Date() })
    const r = new FakeReader()
    r.txBlocks = { '0xlate': 150, '0xearly': 100 }
    r.all = [tr(ZeroAddress, A, 120, 8n)]
    await indexBeatHoldings('polygon', r)
    expect(r.calls[0].fromBlock).toBe(100)
    expect(await held(A, 8)).toEqual(['1'])
  })

  it('an unresolvable create hash beside a resolvable one does not skip the contract', async () => {
    await resetDb()
    await seed({ tokenId: 7, createdOnChainTx: '0xgone' })
    await seed({ tokenId: 8, createdOnChainTx: '0xok' })
    const r = new FakeReader()
    r.txBlocks = { '0xgone': null, '0xok': 100 }
    r.all = [tr(ZeroAddress, A, 105, 8n)]
    await indexBeatHoldings('polygon', r)
    expect(await held(A, 8)).toEqual(['1'])
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

  it('a reissue marks the old wallet row as replaced and the new wallet holds 1', async () => {
    const r = new FakeReader()
    r.all = [tr(ZeroAddress, A, 105), { kind: 'reissue', contract: CONTRACT, tokenId: 7n, from: A, to: B, blockNumber: 120 }, tr(ZeroAddress, B, 120)]
    await indexBeatHoldings('polygon', r)
    const [a] = await db.select().from(beatHoldings).where(eq(beatHoldings.wallet, A))
    expect(a.replacedBy).toBe(B)
    expect(a.balance).toBe('1')
    const [b] = await db.select().from(beatHoldings).where(eq(beatHoldings.wallet, B))
    expect(b.balance).toBe('1')
    expect(b.replacedBy).toBeNull()
  })

  it('two overlapping runs apply each chunk exactly once', async () => {
    const r = new FakeReader()
    r.all = [tr(ZeroAddress, A, 105)]
    await Promise.all([indexBeatHoldings('polygon', r), indexBeatHoldings('polygon', r)])
    expect(await held(A)).toEqual(['1'])
    const [cur] = await db.select().from(beatIndexCursors)
    expect(cur.lastBlock).toBe(170)
  })
})
