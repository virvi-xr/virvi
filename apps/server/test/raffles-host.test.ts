import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { DRAW_COOLDOWN_MS, RAFFLE_HOST_TERMS, RAFFLE_WINNERS_MAX, WHEEL_MAX_NAMES } from '@virvixr/shared'
import { db } from '../src/db/connection.js'
import { hyperfyPairings, hyperfyWorlds, raffleDraws, raffleEntries, raffles, raffleSnapshots, sceneCollaborators } from '../src/db/schema.js'
import { initBus } from '../src/realtime/bus.js'
import { issueHyperfyPass, issueScenePass } from '../src/auth/scene-pass.js'
import { actorFromClaims } from '../src/auth/actor.js'
import { getSceneAccess } from '../src/auth/permissions.js'
import { createBooking, createVenue } from '../src/venues/service.js'
import { drawWinners } from '../src/raffles/draw.js'
import { drawRaffle, takeSnapshot } from '../src/raffles/service.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, randomWallet, testApp, tokenFor, type TestUser } from './helpers/factories.js'

const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
const VALID = { name: 'Friday raffle', prize: 'A wearable', winnersCount: 1, mode: 'one_per_person', acceptHostTerms: true }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('raffle host API (LIV-55)', () => {
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
  })
  afterEach(async () => {
    initBus(null as any)
    await app.close()
  })

  const call = (method: string, url: string, user: TestUser | { authorization: string } = host, payload?: unknown) =>
    app.inject({ method: method as any, url, headers: 'authorization' in user ? user : as(user), payload: payload as any })

  async function create(body: Record<string, unknown> = {}, user: TestUser = host) {
    const res = await call('POST', `/api/scenes/${sceneId}/raffles`, user, { ...VALID, ...body })
    expect(res.statusCode, res.body).toBe(201)
    return res.json().raffle as { id: string }
  }
  async function openRaffle(body: Record<string, unknown> = {}) {
    const r = await create(body)
    const res = await call('POST', `/api/raffles/${r.id}/open`)
    expect(res.statusCode, res.body).toBe(200)
    return r
  }
  /** An entrant present now for `minutes` minutes (or absent / under the minimum with other values). */
  async function entrant(raffleId: string, opts: { minutes?: number; seenAgoMs?: number | null; name?: string } = {}) {
    const u = await createUser({ wallet: randomWallet() })
    const [e] = await db.insert(raffleEntries).values({
      raffleId, userId: u.id, wallet: u.wallet, displayName: opts.name ?? `Entrant ${u.id.slice(0, 4)}`, consentVersion: 1,
      secondsPresent: Math.round((opts.minutes ?? 10) * 60),
      lastSeenAt: opts.seenAgoMs === null ? null : new Date(Date.now() - (opts.seenAgoMs ?? 5_000)),
    }).returning()
    return e
  }
  /** Moves the last draw back past the cooldown. */
  const pastCooldown = (raffleId: string) =>
    db.update(raffles).set({ lastDrawnAt: new Date(Date.now() - DRAW_COOLDOWN_MS - 1000) }).where(eq(raffles.id, raffleId))

  it('the owner creates, opens, snapshots and draws', async () => {
    const r = await create({ rules: 'House rules', minPresentMinutes: 3, autoSnapshotMinutes: 10 })
    expect(r).toMatchObject({ status: 'draft', name: 'Friday raffle', prize: 'A wearable', rules: 'House rules', minPresentMinutes: 3, autoSnapshotMinutes: 10, mode: 'one_per_person' })
    const row = await db.query.raffles.findFirst({ where: eq(raffles.id, r.id) })
    expect(row!.hostTermsAcceptedAt).toBeInstanceOf(Date)
    expect(row!.minPresentSeconds).toBe(180)

    const opened = await call('POST', `/api/raffles/${r.id}/open`)
    expect(opened.json().raffle.status).toBe('open')
    const afterOpen = await db.query.raffles.findFirst({ where: eq(raffles.id, r.id) })
    expect(afterOpen!.openedAt).toBeInstanceOf(Date)
    expect(afterOpen!.nextAutoSnapshotAt!.getTime() - afterOpen!.openedAt!.getTime()).toBe(10 * 60_000)

    const here = await entrant(r.id, { minutes: 4 })
    const tooShort = await entrant(r.id, { minutes: 2 })
    const gone = await entrant(r.id, { minutes: 30, seenAgoMs: 120_000 })
    const snap = await call('POST', `/api/raffles/${r.id}/snapshot`)
    expect(snap.statusCode, snap.body).toBe(200)
    expect(snap.json().snapshot.entryIds).toEqual([here.id])
    expect(snap.json().snapshot.trigger).toBe('manual')

    const draw = await call('POST', `/api/raffles/${r.id}/draw`, host, {})
    expect(draw.statusCode, draw.body).toBe(200)
    expect(draw.json().winners).toEqual([{ entryId: here.id, displayName: here.displayName, wallet: here.wallet }])
    expect(draw.json().draw).toMatchObject({ algorithm: 'v1', mode: 'one_per_person', winnerEntryIds: [here.id], snapshotIds: [snap.json().snapshot.id] })

    const detail = await call('GET', `/api/raffles/${r.id}`)
    expect(detail.statusCode).toBe(200)
    const d = detail.json()
    expect(d.raffle.status).toBe('drawn')
    expect(d.entries.map((e: any) => e.id).sort()).toEqual([here.id, tooShort.id, gone.id].sort())
    expect(d.entries.find((e: any) => e.id === here.id)).toMatchObject({ displayName: here.displayName, wallet: here.wallet, secondsPresent: 240 })
    expect(d.entries[0].lastSeenAt).toBeTruthy()
    expect(d.snapshots).toHaveLength(1)
    expect(d.draws).toHaveLength(1)
    expect(d.draws[0].winners).toEqual([{ entryId: here.id, displayName: here.displayName, wallet: here.wallet }])

    const list = await call('GET', `/api/scenes/${sceneId}/raffles`)
    expect(list.json().raffles.map((x: any) => x.id)).toEqual([r.id])
    expect(list.json().raffles[0].entryCount).toBe(3)

    const closed = await call('POST', `/api/raffles/${r.id}/close`)
    expect(closed.json().raffle.status).toBe('closed')
    expect((await db.query.raffles.findFirst({ where: eq(raffles.id, r.id) }))!.endedAt).toBeInstanceOf(Date)
  })

  it('lists newest first', async () => {
    const a = await create({ name: 'First' })
    await db.update(raffles).set({ createdAt: new Date(Date.now() - 60_000) }).where(eq(raffles.id, a.id))
    const b = await create({ name: 'Second' })
    const list = await call('GET', `/api/scenes/${sceneId}/raffles`)
    expect(list.json().raffles.map((x: any) => x.id)).toEqual([b.id, a.id])
  })

  it('an editor can run a raffle; a viewer, a grant holder and another account get 403', async () => {
    const editor = await createUser()
    await db.insert(sceneCollaborators).values({ sceneId, userId: editor.id, role: 'editor' })
    const r = await create({}, editor)
    expect((await call('POST', `/api/raffles/${r.id}/open`, editor)).statusCode).toBe(200)

    const viewer = await createUser()
    await db.insert(sceneCollaborators).values({ sceneId, userId: viewer.id, role: 'viewer' })
    const grantee = await createUser({ wallet: randomWallet() })
    const venue = await createVenue({ sceneId, name: 'V', slug: `v-${sceneId.slice(0, 8)}` })
    const startsAt = new Date(Date.now() + 5 * 60_000)
    await createBooking({ venueId: venue.id, renterWallet: grantee.wallet!, title: 'Show', startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 3600_000).toISOString(), createdByUserId: host.id })
    expect((await getSceneAccess(actorFromClaims({ id: grantee.id, role: 'creator', wallet: grantee.wallet, verified: true } as any), sceneId)).level).toBe('grant')
    const stranger = await createUser()

    for (const u of [viewer, grantee, stranger]) {
      const reqs: Array<[string, string, unknown?]> = [
        ['GET', `/api/scenes/${sceneId}/raffles`], ['POST', `/api/scenes/${sceneId}/raffles`, VALID],
        ['GET', `/api/raffles/${r.id}`], ['PATCH', `/api/raffles/${r.id}`, { name: 'x' }],
        ['POST', `/api/raffles/${r.id}/snapshot`], ['POST', `/api/raffles/${r.id}/draw`, {}],
        ['POST', `/api/raffles/${r.id}/close`], ['POST', `/api/raffles/${r.id}/cancel`], ['POST', `/api/raffles/${r.id}/open`],
      ]
      for (const [method, url, body] of reqs) {
        const res = await call(method, url, u, body)
        expect([method, url, res.statusCode, res.json().error]).toEqual([method, url, 403, 'forbidden'])
      }
    }
    expect(await db.select().from(raffleSnapshots)).toEqual([])
  })

  it('refuses bad input with a code for each field', async () => {
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ name: '' }, 'name_required'], [{ name: '   ' }, 'name_required'], [{ name: 'x'.repeat(81) }, 'name_required'], [{ name: undefined }, 'name_required'],
      [{ prize: '' }, 'prize_required'], [{ prize: 'x'.repeat(201) }, 'prize_required'],
      [{ rules: 'x'.repeat(4001) }, 'rules_too_long'],
      [{ winnersCount: 0 }, 'winners_out_of_range'], [{ winnersCount: RAFFLE_WINNERS_MAX + 1 }, 'winners_out_of_range'], [{ winnersCount: 1.5 }, 'winners_out_of_range'], [{ winnersCount: undefined }, 'winners_out_of_range'],
      [{ mode: 'lottery' }, 'bad_mode'], [{ mode: undefined }, 'bad_mode'],
      [{ minPresentMinutes: -1 }, 'min_present_out_of_range'], [{ minPresentMinutes: 121 }, 'min_present_out_of_range'], [{ minPresentMinutes: 'five' }, 'min_present_out_of_range'],
      [{ autoSnapshotMinutes: 7 }, 'bad_auto_snapshot'], [{ autoSnapshotMinutes: '5' }, 'bad_auto_snapshot'],
      [{ acceptHostTerms: false }, 'host_terms_required'], [{ acceptHostTerms: undefined }, 'host_terms_required'],
    ]
    for (const [patch, code] of bad) {
      const res = await call('POST', `/api/scenes/${sceneId}/raffles`, host, { ...VALID, ...patch })
      expect([patch, res.statusCode, res.json().error]).toEqual([patch, 400, code])
    }
    expect(await db.select().from(raffles)).toEqual([])
    // At the limits it's fine; the minimum defaults to 5 minutes
    const ok = await create({ name: 'x'.repeat(80), prize: 'y'.repeat(200), rules: 'z'.repeat(4000), winnersCount: RAFFLE_WINNERS_MAX, mode: 'weighted', autoSnapshotMinutes: null })
    expect(ok).toMatchObject({ minPresentMinutes: 5, autoSnapshotMinutes: null, mode: 'weighted' })
    // PATCH validates the same way
    const patched = await call('PATCH', `/api/raffles/${ok.id}`, host, { winnersCount: 0 })
    expect([patched.statusCode, patched.json().error]).toEqual([400, 'winners_out_of_range'])
    expect(RAFFLE_HOST_TERMS.length).toBeGreaterThan(0)
  })

  it('edits a draft or open raffle only; the mode is fixed once a snapshot exists', async () => {
    const r = await create()
    const res = await call('PATCH', `/api/raffles/${r.id}`, host, { name: 'Renamed', winnersCount: 2 })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().raffle).toMatchObject({ name: 'Renamed', winnersCount: 2, prize: 'A wearable' })
    await call('POST', `/api/raffles/${r.id}/open`)
    expect((await call('PATCH', `/api/raffles/${r.id}`, host, { mode: 'weighted' })).statusCode).toBe(200)
    await call('POST', `/api/raffles/${r.id}/snapshot`)
    const locked = await call('PATCH', `/api/raffles/${r.id}`, host, { mode: 'one_per_person' })
    expect([locked.statusCode, locked.json().error]).toEqual([409, 'mode_locked'])
    expect((await call('PATCH', `/api/raffles/${r.id}`, host, { mode: 'weighted', prize: 'Two wearables' })).statusCode).toBe(200)
    await call('POST', `/api/raffles/${r.id}/close`)
    const closed = await call('PATCH', `/api/raffles/${r.id}`, host, { name: 'Late' })
    expect([closed.statusCode, closed.json().error]).toEqual([409, 'bad_status'])
  })

  it('refuses transitions from the wrong status', async () => {
    const r = await create()
    for (const action of ['snapshot', 'draw', 'close']) {
      const res = await call('POST', `/api/raffles/${r.id}/${action}`, host, {})
      expect([action, res.statusCode, res.json().error]).toEqual([action, 409, 'bad_status'])
    }
    expect((await call('POST', `/api/raffles/${r.id}/cancel`)).json().raffle.status).toBe('cancelled')
    expect((await db.query.raffles.findFirst({ where: eq(raffles.id, r.id) }))!.endedAt).toBeInstanceOf(Date)
    for (const action of ['open', 'cancel', 'close', 'snapshot']) {
      const res = await call('POST', `/api/raffles/${r.id}/${action}`)
      expect([action, res.statusCode, res.json().error]).toEqual([action, 409, 'bad_status'])
    }
    // A drawn raffle can't be cancelled, but can be closed
    const d = await openRaffle()
    await entrant(d.id)
    await call('POST', `/api/raffles/${d.id}/snapshot`)
    expect((await call('POST', `/api/raffles/${d.id}/draw`, host, {})).statusCode).toBe(200)
    expect((await call('POST', `/api/raffles/${d.id}/cancel`)).json().error).toBe('bad_status')
    expect((await call('POST', `/api/raffles/${d.id}/open`)).json().error).toBe('bad_status')
    expect((await call('POST', `/api/raffles/${d.id}/close`)).statusCode).toBe(200)
  })

  it('opening a second raffle in the same scene gives raffle_already_active', async () => {
    await openRaffle()
    const second = await create({ name: 'Second' })
    const res = await call('POST', `/api/raffles/${second.id}/open`)
    expect([res.statusCode, res.json().error]).toEqual([409, 'raffle_already_active'])
    expect((await db.query.raffles.findFirst({ where: eq(raffles.id, second.id) }))!.status).toBe('draft')
  })

  it('a draw with no snapshots, or where everyone is under the minimum, is empty_pool and stores nothing', async () => {
    const r = await openRaffle()
    await entrant(r.id, { minutes: 30 })
    const none = await call('POST', `/api/raffles/${r.id}/draw`, host, {})
    expect([none.statusCode, none.json().error]).toEqual([409, 'empty_pool'])

    await db.delete(raffleEntries)
    await entrant(r.id, { minutes: 4 })
    await entrant(r.id, { minutes: 1 })
    const snap = await call('POST', `/api/raffles/${r.id}/snapshot`)
    expect(snap.json().snapshot.entryIds).toEqual([])
    const empty = await call('POST', `/api/raffles/${r.id}/draw`, host, {})
    expect([empty.statusCode, empty.json().error]).toEqual([409, 'empty_pool'])
    expect(await db.select().from(raffleDraws)).toEqual([])
    const row = await db.query.raffles.findFirst({ where: eq(raffles.id, r.id) })
    expect(row).toMatchObject({ status: 'open', lastDrawnAt: null, firstDrawnAt: null })
    expect(published.filter((e) => e.type === 'raffle_draw')).toEqual([])
  })

  it('a second draw within the cooldown is draw_in_progress; after it, the first winner is excluded', async () => {
    const r = await openRaffle()
    const a = await entrant(r.id)
    const b = await entrant(r.id)
    await call('POST', `/api/raffles/${r.id}/snapshot`)
    const first = await call('POST', `/api/raffles/${r.id}/draw`, host, {})
    expect(first.statusCode).toBe(200)
    const again = await call('POST', `/api/raffles/${r.id}/draw`, host, {})
    expect([again.statusCode, again.json().error]).toEqual([409, 'draw_in_progress'])
    expect(await db.select().from(raffleDraws)).toHaveLength(1)

    await pastCooldown(r.id)
    const second = await call('POST', `/api/raffles/${r.id}/draw`, host, {})
    expect(second.statusCode, second.body).toBe(200)
    const won1 = first.json().winners[0].entryId
    const won2 = second.json().winners[0].entryId
    expect(won2).not.toBe(won1)
    expect([won1, won2].sort()).toEqual([a.id, b.id].sort())
    expect(second.json().draw.pool).toEqual([{ entryId: won2, tickets: 1 }])

    // Everyone has won now
    await pastCooldown(r.id)
    expect((await call('POST', `/api/raffles/${r.id}/draw`, host, {})).json().error).toBe('empty_pool')
    const row = await db.query.raffles.findFirst({ where: eq(raffles.id, r.id) })
    expect(row!.status).toBe('drawn')
    // The first draw time stays; the empty-pool attempt stored nothing
    expect(row!.firstDrawnAt!.toISOString()).toBe(first.json().draw.drawnAt)
    expect(await db.select().from(raffleDraws)).toHaveLength(2)
  })

  it('a withdrawn entrant leaves later pools; a past draw still shows it as deleted', async () => {
    const r = await openRaffle()
    const a = await entrant(r.id)
    const b = await entrant(r.id)
    await call('POST', `/api/raffles/${r.id}/snapshot`)
    const first = await call('POST', `/api/raffles/${r.id}/draw`, host, {})
    const winner = first.json().winners[0].entryId
    const other = winner === a.id ? b.id : a.id
    await db.delete(raffleEntries).where(eq(raffleEntries.id, other))
    await pastCooldown(r.id)
    expect((await call('POST', `/api/raffles/${r.id}/draw`, host, {})).json().error).toBe('empty_pool')
    await db.delete(raffleEntries).where(eq(raffleEntries.id, winner))
    const detail = (await call('GET', `/api/raffles/${r.id}`)).json()
    expect(detail.draws[0].winners).toEqual([{ entryId: winner, displayName: null, wallet: null, deleted: true }])
  })

  it('draws only from the chosen snapshots; weighted gives a ticket per snapshot', async () => {
    const r = await openRaffle({ mode: 'weighted', winnersCount: 3 })
    const early = await entrant(r.id)
    const s1 = (await call('POST', `/api/raffles/${r.id}/snapshot`)).json().snapshot
    const late = await entrant(r.id)
    const s2 = (await call('POST', `/api/raffles/${r.id}/snapshot`)).json().snapshot
    const bad = await call('POST', `/api/raffles/${r.id}/draw`, host, { snapshotIds: ['00000000-0000-4000-8000-000000000000'] })
    expect([bad.statusCode, bad.json().error]).toEqual([400, 'bad_snapshots'])
    const onlyFirst = await call('POST', `/api/raffles/${r.id}/draw`, host, { snapshotIds: [s1.id] })
    expect(onlyFirst.json().draw.pool).toEqual([{ entryId: early.id, tickets: 1 }])
    await db.delete(raffleDraws)
    await pastCooldown(r.id)
    const all = await call('POST', `/api/raffles/${r.id}/draw`, host, {})
    expect(all.json().draw.snapshotIds.sort()).toEqual([s1.id, s2.id].sort())
    expect(all.json().draw.pool).toEqual([{ entryId: early.id, tickets: 2 }, { entryId: late.id, tickets: 1 }].sort((x, y) => (x.entryId < y.entryId ? -1 : 1)))
    expect(all.json().winners).toHaveLength(2)
  })

  it('the draw record replays to the same winners', async () => {
    const r = await openRaffle({ winnersCount: 3, mode: 'weighted' })
    for (let i = 0; i < 6; i++) await entrant(r.id)
    await call('POST', `/api/raffles/${r.id}/snapshot`)
    await call('POST', `/api/raffles/${r.id}/snapshot`)
    const draw = (await call('POST', `/api/raffles/${r.id}/draw`, host, {})).json().draw
    const res = await call('GET', `/api/raffles/${r.id}/draws/${draw.id}`)
    expect(res.statusCode).toBe(200)
    const rec = res.json()
    expect(Object.keys(rec).sort()).toEqual(['algorithm', 'drawnAt', 'id', 'mode', 'pool', 'seed', 'snapshotIds', 'winnerEntryIds'])
    expect(rec.seed).toMatch(/^[0-9a-f]{64}$/)
    expect(rec.winnerEntryIds).toHaveLength(3)
    expect(drawWinners(rec.pool, 3, rec.seed, rec.id)).toEqual(rec.winnerEntryIds)
    // Another raffle's id with this draw id finds nothing
    const other = await create({ name: 'Other' })
    expect((await call('GET', `/api/raffles/${other.id}/draws/${draw.id}`)).statusCode).toBe(404)
  })

  it("a scene pass from the owner's HUD can snapshot; a pass for another scene and a Hyperfy pass can't", async () => {
    const r = await openRaffle()
    await entrant(r.id)
    const pass = (sid: string) => ({ authorization: `Bearer ${issueScenePass(app, host as any, host.wallet!, { sceneId: sid, locationId: null }).accessToken}` })
    const ok = await call('POST', `/api/raffles/${r.id}/snapshot`, pass(sceneId))
    expect(ok.statusCode, ok.body).toBe(200)
    expect((await call('GET', `/api/scenes/${sceneId}/raffles`, pass(sceneId))).statusCode).toBe(200)
    const other = (await createScene(host, 'Other')).scene.id
    const wrong = await call('POST', `/api/raffles/${r.id}/snapshot`, pass(other))
    expect([wrong.statusCode, wrong.json().error]).toEqual([403, 'scene_pass_not_allowed'])

    const [world] = await db.insert(hyperfyWorlds).values({ sceneId, ownerId: host.id, name: 'W', keyHash: 'raffle-world-hash', keyPrefix: 'virviw_r' }).returning()
    const [pairing] = await db.insert(hyperfyPairings).values({
      worldId: world.id, userId: host.id, secretHash: 'raffle-secret-hash', status: 'claimed', codeExpiresAt: new Date(Date.now() + 3600_000), expiresAt: new Date(Date.now() + 3600_000),
    }).returning()
    const { pass: hp } = issueHyperfyPass(app, host, host.wallet, { id: pairing.id, worldId: world.id, sceneId })
    const hy = await call('POST', `/api/raffles/${r.id}/snapshot`, { authorization: `Bearer ${hp}` })
    expect([hy.statusCode, hy.json().error]).toEqual([403, 'hyperfy_pass_not_allowed'])
    expect(await db.select().from(raffleSnapshots)).toHaveLength(1)
  })

  it('publishes raffle_draw once, after the commit, with at most WHEEL_MAX_NAMES names and the winners always in', async () => {
    const r = await openRaffle({ winnersCount: 5 })
    for (let i = 0; i < 70; i++) await entrant(r.id, { name: `Name ${String(i).padStart(2, '0')}` })
    await call('POST', `/api/raffles/${r.id}/snapshot`)
    const committed: Promise<unknown[]>[] = []
    initBus({
      publish: (_t: string, d: any) => {
        published.push(d)
        if (d.type === 'raffle_draw') committed.push(db.select({ id: raffleDraws.id }).from(raffleDraws).where(eq(raffleDraws.id, d.draw.drawId)).then((rows) => rows))
      },
      subscribe: () => {}, unsubscribe: () => {},
    })
    const res = await call('POST', `/api/raffles/${r.id}/draw`, host, {})
    expect(res.statusCode).toBe(200)
    const draws = published.filter((e) => e.type === 'raffle_draw')
    expect(draws).toHaveLength(1)
    expect(await Promise.all(committed)).toEqual([[{ id: res.json().draw.id }]])
    const { draw } = draws[0]
    expect(draws[0].sceneId).toBe(sceneId)
    expect(draw.drawId).toBe(res.json().draw.id)
    expect(draw.raffleId).toBe(r.id)
    expect(draw.names).toHaveLength(WHEEL_MAX_NAMES)
    expect(draw.more).toBe(70 - WHEEL_MAX_NAMES)
    expect(new Set(draw.names).size).toBe(WHEEL_MAX_NAMES)
    expect(draw.winners).toEqual(res.json().winners.map((w: any) => ({ entryId: w.entryId, displayName: w.displayName })))
    for (const w of draw.winners) expect(draw.names).toContain(w.displayName)
    // No wallets go to visitors
    expect(JSON.stringify(draw)).not.toMatch(/0x/)
  })

  it('emits raffle_changed (visitor-safe) after open, debounced per scene', async () => {
    const r = await openRaffle()
    await call('PATCH', `/api/raffles/${r.id}`, host, { name: 'Renamed' })
    await call('PATCH', `/api/raffles/${r.id}`, host, { name: 'Renamed again' })
    await sleep(100)
    // (a timer left by an earlier test may publish for its own scene)
    const changes = () => published.filter((e) => e.type === 'raffle_changed' && e.sceneId === sceneId)
    const first = changes()
    expect(first).toHaveLength(1)
    expect(Object.keys(first[0].raffle).sort()).toEqual(['entryCount', 'id', 'name', 'prize', 'rules', 'sceneId', 'status', 'winnersCount'])
    await sleep(2100)
    const all = changes()
    expect(all).toHaveLength(2)
    expect(all[1].raffle).toMatchObject({ id: r.id, name: 'Renamed again', status: 'open', entryCount: 0 })
  }, 10_000)

  it('takeSnapshot and drawRaffle work without the routes', async () => {
    const r = await openRaffle()
    const e = await entrant(r.id)
    const snap = await takeSnapshot(r.id, 'manual')
    expect(snap!.entryIds).toEqual([e.id])
    const out = await drawRaffle(r.id, host.id)
    expect(out.winners.map((w) => w.entryId)).toEqual([e.id])
    expect((await db.query.raffleDraws.findFirst())!.drawnBy).toBe(host.id)
  })

  it('an auto snapshot is taken only when due, and moves the next one on', async () => {
    const r = await openRaffle({ autoSnapshotMinutes: 5 })
    const row = (await db.query.raffles.findFirst({ where: eq(raffles.id, r.id) }))!
    expect(await takeSnapshot(r.id, 'auto', new Date(row.nextAutoSnapshotAt!.getTime() - 1000))).toBeNull()
    const due = new Date(row.nextAutoSnapshotAt!.getTime() + 1000)
    const [a, b] = await Promise.all([takeSnapshot(r.id, 'auto', due), takeSnapshot(r.id, 'auto', due)])
    expect([a, b].filter(Boolean)).toHaveLength(1)
    expect(await db.select().from(raffleSnapshots)).toHaveLength(1)
    const after = (await db.query.raffles.findFirst({ where: eq(raffles.id, r.id) }))!
    expect(after.nextAutoSnapshotAt!.getTime()).toBe(due.getTime() + 5 * 60_000)
  })

  it('unknown raffle ids are 404', async () => {
    expect((await call('GET', '/api/raffles/00000000-0000-4000-8000-000000000000')).statusCode).toBe(404)
    expect((await call('GET', '/api/raffles/not-a-uuid')).statusCode).toBe(404)
    expect((await call('GET', '/api/scenes/not-a-uuid/raffles')).statusCode).toBe(404)
  })
})
