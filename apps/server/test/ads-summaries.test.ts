import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { ads, adEvents, adDailySpace, adDailyViewers } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, createElement } from './helpers/factories.js'
import { adReport } from '../src/ads/report.js'
import { summarizeAdDays, adSummariesThrough, purgeOldAdViews, adRetentionCutoff } from '../src/ads/summaries.js'

describe('ad view summaries (LIV-190)', () => {
  let ad: { id: string }
  let e1: { id: string }
  let e2: { id: string }
  let sceneId: string

  const ev = (elementId: string, level: string, day: string, viewerKey: string, verified: boolean, dwellMs?: number) => ({
    adId: ad.id, elementId, sceneId, level, day, viewerKey, verified, house: false, dwellMs: dwellMs ?? null,
    occurredAt: new Date(`${day}T12:00:00Z`),
  })

  beforeEach(async () => {
    await resetDb()
    const owner = await createUser({ role: 'admin' })
    const { scene, preset } = await createScene(owner, 'Ship')
    sceneId = scene.id
    e1 = await createElement(preset.id, { type: 'ad_space', properties: { shape: '1:1' } })
    e2 = await createElement(preset.id, { type: 'ad_space', properties: { shape: '1:1' } })
    ;[ad] = await db.insert(ads).values({ name: 'Ad', kind: 'partner', clickUrl: 'https://x.example' }).returning()
    await db.insert(adEvents).values([
      ev(e1.id, 'scene', '2026-10-18', 'h:a', true),
      ev(e1.id, 'screen', '2026-10-18', 'h:a', true),
      ev(e1.id, 'look', '2026-10-18', 'h:a', true, 3000),
      ev(e1.id, 'click', '2026-10-18', 'h:a', true),
      ev(e1.id, 'scene', '2026-10-19', 'h:b', true),
      ev(e1.id, 'look', '2026-10-19', 'h:b', true, 5000),
      ev(e2.id, 'scene', '2026-10-19', 'h:a', true),
      ev(e2.id, 'scene', '2026-10-19', 'h:b', true), // h:b saw it on both spaces that day
      ev(e2.id, 'scene', '2026-10-19', 'u:g1', false),
      ev(e2.id, 'click', '2026-10-19', 'u:g1', false),
      ev(e2.id, 'look', '2026-10-19', 'u:g1', false, 90000),
      ev(e1.id, 'look', '2026-10-20', 'h:c', true, 10000),
      ev(e1.id, 'scene', '2026-10-20', 'h:c', true),
    ])
  })

  it('summarizes only days closed for a full day, and records how far it got', async () => {
    // 2026-10-20 is still inside the one-day lag on the 21st
    await summarizeAdDays(new Date('2026-10-21T03:00:00Z'))
    expect(await adSummariesThrough()).toBe('2026-10-19')
    const days = (await db.select({ day: adDailyViewers.day }).from(adDailyViewers)).map((r) => r.day)
    expect(new Set(days)).toEqual(new Set(['2026-10-18', '2026-10-19']))
  })

  it('the report is unchanged by summarizing, and survives the raw rows being deleted', async () => {
    const before = await adReport(ad.id)
    expect(before.avgLookMs).toBe(6000)
    await summarizeAdDays(new Date('2026-10-21T03:00:00Z'))
    expect(await adReport(ad.id)).toEqual(before)
    // What a purge may do later: drop summarized days only
    await db.delete(adEvents).where(eq(adEvents.day, '2026-10-18'))
    await db.delete(adEvents).where(eq(adEvents.day, '2026-10-19'))
    expect(await adReport(ad.id)).toEqual(before)
  })

  it('running again, or on a later day, never double-counts', async () => {
    const before = await adReport(ad.id)
    await summarizeAdDays(new Date('2026-10-21T03:00:00Z'))
    await summarizeAdDays(new Date('2026-10-21T09:00:00Z'))
    expect(await adReport(ad.id)).toEqual(before)
    await summarizeAdDays(new Date('2026-10-25T03:00:00Z'))
    expect(await adSummariesThrough()).toBe('2026-10-23')
    expect(await adReport(ad.id)).toEqual(before)
    const spaceRows = await db.select().from(adDailySpace).where(eq(adDailySpace.day, '2026-10-19'))
    const scenes = spaceRows.filter((r) => r.elementId === e2.id && r.level === 'scene' && r.verified)
    expect(scenes).toEqual([expect.objectContaining({ views: 2 })])
  })

  it('summaries hold no viewer keys', async () => {
    await summarizeAdDays(new Date('2026-10-21T03:00:00Z'))
    const cols = [...Object.keys((await db.select().from(adDailySpace))[0]), ...Object.keys((await db.select().from(adDailyViewers))[0])]
    expect(cols.some((c) => /viewer_?key|wallet/i.test(c))).toBe(false)
  })

  it('the retention cutoff is the same day 13 months back, clamped to short months', () => {
    expect(adRetentionCutoff(new Date('2027-11-21T03:00:00Z'))).toBe('2026-10-21')
    expect(adRetentionCutoff(new Date('2027-03-31T03:00:00Z'))).toBe('2026-02-28')
  })

  it('the purge deletes raw views older than 13 months, only for summarized days, and reports keep every number', async () => {
    // Nothing summarized yet: nothing goes, however old
    expect(await purgeOldAdViews(new Date('2028-01-01T03:00:00Z'))).toEqual({ deleted: 0 })
    expect(await db.select().from(adEvents)).toHaveLength(13)

    await summarizeAdDays(new Date('2026-10-21T03:00:00Z')) // through 2026-10-19; the 20th stays raw
    const before = await adReport(ad.id)
    // 13 months after the 20th: the 18th and 19th are past the cutoff and summarized, the 20th is not summarized
    expect(await purgeOldAdViews(new Date('2027-11-21T03:00:00Z'))).toEqual({ deleted: 11 })
    const left = await db.select({ day: adEvents.day }).from(adEvents)
    expect(new Set(left.map((r) => r.day))).toEqual(new Set(['2026-10-20']))
    expect(await adReport(ad.id)).toEqual(before)
  })

  it('a day inside the 13 months is kept even when summarized', async () => {
    await summarizeAdDays(new Date('2026-10-25T03:00:00Z'))
    expect(await purgeOldAdViews(new Date('2027-11-19T03:00:00Z'))).toEqual({ deleted: 4 }) // only the 18th
    expect(await db.select().from(adEvents)).toHaveLength(9)
  })
})
