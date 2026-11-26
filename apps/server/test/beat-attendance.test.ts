import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { BEAT_CONSENT_VERSION } from '@virvixr/shared'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { beatClaims, beatNetworkClaims, beats, beatScenes, userAuthMethods } from '../src/db/schema.js'
import { issueScenePass } from '../src/auth/scene-pass.js'
import { recordJobFailure } from '../src/errors/record.js'
import { beatLiveSince, beatLiveTiming, clearBeatLive, markBeatLive } from '../src/beats/live.js'
import { busKeyValue } from '../src/realtime/bus.js'
import { platformCheck, resetBeatPlatformChecks, setBeatPlatformCheckForTests } from '../src/beats/platform-checks.js'
import { deleteMyBeatData } from '../src/beats/retention.js'
import { beatNetworkHash, claimBeat } from '../src/beats/visitor.js'
import { beatSettingsFrom } from '../src/config.js'
import { createHmac } from 'node:crypto'
import { resetNewWallets } from '../src/beats/new-wallet-limit.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, randomWallet, testApp, tokenFor, type TestUser } from './helpers/factories.js'
import { joinScene, startGameServer } from './helpers/game-server.js'

vi.mock('../src/errors/record.js', async (orig) => ({
  ...(await orig<typeof import('../src/errors/record.js')>()),
  recordJobFailure: vi.fn(),
}))

const H = 3_600_000
const at = (ms: number) => new Date(Date.now() + ms)

/**
 * Fake attendance (LIV-11, attacker Critical 1): the per-network claim limit, live room presence, the per-platform
 * wallet check (Decentraland: a deployed profile) and host review before minting.
 */
describe('BEAT attendance protections (LIV-11)', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let host: TestUser
  let sceneA: string
  const prev = config.beats

  beforeEach(async () => {
    await resetDb()
    vi.mocked(recordJobFailure).mockClear()
    ;(config as any).beats = { ...config.beats, enabled: true, chain: 'polygon', claimsPerIp: 3, newWalletsPerIpHour: 1000 }
    setBeatPlatformCheckForTests('decentraland', async () => true)
    app = await testApp()
    host = await createUser({ wallet: randomWallet() })
    sceneA = (await createScene(host, 'A')).scene.id
  })
  afterEach(async () => {
    ;(config as any).beats = prev
    setBeatPlatformCheckForTests('decentraland', undefined)
    resetBeatPlatformChecks()
    vi.unstubAllGlobals()
    await app.close()
  })

  let tokenSeq = 7000
  // Auto-claim off: these tests drive the manual Claim (with a minimum of 0, tracking would claim at once)
  async function seed(over: Partial<typeof beats.$inferInsert> = {}) {
    const [b] = await db.insert(beats).values({
      chain: 'polygon', ownerUserId: host.id, name: 'Night', description: '', imageUrl: 'https://cdn.example/f.webp',
      tokenId: tokenSeq++, status: 'live', minPresentSeconds: 0, supplyCap: 100, autoClaim: false, startsAt: at(-H), endsAt: at(H), ...over,
    }).returning()
    await db.insert(beatScenes).values({ beatId: b.id, sceneId: sceneA })
    return b
  }
  async function visitor() {
    const wallet = randomWallet()
    const user = await createUser({ wallet })
    return { user, wallet, pass: issueScenePass(app, user as any, wallet, { sceneId: sceneA, locationId: null }, undefined, 'V').accessToken }
  }
  type V = Awaited<ReturnType<typeof visitor>>
  const go = (method: string, url: string, token: string, payload?: unknown, remoteAddress = '198.51.100.7') =>
    app.inject({ method: method as any, url, remoteAddress, headers: { authorization: `Bearer ${token}` }, payload: payload as any })
  const path = (b: { id: string }, p: string) => `/api/scenes/${sceneA}/beat/${b.id}/${p}`
  const track = (v: V, b: { id: string }) => go('POST', path(b, 'track'), v.pass, { consentVersion: BEAT_CONSENT_VERSION })
  const claim = (v: V, b: { id: string }, ip?: string) => go('POST', path(b, 'claim'), v.pass, undefined, ip)
  const row = async (beatId: string, userId: string) =>
    (await db.select().from(beatClaims).where(and(eq(beatClaims.beatId, beatId), eq(beatClaims.userId, userId))))[0]

  describe('per-network claim limit', () => {
    it('three claims per BEAT from one network, then too_many_from_network; another network is fine; only a hash is stored', async () => {
      const b = await seed()
      const vs = await Promise.all([1, 2, 3, 4, 5].map(() => visitor()))
      for (const v of vs) expect((await track(v, b)).statusCode).toBe(200)
      for (const v of vs.slice(0, 3)) expect((await claim(v, b)).statusCode).toBe(200)
      const fourth = await claim(vs[3], b)
      expect([fourth.statusCode, fourth.json().error]).toEqual([429, 'too_many_from_network'])
      expect((await row(b.id, vs[3].user.id)).status).toBe('present')
      expect((await claim(vs[4], b, '198.51.100.8')).statusCode).toBe(200)
      // Counted apart from the claims, as a hash under the BEAT's own random salt; the address is stored nowhere
      const counts = await db.select().from(beatNetworkClaims).where(eq(beatNetworkClaims.beatId, b.id))
      expect(counts.map((c) => c.claims).sort()).toEqual([1, 3])
      expect(counts.every((c) => /^[0-9a-f]{32}$/.test(c.netHash))).toBe(true)
      const salt = (await db.query.beats.findFirst({ where: eq(beats.id, b.id) }))!.networkSalt
      expect(salt).toMatch(/^[0-9a-f]{64}$/)
      const all = JSON.stringify([await db.select().from(beatClaims), await db.select().from(beatNetworkClaims), await db.select().from(beats)])
      expect(all).not.toContain('198.51.100')
      // Salted per BEAT: the same network hashes differently on another BEAT
      const b2 = await seed()
      await track(vs[0], b2)
      await claim(vs[0], b2)
      const [c2] = await db.select().from(beatNetworkClaims).where(eq(beatNetworkClaims.beatId, b2.id))
      expect(counts.map((c) => c.netHash)).not.toContain(c2.netHash)
    })

    it('fix round I-2: deleting claims\' data, minted or not, never hands the network a claim back', async () => {
      const b = await seed()
      const vs = await Promise.all([1, 2, 3, 4].map(() => visitor()))
      for (const v of vs) await track(v, b)
      for (const v of vs.slice(0, 3)) expect((await claim(v, b)).statusCode).toBe(200)
      await db.update(beatClaims).set({ status: 'minted', mintedAt: new Date() }).where(eq(beatClaims.userId, vs[0].user.id))
      await deleteMyBeatData(vs[0].user.id, new Date())
      await deleteMyBeatData(vs[1].user.id, new Date())
      expect((await claim(vs[3], b)).json().error).toBe('too_many_from_network')
    })

    it('fix round I-2: a claim the host removed still counts for its network, and its wallet stays out after a delete', async () => {
      ;(config as any).beats = { ...config.beats, claimsPerIp: 1 }
      const b = await seed({ holdMints: true })
      const [x, y] = [await visitor(), await visitor()]
      await track(x, b)
      await track(y, b)
      expect((await claim(x, b)).statusCode).toBe(200)
      const xId = (await row(b.id, x.user.id)).id
      const rm = await app.inject({ method: 'DELETE', url: `/api/beats/${b.id}/claims/${xId}`, headers: { authorization: `Bearer ${tokenFor(host)}` } })
      expect(rm.statusCode, rm.body).toBe(200)
      expect((await claim(y, b)).json().error).toBe('too_many_from_network')
      // The removed visitor deletes their data: a wallet-only tombstone stays, so they can't come back
      await deleteMyBeatData(x.user.id, new Date())
      const [tomb] = await db.select().from(beatClaims).where(eq(beatClaims.id, xId))
      expect(tomb).toMatchObject({ status: 'removed', userId: null, displayName: null, wallet: x.wallet.toLowerCase() })
      expect((await track(x, b)).json().error).toBe('not_available')
    })

    it('fix round I-5: a network brings at most BEAT_NEW_WALLETS_PER_IP_HOUR new wallets to BEATs; an older wallet is not counted', async () => {
      ;(config as any).beats = { ...config.beats, newWalletsPerIpHour: 2 }
      resetNewWallets()
      const b = await seed()
      const vs = await Promise.all([1, 2, 3].map(() => visitor()))
      expect((await track(vs[0], b)).statusCode).toBe(200)
      expect((await track(vs[0], b)).statusCode).toBe(200) // the same wallet again: counted once
      expect((await track(vs[1], b)).statusCode).toBe(200)
      const third = await track(vs[2], b)
      expect([third.statusCode, third.json().error]).toEqual([429, 'too_many_new_wallets'])
      // A wallet Virvi has known for over a day isn't new
      await db.update(userAuthMethods).set({ createdAt: new Date(Date.now() - 25 * H) }).where(eq(userAuthMethods.userId, vs[2].user.id))
      expect((await track(vs[2], b)).statusCode).toBe(200)
      resetNewWallets()
    })

    it('an IPv6 address counts by its /64', async () => {
      ;(config as any).beats = { ...config.beats, claimsPerIp: 1 }
      const b = await seed()
      const [x, y, z] = [await visitor(), await visitor(), await visitor()]
      for (const v of [x, y, z]) await track(v, b)
      expect((await claim(x, b, '2001:db8:1:2::1')).statusCode).toBe(200)
      expect((await claim(y, b, '2001:db8:1:2:ffff::9')).json().error).toBe('too_many_from_network')
      expect((await claim(z, b, '2001:db8:1:3::1')).statusCode).toBe(200)
    })

    it('delete-my-data on a minted claim keeps only its wallet', async () => {
      const b = await seed()
      const v = await visitor()
      await track(v, b)
      await claim(v, b)
      await db.update(beatClaims).set({ status: 'minted', mintedAt: new Date() }).where(eq(beatClaims.userId, v.user.id))
      await deleteMyBeatData(v.user.id, new Date())
      const [left] = await db.select().from(beatClaims).where(eq(beatClaims.beatId, b.id))
      expect(left).toMatchObject({ userId: null, displayName: null, wallet: v.wallet.toLowerCase() })
    })
  })

  describe('live room presence', () => {
    it('a check-in with no live connection is accepted and credits nothing; with one it credits; once it drops it stops', async () => {
      const b = await seed()
      const v = await visitor()
      await track(v, b)
      const set = (lastSeenAt: Date) => db.update(beatClaims).set({ lastSeenAt }).where(eq(beatClaims.userId, v.user.id))
      await set(new Date(Date.now() - 30_000))
      const none = await go('POST', path(b, 'checkin'), v.pass)
      expect(none.statusCode, none.body).toBe(200)
      expect((await row(b.id, v.user.id)).secondsPresent).toBe(0)

      await markBeatLive(sceneA, v.user.id, Date.now() - 10 * 60_000)
      await set(new Date(Date.now() - 30_000))
      await go('POST', path(b, 'checkin'), v.pass)
      const credited = (await row(b.id, v.user.id)).secondsPresent!
      expect(credited).toBeGreaterThanOrEqual(29)
      expect(credited).toBeLessThanOrEqual(31)

      await clearBeatLive(sceneA, v.user.id)
      await set(new Date(Date.now() - 30_000))
      await go('POST', path(b, 'checkin'), v.pass)
      expect((await row(b.id, v.user.id)).secondsPresent).toBe(credited)
    })

    it('only the time since the connection opened counts', async () => {
      const b = await seed()
      const v = await visitor()
      await track(v, b)
      await db.update(beatClaims).set({ lastSeenAt: new Date(Date.now() - 30_000) }).where(eq(beatClaims.userId, v.user.id))
      await markBeatLive(sceneA, v.user.id, Date.now() - 10_000)
      await go('POST', path(b, 'checkin'), v.pass)
      const s = (await row(b.id, v.user.id)).secondsPresent!
      expect(s).toBeGreaterThanOrEqual(9)
      expect(s).toBeLessThanOrEqual(11)
    })

    const waitLive = async (userId: string, want: 'set' | 'unset', ms = 3000) => {
      const start = Date.now()
      while (Date.now() - start < ms) {
        const v = await beatLiveSince(sceneA, userId)
        if ((v !== null) === (want === 'set')) return v
        await new Promise((r) => setTimeout(r, 20))
      }
      throw new Error(`live mark never became ${want}`)
    }
    const liveKeys = () => Object.keys((busKeyValue() as unknown as { keys: Record<string, unknown> }).keys).filter((k) => k.startsWith('beat-live:'))

    it('the scene room marks a signed-in scene-pass visitor live while connected, never a guest, and clears it when they leave', async () => {
      await seed()
      const gs = await startGameServer()
      try {
        const v = await visitor()
        expect(await beatLiveSince(sceneA, v.user.id)).toBeNull()
        const c = await joinScene(gs.url, sceneA, v.pass)
        await c.waitFor('beat_available')
        const since = await waitLive(v.user.id, 'set')
        expect(Math.abs(since! - Date.now())).toBeLessThan(10_000)
        const guest = await joinScene(gs.url, sceneA)
        await guest.waitFor('beat_available')
        await new Promise((r) => setTimeout(r, 100))
        expect(liveKeys()).toEqual([`beat-live:${sceneA}:${v.user.id}`])
        await c.room.leave()
        await waitLive(v.user.id, 'unset')
        await guest.room.leave()
      } finally {
        await gs.stop()
      }
    })

    it('M-9: a scene without a BEAT open writes no live mark', async () => {
      const gs = await startGameServer()
      try {
        const v = await visitor()
        const c = await joinScene(gs.url, sceneA, v.pass)
        await c.waitFor('beat_available')
        await new Promise((r) => setTimeout(r, 150))
        expect(await beatLiveSince(sceneA, v.user.id)).toBeNull()
        await c.room.leave()
      } finally {
        await gs.stop()
      }
    })

    it('two connections of one user: one drops, the other keeps them live; the refresh outlives the TTL; without it the mark expires', async () => {
      await seed()
      const prevTiming = { ...beatLiveTiming }
      beatLiveTiming.ttlS = 1
      beatLiveTiming.refreshMs = 200
      const gs = await startGameServer()
      try {
        const v = await visitor()
        const a = await joinScene(gs.url, sceneA, v.pass)
        await a.waitFor('beat_available')
        const b = await joinScene(gs.url, sceneA, v.pass)
        await b.waitFor('beat_available')
        await waitLive(v.user.id, 'set')
        await a.room.leave()
        await new Promise((r) => setTimeout(r, 100))
        expect(await beatLiveSince(sceneA, v.user.id)).not.toBeNull()
        // Past the 1 s TTL: the refresh kept it
        await new Promise((r) => setTimeout(r, 1500))
        expect(await beatLiveSince(sceneA, v.user.id)).not.toBeNull()
        await b.room.leave()
        await waitLive(v.user.id, 'unset')
        // A mark nobody refreshes expires with its TTL
        await markBeatLive(sceneA, v.user.id, Date.now())
        expect(await beatLiveSince(sceneA, v.user.id)).not.toBeNull()
        await new Promise((r) => setTimeout(r, 1200))
        expect(await beatLiveSince(sceneA, v.user.id)).toBeNull()
      } finally {
        Object.assign(beatLiveTiming, prevTiming)
        await gs.stop()
      }
    })

    it('M-9: a connection whose scene pass expired without a renewal stops being live at the next refresh', async () => {
      await seed()
      const prevTiming = { ...beatLiveTiming }
      beatLiveTiming.refreshMs = 200
      const gs = await startGameServer()
      try {
        const v = await visitor()
        const short = issueScenePass(app, v.user as any, v.wallet, { sceneId: sceneA, locationId: null }, new Date(Date.now() + 1500), 'V').accessToken
        const c = await joinScene(gs.url, sceneA, short)
        await c.waitFor('beat_available')
        await waitLive(v.user.id, 'set')
        await waitLive(v.user.id, 'unset', 4000)
        await c.room.leave().catch(() => {})
      } finally {
        Object.assign(beatLiveTiming, prevTiming)
        await gs.stop()
      }
    })
    it('N-3: renewing the pass after it expired makes the visitor live again', async () => {
      await seed()
      const prevTiming = { ...beatLiveTiming }
      beatLiveTiming.refreshMs = 200
      const gs = await startGameServer()
      try {
        const v = await visitor()
        const short = issueScenePass(app, v.user as any, v.wallet, { sceneId: sceneA, locationId: null }, new Date(Date.now() + 1500), 'V').accessToken
        const c = await joinScene(gs.url, sceneA, short)
        await c.waitFor('beat_available')
        await waitLive(v.user.id, 'set')
        await waitLive(v.user.id, 'unset', 4000)
        c.room.send('auth_renew', { sessionToken: v.pass })
        await c.waitFor('auth_renew_ack')
        await waitLive(v.user.id, 'set')
        await c.room.leave()
      } finally {
        Object.assign(beatLiveTiming, prevTiming)
        await gs.stop()
      }
    })
  })

  describe('fix round 2', () => {
    it('N-1: claimed_at is stamped by the database clock, whatever clock the request carries', async () => {
      const b = await seed()
      const v = await visitor()
      await track(v, b)
      const stale = new Date(Date.now() - 10 * 60_000)
      await claimBeat(sceneA, b.id, { userId: v.user.id }, stale)
      const at = (await row(b.id, v.user.id)).claimedAt!
      expect(Math.abs(at.getTime() - Date.now())).toBeLessThan(60_000)
    })

    it('N-2: the network hash is keyed by a server secret as well as the BEAT\'s salt: the salt alone doesn\'t reproduce it', async () => {
      const prev = config.beats
      try {
        ;(config as any).beats = { ...config.beats, networkHashSecret: 'secret-a' }
        const a = beatNetworkHash('salt', '198.51.100.7')
        expect(beatNetworkHash('salt', '198.51.100.7')).toBe(a)
        ;(config as any).beats = { ...config.beats, networkHashSecret: 'secret-b' }
        expect(beatNetworkHash('salt', '198.51.100.7')).not.toBe(a)
        const saltOnly = createHmac('sha256', 'salt').update('198.51.100.7').digest('hex').slice(0, 32)
        expect(a).not.toBe(saltOnly)
      } finally {
        ;(config as any).beats = prev
      }
      // Unset, it falls back to a key derived from JWT_SECRET with a fixed label (never JWT_SECRET itself)
      expect(beatSettingsFrom({ JWT_SECRET: 'j' }).networkHashSecret).toBe(createHmac('sha256', 'j').update('virvi-beat-network-hash').digest('hex'))
      expect(beatSettingsFrom({ BEAT_NETWORK_HASH_SECRET: 'x'.repeat(32) }).networkHashSecret).toBe('x'.repeat(32))
    })

    it('the host\'s claimant list leaves out a removed tombstone whose user is gone', async () => {
      const b = await seed({ holdMints: true })
      const v = await visitor()
      await track(v, b)
      await claim(v, b)
      const id = (await row(b.id, v.user.id)).id
      const as = { authorization: `Bearer ${tokenFor(host)}` }
      await app.inject({ method: 'DELETE', url: `/api/beats/${b.id}/claims/${id}`, headers: as })
      const before = (await app.inject({ method: 'GET', url: `/api/beats/${b.id}/claimants`, headers: as })).json()
      expect(before.map((c: { status: string }) => c.status)).toEqual(['removed'])
      await deleteMyBeatData(v.user.id, new Date())
      expect((await app.inject({ method: 'GET', url: `/api/beats/${b.id}/claimants`, headers: as })).json()).toEqual([])
    })
  })

  describe('per-platform wallet check (Decentraland profile)', () => {
    it('a wallet without a deployed profile gets profile_required at tracking and at claiming', async () => {
      const b = await seed()
      const v = await visitor()
      setBeatPlatformCheckForTests('decentraland', async () => false)
      const t = await track(v, b)
      expect([t.statusCode, t.json().error]).toEqual([403, 'profile_required'])
      setBeatPlatformCheckForTests('decentraland', async () => true)
      expect((await track(v, b)).statusCode).toBe(200)
      setBeatPlatformCheckForTests('decentraland', async () => false)
      const c = await claim(v, b)
      expect([c.statusCode, c.json().error]).toEqual([403, 'profile_required'])
      expect((await row(b.id, v.user.id)).status).toBe('present')
    })

    it('the Decentraland check reads the catalyst (mocked fetch): profile passes, none fails, cached per wallet', async () => {
      setBeatPlatformCheckForTests('decentraland', undefined)
      const calls: string[] = []
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        calls.push(String(url))
        if (String(url).endsWith('/0x00000000000000000000000000000000000000aa')) return new Response(JSON.stringify({ avatars: [{ name: 'A' }] }), { status: 200 })
        if (String(url).endsWith('/0x00000000000000000000000000000000000000bb')) return new Response(JSON.stringify({ avatars: [] }), { status: 200 })
        return new Response('not found', { status: 404 })
      }))
      const now = new Date()
      expect(await platformCheck('decentraland', '0x00000000000000000000000000000000000000AA', now)).toBe(true)
      expect(await platformCheck('decentraland', '0x00000000000000000000000000000000000000bb', now)).toBe(false)
      expect(await platformCheck('decentraland', '0x00000000000000000000000000000000000000cc', now)).toBe(false)
      expect(calls[0]).toBe(`${config.beats.profileCatalystUrl}/lambdas/profiles/0x00000000000000000000000000000000000000aa`)
      expect(await platformCheck('decentraland', '0x00000000000000000000000000000000000000aa', new Date(now.getTime() + 23 * H))).toBe(true)
      expect(calls).toHaveLength(3)
      expect(await platformCheck('decentraland', '0x00000000000000000000000000000000000000aa', new Date(now.getTime() + 25 * H))).toBe(true)
      expect(calls).toHaveLength(4)
      // A platform with no check passes
      expect(await platformCheck('hyperfy', '0x00000000000000000000000000000000000000cc', now)).toBe(true)
    })

    it('fails open when the catalyst is down, reporting it at most once an hour', async () => {
      setBeatPlatformCheckForTests('decentraland', undefined)
      vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })))
      const now = new Date()
      expect(await platformCheck('decentraland', randomWallet(), now)).toBe(true)
      expect(await platformCheck('decentraland', randomWallet(), new Date(now.getTime() + 30 * 60_000))).toBe(true)
      expect(vi.mocked(recordJobFailure)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(recordJobFailure).mock.calls[0][0]).toBe('beat_profile_check')
      await platformCheck('decentraland', randomWallet(), new Date(now.getTime() + 61 * 60_000))
      expect(vi.mocked(recordJobFailure)).toHaveBeenCalledTimes(2)
    })
  })

  describe('host review before minting', () => {
    const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
    it('holdMints is set on create; the host removes a claimed claim (its supply frees) and then sends; after that nothing can be removed', async () => {
      const b = await seed({ holdMints: true, supplyCap: 1 })
      const [x, y] = [await visitor(), await visitor()]
      await track(x, b)
      await track(y, b)
      expect((await claim(x, b)).statusCode).toBe(200)
      expect((await claim(y, b, '198.51.100.9')).json().error).toBe('all_claimed')
      const got = (await app.inject({ method: 'GET', url: `/api/beats/${b.id}`, headers: as(host) })).json()
      expect(got).toMatchObject({ holdMints: true, mintsReleasedAt: null })
      expect(new Date(got.mintsHeldUntil).getTime()).toBe(b.endsAt.getTime() + 24 * H)
      const list = (await app.inject({ method: 'GET', url: `/api/beats/${b.id}/claimants`, headers: as(host) })).json()
      const xClaim = list.find((c: { status: string }) => c.status === 'claimed')
      const rm = await app.inject({ method: 'DELETE', url: `/api/beats/${b.id}/claims/${xClaim.id}`, headers: as(host) })
      expect(rm.statusCode, rm.body).toBe(200)
      expect((await row(b.id, x.user.id)).status).toBe('removed')
      // The freed slot: y can claim now; x can't claim again
      expect((await claim(y, b, '198.51.100.9')).statusCode).toBe(200)
      expect((await row(b.id, y.user.id)).status).toBe('claimed')
      await claim(x, b)
      expect((await row(b.id, x.user.id)).status).toBe('removed')
      // Only claimed claims; a stranger can't
      const stranger = await createUser()
      expect((await app.inject({ method: 'DELETE', url: `/api/beats/${b.id}/claims/${xClaim.id}`, headers: as(stranger) })).statusCode).toBe(404)
      expect((await app.inject({ method: 'DELETE', url: `/api/beats/${b.id}/claims/${xClaim.id}`, headers: as(host) })).json().error).toBe('not_removable')
      const send = await app.inject({ method: 'POST', url: `/api/beats/${b.id}/release`, headers: as(host) })
      expect(send.statusCode, send.body).toBe(200)
      expect(send.json()).toMatchObject({ heldClaims: 0 }) // M-4: still held for claims made later, so mintsHeldUntil stays set
      expect(send.json().mintsReleasedAt).toBeTruthy()
      // y was claimed before the Send, so it's released and can't be removed any more
      const yId = (await row(b.id, y.user.id)).id
      expect((await app.inject({ method: 'DELETE', url: `/api/beats/${b.id}/claims/${yId}`, headers: as(host) })).json().error).toBe('not_held')
    })

    it('fix round M-4: a claim made after Send waits for another Send; the host may still remove it; Send again releases it', async () => {
      const b = await seed({ holdMints: true })
      const [x, y] = [await visitor(), await visitor()]
      await track(x, b)
      await track(y, b)
      await claim(x, b)
      const first = await app.inject({ method: 'POST', url: `/api/beats/${b.id}/release`, headers: as(host) })
      expect(first.json()).toMatchObject({ heldClaims: 0 })
      await new Promise((r) => setTimeout(r, 20))
      await claim(y, b)
      const got = (await app.inject({ method: 'GET', url: `/api/beats/${b.id}`, headers: as(host) })).json()
      expect(got.heldClaims).toBe(1)
      expect(got.mintsHeldUntil).not.toBeNull()
      const yId = (await row(b.id, y.user.id)).id
      const xId = (await row(b.id, x.user.id)).id
      expect((await app.inject({ method: 'DELETE', url: `/api/beats/${b.id}/claims/${xId}`, headers: as(host) })).json().error).toBe('not_held')
      const again = await app.inject({ method: 'POST', url: `/api/beats/${b.id}/release`, headers: as(host) })
      expect([again.statusCode, again.json().heldClaims]).toEqual([200, 0])
      expect((await app.inject({ method: 'DELETE', url: `/api/beats/${b.id}/claims/${yId}`, headers: as(host) })).json().error).toBe('not_held')
    })

    it('fix round M-1: removing a claim the job took meanwhile says not_removable, not removed', async () => {
      const b = await seed({ holdMints: true })
      const x = await visitor()
      await track(x, b)
      await claim(x, b)
      const xId = (await row(b.id, x.user.id)).id
      await db.update(beatClaims).set({ status: 'minting' }).where(eq(beatClaims.id, xId))
      const rm = await app.inject({ method: 'DELETE', url: `/api/beats/${b.id}/claims/${xId}`, headers: as(host) })
      expect([rm.statusCode, rm.json().error]).toEqual([409, 'not_removable'])
      const missing = await app.inject({ method: 'DELETE', url: `/api/beats/${b.id}/claims/00000000-0000-4000-8000-000000000009`, headers: as(host) })
      expect(missing.statusCode).toBe(404)
    })

    it('holdMints is off by default, set on create and editable until go-live', async () => {
      const off = await seed({ status: 'draft', tokenId: null, startsAt: at(2 * H), endsAt: at(3 * H) })
      const ed = await app.inject({ method: 'PATCH', url: `/api/beats/${off.id}`, headers: as(host), payload: { holdMints: true } })
      expect(ed.statusCode, ed.body).toBe(200)
      expect(ed.json().holdMints).toBe(true)
      const live = await seed()
      expect((await app.inject({ method: 'PATCH', url: `/api/beats/${live.id}`, headers: as(host), payload: { holdMints: true } })).json().error).toBe('locked')
      expect((await app.inject({ method: 'PATCH', url: `/api/beats/${off.id}`, headers: as(host), payload: { holdMints: 'yes' } })).json().error).toBe('bad_request')
    })
  })
})
