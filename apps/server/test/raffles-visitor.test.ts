import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { RAFFLE_CONSENT_VERSION } from '@virvixr/shared'
import { db } from '../src/db/connection.js'
import { locationSetups, raffleDraws, raffleEntries, raffles } from '../src/db/schema.js'
import { initBus } from '../src/realtime/bus.js'
import { issueScenePass } from '../src/auth/scene-pass.js'
import { checkInRaffle } from '../src/raffles/service.js'
import { verifySessionToken } from '../src/auth/tokens.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, randomWallet, testApp, tokenFor, type TestUser } from './helpers/factories.js'
import { createAnalyticsScene } from './helpers/analytics.js'
import { createSetup } from './helpers/setups.js'
import { signedSceneHeaders, SCENE_META } from './helpers/dcl-sign.js'

const PLATFORM = '/api/auth/platform'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('raffle visitor routes (LIV-55)', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let host: TestUser
  let sceneId: string
  let published: any[]

  beforeEach(async () => {
    await resetDb()
    published = []
    initBus({ publish: (_t: string, d: unknown) => { published.push(d) }, subscribe: () => {}, unsubscribe: () => {} })
    app = await testApp()
    host = await createUser({ wallet: randomWallet() })
    sceneId = (await createScene(host)).scene.id
    // Set up at SCENE_META's parcel as that signed deployment, so a signed sign-in binds a visitor pass to this scene
    const loc = await createAnalyticsScene({ locationKey: `gc:${SCENE_META.parcel}`, baseParcel: SCENE_META.parcel, parcels: [SCENE_META.parcel] } as any)
    const setup = await createSetup(loc.id, sceneId)
    await db.update(locationSetups).set({ deploymentEntityId: SCENE_META.sceneId }).where(eq(locationSetups.id, setup.id))
  })
  afterEach(async () => {
    initBus(null as any)
    await app.close()
  })

  /** A real visitor pass: a Decentraland signed fetch to POST /api/auth/platform. */
  async function visitorPass(opts: { name?: string | null; wallet?: 'a' | 'b'; isGuest?: boolean } = {}) {
    const body = JSON.stringify(opts.name === null ? {} : { user: { displayName: opts.name ?? 'Visitor A' } })
    const { headers, wallet } = await signedSceneHeaders({ method: 'POST', path: PLATFORM, body, wallet: opts.wallet, metadata: opts.isGuest ? { isGuest: true } : undefined })
    const res = await app.inject({ method: 'POST', url: PLATFORM, headers: { ...headers, 'content-type': 'application/json' }, payload: body })
    expect(res.statusCode, res.body).toBe(200)
    return { token: res.json().accessToken as string, wallet, user: res.json().user as { id: string }, body: res.json() }
  }
  const h = (token: string) => ({ authorization: `Bearer ${token}` })
  const call = (method: string, url: string, token: string, payload?: unknown) =>
    app.inject({ method: method as any, url, headers: h(token), payload: payload as any })
  const enter = (raffleId: string, token: string, consentVersion: unknown = RAFFLE_CONSENT_VERSION) =>
    call('POST', `/api/raffles/${raffleId}/entry`, token, { consentVersion })

  async function raffle(status: 'draft' | 'open' | 'drawn' | 'closed' = 'open') {
    const [r] = await db.insert(raffles).values({
      sceneId, createdBy: host.id, name: 'Friday raffle', prize: 'A wearable', winnersCount: 1, mode: 'one_per_person', status,
      hostTermsAcceptedAt: new Date(), openedAt: status === 'draft' ? null : new Date(),
    }).returning()
    return r
  }

  it('a verified visitor enters with a real scene pass', async () => {
    const r = await raffle()
    const v = await visitorPass({ name: 'Visitor A' })
    const res = await enter(r.id, v.token)
    expect(res.statusCode, res.body).toBe(201)
    const [row] = await db.select().from(raffleEntries)
    expect(row).toMatchObject({ raffleId: r.id, userId: v.user.id, wallet: v.wallet, displayName: 'Visitor A', consentVersion: RAFFLE_CONSENT_VERSION, secondsPresent: 0 })
    expect(Date.now() - row.lastSeenAt!.getTime()).toBeLessThan(10_000)
    expect(res.json().entry).toMatchObject({ entered: true, won: false })
    await sleep(50)
    expect(published.filter((e) => e.type === 'raffle_changed' && e.sceneId === sceneId).at(-1)?.raffle).toMatchObject({ id: r.id, entryCount: 1 })
  })

  it('a guest gets no pass that reaches the routes; an unverified scene pass gets wallet_required', async () => {
    const r = await raffle()
    const guest = await visitorPass({ isGuest: true })
    expect(guest.body.guest).toBe(true)
    // The middleware refuses every guest token before any route runs
    const g = await enter(r.id, guest.token)
    expect(g.statusCode).toBe(401)
    expect((await call('GET', `/api/scenes/${sceneId}/raffle/current`, guest.token)).statusCode).toBe(401)
    // A scene pass with no verified wallet (the local-preview identity) reaches the route and is refused
    const u = await createUser()
    const unverified = tokenFor(u, { kind: 'scene', sceneId, locationId: null, wallet: null, verified: false })
    const res = await enter(r.id, unverified)
    expect([res.statusCode, res.json().error]).toEqual([403, 'wallet_required'])
    const cur = await call('GET', `/api/scenes/${sceneId}/raffle/current`, unverified)
    expect(cur.json()).toMatchObject({ canEnter: false, reason: 'guest', myEntry: null })
    expect(await db.select().from(raffleEntries)).toEqual([])
  })

  it('the wrong consent version is consent_required', async () => {
    const r = await raffle()
    const v = await visitorPass()
    for (const c of [0, 2, '1', null]) {
      const res = await enter(r.id, v.token, c)
      expect([c, res.statusCode, res.json().error]).toEqual([c, 400, 'consent_required'])
    }
    const missing = await call('POST', `/api/raffles/${r.id}/entry`, v.token, {})
    expect([missing.statusCode, missing.json().error]).toEqual([400, 'consent_required'])
    expect(await db.select().from(raffleEntries)).toEqual([])
  })

  it('entering twice, or with a second wallet on the same user, is already_entered', async () => {
    const r = await raffle()
    const v = await visitorPass()
    expect((await enter(r.id, v.token)).statusCode).toBe(201)
    const again = await enter(r.id, v.token)
    expect([again.statusCode, again.json().error]).toEqual([409, 'already_entered'])
    const user = (await db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, v.user.id) }))!
    const second = issueScenePass(app, user as any, randomWallet(), { sceneId, locationId: null }).accessToken
    const other = await enter(r.id, second)
    expect([other.statusCode, other.json().error]).toEqual([409, 'already_entered'])
    // The same wallet on another user too
    const stranger = await createUser()
    const sameWallet = issueScenePass(app, stranger as any, v.wallet, { sceneId, locationId: null }).accessToken
    expect((await enter(r.id, sameWallet)).json().error).toBe('already_entered')
    expect(await db.select().from(raffleEntries)).toHaveLength(1)
  })

  it('entering a draft, drawn or closed raffle is entry_closed', async () => {
    const v = await visitorPass()
    for (const status of ['draft', 'drawn', 'closed'] as const) {
      await db.delete(raffles)
      const r = await raffle(status)
      const res = await enter(r.id, v.token)
      expect([status, res.statusCode, res.json().error]).toEqual([status, 409, 'entry_closed'])
    }
  })

  it('a pass for another scene, or an account token, cannot enter or check in', async () => {
    const r = await raffle()
    const v = await visitorPass()
    const other = (await createScene(host, 'Other')).scene.id
    const user = (await db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, v.user.id) }))!
    const elsewhere = issueScenePass(app, user as any, v.wallet, { sceneId: other, locationId: null }).accessToken
    const res = await enter(r.id, elsewhere)
    expect([res.statusCode, res.json().error]).toEqual([403, 'scene_pass_not_allowed'])
    const account = tokenFor({ ...(user as any), wallet: v.wallet })
    const acc = await enter(r.id, account)
    expect([acc.statusCode, acc.json().error]).toEqual([403, 'scene_pass_required'])
    expect((await enter(r.id, v.token)).statusCode).toBe(201)
    expect((await call('POST', `/api/raffles/${r.id}/presence`, elsewhere)).statusCode).toBe(403)
    expect((await call('POST', `/api/raffles/${r.id}/presence`, account)).json().error).toBe('scene_pass_required')
  })

  it('withdrawing removes the entry row; only while open or drawn', async () => {
    const r = await raffle()
    const v = await visitorPass()
    await enter(r.id, v.token)
    const res = await call('DELETE', `/api/raffles/${r.id}/entry`, v.token)
    expect(res.statusCode, res.body).toBe(204)
    expect(await db.select().from(raffleEntries)).toEqual([])
    expect((await call('DELETE', `/api/raffles/${r.id}/entry`, v.token)).statusCode).toBe(404)
    await enter(r.id, v.token)
    await db.update(raffles).set({ status: 'closed' }).where(eq(raffles.id, r.id))
    const closed = await call('DELETE', `/api/raffles/${r.id}/entry`, v.token)
    expect([closed.statusCode, closed.json().error]).toEqual([409, 'entry_closed'])
    expect(await db.select().from(raffleEntries)).toHaveLength(1)
  })

  it('presence: 10 s after the last check-in is too_soon; 30 s after adds 30', async () => {
    const r = await raffle()
    const v = await visitorPass()
    await enter(r.id, v.token)
    const [entry] = await db.select().from(raffleEntries)
    const t0 = new Date('2030-01-01T12:00:00Z')
    await db.update(raffleEntries).set({ lastSeenAt: t0 }).where(eq(raffleEntries.id, entry.id))
    expect(await checkInRaffle(r.id, v.user.id, new Date(t0.getTime() + 10_000))).toBe('too_soon')
    expect(await checkInRaffle(r.id, v.user.id, new Date(t0.getTime() + 30_000))).toBe('ok')
    const after = (await db.query.raffleEntries.findFirst({ where: eq(raffleEntries.id, entry.id) }))!
    expect(after.secondsPresent).toBe(30)
    expect(after.lastSeenAt!.getTime()).toBe(t0.getTime() + 30_000)
    // Not an entrant, or the raffle isn't running: nothing
    expect(await checkInRaffle(r.id, host.id, new Date(t0.getTime() + 60_000))).toBeNull()

    // Through the route: the entry was just made, so a check-in now is too soon; a minute later it counts
    await db.update(raffleEntries).set({ lastSeenAt: new Date(), secondsPresent: 0 }).where(eq(raffleEntries.id, entry.id))
    const soon = await call('POST', `/api/raffles/${r.id}/presence`, v.token)
    expect([soon.statusCode, soon.json().error]).toEqual([429, 'too_soon'])
    await db.update(raffleEntries).set({ lastSeenAt: new Date(Date.now() - 30_000) }).where(eq(raffleEntries.id, entry.id))
    expect((await call('POST', `/api/raffles/${r.id}/presence`, v.token)).statusCode).toBe(204)
    expect((await db.query.raffleEntries.findFirst({ where: eq(raffleEntries.id, entry.id) }))!.secondsPresent).toBeGreaterThanOrEqual(30)
    // Drawn still counts; closed is 404
    await db.update(raffles).set({ status: 'drawn' }).where(eq(raffles.id, r.id))
    await db.update(raffleEntries).set({ lastSeenAt: new Date(Date.now() - 30_000) }).where(eq(raffleEntries.id, entry.id))
    expect((await call('POST', `/api/raffles/${r.id}/presence`, v.token)).statusCode).toBe(204)
    await db.update(raffles).set({ status: 'closed' }).where(eq(raffles.id, r.id))
    expect((await call('POST', `/api/raffles/${r.id}/presence`, v.token)).statusCode).toBe(404)
  })

  it('a non-entrant checking in gets 404', async () => {
    const r = await raffle()
    const v = await visitorPass()
    expect((await call('POST', `/api/raffles/${r.id}/presence`, v.token)).statusCode).toBe(404)
  })

  it('current returns the raffle and myEntry after a reconnect', async () => {
    const v = await visitorPass()
    const none = await call('GET', `/api/scenes/${sceneId}/raffle/current`, v.token)
    expect(none.statusCode, none.body).toBe(200)
    expect(none.json()).toEqual({ raffle: null, myEntry: null, canEnter: false, reason: 'closed' })
    const r = await raffle()
    const before = (await call('GET', `/api/scenes/${sceneId}/raffle/current`, v.token)).json()
    expect(before).toMatchObject({ myEntry: null, canEnter: true })
    expect(before.reason).toBeUndefined()
    expect(before.raffle).toEqual({ id: r.id, sceneId, name: 'Friday raffle', prize: 'A wearable', rules: null, status: 'open', winnersCount: 1, entryCount: 0 })
    await enter(r.id, v.token)
    // Reconnect: a fresh sign-in, a new pass
    const again = await visitorPass()
    const cur = (await call('GET', `/api/scenes/${sceneId}/raffle/current`, again.token)).json()
    expect(cur).toMatchObject({ myEntry: { entered: true, won: false }, canEnter: false, raffle: { entryCount: 1 } })
    // A win shows
    const [entry] = await db.select().from(raffleEntries)
    await db.insert(raffleDraws).values({ raffleId: r.id, mode: 'one_per_person', pool: [{ entryId: entry.id, tickets: 1 }], seed: 'ab'.repeat(32), winnerEntryIds: [entry.id] })
    await db.update(raffles).set({ status: 'drawn' }).where(eq(raffles.id, r.id))
    const won = (await call('GET', `/api/scenes/${sceneId}/raffle/current`, again.token)).json()
    expect(won).toMatchObject({ myEntry: { entered: true, won: true }, canEnter: false, reason: 'closed', raffle: { status: 'drawn' } })
    // Any signed-in account may read it; a pass for another scene may not
    expect((await call('GET', `/api/scenes/${sceneId}/raffle/current`, tokenFor(await createUser()))).statusCode).toBe(200)
    const other = (await createScene(host, 'Other')).scene.id
    const user = (await db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, v.user.id) }))!
    const elsewhere = issueScenePass(app, user as any, v.wallet, { sceneId: other, locationId: null }).accessToken
    expect((await call('GET', `/api/scenes/${sceneId}/raffle/current`, elsewhere)).statusCode).toBe(403)
  })

  it('cleans the display name before storing it (Review Focus 5)', async () => {
    const r = await raffle()
    const v = await visitorPass({ name: '  <b>Bob</b>\u0007\u0000\u001b[31m' + 'x'.repeat(60) })
    expect((await enter(r.id, v.token)).statusCode).toBe(201)
    const [row] = await db.select().from(raffleEntries)
    expect(row.displayName).toBe(('<b>Bob</b>[31m' + 'x'.repeat(60)).slice(0, 40))
    expect(row.displayName!.length).toBe(40)
    // Only control characters: the short wallet stands in
    await db.delete(raffleEntries)
    const blank = await visitorPass({ name: '\u0001\u0002 ' })
    await enter(r.id, blank.token)
    const [row2] = await db.select().from(raffleEntries)
    expect(row2.displayName).toBe(`${v.wallet.slice(0, 6)}…${v.wallet.slice(-4)}`)
  })

  it('a signed sign-in with no name is stored as the short wallet, not "Guest"', async () => {
    const r = await raffle()
    const v = await visitorPass({ name: null })
    expect(verifySessionToken(v.token)?.displayName).toBeUndefined()
    expect((await enter(r.id, v.token)).statusCode).toBe(201)
    const [row] = await db.select().from(raffleEntries)
    expect(row.displayName).toBe(`${v.wallet.slice(0, 6)}…${v.wallet.slice(-4)}`)
    expect(row.displayName).toMatch(/^0x[0-9a-f]{4}…[0-9a-f]{4}$/)
  })

  it("the pass carries the sign-in name cleaned and capped at 40 characters", async () => {
    const v = await visitorPass({ name: '\u0007' + 'n'.repeat(500) })
    expect(verifySessionToken(v.token)?.displayName).toBe('n'.repeat(40))
  })

  it('/api/me/raffle-entries lists my entries with a win', async () => {
    const r = await raffle()
    const v = await visitorPass()
    await enter(r.id, v.token)
    const [entry] = await db.select().from(raffleEntries)
    await db.insert(raffleDraws).values({ raffleId: r.id, mode: 'one_per_person', pool: [{ entryId: entry.id, tickets: 1 }], seed: 'ab'.repeat(32), winnerEntryIds: [entry.id] })
    await db.update(raffles).set({ status: 'drawn' }).where(eq(raffles.id, r.id))
    const user = (await db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, v.user.id) }))!
    const res = await call('GET', '/api/me/raffle-entries', tokenFor({ ...(user as any), wallet: v.wallet }))
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().entries).toEqual([{ raffleId: r.id, sceneName: 'Venue Scene', raffleName: 'Friday raffle', status: 'drawn', won: true, enteredAt: entry.createdAt.toISOString() }])
    // Someone else's list is empty; a scene pass is refused (normal sign-in only)
    expect((await call('GET', '/api/me/raffle-entries', tokenFor(host))).json().entries).toEqual([])
    expect((await call('GET', '/api/me/raffle-entries', v.token)).statusCode).toBe(403)
  })
})
