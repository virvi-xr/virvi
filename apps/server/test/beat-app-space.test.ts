import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { getAddress } from 'ethers'
import { AR_FEED, BEAT_APP_CONSENT_VERSION, BEAT_CONSENT_VERSION } from '@virvixr/shared'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { arSpaces, beatClaims, beats, beatScenes, mediaAssets, userAuthMethods } from '../src/db/schema.js'
import { issueScenePass } from '../src/auth/scene-pass.js'
import { arLiveSince, markBeatLive } from '../src/beats/live.js'
import { checkInBeat, takenCount } from '../src/beats/visitor.js'
import { appCheckIn } from '../src/beats/app.js'
import { setBeatPlatformCheckForTests } from '../src/beats/platform-checks.js'
import { setArFeedHoldMs } from '../src/routes/ar-feed.js'
import { resetNewWallets } from '../src/beats/new-wallet-limit.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, randomWallet, testApp, tokenFor, type TestUser } from './helpers/factories.js'
import { makeAttestation, makeDevice, makeTestCa, type TestCa, type TestDevice } from './helpers/app-attest.js'

const H = 3_600_000
const M = 60_000
const S = 1_000
const at = (ms: number) => new Date(Date.now() + ms)
const APP_ID = 'P22YGT64VU.io.virvi.app'

describe('BEATs in AR spaces with the Virvi app', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let ca: TestCa
  let host: TestUser
  let sceneId: string
  let spaceId: string
  let imageId: string
  const prevBeats = config.beats
  const prevAttest = config.appAttest

  beforeEach(async () => {
    await resetDb()
    // The network limits stay at their defaults: app claims must not meet them (Review Focus 2)
    ;(config as any).beats = { ...config.beats, enabled: true, chain: 'polygon' }
    ca = makeTestCa()
    ;(config as any).appAttest = { ...config.appAttest, rootCa: ca.rootPem, appId: APP_ID, env: 'production' }
    setBeatPlatformCheckForTests('decentraland', async () => true)
    setArFeedHoldMs(0)
    resetNewWallets()
    app = await testApp()
    host = await createUser({ wallet: randomWallet() })
    sceneId = (await createScene(host, 'Hall')).scene.id
    const [space] = await db.insert(arSpaces).values({ sceneId, name: 'Hall in AR', published: true }).returning()
    spaceId = space.id
    const [m] = await db.insert(mediaAssets).values({ ownerId: host.id, filename: 'b.png', contentType: 'image/png', sizeBytes: 1, storageKey: 'k', publicUrl: 'https://cdn.example/b.png' }).returning()
    imageId = m.id
  })
  afterEach(async () => {
    ;(config as any).beats = prevBeats
    ;(config as any).appAttest = prevAttest
    setBeatPlatformCheckForTests('decentraland', undefined)
    setArFeedHoldMs(AR_FEED.holdMs)
    await app.close()
  })

  let tokenSeq = 500
  async function seed(over: Partial<typeof beats.$inferInsert> = {}) {
    const [b] = await db.insert(beats).values({
      chain: 'polygon', ownerUserId: host.id, name: 'Opening night', description: '', imageMediaId: imageId, imageUrl: 'https://cdn.example/frozen.png',
      tokenId: tokenSeq++, status: 'live', minPresentSeconds: 300, supplyCap: 100, startsAt: at(-H), endsAt: at(H), ...over,
    }).returning()
    await db.insert(beatScenes).values({ beatId: b.id, sceneId })
    return b
  }

  interface Phone { user: TestUser; device: TestDevice; ip: string }
  /** A signed-in visitor with an attested install (registered against the test CA). */
  async function phone(o: { wallets?: number; emailVerified?: boolean; device?: TestDevice; user?: TestUser; ip?: string } = {}): Promise<Phone> {
    const user = o.user ?? (await createUser({ wallet: (o.wallets ?? 1) > 0 ? randomWallet() : null, emailVerified: o.emailVerified }))
    for (let i = 1; i < (o.wallets ?? 1); i++) {
      await db.insert(userAuthMethods).values({ userId: user.id, type: 'wallet', identifier: randomWallet().toLowerCase(), metadata: { verified: true } })
    }
    let device = o.device
    if (!device) {
      device = makeDevice(APP_ID)
      const ch = (await app.inject({ method: 'GET', url: '/api/app/attest/challenge', headers: { authorization: `Bearer ${tokenFor(user)}` } })).json().challenge
      const reg = await app.inject({
        method: 'POST', url: '/api/app/attest/register', headers: { authorization: `Bearer ${tokenFor(user)}` },
        payload: { keyId: device.keyId, attestation: makeAttestation(ca, device, ch, { appId: APP_ID }), challenge: ch },
      })
      expect(reg.statusCode, reg.body).toBe(201)
    }
    return { user, device, ip: o.ip ?? '127.0.0.1' }
  }
  /** A write from the app: the body as sent, signed by the install's key. */
  const write = (p: Phone, method: 'POST' | 'DELETE', url: string, body?: unknown) => {
    const raw = body === undefined ? '' : JSON.stringify(body)
    return app.inject({
      method, url, remoteAddress: p.ip, payload: raw || undefined,
      headers: { authorization: `Bearer ${tokenFor(p.user)}`, 'x-virvi-attest': p.device.assert(raw), ...(raw ? { 'content-type': 'application/json' } : {}) },
    })
  }
  const read = (p: Phone | TestUser, url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${tokenFor('user' in p ? p.user : p)}` } })
  const card = (p: Phone | TestUser, space = spaceId) => read(p, `/api/app/spaces/${space}/beat`)
  const track = (p: Phone, b: { id: string }, body: Record<string, unknown> = {}) =>
    write(p, 'POST', `/api/app/beats/${b.id}/track`, { consentVersion: BEAT_APP_CONSENT_VERSION, spaceId, ...body })
  const claim = (p: Phone, b: { id: string }, body: Record<string, unknown> = {}) => write(p, 'POST', `/api/app/beats/${b.id}/claim`, body)
  const poll = (p: Phone) => app.inject({ method: 'GET', url: `/api/ar/spaces/${spaceId}/feed`, headers: { authorization: `Bearer ${tokenFor(p.user)}` } })
  const rows = (beatId: string) => db.select().from(beatClaims).where(eq(beatClaims.beatId, beatId))
  const rowOf = async (beatId: string, userId: string) => (await db.select().from(beatClaims).where(and(eq(beatClaims.beatId, beatId), eq(beatClaims.userId, userId))))[0]
  /** `n` app check-ins 30 s apart after the claim's last, at the service (the routes use the real clock). */
  async function checkIns(p: Phone, b: { id: string }, n: number) {
    const last = (await rowOf(b.id, p.user.id)).lastSeenAt!.getTime()
    for (let i = 1; i <= n; i++) await appCheckIn(b.id, { userId: p.user.id, spaceId }, new Date(last + i * 30 * S))
  }

  it("shows a published space's live BEAT as a card, with the caller's wallets", async () => {
    const b = await seed({ locationType: 'in_person', locationVenue: 'The Hall', locationCity: 'Lisbon', locationCountry: 'Portugal' })
    const p = await phone({ wallets: 1 })
    const res = await card(p)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().beat).toEqual({
      beatId: b.id, name: 'Opening night', imageUrl: 'https://cdn.example/frozen.png', minMinutes: 5,
      startsAt: b.startsAt.toISOString(), endsAt: b.endsAt.toISOString(), location: { type: 'in_person', venue: 'The Hall' },
      claim: null, wallets: [getAddress(p.user.wallet!)],
    })
    // No BEAT on the scene: no card; an unpublished space is hidden from visitors; a bad id is 404
    await db.delete(beatScenes).where(eq(beatScenes.beatId, b.id))
    expect((await card(p)).json()).toEqual({ beat: null })
    await db.insert(beatScenes).values({ beatId: b.id, sceneId })
    await db.update(arSpaces).set({ published: false }).where(eq(arSpaces.id, spaceId))
    expect((await card(p)).statusCode).toBe(404)
    expect((await card(host)).statusCode).toBe(200) // its builders still see it
    expect((await card(p, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404)
  })

  it("shows a signed-out visitor a published space's BEAT with no claim and no wallets, hides an unpublished space, and refuses a scene pass", async () => {
    const b = await seed({ locationType: 'scene' })
    const anon = () => app.inject({ method: 'GET', url: `/api/app/spaces/${spaceId}/beat` })
    const res = await anon()
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().beat).toMatchObject({ beatId: b.id, claim: null, wallets: [] })
    // A bad token is refused as on any route; a scene pass gains nothing here
    expect((await app.inject({ method: 'GET', url: `/api/app/spaces/${spaceId}/beat`, headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401)
    const pass = issueScenePass(app, host, host.wallet!, { sceneId, locationId: null }, null).accessToken
    expect((await app.inject({ method: 'GET', url: `/api/app/spaces/${spaceId}/beat`, headers: { authorization: `Bearer ${pass}` } })).statusCode).toBeGreaterThanOrEqual(401)
    // Writes stay signed-in only
    expect((await app.inject({ method: 'POST', url: `/api/app/beats/${b.id}/track`, payload: {} })).statusCode).toBe(401)
    await db.update(arSpaces).set({ published: false }).where(eq(arSpaces.id, spaceId))
    expect((await anon()).statusCode).toBe(404)
  })

  it('every write needs an App Attest assertion (401), and tracking needs the app consent and a verified email or wallet', async () => {
    const b = await seed()
    const p = await phone()
    const unsigned = await app.inject({ method: 'POST', url: `/api/app/beats/${b.id}/track`, headers: { authorization: `Bearer ${tokenFor(p.user)}` }, payload: { consentVersion: 1, spaceId } })
    expect([unsigned.statusCode, unsigned.json().error]).toEqual([401, 'attest_required'])
    expect((await track(p, b, { consentVersion: BEAT_CONSENT_VERSION })).json().error).toBe('bad_consent')
    const unverified = await phone({ wallets: 0, emailVerified: false })
    const res = await track(unverified, b)
    expect([res.statusCode, res.json()]).toEqual([403, { error: 'verify_first', message: 'Verify your email at virvi.io to earn BEATs.' }])
    expect(await rows(b.id)).toHaveLength(0)
    // A verified email without a wallet is enough
    expect((await track(await phone({ wallets: 0 }), b)).statusCode).toBe(200)
  })

  it('tracking makes an app claim with no wallet; check-ins without a feed poll credit nothing', async () => {
    const b = await seed()
    const p = await phone()
    const res = await track(p, b)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().beat.claim).toMatchObject({ status: 'present', secondsPresent: 0, wallet: null })
    expect(await rowOf(b.id, p.user.id)).toMatchObject({ source: 'app_space', wallet: null, installKeyId: p.device.keyId, consentVersion: BEAT_APP_CONSENT_VERSION })
    expect(await arLiveSince(spaceId, p.user.id)).toBeNull()
    await checkIns(p, b, 4)
    expect((await rowOf(b.id, p.user.id)).secondsPresent).toBe(0)
    // Tracking again keeps the claim
    expect((await track(p, b)).statusCode).toBe(200)
    expect(await rows(b.id)).toHaveLength(1)
  })

  it('a signed-in feed poll marks the visitor live in the space; an anonymous one does not', async () => {
    const p = await phone()
    expect((await app.inject({ method: 'GET', url: `/api/ar/spaces/${spaceId}/feed` })).statusCode).toBe(200)
    expect((await poll(p)).statusCode).toBe(200)
    const since = await arLiveSince(spaceId, p.user.id)
    expect(since).toEqual(expect.any(Number))
    // Kept from the first poll while the mark lives
    expect((await poll(p)).statusCode).toBe(200)
    expect(await arLiveSince(spaceId, p.user.id)).toBe(since)
  })

  it('after feed polls covering 6 minutes, a 5-minute BEAT claims to the only wallet', async () => {
    const b = await seed()
    const p = await phone({ wallets: 1 })
    await poll(p)
    expect((await track(p, b)).statusCode).toBe(200)
    await checkIns(p, b, 12)
    expect((await rowOf(b.id, p.user.id)).secondsPresent).toBe(360)
    const res = await claim(p, b)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().beat.claim).toMatchObject({ status: 'claimed', wallet: getAddress(p.user.wallet!) })
    expect(await rowOf(b.id, p.user.id)).toMatchObject({ status: 'claimed', wallet: p.user.wallet })
  })

  it('too soon is not_yet; several wallets ask which (409 choose_wallet); the chosen one gets it; not the caller\'s is 400', async () => {
    const b = await seed()
    const p = await phone({ wallets: 2 })
    expect((await track(p, b)).statusCode).toBe(200)
    expect((await claim(p, b)).json().error).toBe('not_yet')
    await db.update(beatClaims).set({ secondsPresent: 300 }).where(eq(beatClaims.beatId, b.id))
    const ask = await claim(p, b)
    expect(ask.statusCode).toBe(409)
    expect(ask.json().error).toBe('choose_wallet')
    const wallets: string[] = ask.json().wallets
    expect(wallets).toHaveLength(2)
    expect((await claim(p, b, { wallet: randomWallet() })).statusCode).toBe(400)
    const res = await claim(p, b, { wallet: wallets[1].toLowerCase() })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().beat.claim).toMatchObject({ status: 'claimed', wallet: wallets[1] })
    expect((await rowOf(b.id, p.user.id)).wallet).toBe(wallets[1].toLowerCase())
  })

  it('with no wallet the claim waits, holding a copy (takenCount)', async () => {
    const b = await seed({ supplyCap: 1 })
    const p = await phone({ wallets: 0 })
    await track(p, b)
    await db.update(beatClaims).set({ secondsPresent: 300 }).where(eq(beatClaims.beatId, b.id))
    const res = await claim(p, b)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().beat.claim).toMatchObject({ status: 'waiting', wallet: null })
    expect(await takenCount(db, b.id)).toBe(1)
    const next = await phone()
    await track(next, b)
    await db.update(beatClaims).set({ secondsPresent: 300 }).where(eq(beatClaims.userId, next.user.id))
    expect((await claim(next, b)).json().error).toBe('all_claimed')
  })

  it('one claim per phone per BEAT: the same install on a second account is 409 this_device', async () => {
    const b = await seed()
    const first = await phone()
    expect((await track(first, b)).statusCode).toBe(200)
    const second = await phone({ device: first.device })
    const res = await track(second, b)
    expect([res.statusCode, res.json().error, res.json().message]).toEqual([409, 'this_device', 'This phone already has this BEAT.'])
    expect(await rows(b.id)).toHaveLength(1)
    // Another BEAT is fine
    expect((await track(second, await seed())).statusCode).toBe(200)
  })

  it('3 minutes in-world then 2 in an AR space claim a 5-minute BEAT on one claim', async () => {
    const b = await seed()
    const p = await phone({ wallets: 1 })
    const wallet = p.user.wallet!
    const pass = issueScenePass(app, p.user as any, wallet, { sceneId, locationId: null }).accessToken
    const inWorld = await app.inject({ method: 'POST', url: `/api/scenes/${sceneId}/beat/${b.id}/track`, headers: { authorization: `Bearer ${pass}` }, payload: { consentVersion: BEAT_CONSENT_VERSION } })
    expect(inWorld.statusCode, inWorld.body).toBe(200)
    await markBeatLive(sceneId, p.user.id, 1)
    const tracked = (await rowOf(b.id, p.user.id)).lastSeenAt!.getTime()
    for (let i = 1; i <= 6; i++) await checkInBeat(sceneId, b.id, p.user.id, new Date(tracked + i * 30 * S))
    expect((await rowOf(b.id, p.user.id)).secondsPresent).toBe(180)
    await poll(p)
    const res = await track(p, b)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().beat.claim).toMatchObject({ status: 'present', secondsPresent: 180 })
    await checkIns(p, b, 4)
    const done = await claim(p, b)
    expect(done.statusCode, done.body).toBe(200)
    expect(done.json().beat.claim).toMatchObject({ status: 'claimed', secondsPresent: 300, wallet: getAddress(wallet) })
    expect(await rows(b.id)).toHaveLength(1)
    expect(await rowOf(b.id, p.user.id)).toMatchObject({ source: 'decentraland', installKeyId: p.device.keyId })
  })

  it('an app-started claim with no wallet, tracked in-world, takes the Decentraland wallet', async () => {
    const b = await seed()
    const p = await phone({ wallets: 0 })
    await track(p, b)
    const wallet = randomWallet().toLowerCase()
    const pass = issueScenePass(app, p.user as any, wallet, { sceneId, locationId: null }).accessToken
    const res = await app.inject({ method: 'POST', url: `/api/scenes/${sceneId}/beat/${b.id}/track`, headers: { authorization: `Bearer ${pass}` }, payload: { consentVersion: BEAT_CONSENT_VERSION } })
    expect(res.statusCode, res.body).toBe(200)
    expect(await rowOf(b.id, p.user.id)).toMatchObject({ wallet, source: 'app_space', status: 'present' })
    expect(await rows(b.id)).toHaveLength(1)
  })

  it('an app-started claim claimed in-world takes the pass\'s wallet (never claimed without one)', async () => {
    const b = await seed()
    const p = await phone({ wallets: 0 })
    await track(p, b)
    await db.update(beatClaims).set({ secondsPresent: 300 }).where(eq(beatClaims.beatId, b.id))
    const wallet = randomWallet().toLowerCase()
    const pass = issueScenePass(app, p.user as any, wallet, { sceneId, locationId: null }).accessToken
    const res = await app.inject({ method: 'POST', url: `/api/scenes/${sceneId}/beat/${b.id}/claim`, headers: { authorization: `Bearer ${pass}` } })
    expect(res.statusCode, res.body).toBe(200)
    expect(await rowOf(b.id, p.user.id)).toMatchObject({ wallet, status: 'claimed' })
  })

  it('Review Focus 2: 30 visitors on one venue network all claim, with no network cap', async () => {
    const b = await seed({ supplyCap: 100 })
    expect(config.beats.claimsPerIp).toBeLessThan(30)
    const failures: string[] = []
    for (let i = 0; i < 30; i++) {
      const p = await phone({ wallets: 1, ip: '203.0.113.7' })
      const t = await track(p, b)
      if (t.statusCode !== 200) failures.push(`track ${i}: ${t.body}`)
      await db.update(beatClaims).set({ secondsPresent: 300 }).where(eq(beatClaims.userId, p.user.id))
      const c = await claim(p, b)
      if (c.statusCode !== 200 || c.json().beat.claim.status !== 'claimed') failures.push(`claim ${i}: ${c.body}`)
    }
    expect(failures).toEqual([])
    expect(await takenCount(db, b.id)).toBe(30)
  }, 180_000)

  /** In-world, from the scene: track with the pass's wallet, or claim, from `ip`. */
  const inWorld = (p: Phone, b: { id: string }, what: 'track' | 'claim', ip: string, wallet = p.user.wallet!) =>
    app.inject({
      method: 'POST', url: `/api/scenes/${sceneId}/beat/${b.id}/${what}`, remoteAddress: ip,
      headers: { authorization: `Bearer ${issueScenePass(app, p.user as any, wallet, { sceneId, locationId: null }).accessToken}` },
      payload: what === 'track' ? { consentVersion: BEAT_CONSENT_VERSION } : {},
    })

  it('a claim started in Decentraland keeps the per-network cap when claimed in the app; one started in the app does not', async () => {
    ;(config as any).beats = { ...config.beats, claimsPerIp: 1, newWalletsPerIpHour: 1000 }
    const ip = '198.51.100.20'
    const b = await seed()
    const first = await phone({ ip })
    expect((await inWorld(first, b, 'track', ip)).statusCode).toBe(200)
    await db.update(beatClaims).set({ secondsPresent: 300 }).where(eq(beatClaims.userId, first.user.id))
    expect((await inWorld(first, b, 'claim', ip)).statusCode).toBe(200)

    // Tracked in-world on the same network, claimed through the app: the in-world refusal, and nothing changes
    const viaApp = await phone({ ip })
    expect((await inWorld(viaApp, b, 'track', ip)).statusCode).toBe(200)
    await db.update(beatClaims).set({ secondsPresent: 300 }).where(eq(beatClaims.userId, viaApp.user.id))
    const refused = await claim(viaApp, b)
    const inWorldOnly = await phone({ ip })
    expect((await inWorld(inWorldOnly, b, 'track', ip)).statusCode).toBe(200)
    await db.update(beatClaims).set({ secondsPresent: 300 }).where(eq(beatClaims.userId, inWorldOnly.user.id))
    const refusedInWorld = await inWorld(inWorldOnly, b, 'claim', ip)
    expect([refused.statusCode, refused.json().error]).toEqual([429, 'too_many_from_network'])
    expect([refused.statusCode, refused.json()]).toEqual([refusedInWorld.statusCode, refusedInWorld.json()])
    expect(await rowOf(b.id, viaApp.user.id)).toMatchObject({ status: 'present', installKeyId: null })

    // Started in the app, on the same network: no cap
    const appOnly = await phone({ ip })
    expect((await track(appOnly, b)).statusCode).toBe(200)
    await db.update(beatClaims).set({ secondsPresent: 300 }).where(eq(beatClaims.userId, appOnly.user.id))
    const ok = await claim(appOnly, b)
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().beat.claim.status).toBe('claimed')
  })

  it('an app-started claim refused in-world (too early) keeps no wallet and costs its network no new wallet', async () => {
    ;(config as any).beats = { ...config.beats, newWalletsPerIpHour: 1 }
    const ip = '198.51.100.30'
    const b = await seed()
    const p = await phone({ wallets: 0, ip })
    await track(p, b)
    const passWallet = randomWallet().toLowerCase()
    const early = await inWorld(p, b, 'claim', ip, passWallet)
    expect(early.json().error).toBe('not_yet')
    expect(await rowOf(b.id, p.user.id)).toMatchObject({ wallet: null, status: 'present' })
    // The network's one new wallet is still free: another visitor's new wallet claims in-world from it
    const other = await phone({ ip })
    expect((await inWorld(other, b, 'track', ip)).statusCode).toBe(200)
    await db.update(beatClaims).set({ secondsPresent: 300 }).where(eq(beatClaims.userId, other.user.id))
    const ok = await inWorld(other, b, 'claim', ip)
    expect(ok.statusCode, ok.body).toBe(200)
  })

  it('stop deletes a present claim; once claimed it stays', async () => {
    const b = await seed()
    const p = await phone()
    await track(p, b)
    const stop = await write(p, 'DELETE', `/api/app/beats/${b.id}/track`)
    expect(stop.statusCode, stop.body).toBe(204)
    expect(await rows(b.id)).toHaveLength(0)
    await track(p, b)
    await db.update(beatClaims).set({ secondsPresent: 300 }).where(eq(beatClaims.beatId, b.id))
    expect((await claim(p, b)).statusCode).toBe(200)
    expect((await write(p, 'DELETE', `/api/app/beats/${b.id}/track`)).json().error).toBe('already_claimed')
  })

  it('mine lists the BEATs in progress, waiting and claimed, newest first', async () => {
    const older = await seed({ name: 'Older' })
    const newer = await seed({ name: 'Newer' })
    const p = await phone()
    await track(p, older)
    await db.update(beatClaims).set({ secondsPresent: 300, createdAt: at(-M) }).where(eq(beatClaims.beatId, older.id))
    await claim(p, older)
    await track(p, newer)
    const res = await read(p, '/api/app/beats/mine')
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().beats.map((c: any) => [c.name, c.claim.status])).toEqual([['Newer', 'present'], ['Older', 'claimed']])
  })

  it('a check-in from a space whose scene does not have the BEAT is 404', async () => {
    const b = await seed()
    const p = await phone()
    await track(p, b)
    const other = (await createScene(host, 'Elsewhere')).scene.id
    const [elsewhere] = await db.insert(arSpaces).values({ sceneId: other, name: 'Elsewhere', published: true }).returning()
    const res = await write(p, 'POST', `/api/app/beats/${b.id}/checkin`, { spaceId: elsewhere.id })
    expect(res.statusCode).toBe(404)
    expect((await write(p, 'POST', `/api/app/beats/${b.id}/checkin`, { spaceId })).statusCode).toBe(200)
  })
})
