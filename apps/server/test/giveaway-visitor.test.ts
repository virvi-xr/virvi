import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { GIVEAWAY_CONSENT_VERSION } from '@virvixr/shared'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { giveawayClaimMints, giveawayClaims, giveawayItems, giveaways, giveawayScenes, giveawayTxs, walletBlocks } from '../src/db/schema.js'
import { issueScenePass, sceneClaims } from '../src/auth/scene-pass.js'
import { setBeatPlatformCheckForTests } from '../src/beats/platform-checks.js'
import { clearBeatLive, markBeatLive } from '../src/beats/live.js'
import { availableGiveaway } from '../src/giveaways/visitor.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, randomWallet, testApp, type TestUser } from './helpers/factories.js'
import { giveawaysOn } from './helpers/giveaways-fake.js'

const H = 3_600_000
const at = (ms: number) => new Date(Date.now() + ms)
const C1 = '0x' + 'c0'.repeat(20)
const C2 = '0x' + 'd0'.repeat(20)

describe('giveaway visitor routes (LIV-194)', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let host: TestUser
  let sceneA: string
  let sceneB: string
  let off: () => void
  const prevBeats = config.beats

  beforeEach(async () => {
    await resetDb()
    ;({ off } = giveawaysOn())
    ;(config as any).beats = { ...config.beats, newWalletsPerIpHour: 1000 }
    setBeatPlatformCheckForTests('decentraland', async () => true)
    app = await testApp()
    host = await createUser({ wallet: randomWallet() })
    sceneA = (await createScene(host, 'A')).scene.id
    sceneB = (await createScene(host, 'B')).scene.id
  })
  afterEach(async () => {
    off()
    ;(config as any).beats = prevBeats
    setBeatPlatformCheckForTests('decentraland', undefined)
    await app.close()
  })

  /** An open giveaway on scene A: started an hour ago, ends in an hour, three ready items over two contracts. */
  async function seed(over: Partial<typeof giveaways.$inferInsert> = {}, scenes = [sceneA], remaining = 100) {
    const [g] = await db.insert(giveaways).values({
      ownerId: host.id, name: 'Launch party', enabled: true, chain: 'polygon', walletAddress: '0x' + 'ab'.repeat(20),
      startsAt: at(-H), endsAt: at(H), minPresentSeconds: 300, ...over,
    }).returning()
    await db.insert(giveawayItems).values([
      { giveawayId: g.id, contractAddress: C1, itemId: '0', name: 'Hat', imageUrl: 'https://peer.example/hat.png', rarity: 'rare', mintState: 'ready', remaining },
      { giveawayId: g.id, contractAddress: C1, itemId: '1', name: 'Dance', imageUrl: null, rarity: 'epic', mintState: 'ready', remaining },
      { giveawayId: g.id, contractAddress: C2, itemId: '0', name: 'Shoes', imageUrl: null, rarity: null, mintState: 'ready', remaining },
    ])
    if (scenes.length) await db.insert(giveawayScenes).values(scenes.map((sceneId) => ({ giveawayId: g.id, sceneId })))
    return g
  }

  interface Visitor { user: TestUser; wallet: string; pass: (sceneId?: string) => string }
  async function visitor(wallet = randomWallet()): Promise<Visitor> {
    const user = await createUser({ wallet })
    // In the scene's room since long ago (live presence; the check-in tests cover it)
    await markBeatLive(sceneA, user.id, 1)
    await markBeatLive(sceneB, user.id, 1)
    return { user, wallet: wallet.toLowerCase(), pass: (sceneId = sceneA) => issueScenePass(app, user as any, wallet, { sceneId, locationId: null }).accessToken }
  }
  const go = (method: string, url: string, token: string, payload?: unknown) =>
    app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}` }, payload: payload as any })
  const base = (sceneId: string, id: string) => `/api/scenes/${sceneId}/giveaway/${id}`
  const track = (v: Visitor, g: { id: string }, sceneId = sceneA, consentVersion: unknown = GIVEAWAY_CONSENT_VERSION) =>
    go('POST', `${base(sceneId, g.id)}/track`, v.pass(sceneId), { consentVersion })
  const checkin = (v: Visitor, g: { id: string }) => go('POST', `${base(sceneA, g.id)}/checkin`, v.pass())
  const claim = (v: Visitor, g: { id: string }) => go('POST', `${base(sceneA, g.id)}/claim`, v.pass())
  const stop = (v: Visitor, g: { id: string }) => go('DELETE', `${base(sceneA, g.id)}/track`, v.pass())
  const current = (v: Visitor, sceneId = sceneA) => go('GET', `/api/scenes/${sceneId}/giveaway/current`, v.pass(sceneId))
  const claimRow = async (id: string, userId: string) =>
    (await db.select().from(giveawayClaims).where(and(eq(giveawayClaims.giveawayId, id), eq(giveawayClaims.userId, userId))))[0]
  async function present(g: { id: string }, seconds: number, v?: Visitor) {
    const who = v ?? (await visitor())
    const res = await track(who, g)
    expect(res.statusCode, res.body).toBe(200)
    await db.update(giveawayClaims).set({ secondsPresent: seconds }).where(and(eq(giveawayClaims.giveawayId, g.id), eq(giveawayClaims.userId, who.user.id)))
    return who
  }

  describe('current', () => {
    it('shows the open giveaway with its items and no claim', async () => {
      const g = await seed()
      const res = await current(await visitor())
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().giveaway).toEqual({
        id: g.id, name: 'Launch party', endsAt: g.endsAt!.toISOString(), minPresentSeconds: 300, test: false, claim: null,
        items: [
          { name: 'Hat', thumbnail: 'https://peer.example/hat.png', rarity: 'rare' },
          { name: 'Dance', thumbnail: null, rarity: 'epic' },
          { name: 'Shoes', thumbnail: null, rarity: null },
        ],
      })
      expect(res.body).not.toMatch(/walletKeyEnc|keyEnc/)
    })

    it('is null once the window ended, or before it starts', async () => {
      const v = await visitor()
      await seed({ startsAt: at(-3 * H), endsAt: at(-1000) })
      expect((await current(v)).json()).toEqual({ giveaway: null })
      await seed({ startsAt: at(H), endsAt: at(2 * H) })
      expect((await current(v)).json()).toEqual({ giveaway: null })
    })

    it('is null for a disabled giveaway', async () => {
      await seed({ enabled: false })
      expect((await current(await visitor())).json()).toEqual({ giveaway: null })
    })

    it('is null for a deleted giveaway', async () => {
      await seed({ deletedAt: new Date() })
      expect((await current(await visitor())).json()).toEqual({ giveaway: null })
    })

    it('still shows a paused (low_gas) giveaway, and it still takes claims', async () => {
      const g = await seed({ pausedReason: 'low_gas', pausedAt: new Date() })
      const v = await visitor()
      expect((await current(v)).json().giveaway).toMatchObject({ id: g.id })
      await present(g, 600, v)
      const res = await claim(v, g)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().giveaway.claim.status).toBe('waiting')
    })

    it("a visitor on scene B can't see a giveaway linked only to A", async () => {
      const g = await seed()
      const v = await visitor()
      expect((await current(v, sceneB)).json()).toEqual({ giveaway: null })
      expect((await track(v, g, sceneB)).statusCode).toBe(404)
    })

    it('picks the oldest start first', async () => {
      await seed({ name: 'Newer', startsAt: at(-H / 2) })
      const older = await seed({ name: 'Older', startsAt: at(-2 * H) })
      expect((await current(await visitor())).json().giveaway).toMatchObject({ id: older.id, name: 'Older' })
    })

    it('hides an Amoy giveaway unless its owner is an admin', async () => {
      const g = await seed({ chain: 'polygon-amoy' })
      const v = await visitor()
      expect((await current(v)).json()).toEqual({ giveaway: null })
      const admin = await createUser({ role: 'admin', wallet: randomWallet() })
      await db.update(giveaways).set({ ownerId: admin.id }).where(eq(giveaways.id, g.id))
      expect((await current(v)).json().giveaway).toMatchObject({ id: g.id, test: true })
    })

    it('closes when the claims queued reach an item\'s remaining supply, or an item is sold out', async () => {
      const g = await seed({}, [sceneA], 1)
      const first = await present(g, 600)
      expect((await claim(first, g)).statusCode).toBe(200)
      const passer = await visitor()
      expect((await current(passer)).json()).toEqual({ giveaway: null })
      // The claimer's own claim stays visible while the giveaway runs
      expect((await current(first)).json().giveaway).toMatchObject({ id: g.id, claim: { status: 'waiting' } })

      const g2 = await seed({}, [sceneB])
      const late = await visitor()
      expect((await current(late, sceneB)).json().giveaway).toMatchObject({ id: g2.id })
      await db.update(giveawayItems).set({ mintState: 'sold_out' }).where(and(eq(giveawayItems.giveawayId, g2.id), eq(giveawayItems.itemId, '1')))
      expect((await current(late, sceneB)).json()).toEqual({ giveaway: null })
    })

    it('a recoverable pause (not_minter, not_approved) keeps the card and takes claims, which wait', async () => {
      const g = await seed()
      await db.update(giveawayItems).set({ mintState: 'not_minter' }).where(and(eq(giveawayItems.giveawayId, g.id), eq(giveawayItems.itemId, '1')))
      await db.update(giveawayItems).set({ mintState: 'not_approved' }).where(and(eq(giveawayItems.giveawayId, g.id), eq(giveawayItems.contractAddress, C2)))
      await db.update(giveaways).set({ pausedReason: 'not_minter', pausedAt: new Date() }).where(eq(giveaways.id, g.id))
      const v = await visitor()
      expect((await current(v)).json().giveaway).toMatchObject({ id: g.id })
      await present(g, 600, v)
      const res = await claim(v, g)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().giveaway.claim.status).toBe('waiting')
    })

    it('a non-numeric item id does not break the card', async () => {
      const g = await seed()
      await db.update(giveawayItems).set({ itemId: 'not-a-number' }).where(and(eq(giveawayItems.giveawayId, g.id), eq(giveawayItems.itemId, '1')))
      const res = await current(await visitor())
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().giveaway.items).toHaveLength(3)
    })

    it('a sent claim carries its transaction link', async () => {
      const g = await seed()
      const v = await present(g, 600)
      expect((await claim(v, g)).statusCode).toBe(200)
      const row = await claimRow(g.id, v.user.id)
      const [tx] = await db.insert(giveawayTxs).values({
        giveawayId: g.id, chain: 'polygon', kind: 'mint', fromAddress: g.walletAddress!, toAddress: C1, contractAddress: C1, txHash: '0x' + '12'.repeat(32), status: 'confirmed',
      }).returning()
      await db.update(giveawayClaimMints).set({ txId: tx.id, status: 'sent' }).where(and(eq(giveawayClaimMints.claimId, row.id), eq(giveawayClaimMints.contractAddress, C1)))
      await db.update(giveawayClaims).set({ status: 'sent', sentAt: new Date() }).where(eq(giveawayClaims.id, row.id))
      expect((await current(v)).json().giveaway.claim).toEqual({
        status: 'sent', secondsPresent: 600, txUrl: `https://polygonscan.com/tx/0x${'12'.repeat(32)}`, failReason: null, delayed: false,
      })
    })
  })

  describe('track', () => {
    it('records a present claim with the consent version', async () => {
      const g = await seed()
      const v = await visitor()
      const res = await track(v, g)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().giveaway.claim).toEqual({ status: 'present', secondsPresent: 0, txUrl: null, failReason: null, delayed: false })
      const row = await claimRow(g.id, v.user.id)
      expect(row).toMatchObject({ wallet: v.wallet, consentVersion: GIVEAWAY_CONSENT_VERSION, status: 'present' })
      // Again: idempotent
      expect((await track(v, g)).statusCode).toBe(200)
      expect(await db.select().from(giveawayClaims)).toHaveLength(1)
    })

    it('a wallet without verification gets 403 wallet_required', async () => {
      const g = await seed()
      const u = await createUser()
      const pass = app.jwt.sign({ ...sceneClaims(u as any, randomWallet(), { sceneId: sceneA, locationId: null }), verified: false })
      const res = await go('POST', `${base(sceneA, g.id)}/track`, pass, { consentVersion: GIVEAWAY_CONSENT_VERSION })
      expect([res.statusCode, res.json().error, res.json().message]).toEqual([403, 'wallet_required', 'Connect a wallet to claim.'])
      const none = app.jwt.sign(sceneClaims(u as any, null, { sceneId: sceneA, locationId: null }))
      expect((await go('POST', `${base(sceneA, g.id)}/track`, none, { consentVersion: GIVEAWAY_CONSENT_VERSION })).statusCode).toBe(403)
      expect(await db.select().from(giveawayClaims)).toHaveLength(0)
    })

    it('an old consent version gets 400 consent_outdated', async () => {
      const g = await seed()
      const res = await track(await visitor(), g, sceneA, GIVEAWAY_CONSENT_VERSION - 1)
      expect([res.statusCode, res.json().error]).toEqual([400, 'consent_outdated'])
    })

    it('the same wallet on another account gets 409 already_claimed', async () => {
      const g = await seed()
      const first = await visitor()
      expect((await track(first, g)).statusCode).toBe(200)
      const other = await createUser()
      const pass = issueScenePass(app, other as any, first.wallet, { sceneId: sceneA, locationId: null }).accessToken
      const res = await go('POST', `${base(sceneA, g.id)}/track`, pass, { consentVersion: GIVEAWAY_CONSENT_VERSION })
      expect([res.statusCode, res.json().error, res.json().message]).toEqual([409, 'already_claimed', 'This wallet already claimed this giveaway.'])
    })

    it('refuses a wallet without a profile, and a blocked wallet', async () => {
      const g = await seed()
      setBeatPlatformCheckForTests('decentraland', async () => false)
      expect((await track(await visitor(), g)).json().error).toBe('profile_required')
      setBeatPlatformCheckForTests('decentraland', async () => true)
      const v = await visitor()
      await db.insert(walletBlocks).values({ wallet: v.wallet, userId: host.id, reason: 'reissue' })
      const res = await track(v, g)
      expect([res.statusCode, res.json().error]).toEqual([403, 'wallet_blocked'])
      expect(await db.select().from(giveawayClaims)).toHaveLength(0)
    })

    it('needs a pass for this scene', async () => {
      const g = await seed()
      const v = await visitor()
      const res = await go('POST', `${base(sceneA, g.id)}/track`, v.pass(sceneB), { consentVersion: GIVEAWAY_CONSENT_VERSION })
      expect(res.statusCode).toBe(403)
    })
  })

  describe('check-in', () => {
    it('with no live room connection a check-in is accepted and adds nothing; with one it adds time', async () => {
      const g = await seed()
      const v = await present(g, 0)
      await clearBeatLive(sceneA, v.user.id)
      const back = () => db.update(giveawayClaims).set({ lastSeenAt: at(-30_000) }).where(eq(giveawayClaims.userId, v.user.id))
      await back()
      const none = await checkin(v, g)
      expect(none.statusCode, none.body).toBe(200)
      expect(none.json().giveaway.claim.secondsPresent).toBe(0)
      // Live only for the last 10 seconds: only those count
      await markBeatLive(sceneA, v.user.id, Date.now() - 10_000)
      await back()
      const some = (await checkin(v, g)).json().giveaway.claim.secondsPresent
      expect(some).toBeGreaterThanOrEqual(9)
      expect(some).toBeLessThanOrEqual(11)
    })

    it('adds the time since the last check-in', async () => {
      const g = await seed()
      const v = await present(g, 0)
      await db.update(giveawayClaims).set({ lastSeenAt: at(-30_000) }).where(eq(giveawayClaims.userId, v.user.id))
      const res = await checkin(v, g)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().giveaway.claim.secondsPresent).toBeGreaterThanOrEqual(29)
      expect(res.json().giveaway.claim.secondsPresent).toBeLessThanOrEqual(31)
      // Too soon after: nothing more
      const again = (await checkin(v, g)).json().giveaway.claim.secondsPresent
      expect(again).toBe(res.json().giveaway.claim.secondsPresent)
    })
  })

  describe('claim', () => {
    it('queues the claim as waiting with one mint row per collection contract', async () => {
      const g = await seed()
      const v = await present(g, 300)
      const res = await claim(v, g)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().giveaway.claim).toMatchObject({ status: 'waiting', txUrl: null })
      const row = await claimRow(g.id, v.user.id)
      expect(row.status).toBe('waiting')
      expect(row.claimedAt).toBeInstanceOf(Date)
      const mints = await db.select().from(giveawayClaimMints).where(eq(giveawayClaimMints.claimId, row.id))
      expect(mints.map((m) => [m.contractAddress.toLowerCase(), m.status]).sort()).toEqual([[C1, 'waiting'], [C2, 'waiting']])
      // Claiming again changes nothing
      expect((await claim(v, g)).statusCode).toBe(200)
      expect(await db.select().from(giveawayClaimMints)).toHaveLength(2)
    })

    it('too_soon before the minimum time, with the seconds left', async () => {
      const g = await seed()
      const v = await present(g, 100)
      const res = await claim(v, g)
      expect([res.statusCode, res.json().error, res.json().secondsLeft]).toEqual([409, 'too_soon', 200])
      expect((await claimRow(g.id, v.user.id)).status).toBe('present')
    })

    it('without tracking first gets 404', async () => {
      const g = await seed()
      expect((await claim(await visitor(), g)).statusCode).toBe(404)
    })

    it('cap 1, two concurrent claims: exactly one waits, the other gets 409 closed', async () => {
      const g = await seed({ claimCap: 1 })
      const a = await present(g, 600)
      const b = await present(g, 600)
      const results = await Promise.all([claim(a, g), claim(b, g)])
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409])
      expect(results.find((r) => r.statusCode === 409)!.json().error).toBe('closed')
      const rows = await db.select().from(giveawayClaims).where(eq(giveawayClaims.giveawayId, g.id))
      expect(rows.filter((r) => r.status === 'waiting')).toHaveLength(1)
    })

    it('sold_out once the queued claims take the remaining supply', async () => {
      const g = await seed({}, [sceneA], 1)
      const a = await present(g, 600)
      const b = await present(g, 600)
      expect((await claim(a, g)).statusCode).toBe(200)
      const res = await claim(b, g)
      expect([res.statusCode, res.json().error]).toEqual([409, 'sold_out'])
    })

    it('M-11: giveaways sharing an item share its supply: a claim queued in one takes it from the other', async () => {
      const g1 = await seed({}, [sceneA], 1)
      const g2 = await seed({}, [sceneA], 1)
      const a = await present(g1, 600)
      const b = await present(g2, 600)
      expect((await claim(a, g1)).statusCode).toBe(200)
      const res = await claim(b, g2)
      expect([res.statusCode, res.json().error]).toEqual([409, 'sold_out'])
    })

    it('M-12: failed claims do not count toward the cap', async () => {
      const g = await seed({ claimCap: 1 })
      await db.insert(giveawayClaims).values({ giveawayId: g.id, wallet: randomWallet().toLowerCase(), consentVersion: 1, status: 'failed', failReason: 'reverted' })
      const v = await present(g, 600)
      const res = await claim(v, g)
      expect(res.statusCode, res.body).toBe(200)
      const late = await visitor()
      expect([(await track(late, g)).statusCode, (await track(late, g)).json().error]).toEqual([409, 'closed'])
    })

    it('M-8: a queued claim is delayed while the giveaway is paused or once it waited 10 minutes', async () => {
      const g = await seed()
      const v = await present(g, 600)
      expect((await claim(v, g)).json().giveaway.claim).toMatchObject({ status: 'waiting', delayed: false })
      await db.update(giveaways).set({ pausedReason: 'low_gas', pausedAt: new Date() }).where(eq(giveaways.id, g.id))
      expect((await current(v)).json().giveaway.claim.delayed).toBe(true)
      await db.update(giveaways).set({ pausedReason: null, pausedAt: null }).where(eq(giveaways.id, g.id))
      expect((await current(v)).json().giveaway.claim.delayed).toBe(false)
      await db.update(giveawayClaims).set({ claimedAt: at(-11 * 60_000) }).where(eq(giveawayClaims.userId, v.user.id))
      expect((await current(v)).json().giveaway.claim.delayed).toBe(true)
    })

    it('closed once the giveaway is switched off', async () => {
      const g = await seed()
      const v = await present(g, 600)
      await db.update(giveaways).set({ enabled: false }).where(eq(giveaways.id, g.id))
      const res = await claim(v, g)
      expect([res.statusCode, res.json().error]).toEqual([409, 'closed'])
    })
  })

  describe('stop', () => {
    it('deletes a present claim only', async () => {
      const g = await seed()
      const v = await present(g, 0)
      expect((await stop(v, g)).statusCode).toBe(204)
      expect(await claimRow(g.id, v.user.id)).toBeUndefined()
      const w = await present(g, 600)
      expect((await claim(w, g)).statusCode).toBe(200)
      expect((await stop(w, g)).statusCode).toBe(409)
      expect((await claimRow(g.id, w.user.id)).status).toBe('waiting')
    })
  })

  it('answers 503 giveaways_off when giveaways are off', async () => {
    const g = await seed()
    off()
    const v = await visitor()
    const res = await current(v)
    expect([res.statusCode, res.json().error]).toEqual([503, 'giveaways_off'])
    expect((await track(v, g)).statusCode).toBe(503)
    ;({ off } = giveawaysOn())
  })

  it('availableGiveaway (the room\'s giveaway_available) gives the open giveaway\'s name and test flag', async () => {
    expect(await availableGiveaway(sceneA)).toBeNull()
    await seed()
    expect(await availableGiveaway(sceneA)).toEqual({ name: 'Launch party', test: false })
    expect(await availableGiveaway(sceneB)).toBeNull()
  })
})
