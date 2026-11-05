/** Shared vocabulary for Hyperfy worlds: the scene feed protocol and the visit analytics batch. */

import type { Adjustment } from './ar.js'
import type { ShowingInstance } from './showings.js'
import type { Vec3 } from './types/math.js'

export const HYPERFY_FEED = {
  version: 1,
  /** Long-poll hold, in ms. */
  holdMs: 25_000,
  /** App back-off bounds on failure, in ms. */
  retryMinMs: 1_000,
  retryMaxMs: 30_000,
  /** How often a poll updates a world's lastSeenAt, in ms. */
  lastSeenThrottleMs: 60_000,
  analyticsFlushMs: 15_000,
  positionSampleMs: 5_000,
  keyPrefix: 'virviw_',
} as const

/**
 * One serialized instance; other keys are allowed. In an AR space's feed, an instance with a "Just this place"
 * adjustment has its transform adjusted and also carries `arAdjusted`, the shared (unadjusted) transform in `arShared`
 * and the adjustment itself in `arAdjustment`.
 */
export interface SerializedSceneInstance {
  sk?: string
  position?: Vec3
  rotation?: Vec3
  scale?: Vec3
  arAdjusted?: true
  arShared?: { position: Vec3; rotation: Vec3; scale: Vec3 }
  arAdjustment?: Adjustment
  [key: string]: unknown
}

/** One serialized element (video, image, model, sound, ...) with its instances; other keys are allowed. */
export interface SerializedSceneElement {
  sk?: string
  instances?: SerializedSceneInstance[]
  [key: string]: unknown
}

/** The preset JSON shape the feed serves; other keys (nfts, widgets, ...) are allowed. */
export interface SerializedScene {
  videos: SerializedSceneElement[]
  images: SerializedSceneElement[]
  models: SerializedSceneElement[]
  sounds: SerializedSceneElement[]
  [key: string]: unknown
}

export interface HyperfyFeedResponse {
  v: 1
  /** SHA-256 of the scene JSON. */
  version: string
  /** Null when the scene has no active preset. */
  scene: SerializedScene | null
  /**
   * Scheduled showings (LIV-87) for each enabled video screen in Schedule mode, by element id (the element's `sk`),
   * running now or starting within about a day and a half. Refreshed hourly and on every edit.
   */
  showings?: Array<{ elementId: string; showings: ShowingInstance[] }>
  /** Virvi's clock (UTC ms) when this answer was sent, for `screenStateAt`. Not part of `version`. */
  serverTime?: number
}

/** How long a hosted world's data, slug and key are kept after it ends, before the sweep purges it. */
export const HOSTED_WORLD_RETENTION_DAYS = 30

export interface HyperfyWorldSummary {
  id: string
  sceneId: string
  name: string
  kind: 'self' | 'hosted'
  /** Hostname of a hosted world; null for self-run worlds. */
  address: string | null
  status: 'provisioning' | 'running' | 'failed' | 'ended'
  errorMessage: string | null
  /** First 12 characters of the world key, to tell keys apart; never the whole key. */
  keyPrefix: string
  createdAt: string
  lastSeenAt: string | null
  endsAt: string | null
  endedAt: string | null
  purgeAfter: string | null
}

export type HyperfyVisitEventType = 'enter' | 'leave' | 'pos'

export interface HyperfyVisitEvent {
  type: HyperfyVisitEventType
  playerId: string
  t: number
  x?: number
  y?: number
  z?: number
}

export interface HyperfyAnalyticsBatch {
  v: 1
  events: HyperfyVisitEvent[]
}

export type HyperfyAnalyticsCheck = { ok: true; batch: HyperfyAnalyticsBatch } | { ok: false; error: string }

export const HYPERFY_ANALYTICS_LIMITS = {
  maxBatchEvents: 200,
  maxPlayerIdLength: 100,
  /** How far an event's t may be behind the server's clock (a world that was offline for a while). */
  maxPastMs: 24 * 3600_000,
  /** How far an event's t may be ahead of the server's clock (clock skew). */
  maxFutureMs: 60_000,
} as const

const EVENT_TYPES: ReadonlySet<string> = new Set<HyperfyVisitEventType>(['enter', 'leave', 'pos'])

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function checkHyperfyAnalyticsBatch(body: unknown, nowMs: number): HyperfyAnalyticsCheck {
  if (!isObj(body)) return { ok: false, error: 'batch must be an object' }
  if (body.v !== 1) return { ok: false, error: 'v must be 1' }
  const max = HYPERFY_ANALYTICS_LIMITS.maxBatchEvents
  if (!Array.isArray(body.events) || body.events.length > max) {
    return { ok: false, error: `events must be an array of up to ${max} items` }
  }
  const events: HyperfyVisitEvent[] = []
  for (const e of body.events) {
    if (!isObj(e)) return { ok: false, error: 'event must be an object' }
    if (typeof e.type !== 'string' || !EVENT_TYPES.has(e.type)) return { ok: false, error: `unknown event type: ${String(e.type)}` }
    if (typeof e.playerId !== 'string' || e.playerId.length < 1 || e.playerId.length > HYPERFY_ANALYTICS_LIMITS.maxPlayerIdLength) {
      return { ok: false, error: `playerId must be a string of 1-${HYPERFY_ANALYTICS_LIMITS.maxPlayerIdLength} characters` }
    }
    if (!isNum(e.t)) return { ok: false, error: 'event.t must be a number' }
    if (e.t < nowMs - HYPERFY_ANALYTICS_LIMITS.maxPastMs || e.t > nowMs + HYPERFY_ANALYTICS_LIMITS.maxFutureMs) {
      return { ok: false, error: 'event.t must be within the last 24 hours and at most 60 seconds ahead' }
    }
    const hasCoords = e.x !== undefined || e.y !== undefined || e.z !== undefined
    if (e.type === 'pos') {
      if (!isNum(e.x) || !isNum(e.y) || !isNum(e.z)) return { ok: false, error: 'pos events need numeric x, y and z' }
      events.push({ type: 'pos', playerId: e.playerId, t: e.t, x: e.x, y: e.y, z: e.z })
    } else {
      if (hasCoords) return { ok: false, error: `${e.type} events must not have coordinates` }
      events.push({ type: e.type as 'enter' | 'leave', playerId: e.playerId, t: e.t })
    }
  }
  return { ok: true, batch: { v: 1, events } }
}
