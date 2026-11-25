import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { BEAT_CARD_LEAD_MS, BEAT_CLAIM_GRACE_MS, BEAT_CONSENT_VERSION } from '@virvixr/shared'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { beatClaims, beatNetworkClaims, beats, beatScenes, hyperfyPairings, hyperfyWorlds, mediaAssets, walletBlocks } from '../src/db/schema.js'
import { issueHyperfyPass, issueScenePass, sceneClaims } from '../src/auth/scene-pass.js'
import { markBeatLive } from '../src/beats/live.js'
import { setBeatPlatformCheckForTests } from '../src/beats/platform-checks.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, randomWallet, testApp, tokenFor, type TestUser } from './helpers/factories.js'

const H = 3_600_000
const M = 60_000
const at = (ms: number) => new Date(Date.now() + ms)

describe('BEAT visitor routes (LIV-11)', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let host: TestUser
  let sceneA: string
  let sceneB: string
  let imageId: string
  const prev = config.beats

  beforeEach(async () => {
    await resetDb()
    ;(config as any).beats = { ...config.beats, enabled: true, chain: 'polygon', claimsPerIp: 1000, newWalletsPerIpHour: 1000 }
    setBeatPlatformCheckForTests('decentraland', async () => true)
    app = await testApp()
    host = await createUser({ wallet: randomWallet() })
    sceneA = (await createScene(host, 'A')).scene.id
    sceneB = (await createScene(host, 'B')).scene.id
    const [m] = await db.insert(mediaAssets).values({ ownerId: host.id, filename: 'b.png', contentType: 'image/png', sizeBytes: 1, storageKey: 'k', publicUrl: 'https://cdn.example/b.png' }).returning()
    imageId = m.id
  })
  afterEach(async () => {
    ;(config as any).beats = prev
    setBeatPlatformCheckForTests('decentraland', undefined)
    await app.close()
  })

  let tokenSeq = 100
  /** A BEAT row: live by default (started an hour ago, ends in an hour). */
  async function seed(over: Partial<typeof beats.$inferInsert> = {}, scenes = [sceneA]) {
    const [b] = await db.insert(beats).values({
      chain: 'polygon', ownerUserId: host.id, name: 'Opening night', description: 'Thanks for coming', imageMediaId: imageId,
      imageUrl: 'https://cdn.example/frozen.png', tokenId: tokenSeq++, status: 'live', minPresentSeconds: 300, supplyCap: 100,
      startsAt: at(-H), endsAt: at(H), ...over,
    }).returning()
    await db.insert(beatScenes).values(scenes.map((sceneId) => ({ beatId: b.id, sceneId })))
    return b
  }

  interface Visitor { user: TestUser; wallet: string; pass: (sceneId: string) => string }
  async function visitor(name: string | null = 'Visitor'): Promise<Visitor> {
    const wallet = randomWallet()
    const user = await createUser({ wallet })
    // In the scene's room since long ago (live presence, beat-attendance.test.ts covers it)
    await markBeatLive(sceneA, user.id, 1)
    await markBeatLive(sceneB, user.id, 1)
    return { user, wallet, pass: (sceneId) => issueScenePass(app, user as any, wallet, { sceneId, locationId: null }, undefined, name ?? undefined).accessToken }
  }
  const go = (method: string, url: string, token: string, payload?: unknown) =>
    app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}` }, payload: payload as any })
  const base = (sceneId: string, beatId: string) => `/api/scenes/${sceneId}/beat/${beatId}`
  const track = (v: Visitor, b: { id: string }, sceneId = sceneA, consentVersion: unknown = BEAT_CONSENT_VERSION) =>
    go('POST', `${base(sceneId, b.id)}/track`, v.pass(sceneId), { consentVersion })
  const checkin = (v: Visitor, b: { id: string }, sceneId = sceneA) => go('POST', `${base(sceneId, b.id)}/checkin`, v.pass(sceneId))
  const claim = (v: Visitor, b: { id: string }, sceneId = sceneA) => go('POST', `${base(sceneId, b.id)}/claim`, v.pass(sceneId))
  const current = (v: Visitor, sceneId = sceneA) => go('GET', `/api/scenes/${sceneId}/beat/current`, v.pass(sceneId))
  const claimRow = async (beatId: string, userId: string) =>
    (await db.select().from(beatClaims).where(and(eq(beatClaims.beatId, beatId), eq(beatClaims.userId, userId))))[0]
  const setClaim = (beatId: string, userId: string, set: Partial<typeof beatClaims.$inferInsert>) =>
    db.update(beatClaims).set(set).where(and(eq(beatClaims.beatId, beatId), eq(beatClaims.userId, userId)))
  /** A visitor who has opted in, with the given time present. */
  async function present(b: { id: string }, seconds: number, v?: Visitor) {
    const who = v ?? (await visitor())
    expect((await track(who, b)).statusCode).toBe(200)
    await setClaim(b.id, who.user.id, { secondsPresent: seconds })
    return who
  }

  describe('current', () => {
    it('LIV-184: after the end a BEAT shows only to visitors with a claim; others get the next BEAT or nothing', async () => {
      const done = await seed({ status: 'ended', supplyCap: 1, startsAt: at(-3 * H), endsAt: at(-H) })
      const taker = await visitor()
      await db.insert(beatClaims).values({ beatId: done.id, userId: taker.user.id, wallet: taker.wallet, displayName: 'T', consentVersion: 1, secondsPresent: 600, status: 'minted' })
      const passer = await visitor()
      expect((await current(passer)).json()).toEqual({ beat: null })
      expect((await current(taker)).json().beat).toMatchObject({ id: done.id, soldOut: true, myClaim: { status: 'minted' } })
      const next = await seed({ status: 'paid', startsAt: at(10 * M), endsAt: at(2 * H) })
      expect((await current(passer)).json().beat).toMatchObject({ id: next.id, soldOut: false, myClaim: null })
    })

    it('is null before the lead time and after the grace, and appears 30 minutes before the start', async () => {
      const v = await visitor()
      const early = await seed({ status: 'paid', startsAt: at(BEAT_CARD_LEAD_MS + 2 * M), endsAt: at(3 * H) })
      expect((await current(v)).json()).toEqual({ beat: null })
      await db.update(beats).set({ startsAt: at(BEAT_CARD_LEAD_MS - 2 * M) }).where(eq(beats.id, early.id))
      const res = await current(v)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().beat).toMatchObject({ id: early.id, name: 'Opening night', status: 'paid', imageUrl: 'https://cdn.example/frozen.png', soldOut: false, myClaim: null, minPresentSeconds: 300 })
      expect(BEAT_CARD_LEAD_MS).toBe(30 * M)

      const late = await seed({ status: 'ended', startsAt: at(-30 * H), endsAt: at(-BEAT_CLAIM_GRACE_MS - M) }, [sceneB])
      expect((await current(v, sceneB)).json()).toEqual({ beat: null })
      await db.update(beats).set({ endsAt: at(-BEAT_CLAIM_GRACE_MS + M) }).where(eq(beats.id, late.id))
      // After the end it shows only to visitors with a claim (LIV-184): this one opted in during the event
      await db.insert(beatClaims).values({ beatId: late.id, userId: v.user.id, wallet: v.wallet, displayName: 'V', consentVersion: 1, secondsPresent: 600 })
      expect((await current(v, sceneB)).json().beat).toMatchObject({ id: late.id, status: 'ended' })
      const claimUntil = new Date((await current(v, sceneB)).json().beat.claimUntil).getTime()
      expect(Math.abs(claimUntil - (Date.now() + M))).toBeLessThan(5_000)
    })

    it('a BEAT on an earlier contract is never current, and can\'t be tracked or claimed (Virvi would never send it)', async () => {
      ;(config as any).beats = { ...config.beats, contracts: { polygon: '0x00000000000000000000000000000000000b3a75', 'polygon-amoy': null } }
      const v = await visitor()
      const b = await seed({ contractAddress: '0x0000000000000000000000000000000000000001', createdOnChainTx: '0xc' })
      expect((await current(v)).json()).toEqual({ beat: null })
      expect((await track(v, b)).statusCode).toBe(404)
      // One already tracking when the contract was replaced can't claim either
      await db.update(beats).set({ contractAddress: '0x00000000000000000000000000000000000b3a75' }).where(eq(beats.id, b.id))
      await present(b, 600, v)
      await db.update(beats).set({ contractAddress: '0x0000000000000000000000000000000000000001' }).where(eq(beats.id, b.id))
      expect((await claim(v, b)).statusCode).toBe(404)
      expect((await claimRow(b.id, v.user.id)).status).toBe('present')
      // A BEAT not yet on chain (no contract recorded) still shows
      const fresh = await seed({ contractAddress: null }, [sceneB])
      expect((await current(v, sceneB)).json().beat).toMatchObject({ id: fresh.id })
    })

    it('draft and cancelled BEATs are never current', async () => {
      const v = await visitor()
      await seed({ status: 'draft', tokenId: null, imageUrl: null })
      await seed({ status: 'cancelled' }, [sceneB])
      expect((await current(v)).json()).toEqual({ beat: null })
      expect((await current(v, sceneB)).json()).toEqual({ beat: null })
    })

    it('plain-ux I2: a failed claim says whether it will be retried (final)', async () => {
      const b = await seed()
      const v = await present(b, 600)
      await setClaim(b.id, v.user.id, { status: 'failed', failReason: 'send_failed' })
      expect((await current(v)).json().beat.myClaim).toMatchObject({ status: 'failed', final: false })
      for (const reason of ['receiver_rejected', 'ERC1155InvalidReceiver', 'BeatClosedError', 'given_up']) {
        await setClaim(b.id, v.user.id, { failReason: reason })
        expect((await current(v)).json().beat.myClaim).toMatchObject({ status: 'failed', final: true })
      }
    })

    it('host review: a held claim says when it goes out at the latest (heldUntil); once sent it is null', async () => {
      const b = await seed({ holdMints: true })
      const v = await present(b, 600)
      expect((await claim(v, b)).statusCode).toBe(200)
      const until = new Date(b.endsAt.getTime() + BEAT_CLAIM_GRACE_MS).toISOString()
      expect((await current(v)).json().beat.myClaim).toMatchObject({ status: 'claimed', heldUntil: until })
      await db.update(beats).set({ mintsReleasedAt: new Date(Date.now() + 1000) }).where(eq(beats.id, b.id))
      expect((await current(v)).json().beat.myClaim).toMatchObject({ status: 'claimed', heldUntil: null })
    })

    it('a reconnecting visitor gets their myClaim; a minted claim without its tx tolerates a null mint_tx', async () => {
      const b = await seed()
      const v = await visitor()
      expect((await track(v, b)).statusCode).toBe(200)
      const again = await current(v)
      expect(again.json().beat.myClaim).toEqual({ status: 'present', secondsPresent: 0, txUrl: null, final: false, heldUntil: null })
      await setClaim(b.id, v.user.id, { status: 'minted', mintTx: null, secondsPresent: 600 })
      expect((await current(v)).json().beat.myClaim).toEqual({ status: 'minted', secondsPresent: 600, txUrl: null, final: false, heldUntil: null })
      await setClaim(b.id, v.user.id, { mintTx: '0x' + 'ab'.repeat(32) })
      expect((await current(v)).json().beat.myClaim.txUrl).toBe(`https://polygonscan.com/tx/0x${'ab'.repeat(32)}`)
      // Another visitor sees only their own (none)
      expect((await current(await visitor())).json().beat.myClaim).toBeNull()
    })
  })

  describe('track and check-in', () => {
    it('a blocked wallet (a reissue\'s old wallet) can neither start tracking nor claim, on its old account or a new one', async () => {
      const b = await seed()
      const v = await present(b, 600)
      // On the account it was taken from: no session at all
      await db.insert(walletBlocks).values({ wallet: v.wallet.toLowerCase(), userId: v.user.id, reason: 'reissue' })
      for (const res of [await track(v, b), await claim(v, b)]) expect([res.statusCode, res.json().error]).toEqual([401, 'wallet_blocked'])
      expect((await claimRow(b.id, v.user.id)).status).toBe('present')
      // Signed up again as a separate account (the block is on BEATs everywhere, not on Virvi): no BEATs either
      await db.update(walletBlocks).set({ userId: host.id })
      for (const res of [await track(v, b), await claim(v, b)]) expect([res.statusCode, res.json().error]).toEqual([403, 'beats_blocked'])
      expect((await claimRow(b.id, v.user.id)).status).toBe('present')
    })
    it('tracking without a wallet gets no_wallet', async () => {
      const b = await seed()
      const u = await createUser()
      const pass = app.jwt.sign(sceneClaims(u as any, null, { sceneId: sceneA, locationId: null }))
      const res = await go('POST', `${base(sceneA, b.id)}/track`, pass, { consentVersion: BEAT_CONSENT_VERSION })
      expect([res.statusCode, res.json().error]).toEqual([403, 'no_wallet'])
      expect(await db.select().from(beatClaims)).toHaveLength(0)
    })

    it('tracking with an old consent version (1) gets bad_consent', async () => {
      const b = await seed()
      const res = await track(await visitor(), b, sceneA, 1)
      expect([res.statusCode, res.json().error]).toEqual([400, 'bad_consent'])
      // An old scene sends v1: the reply says the scene needs updating, not "reload" (which changes nothing)
      expect(res.json().message).toBe('This scene needs an update before visitors can claim BEATs. Ask the host to update it.')
      expect(await db.select().from(beatClaims)).toHaveLength(0)
    })

    it('stores the lowercased wallet, the cleaned display name and the consent, and is idempotent', async () => {
      const b = await seed()
      const wallet = '0xAbCDEF' + randomWallet().slice(8)
      const user = await createUser({ wallet })
      const v: Visitor = { user, wallet, pass: (sceneId) => issueScenePass(app, user as any, wallet, { sceneId, locationId: null }, undefined, 'Bad\u0007 Name\u001b').accessToken }
      const res = await track(v, b)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().beat.myClaim).toEqual({ status: 'present', secondsPresent: 0, txUrl: null, final: false, heldUntil: null })
      const row = await claimRow(b.id, user.id)
      expect(row).toMatchObject({ wallet: wallet.toLowerCase(), displayName: 'Bad Name', consentVersion: BEAT_CONSENT_VERSION, status: 'present' })
      expect(Date.now() - row.consentedAt.getTime()).toBeLessThan(10_000)
      await setClaim(b.id, user.id, { secondsPresent: 120 })
      expect((await track(v, b)).statusCode).toBe(200)
      const rows = await db.select().from(beatClaims)
      expect(rows).toHaveLength(1)
      expect(rows[0].secondsPresent).toBe(120)
    })

    it('tracking after ends_at is too_late; inside the lead time on a paid BEAT is allowed', async () => {
      const over = await seed({ status: 'ended', startsAt: at(-3 * H), endsAt: at(-M) })
      const res = await track(await visitor(), over)
      expect([res.statusCode, res.json().error]).toEqual([409, 'too_late'])
      const soon = await seed({ status: 'paid', startsAt: at(10 * M), endsAt: at(2 * H) }, [sceneB])
      expect((await track(await visitor(), soon, sceneB)).statusCode).toBe(200)
    })

    it('check-ins before starts_at add 0', async () => {
      const b = await seed({ status: 'paid', startsAt: at(10 * M), endsAt: at(2 * H) })
      const v = await visitor()
      await track(v, b)
      await setClaim(b.id, v.user.id, { lastSeenAt: at(-30_000) })
      const res = await checkin(v, b)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().beat.myClaim.secondsPresent).toBe(0)
      expect((await claimRow(b.id, v.user.id)).secondsPresent).toBe(0)
    })

    it('a check-in spanning ends_at adds only the part inside the window', async () => {
      const b = await seed({ status: 'live', startsAt: at(-2 * H), endsAt: at(-10_000) })
      const v = await visitor()
      // Opted in during the event (tracking is closed after ends_at)
      await db.insert(beatClaims).values({ beatId: b.id, userId: v.user.id, wallet: v.wallet, displayName: 'V', consentVersion: 1, lastSeenAt: at(-30_000) })
      const res = await checkin(v, b)
      expect(res.statusCode, res.body).toBe(200)
      const s = (await claimRow(b.id, v.user.id)).secondsPresent
      expect(s).toBeGreaterThanOrEqual(19)
      expect(s).toBeLessThanOrEqual(21)
      expect(res.json().beat.myClaim.secondsPresent).toBe(s)
    })

    it('a check-in spanning starts_at adds only the part inside the window', async () => {
      const b = await seed({ status: 'live', startsAt: at(-10_000), endsAt: at(H) })
      const v = await visitor()
      await track(v, b)
      await setClaim(b.id, v.user.id, { lastSeenAt: at(-30_000) })
      await checkin(v, b)
      const s = (await claimRow(b.id, v.user.id)).secondsPresent
      expect(s).toBeGreaterThanOrEqual(9)
      expect(s).toBeLessThanOrEqual(11)
    })

    it('two scenes checking in 5 s apart add once; the rejected check-in returns the claim unchanged', async () => {
      const b = await seed({}, [sceneA, sceneB])
      const v = await visitor()
      await track(v, b)
      await setClaim(b.id, v.user.id, { lastSeenAt: at(-35_000) })
      const first = await checkin(v, b, sceneA)
      expect(first.statusCode, first.body).toBe(200)
      const after = (await claimRow(b.id, v.user.id)).secondsPresent
      expect(after).toBeGreaterThanOrEqual(34)
      // The second scene 5 s later: closer than the minimum gap, so nothing is added
      await setClaim(b.id, v.user.id, { lastSeenAt: at(-5_000) })
      const second = await checkin(v, b, sceneB)
      expect(second.statusCode, second.body).toBe(200)
      expect(second.json().beat.myClaim.secondsPresent).toBe(after)
      expect((await claimRow(b.id, v.user.id)).secondsPresent).toBe(after)
    })

    it('checking in without tracking is not_tracking', async () => {
      const b = await seed()
      const res = await checkin(await visitor(), b)
      expect([res.statusCode, res.json().error]).toEqual([404, 'not_tracking'])
    })
  })

  describe('claim', () => {
    it('claiming under the minimum gets not_yet; at the minimum it succeeds', async () => {
      const b = await seed({ minPresentSeconds: 300 })
      const v = await present(b, 299)
      const under = await claim(v, b)
      expect([under.statusCode, under.json().error]).toEqual([409, 'not_yet'])
      await setClaim(b.id, v.user.id, { secondsPresent: 300 })
      const ok = await claim(v, b)
      expect(ok.statusCode, ok.body).toBe(200)
      expect(ok.json().beat.myClaim).toEqual({ status: 'claimed', secondsPresent: 300, txUrl: null, final: false, heldUntil: null })
      const row = await claimRow(b.id, v.user.id)
      expect(row.status).toBe('claimed')
      expect(Date.now() - row.claimedAt!.getTime()).toBeLessThan(10_000)
      // Again: returned as is
      const again = await claim(v, b)
      expect([again.statusCode, again.json().beat.myClaim.status]).toEqual([200, 'claimed'])
    })

    it('M1: no claim before the start, even with a minimum of 0 (not_started); at the start it succeeds', async () => {
      const b = await seed({ status: 'paid', startsAt: at(10 * M), endsAt: at(2 * H), minPresentSeconds: 0 })
      const v = await present(b, 0)
      const early = await claim(v, b)
      expect([early.statusCode, early.json().error]).toEqual([409, 'not_started'])
      expect(early.json().message).toBe("This event hasn't started yet.")
      expect((await claimRow(b.id, v.user.id)).status).toBe('present')
      await db.update(beats).set({ status: 'live', startsAt: at(-1000) }).where(eq(beats.id, b.id))
      const ok = await claim(v, b)
      expect(ok.statusCode, ok.body).toBe(200)
      expect((await claimRow(b.id, v.user.id)).status).toBe('claimed')
    })

    it('claiming 23 hours after the end succeeds, and 25 hours after gets too_late', async () => {
      const ok = await seed({ status: 'ended', startsAt: at(-26 * H), endsAt: at(-23 * H) })
      const v = await visitor()
      // Opted in during the event (tracking is closed after ends_at)
      await db.insert(beatClaims).values({ beatId: ok.id, userId: v.user.id, wallet: v.wallet, displayName: 'V', consentVersion: 1, secondsPresent: 600 })
      expect((await claim(v, ok)).statusCode).toBe(200)
      const late = await seed({ status: 'ended', startsAt: at(-28 * H), endsAt: at(-25 * H) }, [sceneB])
      await db.insert(beatClaims).values({ beatId: late.id, userId: v.user.id, wallet: v.wallet, displayName: 'V', consentVersion: 1, secondsPresent: 600 })
      const res = await claim(v, late, sceneB)
      expect([res.statusCode, res.json().error]).toEqual([409, 'too_late'])
      expect((await claimRow(late.id, v.user.id)).status).toBe('present')
    })

    it('with cap 1, two visitors claiming at once: one claimed, the other all_claimed', async () => {
      const b = await seed({ supplyCap: 1 })
      const v1 = await present(b, 600)
      const v2 = await present(b, 600)
      const [r1, r2] = await Promise.all([claim(v1, b), claim(v2, b)])
      const results = [r1, r2].map((r) => (r.statusCode === 200 ? r.json().beat.myClaim.status : r.json().error)).sort()
      expect(results).toEqual(['all_claimed', 'claimed'])
      const rows = await db.select().from(beatClaims).where(eq(beatClaims.beatId, b.id))
      expect(rows.filter((r) => r.status === 'claimed')).toHaveLength(1)
      expect((await current(v1)).json().beat.soldOut).toBe(true)
    })

    it('the same visitor claiming from two scenes at once ends with one claimed row', async () => {
      const b = await seed({ supplyCap: 5 }, [sceneA, sceneB])
      const v = await present(b, 600)
      const [r1, r2] = await Promise.all([claim(v, b, sceneA), claim(v, b, sceneB)])
      expect([r1.statusCode, r2.statusCode]).toEqual([200, 200])
      const rows = await db.select().from(beatClaims).where(eq(beatClaims.beatId, b.id))
      expect(rows.map((r) => r.status)).toEqual(['claimed'])
    })

    it('the cap counts a failed claim', async () => {
      const b = await seed({ supplyCap: 1 })
      const failed = await present(b, 600)
      await setClaim(b.id, failed.user.id, { status: 'failed', failReason: 'send_failed' })
      const v = await present(b, 600)
      const res = await claim(v, b)
      expect([res.statusCode, res.json().error]).toEqual([409, 'all_claimed'])
    })

    it('a claim with delete_requested is not found for that visitor', async () => {
      const b = await seed()
      const v = await present(b, 600)
      await setClaim(b.id, v.user.id, { deleteRequested: true })
      const res = await claim(v, b)
      expect([res.statusCode, res.json().error]).toEqual([404, 'not_tracking'])
      const stop = await go('DELETE', `${base(sceneA, b.id)}/track`, v.pass(sceneA))
      expect([stop.statusCode, stop.json().error]).toEqual([404, 'not_tracking'])
      expect((await current(v)).json().beat.myClaim).toBeNull()
      // Tracking again doesn't bring it back
      const again = await track(v, b)
      expect(again.statusCode).toBe(409)
      expect((await claimRow(b.id, v.user.id)).deleteRequested).toBe(true)
    })
  })

  describe('auto-claim (LIV-180)', () => {
    /** A tracked visitor (consent v3) just short of the minimum, last seen 30 s ago: the next check-in crosses it. */
    async function nearly(b: { id: string; minPresentSeconds: number }, v?: Visitor, sceneId = sceneA) {
      const who = v ?? (await visitor())
      const res = await track(who, b, sceneId)
      expect(res.statusCode, res.body).toBe(200)
      await setClaim(b.id, who.user.id, { secondsPresent: b.minPresentSeconds - 10, lastSeenAt: at(-30_000) })
      return who
    }
    const networkClaims = async (beatId: string) =>
      (await db.select().from(beatNetworkClaims).where(eq(beatNetworkClaims.beatId, beatId))).reduce((n, r) => n + r.claims, 0)

    it('is on by default and shown on the visitor view', async () => {
      const b = await seed()
      expect(b.autoClaim).toBe(true)
      expect((await current(await visitor())).json().beat.autoClaim).toBe(true)
      const off = await seed({ autoClaim: false }, [sceneB])
      expect((await current(await visitor(), sceneB)).json().beat.autoClaim).toBe(false)
      expect(off.autoClaim).toBe(false)
    })

    it('the check-in that crosses the minimum claims, exactly once', async () => {
      const b = await seed({ minPresentSeconds: 300 })
      const v = await nearly(b)
      const res = await checkin(v, b)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().beat.myClaim.status).toBe('claimed')
      const row = await claimRow(b.id, v.user.id)
      expect(row.status).toBe('claimed')
      expect(Date.now() - row.claimedAt!.getTime()).toBeLessThan(10_000)
      // Later check-ins and a manual Claim change nothing
      await setClaim(b.id, v.user.id, { lastSeenAt: at(-30_000) })
      const again = await checkin(v, b)
      expect([again.statusCode, again.json().beat.myClaim.status]).toEqual([200, 'claimed'])
      expect((await claim(v, b)).json().beat.myClaim.status).toBe('claimed')
      expect((await claimRow(b.id, v.user.id)).claimedAt!.getTime()).toBe(row.claimedAt!.getTime())
      expect(await networkClaims(b.id)).toBe(1)
    })

    it('a check-in still short of the minimum leaves the claim present', async () => {
      const b = await seed({ minPresentSeconds: 300 })
      const v = await visitor()
      await track(v, b)
      await setClaim(b.id, v.user.id, { secondsPresent: 100, lastSeenAt: at(-30_000) })
      const res = await checkin(v, b)
      expect([res.statusCode, res.json().beat.myClaim.status]).toEqual([200, 'present'])
    })

    it("concurrent check-ins from two scenes don't double-claim", async () => {
      const b = await seed({ minPresentSeconds: 300 }, [sceneA, sceneB])
      const v = await nearly(b)
      const [r1, r2, r3] = await Promise.all([checkin(v, b, sceneA), checkin(v, b, sceneB), checkin(v, b, sceneA)])
      expect([r1.statusCode, r2.statusCode, r3.statusCode]).toEqual([200, 200, 200])
      const rows = await db.select().from(beatClaims).where(eq(beatClaims.beatId, b.id))
      expect(rows.map((r) => r.status)).toEqual(['claimed'])
      expect(await networkClaims(b.id)).toBe(1)
    })

    it('with cap 1, two visitors crossing at once: one claimed, the other present and shown sold out', async () => {
      const b = await seed({ minPresentSeconds: 300, supplyCap: 1 })
      const v1 = await nearly(b)
      const v2 = await nearly(b)
      const [r1, r2] = await Promise.all([checkin(v1, b), checkin(v2, b)])
      expect([r1.statusCode, r2.statusCode]).toEqual([200, 200])
      expect([r1.json().beat.myClaim.status, r2.json().beat.myClaim.status].sort()).toEqual(['claimed', 'present'])
      expect(r1.json().beat.soldOut && r2.json().beat.soldOut).toBe(true)
    })

    it('no claim before the start: a minimum of 0 waits for the first check-in after it', async () => {
      const b = await seed({ status: 'paid', startsAt: at(10 * M), endsAt: at(2 * H), minPresentSeconds: 0 })
      const v = await visitor()
      const res = await track(v, b)
      expect([res.statusCode, res.json().beat.myClaim.status]).toEqual([200, 'present'])
      await setClaim(b.id, v.user.id, { lastSeenAt: at(-30_000) })
      const early = await checkin(v, b)
      expect([early.statusCode, early.json().beat.myClaim.status]).toEqual([200, 'present'])
      await db.update(beats).set({ status: 'live', startsAt: at(-1000) }).where(eq(beats.id, b.id))
      await setClaim(b.id, v.user.id, { lastSeenAt: at(-30_000) })
      const started = await checkin(v, b)
      expect([started.statusCode, started.json().beat.myClaim.status]).toEqual([200, 'claimed'])
    })

    it('tracking a started BEAT with a minimum of 0 claims at once', async () => {
      const b = await seed({ minPresentSeconds: 0 })
      const v = await visitor()
      const res = await track(v, b)
      expect([res.statusCode, res.json().beat.myClaim.status]).toEqual([200, 'claimed'])
      // Tracking again returns it as it is
      expect((await track(v, b)).json().beat.myClaim.status).toBe('claimed')
      expect(await networkClaims(b.id)).toBe(1)
    })

    it('no claim after the claim window', async () => {
      const b = await seed({ status: 'ended', startsAt: at(-28 * H), endsAt: at(-25 * H), minPresentSeconds: 300 })
      const v = await visitor()
      await db.insert(beatClaims).values({ beatId: b.id, userId: v.user.id, wallet: v.wallet, displayName: 'V', consentVersion: 3, secondsPresent: 600, lastSeenAt: at(-30_000) })
      const res = await checkin(v, b)
      expect([res.statusCode, res.json().beat.myClaim.status]).toEqual([200, 'present'])
    })

    it('no claim when the supply is used up: the check-in succeeds and shows sold out', async () => {
      const b = await seed({ minPresentSeconds: 300, supplyCap: 1 })
      const taker = await present(b, 600)
      await setClaim(b.id, taker.user.id, { status: 'minted' })
      const v = await nearly(b)
      const res = await checkin(v, b)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().beat).toMatchObject({ soldOut: true, myClaim: { status: 'present' } })
    })

    it('a refused wallet check is swallowed: the check-in succeeds and the claim stays present', async () => {
      const b = await seed({ minPresentSeconds: 300 })
      const v = await nearly(b)
      const blocked = await nearly(b)
      setBeatPlatformCheckForTests('decentraland', async () => false)
      const res = await checkin(v, b)
      expect([res.statusCode, res.json().beat.myClaim.status]).toEqual([200, 'present'])
      setBeatPlatformCheckForTests('decentraland', async () => true)
      // Blocked for BEATs everywhere (the block is on another account, so the pass still works): beats_blocked, swallowed
      await db.insert(walletBlocks).values({ wallet: blocked.wallet.toLowerCase(), userId: host.id, reason: 'reissue' })
      const res2 = await checkin(blocked, b)
      expect(res2.statusCode, res2.body).toBe(200)
      expect(res2.json().beat.myClaim.status).toBe('present')
    })

    it('no auto-claim when the BEAT has it off: the visitor presses Claim', async () => {
      const b = await seed({ minPresentSeconds: 300, autoClaim: false })
      const v = await nearly(b)
      const res = await checkin(v, b)
      expect([res.statusCode, res.json().beat.myClaim.status]).toEqual([200, 'present'])
      expect(res.json().beat.myClaim.secondsPresent).toBeGreaterThanOrEqual(300)
      expect((await claim(v, b)).json().beat.myClaim.status).toBe('claimed')
      const zero = await seed({ minPresentSeconds: 0, autoClaim: false }, [sceneB])
      expect((await track(v, zero, sceneB)).json().beat.myClaim.status).toBe('present')
    })

    it('no auto-claim for a v2 claim (an older scene): tracking with v3 upgrades it and the next check-in claims', async () => {
      const b = await seed({ minPresentSeconds: 300 })
      const v = await visitor()
      const old = await track(v, b, sceneA, 2)
      expect(old.statusCode, old.body).toBe(200)
      expect((await claimRow(b.id, v.user.id)).consentVersion).toBe(2)
      await setClaim(b.id, v.user.id, { secondsPresent: 290, lastSeenAt: at(-30_000) })
      const res = await checkin(v, b)
      expect([res.statusCode, res.json().beat.myClaim.status]).toEqual([200, 'present'])
      // A v2 track with a minimum of 0 doesn't claim either
      const zero = await seed({ minPresentSeconds: 0 }, [sceneB])
      expect((await track(v, zero, sceneB, 2)).json().beat.myClaim.status).toBe('present')
      // Tracking again with v3 upgrades the consent; v2 again doesn't take it back
      expect((await track(v, b, sceneA, 3)).statusCode).toBe(200)
      expect((await claimRow(b.id, v.user.id)).consentVersion).toBe(3)
      expect((await track(v, b, sceneA, 2)).statusCode).toBe(200)
      expect((await claimRow(b.id, v.user.id)).consentVersion).toBe(3)
      await setClaim(b.id, v.user.id, { lastSeenAt: at(-30_000) })
      expect((await checkin(v, b)).json().beat.myClaim.status).toBe('claimed')
    })

    it('tracking with v2 still works; an unknown version is bad_consent', async () => {
      const b = await seed()
      const v = await visitor()
      expect((await track(v, b, sceneA, 2)).statusCode).toBe(200)
      for (const bad of [4, '3', null, 2.5]) {
        const res = await track(await visitor(), b, sceneA, bad)
        expect([res.statusCode, res.json().error], String(bad)).toEqual([400, 'bad_consent'])
      }
      expect(await db.select().from(beatClaims)).toHaveLength(1)
    })

    it('a guest (no wallet) still gets no_wallet, with either version', async () => {
      const b = await seed({ minPresentSeconds: 0 })
      const u = await createUser()
      const pass = app.jwt.sign(sceneClaims(u as any, null, { sceneId: sceneA, locationId: null }))
      for (const consentVersion of [2, 3]) {
        const res = await go('POST', `${base(sceneA, b.id)}/track`, pass, { consentVersion })
        expect([res.statusCode, res.json().error]).toEqual([403, 'no_wallet'])
      }
      expect(await db.select().from(beatClaims)).toHaveLength(0)
    })
  })

  describe('stop tracking', () => {
    it('deletes a present row, and gets already_claimed after a claim', async () => {
      const b = await seed()
      const v = await present(b, 100)
      const res = await go('DELETE', `${base(sceneA, b.id)}/track`, v.pass(sceneA))
      expect(res.statusCode, res.body).toBe(204)
      expect(await db.select().from(beatClaims)).toHaveLength(0)
      const w = await present(b, 600)
      expect((await claim(w, b)).statusCode).toBe(200)
      const late = await go('DELETE', `${base(sceneA, b.id)}/track`, w.pass(sceneA))
      expect([late.statusCode, late.json().error]).toEqual([409, 'already_claimed'])
      expect((await claimRow(b.id, w.user.id)).status).toBe('claimed')
    })
  })

  describe('passes', () => {
    it('a pass for a scene the BEAT is not on gets not_found; a pass for another scene is refused', async () => {
      const b = await seed()
      const v = await visitor()
      for (const [method, path] of [['POST', 'track'], ['POST', 'checkin'], ['POST', 'claim'], ['DELETE', 'track']] as const) {
        const r = await go(method, `${base(sceneB, b.id)}/${path}`, v.pass(sceneB), { consentVersion: BEAT_CONSENT_VERSION })
        expect([method, path, r.statusCode, r.json().error]).toEqual([method, path, 404, 'not_found'])
        const other = await go(method, `${base(sceneB, b.id)}/${path}`, v.pass(sceneA), { consentVersion: BEAT_CONSENT_VERSION })
        expect([method, path, other.statusCode, other.json().error]).toEqual([method, path, 403, 'scene_pass_not_allowed'])
      }
      expect(await db.select().from(beatClaims)).toHaveLength(0)
    })

    it('an account session cannot track, check in or claim (scene_pass_required)', async () => {
      const b = await seed()
      const u = await createUser({ wallet: randomWallet() })
      for (const path of ['track', 'checkin', 'claim']) {
        const r = await go('POST', `${base(sceneA, b.id)}/${path}`, tokenFor(u), { consentVersion: BEAT_CONSENT_VERSION })
        expect([path, r.statusCode, r.json().error]).toEqual([path, 403, 'scene_pass_required'])
      }
    })

    it('every visitor route refuses a Hyperfy pass', async () => {
      const b = await seed()
      const v = await visitor()
      const soon = new Date(Date.now() + H)
      const [world] = await db.insert(hyperfyWorlds).values({ sceneId: sceneA, ownerId: host.id, name: 'W', keyHash: 'beat-v-world-hash', keyPrefix: 'virviw_v' }).returning()
      const [pairing] = await db.insert(hyperfyPairings).values({ worldId: world.id, userId: v.user.id, secretHash: 'beat-v-secret', status: 'claimed', codeExpiresAt: soon, expiresAt: soon }).returning()
      const hy = issueHyperfyPass(app, { id: v.user.id, role: v.user.role }, v.wallet, { id: pairing.id, worldId: world.id, sceneId: sceneA }).pass
      const routes: Array<[string, string]> = [
        ['GET', `/api/scenes/${sceneA}/beat/current`], ['POST', `${base(sceneA, b.id)}/track`], ['POST', `${base(sceneA, b.id)}/checkin`],
        ['POST', `${base(sceneA, b.id)}/claim`], ['DELETE', `${base(sceneA, b.id)}/track`],
      ]
      for (const [method, url] of routes) {
        const r = await go(method, url, hy, method === 'GET' ? undefined : { consentVersion: BEAT_CONSENT_VERSION })
        expect([method, url, r.statusCode, r.json().error]).toEqual([method, url, 403, 'hyperfy_pass_not_allowed'])
      }
      expect(await db.select().from(beatClaims)).toHaveLength(0)
    })

    it('every visitor route answers 404 while BEATs are off', async () => {
      const b = await seed()
      const v = await visitor()
      ;(config as any).beats = { ...config.beats, enabled: false }
      for (const [method, url] of [['GET', `/api/scenes/${sceneA}/beat/current`], ['POST', `${base(sceneA, b.id)}/track`], ['POST', `${base(sceneA, b.id)}/checkin`], ['POST', `${base(sceneA, b.id)}/claim`], ['DELETE', `${base(sceneA, b.id)}/track`]]) {
        const r = await go(method, url, v.pass(sceneA), method === 'GET' ? undefined : { consentVersion: BEAT_CONSENT_VERSION })
        expect([method, url, r.statusCode]).toEqual([method, url, 404])
      }
    })
  })
})
