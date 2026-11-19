import { and, eq, gt, gte, inArray, lte, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { adDailySpace, adDailyViewers, adEvents, ads, scenes } from '../db/schema.js'
import { adSummariesThrough } from './summaries.js'
import type { AdLevel, AdReport, LevelCounts, OwnerAdSpaceReport } from '@virvixr/shared'

const LEVELS: AdLevel[] = ['scene', 'screen', 'look', 'click']

function emptyCounts(): LevelCounts {
  return { scene: 0, screen: 0, look: 0, click: 0, unverified: { scene: 0, screen: 0, look: 0, click: 0 } }
}

function add(c: LevelCounts, level: string, verified: boolean, n: number) {
  if (!LEVELS.includes(level as AdLevel)) return
  if (verified) c[level as AdLevel] += n
  else c.unverified[level as AdLevel] += n
}

/**
 * Per-ad numbers. Events are one per wallet (or guest session) per space per level per day: each space counts
 * its own rows, while totals and days count each viewer once per level per day across spaces.
 * Days up to the summaries' watermark come from the daily summaries (LIV-190), later days from the raw rows, so the
 * numbers are the same before and after a day is summarized and after its raw rows are gone.
 */
export async function adReport(adId: string): Promise<AdReport> {
  const through = (await adSummariesThrough()) ?? '0001-01-01'
  const rawDays = and(eq(adEvents.adId, adId), gt(adEvents.day, through))
  const sumDays = and(eq(adDailySpace.adId, adId), lte(adDailySpace.day, through))
  const spaceRows = [
    ...(await db
      .select({
        elementId: adEvents.elementId,
        sceneName: scenes.name,
        level: adEvents.level,
        verified: adEvents.verified,
        n: sql<number>`count(*)::int`,
      })
      .from(adEvents)
      .innerJoin(scenes, eq(scenes.id, adEvents.sceneId))
      .where(rawDays)
      .groupBy(adEvents.elementId, scenes.name, adEvents.level, adEvents.verified)),
    ...(await db
      .select({
        elementId: adDailySpace.elementId,
        sceneName: scenes.name,
        level: adDailySpace.level,
        verified: adDailySpace.verified,
        n: sql<number>`sum(${adDailySpace.views})::int`,
      })
      .from(adDailySpace)
      .innerJoin(scenes, eq(scenes.id, adDailySpace.sceneId))
      .where(sumDays)
      .groupBy(adDailySpace.elementId, scenes.name, adDailySpace.level, adDailySpace.verified)),
  ]
  const dayRows = [
    ...(await db
      .select({
        day: adDailyViewers.day,
        level: adDailyViewers.level,
        verified: adDailyViewers.verified,
        n: adDailyViewers.viewers,
      })
      .from(adDailyViewers)
      .where(and(eq(adDailyViewers.adId, adId), lte(adDailyViewers.day, through)))),
    ...(await db
      .select({
        day: adEvents.day,
        level: adEvents.level,
        verified: adEvents.verified,
        n: sql<number>`count(distinct ${adEvents.viewerKey})::int`,
      })
      .from(adEvents)
      .where(rawDays)
      .groupBy(adEvents.day, adEvents.level, adEvents.verified)),
  ]

  const totals = emptyCounts()
  const byDay = new Map<string, LevelCounts>()
  const bySpace = new Map<string, { sceneName: string; counts: LevelCounts }>()
  for (const r of dayRows) {
    add(totals, r.level, r.verified, r.n)
    if (!byDay.has(r.day)) byDay.set(r.day, emptyCounts())
    add(byDay.get(r.day)!, r.level, r.verified, r.n)
  }
  for (const r of spaceRows) {
    if (!bySpace.has(r.elementId)) bySpace.set(r.elementId, { sceneName: r.sceneName, counts: emptyCounts() })
    add(bySpace.get(r.elementId)!.counts, r.level, r.verified, r.n)
  }

  // Only paid (verified) looks make the average
  const [rawLook] = await db
    .select({ sum: sql<string | null>`sum(${adEvents.dwellMs})`, n: sql<number>`count(${adEvents.dwellMs})::int` })
    .from(adEvents)
    .where(and(rawDays, eq(adEvents.level, 'look'), eq(adEvents.verified, true)))
  const [sumLook] = await db
    .select({ sum: sql<string | null>`sum(${adDailySpace.lookMsSum})`, n: sql<number>`coalesce(sum(${adDailySpace.lookCount}), 0)::int` })
    .from(adDailySpace)
    .where(sumDays)
  const lookMs = Number(rawLook?.sum ?? 0) + Number(sumLook?.sum ?? 0)
  const looks = (rawLook?.n ?? 0) + (sumLook?.n ?? 0)

  return {
    totals,
    byDay: [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([day, c]) => ({ day, ...c })),
    bySpace: [...bySpace]
      .sort(([a, x], [b, y]) => x.sceneName.localeCompare(y.sceneName) || a.localeCompare(b))
      .map(([elementId, v]) => ({ elementId, sceneName: v.sceneName, ...v.counts })),
    avgLookMs: looks === 0 ? null : Math.round(lookMs / looks),
  }
}

/**
 * LIV-38: what an ad space delivered since `from` (a UTC date), per ad, for its scene's owner. `elementIds` is the
 * space and its booking copies, which show the same ads. Summarized days and raw days are read as in adReport.
 */
export async function adSpaceReport(elementIds: string[], from: string, days: number): Promise<OwnerAdSpaceReport> {
  const through = (await adSummariesThrough()) ?? '0001-01-01'
  const rows = [
    ...(await db
      .select({ adId: adEvents.adId, level: adEvents.level, verified: adEvents.verified, n: sql<number>`count(*)::int` })
      .from(adEvents)
      .where(and(inArray(adEvents.elementId, elementIds), gt(adEvents.day, through), gte(adEvents.day, from)))
      .groupBy(adEvents.adId, adEvents.level, adEvents.verified)),
    ...(await db
      .select({ adId: adDailySpace.adId, level: adDailySpace.level, verified: adDailySpace.verified, n: sql<number>`sum(${adDailySpace.views})::int` })
      .from(adDailySpace)
      .where(and(inArray(adDailySpace.elementId, elementIds), lte(adDailySpace.day, through), gte(adDailySpace.day, from)))
      .groupBy(adDailySpace.adId, adDailySpace.level, adDailySpace.verified)),
  ]
  const totals = emptyCounts()
  const byAd = new Map<string, LevelCounts>()
  for (const r of rows) {
    add(totals, r.level, r.verified, r.n)
    if (!byAd.has(r.adId)) byAd.set(r.adId, emptyCounts())
    add(byAd.get(r.adId)!, r.level, r.verified, r.n)
  }
  const names = byAd.size
    ? await db.select({ id: ads.id, name: ads.name, kind: ads.kind }).from(ads).where(inArray(ads.id, [...byAd.keys()]))
    : []
  const info = new Map(names.map((a) => [a.id, a]))
  return {
    days,
    from,
    totals,
    ads: [...byAd]
      .filter(([id]) => info.has(id))
      .map(([adId, c]) => ({ adId, name: info.get(adId)!.name, house: info.get(adId)!.kind === 'house', ...c }))
      .sort((a, b) => b.screen + b.unverified.screen - (a.screen + a.unverified.screen) || a.name.localeCompare(b.name)),
  }
}
