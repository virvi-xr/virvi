import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import bcrypt from 'bcryptjs'
import { Wallet, parseEther } from 'ethers'
import { BEAT_RETENTION_DAYS } from '@virvixr/shared'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { beatClaims, beatMintBatches, beatPayments, beats, userAuthMethods, users } from '../src/db/schema.js'
import { setBeatChainClientForTests } from '../src/beats/chain.js'
import { resetBeatJobState, runBeatTick } from '../src/beats/job.js'
import { deleteMyBeatData, scrubBeats } from '../src/beats/retention.js'
import { recordJobFailure } from '../src/errors/record.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor, type TestUser } from './helpers/factories.js'
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
const wallet = () => Wallet.createRandom().address.toLowerCase()
let nextToken = 5000

describe('BEAT privacy and retention (LIV-11)', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let fake: FakeBeatChain
  let host: TestUser
  let me: TestUser
  let other: TestUser
  const prev = config.beats

  beforeEach(async () => {
    await resetDb()
    resetBeatJobState()
    ;(config as any).beats = { ...config.beats, enabled: true, chain: 'polygon-amoy', minGasWei: parseEther('1') }
    fake = fakeBeatChain({ chain: 'polygon-amoy' })
    setBeatChainClientForTests('polygon-amoy', fake)
    setBeatChainClientForTests('polygon', null)
    app = await testApp()
    host = await createUser({ wallet: wallet() })
    me = await createUser({ wallet: wallet(), name: 'Me' })
    other = await createUser({ wallet: wallet(), name: 'Other' })
  })
  afterEach(async () => {
    ;(config as any).beats = prev
    setBeatChainClientForTests('polygon-amoy', null)
    await app.close()
  })

  async function seedBeat(o: { endsAt?: Date; created?: boolean } = {}) {
    const tokenId = nextToken++
    const [b] = await db.insert(beats).values({
      chain: 'polygon-amoy', ownerUserId: host.id, name: 'Seed', description: '', tokenId,
      startsAt: at(-H), endsAt: o.endsAt ?? at(H), status: 'live',
      ...(o.created ? { createdOnChainTx: '0xcreated', createdOnChainAt: at(-2 * H) } : {}),
    }).returning()
    const [p] = await db.insert(beatPayments).values({
      beatId: b.id, userId: host.id, kind: 'create', capFrom: 0, capTo: 100, method: 'test', amountCents: 0, status: 'paid', paidAt: at(-3 * H),
    }).returning()
    await db.update(beats).set({ paymentId: p.id }).where(eq(beats.id, b.id))
    if (o.created) fake.createdBeat(BigInt(tokenId))
    return b
  }
  const claim = async (beatId: string, user: TestUser | null, status: typeof beatClaims.$inferInsert['status'], extra: Partial<typeof beatClaims.$inferInsert> = {}) =>
    (await db.insert(beatClaims).values({
      beatId, userId: user?.id ?? null, wallet: user?.wallet ?? wallet(), displayName: 'Visitor', consentVersion: 1, status,
      claimedAt: status === 'present' ? null : at(-H), ...extra,
    }).returning())[0]
  const byId = async (id: string) => (await db.select().from(beatClaims).where(eq(beatClaims.id, id)))[0]

  describe('deleteMyBeatData', () => {
    it('deletes present, claimed and failed rows; unlinks minted; flags minting; leaves other users alone', async () => {
      const mk = async () => {
        const out: Record<string, typeof beatClaims.$inferSelect> = {}
        for (const s of ['present', 'claimed', 'failed', 'minted', 'minting'] as const) {
          const b = await seedBeat()
          out[s] = await claim(b.id, me, s, s === 'minted' ? { mintTx: null, mintedAt: at(-H) } : {})
        }
        return out
      }
      const mine = await mk()
      const bOther = await seedBeat()
      const theirs = await claim(bOther.id, other, 'claimed')
      const res = await deleteMyBeatData(me.id, T0)
      expect(res).toEqual({ deleted: 3, unlinked: 1, pending: 1 })
      for (const s of ['present', 'claimed', 'failed']) expect(await byId(mine[s].id), s).toBeUndefined()
      expect(await byId(mine.minted.id)).toMatchObject({ userId: null, displayName: null, wallet: me.wallet, status: 'minted' })
      expect(await byId(mine.minting.id)).toMatchObject({ userId: me.id, deleteRequested: true, status: 'minting' })
      expect(await byId(theirs.id)).toMatchObject({ userId: other.id, displayName: 'Visitor', deleteRequested: false })
      // Nothing left to do the second time except the flag already set
      expect(await deleteMyBeatData(me.id, T0)).toEqual({ deleted: 0, unlinked: 0, pending: 1 })
    })

    it('POST /api/analytics/me/delete counts beatClaims and runs it', async () => {
      const b = await seedBeat()
      await claim(b.id, me, 'claimed')
      const b2 = await seedBeat()
      await claim(b2.id, me, 'minted', { mintedAt: at(-H) })
      const res = await app.inject({ method: 'POST', url: '/api/analytics/me/delete', headers: { authorization: `Bearer ${tokenFor(me)}` } })
      expect(res.statusCode).toBe(200)
      expect(res.json().deleted).toMatchObject({ beatClaims: 2 })
      expect(await db.select().from(beatClaims).where(eq(beatClaims.userId, me.id))).toHaveLength(0)
      expect((await db.select().from(beatClaims)).map((c) => c.status)).toEqual(['minted'])
    })

    it('account deletion does the same, and leaves other users alone', async () => {
      await db.insert(userAuthMethods).values({ userId: me.id, type: 'email', identifier: me.email!, credentialHash: await bcrypt.hash('pw-1234', 4) })
      const b = await seedBeat()
      const claimed = await claim(b.id, me, 'claimed')
      const minted = await claim((await seedBeat()).id, me, 'minted', { mintedAt: at(-H), displayName: 'My Name' })
      const minting = await claim((await seedBeat()).id, me, 'minting')
      const theirs = await claim(b.id, other, 'claimed')
      const r = await app.inject({ method: 'DELETE', url: '/api/auth/account', payload: { password: 'pw-1234' }, headers: { authorization: `Bearer ${tokenFor(me)}` } })
      expect(r.statusCode).toBe(204)
      expect(await db.select().from(users).where(eq(users.id, me.id))).toHaveLength(0)
      expect(await byId(claimed.id)).toBeUndefined()
      expect(await byId(minted.id)).toMatchObject({ userId: null, displayName: null, wallet: me.wallet })
      expect(await byId(minting.id)).toMatchObject({ userId: null, deleteRequested: true })
      expect(await byId(theirs.id)).toMatchObject({ userId: other.id, displayName: 'Visitor' })
    })

    it('a flagged minting claim whose batch confirms ends unlinked; one whose batch fails is deleted', async () => {
      const b = await seedBeat({ created: true })
      const ok = await claim(b.id, me, 'claimed')
      await runBeatTick(T0)
      expect((await byId(ok.id)).status).toBe('minting')
      expect(await deleteMyBeatData(me.id, T0)).toEqual({ deleted: 0, unlinked: 0, pending: 1 })
      fake.mine(6)
      await runBeatTick(at(MIN))
      expect(await byId(ok.id)).toMatchObject({ status: 'minted', userId: null, displayName: null, wallet: me.wallet, deleteRequested: true })

      const b2 = await seedBeat({ created: true })
      const bad = await claim(b2.id, other, 'claimed')
      await runBeatTick(at(2 * MIN))
      expect((await byId(bad.id)).status).toBe('minting')
      await deleteMyBeatData(other.id, at(2 * MIN))
      fake.revertNext('BeatClosedError', { kind: 'mint' })
      fake.mine(6)
      await runBeatTick(at(3 * MIN))
      expect(await byId(bad.id)).toBeUndefined()
      expect((await db.select().from(beatMintBatches)).map((x) => x.status)).toContain('failed')
    })
  })

  describe('scrubBeats', () => {
    it('deletes present claims 30 days after the end, not at 29 days 23 hours; other statuses stay', async () => {
      expect(BEAT_RETENTION_DAYS).toBe(30)
      const old = await seedBeat({ endsAt: at(-30 * DAY) })
      const recent = await seedBeat({ endsAt: at(-(30 * DAY - H)) })
      const oldPresent = await claim(old.id, me, 'present')
      const oldClaimed = await claim(old.id, other, 'claimed')
      const recentPresent = await claim(recent.id, me, 'present')
      expect(await scrubBeats(T0)).toEqual({ present: 1, batches: 0 })
      expect(await byId(oldPresent.id)).toBeUndefined()
      expect(await byId(oldClaimed.id)).toBeDefined()
      expect(await byId(recentPresent.id)).toBeDefined()
      expect((await scrubBeats(at(H)))).toEqual({ present: 1, batches: 0 })
      expect(await byId(recentPresent.id)).toBeUndefined()
    })

    it('nulls batch wallets 30 days after settling (confirmed, or failed by sent time), keeps hashes and open batches', async () => {
      const b = await seedBeat()
      const mk = (nonce: number, status: 'confirmed' | 'failed' | 'sent', when: Date, extra: Partial<typeof beatMintBatches.$inferInsert> = {}) =>
        db.insert(beatMintBatches).values({
          chain: 'polygon-amoy', kind: 'mint', beatId: b.id, tokenId: 1, wallets: [wallet()], nonce, txHash: '0xabc', txHashes: ['0xabc'],
          status, createdAt: when, ...extra,
        }).returning().then((r) => r[0])
      const confOld = await mk(1, 'confirmed', at(-31 * DAY), { confirmedAt: at(-30 * DAY) })
      const confNew = await mk(2, 'confirmed', at(-31 * DAY), { confirmedAt: at(-(30 * DAY - H)) })
      const failOld = await mk(3, 'failed', at(-31 * DAY), { sentAt: at(-30 * DAY) })
      const open = await mk(4, 'sent', at(-40 * DAY), { sentAt: at(-40 * DAY) })
      expect(await scrubBeats(T0)).toEqual({ present: 0, batches: 2 })
      const row = async (id: string) => (await db.select().from(beatMintBatches).where(eq(beatMintBatches.id, id)))[0]
      expect(await row(confOld.id)).toMatchObject({ wallets: null, txHash: '0xabc', txHashes: ['0xabc'] })
      expect((await row(failOld.id)).wallets).toBeNull()
      expect((await row(confNew.id)).wallets).toHaveLength(1)
      expect((await row(open.id)).wallets).toHaveLength(1)
    })
  })
})
