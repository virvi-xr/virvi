import { and, eq, inArray, or } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { adEvents, sceneElements, scenes } from '../db/schema.js'
import type { AdEvent } from '@virvixr/shared'
import { selectAdsForElements } from './select.js'
import { adViewerKey } from './viewer.js'

// dwell_ms is an int column
const MAX_DWELL_MS = 2_147_483_647
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The subset of `ids` that belong to the scene's active preset: an element of that preset, or the
 * original an element of that preset was cloned from (booking presets).
 */
export async function elementsInScene(sceneId: string, ids: string[]): Promise<Set<string>> {
  const wanted = [...new Set(ids)].filter((id) => UUID.test(id))
  const found = new Set<string>()
  if (!wanted.length) return found
  const [scene] = await db.select({ presetId: scenes.activePresetId }).from(scenes).where(eq(scenes.id, sceneId))
  if (!scene?.presetId) return found
  const rows = await db
    .select({ id: sceneElements.id, clonedFromId: sceneElements.clonedFromId })
    .from(sceneElements)
    .where(and(eq(sceneElements.presetId, scene.presetId), or(inArray(sceneElements.id, wanted), inArray(sceneElements.clonedFromId, wanted))))
  const want = new Set(wanted)
  for (const r of rows) {
    if (want.has(r.id)) found.add(r.id)
    if (r.clonedFromId && want.has(r.clonedFromId)) found.add(r.clonedFromId)
  }
  return found
}

/**
 * Store ad events for a scene, once per viewer per ad per space per level per UTC day. Events for elements outside
 * the scene, or for an ad not selectable on that element (ignoring booking pauses), are dropped.
 * Returns how many rows were inserted.
 */
export async function recordAdEvents(
  sceneId: string,
  viewer: { wallet: string | null; isGuest: boolean; sessionId: string },
  events: AdEvent[],
  now: Date,
): Promise<number> {
  const inScene = await elementsInScene(sceneId, events.map((e) => e.elementId))
  const kept = events.filter((e) => inScene.has(e.elementId))
  if (!kept.length) return 0
  const spaces = await selectAdsForElements(sceneId, [...new Set(kept.map((e) => e.elementId))], now, { ignoreBooking: true })

  const verified = !!viewer.wallet && !viewer.isGuest
  // A wallet is stored only as a keyed hash (LIV-167), like visitor analytics; a guest by its session
  const viewerKey = verified ? adViewerKey(sceneId, viewer.wallet!) : `u:${viewer.sessionId}`
  const day = now.toISOString().slice(0, 10)
  const rows: (typeof adEvents.$inferInsert)[] = []
  for (const e of kept) {
    const item = spaces[e.elementId]?.ads.find((a) => a.adId === e.adId)
    if (!item) continue
    rows.push({
      adId: e.adId,
      elementId: e.elementId,
      sceneId,
      level: e.level,
      day,
      viewerKey,
      verified,
      house: item.house,
      dwellMs: e.level === 'look' && e.dwellMs !== undefined ? Math.min(Math.round(e.dwellMs), MAX_DWELL_MS) : null,
      occurredAt: now,
    })
  }
  if (!rows.length) return 0
  const inserted = await db
    .insert(adEvents)
    .values(rows)
    .onConflictDoNothing({ target: [adEvents.adId, adEvents.elementId, adEvents.level, adEvents.day, adEvents.viewerKey] })
    .returning({ id: adEvents.id })
  return inserted.length
}
