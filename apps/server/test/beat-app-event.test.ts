import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { BEAT_APP_CONSENT_VERSION, ringCodeOf } from '@virvixr/shared'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { beatArcs, beatClaims, beats, mediaAssets, userAuthMethods } from '../src/db/schema.js'
import { appClaim, appTrack } from '../src/beats/app.js'
import { distanceM, locationCheck } from '../src/beats/geo.js'
import { setBeatPlatformCheckForTests } from '../src/beats/platform-checks.js'
import { resetNewWallets } from '../src/beats/new-wallet-limit.js'
import { resetDb } from './helpers/db.js'
import { createUser, randomWallet, testApp, tokenFor, type TestUser } from './helpers/factories.js'
import { makeAttestation, makeDevice, makeTestCa, type TestCa, type TestDevice } from './helpers/app-attest.js'

const H = 3_600_000
const M = 60_000
const at = (ms: number) => new Date(Date.now() + ms)
const APP_ID = 'P22YGT64VU.io.virvi.app'
const PIN = { lat: 38.7223, lng: -9.1393, radiusM: 150 }
/** A point `m` metres due north of the pin (1 degree of latitude = 111 194.9 m on this sphere). */
const north = (m: number, accuracyM = 10) => ({ lat: PIN.lat + m / 111_194.93, lng: PIN.lng, accuracyM })

describe('geo', () => {
  it('measures Paris to London as about 343 km', () => {
    const d = distanceM({ lat: 48.8566, lng: 2.3522 }, { lat: 51.5074, lng: -0.1278 })
    expect(Math.abs(d - 343_000)).toBeLessThan(1_000)
  })

  it('applies the accuracy rule with radius 150', () => {
    expect(locationCheck(PIN, north(120, 10))).toBe('ok')
    expect(locationCheck(PIN, north(300, 20))).toBe('outside')
    expect(locationCheck(PIN, north(300, 200))).toBe('ok')
    expect(locationCheck(PIN, north(300, 600))).toBe('poor')
    expect(locationCheck(PIN, north(5000, 500))).toBe('outside') // credit is capped at 200 m
    expect(locationCheck(PIN, north(0, 501))).toBe('poor')
    expect(locationCheck(PIN, undefined)).toBe('missing')
    expect(locationCheck(null, undefined)).toBe('ok')
  })
})

describe('in-person BEATs with the event ARC', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let ca: TestCa
  let host: TestUser
  let imageId: string
  const prevBeats = config.beats
  const prevAttest = config.appAttest

  beforeEach(async () => {
    await resetDb()
    ;(config as any).beats = { ...config.beats, enabled: true, chain: 'polygon' }
    ca = makeTestCa()
    ;(config as any).appAttest = { ...config.appAttest, rootCa: ca.rootPem, appId: APP_ID, env: 'production' }
    setBeatPlatformCheckForTests('decentraland', async () => true)
    resetNewWallets()
    app = await testApp()
    host = await createUser({ wallet: randomWallet() })
    const [m] = await db.insert(mediaAssets).values({ ownerId: host.id, filename: 'b.png', contentType: 'image/png', sizeBytes: 1, storageKey: 'k', publicUrl: 'https://cdn.example/b.png' }).returning()
    imageId = m.id
  })
  afterEach(async () => {
    ;(config as any).beats = prevBeats
    ;(config as any).appAttest = prevAttest
    setBeatPlatformCheckForTests('decentraland', undefined)
    await app.close()
  })

  let tokenSeq = 700
  let ringSeq = 90_001
  async function seed(over: Partial<typeof beats.$inferInsert> = {}, pin = true) {
    const [b] = await db.insert(beats).values({
      chain: 'polygon', ownerUserId: host.id, name: 'Opening night', description: '', imageMediaId: imageId, imageUrl: 'https://cdn.example/frozen.png',
      tokenId: tokenSeq++, status: 'live', minPresentSeconds: 300, supplyCap: 100, startsAt: at(-H), endsAt: at(H),
      locationType: 'in_person', locationVenue: 'The Hall',
      ...(pin ? { pinLat: PIN.lat, pinLng: PIN.lng, pinRadiusM: PIN.radiusM } : {}), ...over,
    }).returning()
    const ringId = ringSeq++
    await db.insert(beatArcs).values({ beatId: b.id, ringId, code: ringCodeOf(ringId) })
    return { b, code: ringCodeOf(ringId) }
  }

  interface Phone { user: TestUser; device: TestDevice }
  async function phone(o: { wallets?: number } = {}): Promise<Phone> {
    const user = await createUser({ wallet: (o.wallets ?? 1) > 0 ? randomWallet() : null })
    for (let i = 1; i < (o.wallets ?? 1); i++) {
      await db.insert(userAuthMethods).values({ userId: user.id, type: 'wallet', identifier: randomWallet().toLowerCase(), metadata: { verified: true } })
    }
    const device = makeDevice(APP_ID)
    const ch = (await app.inject({ method: 'GET', url: '/api/app/attest/challenge', headers: { authorization: `Bearer ${tokenFor(user)}` } })).json().challenge
    const reg = await app.inject({
      method: 'POST', url: '/api/app/attest/register', headers: { authorization: `Bearer ${tokenFor(user)}` },
      payload: { keyId: device.keyId, attestation: makeAttestation(ca, device, ch, { appId: APP_ID }), challenge: ch },
    })
    expect(reg.statusCode, reg.body).toBe(201)
    return { user, device }
  }
  const write = (p: Phone, url: string, body: unknown) => {
    const raw = JSON.stringify(body)
    return app.inject({
      method: 'POST', url, payload: raw,
      headers: { authorization: `Bearer ${tokenFor(p.user)}`, 'x-virvi-attest': p.device.assert(raw), 'content-type': 'application/json' },
    })
  }
  const trackReq = (p: Phone, b: { id: string }, code: string, location?: unknown) =>
    write(p, `/api/app/beats/${b.id}/track`, { consentVersion: BEAT_APP_CONSENT_VERSION, arcCode: code, ...(location === undefined ? {} : { location }) })
  const claimReq = (p: Phone, b: { id: string }, body: Record<string, unknown> = {}) => write(p, `/api/app/beats/${b.id}/claim`, body)
  const rowOf = async (beatId: string, userId: string) => (await db.select().from(beatClaims).where(and(eq(beatClaims.beatId, beatId), eq(beatClaims.userId, userId))))[0]

  it('refuses an outside check-in (403 outside), a poor fix (422), a missing or invalid location (400), another BEAT\'s ARC (400)', async () => {
    const { b, code } = await seed()
    const other = await seed()
    const p = await phone()
    let res = await trackReq(p, b, code, north(600))
    expect([res.statusCode, res.json()]).toEqual([403, { error: 'outside', message: 'You need to be at The Hall to check in.' }])
    res = await trackReq(p, b, code, north(10, 600))
    expect([res.statusCode, res.json().error]).toEqual([422, 'poor_fix'])
    expect(res.json().message).toBe("Couldn't get your location accurately. Step outside or near a window and try again.")
    expect((await trackReq(p, b, code)).statusCode).toBe(400)
    for (const bad of [{ lat: 91, lng: 0, accuracyM: 5 }, { lat: 0, lng: 181, accuracyM: 5 }, { lat: 0, lng: 0, accuracyM: -1 }, { lat: 'x', lng: 0, accuracyM: 1 }]) {
      expect((await trackReq(p, b, code, bad)).statusCode, JSON.stringify(bad)).toBe(400)
    }
    expect((await trackReq(p, b, other.code, north(10))).statusCode).toBe(400)
    expect((await trackReq(p, b, ringCodeOf(5), north(10))).statusCode).toBe(400)
    expect(await db.select().from(beatClaims).where(eq(beatClaims.beatId, b.id))).toHaveLength(0)
  })

  it('tracks inside the pin as app_event, then claims after the minutes, re-checking the pin', async () => {
    const { b, code } = await seed()
    const p = await phone()
    const res = await trackReq(p, b, code, north(100))
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().beat.claim.status).toBe('present')
    const row = await rowOf(b.id, p.user.id)
    expect(row.source).toBe('app_event')
    const t0 = row.consentedAt!.getTime()
    const claim = (ms: number, location?: ReturnType<typeof north>) => appClaim(b.id, { userId: p.user.id, installKeyId: p.device.keyId, location }, new Date(t0 + ms))
    await expect(claim(4 * M, north(10))).rejects.toMatchObject({ status: 409, code: 'not_yet' })
    await expect(claim(5 * M, north(600))).rejects.toMatchObject({ status: 403, code: 'outside', message: 'Come back to The Hall to claim this BEAT.' })
    await expect(claim(5 * M, north(10, 600))).rejects.toMatchObject({ status: 422, code: 'poor_fix' })
    await expect(claim(5 * M)).rejects.toMatchObject({ status: 400 })
    const done = await claim(5 * M, north(10))
    expect(done.claim?.status).toBe('claimed')
    const after = await rowOf(b.id, p.user.id)
    expect(after.secondsPresent).toBeGreaterThanOrEqual(300)
    expect(after.wallet).toBe(p.user.wallet!.toLowerCase())
  })

  it('claims over the route with the location, and the time is wall-clock (no check-ins)', async () => {
    const { b, code } = await seed({ minPresentSeconds: 60 })
    const p = await phone()
    expect((await trackReq(p, b, code, north(50))).statusCode).toBe(200)
    // Make the check-in a minute old
    await db.update(beatClaims).set({ consentedAt: at(-61_000) }).where(eq(beatClaims.beatId, b.id))
    expect((await claimReq(p, b)).statusCode).toBe(400) // location needed
    const res = await claimReq(p, b, { location: north(50) })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().beat.claim.status).toBe('claimed')
  })

  it('needs no location without a pin', async () => {
    const { b, code } = await seed({}, false)
    const p = await phone()
    expect((await trackReq(p, b, code)).statusCode).toBe(200)
    const t0 = (await rowOf(b.id, p.user.id)).consentedAt!.getTime()
    const done = await appClaim(b.id, { userId: p.user.id, installKeyId: p.device.keyId }, new Date(t0 + 5 * M))
    expect(done.claim?.status).toBe('claimed')
  })

  it('claims at once on a BEAT with 0 minimum minutes', async () => {
    const { b, code } = await seed({ minPresentSeconds: 0 })
    const p = await phone()
    const res = await trackReq(p, b, code, north(10))
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().beat.claim.status).toBe('claimed')
    const w = await phone({ wallets: 0 })
    const waiting = await trackReq(w, b, code, north(10))
    expect(waiting.statusCode, waiting.body).toBe(200)
    expect(waiting.json().beat.claim.status).toBe('waiting')
  })

  it('0 minutes with several wallets asks which (the claim stays tracked), 0 minutes outside is refused without a claim', async () => {
    const { b, code } = await seed({ minPresentSeconds: 0 })
    const p = await phone({ wallets: 2 })
    const res = await trackReq(p, b, code, north(10))
    expect([res.statusCode, res.json().error]).toEqual([409, 'choose_wallet'])
    expect((await rowOf(b.id, p.user.id)).status).toBe('present')
    const q = await phone()
    expect((await trackReq(q, b, code, north(900))).statusCode).toBe(403)
    expect(await rowOf(b.id, q.user.id)).toBeUndefined()
  })

  it('credits a claim that started elsewhere from its ARC scan only, never from its first check-in', async () => {
    const { b, code } = await seed()
    const p = await phone()
    await db.insert(beatClaims).values({ beatId: b.id, userId: p.user.id, wallet: null, consentVersion: 1, consentedAt: at(-30 * M), lastSeenAt: at(-30 * M), createdAt: at(-30 * M), source: 'app_space', secondsPresent: 0 })
    expect((await trackReq(p, b, code, north(10))).statusCode).toBe(200)
    const row = await rowOf(b.id, p.user.id)
    expect(row.source).toBe('app_space')
    await expect(appClaim(b.id, { userId: p.user.id, installKeyId: p.device.keyId, location: north(10) })).rejects.toMatchObject({ status: 409, code: 'not_yet' })
  })

  it('adds in-person minutes to time earned in Decentraland: 2 of 5 minutes, a scan at t, claimable at the venue at t+3', async () => {
    const { b, code } = await seed()
    const p = await phone()
    await db.insert(beatClaims).values({
      beatId: b.id, userId: p.user.id, wallet: p.user.wallet!, displayName: 'Visitor', consentVersion: 1, consentedAt: at(-40 * M), lastSeenAt: at(-20 * M),
      createdAt: at(-40 * M), source: 'decentraland', secondsPresent: 120,
    })
    const scan = await trackReq(p, b, code, north(10))
    expect(scan.statusCode, scan.body).toBe(200)
    expect(scan.json().beat.claim).toMatchObject({ status: 'present' })
    expect(scan.json().beat.claim.secondsPresent).toBeGreaterThanOrEqual(120)
    expect(scan.json().beat.claim.secondsPresent).toBeLessThan(130)
    const row = await rowOf(b.id, p.user.id)
    expect(row.source).toBe('decentraland')
    expect(row.secondsAtEventScan).toBe(120)
    const t = row.eventCheckedInAt!.getTime()
    expect(Math.abs(t - Date.now())).toBeLessThan(10_000)
    // A second scan keeps the first check-in
    expect((await trackReq(p, b, code, north(10))).statusCode).toBe(200)
    expect((await rowOf(b.id, p.user.id)).eventCheckedInAt!.getTime()).toBe(t)
    const claim = (ms: number, location?: ReturnType<typeof north>) =>
      appClaim(b.id, { userId: p.user.id, installKeyId: p.device.keyId, location, ip: '203.0.113.9' }, new Date(t + ms))
    await expect(claim(2 * M, north(10))).rejects.toMatchObject({ status: 409, code: 'not_yet' })
    await expect(claim(3 * M, north(600))).rejects.toMatchObject({ status: 403, code: 'outside', message: 'Come back to The Hall to claim this BEAT.' })
    await expect(claim(3 * M)).rejects.toMatchObject({ status: 400, code: 'location_needed' })
    const done = await claim(3 * M, north(10))
    expect(done.claim?.status).toBe('claimed')
    expect((await rowOf(b.id, p.user.id)).secondsPresent).toBeGreaterThanOrEqual(300)
  })

  it('shows the live seconds of a claim with an ARC scan on its card, and never fewer than it earned elsewhere', async () => {
    const { b, code } = await seed()
    const p = await phone()
    await db.insert(beatClaims).values({ beatId: b.id, userId: p.user.id, wallet: null, consentVersion: 1, consentedAt: at(-40 * M), createdAt: at(-40 * M), source: 'app_space', secondsPresent: 60 })
    expect((await trackReq(p, b, code, north(10))).statusCode).toBe(200)
    await db.update(beatClaims).set({ eventCheckedInAt: at(-3 * M) }).where(eq(beatClaims.beatId, b.id))
    const card = (await app.inject({ method: 'GET', url: `/api/app/arcs/${code}`, headers: { authorization: `Bearer ${tokenFor(p.user)}` } })).json().card
    expect(card.claim.secondsPresent).toBeGreaterThanOrEqual(240)
    expect(card.claim.secondsPresent).toBeLessThan(250)
    // More time earned in the space since the scan than the wall clock gives: that counts
    await db.update(beatClaims).set({ secondsPresent: 900 }).where(eq(beatClaims.beatId, b.id))
    const later = (await app.inject({ method: 'GET', url: `/api/app/arcs/${code}`, headers: { authorization: `Bearer ${tokenFor(p.user)}` } })).json().card
    expect(later.claim.secondsPresent).toBe(900)
  })

  it('records the app consent apart from the in-world one, on a new claim and on a reused one', async () => {
    const { b, code } = await seed()
    const p = await phone()
    const res = await trackReq(p, b, code, north(10))
    const row = await rowOf(b.id, p.user.id)
    expect(row.appConsentVersion).toBe(BEAT_APP_CONSENT_VERSION)
    expect(row.appConsentedAt).not.toBeNull()
    expect(res.json().beat.claim.checkedInAt).toBe(row.appConsentedAt!.toISOString())
    // A claim started in Decentraland keeps its in-world consent, gains the app's, and its card keeps the in-world time
    const q = await phone()
    const inWorld = at(-40 * M)
    await db.insert(beatClaims).values({ beatId: b.id, userId: q.user.id, wallet: q.user.wallet!, consentVersion: 1, consentedAt: inWorld, createdAt: inWorld, source: 'decentraland', secondsPresent: 60 })
    const reused = await trackReq(q, b, code, north(10))
    expect(reused.statusCode, reused.body).toBe(200)
    const r = await rowOf(b.id, q.user.id)
    expect([r.consentVersion, r.consentedAt!.getTime()]).toEqual([1, inWorld.getTime()])
    expect(r.appConsentVersion).toBe(BEAT_APP_CONSENT_VERSION)
    expect(Math.abs(r.appConsentedAt!.getTime() - Date.now())).toBeLessThan(10_000)
    expect(reused.json().beat.claim.checkedInAt).toBe(inWorld.toISOString())
  })

  it('is idempotent and never stores the location', async () => {
    const { b, code } = await seed()
    const p = await phone()
    expect((await trackReq(p, b, code, north(10))).statusCode).toBe(200)
    expect((await trackReq(p, b, code, north(10))).statusCode).toBe(200) // idempotent
    const row = await rowOf(b.id, p.user.id)
    expect(JSON.stringify(row)).not.toContain(String(PIN.lat).slice(0, 6))
  })

  it('skips the network caps for an app_event claim', async () => {
    ;(config as any).beats = { ...config.beats, enabled: true, chain: 'polygon', claimsPerIp: 1 }
    const { b, code } = await seed({ minPresentSeconds: 0 })
    for (let i = 0; i < 3; i++) {
      const p = await phone()
      const res = await trackReq(p, b, code, north(10))
      expect(res.statusCode, res.body).toBe(200)
    }
  })

  it('shows the BEAT card on the ARC lookup to a signed-in caller only', async () => {
    const { b, code } = await seed()
    const p = await phone()
    const anon = await app.inject({ method: 'GET', url: `/api/app/arcs/${code}` })
    expect(anon.json()).toEqual({ kind: 'beat', beatId: b.id, name: 'Opening night' })
    const res = await app.inject({ method: 'GET', url: `/api/app/arcs/${code}`, headers: { authorization: `Bearer ${tokenFor(p.user)}` } })
    expect(res.json()).toMatchObject({ kind: 'beat', beatId: b.id, name: 'Opening night', card: { beatId: b.id, minMinutes: 5, location: { type: 'in_person', venue: 'The Hall' }, claim: null } })
  })

  it('service: appTrack refuses an ARC code that is not the BEAT\'s', async () => {
    const { b } = await seed()
    const p = await phone()
    await expect(appTrack(b.id, { userId: p.user.id, installKeyId: p.device.keyId, consentVersion: BEAT_APP_CONSENT_VERSION, via: { arcCode: 'zzz', location: north(1) } })).rejects.toMatchObject({ status: 400 })
  })
})
