import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { Wallet, parseEther, getAddress } from 'ethers'
import { BEAT_CLAIM_GRACE_MS, type BeatChain } from '@virvixr/shared'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { beatClaims, beatPayments, beats, walletBlocks } from '../src/db/schema.js'
import { setBeatChainClientForTests } from '../src/beats/chain.js'
import { resetBeatJobState, runBeatTick } from '../src/beats/job.js'
import { fulfilWaitingClaims } from '../src/beats/waiting.js'
import { scrubBeats, deleteMyBeatData } from '../src/beats/retention.js'
import { appClaim } from '../src/beats/app.js'
import { collectionFor } from '../src/beats/collection.js'
import { getBeat, listClaimants, removeBeatClaim } from '../src/beats/service.js'
import { takenCount } from '../src/beats/visitor.js'
import { linkVerifiedWallet } from '../src/auth/wallet-users.js'
import { recordJobFailure } from '../src/errors/record.js'
import { resetDb } from './helpers/db.js'
import { createUser } from './helpers/factories.js'
import { fakeBeatChain, type FakeBeatChain } from './helpers/fake-beat-chain.js'

vi.mock('../src/errors/record.js', async (orig) => ({
  ...(await orig<typeof import('../src/errors/record.js')>()),
  recordJobFailure: vi.fn(),
}))

const MIN = 60_000
const H = 60 * MIN
const DAY = 24 * H
const T0 = new Date('2026-12-01T12:00:00Z')
const at = (ms: number) => new Date(T0.getTime() + ms)
const lc = (s: string) => s.toLowerCase()
const wallet = () => Wallet.createRandom().address

type BeatRow = typeof beats.$inferSelect

describe('claims waiting for a wallet (Task 9)', () => {
  let fake: FakeBeatChain
  let hostId: string
  const prev = config.beats

  beforeEach(async () => {
    await resetDb()
    resetBeatJobState()
    vi.mocked(recordJobFailure).mockClear()
    ;(config as any).beats = { ...config.beats, enabled: true, chain: 'polygon-amoy', minGasWei: parseEther('1') }
    fake = fakeBeatChain({ chain: 'polygon-amoy' })
    setBeatChainClientForTests('polygon-amoy', fake)
    setBeatChainClientForTests('polygon', null)
    hostId = (await createUser({ wallet: wallet() })).id
  })
  afterEach(() => {
    ;(config as any).beats = prev
    setBeatChainClientForTests('polygon-amoy', null)
  })

  let nextToken = 1
  async function seed(o: { status?: BeatRow['status']; startsAt?: Date; endsAt?: Date; chain?: BeatChain; hold?: boolean; supplyCap?: number } = {}) {
    const tokenId = nextToken++
    const [b] = await db.insert(beats).values({
      chain: o.chain ?? 'polygon-amoy', ownerUserId: hostId, name: 'Seed', description: '', tokenId, imageUrl: 'https://cdn.virvi.test/frozen.webp',
      startsAt: o.startsAt ?? at(-H), endsAt: o.endsAt ?? at(H), status: o.status ?? 'live', supplyCap: o.supplyCap ?? 100, holdMints: o.hold ?? false,
      createdOnChainTx: '0xcreated', createdOnChainAt: at(-2 * H), contractAddress: fake.contract,
    }).returning()
    const [p] = await db.insert(beatPayments).values({
      beatId: b.id, userId: hostId, kind: 'create', capFrom: 0, capTo: 100, method: 'test', amountCents: 0, status: 'paid', paidAt: at(-3 * H),
    }).returning()
    await db.update(beats).set({ paymentId: p.id }).where(eq(beats.id, b.id))
    fake.createdBeat(BigInt(tokenId))
    return { ...b, paymentId: p.id }
  }
  /** A visitor with no wallet and a claim waiting for one. */
  async function waiter(beatId: string, extra: Partial<typeof beatClaims.$inferInsert> = {}) {
    const user = await createUser({ wallet: null })
    const [claim] = await db.insert(beatClaims).values({
      beatId, userId: user.id, wallet: null, displayName: 'Visitor', consentVersion: 1, status: 'waiting', source: 'app_space',
      claimedAt: at(-30 * MIN), secondsPresent: 600, ...extra,
    }).returning()
    return { user, claim }
  }
  const rowOf = async (id: string) => (await db.select().from(beatClaims).where(eq(beatClaims.id, id)))[0]
  const mintWallets = (tx: { call: { kind: string } }) => (tx.call as unknown as { wallets: string[] }).wallets.map(lc)

  it('linking a wallet sends the waiting claims to it, and the mint job picks them up', async () => {
    const b = await seed()
    const { user, claim } = await waiter(b.id)
    const w = wallet()
    await runBeatTick(T0)
    expect(fake.mempool()).toHaveLength(0) // the auto-send skips a waiting claim
    expect(await linkVerifiedWallet(user.id, w)).toBe('linked')
    const row = await rowOf(claim.id)
    expect([row.status, row.wallet, row.failReason]).toEqual(['claimed', lc(w), null])
    await runBeatTick(at(MIN))
    expect(fake.mempool()).toHaveLength(1)
    expect(mintWallets(fake.mempool()[0])).toEqual([lc(w)])
    expect((await rowOf(claim.id)).status).toBe('minting')
  })

  it('a link that finds nothing waiting changes nothing, and a failure to send never reaches the link', async () => {
    const user = await createUser({ wallet: null })
    expect(await fulfilWaitingClaims(user.id, wallet())).toEqual({ sent: 0, kept: 0 })
    const b = await seed()
    await waiter(b.id)
    const errs = vi.spyOn(console, 'error').mockImplementation(() => {})
    const spy = vi.spyOn(db, 'select').mockImplementationOnce(() => { throw new Error('db down') })
    const u2 = await createUser({ wallet: null })
    expect(await linkVerifiedWallet(u2.id, wallet())).toBe('linked')
    spy.mockRestore()
    expect(errs).toHaveBeenCalled()
    errs.mockRestore()
  })

  it('Review Focus 1: a wallet that already has this BEAT from another account keeps the claim waiting as wallet_has_it', async () => {
    const b = await seed()
    const w = wallet()
    const other = await createUser({ wallet: null })
    await db.insert(beatClaims).values({ beatId: b.id, userId: other.id, wallet: lc(w), consentVersion: 1, status: 'minted', source: 'decentraland' })
    const { user, claim } = await waiter(b.id)
    expect(await fulfilWaitingClaims(user.id, w)).toEqual({ sent: 0, kept: 1 })
    const row = await rowOf(claim.id)
    expect([row.status, row.wallet, row.failReason]).toEqual(['waiting', null, 'wallet_has_it'])
    // A later wallet that is free takes it, and the reason goes
    const w2 = wallet()
    expect(await fulfilWaitingClaims(user.id, w2)).toEqual({ sent: 1, kept: 0 })
    expect([(await rowOf(claim.id)).status, (await rowOf(claim.id)).failReason]).toEqual(['claimed', null])
  })

  it('two accounts sending the same wallet at once: one claim goes, the other stays waiting (the unique index holds)', async () => {
    const b = await seed()
    const w = wallet()
    const a = await waiter(b.id)
    const c = await waiter(b.id)
    const [r1, r2] = await Promise.all([fulfilWaitingClaims(a.user.id, w), fulfilWaitingClaims(c.user.id, w)])
    expect(r1.sent + r2.sent).toBe(1)
    expect(r1.kept + r2.kept).toBe(1)
    const rows = [await rowOf(a.claim.id), await rowOf(c.claim.id)]
    expect(rows.map((r) => r.status).sort()).toEqual(['claimed', 'waiting'])
    expect(rows.find((r) => r.status === 'waiting')!.failReason).toBe('wallet_has_it')
  })

  it('two wallets linked at once never double-send: the first to land wins', async () => {
    const b = await seed()
    const { user, claim } = await waiter(b.id)
    const [w1, w2] = [wallet(), wallet()]
    const [r1, r2] = await Promise.all([fulfilWaitingClaims(user.id, w1), fulfilWaitingClaims(user.id, w2)])
    expect(r1.sent + r2.sent).toBe(1)
    const row = await rowOf(claim.id)
    expect(row.status).toBe('claimed')
    expect([lc(w1), lc(w2)]).toContain(row.wallet)
    const all = await db.select().from(beatClaims).where(eq(beatClaims.beatId, b.id))
    expect(all).toHaveLength(1)
  })

  it('a blocked wallet takes nothing: the claims keep waiting for another wallet', async () => {
    const b = await seed()
    const { user, claim } = await waiter(b.id)
    const bad = wallet()
    await db.insert(walletBlocks).values({ wallet: lc(bad), reason: 'reissue' })
    expect(await fulfilWaitingClaims(user.id, bad)).toEqual({ sent: 0, kept: 1 })
    expect((await rowOf(claim.id)).status).toBe('waiting')
    expect(await fulfilWaitingClaims(user.id, wallet())).toEqual({ sent: 1, kept: 0 })
  })

  it('Review Focus 3: a BEAT that ended 40 days ago with review on still sends a claim fulfilled now, and waiting claims keep it open', async () => {
    const b = await seed({ status: 'ended', startsAt: at(-41 * DAY), endsAt: at(-40 * DAY), hold: true })
    const { user, claim } = await waiter(b.id)
    // Not closed on chain while a claim waits for a wallet
    await runBeatTick(T0)
    expect(fake.mempool()).toHaveLength(0)
    expect((await db.select().from(beats).where(eq(beats.id, b.id)))[0].closedOnChainAt).toBeNull()
    const w = wallet()
    expect(await fulfilWaitingClaims(user.id, w)).toEqual({ sent: 1, kept: 0 })
    expect((await rowOf(claim.id)).status).toBe('claimed')
    await runBeatTick(at(MIN))
    expect(fake.mempool()).toHaveLength(1)
    expect(mintWallets(fake.mempool()[0])).toEqual([lc(w)])
    expect(BEAT_CLAIM_GRACE_MS).toBeLessThan(40 * DAY)
  })

  it('scrubBeats 31 days on leaves waiting claims intact', async () => {
    const b = await seed({ status: 'ended', startsAt: at(-33 * DAY), endsAt: at(-32 * DAY) })
    const { claim } = await waiter(b.id)
    const [gone] = await db.insert(beatClaims).values({ beatId: b.id, consentVersion: 1, status: 'present', wallet: lc(wallet()) }).returning()
    await scrubBeats(at(0))
    expect(await rowOf(claim.id)).toMatchObject({ status: 'waiting', wallet: null })
    expect(await rowOf(gone.id)).toBeUndefined()
  })

  it("a visitor's own data deletion removes their waiting claim (nothing of it is on chain)", async () => {
    const b = await seed()
    const { user, claim } = await waiter(b.id)
    await deleteMyBeatData(user.id, T0)
    expect(await rowOf(claim.id)).toBeUndefined()
  })

  it('the host removes a waiting claim, which frees its copy', async () => {
    const b = await seed({ supplyCap: 1, hold: false })
    const { claim } = await waiter(b.id)
    expect(await takenCount(db, b.id)).toBe(1)
    const host = { userId: hostId, actor: {} as any, admin: true }
    expect(await removeBeatClaim(host, b.id, claim.id)).toEqual({ removed: true })
    expect((await rowOf(claim.id)).status).toBe('removed')
    expect(await takenCount(db, b.id)).toBe(0)
  })

  it('Review Focus 5: supply 2 with 2 waiting: the third claimer gets all_claimed and the host sees waitingCount 2', async () => {
    const b = await seed({ supplyCap: 2 })
    await waiter(b.id)
    await waiter(b.id)
    const third = await createUser({ wallet: null })
    await db.insert(beatClaims).values({ beatId: b.id, userId: third.id, consentVersion: 1, status: 'present', source: 'app_space', secondsPresent: 600, installKeyId: 'k3' })
    await expect(appClaim(b.id, { userId: third.id, installKeyId: 'k3' }, at(0))).rejects.toMatchObject({
      status: 409, code: 'all_claimed', message: 'All of these BEATs have been claimed.',
    })
    const host = { userId: hostId, actor: {} as any, admin: true }
    expect((await getBeat(host, b.id)).waitingCount).toBe(2)
  })

  it('the host list shows a waiting claim with a null wallet and the waiting status', async () => {
    const b = await seed()
    const { claim } = await waiter(b.id)
    const host = { userId: hostId, actor: {} as any, admin: true }
    const list = await listClaimants(host, b.id)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: claim.id, wallet: null, status: 'waiting' })
  })

  it("the signed-in collection lists the account's waiting claims, with the reason; the public page never does", async () => {
    const b = await seed()
    const { user } = await waiter(b.id)
    const none = await collectionFor([], { includeClaimTimes: true, waitingFor: user.id })
    expect(none).toHaveLength(1)
    expect(none[0]).toMatchObject({ status: 'waiting', name: 'Seed', earned: false })
    expect(none[0].reason).toBeUndefined()
    await db.update(beatClaims).set({ failReason: 'wallet_has_it' }).where(eq(beatClaims.userId, user.id))
    expect((await collectionFor([getAddress(wallet())], { includeClaimTimes: true, waitingFor: user.id }))[0]).toMatchObject({ status: 'waiting', reason: 'wallet_has_it' })
    expect(await collectionFor([wallet()], { includeClaimTimes: false })).toEqual([])
    const other = await createUser({ wallet: null })
    expect(await collectionFor([], { includeClaimTimes: true, waitingFor: other.id })).toEqual([])
  })
})
