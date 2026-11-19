export type AdShape = '16:9' | '1:1' | '9:16' | '2:5'
export const AD_SHAPES: readonly AdShape[] = ['16:9', '1:1', '9:16', '2:5']

export type AdFormats = 'image' | 'video' | 'both'

export interface Quat {
  x: number
  y: number
  z: number
  w: number
}

export const AD_LIMITS = {
  imageSeconds: 10,
  freqCapPerHour: 6,
  maxVideoAdsPerScene: 2,
  idleMs: 60_000,
  minShortSideM: 0.5,
  onScreenMaxDistanceM: 25,
  onScreenHalfAngleDeg: 35,
  onScreenMinApparent: 0.04,
  onScreenMinMs: 1000,
  hoverMaxDistanceM: 20,
  serveRefreshMs: 300_000,
  eventsFlushMs: 10_000,
  eventsFlushCount: 20,
  maxEventsPerBatch: 50,
  playlistItemsBetweenAds: 1,
} as const

export interface AdItem {
  adId: string
  creativeId: string
  kind: 'image' | 'video'
  url: string
  clickUrl: string
  house: boolean
}

export interface AdServeRequest {
  elementIds: string[]
}

export interface AdServeResponse {
  spaces: Record<string, { paused: boolean; ads: AdItem[] }>
}

export type AdLevel = 'scene' | 'screen' | 'look' | 'click'
const AD_LEVELS = new Set<string>(['scene', 'screen', 'look', 'click'])

export interface AdEvent {
  adId: string
  elementId: string
  level: AdLevel
  t: number
  dwellMs?: number
}

export interface AdEventBatch {
  v: 1
  sessionId: string
  events: AdEvent[]
}

export type AdEventBatchCheck = { ok: true; batch: AdEventBatch } | { ok: false; error: string }

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= max
}

export function checkAdEventBatch(body: unknown): AdEventBatchCheck {
  if (!isObj(body)) return { ok: false, error: 'batch must be an object' }
  if (body.v !== 1) return { ok: false, error: 'v must be 1' }
  if (!str(body.sessionId, 100)) return { ok: false, error: 'sessionId is required' }
  if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > AD_LIMITS.maxEventsPerBatch) {
    return { ok: false, error: `events must contain 1-${AD_LIMITS.maxEventsPerBatch} items` }
  }
  const events: AdEvent[] = []
  for (const e of body.events) {
    if (!isObj(e)) return { ok: false, error: 'event must be an object' }
    if (!str(e.adId, 100) || !str(e.elementId, 100)) return { ok: false, error: 'event.adId and event.elementId are required' }
    if (typeof e.level !== 'string' || !AD_LEVELS.has(e.level)) return { ok: false, error: `unknown event level: ${String(e.level)}` }
    if (typeof e.t !== 'number' || !Number.isFinite(e.t)) return { ok: false, error: 'event.t must be a number' }
    if (e.dwellMs !== undefined) {
      if (e.level !== 'look') return { ok: false, error: 'event.dwellMs is only allowed on look events' }
      if (typeof e.dwellMs !== 'number' || !Number.isFinite(e.dwellMs) || e.dwellMs < 0) {
        return { ok: false, error: 'event.dwellMs must be a non-negative number' }
      }
    }
    events.push({ adId: e.adId, elementId: e.elementId, level: e.level as AdLevel, t: e.t, ...(e.dwellMs !== undefined ? { dwellMs: e.dwellMs } : {}) })
  }
  return { ok: true, batch: { v: 1, sessionId: body.sessionId, events } }
}

/** What an ad space owner allows on a space. */
export type AdContent = 'family' | 'all' | 'approve'
/** What a reviewer rates an ad as. */
export type AdAudience = 'family' | 'mature'
export type AdReviewStatus = 'pending' | 'approved' | 'rejected'
export const AD_CONTENT_DEFAULT: AdContent = 'family'

export type AdReviewer = { kind: 'human'; userId: string } | { kind: 'ai'; label: string }

export interface AdminAd {
  id: string
  name: string
  kind: 'house' | 'partner'
  clickUrl: string
  status: 'active' | 'paused'
  startsAt: string | null
  endsAt: string | null
  creatives: { id: string; shape: AdShape; kind: 'image' | 'video'; url: string }[]
  placements: string[]
  review: {
    status: AdReviewStatus
    audience: AdAudience | null
    reason: string | null
    reviewerKind: 'human' | 'ai' | null
    reviewedAt: string | null
  }
}

/** An element an ad can be placed on. `shape` is null for an ad space whose stored shape is invalid. */
export interface AdminAdSpace {
  elementId: string
  sceneId: string
  sceneName: string
  presetName: string
  /** Whether the element's preset is the scene's active preset. */
  activePreset: boolean
  name: string
  type: 'ad_space' | 'video'
  shape: AdShape | null
  /** The owner's content setting for this space. */
  content: AdContent
}

export type LevelCounts = Record<AdLevel, number> & { unverified: Record<AdLevel, number> }

export interface AdReport {
  totals: LevelCounts
  byDay: ({ day: string } & LevelCounts)[]
  bySpace: ({ elementId: string; sceneName: string } & LevelCounts)[]
  avgLookMs: number | null
}

/**
 * LIV-38: what one ad space delivered, for its scene's owner: per ad, the views at each level over the last `days`
 * days (UTC, today included). Views are one per wallet (or guest) per level per day, as in the admin report.
 */
export interface OwnerAdSpaceReport {
  days: number
  from: string
  ads: ({ adId: string; name: string; house: boolean } & LevelCounts)[]
  totals: LevelCounts
}

/** Body of the public early-access form. `nickname` is a honeypot: real visitors never fill it. */
export interface AdvertiserLeadInput {
  email: string
  name?: string
  company?: string
  website?: string
  message?: string
  consent: true
  nickname?: string
}

export interface AdminAdvertiserLead {
  id: string
  email: string
  name: string | null
  company: string | null
  website: string | null
  message: string | null
  consentAt: string
  createdAt: string
  updatedAt: string
}

export interface OwnerAdCandidate {
  adId: string
  name: string
  clickUrl: string
  house: boolean
  audience: AdAudience | null
  creatives: { id: string; kind: 'image' | 'video'; url: string }[]
  decision: 'approved' | 'declined' | null
}

export interface OwnerAdSpace {
  elementId: string
  content: AdContent
  ads: OwnerAdCandidate[]
}
