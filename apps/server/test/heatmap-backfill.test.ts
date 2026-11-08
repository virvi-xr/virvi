import { describe, it, expect, beforeEach } from 'vitest'
import { and, eq, like } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { analyticsHeatmapDaily, analyticsJobRuns, analyticsPositions } from '../src/db/schema.js'
import { HEATMAP_BACKFILL_JOB, rollupDay, runHeatmapHeightBackfill } from '../src/analytics/jobs.js'
import { resetDb } from './helpers/db.js'
import { createAnalyticsScene, insertSession } from './helpers/analytics.js'

const DAY = 86_400_000
const now = new Date('2026-11-08T12:00:00Z')
const dayAgo = (n: number) => new Date(now.getTime() - n * DAY).toISOString().slice(0, 10)
const noonAgo = (n: number) => new Date(`${dayAgo(n)}T12:00:00Z`)

/** A location (30-day retention: no setup) with a legacy height-less heatmap row and its raw positions on each day. */
async function legacyScene(days: number[]) {
  const s = await createAnalyticsScene()
  for (const n of days) {
    const sess = await insertSession(s.id, { startedAt: noonAgo(n), lastSeenAt: noonAgo(n) })
    await db.insert(analyticsPositions).values([
      { sceneId: s.id, sessionId: sess.id, seq: 1, occurredAt: noonAgo(n), x: 2.5, y: 0.9, z: 2.5 },
      { sceneId: s.id, sessionId: sess.id, seq: 2, occurredAt: new Date(noonAgo(n).getTime() + 3000), x: 2.5, y: 3.9, z: 2.5 },
    ])
    await db.insert(analyticsHeatmapDaily).values({ sceneId: s.id, day: dayAgo(n), cellX: 2, cellZ: 2, dwellSec: 6, visits: 1 })
  }
  return s
}

const cellsOf = async (sceneId: string, day: string) =>
  (await db.select().from(analyticsHeatmapDaily).where(and(eq(analyticsHeatmapDaily.sceneId, sceneId), eq(analyticsHeatmapDaily.day, day))))
    .map((c) => ({ y: c.cellY, dwellSec: c.dwellSec }))
    .sort((a, b) => (a.y ?? -99) - (b.y ?? -99))

describe('heatmap height backfill (LIV-85)', () => {
  beforeEach(resetDb)

  it('re-rolls every day fully inside retention with heights; older days keep their height-less cells', async () => {
    const s = await legacyScene([2, 29, 31])
    expect(await runHeatmapHeightBackfill(now)).toEqual({ scenes: 1, days: 2, failed: 0 })
    expect(await cellsOf(s.id, dayAgo(2))).toEqual([{ y: 0, dwellSec: 3 }, { y: 1, dwellSec: 3 }])
    expect(await cellsOf(s.id, dayAgo(29))).toEqual([{ y: 0, dwellSec: 3 }, { y: 1, dwellSec: 3 }])
    expect(await cellsOf(s.id, dayAgo(31))).toEqual([{ y: null, dwellSec: 6 }]) // outside the 30 days
  })

  it('the day the retention cutoff falls in is left alone (some of its positions may already be gone)', async () => {
    const s = await legacyScene([30])
    expect(await runHeatmapHeightBackfill(now)).toMatchObject({ days: 0 })
    expect(await cellsOf(s.id, dayAgo(30))).toEqual([{ y: null, dwellSec: 6 }])
  })

  it('runs once: a second run does nothing, and the per-location progress rows are cleared', async () => {
    const s = await legacyScene([2])
    await runHeatmapHeightBackfill(now)
    await db.delete(analyticsHeatmapDaily)
    await db.insert(analyticsHeatmapDaily).values({ sceneId: s.id, day: dayAgo(2), cellX: 9, cellZ: 9, dwellSec: 1, visits: 1 })
    expect(await runHeatmapHeightBackfill(now)).toBeNull()
    expect(await cellsOf(s.id, dayAgo(2))).toEqual([{ y: null, dwellSec: 1 }])
    const runs = await db.select().from(analyticsJobRuns)
    expect(runs.map((r) => r.name)).toEqual([HEATMAP_BACKFILL_JOB])
  })

  it('a location that fails is retried next time; the others are not redone', async () => {
    const a = await legacyScene([2])
    const b = await legacyScene([3])
    const done: string[] = []
    const failB = async (sceneId: string, day: string, at?: Date) => {
      if (sceneId === b.id) throw new Error('boom')
      done.push(sceneId)
      return rollupDay(sceneId, day, at)
    }
    expect(await runHeatmapHeightBackfill(now, failB)).toEqual({ scenes: 1, days: 1, failed: 1 })
    expect(await db.select().from(analyticsJobRuns).where(eq(analyticsJobRuns.name, HEATMAP_BACKFILL_JOB))).toHaveLength(0)
    expect(await db.select().from(analyticsJobRuns).where(like(analyticsJobRuns.name, `${HEATMAP_BACKFILL_JOB}:%`))).toHaveLength(1)
    done.length = 0
    expect(await runHeatmapHeightBackfill(now, (id, day, at) => (done.push(id), rollupDay(id, day, at)))).toEqual({ scenes: 1, days: 1, failed: 0 })
    expect(done).toEqual([b.id])
    expect(await cellsOf(b.id, dayAgo(3))).toEqual([{ y: 0, dwellSec: 3 }, { y: 1, dwellSec: 3 }])
    expect(await cellsOf(a.id, dayAgo(2))).toHaveLength(2)
  })

  it('two servers running it at once leave the same cells as one', async () => {
    const s = await legacyScene([2, 5])
    await Promise.all([runHeatmapHeightBackfill(now), runHeatmapHeightBackfill(now)])
    expect(await cellsOf(s.id, dayAgo(2))).toEqual([{ y: 0, dwellSec: 3 }, { y: 1, dwellSec: 3 }])
    expect(await cellsOf(s.id, dayAgo(5))).toEqual([{ y: 0, dwellSec: 3 }, { y: 1, dwellSec: 3 }])
    expect(await db.select().from(analyticsJobRuns).where(eq(analyticsJobRuns.name, HEATMAP_BACKFILL_JOB))).toHaveLength(1)
  })
})
