import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { raffleDraws, raffleEntries, raffles, raffleSnapshots } from '../src/db/schema.js'
import { initBus } from '../src/realtime/bus.js'
import { drawWinners } from '../src/raffles/draw.js'
import { runRaffleSweep, scrubEndedRaffles } from '../src/raffles/sweeps.js'
import { setDeleteMyDataLimiter } from '../src/routes/analytics-read.js'
import { TokenBucketLimiter } from '../src/analytics/limiter.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, randomWallet, testApp, tokenFor, type TestUser } from './helpers/factories.js'

const DAY = 86_400_000
const MIN = 60_000

describe('raffle sweeps, retention and delete-my-data (LIV-55)', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let host: TestUser
  let sceneId: string
  let published: any[]

  beforeEach(async () => {
    await resetDb()
    setDeleteMyDataLimiter(new TokenBucketLimiter())
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

  async function raffle(v: Partial<typeof raffles.$inferInsert> = {}) {
    const [r] = await db.insert(raffles).values({
      sceneId, createdBy: host.id, name: 'Friday raffle', prize: 'A wearable', winnersCount: 1, mode: 'one_per_person', status: 'open',
      hostTermsAcceptedAt: new Date(), openedAt: new Date(), ...v,
    }).returning()
    return r
  }
  async function entry(raffleId: string, user?: TestUser, v: Partial<typeof raffleEntries.$inferInsert> = {}) {
    const u = user ?? (await createUser({ wallet: randomWallet() }))
    const [e] = await db.insert(raffleEntries).values({
      raffleId, userId: u.id, wallet: randomWallet(), displayName: 'Visitor', consentVersion: 1, ...v,
    }).returning()
    return { entry: e, user: u }
  }
  const snaps = (id: string) => db.select().from(raffleSnapshots).where(eq(raffleSnapshots.raffleId, id))
  const row = async (id: string) => (await db.select().from(raffles).where(eq(raffles.id, id)))[0]

  it('two concurrent sweeps make exactly one snapshot and move the next one on', async () => {
    const now = new Date()
    const r = await raffle({ autoSnapshotMinutes: 5, nextAutoSnapshotAt: new Date(now.getTime() - 1000) })
    const [a, b] = await Promise.all([runRaffleSweep(now), runRaffleSweep(now)])
    expect(a.snapshots + b.snapshots).toBe(1)
    const list = await snaps(r.id)
    expect(list).toHaveLength(1)
    expect(list[0].trigger).toBe('auto')
    expect((await row(r.id)).nextAutoSnapshotAt!.getTime()).toBe(now.getTime() + 5 * MIN)
  })

  it('a raffle not yet due makes no snapshot', async () => {
    const now = new Date()
    const r = await raffle({ autoSnapshotMinutes: 5, nextAutoSnapshotAt: new Date(now.getTime() + MIN) })
    const none = await raffle({ sceneId: (await createScene(host)).scene.id })
    expect(await runRaffleSweep(now)).toEqual({ snapshots: 0, closed: 0 })
    expect(await snaps(r.id)).toHaveLength(0)
    expect(await snaps(none.id)).toHaveLength(0)
  })

  it('closes 7 days after the last draw, and 30 days after opening', async () => {
    const now = new Date()
    const s2 = (await createScene(host)).scene.id
    const s3 = (await createScene(host)).scene.id
    const drawn = await raffle({ status: 'drawn', openedAt: new Date(now.getTime() - 8 * DAY), lastDrawnAt: new Date(now.getTime() - 7 * DAY), nextAutoSnapshotAt: new Date(now.getTime() - 1000), autoSnapshotMinutes: 5 })
    const old = await raffle({ sceneId: s2, openedAt: new Date(now.getTime() - 30 * DAY) })
    const fresh = await raffle({ sceneId: s3, status: 'drawn', openedAt: new Date(now.getTime() - 20 * DAY), lastDrawnAt: new Date(now.getTime() - 6 * DAY) })
    const res = await runRaffleSweep(now)
    expect(res).toEqual({ snapshots: 0, closed: 2 })
    for (const id of [drawn.id, old.id]) {
      const r = await row(id)
      expect(r.status).toBe('closed')
      expect(r.endedAt!.getTime()).toBe(now.getTime())
    }
    expect((await row(drawn.id)).nextAutoSnapshotAt).toBeNull()
    expect((await row(fresh.id)).status).toBe('drawn')
    expect(await snaps(drawn.id)).toHaveLength(0)
    await new Promise((r) => setTimeout(r, 50))
    expect(published.filter((e) => e.type === 'raffle_changed').map((e) => e.sceneId).sort()).toEqual([sceneId, s2].sort())
  })

  it('the scrub nulls names and wallets 30 days after the raffle ended, and not before', async () => {
    const now = new Date()
    const ended = await raffle({ status: 'closed', endedAt: new Date(now.getTime() - 30 * DAY) })
    const recent = await raffle({ sceneId: (await createScene(host)).scene.id, status: 'closed', endedAt: new Date(now.getTime() - 30 * DAY + MIN) })
    const live = await raffle({ sceneId: (await createScene(host)).scene.id })
    const a = (await entry(ended.id)).entry
    const b = (await entry(recent.id)).entry
    const c = (await entry(live.id)).entry
    expect(await scrubEndedRaffles(now)).toBe(1)
    const get = async (id: string) => (await db.select().from(raffleEntries).where(eq(raffleEntries.id, id)))[0]
    expect(await get(a.id)).toMatchObject({ wallet: null, displayName: null })
    expect(await get(b.id)).toMatchObject({ wallet: b.wallet, displayName: 'Visitor' })
    expect(await get(c.id)).toMatchObject({ wallet: c.wallet, displayName: 'Visitor' })
    expect(await scrubEndedRaffles(now)).toBe(0)
  })

  it('delete-my-data removes the caller\'s entries, reports the count, and the draw still replays', async () => {
    const wallet = randomWallet()
    const r = await raffle({ status: 'drawn', winnersCount: 1 })
    const me = await createUser({ wallet })
    const mine = (await entry(r.id, me, { wallet })).entry
    const other = (await entry(r.id)).entry
    const pool = [{ entryId: mine.id, tickets: 1 }, { entryId: other.id, tickets: 1 }].sort((x, y) => (x.entryId < y.entryId ? -1 : 1))
    const [draw] = await db.insert(raffleDraws).values({ raffleId: r.id, mode: 'one_per_person', pool, seed: 'ab'.repeat(32), winnerEntryIds: [] }).returning()
    const winners = drawWinners(pool, 1, draw.seed, draw.id)
    await db.update(raffleDraws).set({ winnerEntryIds: [mine.id] }).where(eq(raffleDraws.id, draw.id))

    const res = await app.inject({ method: 'POST', url: '/api/analytics/me/delete', headers: { authorization: `Bearer ${tokenFor(me)}` } })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().deleted.raffleEntries).toBe(1)
    const left = await db.select().from(raffleEntries).where(eq(raffleEntries.raffleId, r.id))
    expect(left.map((e) => e.id)).toEqual([other.id])

    const detail = await app.inject({ method: 'GET', url: `/api/raffles/${r.id}`, headers: { authorization: `Bearer ${tokenFor(host)}` } })
    expect(detail.statusCode).toBe(200)
    expect(detail.json().draws[0].winners).toEqual([{ entryId: mine.id, displayName: null, wallet: null, deleted: true }])
    const rec = await app.inject({ method: 'GET', url: `/api/raffles/${r.id}/draws/${draw.id}`, headers: { authorization: `Bearer ${tokenFor(host)}` } })
    expect(rec.statusCode).toBe(200)
    expect(rec.json().pool).toEqual(pool)
    expect(drawWinners(rec.json().pool, 1, rec.json().seed, rec.json().id)).toEqual(winners)
  })
})
