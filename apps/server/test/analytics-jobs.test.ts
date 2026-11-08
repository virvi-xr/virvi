import { describe, it, expect, beforeEach } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import {
  analyticsSessions,
  analyticsEvents,
  analyticsPositions,
  analyticsRollupHourly,
  analyticsHeatmapDaily,
  analyticsCopresenceDaily,
  analyticsDirtyHours,
  analyticsScenes,
} from '../src/db/schema.js'
import { runSessionCloseSweep, rollupHour, rollupDay, runRollups, runRetention, registerDailyJob, runDailyJobs } from '../src/analytics/jobs.js'
import { writeBatch } from '../src/analytics/writer.js'
import type { AnalyticsSceneRow } from '../src/analytics/registry.js'
import type { IngestBatch } from '@virvixr/shared'
import { randomUUID } from 'node:crypto'
import { resetDb } from './helpers/db.js'
import { createUser, createScene } from './helpers/factories.js'
import { createSetup } from './helpers/setups.js'
import { createAnalyticsScene, insertSession } from './helpers/analytics.js'

const H = new Date('2026-10-01T10:00:00Z')
const at = (min: number, sec = 0) => new Date(H.getTime() + min * 60_000 + sec * 1000)

describe('analytics jobs', () => {
  beforeEach(resetDb)

  it('closes sessions idle for more than 60 s', async () => {
    const s = await createAnalyticsScene()
    const idle = await insertSession(s.id, { lastSeenAt: new Date(Date.now() - 61_000) })
    const live = await insertSession(s.id, { lastSeenAt: new Date(Date.now() - 10_000) })
    expect(await runSessionCloseSweep()).toBe(1)
    const rows = await db.select().from(analyticsSessions)
    expect(rows.find((r) => r.id === idle.id)!.endedAt?.getTime()).toBe(idle.lastSeenAt.getTime())
    expect(rows.find((r) => r.id === live.id)!.endedAt).toBeNull()
  })

  it('hourly rollup: counts, uniques, new vs returning, verified, dwell percentiles, peak concurrency, breakdowns', async () => {
    const s = await createAnalyticsScene()
    const a = await insertSession(s.id, { visitorHash: 'A', startedAt: at(0), lastSeenAt: at(10), endedAt: at(10), durationSec: 600, verified: true, country: 'DE', cameraMode: 'third' })
    await insertSession(s.id, { visitorHash: 'B', startedAt: at(5), lastSeenAt: at(8), endedAt: at(8), durationSec: 180, isReturning: true, country: 'DE', cameraMode: 'first' })
    await insertSession(s.id, { visitorHash: 'A', startedAt: at(30), lastSeenAt: at(31), endedAt: at(31), durationSec: 60, isReturning: true, country: 'US' })
    await db.insert(analyticsEvents).values([
      { sceneId: s.id, sessionId: a.id, seq: 1, visitorHash: 'A', type: 'interact', occurredAt: at(1), data: { kind: 'click', target: 'door' } },
      { sceneId: s.id, sessionId: a.id, seq: 2, visitorHash: 'A', type: 'interact', occurredAt: at(2), data: { kind: 'click', target: 'door' } },
      { sceneId: s.id, sessionId: a.id, seq: 3, visitorHash: 'A', type: 'interact', occurredAt: at(2), data: { kind: 'hover', target: 'door' } },
      { sceneId: s.id, sessionId: a.id, seq: 4, visitorHash: 'A', type: 'emote', occurredAt: at(3), data: { emote: 'wave' } },
      { sceneId: s.id, sessionId: a.id, seq: 5, visitorHash: 'A', type: 'video', occurredAt: at(4), data: { target: 'screen', state: 'play' } },
      { sceneId: s.id, sessionId: a.id, seq: 6, visitorHash: 'A', type: 'video', occurredAt: at(6), data: { target: 'screen', state: 'pause' } },
    ])
    await rollupHour(s.id, H)
    const [r] = await db.select().from(analyticsRollupHourly).where(eq(analyticsRollupHourly.sceneId, s.id))
    expect(r).toMatchObject({ sessions: 3, uniqueVisitors: 2, newVisitors: 1, returningVisitors: 2, verifiedSessions: 1, peakConcurrency: 2 })
    expect(r.dwellP50Sec).toBe(180)
    expect(r.interactions).toEqual({ door: 2 })
    expect(r.emotes).toEqual({ wave: 1 })
    expect(r.video).toEqual({ screen: { plays: 1, watchSec: 120 } })
    expect(r.countries).toEqual({ DE: 2, US: 1 })
    expect(r.cameraModes).toEqual({ third: 1, first: 1 })
  })

  it('daily heatmap uses 1 m cells and capped gaps; co-presence needs 5 minutes of overlap', async () => {
    const s = await createAnalyticsScene()
    const a = await insertSession(s.id, { visitorHash: 'A', startedAt: at(0), lastSeenAt: at(10), endedAt: at(10) })
    await insertSession(s.id, { visitorHash: 'B', startedAt: at(2), lastSeenAt: at(9), endedAt: at(9) })
    await insertSession(s.id, { visitorHash: 'C', startedAt: at(9), lastSeenAt: at(12), endedAt: at(12) })
    await db.insert(analyticsPositions).values([
      { sceneId: s.id, sessionId: a.id, seq: 1, occurredAt: at(0, 0), x: 3.4, y: 0, z: 4.9 },
      { sceneId: s.id, sessionId: a.id, seq: 2, occurredAt: at(0, 3), x: 3.6, y: 0, z: 4.1 },
      { sceneId: s.id, sessionId: a.id, seq: 3, occurredAt: at(1, 0), x: 8.0, y: 0, z: 8.0 },
    ])
    await rollupDay(s.id, '2026-10-01')
    const cells = await db.select().from(analyticsHeatmapDaily).where(eq(analyticsHeatmapDaily.sceneId, s.id))
    const cell = (x: number, z: number) => cells.find((c) => c.cellX === x && c.cellZ === z)
    expect(cell(3, 4)).toMatchObject({ dwellSec: 3 + 15, visits: 1 }) // 3 s gap + gap capped at 15 s
    expect(cell(8, 8)).toMatchObject({ dwellSec: 3, visits: 1 }) // last sample counts 3 s
    const pairs = await db.select().from(analyticsCopresenceDaily)
    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toMatchObject({ visitorA: 'A', visitorB: 'B', overlapSec: 420 })
  })

  it('daily heatmap keeps floors apart: a visitor on the ground and one 3 m up make two cells at the same x/z', async () => {
    const s = await createAnalyticsScene() // Decentraland: y is about 0.9 m above the feet
    const a = await insertSession(s.id, { visitorHash: 'A', startedAt: at(0), lastSeenAt: at(10) })
    const b = await insertSession(s.id, { visitorHash: 'B', startedAt: at(0), lastSeenAt: at(10) })
    await db.insert(analyticsPositions).values([
      { sceneId: s.id, sessionId: a.id, seq: 1, occurredAt: at(0, 0), x: 5.5, y: 0.88, z: 6.5 },
      { sceneId: s.id, sessionId: a.id, seq: 2, occurredAt: at(0, 3), x: 5.2, y: 2.3, z: 6.1 }, // jumping: still the ground floor
      { sceneId: s.id, sessionId: b.id, seq: 1, occurredAt: at(0, 0), x: 5.5, y: 3.9, z: 6.5 },
    ])
    await rollupDay(s.id, '2026-10-01')
    const cells = (await db.select().from(analyticsHeatmapDaily).where(eq(analyticsHeatmapDaily.sceneId, s.id)))
      .map((c) => ({ x: c.cellX, y: c.cellY, z: c.cellZ, dwellSec: c.dwellSec, visits: c.visits }))
      .sort((p, q) => p.y! - q.y!)
    expect(cells).toEqual([
      { x: 5, y: 0, z: 6, dwellSec: 6, visits: 1 },
      { x: 5, y: 1, z: 6, dwellSec: 3, visits: 1 },
    ])
  })

  it('Hyperfy positions are at the feet, so its floors band without the Decentraland offset', async () => {
    const s = await createAnalyticsScene({ kind: 'hyperfy' })
    const a = await insertSession(s.id, { startedAt: at(0), lastSeenAt: at(10) })
    await db.insert(analyticsPositions).values([
      { sceneId: s.id, sessionId: a.id, seq: 1, occurredAt: at(0, 0), x: 1, y: 0, z: 1 },
      { sceneId: s.id, sessionId: a.id, seq: 2, occurredAt: at(1, 0), x: 1, y: 3, z: 1 },
      { sceneId: s.id, sessionId: a.id, seq: 3, occurredAt: at(2, 0), x: 1, y: -3, z: 1 },
    ])
    await rollupDay(s.id, '2026-10-01')
    const ys = (await db.select().from(analyticsHeatmapDaily)).map((c) => c.cellY).sort()
    expect(ys).toEqual([-2, 0, 1])
  })

  it('re-running a day replaces its cells, and two runs at once leave one set', async () => {
    const s = await createAnalyticsScene()
    const a = await insertSession(s.id, { startedAt: at(0), lastSeenAt: at(10) })
    await db.insert(analyticsPositions).values({ sceneId: s.id, sessionId: a.id, seq: 1, occurredAt: at(0), x: 1, y: 0.9, z: 1 })
    await rollupDay(s.id, '2026-10-01')
    await Promise.all([rollupDay(s.id, '2026-10-01'), rollupDay(s.id, '2026-10-01'), rollupDay(s.id, '2026-10-01')])
    expect(await db.select().from(analyticsHeatmapDaily)).toHaveLength(1)
  })

  it('during a rolling deploy, a rollup by the old code (no day lock, height-less rows) and one by the new never both stay', async () => {
    const s = await createAnalyticsScene()
    const a = await insertSession(s.id, { startedAt: at(0), lastSeenAt: at(10) })
    await db.insert(analyticsPositions).values({ sceneId: s.id, sessionId: a.id, seq: 1, occurredAt: at(0), x: 1, y: 0.9, z: 1 })
    const day = '2026-10-01'
    const oldRollup = (hold: Promise<void>, started: () => void) =>
      db.transaction(async (tx) => {
        // What the pre-LIV-85 rollupDay did: replace the day, no cell_y, no lock.
        await tx.delete(analyticsHeatmapDaily).where(and(eq(analyticsHeatmapDaily.sceneId, s.id), eq(analyticsHeatmapDaily.day, day)))
        await tx.insert(analyticsHeatmapDaily).values({ sceneId: s.id, day, cellX: 1, cellZ: 1, dwellSec: 3, visits: 1 })
        started()
        await hold
      })
    // Old first: the new rollup waits for it, then replaces its rows.
    let release!: () => void
    let started!: () => void
    const held = new Promise<void>((r) => (release = r))
    const inside = new Promise<void>((r) => (started = r))
    const old = oldRollup(held, started)
    await inside
    const fresh = rollupDay(s.id, day)
    await new Promise((r) => setTimeout(r, 300))
    release()
    await Promise.all([old, fresh])
    expect((await db.select().from(analyticsHeatmapDaily)).map((c) => c.cellY)).toEqual([0])
    // New first: the old rollup's delete waits for it, then replaces it (height-less until the next rollup; never doubled).
    let ready!: () => void
    const begun = new Promise<void>((r) => (ready = r))
    const slow = db.transaction(async (tx) => {
      await tx.execute(sql`lock table analytics_heatmap_daily in share row exclusive mode`)
      ready()
      await new Promise((r) => setTimeout(r, 300))
    })
    await begun
    const late = rollupDay(s.id, day)
    const legacy = oldRollup(Promise.resolve(), () => {})
    await Promise.all([slow, late, legacy])
    expect(await db.select().from(analyticsHeatmapDaily)).toHaveLength(1)
  })

  it('the heatmap key is the cell and its floor: a second row for both is refused, another floor is not', async () => {
    const s = await createAnalyticsScene()
    const row = { sceneId: s.id, day: '2026-10-01', cellX: 1, cellZ: 1, cellY: 0, dwellSec: 1, visits: 1 }
    await db.insert(analyticsHeatmapDaily).values(row)
    await expect(db.insert(analyticsHeatmapDaily).values(row)).rejects.toThrow()
    await db.insert(analyticsHeatmapDaily).values({ ...row, cellY: 1 })
    expect(await db.select().from(analyticsHeatmapDaily)).toHaveLength(2)
  })

  it('runRollups processes dirty hours and clears them', async () => {
    const s = await createAnalyticsScene()
    await insertSession(s.id, { startedAt: at(0), lastSeenAt: at(1), endedAt: at(1) })
    await db.insert(analyticsDirtyHours).values({ sceneId: s.id, hour: H })
    expect(await runRollups(new Date('2026-10-01T12:00:00Z'))).toEqual({ hours: 1, days: 1 })
    expect(await db.select().from(analyticsDirtyHours)).toHaveLength(0)
    expect(await db.select().from(analyticsRollupHourly)).toHaveLength(1)
  })

  it('retention: no setup 30 days, ended setup 30, preview 7, active setup by the host tier; rollups survive', async () => {
    const now = new Date('2026-10-04T00:00:00Z')
    const old = new Date(now.getTime() - 40 * 86400_000)
    const mid = new Date(now.getTime() - 10 * 86400_000)
    const unset = await createAnalyticsScene()
    const preview = await createAnalyticsScene({ kind: 'preview', isPreview: true })
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const setUp = await createAnalyticsScene()
    await createSetup(setUp.id, scene.id)
    const ended = await createAnalyticsScene()
    await createSetup(ended.id, scene.id, { startedAt: old, endedAt: mid })
    for (const sc of [unset, preview, setUp, ended]) {
      await insertSession(sc.id, { startedAt: old, lastSeenAt: old })
      await insertSession(sc.id, { startedAt: mid, lastSeenAt: mid })
      await db.insert(analyticsRollupHourly).values({ sceneId: sc.id, hour: old, sessions: 1 })
    }
    await runRetention(now)
    const left = async (id: string) => (await db.select().from(analyticsSessions).where(eq(analyticsSessions.sceneId, id))).length
    expect(await left(unset.id)).toBe(1) // 40-day-old gone, 10-day kept
    expect(await left(ended.id)).toBe(1)
    expect(await left(preview.id)).toBe(0) // both older than 7 days
    // Test env runs with all features unlocked (no Stripe key) → set-up scenes keep everything
    expect(await left(setUp.id)).toBe(2)
    expect(await db.select().from(analyticsRollupHourly)).toHaveLength(4)
  })

  const mkBatch = (sessionId: string, events: Array<Record<string, unknown>>) =>
    ({ v: 1, sessionId, visitorId: '0xabc', isGuest: true, noticeShown: false, scene: {}, events }) as unknown as IngestBatch
  const write = (scene: AnalyticsSceneRow, b: IngestBatch) =>
    writeBatch({ scene, batch: b, verified: false, signer: null, country: null, keepPosProbability: 1 })

  it('writer re-reads wallet visibility inside the transaction (stale scene object)', async () => {
    const s = await createAnalyticsScene() // DB: walletVisibility false
    const W = '0x00000000000000000000000000000000000000aa'
    const b = { ...mkBatch(randomUUID(), [{ t: at(1).getTime(), type: 'session.start', seq: 0, data: {} }]), visitorId: W, isGuest: false, noticeShown: true, displayName: 'Ana' } as unknown as IngestBatch
    await writeBatch({ scene: { ...s, walletVisibility: true }, batch: b, verified: true, signer: W, country: null, keepPosProbability: 1 })
    const [row] = await db.select().from(analyticsSessions)
    expect(row.wallet).toBeNull()
    expect(row.displayName).toBeNull()
  })

  it('writer bumps last_activity_at only when it is null or more than 60 s behind, after the batch commits', async () => {
    const s = await createAnalyticsScene()
    const sid = randomUUID()
    const activity = async () => (await db.select().from(analyticsScenes).where(eq(analyticsScenes.id, s.id)))[0].lastActivityAt?.getTime()
    await write(s, mkBatch(sid, [{ t: at(1).getTime(), type: 'session.start', seq: 0, data: {} }]))
    expect(await activity()).toBe(at(1).getTime())
    await write(s, mkBatch(sid, [{ t: at(1, 30).getTime(), type: 'custom', seq: 1, data: {} }]))
    expect(await activity()).toBe(at(1).getTime()) // 30 s newer: not worth a write
    await write(s, mkBatch(sid, [{ t: at(3).getTime(), type: 'custom', seq: 2, data: {} }]))
    expect(await activity()).toBe(at(3).getTime())
  })

  it('writers share the scene row lock instead of queueing on an exclusive one', async () => {
    const s = await createAnalyticsScene({ lastActivityAt: at(10) })
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let locked!: () => void
    const isLocked = new Promise<void>((r) => (locked = r))
    // Another writer mid-transaction, holding the scene row FOR SHARE.
    const other = db.transaction(async (tx) => {
      await tx.select({ id: analyticsScenes.id }).from(analyticsScenes).where(eq(analyticsScenes.id, s.id)).for('share')
      locked()
      await held
    })
    await isLocked
    try {
      const done = write(s, mkBatch(randomUUID(), [{ t: at(1).getTime(), type: 'session.start', seq: 0, data: {} }])).then(() => 'done')
      const outcome = await Promise.race([done, new Promise((r) => setTimeout(() => r('blocked'), 1_500))])
      expect(outcome).toBe('done')
    } finally {
      release()
      await other
    }
  })

  it('ingest drops positions beyond 32000 m', async () => {
    const s = await createAnalyticsScene()
    const sid = randomUUID()
    await write(s, mkBatch(sid, [
      { t: at(1).getTime(), type: 'pos', seq: 1, data: { x: 40000, y: 0, z: 1 } },
      { t: at(2).getTime(), type: 'pos', seq: 2, data: { x: 5, y: 0, z: 1 } },
    ]))
    const rows = await db.select().from(analyticsPositions)
    expect(rows).toHaveLength(1)
    expect(rows[0].x).toBe(5)
  })

  it('an out-of-range position does not break runRollups for other scenes', async () => {
    const bad = await createAnalyticsScene()
    const good = await createAnalyticsScene()
    const sess = await insertSession(bad.id, { startedAt: at(0), lastSeenAt: at(1), endedAt: at(1) })
    await insertSession(good.id, { startedAt: at(0), lastSeenAt: at(1), endedAt: at(1) })
    await db.insert(analyticsPositions).values({ sceneId: bad.id, sessionId: sess.id, seq: 1, occurredAt: at(0), x: 40000, y: 0, z: 0 })
    await db.insert(analyticsDirtyHours).values([{ sceneId: bad.id, hour: H }, { sceneId: good.id, hour: H }])
    await expect(runRollups(new Date('2026-10-01T12:00:00Z'))).resolves.toBeDefined()
    const r = await db.select().from(analyticsRollupHourly).where(eq(analyticsRollupHourly.sceneId, good.id))
    expect(r).toHaveLength(1)
  })

  it('marks the session start hour dirty when a later batch arrives', async () => {
    const s = await createAnalyticsScene()
    const sid = randomUUID()
    await write(s, mkBatch(sid, [{ t: at(-90).getTime(), type: 'session.start', seq: 0, data: {} }]))
    await db.delete(analyticsDirtyHours)
    await write(s, mkBatch(sid, [{ t: at(5).getTime(), type: 'emote', seq: 1, data: { emote: 'wave' } }]))
    const hours = (await db.select().from(analyticsDirtyHours)).map((d) => d.hour.toISOString()).sort()
    expect(hours).toEqual(['2026-10-01T08:00:00.000Z', '2026-10-01T10:00:00.000Z'])
  })

  it('a late event for an already-rolled-up past hour is rolled up on the next run', async () => {
    const s = await createAnalyticsScene()
    const now = new Date('2026-10-01T12:00:00Z')
    const sess = await insertSession(s.id, { startedAt: at(0), lastSeenAt: at(1), endedAt: at(1) })
    await db.insert(analyticsDirtyHours).values({ sceneId: s.id, hour: H })
    await runRollups(now)
    await db.insert(analyticsEvents).values({ sceneId: s.id, sessionId: sess.id, seq: 1, visitorHash: 'x', type: 'emote', occurredAt: at(2), data: { emote: 'wave' } })
    await db.insert(analyticsDirtyHours).values({ sceneId: s.id, hour: H })
    expect(await runRollups(now)).toMatchObject({ hours: 1 })
    const [r] = await db.select().from(analyticsRollupHourly).where(eq(analyticsRollupHourly.sceneId, s.id))
    expect(r.emotes).toEqual({ wave: 1 })
  })

  it('a daily job runs once per UTC day across restarts', async () => {
    let calls = 0
    registerDailyJob('test-daily', async () => { calls++ })
    const day1 = new Date('2026-10-02T03:00:00Z')
    await runDailyJobs(day1)
    await runDailyJobs(new Date('2026-10-02T20:00:00Z'))
    expect(calls).toBe(1)
    await runDailyJobs(new Date('2026-10-03T01:00:00Z'))
    expect(calls).toBe(2)
  })
})
