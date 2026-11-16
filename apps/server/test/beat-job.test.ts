import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { Wallet, parseEther } from 'ethers'
import { BEAT_CLAIM_GRACE_MS, type BeatChain } from '@virvixr/shared'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { beatClaims, beatMintBatches, beatPayments, beats } from '../src/db/schema.js'
import { setBeatChainClientForTests } from '../src/beats/chain.js'
import { BEAT_GAS_PER_RECIPIENT } from '../src/beats/abi.js'
import { recordJobFailure } from '../src/errors/record.js'
import { sweepBeatPayments } from '../src/beats/payments.js'
import {
  beatJobTestHooks, beatPaused, clearBeatPause, resetBeatJobState, retryFailedClaims, runBeatTick,
} from '../src/beats/job.js'
import { resetDb } from './helpers/db.js'
import { createUser } from './helpers/factories.js'
import { fakeBeatChain, type FakeBeatChain } from './helpers/fake-beat-chain.js'

vi.mock('../src/errors/record.js', async (orig) => ({
  ...(await orig<typeof import('../src/errors/record.js')>()),
  recordJobFailure: vi.fn(),
}))
vi.mock('../src/beats/payments.js', async (orig) => {
  const a = await orig<typeof import('../src/beats/payments.js')>()
  return { ...a, sweepBeatPayments: vi.fn(a.sweepBeatPayments) }
})

const MIN = 60_000
const H = 60 * MIN
const GWEI = 1_000_000_000n
const T0 = new Date('2026-12-01T12:00:00Z')
const at = (ms: number) => new Date(T0.getTime() + ms)
const lc = (s: string) => s.toLowerCase()
const wallet = () => Wallet.createRandom().address

type BeatRow = typeof beats.$inferSelect
type ClaimRow = typeof beatClaims.$inferSelect

describe('BEAT minting job (LIV-11)', () => {
  let fake: FakeBeatChain
  let hostId: string
  const prev = config.beats
  const setBeats = (patch: Record<string, unknown>) => { ;(config as any).beats = { ...config.beats, ...patch } }

  beforeEach(async () => {
    await resetDb()
    resetBeatJobState()
    vi.mocked(recordJobFailure).mockClear()
    setBeats({ enabled: true, chain: 'polygon-amoy', minGasWei: parseEther('1') })
    fake = fakeBeatChain({ chain: 'polygon-amoy' })
    setBeatChainClientForTests('polygon-amoy', fake)
    setBeatChainClientForTests('polygon', null)
    hostId = (await createUser({ wallet: wallet() })).id
  })
  afterEach(() => {
    ;(config as any).beats = prev
    setBeatChainClientForTests('polygon-amoy', null)
    setBeatChainClientForTests('polygon', null)
    beatJobTestHooks.afterInsert = undefined
    beatJobTestHooks.beforeInsert = undefined
  })

  let nextToken = 1
  /** A BEAT with a paid create payment. `created` also creates it on the fake chain and records the create. */
  async function seed(o: {
    status?: BeatRow['status']; startsAt?: Date; endsAt?: Date; chain?: BeatChain; created?: boolean; payment?: 'paid' | 'refunded'
    chainFake?: FakeBeatChain
  } = {}) {
    const tokenId = nextToken++
    const [b] = await db.insert(beats).values({
      chain: o.chain ?? 'polygon-amoy', ownerUserId: hostId, name: 'Seed', description: '', tokenId, imageUrl: 'https://cdn.virvi.test/frozen.webp',
      startsAt: o.startsAt ?? at(-H), endsAt: o.endsAt ?? at(H), status: o.status ?? 'live',
      ...(o.created ? { createdOnChainTx: '0xcreated', createdOnChainAt: at(-2 * H) } : {}),
    }).returning()
    const [p] = await db.insert(beatPayments).values({
      beatId: b.id, userId: hostId, kind: 'create', capFrom: 0, capTo: 100, method: 'test', amountCents: 0,
      status: o.payment ?? 'paid', paidAt: at(-3 * H),
    }).returning()
    await db.update(beats).set({ paymentId: p.id }).where(eq(beats.id, b.id))
    if (o.created) (o.chainFake ?? fake).createdBeat(BigInt(tokenId))
    return { ...b, paymentId: p.id }
  }
  async function claims(beatId: string, wallets: string[], extra: Partial<typeof beatClaims.$inferInsert> = {}) {
    const rows = wallets.map((w, i) => ({
      beatId, wallet: w, displayName: `Visitor ${i}`, consentVersion: 1, status: 'claimed' as const,
      claimedAt: new Date(T0.getTime() - 10 * H + i * 1000), secondsPresent: 600, ...extra,
    }))
    const out: ClaimRow[] = []
    for (let i = 0; i < rows.length; i += 500) out.push(...await db.insert(beatClaims).values(rows.slice(i, i + 500)).returning())
    return out
  }
  const claimsOf = (beatId: string) => db.select().from(beatClaims).where(eq(beatClaims.beatId, beatId)).orderBy(asc(beatClaims.claimedAt))
  const beatOf = async (id: string) => (await db.select().from(beats).where(eq(beats.id, id)))[0]
  const batches = () => db.select().from(beatMintBatches).orderBy(asc(beatMintBatches.createdAt), asc(beatMintBatches.nonce))
  const statusCount = async (beatId: string) => {
    const out: Record<string, number> = {}
    for (const c of await claimsOf(beatId)) out[c.status] = (out[c.status] ?? 0) + 1
    return out
  }
  const mintWallets = (tx: { call: { kind: string } }) => (tx.call as unknown as { wallets: string[] }).wallets.map(lc)

  it('standards I2: a paid BEAT goes on chain only at go-live; then one create, created after 5 confirmations on Amoy, and no second', async () => {
    const early = await seed({ status: 'paid', startsAt: at(2 * H), endsAt: at(3 * H) })
    expect((await runBeatTick(T0)).sent).toBe(0)
    expect(fake.mempool()).toHaveLength(0)
    await db.delete(beats).where(eq(beats.id, early.id))
    const b = await seed({ status: 'paid', startsAt: T0, endsAt: at(3 * H) })
    const r1 = await runBeatTick(T0)
    expect((await beatOf(b.id)).status).toBe('live')
    expect(r1.sent).toBe(1)
    expect(fake.mempool()).toHaveLength(1)
    expect(fake.mempool()[0].call).toEqual({ kind: 'create', tokenId: BigInt(b.tokenId!), tradeable: false })
    // Not mined: nothing new
    await runBeatTick(at(MIN))
    expect(fake.mempool()).toHaveLength(1)
    fake.mine(1)
    fake.mine(4)
    await runBeatTick(at(2 * MIN))
    expect((await beatOf(b.id)).createdOnChainTx).toBeNull()
    fake.mine(1)
    const r = await runBeatTick(at(3 * MIN))
    expect(r.confirmed).toBe(1)
    const row = await beatOf(b.id)
    expect(row.createdOnChainTx).toBe(fake.minedTxs()[0].hash)
    expect(row.createdOnChainAt).toEqual(at(3 * MIN))
    await runBeatTick(at(4 * MIN))
    fake.mine(10)
    await runBeatTick(at(5 * MIN))
    expect(fake.mempool()).toHaveLength(0)
    expect(fake.minedTxs()).toHaveLength(1)
    expect((await batches()).map((x) => [x.kind, x.status])).toEqual([['create', 'confirmed']])
  })

  it('250 claims go out as 100, 100 then 50 (BEAT_MAX_BATCH), never two open at once, and all end minted', async () => {
    const b = await seed({ created: true })
    const ws = Array.from({ length: 250 }, wallet)
    await claims(b.id, ws)
    await runBeatTick(T0)
    expect(fake.mempool()).toHaveLength(1)
    expect(mintWallets(fake.mempool()[0])).toEqual(ws.slice(0, 100).map(lc))
    expect(await statusCount(b.id)).toEqual({ minting: 100, claimed: 150 })
    await runBeatTick(at(MIN))
    expect(fake.mempool()).toHaveLength(1)
    fake.mine(6)
    await runBeatTick(at(2 * MIN))
    expect(mintWallets(fake.mempool()[0])).toEqual(ws.slice(100, 200).map(lc))
    fake.mine(6)
    await runBeatTick(at(3 * MIN))
    expect(mintWallets(fake.mempool()[0])).toEqual(ws.slice(200).map(lc))
    expect(await statusCount(b.id)).toEqual({ minted: 200, minting: 50 })
    fake.mine(6)
    await runBeatTick(at(4 * MIN))
    expect(await statusCount(b.id)).toEqual({ minted: 250 })
    expect(fake.mintedCount(BigInt(b.tokenId!))).toBe(250)
    const done = await claimsOf(b.id)
    expect(done.every((c) => c.mintTx && c.mintedAt)).toBe(true)
    expect((await batches()).map((x) => [x.nonce, x.status, x.wallets?.length])).toEqual([[0, 'confirmed', 100], [1, 'confirmed', 100], [2, 'confirmed', 50]])
  })

  it('on Polygon a receipt with 29 confirmations does not confirm; 30 does', async () => {
    const poly = fakeBeatChain({ chain: 'polygon' })
    setBeatChainClientForTests('polygon', poly)
    const b = await seed({ chain: 'polygon', created: true, chainFake: poly })
    await claims(b.id, [wallet()])
    await runBeatTick(T0)
    poly.mine(1)
    poly.mine(29)
    await runBeatTick(at(MIN))
    expect(await statusCount(b.id)).toEqual({ minting: 1 })
    poly.mine(1)
    await runBeatTick(at(2 * MIN))
    expect(await statusCount(b.id)).toEqual({ minted: 1 })
  })

  it('attacker I2: wallets with code go in the same batch as the rest, every recipient budgeted as if it had code', async () => {
    const b = await seed({ created: true })
    const [e1, c1, e2, c2] = [wallet(), wallet(), wallet(), wallet()]
    fake.setCode(c1)
    fake.setCode(c2)
    await claims(b.id, [e1, c1, e2, c2])
    await runBeatTick(T0)
    const tx = fake.mempool()[0]
    expect(mintWallets(tx)).toEqual([e1, c1, e2, c2].map(lc))
    // Fix round I-4: each wallet is budgeted once, as a plain mint (the plain subset's own estimate, per wallet) plus the
    // receiver budget; the code wallets' hook gas isn't counted on top of that again
    const plainEst = fake.gasFor({ kind: 'mint', tokenId: 1n, wallets: [e1, e2] })
    expect(tx.gasLimit).toBe((plainEst + 2n * (plainEst / 2n)) * 110n / 100n + 4n * BEAT_GAS_PER_RECIPIENT)
    expect(tx.gasLimit).toBeLessThan(fake.gasFor(tx.call) * 110n / 100n + 4n * BEAT_GAS_PER_RECIPIENT)
    expect((await batches())[0].codeCount).toBe(2)
    fake.mine(6)
    await runBeatTick(at(MIN))
    expect(await statusCount(b.id)).toEqual({ minted: 4 })
  })

  it('attacker I1: wallets that gain code after the estimate are covered by the budget and the batch still mints', async () => {
    const b = await seed({ created: true })
    const ws = Array.from({ length: 100 }, wallet)
    await claims(b.id, ws)
    await runBeatTick(T0)
    // A front-run delegates 40 of them before the batch is mined
    for (const w of ws.slice(0, 40)) fake.setCode(w)
    fake.mine(6)
    await runBeatTick(at(MIN))
    expect(await statusCount(b.id)).toEqual({ minted: 100 })
    expect(fake.minedTxs().every((t) => t.ok)).toBe(true)
  })

  it('a reverting wallet is found one at a time (ruling 5) and fails only its own claim', async () => {
    const b = await seed({ created: true })
    const [e1, c1, e2] = [wallet(), wallet(), wallet()]
    fake.setCode(c1)
    fake.revertForWallet(c1, 'ERC1155InvalidReceiver')
    await claims(b.id, [e1, c1, e2])
    for (let i = 0; i < 4; i++) {
      await runBeatTick(at(i * MIN))
      fake.mine(6)
    }
    await runBeatTick(at(5 * MIN))
    const byWallet = Object.fromEntries((await claimsOf(b.id)).map((c) => [lc(c.wallet), c]))
    expect(byWallet[lc(c1)]).toMatchObject({ status: 'failed', failReason: 'ERC1155InvalidReceiver' })
    for (const w of [e1, e2]) expect(byWallet[lc(w)].status).toBe('minted')
  })

  describe('Review Focus 2: crash recovery', () => {
    it('a crash after the insert, before the broadcast: the next tick broadcasts the same raw tx at the same nonce', async () => {
      const b = await seed({ created: true })
      await claims(b.id, [wallet(), wallet()])
      beatJobTestHooks.afterInsert = async () => { throw new Error('crash') }
      await runBeatTick(T0)
      expect(fake.mempool()).toHaveLength(0)
      const [row] = await batches()
      expect(row.status).toBe('sending')
      expect(await statusCount(b.id)).toEqual({ minting: 2 })
      beatJobTestHooks.afterInsert = undefined
      await runBeatTick(at(MIN))
      expect(fake.mempool()).toHaveLength(1)
      expect(fake.mempool()[0].raw).toBe(row.rawTx)
      expect(fake.mempool()[0].nonce).toBe(row.nonce)
      expect((await batches())[0].status).toBe('sent')
      expect(await batches()).toHaveLength(1)
      fake.mine(6)
      await runBeatTick(at(2 * MIN))
      expect(await statusCount(b.id)).toEqual({ minted: 2 })
    })

    it('a dropped tx is re-signed after 10 minutes at the same nonce with higher fees, and the second hash confirms', async () => {
      const b = await seed({ created: true })
      await claims(b.id, [wallet()])
      fake.dropNext(1)
      await runBeatTick(T0)
      expect(fake.mempool()).toHaveLength(0)
      const [first] = await batches()
      expect(first.status).toBe('sent')
      await runBeatTick(at(5 * MIN))
      expect(fake.mempool()).toHaveLength(0)
      await runBeatTick(at(11 * MIN))
      expect(fake.mempool()).toHaveLength(1)
      const tx = fake.mempool()[0]
      expect(tx.nonce).toBe(first.nonce)
      expect(tx.fees.maxFeePerGas).toBeGreaterThanOrEqual(75n * GWEI)
      expect(tx.fees.maxPriorityFeePerGas).toBeGreaterThanOrEqual(37n * GWEI)
      const [again] = await batches()
      expect(again.txHashes).toHaveLength(2)
      expect(again.txHashes[1]).toBe(tx.hash)
      expect(again.rawTx).toBe(tx.raw)
      expect(again.sentAt).toEqual(at(11 * MIN))
      fake.mine(6)
      await runBeatTick(at(12 * MIN))
      const [c] = await claimsOf(b.id)
      expect(c.status).toBe('minted')
      expect(c.mintTx).toBe(tx.hash)
      expect((await batches())[0].status).toBe('confirmed')
    })

    it('a nonce consumed by a lost hash is reconciled with isMinted, and no claim is left minting in that batch', async () => {
      const b = await seed({ created: true })
      const ws = [wallet(), wallet(), wallet()]
      await claims(b.id, ws)
      await runBeatTick(T0)
      const [first] = await batches()
      // Another of our transactions (one we lost) takes the nonce, minting two of the three
      const lost = await fake.sign({ kind: 'mint', tokenId: BigInt(b.tokenId!), wallets: ws.slice(0, 2) }, first.nonce,
        { maxFeePerGas: 200n * GWEI, maxPriorityFeePerGas: 100n * GWEI })
      await fake.broadcast(lost.raw)
      fake.mine(6)
      await runBeatTick(at(MIN))
      const [old] = (await batches()).filter((x) => x.id === first.id)
      expect(old.status).toBe('failed')
      expect(old.lastError).toBe('replaced')
      const rows = await claimsOf(b.id)
      expect(rows.filter((c) => c.batchId === first.id && c.status === 'minting')).toHaveLength(0)
      expect(rows.slice(0, 2).map((c) => c.status)).toEqual(['minted', 'minted'])
      // The third went back to claimed and straight into a new batch at the next nonce
      expect(rows[2].status).toBe('minting')
      expect(fake.mempool()[0].nonce).toBe(first.nonce + 1)
      fake.mine(6)
      await runBeatTick(at(2 * MIN))
      expect(await statusCount(b.id)).toEqual({ minted: 3 })
    })
  })

  it('low gas pauses the chain and sends nothing; the claims stay claimed', async () => {
    const b = await seed({ created: true })
    await claims(b.id, [wallet(), wallet()])
    fake.setBalance(parseEther('0.5'))
    const r = await runBeatTick(T0)
    expect(r.paused).toContain('polygon-amoy')
    expect(beatPaused('polygon-amoy')).toEqual({ paused: true, reason: 'low_gas' })
    expect(fake.mempool()).toHaveLength(0)
    expect(await batches()).toHaveLength(0)
    expect(await statusCount(b.id)).toEqual({ claimed: 2 })
    fake.setBalance(parseEther('10'))
    const r2 = await runBeatTick(at(MIN))
    expect(r2.sent).toBe(1)
    expect(beatPaused('polygon-amoy')).toEqual({ paused: false, reason: null })
    expect(beatPaused('polygon')).toEqual({ paused: true, reason: 'no_client' })
  })

  it('money I3: 5 broadcast refusals give the unsent batch up with a job failure; its claims go back to claimed and mint', async () => {
    const b = await seed({ created: true })
    const ws = [wallet(), wallet(), wallet()]
    await claims(b.id, ws)
    fake.failBroadcast('INVALID_ARGUMENT', 5)
    await runBeatTick(T0)
    let [row] = await batches()
    expect(row.status).toBe('sending')
    expect(row.attempts).toBe(1)
    expect(row.nextAttemptAt).toEqual(at(2 * MIN))
    await runBeatTick(at(MIN))
    expect((await batches())[0].attempts).toBe(1)
    for (let i = 1; i <= 3; i++) {
      await runBeatTick(at(i * H))
      ;[row] = await batches()
      expect(row.attempts).toBe(i + 1)
    }
    expect(recordJobFailure).not.toHaveBeenCalled()
    await runBeatTick(at(4 * H))
    // The given-up batch's nonce was never used: the re-planned batch took its place (and its nonce)
    const all = await batches()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ status: 'sent', nonce: 0 })
    expect(recordJobFailure).toHaveBeenCalledTimes(1)
    const [job, err] = vi.mocked(recordJobFailure).mock.calls[0]
    expect(job).toMatch(/^beat/)
    for (const w of ws) expect(String((err as Error).message).toLowerCase()).not.toContain(lc(w).slice(2))
    // Never failed: the same tick re-plans them at the same nonce
    expect(await statusCount(b.id)).toEqual({ minting: 3 })
    expect(fake.mempool()).toHaveLength(1)
    expect(fake.mempool()[0].nonce).toBe(0)
    fake.mine(6)
    await runBeatTick(at(4 * H + MIN))
    expect(await statusCount(b.id)).toEqual({ minted: 3 })
  })

  it('fix round I-1: a deterministic refusal (UNKNOWN_ERROR from the node, say its tx fee cap) goes the failed-send way: backoff, give-up, one alert', async () => {
    const b = await seed({ created: true })
    await claims(b.id, [wallet(), wallet()])
    // Refused on every broadcast, as a geth node with --rpc.txfeecap refuses a big batch
    fake.failBroadcast('UNKNOWN_ERROR', 40, false)
    await runBeatTick(T0)
    for (let i = 1; i <= 12; i++) await runBeatTick(at(i * H))
    const failures = vi.mocked(recordJobFailure).mock.calls.filter((c) => String(c[0]).startsWith('beat_mint'))
    expect(failures).toHaveLength(1)
    expect(String((failures[0][1] as Error).message)).toContain('UNKNOWN_ERROR')
    expect(String((failures[0][1] as Error).message)).toContain('not sent after')
    // Never stuck in `sending` behind a refusal: the claims are re-planned, and nothing is marked failed
    expect(await statusCount(b.id)).not.toHaveProperty('failed')
    expect(beatPaused('polygon-amoy').paused).toBe(false)
  })

  it('money I3: a batch never broadcast because the RPC is down is not failed; it waits and goes once the RPC is back', async () => {
    const b = await seed({ created: true })
    await claims(b.id, [wallet(), wallet()])
    fake.failBroadcast('NETWORK_ERROR', 8)
    await runBeatTick(T0)
    for (let i = 1; i <= 7; i++) await runBeatTick(at(i * H))
    const [row] = await batches()
    expect(row.status).toBe('sending')
    expect(await statusCount(b.id)).toEqual({ minting: 2 })
    await runBeatTick(at(8 * H))
    expect((await batches())[0].status).toBe('sent')
    fake.mine(6)
    await runBeatTick(at(8 * H + MIN))
    expect(await statusCount(b.id)).toEqual({ minted: 2 })
  })

  it('statuses: paid → live at starts_at, live → ended at ends_at', async () => {
    const b = await seed({ status: 'paid', startsAt: at(H), endsAt: at(2 * H) })
    await runBeatTick(T0)
    expect((await beatOf(b.id)).status).toBe('paid')
    await runBeatTick(at(H - 1))
    expect((await beatOf(b.id)).status).toBe('paid')
    await runBeatTick(at(H))
    expect((await beatOf(b.id)).status).toBe('live')
    await runBeatTick(at(2 * H - 1))
    expect((await beatOf(b.id)).status).toBe('live')
    await runBeatTick(at(2 * H))
    expect((await beatOf(b.id)).status).toBe('ended')
  })

  it('a BEAT whose create payment is refunded never goes live (or on chain), and admins are told', async () => {
    const b = await seed({ status: 'paid', startsAt: at(H), endsAt: at(2 * H), payment: 'refunded' })
    await runBeatTick(at(H))
    expect((await beatOf(b.id)).status).toBe('paid')
    expect(fake.mempool()).toHaveLength(0)
    expect(recordJobFailure).toHaveBeenCalledTimes(1)
    expect(String((vi.mocked(recordJobFailure).mock.calls[0][1] as Error).message)).toContain(b.id)
    await runBeatTick(at(H + MIN))
    expect((await beatOf(b.id)).status).toBe('paid')
  })

  it('two ticks at once send exactly one transaction', async () => {
    const b = await seed({ created: true })
    await claims(b.id, [wallet(), wallet()])
    const [r1, r2] = await Promise.all([runBeatTick(T0), runBeatTick(T0)])
    expect(r1.sent + r2.sent).toBe(1)
    expect(fake.mempool()).toHaveLength(1)
    expect(await batches()).toHaveLength(1)
  })

  it('a tick started while another holds the lock does nothing', async () => {
    const b = await seed({ created: true })
    await claims(b.id, [wallet()])
    let inner: Awaited<ReturnType<typeof runBeatTick>> | null = null
    beatJobTestHooks.afterInsert = async () => { inner = await runBeatTick(T0) }
    const outer = await runBeatTick(T0)
    expect(inner).toEqual({ sent: 0, confirmed: 0, failed: 0, paused: [] })
    expect(outer.sent).toBe(1)
  })

  it('MintSkipped in a receipt fails only those claims, with receiver_rejected', async () => {
    const b = await seed({ created: true })
    const [e1, r1] = [wallet(), wallet()]
    fake.rejectReceiver(r1)
    await claims(b.id, [e1, r1])
    await runBeatTick(T0)
    expect(mintWallets(fake.mempool()[0])).toEqual([lc(e1), lc(r1)])
    fake.mine(6)
    await runBeatTick(at(MIN))
    const byWallet = Object.fromEntries((await claimsOf(b.id)).map((c) => [lc(c.wallet), c]))
    expect(byWallet[lc(e1)].status).toBe('minted')
    expect(byWallet[lc(r1)].status).toBe('failed')
    expect(byWallet[lc(r1)].failReason).toBe('receiver_rejected')
    expect((await batches()).map((x) => x.status)).toEqual(['confirmed'])
  })

  it('BeatExists on create pauses the chain with id_conflict until an admin clears it', async () => {
    const b = await seed({ status: 'live', startsAt: at(-H), endsAt: at(2 * H) })
    fake.createdBeat(BigInt(b.tokenId!)) // someone else's
    const r = await runBeatTick(T0)
    expect(r.sent).toBe(0)
    expect(beatPaused('polygon-amoy')).toEqual({ paused: true, reason: 'id_conflict' })
    expect(recordJobFailure).toHaveBeenCalledTimes(1)
    expect(fake.mempool()).toHaveLength(0)
    // Sticky: another BEAT's claims don't go out either
    const other = await seed({ created: true })
    await claims(other.id, [wallet()])
    await runBeatTick(at(MIN))
    expect(beatPaused('polygon-amoy').reason).toBe('id_conflict')
    expect(fake.mempool()).toHaveLength(0)
    clearBeatPause('polygon-amoy')
    expect(beatPaused('polygon-amoy')).toEqual({ paused: false, reason: null })
  })

  it('an ended BEAT past the grace with nothing pending gets one close, and closed_on_chain_at is set', async () => {
    const b = await seed({ status: 'ended', startsAt: at(-30 * H), endsAt: new Date(T0.getTime() - BEAT_CLAIM_GRACE_MS + MIN), created: true })
    await claims(b.id, [wallet()], { status: 'minted', mintTx: '0xabc', mintedAt: at(-20 * H) })
    // Still inside the grace
    await runBeatTick(T0)
    expect(fake.mempool()).toHaveLength(0)
    // A claim still minting holds it open
    const [late] = await claims(b.id, [wallet()], { status: 'minting' })
    await runBeatTick(at(2 * MIN))
    expect(fake.mempool()).toHaveLength(0)
    await db.delete(beatClaims).where(eq(beatClaims.id, late.id))
    await runBeatTick(at(2 * MIN))
    expect(fake.mempool()).toHaveLength(1)
    expect(fake.mempool()[0].call).toEqual({ kind: 'close', tokenId: BigInt(b.tokenId!) })
    await runBeatTick(at(3 * MIN))
    expect(fake.mempool()).toHaveLength(1)
    fake.mine(6)
    await runBeatTick(at(4 * MIN))
    expect(fake.isClosed(BigInt(b.tokenId!))).toBe(true)
    expect((await beatOf(b.id)).closedOnChainAt).toEqual(at(4 * MIN))
    await runBeatTick(at(5 * MIN))
    expect(fake.mempool()).toHaveLength(0)
    expect(fake.minedTxs()).toHaveLength(1)
  })

  it('the first confirmed mint sets frozen_at; later ones leave it', async () => {
    const b = await seed({ created: true })
    await claims(b.id, [wallet()])
    await runBeatTick(T0)
    fake.mine(6)
    await runBeatTick(at(MIN))
    expect((await beatOf(b.id)).frozenAt).toEqual(at(MIN))
    await db.insert(beatClaims).values({ beatId: b.id, wallet: wallet(), consentVersion: 1, status: 'claimed', claimedAt: at(MIN) })
    await runBeatTick(at(2 * MIN))
    fake.mine(6)
    await runBeatTick(at(3 * MIN))
    expect(await statusCount(b.id)).toEqual({ minted: 2 })
    expect((await beatOf(b.id)).frozenAt).toEqual(at(MIN))
  })

  it('delete requests settle: a minted claim loses its account and name, a failed one is deleted', async () => {
    const b = await seed({ created: true })
    const [e1, r1] = [wallet(), wallet()]
    fake.rejectReceiver(r1)
    const visitor = await createUser({ wallet: e1 })
    const [ce] = await claims(b.id, [e1], { userId: visitor.id })
    const [cr] = await claims(b.id, [r1], { claimedAt: at(-H) })
    await runBeatTick(T0)
    await db.update(beatClaims).set({ deleteRequested: true }).where(inArray(beatClaims.id, [ce.id, cr.id]))
    fake.mine(6)
    await runBeatTick(at(MIN))
    const [kept] = await db.select().from(beatClaims).where(eq(beatClaims.id, ce.id))
    expect(kept).toMatchObject({ status: 'minted', userId: null, displayName: null, wallet: e1, secondsPresent: null })
    // The rejecting receiver was skipped (failed) and asked to be deleted: gone
    expect(await db.select().from(beatClaims).where(eq(beatClaims.id, cr.id))).toHaveLength(0)
  })

  it('ruling 4: a mint batch reverting on chain (InsufficientGas) is retried at half the size', async () => {
    const b = await seed({ created: true })
    const ws = [wallet(), wallet(), wallet(), wallet()]
    await claims(b.id, ws)
    await runBeatTick(T0)
    fake.revertNext('InsufficientGas', { kind: 'mint' })
    fake.mine(6)
    await runBeatTick(at(MIN))
    const [first] = await batches()
    expect(first.status).toBe('failed')
    expect(fake.revertReason(first.txHashes[0])).toBe('InsufficientGas')
    expect(mintWallets(fake.mempool()[0])).toEqual(ws.slice(0, 2).map(lc))
    expect(await statusCount(b.id)).toEqual({ minting: 2, claimed: 2 })
    fake.mine(6)
    await runBeatTick(at(2 * MIN))
    fake.mine(6)
    await runBeatTick(at(3 * MIN))
    expect(await statusCount(b.id)).toEqual({ minted: 4 })
  })

  it('a broadcast batch whose later rebroadcasts fail up to the max stays open: its nonce is kept and it mints', async () => {
    const b = await seed({ created: true })
    const ws = [wallet(), wallet()]
    await claims(b.id, ws)
    await runBeatTick(T0)
    const [first] = await batches()
    expect(first.status).toBe('sent')
    expect(first.attempts).toBe(0)
    // The tx sits in the mempool; every reprice and rebroadcast after it fails
    fake.failBroadcast('NETWORK_ERROR', 20)
    for (let i = 1; i <= 8; i++) await runBeatTick(at(i * H))
    const [row] = await batches()
    expect(row.id).toBe(first.id)
    expect(row.status).toBe('sending')
    expect(row.attempts).toBeGreaterThanOrEqual(5)
    expect(row.lastError?.startsWith('unsent')).toBe(false)
    expect(await statusCount(b.id)).toEqual({ minting: 2 })
    expect(recordJobFailure).toHaveBeenCalledTimes(1)
    // Its nonce stays reserved: a new claim waits instead of taking it
    await claims(b.id, [wallet()], { claimedAt: at(H) })
    await runBeatTick(at(9 * H))
    expect(await batches()).toHaveLength(1)
    fake.mine(6)
    await runBeatTick(at(10 * H))
    const settled = await batches()
    expect(settled[0].status).toBe('confirmed')
    expect(settled[0].txHash).toBe(first.txHashes[0])
    const rows = await claimsOf(b.id)
    expect(rows.filter((c) => ws.includes(c.wallet)).map((c) => c.status)).toEqual(['minted', 'minted'])
    // The next batch takes the next nonce
    expect(settled[1].nonce).toBe(first.nonce + 1)
    // One report for the batch; a broadcast that found the RPC unreachable 10 passes running also reports rpc_down
    expect(vi.mocked(recordJobFailure).mock.calls.filter((c) => c[0] === 'beat_mint')).toHaveLength(1)
    expect(vi.mocked(recordJobFailure).mock.calls.filter((c) => c[0] !== 'beat_mint' && c[0] !== 'beat_rpc')).toHaveLength(0)
  })

  it('a successful broadcast after failures resets attempts', async () => {
    const b = await seed({ created: true })
    await claims(b.id, [wallet()])
    fake.failBroadcast('NETWORK_ERROR', 2)
    await runBeatTick(T0)
    await runBeatTick(at(H))
    expect((await batches())[0].attempts).toBe(2)
    await runBeatTick(at(2 * H))
    const [row] = await batches()
    expect(row.status).toBe('sent')
    expect(row.attempts).toBe(0)
    expect(row.nextAttemptAt).toBeNull()
  })

  it('a single-wallet mint that reverts on chain fails its claim and batch, with no automatic retry', async () => {
    const b = await seed({ created: true })
    await claims(b.id, [wallet()])
    await runBeatTick(T0)
    fake.revertNext('BeatClosedError', { kind: 'mint' })
    fake.mine(6)
    await runBeatTick(at(MIN))
    const [row] = await batches()
    expect(row.status).toBe('failed')
    expect(row.lastError).toMatch(/^reverted/)
    const [c] = await claimsOf(b.id)
    expect(c.status).toBe('failed')
    expect(c.failReason).toBe('reverted')
    for (let i = 2; i < 5; i++) { await runBeatTick(at(i * MIN)); fake.mine(6) }
    expect(await batches()).toHaveLength(1)
    expect(fake.mempool()).toHaveLength(0)
    expect((await claimsOf(b.id))[0].status).toBe('failed')
  })

  it('BeatExists after a confirmed create of ours records the hash that mined, not the newest one signed', async () => {
    const b = await seed({ status: 'live', startsAt: at(-H), endsAt: at(2 * H) })
    const mined = '0x' + 'a'.repeat(64)
    const newer = '0x' + 'b'.repeat(64)
    await db.insert(beatMintBatches).values({
      chain: 'polygon-amoy', kind: 'create', beatId: b.id, tokenId: b.tokenId!, nonce: 0, status: 'confirmed',
      txHash: mined, txHashes: [mined, newer], confirmedAt: at(-H),
    })
    fake.createdBeat(BigInt(b.tokenId!))
    await runBeatTick(T0)
    expect((await beatOf(b.id)).createdOnChainTx).toBe(mined)
    expect(beatPaused('polygon-amoy').paused).toBe(false)
  })

  it('BeatExists after an earlier unsent create of ours is still an id_conflict', async () => {
    const b = await seed({ status: 'live', startsAt: at(-H), endsAt: at(10 * H) })
    fake.failBroadcast('INVALID_ARGUMENT', 5)
    await runBeatTick(T0)
    for (let i = 1; i <= 3; i++) await runBeatTick(at(i * H))
    // Meanwhile someone else's create of that id lands
    fake.createdBeat(BigInt(b.tokenId!))
    // Our create gives up unsent, and the same tick's next create estimate meets BeatExists
    await runBeatTick(at(4 * H))
    const all = await batches()
    expect(all).toHaveLength(1)
    expect(all[0].status).toBe('failed')
    expect(all[0].lastError).toMatch(/^unsent:/)
    expect(beatPaused('polygon-amoy')).toEqual({ paused: true, reason: 'id_conflict' })
    expect((await beatOf(b.id)).createdOnChainTx).toBeNull()
    // One for the give-up, one for the conflict
    expect(recordJobFailure).toHaveBeenCalledTimes(2)
    expect(String((vi.mocked(recordJobFailure).mock.calls[1][1] as Error).message)).toContain('already exists')
  })

  it('a create whose estimate keeps reverting is reported once, not every tick', async () => {
    const b = await seed({ status: 'live', startsAt: at(-H), endsAt: at(2 * H) })
    fake.revertNext('AccessControlUnauthorizedAccount', { kind: 'create', times: 3 })
    for (let i = 0; i < 3; i++) await runBeatTick(at(i * MIN))
    expect(fake.mempool()).toHaveLength(0)
    expect(recordJobFailure).toHaveBeenCalledTimes(1)
    expect(String((vi.mocked(recordJobFailure).mock.calls[0][1] as Error).message)).toContain(b.id)
    // Once it estimates again it goes out
    await runBeatTick(at(3 * MIN))
    expect(fake.mempool()).toHaveLength(1)
  })

  it('ruling 5: a batch whose estimate reverts falls back to one wallet at a time, failing only the bad one', async () => {
    const b = await seed({ created: true })
    const [w1, w2, w3] = [wallet(), wallet(), wallet()]
    fake.revertForWallet(w2, 'ERC1155InvalidReceiver')
    await claims(b.id, [w1, w2, w3])
    for (let i = 0; i < 6; i++) {
      await runBeatTick(at(i * MIN))
      for (const tx of fake.mempool()) expect(mintWallets(tx)).toHaveLength(1)
      fake.mine(6)
    }
    const byWallet = Object.fromEntries((await claimsOf(b.id)).map((c) => [lc(c.wallet), c]))
    expect(byWallet[lc(w1)].status).toBe('minted')
    expect(byWallet[lc(w3)].status).toBe('minted')
    expect(byWallet[lc(w2)].status).toBe('failed')
    expect(byWallet[lc(w2)].failReason).toBe('ERC1155InvalidReceiver')
  })

  it('logs no wallets or display names at info level or above', async () => {
    const spies = (['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    try {
      const b = await seed({ created: true })
      const ws = [wallet(), wallet()]
      fake.rejectReceiver(ws[1])
      await claims(b.id, ws)
      fake.failBroadcast('NETWORK_ERROR', 1)
      for (let i = 0; i < 4; i++) { await runBeatTick(at(i * H)); fake.mine(6) }
      const text = spies.flatMap((s) => s.mock.calls.flat().map(String)).join('\n').toLowerCase()
      for (const w of ws) expect(text).not.toContain(lc(w).slice(2))
      expect(text).not.toContain('visitor 0')
    } finally {
      for (const s of spies) s.mockRestore()
    }
  })

  describe('final review fixes', () => {
    it('C1: a BEAT that ends before its create (low gas) is created and its claims minted once gas returns', async () => {
      const b = await seed({ status: 'live', startsAt: at(-H), endsAt: at(H) })
      await claims(b.id, [wallet(), wallet()])
      fake.setBalance(parseEther('0.5'))
      await runBeatTick(T0)
      expect(fake.mempool()).toHaveLength(0)
      await runBeatTick(at(2 * H))
      expect((await beatOf(b.id)).status).toBe('ended')
      expect(fake.mempool()).toHaveLength(0)
      fake.setBalance(parseEther('10'))
      await runBeatTick(at(2 * H + MIN))
      expect(fake.mempool()).toHaveLength(1)
      expect(fake.mempool()[0].call.kind).toBe('create')
      fake.mine(6)
      await runBeatTick(at(2 * H + 2 * MIN))
      expect((await beatOf(b.id)).createdOnChainTx).not.toBeNull()
      expect(fake.mempool()[0].call.kind).toBe('mint')
      fake.mine(6)
      await runBeatTick(at(2 * H + 3 * MIN))
      expect(await statusCount(b.id)).toEqual({ minted: 2 })
    })

    it('C1: an ended BEAT past its grace with no claims is not created', async () => {
      await seed({ status: 'ended', startsAt: at(-30 * H), endsAt: new Date(T0.getTime() - BEAT_CLAIM_GRACE_MS - MIN) })
      await runBeatTick(T0)
      expect(fake.mempool()).toHaveLength(0)
    })

    it('I1: a balance above the minimum but below the batch cost pauses low_gas; claims stay claimed', async () => {
      setBeats({ minGasWei: parseEther('0.001') })
      const b = await seed({ created: true })
      await claims(b.id, [wallet(), wallet()])
      fake.setBalance(parseEther('0.005')) // the batch costs about 0.0086 POL at 60 gwei
      const r = await runBeatTick(T0)
      expect(r.paused).toContain('polygon-amoy')
      expect(beatPaused('polygon-amoy')).toEqual({ paused: true, reason: 'low_gas' })
      expect(fake.mempool()).toHaveLength(0)
      expect(await batches()).toHaveLength(0)
      expect(await statusCount(b.id)).toEqual({ claimed: 2 })
      fake.setBalance(parseEther('10'))
      expect((await runBeatTick(at(MIN))).sent).toBe(1)
      expect(beatPaused('polygon-amoy')).toEqual({ paused: false, reason: null })
    })

    it('I1: a broadcast rejected for insufficient funds pauses low_gas and never counts an attempt', async () => {
      const b = await seed({ created: true })
      await claims(b.id, [wallet(), wallet()])
      fake.failBroadcast('INSUFFICIENT_FUNDS', 8)
      for (let i = 0; i < 8; i++) {
        await runBeatTick(at(i * H))
        expect(beatPaused('polygon-amoy')).toEqual({ paused: true, reason: 'low_gas' })
        const [row] = await batches()
        expect(row.status).toBe('sending')
        expect(row.attempts).toBe(0)
      }
      expect(await statusCount(b.id)).toEqual({ minting: 2 })
      expect(recordJobFailure).not.toHaveBeenCalled()
      await runBeatTick(at(9 * H))
      expect((await batches())[0].status).toBe('sent')
      expect(beatPaused('polygon-amoy')).toEqual({ paused: false, reason: null })
      fake.mine(6)
      await runBeatTick(at(9 * H + MIN))
      expect(await statusCount(b.id)).toEqual({ minted: 2 })
    })

    it('I2: no close while a claim has failed for a retryable reason; a final one does not hold it', async () => {
      const past = new Date(T0.getTime() - BEAT_CLAIM_GRACE_MS - MIN)
      const held = await seed({ status: 'ended', startsAt: at(-40 * H), endsAt: past, created: true })
      const free = await seed({ status: 'ended', startsAt: at(-40 * H), endsAt: past, created: true })
      await claims(held.id, [wallet()], { status: 'failed', failReason: 'send_failed' })
      await claims(free.id, [wallet()], { status: 'failed', failReason: 'receiver_rejected' })
      await runBeatTick(T0)
      expect(fake.mempool().map((t) => t.call)).toEqual([{ kind: 'close', tokenId: BigInt(free.tokenId!) }])
      fake.mine(6)
      await runBeatTick(at(MIN))
      await runBeatTick(at(2 * MIN))
      expect(fake.mempool()).toHaveLength(0)
      expect((await beatOf(held.id)).closedOnChainAt).toBeNull()
      // Retrying it mints the claim, and only then does the BEAT close
      expect(await retryFailedClaims(held.id)).toEqual({ retried: 1, skippedClosed: 0 })
      await runBeatTick(at(3 * MIN))
      expect(fake.mempool()[0].call.kind).toBe('mint')
      fake.mine(6)
      await runBeatTick(at(4 * MIN))
      expect(await statusCount(held.id)).toEqual({ minted: 1 })
      expect(fake.mempool()[0].call).toEqual({ kind: 'close', tokenId: BigInt(held.tokenId!) })
    })

    it('I2: retryFailedClaims skips claims of BEATs closed on chain and says how many', async () => {
      const closed = await seed({ status: 'ended', startsAt: at(-40 * H), endsAt: at(-30 * H), created: true })
      await db.update(beats).set({ closedOnChainAt: at(-H) }).where(eq(beats.id, closed.id))
      const open = await seed({ created: true })
      await claims(closed.id, [wallet(), wallet()], { status: 'failed', failReason: 'send_failed' })
      await claims(open.id, [wallet()], { status: 'failed', failReason: 'send_failed' })
      expect(await retryFailedClaims(closed.id)).toEqual({ retried: 0, skippedClosed: 2 })
      expect(await retryFailedClaims()).toEqual({ retried: 1, skippedClosed: 2 })
      expect(await statusCount(closed.id)).toEqual({ failed: 2 })
      expect(await statusCount(open.id)).toEqual({ claimed: 1 })
      // A close in flight counts as closed
      const closing = await seed({ status: 'ended', startsAt: at(-40 * H), endsAt: at(-30 * H), created: true })
      await claims(closing.id, [wallet()], { status: 'failed', failReason: 'receiver_rejected' })
      await db.insert(beatMintBatches).values({ chain: 'polygon-amoy', kind: 'close', beatId: closing.id, tokenId: closing.tokenId!, nonce: 40, status: 'sent', txHashes: ['0xc1'] })
      expect(await retryFailedClaims(closing.id)).toEqual({ retried: 0, skippedClosed: 1 })
    })

    it('a retry that lands between a close plan and its insert wins: the close waits and the claim mints', async () => {
      const b = await seed({ status: 'ended', startsAt: at(-40 * H), endsAt: new Date(T0.getTime() - BEAT_CLAIM_GRACE_MS - MIN), created: true })
      await claims(b.id, [wallet()], { status: 'failed', failReason: 'receiver_rejected' })
      let retried: Awaited<ReturnType<typeof retryFailedClaims>> | null = null
      beatJobTestHooks.beforeInsert = async (plan) => {
        if (plan.kind !== 'close' || retried) return
        retried = await retryFailedClaims(b.id)
      }
      await runBeatTick(T0)
      expect(retried).toEqual({ retried: 1, skippedClosed: 0 })
      // The close was dropped at insert; the retried claim went out instead
      expect(fake.mempool().map((t) => t.call.kind)).toEqual(['mint'])
      fake.mine(6)
      await runBeatTick(at(MIN))
      expect(await statusCount(b.id)).toEqual({ minted: 1 })
      expect(fake.mempool()[0].call).toEqual({ kind: 'close', tokenId: BigInt(b.tokenId!) })
      fake.mine(6)
      await runBeatTick(at(2 * MIN))
      expect(fake.isClosed(BigInt(b.tokenId!))).toBe(true)
      expect(await statusCount(b.id)).toEqual({ minted: 1 })
    })

    it('M2: a cancelled BEAT that exists on chain gets a close, after everything else', async () => {
      const cancelled = await seed({ status: 'cancelled', startsAt: at(H), endsAt: at(2 * H), created: true })
      const live = await seed({ created: true })
      await claims(live.id, [wallet()])
      await runBeatTick(T0)
      expect(fake.mempool()[0].call.kind).toBe('mint')
      fake.mine(6)
      await runBeatTick(at(MIN))
      expect(fake.mempool()[0].call).toEqual({ kind: 'close', tokenId: BigInt(cancelled.tokenId!) })
      fake.mine(6)
      await runBeatTick(at(2 * MIN))
      expect(fake.isClosed(BigInt(cancelled.tokenId!))).toBe(true)
      expect((await beatOf(cancelled.id)).closedOnChainAt).toEqual(at(2 * MIN))
    })

    it('M8: a tick re-plans a stale mint at most 3 times, then ends', async () => {
      const b = await seed({ created: true })
      await claims(b.id, [wallet(), wallet()])
      const sign = vi.spyOn(fake, 'sign')
      let release!: () => void
      let locked!: () => void
      const holding = new Promise<void>((res) => { release = res })
      const ready = new Promise<void>((res) => { locked = res })
      // A delete-my-data transaction holds the claim locks for the whole tick
      const holder = db.transaction(async (tx) => {
        await tx.select({ id: beatClaims.id }).from(beatClaims).where(eq(beatClaims.beatId, b.id)).for('update')
        locked()
        await holding
      })
      await ready
      try {
        await runBeatTick(T0)
      } finally {
        release()
        await holder
      }
      expect(sign).toHaveBeenCalledTimes(3)
      expect(await batches()).toHaveLength(0)
      expect(await statusCount(b.id)).toEqual({ claimed: 2 })
    })
  })

  it('also sweeps BEAT payments, and a failing sweep does not stop minting', async () => {
    const b = await seed({ created: true })
    await claims(b.id, [wallet()])
    const [stale] = await db.insert(beatPayments).values({
      beatId: b.id, kind: 'topup', capFrom: 100, capTo: 200, method: 'card', amountCents: 200, status: 'pending',
      createdAt: new Date(Date.now() - 10 * H),
    }).returning()
    await runBeatTick(T0)
    expect(sweepBeatPayments).toHaveBeenCalledWith(T0)
    expect((await db.select().from(beatPayments).where(eq(beatPayments.id, stale.id)))[0].status).toBe('expired')
    expect(fake.mempool()).toHaveLength(1)
    fake.mine(6)
    await claims(b.id, [wallet()], { claimedAt: at(MIN) })
    vi.mocked(sweepBeatPayments).mockRejectedValueOnce(new Error('sweep down'))
    await runBeatTick(at(MIN))
    expect(await statusCount(b.id)).toEqual({ minted: 1, minting: 1 })
  })

  describe('mainnet fixes (money C1, I1, I3; attacker I1, I2; host review)', () => {
    it('ruling 4 in the DB: an unexplained revert halves the BEAT\'s batch size; successes grow it back', async () => {
      const b = await seed({ created: true })
      const ws = Array.from({ length: 8 }, wallet)
      await claims(b.id, ws)
      await runBeatTick(T0)
      fake.revertNext('unknown', { kind: 'mint' })
      fake.mine(6)
      await runBeatTick(at(MIN))
      expect((await beatOf(b.id)).maxBatch).toBe(4)
      // It survives a restart (the in-memory state is gone)
      resetBeatJobState()
      fake.mine(6)
      await runBeatTick(at(2 * MIN))
      expect((await beatOf(b.id)).maxBatch).toBe(8)
      expect(mintWallets(fake.mempool()[0])).toHaveLength(4)
      fake.mine(6)
      await runBeatTick(at(3 * MIN))
      expect((await beatOf(b.id)).maxBatch).toBe(16)
      expect(await statusCount(b.id)).toEqual({ minted: 8 })
      // Doubling past BEAT_MAX_BATCH goes back to the default (null)
      await db.update(beats).set({ maxBatch: 60 }).where(eq(beats.id, b.id))
      await claims(b.id, [wallet()])
      await runBeatTick(at(4 * MIN))
      fake.mine(6)
      await runBeatTick(at(5 * MIN))
      expect((await beatOf(b.id)).maxBatch).toBeNull()
    })

    it('a revert explained by wallets that gained code since the plan keeps the batch size', async () => {
      const b = await seed({ created: true })
      const ws = Array.from({ length: 6 }, wallet)
      await claims(b.id, ws)
      await runBeatTick(T0)
      fake.setCode(ws[0])
      fake.revertNext('InsufficientGas', { kind: 'mint' })
      fake.mine(6)
      await runBeatTick(at(MIN))
      const [first] = await batches()
      expect(first).toMatchObject({ status: 'failed', lastError: 'reverted:code_changed', codeCount: 0 })
      expect((await beatOf(b.id)).maxBatch).toBeNull()
      expect(mintWallets(fake.mempool()[0])).toHaveLength(6)
    })

    it('attacker I2: mints go round-robin across BEATs, so one BEAT\'s backlog can\'t starve another', async () => {
      const big = await seed({ created: true })
      const small = await seed({ created: true })
      await claims(big.id, Array.from({ length: 250 }, wallet))
      // The small BEAT's claim is newer than all of the big one's
      await claims(small.id, [wallet()], { claimedAt: T0 })
      await runBeatTick(T0)
      expect(fake.mempool()[0].call.tokenId).toBe(BigInt(big.tokenId!))
      fake.mine(6)
      await runBeatTick(at(MIN))
      expect(fake.mempool()[0].call.tokenId).toBe(BigInt(small.tokenId!))
      fake.mine(6)
      await runBeatTick(at(2 * MIN))
      expect(fake.mempool()[0].call.tokenId).toBe(BigInt(big.tokenId!))
    })

    it('money C1: a wrong chain id, a contract without code or a minter without the role pauses misconfigured, reported once, and marks nothing minted', async () => {
      const b = await seed({ created: true })
      let t = 0
      const tick = () => runBeatTick(at(++t * MIN))
      for (const [break_, fix] of [
        [() => fake.setChainId(137), () => fake.setChainId(80002)],
        [() => fake.setContractCode(false), () => fake.setContractCode(true)],
        [() => fake.setMinterRole(false), () => fake.setMinterRole(true)],
      ] as const) {
        await claims(b.id, [wallet()])
        await tick()
        const minted = (await statusCount(b.id)).minted ?? 0
        vi.mocked(recordJobFailure).mockClear()
        break_()
        fake.mine(6)
        await tick()
        await tick()
        expect(beatPaused('polygon-amoy')).toEqual({ paused: true, reason: 'misconfigured' })
        expect((await statusCount(b.id)).minted ?? 0).toBe(minted)
        expect(recordJobFailure).toHaveBeenCalledTimes(1)
        expect(vi.mocked(recordJobFailure).mock.calls[0][0]).toBe('beat_setup')
        fix()
        await tick()
        expect(beatPaused('polygon-amoy').paused).toBe(false)
        expect((await statusCount(b.id)).minted).toBe(minted + 1)
      }
    })

    it('money I1: nothing is signed while base fee + tip is above the ceiling (high_fees); under it the fees are capped', async () => {
      setBeats({ maxFeeGwei: 100 })
      const b = await seed({ created: true })
      await claims(b.id, [wallet()])
      fake.setBaseFee(90n * GWEI)
      fake.setFees({ maxFeePerGas: 210n * GWEI, maxPriorityFeePerGas: 30n * GWEI })
      await runBeatTick(T0)
      expect(fake.mempool()).toHaveLength(0)
      expect(await batches()).toHaveLength(0)
      expect(beatPaused('polygon-amoy')).toEqual({ paused: true, reason: 'high_fees' })
      fake.setBaseFee(50n * GWEI)
      await runBeatTick(at(MIN))
      expect(beatPaused('polygon-amoy').paused).toBe(false)
      expect(fake.mempool()[0].fees).toEqual({ maxFeePerGas: 100n * GWEI, maxPriorityFeePerGas: 30n * GWEI })
    })

    it('money I1: a reprice never goes above the ceiling; at the ceiling it keeps waiting on the tx it sent', async () => {
      setBeats({ maxFeeGwei: 100 })
      const b = await seed({ created: true })
      await claims(b.id, [wallet()])
      fake.setBaseFee(20n * GWEI)
      fake.setFees({ maxFeePerGas: 70n * GWEI, maxPriorityFeePerGas: 30n * GWEI })
      await runBeatTick(T0)
      for (let i = 1; i <= 6; i++) await runBeatTick(at(i * 11 * MIN))
      const [row] = await batches()
      const fees = fake.mempool().map((t) => t.fees.maxFeePerGas)
      expect(fees.every((f) => f <= 100n * GWEI)).toBe(true)
      const signedFees = row.txHashes.length
      expect(signedFees).toBeGreaterThan(1)
      expect(signedFees).toBeLessThan(7)
      fake.mine(6)
      await runBeatTick(at(80 * MIN))
      expect(await statusCount(b.id)).toEqual({ minted: 1 })
    })

    it('money I3: after BEAT_RPC_FAILS_BEFORE_PAUSE failed passes in a row the chain pauses rpc_down once, and recovers', async () => {
      setBeats({ rpcFailsBeforePause: 3 })
      await seed({ created: true })
      fake.setDown(true)
      for (let i = 0; i < 2; i++) await runBeatTick(at(i * MIN))
      expect(beatPaused('polygon-amoy').paused).toBe(false)
      expect(recordJobFailure).not.toHaveBeenCalled()
      for (let i = 2; i < 6; i++) await runBeatTick(at(i * MIN))
      expect(beatPaused('polygon-amoy')).toEqual({ paused: true, reason: 'rpc_down' })
      expect(recordJobFailure).toHaveBeenCalledTimes(1)
      expect(vi.mocked(recordJobFailure).mock.calls[0][0]).toBe('beat_rpc')
      fake.setDown(false)
      await runBeatTick(at(10 * MIN))
      expect(beatPaused('polygon-amoy').paused).toBe(false)
    })

    it('fix round M-6: a pass that fails for a reason other than the RPC never counts toward rpc_down, and is reported once as beat_job', async () => {
      setBeats({ rpcFailsBeforePause: 2 })
      await seed({ created: true })
      const real = fake.balanceWei
      fake.balanceWei = async () => { throw new Error('a bug, not the RPC') }
      for (let i = 0; i < 5; i++) await runBeatTick(at(i * MIN))
      fake.balanceWei = real
      expect(beatPaused('polygon-amoy').reason).not.toBe('rpc_down')
      const calls = vi.mocked(recordJobFailure).mock.calls.map((c) => c[0])
      expect(calls).toEqual(['beat_job'])
    })

    it('the low-gas floor defaults per chain: 0.1 POL on Amoy', async () => {
      setBeats({ minGasWei: null })
      await seed({ created: true })
      fake.setBalance(parseEther('0.09'))
      await runBeatTick(T0)
      expect(beatPaused('polygon-amoy')).toEqual({ paused: true, reason: 'low_gas' })
      fake.setBalance(parseEther('0.11'))
      await runBeatTick(at(MIN))
      expect(beatPaused('polygon-amoy').paused).toBe(false)
    })

    it('host review: a held BEAT\'s claims wait for Send, or for the end of its claim grace', async () => {
      const b = await seed({ created: true })
      await db.update(beats).set({ holdMints: true }).where(eq(beats.id, b.id))
      await claims(b.id, [wallet()])
      await runBeatTick(T0)
      expect(fake.mempool()).toHaveLength(0)
      await db.update(beats).set({ mintsReleasedAt: T0 }).where(eq(beats.id, b.id))
      await runBeatTick(at(MIN))
      expect(fake.mempool()).toHaveLength(1)

      const late = await seed({ created: true, startsAt: at(-30 * H), endsAt: at(-2 * H) })
      await db.update(beats).set({ holdMints: true }).where(eq(beats.id, late.id))
      await claims(late.id, [wallet()])
      fake.mine(6)
      await runBeatTick(at(2 * MIN))
      expect(fake.mempool()).toHaveLength(0) // the first BEAT's done; the late one is still held
      await runBeatTick(at(BEAT_CLAIM_GRACE_MS - 2 * H + MIN))
      expect(fake.mempool()).toHaveLength(1)
      expect(fake.mempool()[0].call.tokenId).toBe(BigInt(late.tokenId!))
    })

    it('standards I1: a live BEAT whose art isn\'t frozen is neither created nor minted, and is reported once', async () => {
      const b = await seed({ status: 'live' })
      await db.update(beats).set({ imageUrl: null }).where(eq(beats.id, b.id))
      await claims(b.id, [wallet()])
      await runBeatTick(T0)
      await runBeatTick(at(MIN))
      expect(fake.mempool()).toHaveLength(0)
      const reports = vi.mocked(recordJobFailure).mock.calls.filter((c) => c[0] === 'beat_art')
      expect(reports).toHaveLength(1)
      // On chain already but its art lost: still no mint
      const c = await seed({ created: true })
      await db.update(beats).set({ imageUrl: null }).where(eq(beats.id, c.id))
      await claims(c.id, [wallet()])
      await runBeatTick(at(2 * MIN))
      expect(fake.mempool()).toHaveLength(0)
      await db.update(beats).set({ imageUrl: 'https://cdn.virvi.test/frozen.webp' }).where(inArray(beats.id, [b.id, c.id]))
      await runBeatTick(at(3 * MIN))
      expect(fake.mempool()).toHaveLength(1)
    })

    it('fix round M-4: after Send, only the claims made up to it go out; later ones wait for another Send or the grace', async () => {
      const b = await seed({ created: true })
      await db.update(beats).set({ holdMints: true, mintsReleasedAt: at(-30 * MIN) }).where(eq(beats.id, b.id))
      const [early] = await claims(b.id, [wallet()], { claimedAt: at(-H) })
      const [late] = await claims(b.id, [wallet()], { claimedAt: at(-10 * MIN) })
      await runBeatTick(T0)
      expect(mintWallets(fake.mempool()[0])).toEqual([lc(early.wallet)])
      fake.mine(6)
      await runBeatTick(at(MIN))
      expect(fake.mempool()).toHaveLength(0)
      await db.update(beats).set({ mintsReleasedAt: at(MIN) }).where(eq(beats.id, b.id))
      await runBeatTick(at(2 * MIN))
      expect(mintWallets(fake.mempool()[0])).toEqual([lc(late.wallet)])
    })

    it('fix round I-4: a batch the balance can\'t cover shrinks to what fits; only when 1 wallet won\'t fit does the chain pause low_gas', async () => {
      setBeats({ minGasWei: parseEther('0.001') })
      const b = await seed({ created: true })
      const ws = Array.from({ length: 10 }, wallet)
      await claims(b.id, ws)
      fake.setBalance(parseEther('0.06'))
      await runBeatTick(T0)
      const tx = fake.mempool()[0]
      const n = mintWallets(tx).length
      expect(n).toBeGreaterThan(1)
      expect(n).toBeLessThan(10)
      expect(tx.gasLimit * tx.fees.maxFeePerGas).toBeLessThanOrEqual(parseEther('0.06'))
      expect(mintWallets(tx)).toEqual(ws.slice(0, n).map(lc))
      expect(beatPaused('polygon-amoy').paused).toBe(false)
      fake.mine(6)
      fake.setBalance(parseEther('0.002'))
      await runBeatTick(at(MIN))
      expect(fake.mempool()).toHaveLength(0)
      expect(beatPaused('polygon-amoy')).toEqual({ paused: true, reason: 'low_gas' })
      expect(await statusCount(b.id)).toEqual({ minted: n, claimed: 10 - n })
    })

    it('money M3: a create that reverts with BeatExists after an earlier create of ours was replaced is taken as ours, not a conflict', async () => {
      const b = await seed({ status: 'live' })
      // Nonce 0 was used on chain by "our" create, whose receipt the job never saw
      const used = await fake.sign({ kind: 'create', tokenId: 999_999n, tradeable: false }, 0)
      await fake.broadcast(used.raw)
      fake.mine(1)
      await db.insert(beatMintBatches).values({
        chain: 'polygon-amoy', kind: 'create', beatId: b.id, tokenId: b.tokenId!, nonce: 0, txHash: '0xours', txHashes: ['0xours'],
        status: 'failed', lastError: 'replaced', createdAt: at(-H),
      })
      fake.createdBeat(BigInt(b.tokenId!))
      // A lagging node let the second create's estimate pass; it mined and reverted with BeatExists
      const real = fake.estimate
      fake.estimate = async (call) => (call.kind === 'create' ? 60_000n : real(call))
      await runBeatTick(T0)
      fake.estimate = real
      fake.mine(6)
      await runBeatTick(at(MIN))
      expect(beatPaused('polygon-amoy').paused).toBe(false)
      expect((await beatOf(b.id)).createdOnChainTx).toBe('0xours')
    })
  })
})
