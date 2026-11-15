import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { Transaction, Wallet, parseEther } from 'ethers'
import { BEAT_CLAIM_GRACE_MS, BEAT_MAX_BATCH, beatTxUrl } from '@virvixr/shared'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { beatClaims, beatMintBatches, beatPayments, beats } from '../src/db/schema.js'
import { setBeatChainClientForTests } from '../src/beats/chain.js'
import { beatPaused, resetBeatJobState, retryFailedClaims, runBeatTick } from '../src/beats/job.js'
import { recordJobFailure } from '../src/errors/record.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { fakeBeatChain, type FakeBeatChain } from './helpers/fake-beat-chain.js'

vi.mock('../src/errors/record.js', async (orig) => ({
  ...(await orig<typeof import('../src/errors/record.js')>()),
  recordJobFailure: vi.fn(),
}))

const H = 3_600_000
const T0 = new Date('2026-12-01T12:00:00Z')
const wallet = () => Wallet.createRandom().address.toLowerCase()

describe('admin BEAT routes (LIV-11)', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let fake: FakeBeatChain
  let admin: TestUser
  let plain: TestUser
  const prev = config.beats
  const set = (patch: Record<string, unknown>) => { ;(config as any).beats = { ...config.beats, ...patch } }

  beforeEach(async () => {
    await resetDb()
    resetBeatJobState()
    set({ enabled: true, chain: 'polygon-amoy', minGasWei: parseEther('1'), contracts: { 'polygon-amoy': '0x00000000000000000000000000000000000b3a75' } })
    fake = fakeBeatChain({ chain: 'polygon-amoy', balanceWei: parseEther('7') })
    setBeatChainClientForTests('polygon-amoy', fake)
    setBeatChainClientForTests('polygon', null)
    app = await testApp()
    admin = await createUser({ role: 'admin' })
    plain = await createUser()
  })
  afterEach(async () => {
    ;(config as any).beats = prev
    setBeatChainClientForTests('polygon-amoy', null)
    await app.close()
  })

  const call = (method: 'GET' | 'POST', url: string, u: TestUser | null = admin, payload?: unknown) =>
    app.inject({ method, url, payload: payload as any, headers: u ? { authorization: `Bearer ${tokenFor(u)}` } : {} })

  async function seedBeat(tokenId: number) {
    const [b] = await db.insert(beats).values({
      chain: 'polygon-amoy', ownerUserId: admin.id, name: `Beat ${tokenId}`, description: '', tokenId,
      startsAt: new Date(T0.getTime() - H), endsAt: new Date(T0.getTime() + H), status: 'live', createdOnChainTx: '0xc', createdOnChainAt: T0,
    }).returning()
    const [p] = await db.insert(beatPayments).values({ beatId: b.id, userId: admin.id, kind: 'create', capFrom: 0, capTo: 100, method: 'test', amountCents: 0, status: 'paid', paidAt: T0 }).returning()
    await db.update(beats).set({ paymentId: p.id }).where(eq(beats.id, b.id))
    fake.createdBeat(BigInt(tokenId))
    return b
  }

  it('are for site admins only, and 404 while BEAT is dark', async () => {
    const routes: Array<['GET' | 'POST', string, unknown?]> = [
      ['GET', '/api/admin/beats'], ['POST', '/api/admin/beats/retry-failed', {}], ['POST', '/api/admin/beats/clear-pause', { chain: 'polygon-amoy' }],
    ]
    for (const [m, url, body] of routes) {
      expect((await call(m, url, plain, body)).statusCode, `${m} ${url} plain`).toBe(403)
      expect((await call(m, url, null, body)).statusCode, `${m} ${url} anon`).toBe(401)
      expect((await call(m, url, admin, body)).statusCode, `${m} ${url} admin`).toBe(200)
    }
    set({ enabled: false })
    for (const [m, url, body] of routes) {
      for (const u of [admin, plain, null]) expect((await call(m, url, u, body)).statusCode, `${m} ${url} dark`).toBe(404)
    }
  })

  it('shows the chain, balance, pause reason, counts, failed claims and batches with explorer links', async () => {
    const b = await seedBeat(901)
    const w1 = wallet()
    await db.insert(beatClaims).values({ beatId: b.id, wallet: w1, displayName: 'F', consentVersion: 1, status: 'failed', failReason: 'receiver_rejected' }).returning()
    await db.insert(beatClaims).values({ beatId: b.id, wallet: wallet(), consentVersion: 1, status: 'claimed', claimedAt: T0 })
    await db.insert(beatClaims).values({ beatId: b.id, wallet: wallet(), consentVersion: 1, status: 'present' })
    await runBeatTick(T0) // mints the claimed one
    let res = await call('GET', '/api/admin/beats')
    expect(res.statusCode).toBe(200)
    let json = res.json()
    expect(json.chains).toEqual([{
      chain: 'polygon-amoy', contract: '0x00000000000000000000000000000000000b3a75', minter: fake.minterAddress,
      balanceWei: parseEther('7').toString(), balanceError: false, paused: false, reason: null, missing: [],
      minGasWei: parseEther('1').toString(), batchCostWei: expect.any(String), topUpWei: null,
    }])
    expect(json.counts).toEqual({ claimed: 0, minting: 1, failed: 1, givenUp: 0 })
    expect(json.failed).toEqual([{ beatId: b.id, name: 'Beat 901', wallet: w1, failReason: 'receiver_rejected', retryable: true }])
    expect(json.batches).toHaveLength(1)
    const [batch] = await db.select().from(beatMintBatches)
    expect(json.batches[0]).toMatchObject({ id: batch.id, chain: 'polygon-amoy', kind: 'mint', tokenId: '901', nonce: batch.nonce, status: 'sent', attempts: batch.attempts })
    expect(json.batches[0].txUrl).toBe(beatTxUrl('polygon-amoy', batch.txHashes.at(-1)!))

    // Paused for low gas
    fake.setBalance(parseEther('0.5'))
    await runBeatTick(new Date(T0.getTime() + 60_000))
    res = await call('GET', '/api/admin/beats')
    json = res.json()
    expect(json.chains[0]).toMatchObject({ balanceWei: parseEther('0.5').toString(), paused: true, reason: 'low_gas' })
  })

  it('lists chains with a client, and the server chain even without one; a chain with no contract shows contract null; batches without a hash have no link', async () => {
    set({ contracts: {} })
    const b = await seedBeat(902)
    await db.insert(beatMintBatches).values({ chain: 'polygon-amoy', kind: 'mint', beatId: b.id, tokenId: 902, nonce: 7, status: 'failed', txHashes: [] })
    const json = (await call('GET', '/api/admin/beats')).json()
    expect(json.chains.map((c: { chain: string; contract: unknown }) => [c.chain, c.contract])).toEqual([['polygon-amoy', null]])
    expect(json.batches[0].txUrl).toBeNull()
    setBeatChainClientForTests('polygon-amoy', null)
    set({ minterKey: null })
    // The server's own chain is shown as not set up rather than hidden (M4); another chain without a client is left out
    expect((await call('GET', '/api/admin/beats')).json().chains).toEqual([{
      chain: 'polygon-amoy', contract: null, minter: null, balanceWei: null, balanceError: false, paused: true, reason: 'no_client',
      missing: ['BEAT_CONTRACT_POLYGON_AMOY', 'BEAT_MINTER_KEY'], minGasWei: parseEther('1').toString(), batchCostWei: null, topUpWei: null,
    }])
    set({ contracts: { 'polygon-amoy': '0x00000000000000000000000000000000000b3a75' } })
    expect((await call('GET', '/api/admin/beats')).json().chains[0]).toMatchObject({ contract: '0x00000000000000000000000000000000000b3a75', missing: ['BEAT_MINTER_KEY'] })
  })

  it('links the hash that mined (tx_hash), not the newest one signed; literal URLs on both chains', async () => {
    const b = await seedBeat(910)
    const h = (c: string) => '0x' + c.repeat(64)
    await db.insert(beatMintBatches).values([
      { chain: 'polygon-amoy', kind: 'mint', beatId: b.id, tokenId: 910, nonce: 1, status: 'confirmed', txHash: h('a'), txHashes: [h('a'), h('b')] },
      { chain: 'polygon', kind: 'mint', beatId: b.id, tokenId: 910, nonce: 2, status: 'confirmed', txHash: h('c'), txHashes: [h('c')] },
      { chain: 'polygon-amoy', kind: 'mint', beatId: b.id, tokenId: 910, nonce: 3, status: 'sent', txHash: null, txHashes: [h('d'), h('e')] },
    ])
    const rows = (await call('GET', '/api/admin/beats')).json().batches as Array<{ nonce: number; txUrl: string | null }>
    const url = (n: number) => rows.find((r) => r.nonce === n)!.txUrl
    expect(url(1)).toBe(`https://amoy.polygonscan.com/tx/0x${'a'.repeat(64)}`)
    expect(url(2)).toBe(`https://polygonscan.com/tx/0x${'c'.repeat(64)}`)
    expect(url(3)).toBe(`https://amoy.polygonscan.com/tx/0x${'e'.repeat(64)}`)
  })

  it('a failed balance read shows balanceWei null with balanceError, a good one shows false', async () => {
    expect((await call('GET', '/api/admin/beats')).json().chains[0]).toMatchObject({ balanceWei: parseEther('7').toString(), balanceError: false })
    fake.setDown(true)
    const res = await call('GET', '/api/admin/beats')
    expect(res.statusCode).toBe(200)
    expect(res.json().chains[0]).toMatchObject({ balanceWei: null, balanceError: true })
  })

  it('keeps only the last 50 batches', async () => {
    const b = await seedBeat(903)
    await db.insert(beatMintBatches).values(Array.from({ length: 55 }, (_, i) => ({ chain: 'polygon-amoy' as const, kind: 'mint' as const, beatId: b.id, tokenId: 903, nonce: i, status: 'confirmed' as const })))
    const rows = (await call('GET', '/api/admin/beats')).json().batches as Array<{ nonce: number }>
    expect(rows.map((r) => r.nonce)).toEqual(Array.from({ length: 50 }, (_, i) => 54 - i))
  })

  it('retry-failed puts failed claims back to claimed, for one BEAT or all', async () => {
    const a = await seedBeat(904)
    const c = await seedBeat(905)
    for (const beat of [a, a, c]) await db.insert(beatClaims).values({ beatId: beat.id, wallet: wallet(), consentVersion: 1, status: 'failed', failReason: 'reverted' })
    expect((await call('POST', '/api/admin/beats/retry-failed', admin, { beatId: a.id })).json()).toEqual({ retried: 2, skippedClosed: 0 })
    expect((await db.select().from(beatClaims).where(eq(beatClaims.beatId, c.id)))[0].status).toBe('failed')
    expect((await call('POST', '/api/admin/beats/retry-failed', admin, {})).json()).toEqual({ retried: 1, skippedClosed: 0 })
    expect((await db.select().from(beatClaims)).every((r) => r.status === 'claimed' && r.failReason === null)).toBe(true)
    expect((await call('POST', '/api/admin/beats/retry-failed', admin, { beatId: 'nope' })).statusCode).toBe(400)
  })

  it('retry-failed leaves the failed claims of a BEAT closed on chain, and says how many', async () => {
    const shut = await seedBeat(907)
    await db.update(beats).set({ status: 'ended', closedOnChainAt: T0 }).where(eq(beats.id, shut.id))
    const open = await seedBeat(908)
    for (const beat of [shut, shut, open]) await db.insert(beatClaims).values({ beatId: beat.id, wallet: wallet(), consentVersion: 1, status: 'failed', failReason: 'send_failed' })
    expect((await call('POST', '/api/admin/beats/retry-failed', admin, {})).json()).toEqual({ retried: 1, skippedClosed: 2 })
    expect((await db.select().from(beatClaims).where(eq(beatClaims.beatId, shut.id))).map((r) => r.status)).toEqual(['failed', 'failed'])
  })

  it('clear-pause lifts an id_conflict pause and rejects an unknown chain', async () => {
    const [b] = await db.insert(beats).values({
      chain: 'polygon-amoy', ownerUserId: admin.id, name: 'Clash', description: '', tokenId: 906,
      startsAt: new Date(T0.getTime() + H), endsAt: new Date(T0.getTime() + 2 * H), status: 'paid',
    }).returning()
    const [p] = await db.insert(beatPayments).values({ beatId: b.id, userId: admin.id, kind: 'create', capFrom: 0, capTo: 100, method: 'test', amountCents: 0, status: 'paid', paidAt: T0 }).returning()
    await db.update(beats).set({ paymentId: p.id }).where(eq(beats.id, b.id))
    fake.createdBeat(906n) // someone else's
    await runBeatTick(T0)
    expect(beatPaused('polygon-amoy').reason).toBe('id_conflict')
    expect((await call('GET', '/api/admin/beats')).json().chains[0]).toMatchObject({ paused: true, reason: 'id_conflict' })
    const res = await call('POST', '/api/admin/beats/clear-pause', admin, { chain: 'polygon-amoy' })
    expect(res.json()).toEqual({ ok: true })
    expect(beatPaused('polygon-amoy')).toEqual({ paused: false, reason: null })
    for (const body of [{ chain: 'ethereum' }, {}, { chain: 5 }]) {
      const bad = await call('POST', '/api/admin/beats/clear-pause', admin, body)
      expect(bad.statusCode).toBe(400)
      expect(bad.json().error).toBe('bad_chain')
    }
  })

  describe('give up on failed claims and close', () => {
    const MIN = 60_000
    /** An ended BEAT on chain; `ago` is how long before now it ended (real time: the route reads the clock). */
    async function endedBeat(tokenId: number, ago: number) {
      const b = await seedBeat(tokenId)
      const endsAt = new Date(Date.now() - ago)
      await db.update(beats).set({ status: 'ended', startsAt: new Date(endsAt.getTime() - H), endsAt }).where(eq(beats.id, b.id))
      return b
    }
    const failed = (beatId: string, failReason: string | null) =>
      db.insert(beatClaims).values({ beatId, wallet: wallet(), consentVersion: 1, status: 'failed', failReason }).returning()

    it('marks the retryable failed claims given_up (final ones untouched), and the next tick closes the BEAT', async () => {
      const b = await endedBeat(920, BEAT_CLAIM_GRACE_MS + MIN)
      const [r1] = await failed(b.id, 'send_failed')
      const [r2] = await failed(b.id, null)
      const [f1] = await failed(b.id, 'receiver_rejected')
      await runBeatTick(new Date())
      expect(fake.mempool()).toHaveLength(0) // held open by the retryable failures
      const res = await call('POST', `/api/admin/beats/${b.id}/give-up`)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ givenUp: 2 })
      const rows = await db.select().from(beatClaims).where(eq(beatClaims.beatId, b.id))
      const reason = (id: string) => rows.find((r) => r.id === id)!
      expect([reason(r1.id), reason(r2.id)].map((r) => [r.status, r.failReason])).toEqual([['failed', 'given_up'], ['failed', 'given_up']])
      expect(reason(f1.id).failReason).toBe('receiver_rejected')
      await runBeatTick(new Date())
      expect(fake.mempool().map((t) => t.call)).toEqual([{ kind: 'close', tokenId: 920n }])
    })

    it('is refused with 409 before the claim grace is over, or for a BEAT that has not ended; 404 for an unknown one', async () => {
      const b = await endedBeat(921, BEAT_CLAIM_GRACE_MS - MIN)
      await failed(b.id, 'reverted')
      const res = await call('POST', `/api/admin/beats/${b.id}/give-up`)
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toBe('too_early')
      const live = await seedBeat(922)
      await failed(live.id, 'reverted')
      expect((await call('POST', `/api/admin/beats/${live.id}/give-up`)).statusCode).toBe(409)
      expect((await db.select().from(beatClaims)).every((r) => r.failReason === 'reverted')).toBe(true)
      expect((await call('POST', '/api/admin/beats/00000000-0000-4000-8000-000000000000/give-up')).statusCode).toBe(404)
      expect((await call('POST', '/api/admin/beats/nope/give-up')).statusCode).toBe(400)
    })

    it('is for site admins only, and 404 while BEAT is dark', async () => {
      const b = await endedBeat(923, BEAT_CLAIM_GRACE_MS + MIN)
      expect((await call('POST', `/api/admin/beats/${b.id}/give-up`, plain)).statusCode).toBe(403)
      expect((await call('POST', `/api/admin/beats/${b.id}/give-up`, null)).statusCode).toBe(401)
      set({ enabled: false })
      expect((await call('POST', `/api/admin/beats/${b.id}/give-up`)).statusCode).toBe(404)
    })

    it('retry skips given_up claims', async () => {
      const b = await endedBeat(924, BEAT_CLAIM_GRACE_MS + MIN)
      await failed(b.id, 'given_up')
      const [other] = await failed(b.id, 'reverted')
      expect(await retryFailedClaims(b.id)).toEqual({ retried: 1, skippedClosed: 0 })
      expect(await retryFailedClaims()).toEqual({ retried: 0, skippedClosed: 0 })
      const rows = await db.select().from(beatClaims).where(eq(beatClaims.beatId, b.id))
      expect(rows.map((r) => [r.id === other.id, r.status, r.failReason]).sort()).toEqual([[false, 'failed', 'given_up'], [true, 'claimed', null]])
    })

    it('M5: given-up claims are listed as not retryable and are not counted as failed', async () => {
      const b = await endedBeat(929, BEAT_CLAIM_GRACE_MS + MIN)
      await failed(b.id, 'given_up')
      await failed(b.id, 'reverted')
      const json = (await call('GET', '/api/admin/beats')).json()
      expect(json.counts).toMatchObject({ failed: 1, givenUp: 1 })
      expect(json.failed.map((f: { failReason: string; retryable: boolean }) => [f.failReason, f.retryable]).sort()).toEqual([['given_up', false], ['reverted', true]])
    })

    it('the overview lists the BEATs a give-up can close: ended past the grace, not closed, with retryable failed claims', async () => {
      const eligible = await endedBeat(925, BEAT_CLAIM_GRACE_MS + MIN)
      await failed(eligible.id, 'send_failed')
      await failed(eligible.id, 'reverted')
      await failed(eligible.id, 'receiver_rejected')
      const early = await endedBeat(926, BEAT_CLAIM_GRACE_MS - MIN)
      await failed(early.id, 'send_failed')
      const finalOnly = await endedBeat(927, BEAT_CLAIM_GRACE_MS + MIN)
      await failed(finalOnly.id, 'given_up')
      const shut = await endedBeat(928, BEAT_CLAIM_GRACE_MS + MIN)
      await db.update(beats).set({ closedOnChainAt: new Date() }).where(eq(beats.id, shut.id))
      await failed(shut.id, 'send_failed')
      expect((await call('GET', '/api/admin/beats')).json().held).toEqual([{ beatId: eligible.id, name: 'Beat 925', retryable: 2 }])
    })
  })

  describe('low-gas top-up', () => {
    it('gives the balance, the minimum, and a top-up of the minimum plus one full batch at the fees the job last signed', async () => {
      const b = await seedBeat(930)
      for (let i = 0; i < 3; i++) await db.insert(beatClaims).values({ beatId: b.id, wallet: wallet(), consentVersion: 1, status: 'claimed', claimedAt: new Date(T0.getTime() - H + i) })
      await runBeatTick(T0) // signs a mint of 3: the job now knows its gas and fees
      const [batch] = await db.select().from(beatMintBatches)
      const tx = Transaction.from(batch.rawTx!)
      const perBatch = ((tx.gasLimit * BigInt(BEAT_MAX_BATCH) + 2n) / 3n) * tx.maxFeePerGas!
      // Not low yet: the fields are there, but no top-up is suggested
      let c = (await call('GET', '/api/admin/beats')).json().chains[0]
      expect(c).toMatchObject({ minGasWei: parseEther('1').toString(), batchCostWei: perBatch.toString(), topUpWei: null })
      fake.setBalance(parseEther('0.25'))
      await runBeatTick(new Date(T0.getTime() + 60_000))
      c = (await call('GET', '/api/admin/beats')).json().chains[0]
      expect(c).toMatchObject({
        reason: 'low_gas', balanceWei: parseEther('0.25').toString(), minGasWei: parseEther('1').toString(),
        batchCostWei: perBatch.toString(), topUpWei: (parseEther('1') + perBatch - parseEther('0.25')).toString(),
      })
    })

    const GWEI = 1_000_000_000n
    async function storedBatch(b: { id: string; tokenId: number | null }, nonce: number, call: any, maxFeePerGas: bigint, createdAt: Date) {
      const signed = await fake.sign(call, nonce, { maxFeePerGas, maxPriorityFeePerGas: GWEI }, undefined)
      await db.insert(beatMintBatches).values({
        chain: 'polygon-amoy', kind: call.kind, beatId: b.id, tokenId: b.tokenId!, nonce, status: 'confirmed',
        wallets: call.kind === 'mint' ? call.wallets : null, rawTx: signed.raw, txHash: signed.hash, txHashes: [signed.hash], createdAt,
      })
      return signed
    }

    it('I1: works the estimate out from the stored batches, so it survives a restart and a pause that never signs', async () => {
      const b = await seedBeat(931)
      const big = await storedBatch(b, 1, { kind: 'mint', tokenId: 931n, wallets: [wallet(), wallet(), wallet(), wallet()] }, 40n * GWEI, new Date(T0.getTime() - 3 * H))
      await storedBatch(b, 2, { kind: 'mint', tokenId: 931n, wallets: [wallet()] }, 50n * GWEI, new Date(T0.getTime() - 2 * H))
      // M2: the newest signing (here a reprice-sized fee on a close) sets the fee, the largest mint the gas
      await storedBatch(b, 3, { kind: 'close', tokenId: 931n }, 90n * GWEI, new Date(T0.getTime() - H))
      resetBeatJobState() // a restart: nothing in memory
      fake.setBalance(parseEther('0.25'))
      await runBeatTick(T0) // paused for low gas before anything is signed
      const perBatch = ((big.gasLimit * BigInt(BEAT_MAX_BATCH) + 3n) / 4n) * 90n * GWEI
      const c = (await call('GET', '/api/admin/beats')).json().chains[0]
      expect(c).toMatchObject({ reason: 'low_gas', batchCostWei: perBatch.toString(), topUpWei: (parseEther('1') + perBatch - parseEther('0.25')).toString() })
    })

    it('M2: a reprice (the batch re-signed at higher fees) raises the estimate', async () => {
      const b = await seedBeat(932)
      const call2 = { kind: 'mint', tokenId: 932n, wallets: [wallet(), wallet()] }
      const first = await storedBatch(b, 1, call2, 40n * GWEI, new Date(T0.getTime() - H))
      const before = (await call('GET', '/api/admin/beats')).json().chains[0].batchCostWei
      const resigned = await fake.sign(call2 as any, 1, { maxFeePerGas: 80n * GWEI, maxPriorityFeePerGas: GWEI }, first.gasLimit)
      await db.update(beatMintBatches).set({ rawTx: resigned.raw, txHash: resigned.hash }).where(eq(beatMintBatches.nonce, 1))
      const after = (await call('GET', '/api/admin/beats')).json().chains[0].batchCostWei
      expect(BigInt(after)).toBe(BigInt(before) * 2n)
    })

    it('M1: never suggests a top-up of 0: with the balance above the minimum, the top-up is null', async () => {
      const b = await seedBeat(933)
      await db.insert(beatClaims).values({ beatId: b.id, wallet: wallet(), consentVersion: 1, status: 'claimed', claimedAt: T0 })
      fake.setBalance(parseEther('1.5'))
      fake.setFees({ maxFeePerGas: 100_000n * GWEI, maxPriorityFeePerGas: GWEI }) // the batch costs more than the balance
      await runBeatTick(T0)
      const c = (await call('GET', '/api/admin/beats')).json().chains[0]
      expect(c).toMatchObject({ reason: 'low_gas', batchCostWei: null, topUpWei: null })
    })

    it('without a batch to go by, the top-up is the minimum minus the balance', async () => {
      fake.setBalance(parseEther('0.25'))
      await runBeatTick(T0)
      const c = (await call('GET', '/api/admin/beats')).json().chains[0]
      expect(c).toMatchObject({ reason: 'low_gas', minGasWei: parseEther('1').toString(), batchCostWei: null, topUpWei: parseEther('0.75').toString() })
    })
  })
})
