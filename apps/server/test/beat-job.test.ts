import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { and, asc, eq } from 'drizzle-orm'
import { Wallet, parseEther } from 'ethers'
import { BEAT_CLAIM_GRACE_MS, type BeatChain } from '@virvixr/shared'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { beatClaims, beatMintBatches, beatPayments, beats } from '../src/db/schema.js'
import { setBeatChainClientForTests } from '../src/beats/chain.js'
import { BEAT_RECEIVER_GAS } from '../src/beats/abi.js'
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
  })

  let nextToken = 1
  /** A BEAT with a paid create payment. `created` also creates it on the fake chain and records the create. */
  async function seed(o: {
    status?: BeatRow['status']; startsAt?: Date; endsAt?: Date; chain?: BeatChain; created?: boolean; payment?: 'paid' | 'refunded'
    chainFake?: FakeBeatChain
  } = {}) {
    const tokenId = nextToken++
    const [b] = await db.insert(beats).values({
      chain: o.chain ?? 'polygon-amoy', ownerUserId: hostId, name: 'Seed', description: '', tokenId,
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

  it('a paid BEAT gets one create; after 5 confirmations on Amoy it is created, and no second create is sent', async () => {
    const b = await seed({ status: 'paid', startsAt: at(2 * H), endsAt: at(3 * H) })
    const r1 = await runBeatTick(T0)
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

  it('250 claims go out as 200 then 50, never two open at once, and all end minted', async () => {
    const b = await seed({ created: true })
    const ws = Array.from({ length: 250 }, wallet)
    await claims(b.id, ws)
    await runBeatTick(T0)
    expect(fake.mempool()).toHaveLength(1)
    expect(mintWallets(fake.mempool()[0])).toEqual(ws.slice(0, 200).map(lc))
    expect(await statusCount(b.id)).toEqual({ minting: 200, claimed: 50 })
    await runBeatTick(at(MIN))
    expect(fake.mempool()).toHaveLength(1)
    fake.mine(6)
    await runBeatTick(at(2 * MIN))
    expect(fake.mempool()).toHaveLength(1)
    expect(mintWallets(fake.mempool()[0])).toEqual(ws.slice(200).map(lc))
    expect(await statusCount(b.id)).toEqual({ minted: 200, minting: 50 })
    fake.mine(6)
    await runBeatTick(at(3 * MIN))
    expect(await statusCount(b.id)).toEqual({ minted: 250 })
    expect(fake.mintedCount(BigInt(b.tokenId!))).toBe(250)
    const done = await claimsOf(b.id)
    expect(done.every((c) => c.mintTx && c.mintedAt)).toBe(true)
    expect((await batches()).map((x) => [x.nonce, x.status, x.wallets?.length])).toEqual([[0, 'confirmed', 200], [1, 'confirmed', 50]])
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

  it('Review Focus 1: EOAs go first, then each contract wallet alone; a reverting one fails only its claim', async () => {
    const b = await seed({ created: true })
    const [e1, e2, c1, e3, c2] = [wallet(), wallet(), wallet(), wallet(), wallet()]
    fake.setCode(c1)
    fake.setCode(c2)
    fake.revertForWallet(c1, 'ERC1155InvalidReceiver')
    await claims(b.id, [e1, e2, c1, e3, c2])
    await runBeatTick(T0)
    expect(fake.mempool()).toHaveLength(1)
    expect(mintWallets(fake.mempool()[0])).toEqual([e1, e2, e3].map(lc))
    fake.mine(6)
    await runBeatTick(at(MIN))
    // c1 reverted at estimate and failed; c2 went out alone with room for its receiver
    const tx = fake.mempool()[0]
    expect(mintWallets(tx)).toEqual([lc(c2)])
    const est = fake.gasFor(tx.call)
    expect(tx.gasLimit).toBe((est + BEAT_RECEIVER_GAS) * 110n / 100n)
    fake.mine(6)
    await runBeatTick(at(2 * MIN))
    const byWallet = Object.fromEntries((await claimsOf(b.id)).map((c) => [lc(c.wallet), c]))
    expect(byWallet[lc(c1)].status).toBe('failed')
    expect(byWallet[lc(c1)].failReason).toBe('ERC1155InvalidReceiver')
    for (const w of [e1, e2, e3, c2]) expect(byWallet[lc(w)].status).toBe('minted')
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

  it('5 broadcast failures fail the claims and record a job failure; retryFailedClaims puts them back and they mint', async () => {
    const b = await seed({ created: true })
    const ws = [wallet(), wallet(), wallet()]
    await claims(b.id, ws)
    fake.failBroadcast('NETWORK_ERROR', 5)
    await runBeatTick(T0)
    let [row] = await batches()
    expect(row.status).toBe('sending')
    expect(row.attempts).toBe(1)
    expect(row.nextAttemptAt).toEqual(at(2 * MIN))
    // Not before its backoff
    await runBeatTick(at(MIN))
    expect((await batches())[0].attempts).toBe(1)
    for (let i = 1; i <= 3; i++) {
      await runBeatTick(at(i * H))
      ;[row] = await batches()
      expect(row.attempts).toBe(i + 1)
      expect(row.nextAttemptAt).toEqual(new Date(at(i * H).getTime() + 2 ** (i + 1) * MIN))
    }
    expect(recordJobFailure).not.toHaveBeenCalled()
    await runBeatTick(at(4 * H))
    ;[row] = await batches()
    expect(row.status).toBe('failed')
    expect(await statusCount(b.id)).toEqual({ failed: 3 })
    expect(recordJobFailure).toHaveBeenCalledTimes(1)
    const [job, err] = vi.mocked(recordJobFailure).mock.calls[0]
    expect(job).toMatch(/^beat/)
    for (const w of ws) expect(String((err as Error).message).toLowerCase()).not.toContain(lc(w).slice(2))
    expect(fake.mempool()).toHaveLength(0)

    expect(await retryFailedClaims(b.id)).toBe(3)
    const back = await claimsOf(b.id)
    expect(back.every((c) => c.status === 'claimed' && c.failReason === null)).toBe(true)
    await runBeatTick(at(5 * H))
    // The failed batch never used its nonce, so the new one takes it again
    expect(fake.mempool()).toHaveLength(1)
    expect(fake.mempool()[0].nonce).toBe(0)
    fake.mine(6)
    await runBeatTick(at(5 * H + MIN))
    expect(await statusCount(b.id)).toEqual({ minted: 3 })
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
    fake.mine(6)
    await runBeatTick(at(MIN))
    expect(mintWallets(fake.mempool()[0])).toEqual([lc(r1)])
    fake.mine(6)
    await runBeatTick(at(2 * MIN))
    const byWallet = Object.fromEntries((await claimsOf(b.id)).map((c) => [lc(c.wallet), c]))
    expect(byWallet[lc(e1)].status).toBe('minted')
    expect(byWallet[lc(r1)].status).toBe('failed')
    expect(byWallet[lc(r1)].failReason).toBe('receiver_rejected')
    expect((await batches()).map((x) => x.status)).toEqual(['confirmed', 'confirmed'])
  })

  it('BeatExists on create pauses the chain with id_conflict until an admin clears it', async () => {
    const b = await seed({ status: 'paid', startsAt: at(H), endsAt: at(2 * H) })
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
    await db.update(beatClaims).set({ deleteRequested: true }).where(eq(beatClaims.id, ce.id))
    fake.mine(6)
    await runBeatTick(at(MIN))
    const [kept] = await db.select().from(beatClaims).where(eq(beatClaims.id, ce.id))
    expect(kept.status).toBe('minted')
    expect(kept.userId).toBeNull()
    expect(kept.displayName).toBeNull()
    expect(kept.wallet).toBe(e1)
    // The rejecting receiver is now minting alone; it asks to be deleted, then fails
    await db.update(beatClaims).set({ deleteRequested: true }).where(and(eq(beatClaims.id, cr.id), eq(beatClaims.status, 'minting')))
    fake.mine(6)
    await runBeatTick(at(2 * MIN))
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
    expect(recordJobFailure).toHaveBeenCalledTimes(1)
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
    const b = await seed({ status: 'paid', startsAt: at(H), endsAt: at(2 * H) })
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
    const b = await seed({ status: 'paid', startsAt: at(H), endsAt: at(10 * H) })
    fake.failBroadcast('NETWORK_ERROR', 5)
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
    const b = await seed({ status: 'paid', startsAt: at(H), endsAt: at(2 * H) })
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
})
