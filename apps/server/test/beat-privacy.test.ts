import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import bcrypt from 'bcryptjs'
import { Wallet, parseEther } from 'ethers'
import { BEAT_RETENTION_DAYS } from '@virvixr/shared'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { beatClaims, beatMintBatches, beatNetworkClaims, beatPayments, beats, beatScenes, raffleDraws, raffleEntries, raffles, userAuthMethods, users } from '../src/db/schema.js'
import { setBeatChainClientForTests } from '../src/beats/chain.js'
import { resetBeatJobState, runBeatTick } from '../src/beats/job.js'
import { linkVerifiedWallet } from '../src/auth/wallet-users.js'
import { issueScenePass } from '../src/auth/scene-pass.js'
import { deleteMyBeatData, scrubBeats } from '../src/beats/retention.js'
import { recordJobFailure } from '../src/errors/record.js'
import { resetDb } from './helpers/db.js'
import { testApp, createScene, createUser, tokenFor, type TestUser } from './helpers/factories.js'
import { fakeBeatChain, type FakeBeatChain, FAKE_BEAT_CONTRACT } from './helpers/fake-beat-chain.js'

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
      chain: 'polygon-amoy', ownerUserId: host.id, name: 'Seed', description: '', tokenId, imageUrl: 'https://cdn.virvi.test/frozen.webp',
      startsAt: at(-H), endsAt: o.endsAt ?? at(H), status: 'live',
      ...(o.created ? { createdOnChainTx: '0xcreated', createdOnChainAt: at(-2 * H), contractAddress: FAKE_BEAT_CONTRACT } : {}),
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
          out[s] = await claim(b.id, me, s, s === 'minted' ? { mintTx: null, mintedAt: at(-H), eventCheckedInAt: at(-2 * H), secondsAtEventScan: 60, appConsentVersion: 1, appConsentedAt: at(-2 * H) } : {})
        }
        return out
      }
      const mine = await mk()
      const bOther = await seedBeat()
      const theirs: Record<string, typeof beatClaims.$inferSelect> = {}
      for (const st of ['present', 'claimed', 'minting', 'minted', 'failed'] as const) {
        theirs[st] = await claim((await seedBeat()).id, other, st, { displayName: `Other ${st}` })
      }
      void bOther
      const res = await deleteMyBeatData(me.id, T0)
      expect(res).toEqual({ deleted: 3, unlinked: 1, pending: 1 })
      for (const s of ['present', 'claimed', 'failed']) expect(await byId(mine[s].id), s).toBeUndefined()
      // M1: only the wallet stays (it is on chain); time present and the consent and claim times go with the link
      expect(await byId(mine.minted.id)).toMatchObject({
        userId: null, displayName: null, wallet: me.wallet, status: 'minted', secondsPresent: null, lastSeenAt: null, consentedAt: null, claimedAt: null,
        eventCheckedInAt: null, secondsAtEventScan: null, appConsentedAt: null,
      })
      expect(await byId(mine.minting.id)).toMatchObject({ userId: me.id, deleteRequested: true, status: 'minting' })
      for (const st of Object.keys(theirs)) {
        expect(await byId(theirs[st].id), `other user's ${st} claim`).toMatchObject({ status: st, userId: other.id, displayName: `Other ${st}`, deleteRequested: false })
      }
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

    it('locks the user\'s claims first: a claim the job moves out of minting while it waits is still deleted', async () => {
      const b = await seedBeat()
      const spare = await claim(b.id, me, 'claimed')
      const racing = await claim((await seedBeat()).id, me, 'minting')
      let release!: () => void
      const gate = new Promise<void>((r) => { release = r })
      let locked!: () => void
      const held = new Promise<void>((r) => { locked = r })
      // The job's settle: minting -> failed, uncommitted while delete-my-data starts
      const job = db.transaction(async (tx) => {
        await tx.update(beatClaims).set({ status: 'failed', failReason: 'reverted' }).where(eq(beatClaims.id, racing.id))
        locked()
        await gate
      })
      await held
      const del = deleteMyBeatData(me.id, T0)
      let done = false
      void del.then(() => { done = true })
      await new Promise((r) => setTimeout(r, 400))
      expect(done).toBe(false) // it waits on the job's row
      release()
      await job
      expect(await del).toEqual({ deleted: 2, unlinked: 0, pending: 0 })
      expect(await byId(racing.id)).toBeUndefined()
      expect(await byId(spare.id)).toBeUndefined()
    })

    it('admin deleting a user removes their BEAT data too', async () => {
      const admin = await createUser({ role: 'admin' })
      const claimed = await claim((await seedBeat()).id, me, 'claimed')
      const minted = await claim((await seedBeat()).id, me, 'minted', { mintedAt: at(-H), displayName: 'Named' })
      const r = await app.inject({ method: 'DELETE', url: `/api/admin/users/${me.id}`, headers: { authorization: `Bearer ${tokenFor(admin)}` } })
      expect(r.statusCode).toBe(204)
      expect(await byId(claimed.id)).toBeUndefined()
      expect(await byId(minted.id)).toMatchObject({ userId: null, displayName: null, wallet: me.wallet })
    })

    it('absorbing a visitor shell moves its claims, except on BEATs the absorbing user already claimed', async () => {
      const w = wallet()
      const shell = await createUser({ role: 'viewer', email: null, wallet: w, name: 'Shell' })
      const account = await createUser({ role: 'creator' })
      const free = await seedBeat()
      const both = await seedBeat()
      const moved = await claim(free.id, shell, 'claimed', { displayName: 'Shell name' })
      const dup = await claim(both.id, shell, 'claimed', { displayName: 'Shell dup' })
      const keep = await claim(both.id, account, 'claimed', { wallet: wallet(), displayName: 'Account name' })
      expect(await linkVerifiedWallet(account.id, w)).toBe('linked')
      expect(await db.select().from(users).where(eq(users.id, shell.id))).toHaveLength(0)
      expect(await byId(moved.id)).toMatchObject({ userId: account.id, displayName: 'Shell name' })
      // I3: the visitor's own claim on the shared BEAT isn't left behind with no user: not minted, so it's deleted
      expect(await byId(dup.id)).toBeUndefined()
      expect(await byId(keep.id)).toMatchObject({ userId: account.id, displayName: 'Account name' })
      // and the account's delete-my-data now reaches the moved claim
      expect(await deleteMyBeatData(account.id, T0)).toMatchObject({ deleted: 2 })
      expect(await byId(moved.id)).toBeUndefined()
    })
  })

  it('I3: absorbing, a minted visitor claim on a BEAT the account also claimed is unlinked; a minting one is flagged', async () => {
    const w = wallet()
    const shell = await createUser({ role: 'viewer', email: null, wallet: w, name: 'Shell' })
    const account = await createUser({ role: 'creator' })
    const b1 = await seedBeat()
    const b2 = await seedBeat()
    const minted = await claim(b1.id, shell, 'minted', { displayName: 'Shell minted', mintedAt: at(-H), secondsPresent: 900, lastSeenAt: at(-H) })
    const minting = await claim(b2.id, shell, 'minting', { displayName: 'Shell minting' })
    await claim(b1.id, account, 'claimed', { wallet: wallet() })
    await claim(b2.id, account, 'claimed', { wallet: wallet() })
    expect(await linkVerifiedWallet(account.id, w)).toBe('linked')
    expect(await byId(minted.id)).toMatchObject({
      userId: null, displayName: null, wallet: w, status: 'minted', secondsPresent: null, lastSeenAt: null, consentedAt: null, claimedAt: null,
    })
    expect(await byId(minting.id)).toMatchObject({ status: 'minting', deleteRequested: true })
  })

  describe('host and cancel views (I2, I4)', () => {
    it('I2: the host\'s claimant list leaves out claims their visitor asked to delete', async () => {
      const b = await seedBeat()
      await claim(b.id, me, 'minting', { deleteRequested: true, displayName: 'Gone' })
      await claim(b.id, other, 'claimed', { displayName: 'Still here' })
      const res = await app.inject({ method: 'GET', url: `/api/beats/${b.id}/claimants`, headers: { authorization: `Bearer ${tokenFor(host)}` } })
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().map((c: { displayName: string }) => c.displayName)).toEqual(['Still here'])
    })

    it('I4: cancelling deletes the tracked (present) claims, and Stop on the cancelled BEAT answers ok', async () => {
      const scene = (await createScene(host, 'Cancel')).scene.id
      const [b] = await db.insert(beats).values({
        chain: 'polygon-amoy', ownerUserId: host.id, name: 'Soon', description: '', startsAt: new Date(Date.now() + 20 * MIN),
        endsAt: new Date(Date.now() + 2 * H), status: 'draft',
      }).returning()
      await db.insert(beatScenes).values({ beatId: b.id, sceneId: scene })
      const mine = await claim(b.id, me, 'present')
      const theirs = await claim(b.id, other, 'present')
      const res = await app.inject({ method: 'POST', url: `/api/beats/${b.id}/cancel`, headers: { authorization: `Bearer ${tokenFor(host)}` } })
      expect(res.statusCode, res.body).toBe(200)
      expect(await byId(mine.id)).toBeUndefined()
      expect(await byId(theirs.id)).toBeUndefined()
      const pass = issueScenePass(app, me as any, me.wallet!, { sceneId: scene, locationId: null }).accessToken
      const stop = await app.inject({ method: 'DELETE', url: `/api/scenes/${scene}/beat/${b.id}/track`, headers: { authorization: `Bearer ${pass}` } })
      expect(stop.statusCode, stop.body).toBe(204)
    })
  })

  describe('raffle entries when a visitor is absorbed', () => {
    async function raffle(name: string) {
      const scene = (await createScene(host, name)).scene.id
      const [r] = await db.insert(raffles).values({ sceneId: scene, createdBy: host.id, name, prize: 'A hat', winnersCount: 1, status: 'open' }).returning()
      return r
    }
    const entry = async (raffleId: string, u: TestUser, w: string, displayName: string) =>
      (await db.insert(raffleEntries).values({ raffleId, userId: u.id, wallet: w, displayName, consentVersion: 1, secondsPresent: 120 }).returning())[0]
    const entryById = async (id: string) => (await db.select().from(raffleEntries).where(eq(raffleEntries.id, id)))[0]

    it('move to the absorbing account; where it already entered the same raffle, its own entry is kept and the visitor\'s dropped', async () => {
      const w = wallet()
      const shell = await createUser({ role: 'viewer', email: null, wallet: w, name: 'Shell' })
      const account = await createUser({ role: 'creator' })
      const solo = await raffle('Solo')
      const both = await raffle('Both')
      const moved = await entry(solo.id, shell, w, 'Shell name')
      const dup = await entry(both.id, shell, w, 'Shell dup')
      const keep = await entry(both.id, account, wallet(), 'Account name')
      expect(await linkVerifiedWallet(account.id, w)).toBe('linked')
      expect(await db.select().from(users).where(eq(users.id, shell.id))).toHaveLength(0)
      expect(await entryById(moved.id)).toMatchObject({ userId: account.id, wallet: w, displayName: 'Shell name', secondsPresent: 120 })
      expect(await entryById(dup.id)).toBeUndefined()
      expect(await entryById(keep.id)).toMatchObject({ userId: account.id, displayName: 'Account name' })
      expect((await db.select().from(raffleEntries).where(eq(raffleEntries.userId, account.id))).map((e) => e.id).sort()).toEqual([moved.id, keep.id].sort())
    })

    it('M3: where the visitor\'s duplicate entry won a draw, it is the one kept (moved), and the account\'s losing one goes', async () => {
      const w = wallet()
      const shell = await createUser({ role: 'viewer', email: null, wallet: w, name: 'Shell' })
      const account = await createUser({ role: 'creator' })
      const r = await raffle('Won')
      const winner = await entry(r.id, shell, w, 'Shell winner')
      const loser = await entry(r.id, account, wallet(), 'Account loser')
      await db.insert(raffleDraws).values({ raffleId: r.id, mode: 'one_per_person', pool: [], seed: 's', winnerEntryIds: [winner.id] })
      // and where the account's own entry won, it stays and the visitor's goes
      const r2 = await raffle('Mine won')
      const theirs = await entry(r2.id, shell, w, 'Shell other')
      const mine = await entry(r2.id, account, wallet(), 'Account winner')
      await db.insert(raffleDraws).values({ raffleId: r2.id, mode: 'one_per_person', pool: [], seed: 's', winnerEntryIds: [mine.id] })
      expect(await linkVerifiedWallet(account.id, w)).toBe('linked')
      expect(await entryById(winner.id)).toMatchObject({ userId: account.id, displayName: 'Shell winner' })
      expect(await entryById(loser.id)).toBeUndefined()
      expect(await entryById(mine.id)).toMatchObject({ userId: account.id })
      expect(await entryById(theirs.id)).toBeUndefined()
    })

    it('a visitor that keeps its account (it owns a scene) still hands its entries over', async () => {
      const w = wallet()
      const shell = await createUser({ role: 'viewer', email: null, wallet: w, name: 'Shell' })
      await createScene(shell, 'Shell scene')
      const account = await createUser({ role: 'creator' })
      const r = await raffle('Kept')
      const moved = await entry(r.id, shell, w, 'Shell name')
      expect(await linkVerifiedWallet(account.id, w)).toBe('linked')
      expect(await db.select().from(users).where(eq(users.id, shell.id))).toHaveLength(1)
      expect(await entryById(moved.id)).toMatchObject({ userId: account.id })
      expect(await db.select().from(raffleEntries).where(eq(raffleEntries.userId, shell.id))).toHaveLength(0)
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
      expect(await scrubBeats(T0)).toEqual({ present: 1, batches: 0, networks: 0, reissueRequests: 0 })
      expect(await byId(oldPresent.id)).toBeUndefined()
      expect(await byId(oldClaimed.id)).toBeDefined()
      expect(await byId(recentPresent.id)).toBeDefined()
      expect((await scrubBeats(at(H)))).toEqual({ present: 1, batches: 0, networks: 0, reissueRequests: 0 })
      expect(await byId(recentPresent.id)).toBeUndefined()
    })

    it('removes removed claims 30 days after the end; a BEAT\'s network counts and salt go once its claims are over', async () => {
      const old = await seedBeat({ endsAt: at(-30 * DAY) })
      const graceOver = await seedBeat({ endsAt: at(-25 * H) })
      const open = await seedBeat({ endsAt: at(-23 * H) })
      const removed = await claim(old.id, me, 'removed')
      for (const b of [old, graceOver, open]) {
        await db.update(beats).set({ networkSalt: 'salt' }).where(eq(beats.id, b.id))
        await db.insert(beatNetworkClaims).values({ beatId: b.id, netHash: 'h', claims: 2 })
      }
      expect(await scrubBeats(T0)).toEqual({ present: 1, batches: 0, networks: 2, reissueRequests: 0 })
      expect(await byId(removed.id)).toBeUndefined()
      const counts = await db.select().from(beatNetworkClaims)
      expect(counts.map((c) => c.beatId)).toEqual([open.id])
      const salts = Object.fromEntries((await db.select().from(beats)).map((b) => [b.id, b.networkSalt]))
      expect([salts[old.id], salts[graceOver.id], salts[open.id]]).toEqual([null, null, 'salt'])
    })

    it('nulls batch wallets and raw txs 30 days after settling (confirmed, or failed by sent time), keeps hashes; open batches 30 days after they were made', async () => {
      const b = await seedBeat()
      const mk = (nonce: number, status: 'confirmed' | 'failed' | 'sent', when: Date, extra: Partial<typeof beatMintBatches.$inferInsert> = {}) =>
        db.insert(beatMintBatches).values({
          chain: 'polygon-amoy', kind: 'mint', beatId: b.id, tokenId: 1, wallets: [wallet()], nonce, txHash: '0xabc', txHashes: ['0xabc'],
          rawTx: '0x02f8raw', status, createdAt: when, ...extra,
        }).returning().then((r) => r[0])
      const confOld = await mk(1, 'confirmed', at(-31 * DAY), { confirmedAt: at(-30 * DAY) })
      const confNew = await mk(2, 'confirmed', at(-31 * DAY), { confirmedAt: at(-(30 * DAY - H)) })
      const failOld = await mk(3, 'failed', at(-31 * DAY), { sentAt: at(-30 * DAY) })
      const open = await mk(4, 'sent', at(-40 * DAY), { sentAt: at(-40 * DAY) })
      const openNew = await mk(6, 'sending', at(-(30 * DAY - H)))
      // Scrubbed of its wallets before raw txs were scrubbed too: its raw tx (calldata = every wallet) still goes
      const halfDone = await mk(5, 'failed', at(-50 * DAY), { wallets: null, lastError: 'unsent:NETWORK_ERROR' })
      expect(await scrubBeats(T0)).toEqual({ present: 0, batches: 4, networks: 0, reissueRequests: 0 })
      const row = async (id: string) => (await db.select().from(beatMintBatches).where(eq(beatMintBatches.id, id)))[0]
      expect(await row(confOld.id)).toMatchObject({ wallets: null, rawTx: null, txHash: '0xabc', txHashes: ['0xabc'] })
      expect(await row(failOld.id)).toMatchObject({ wallets: null, rawTx: null })
      expect(await row(halfDone.id)).toMatchObject({ wallets: null, rawTx: null, txHashes: ['0xabc'], lastError: 'unsent:NETWORK_ERROR' })
      expect(await row(confNew.id)).toMatchObject({ rawTx: '0x02f8raw' })
      expect((await row(confNew.id)).wallets).toHaveLength(1)
      // M3: open 40 days, so its wallets go too (reconcile settles it by receipt or nonce without them)
      expect(await row(open.id)).toMatchObject({ rawTx: null, wallets: null, status: 'sent', txHashes: ['0xabc'] })
      expect(await row(openNew.id)).toMatchObject({ rawTx: '0x02f8raw' })
      expect(await scrubBeats(T0)).toEqual({ present: 0, batches: 0, networks: 0, reissueRequests: 0 })
    })
  })
})
