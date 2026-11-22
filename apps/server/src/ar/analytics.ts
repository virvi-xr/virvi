import type { HyperfyAnalyticsBatch } from '@virvixr/shared'
import { recordVisitBatch } from '../hyperfy/analytics.js'

/** The headset apps that report visits. The Apple plan adds `ar-visionos`. */
export const AR_ANALYTICS_PLATFORMS: ReadonlySet<string> = new Set(['ar-quest', 'ar-ios'])

/**
 * Record an AR space's visitor events, as Hyperfy worlds do: an `ar` analytics location per space, and
 * unverified guest sessions tagged with the headset's platform.
 */
export function recordArBatch(
  space: { id: string; sceneId: string; name: string },
  platform: string,
  batch: HyperfyAnalyticsBatch,
): Promise<{ accepted: number }> {
  return recordVisitBatch({ kind: 'ar', sourceId: space.id, keyPrefix: 'ar', realm: 'ar', platform, title: space.name, sceneId: space.sceneId, hostUserId: null }, batch)
}
