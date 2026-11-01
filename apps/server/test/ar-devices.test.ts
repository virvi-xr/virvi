import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { AR_PAIRING, DEFAULT_VENUE_RULES, VENUE_ROLE_SCOPES, ringCodeOf } from '@virvixr/shared'
import { db } from '../src/db/connection.js'
import { accessGrants, arDevices, arFloors, arMarkers, arSpaces, bookings, sceneCollaborators, sceneRoles, venues } from '../src/db/schema.js'
import { sceneRoleOfAccess } from '../src/ar/access.js'
import { redactPairingCode } from '../src/app.js'
import { config } from '../src/config.js'
import { verifySessionToken } from '../src/auth/tokens.js'
import { resetDb } from './helpers/db.js'
import { createElement, createInstance, createScene, createUser, randomWallet, testApp, tokenFor, type TestUser } from './helpers/factories.js'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const SECRET = 'headset-secret-1'
const bearer = (t: string) => ({ authorization: `Bearer ${t}` })
const as = (u: TestUser) => bearer(tokenFor(u))

describe('AR headset pairing and the AR pass', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { vi.useRealTimers(); await app.close() })

  async function sceneWithSpace(owner: TestUser, name = 'A') {
    const { scene, preset } = await createScene(owner, name)
    const [space] = await db.insert(arSpaces).values({ sceneId: scene.id, name: `${name} space` }).returning()
    return { scene, preset, space }
  }

  const start = (secret = SECRET) =>
    app.inject({ method: 'POST', url: '/api/ar/pair', payload: { secretHash: sha256(secret), deviceName: 'Quest 3' } })
  const approve = (code: string, u: TestUser, kind: 'personal' | 'shared') =>
    app.inject({ method: 'POST', url: `/api/ar/pair/${code}/approve`, headers: as(u), payload: { kind } })
  const claim = (code: string, secret = SECRET) =>
    app.inject({ method: 'POST', url: `/api/ar/pair/${code}/claim`, payload: { secret } })
  const mint = (deviceId: string, spaceId: string, secret = SECRET) =>
    app.inject({ method: 'POST', url: `/api/ar/devices/${deviceId}/pass`, payload: { secret, spaceId } })

  /** Start, approve as `u`, claim: the device id. */
  async function pairAs(u: TestUser, kind: 'personal' | 'shared') {
    const { code } = (await start()).json()
    expect((await approve(code, u, kind)).statusCode).toBe(200)
    const claimed = (await claim(code)).json()
    expect(claimed.status).toBe('approved')
    return claimed.deviceId as string
  }

  it('pairs a personal headset end to end', async () => {
    const owner = await createUser({ wallet: randomWallet() })
    const a = await sceneWithSpace(owner)

    const started = await start()
    expect(started.statusCode).toBe(200)
    const { code, approveUrl, codeExpiresAt } = started.json()
    expect(approveUrl).toBe(`${config.webAppUrl}/pair/headset/${code}`)
    expect(new Date(codeExpiresAt).getTime()).toBeGreaterThan(Date.now())

    expect((await claim(code)).json()).toEqual({ status: 'pending' })
    expect((await app.inject({ method: 'GET', url: `/api/ar/pair/${code}` })).statusCode).toBe(401)
    const typed = `${code.slice(0, 3)}-${code.slice(3)}`.toLowerCase()
    const info = await app.inject({ method: 'GET', url: `/api/ar/pair/${typed}`, headers: as(owner) })
    expect(info.statusCode).toBe(200)
    expect(info.json()).toEqual({ deviceName: 'Quest 3', codeExpiresAt })

    expect((await approve(typed, owner, 'personal')).json()).toEqual({ result: 'approved' })
    const claimed = (await claim(code)).json()
    expect(claimed).toMatchObject({ status: 'approved', kind: 'personal', deviceId: expect.any(String) })
    expect(new Date(claimed.expiresAt).getTime()).toBeGreaterThan(Date.now() + AR_PAIRING.personalIdleTtlMs - 60_000)
    // The code is spent.
    expect((await claim(code)).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: `/api/ar/pair/${code}`, headers: as(owner) })).statusCode).toBe(404)

    const minted = await mint(claimed.deviceId, a.space.id)
    expect(minted.statusCode).toBe(200)
    const { pass, passExpiresAt, sceneId } = minted.json()
    expect(sceneId).toBe(a.scene.id)
    expect(new Date(passExpiresAt).getTime()).toBeGreaterThan(Date.now())
    expect(verifySessionToken(pass)).toMatchObject({ id: owner.id, kind: 'scene', sceneId: a.scene.id, via: 'ar', deviceId: claimed.deviceId, wallet: owner.wallet })
    expect((await app.inject({ method: 'GET', url: `/api/scenes/${a.scene.id}`, headers: bearer(pass) })).statusCode).toBe(200)
    // The AR routes opt in too: the space list, and the feed (drafts included for a builder).
    expect((await app.inject({ method: 'GET', url: `/api/scenes/${a.scene.id}/ar/spaces`, headers: bearer(pass) })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: `/api/ar/spaces/${a.space.id}/feed`, headers: bearer(pass) })).statusCode).toBe(200)

    const list = await app.inject({ method: 'GET', url: '/api/ar/devices', headers: as(owner) })
    expect(list.json()).toEqual([expect.objectContaining({ id: claimed.deviceId, deviceName: 'Quest 3', kind: 'personal', status: 'claimed' })])
    expect(list.json()[0].lastUsedAt).toEqual(expect.any(String))
  })

  it('a personal headset slides its expiry forward on each mint', async () => {
    const owner = await createUser()
    const a = await sceneWithSpace(owner)
    const deviceId = await pairAs(owner, 'personal')
    const soon = new Date(Date.now() + 60_000)
    await db.update(arDevices).set({ expiresAt: soon }).where(eq(arDevices.id, deviceId))
    const minted = await mint(deviceId, a.space.id)
    expect(minted.statusCode).toBe(200)
    const [row] = await db.select().from(arDevices).where(eq(arDevices.id, deviceId))
    expect(row.expiresAt!.getTime()).toBeGreaterThan(Date.now() + AR_PAIRING.personalIdleTtlMs - 60_000)
  })

  it("a shared headset's pass never outlives its session", async () => {
    const owner = await createUser()
    const a = await sceneWithSpace(owner)
    const deviceId = await pairAs(owner, 'shared')
    const [before] = await db.select().from(arDevices).where(eq(arDevices.id, deviceId))
    expect(before.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + AR_PAIRING.sharedSessionTtlMs)
    const soon = new Date(Date.now() + 90_000)
    await db.update(arDevices).set({ expiresAt: soon }).where(eq(arDevices.id, deviceId))
    const minted = (await mint(deviceId, a.space.id)).json()
    expect(new Date(minted.passExpiresAt).getTime()).toBeLessThanOrEqual(soon.getTime())
    const [after] = await db.select().from(arDevices).where(eq(arDevices.id, deviceId))
    expect(after.expiresAt!.getTime()).toBe(soon.getTime())
  })

  it("a shared headset's session ends", async () => {
    const owner = await createUser()
    const a = await sceneWithSpace(owner)
    const deviceId = await pairAs(owner, 'shared')
    const { pass } = (await mint(deviceId, a.space.id)).json()
    expect((await app.inject({ method: 'GET', url: `/api/scenes/${a.scene.id}`, headers: bearer(pass) })).statusCode).toBe(200)

    expect((await app.inject({ method: 'POST', url: `/api/ar/devices/${deviceId}/end`, payload: { secret: 'wrong' } })).statusCode).toBe(401)
    const end = await app.inject({ method: 'POST', url: `/api/ar/devices/${deviceId}/end`, payload: { secret: SECRET } })
    expect(end.statusCode).toBe(204)
    const after = await app.inject({ method: 'GET', url: `/api/scenes/${a.scene.id}`, headers: bearer(pass) })
    expect([after.statusCode, after.json().error]).toEqual([401, 'device_revoked'])
    const again = await mint(deviceId, a.space.id)
    expect([again.statusCode, again.json().error]).toEqual([401, 'device_revoked'])
  })

  it('ending a personal headset session keeps the device paired', async () => {
    const owner = await createUser()
    const a = await sceneWithSpace(owner)
    const deviceId = await pairAs(owner, 'personal')
    expect((await app.inject({ method: 'POST', url: `/api/ar/devices/${deviceId}/end`, payload: { secret: SECRET } })).statusCode).toBe(204)
    expect((await mint(deviceId, a.space.id)).statusCode).toBe(200)
  })

  it('revoking from the website kills the pass at once', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    const a = await sceneWithSpace(owner)
    const deviceId = await pairAs(owner, 'personal')
    const { pass } = (await mint(deviceId, a.space.id)).json()
    // Warm the 10 s cache: revoking must still bite at once.
    expect((await app.inject({ method: 'GET', url: `/api/scenes/${a.scene.id}`, headers: bearer(pass) })).statusCode).toBe(200)

    expect((await app.inject({ method: 'DELETE', url: `/api/ar/devices/${deviceId}`, headers: as(stranger) })).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: `/api/ar/devices/${deviceId}`, headers: bearer(pass) })).statusCode).toBe(403)
    expect((await app.inject({ method: 'DELETE', url: `/api/ar/devices/${deviceId}`, headers: as(owner) })).statusCode).toBe(204)
    const after = await app.inject({ method: 'GET', url: `/api/scenes/${a.scene.id}`, headers: bearer(pass) })
    expect([after.statusCode, after.json().error]).toEqual([401, 'device_revoked'])
    expect((await mint(deviceId, a.space.id)).json().error).toBe('device_revoked')
    expect((await app.inject({ method: 'GET', url: '/api/ar/devices', headers: as(owner) })).json()).toEqual([])
  })

  it("a pass for space A's scene can't touch space B's scene", async () => {
    const owner = await createUser()
    const a = await sceneWithSpace(owner, 'A')
    const b = await sceneWithSpace(owner, 'B')
    const inst = await createInstance((await createElement(b.preset.id)).id)
    const deviceId = await pairAs(owner, 'personal')
    const { pass } = (await mint(deviceId, a.space.id)).json()
    const res = await app.inject({ method: 'PUT', url: `/api/instances/${inst.id}`, headers: bearer(pass), payload: { enabled: false } })
    expect([res.statusCode, res.json().error]).toEqual([403, 'scene_pass_not_allowed'])
    const feed = await app.inject({ method: 'GET', url: `/api/ar/spaces/${b.space.id}/feed`, headers: bearer(pass) })
    expect([feed.statusCode, feed.json().error]).toEqual([403, 'scene_pass_not_allowed'])
  })

  it("an AR pass is refused on routes that don't opt in", async () => {
    const owner = await createUser()
    const a = await sceneWithSpace(owner)
    const deviceId = await pairAs(owner, 'personal')
    const { pass } = (await mint(deviceId, a.space.id)).json()
    const cases: Array<[string, string, object | undefined]> = [
      ['POST', `/api/scenes/${a.scene.id}/transfer-host`, { wallet: '0x' + 'ab'.repeat(20) }],
      ['POST', `/api/scenes/${a.scene.id}/ar/spaces`, { name: 'x' }],
      ['GET', '/api/ar/devices', undefined],
      ['POST', '/api/auth/handoff', {}],
    ]
    for (const [method, url, payload] of cases) {
      const res = await app.inject({ method: method as any, url, headers: bearer(pass), payload })
      expect([res.statusCode, res.json().error], `${method} ${url}`).toEqual([403, 'ar_pass_not_allowed'])
    }
    // An AR pass can't approve another headset either.
    const { code } = (await start('other-secret')).json()
    const res = await app.inject({ method: 'POST', url: `/api/ar/pair/${code}/approve`, headers: bearer(pass), payload: { kind: 'personal' } })
    expect([res.statusCode, res.json().error]).toEqual([403, 'ar_pass_not_allowed'])
  })

  it("can't mint for a scene the approver can't build on", async () => {
    const owner = await createUser()
    const other = await createUser()
    await sceneWithSpace(owner, 'A')
    const b = await sceneWithSpace(other, 'B')
    const deviceId = await pairAs(owner, 'personal')
    const res = await mint(deviceId, b.space.id)
    expect([res.statusCode, res.json().error]).toEqual([403, 'no_access'])
    const unknown = await mint(deviceId, '00000000-0000-0000-0000-000000000000')
    expect([unknown.statusCode, unknown.json().error]).toEqual([404, 'not_found'])

    // A booking host on B may pair a headset, but it can't build there.
    const host = await createUser({ wallet: randomWallet() })
    const [venue] = await db.insert(venues).values({
      sceneId: b.scene.id, name: 'V', slug: `v-${crypto.randomUUID()}`, defaultPresetId: b.preset.id, rules: DEFAULT_VENUE_RULES,
    }).returning()
    const startsAt = new Date(Date.now() - 3600_000)
    const endsAt = new Date(Date.now() + 3600_000)
    const [booking] = await db.insert(bookings).values({
      venueId: venue.id, renterUserId: host.id, title: 'Show', startsAt, endsAt, status: 'live',
      blockedRange: `[${startsAt.toISOString()},${endsAt.toISOString()})`,
    }).returning()
    await db.insert(accessGrants).values({
      bookingId: booking.id, sceneId: b.scene.id, walletAddress: host.wallet, userId: host.id, role: 'host',
      scopes: [...VENUE_ROLE_SCOPES.host], validFrom: startsAt, validUntil: endsAt,
    })
    const hostDevice = await pairAs(host, 'shared')
    const hostMint = await mint(hostDevice, b.space.id)
    expect([hostMint.statusCode, hostMint.json().error]).toEqual([403, 'no_access'])
  })

  it('wrong secret is refused', async () => {
    const owner = await createUser()
    const a = await sceneWithSpace(owner)
    const { code } = (await start()).json()
    await approve(code, owner, 'personal')
    const bad = await claim(code, 'not-the-secret')
    expect([bad.statusCode, bad.json().error]).toEqual([401, 'bad_secret'])
    // A wrong guess consumes nothing.
    const deviceId = (await claim(code)).json().deviceId
    const badMint = await mint(deviceId, a.space.id, 'not-the-secret')
    expect([badMint.statusCode, badMint.json().error]).toEqual([401, 'bad_secret'])
    const badSpaces = await app.inject({ method: 'POST', url: `/api/ar/devices/${deviceId}/spaces`, payload: { secret: 'not-the-secret' } })
    expect([badSpaces.statusCode, badSpaces.json().error]).toEqual([401, 'bad_secret'])
  })

  it('codes expire after 10 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const owner = await createUser()
    const { code } = (await start()).json()
    vi.setSystemTime(Date.now() + AR_PAIRING.codeTtlMs + 1000)
    expect((await approve(code, owner, 'personal')).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: `/api/ar/pair/${code}`, headers: as(owner) })).statusCode).toBe(404)
    expect((await claim(code)).statusCode).toBe(404)
  })

  it('bad input is refused', async () => {
    const owner = await createUser()
    expect((await app.inject({ method: 'POST', url: '/api/ar/pair', payload: { secretHash: 'short' } })).statusCode).toBe(400)
    const { code } = (await start()).json()
    expect((await app.inject({ method: 'POST', url: `/api/ar/pair/${code}/approve`, headers: as(owner), payload: { kind: 'everyone' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/ar/pair/OOO-111/claim', payload: { secret: SECRET } })).statusCode).toBe(404)
    expect((await mint('not-a-uuid', '00000000-0000-0000-0000-000000000000')).json().error).toBe('device_revoked')
    // An unverified account can't vouch for a headset.
    const unverified = await app.inject({ method: 'POST', url: `/api/ar/pair/${code}/approve`, headers: bearer(tokenFor(owner, { verified: false })), payload: { kind: 'personal' } })
    expect([unverified.statusCode, unverified.json().error]).toEqual([403, 'unverified'])
    // A code is approved once.
    expect((await approve(code, owner, 'personal')).statusCode).toBe(200)
    const twice = await approve(code, owner, 'shared')
    expect([twice.statusCode, twice.json()]).toEqual([404, { error: 'not_found' }])
  })

  it('lists the spaces the approver can build on', async () => {
    const me = await createUser()
    const other = await createUser()
    const third = await createUser()
    const a = await sceneWithSpace(me, 'A')
    const b = await sceneWithSpace(other, 'B')
    await db.insert(sceneCollaborators).values({ sceneId: b.scene.id, userId: me.id, role: 'editor' })
    const c = await sceneWithSpace(third, 'C')
    // Unpublished rings: the list is how the headset learns which space a ring it sees belongs to.
    const ring = async (spaceId: string, ringId: number) => {
      const [floor] = await db.insert(arFloors).values({ spaceId, name: 'Ground floor' }).returning()
      const [m] = await db.insert(arMarkers).values({ floorId: floor.id, ringId, code: ringCodeOf(ringId) }).returning()
      return { markerId: m.id, floorId: floor.id, code: m.code }
    }
    const ringA = await ring(a.space.id, 1001)
    const ringB = await ring(b.space.id, 1002)
    await ring(c.space.id, 1003)
    const deviceId = await pairAs(me, 'personal')
    const res = await app.inject({ method: 'POST', url: `/api/ar/devices/${deviceId}/spaces`, payload: { secret: SECRET } })
    expect(res.statusCode).toBe(200)
    const sorted = [...res.json()].sort((x, y) => x.spaceName.localeCompare(y.spaceName))
    expect(sorted).toEqual([
      { spaceId: a.space.id, spaceName: 'A space', sceneId: a.scene.id, sceneName: 'A', markers: [ringA] },
      { spaceId: b.space.id, spaceName: 'B space', sceneId: b.scene.id, sceneName: 'B', markers: [ringB] },
    ])
    // The headset matches the ring it sees, then mints for that ring's space.
    const seen = sorted.find((s: any) => s.markers.some((m: any) => m.code === ringB.code))
    expect((await mint(deviceId, seen.spaceId)).json().sceneId).toBe(b.scene.id)
  })

  const mintScene = (deviceId: string, body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/ar/devices/${deviceId}/pass`, payload: body })

  it('mints a pass for a scene the approver can build on, with no space', async () => {
    const owner = await createUser({ wallet: randomWallet() })
    const { scene } = await createScene(owner, 'No space')
    const deviceId = await pairAs(owner, 'personal')
    const res = await mintScene(deviceId, { secret: SECRET, sceneId: scene.id })
    expect(res.statusCode).toBe(200)
    const { pass, passExpiresAt, sceneId } = res.json()
    expect(sceneId).toBe(scene.id)
    expect(new Date(passExpiresAt).getTime()).toBeGreaterThan(Date.now())
    expect(verifySessionToken(pass)).toMatchObject({ id: owner.id, kind: 'scene', sceneId: scene.id, via: 'ar', deviceId })
  })

  it('refuses a scene pass to a shared headset', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner, 'S')
    const deviceId = await pairAs(owner, 'shared')
    const res = await mintScene(deviceId, { secret: SECRET, sceneId: scene.id })
    expect([res.statusCode, res.json()]).toEqual([403, { error: 'personal_only' }])
  })

  it('refuses a scene pass on a scene the approver cannot build', async () => {
    const owner = await createUser()
    const other = await createUser()
    const { scene } = await createScene(other, 'Theirs')
    const deviceId = await pairAs(owner, 'personal')
    const res = await mintScene(deviceId, { secret: SECRET, sceneId: scene.id })
    expect([res.statusCode, res.json().error]).toEqual([403, 'no_access'])
    const unknown = await mintScene(deviceId, { secret: SECRET, sceneId: '00000000-0000-0000-0000-000000000000' })
    expect([unknown.statusCode, unknown.json().error]).toEqual([403, 'no_access'])
  })

  it('needs exactly one of spaceId and sceneId', async () => {
    const owner = await createUser()
    const a = await sceneWithSpace(owner)
    const deviceId = await pairAs(owner, 'personal')
    expect((await mintScene(deviceId, { secret: SECRET, sceneId: a.scene.id, spaceId: a.space.id })).statusCode).toBe(400)
    expect((await mintScene(deviceId, { secret: SECRET })).statusCode).toBe(400)
  })

  it('lists the scenes the approver can build on', async () => {
    const me = await createUser({ wallet: randomWallet() })
    const other = await createUser()
    const third = await createUser()
    const { scene: owned } = await createScene(me, 'B owned, no space')
    const collab = await sceneWithSpace(other, 'A collab')
    await db.insert(sceneCollaborators).values({ sceneId: collab.scene.id, userId: me.id, role: 'editor' })
    const { scene: roled } = await createScene(third, 'C role')
    await db.insert(sceneRoles).values({ sceneId: roled.id, userId: me.id, walletAddress: me.wallet!.toLowerCase(), role: 'editor' } as any)
    const { scene: coRoled } = await createScene(third, 'E cohost')
    await db.insert(sceneRoles).values({ sceneId: coRoled.id, userId: me.id, walletAddress: me.wallet!.toLowerCase(), role: 'cohost' } as any)
    await createScene(third, 'D no access')
    const deviceId = await pairAs(me, 'personal')
    const res = await app.inject({ method: 'POST', url: `/api/ar/devices/${deviceId}/scenes`, payload: { secret: SECRET } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([
      { sceneId: collab.scene.id, sceneName: 'A collab', role: 'editor' },
      { sceneId: owned.id, sceneName: 'B owned, no space', role: 'host' },
      { sceneId: roled.id, sceneName: 'C role', role: 'editor' },
      { sceneId: coRoled.id, sceneName: 'E cohost', role: 'cohost' },
    ])
    const bad = await app.inject({ method: 'POST', url: `/api/ar/devices/${deviceId}/scenes`, payload: { secret: 'nope' } })
    expect(bad.statusCode).toBe(401)
  })

  it('maps scene access to the HUD role', () => {
    const a = (level: string) => ({ level, scopes: new Set(), booking: null }) as any
    expect(['admin', 'owner', 'cohost', 'editor', 'grant', 'viewer'].map((l) => sceneRoleOfAccess(a(l)))).toEqual(['host', 'host', 'cohost', 'editor', 'editor', 'viewer'])
  })

  it('codes are kept out of logs', () => {
    for (const url of ['/api/ar/pair/ABC234/approve', '/api/ar/pair/ABC234', '/api/ar/pair/ABC234/claim', '/pair/headset/ABC234']) {
      expect(redactPairingCode(url)).not.toContain('ABC234')
    }
    expect(redactPairingCode('/api/ar/pair/ABC234/approve')).toBe('/api/ar/pair/:code/approve')
    expect(redactPairingCode('/pair/headset/ABC234')).toBe('/pair/headset/:code')
  })
})
