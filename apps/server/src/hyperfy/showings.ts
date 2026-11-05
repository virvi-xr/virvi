import { VideoSourceType, type HyperfyFeedResponse, type SerializedScene } from '@virvixr/shared'
import { screenShowingsMessages, SHOWINGS_REFRESH_MS } from '../scenes/showings.js'

type FeedShowings = NonNullable<HyperfyFeedResponse['showings']>

/** Enabled video screens in Schedule mode in a serialized scene, by element id (`sk`). */
export function scheduledScreenIds(scene: SerializedScene | null): string[] {
  return (scene?.videos ?? [])
    .filter((el) => el.enabled !== false && el.offType === VideoSourceType.SCHEDULED && typeof el.sk === 'string')
    .map((el) => el.sk as string)
}

/**
 * The feed's showings for the scene's scheduled screens (LIV-87). The window starts at the top of the hour, so the
 * answer (and the feed version) stays the same all hour unless a showing is edited, and moves on once an hour.
 */
export async function feedShowings(scene: SerializedScene | null, now = Date.now()): Promise<FeedShowings> {
  const anchor = new Date(Math.floor(now / SHOWINGS_REFRESH_MS) * SHOWINGS_REFRESH_MS)
  const msgs = await screenShowingsMessages(scheduledScreenIds(scene), anchor)
  return msgs.map(({ elementId, showings }) => ({ elementId, showings }))
}
