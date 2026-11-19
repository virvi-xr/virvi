export const ANALYTICS_EVENT_TYPES = [
  'session.start',
  'session.heartbeat',
  'session.leave',
  'pos',
  'interact',
  'video',
  'sound',
  'emote',
  'giveaway',
  'custom',
] as const
export type AnalyticsEventType = (typeof ANALYTICS_EVENT_TYPES)[number]

export const ANALYTICS_LIMITS = {
  maxBatchEvents: 100,
  maxEventBytes: 2048,
  maxBodyBytes: 256 * 1024,
  maxQueue: 500,
  flushIntervalMs: 5_000,
  flushAtCount: 50,
  heartbeatMs: 15_000,
  posMovingMs: 3_000,
  posIdleMs: 15_000,
  posMinMoveM: 0.5,
  sessionResumeMs: 60_000,
  hoverDedupeMs: 10_000,
  clockSkewMs: 10 * 60_000,
  backoffMinMs: 1_000,
  backoffMaxMs: 30_000,
} as const

export const NOTICE_TEXT = 'This scene records visitor wallets and names for analytics — powered by Virvi'

export interface AnalyticsEvent {
  t: number
  type: AnalyticsEventType
  seq: number
  data?: Record<string, unknown>
}

export interface AnalyticsSceneRef {
  realm: string
  isWorld: boolean
  isPreview: boolean
  worldName?: string
  baseParcel?: string
  parcels?: string[]
  entityId?: string
  title?: string
}

export interface IngestBatch {
  v: 1
  sessionId: string
  visitorId: string
  isGuest: boolean
  noticeShown: boolean
  displayName?: string
  scene: AnalyticsSceneRef
  events: AnalyticsEvent[]
}

export interface IngestResponse {
  ok: true
  accepted: number
  notice: boolean
}

export const PARCEL_RE = /^-?\d{1,3},-?\d{1,3}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const WORLD_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i
const TYPES = new Set<string>(ANALYTICS_EVENT_TYPES)
const PRIORITY = new Set<AnalyticsEventType>(['session.start', 'session.leave', 'video', 'emote', 'giveaway', 'custom'])

export function isHighPriority(e: { type: AnalyticsEventType; data?: Record<string, unknown> }): boolean {
  return PRIORITY.has(e.type) || (e.type === 'interact' && e.data?.kind === 'click')
}

export function locationKeyFor(scene: AnalyticsSceneRef, signer: string | null): string {
  const place = scene.isWorld ? (scene.worldName ?? '').toLowerCase() : scene.baseParcel ?? ''
  if (scene.isPreview) return `preview:${signer ? signer.toLowerCase() : 'anon'}:${place || 'unknown'}`
  return scene.isWorld ? `world:${place}` : `gc:${place}`
}

export type BatchCheck = { ok: true; batch: IngestBatch; skewed: number } | { ok: false; error: string }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
function utf8Length(s: string): number {
  let n = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) as number
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
  }
  return n
}
const str = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max

function checkScene(s: unknown): AnalyticsSceneRef | string {
  if (!isObj(s)) return 'scene must be an object'
  if (!str(s.realm, 200)) return 'scene.realm is required'
  if (typeof s.isWorld !== 'boolean' || typeof s.isPreview !== 'boolean') return 'scene.isWorld and scene.isPreview must be booleans'
  if (s.isWorld) {
    if (typeof s.worldName !== 'string' || !WORLD_RE.test(s.worldName)) return 'scene.worldName must be a .eth name'
  } else if (typeof s.baseParcel !== 'string' || !PARCEL_RE.test(s.baseParcel)) {
    return 'scene.baseParcel must look like "x,y"'
  }
  if (s.parcels !== undefined) {
    if (!Array.isArray(s.parcels) || s.parcels.length > 400 || !s.parcels.every((p) => typeof p === 'string' && PARCEL_RE.test(p))) {
      return 'scene.parcels must be up to 400 "x,y" strings'
    }
  }
  if (s.entityId !== undefined && !str(s.entityId, 200)) return 'scene.entityId must be a string'
  if (s.title !== undefined && typeof s.title !== 'string') return 'scene.title must be a string'
  return {
    realm: s.realm as string,
    isWorld: s.isWorld as boolean,
    isPreview: s.isPreview as boolean,
    worldName: s.worldName as string | undefined,
    baseParcel: s.baseParcel as string | undefined,
    parcels: s.parcels as string[] | undefined,
    entityId: s.entityId as string | undefined,
    title: typeof s.title === 'string' ? s.title.slice(0, 200) : undefined,
  }
}

/** The scene ref if it is well-formed, else null (the same check ingest applies to batch.scene). */
export function validateSceneRef(v: unknown): AnalyticsSceneRef | null {
  const r = checkScene(v)
  return typeof r === 'string' ? null : r
}

const MAX_NESTING = 20 // levels of objects/arrays, counted from the batch root

/** True when the string contains a UTF-16 high/low surrogate that is not part of a valid pair. */
function hasLoneSurrogate(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = str.charCodeAt(i + 1)
      if (n >= 0xdc00 && n <= 0xdfff) i++
      else return true
    } else if (c >= 0xdc00 && c <= 0xdfff) return true
  }
  return false
}

/** Strings Postgres text/jsonb cannot store (NUL, lone surrogates) and over-deep nesting. */
function scanInput(v: unknown, depth = 0): string | null {
  if (typeof v === 'string') {
    if (v.includes('\u0000')) return 'strings must not contain NUL characters'
    if (hasLoneSurrogate(v)) return 'strings must not contain unpaired surrogates'
    return null
  }
  if (v === null || typeof v !== 'object') return null
  if (depth >= MAX_NESTING) return 'event data too deeply nested'
  const entries: [string | null, unknown][] = Array.isArray(v) ? v.map((x) => [null, x]) : Object.entries(v)
  for (const [k, x] of entries) {
    if (k !== null) {
      const ke = scanInput(k, depth + 1)
      if (ke) return ke
    }
    const e = scanInput(x, depth + 1)
    if (e) return e
  }
  return null
}

export function checkBatch(input: unknown, nowMs: number): BatchCheck {
  if (!isObj(input)) return { ok: false, error: 'batch must be an object' }
  if (input.v !== 1) return { ok: false, error: 'v must be 1' }
  const scanError = scanInput(input)
  if (scanError) return { ok: false, error: scanError }
  if (typeof input.sessionId !== 'string' || !UUID_RE.test(input.sessionId)) return { ok: false, error: 'sessionId must be a UUID' }
  if (!str(input.visitorId, 100)) return { ok: false, error: 'visitorId is required' }
  if (typeof input.isGuest !== 'boolean' || typeof input.noticeShown !== 'boolean') {
    return { ok: false, error: 'isGuest and noticeShown must be booleans' }
  }
  if (input.displayName !== undefined && (typeof input.displayName !== 'string' || input.displayName.length > 64)) {
    return { ok: false, error: 'displayName must be a string up to 64 characters' }
  }
  const scene = checkScene(input.scene)
  if (typeof scene === 'string') return { ok: false, error: scene }
  if (!Array.isArray(input.events) || input.events.length < 1 || input.events.length > ANALYTICS_LIMITS.maxBatchEvents) {
    return { ok: false, error: `events must contain 1-${ANALYTICS_LIMITS.maxBatchEvents} items` }
  }
  let skewed = 0
  const events: AnalyticsEvent[] = []
  for (const e of input.events) {
    if (!isObj(e) || typeof e.t !== 'number' || !Number.isFinite(e.t)) return { ok: false, error: 'event.t must be a number' }
    if (typeof e.type !== 'string' || !TYPES.has(e.type)) return { ok: false, error: `unknown event type: ${String(e.type)}` }
    if (!Number.isSafeInteger(e.seq) || (e.seq as number) < 0 || (e.seq as number) > 2147483647) return { ok: false, error: 'event.seq must be a non-negative integer' }
    if (e.data !== undefined && !isObj(e.data)) return { ok: false, error: 'event.data must be an object' }
    let size: number
    try {
      size = utf8Length(JSON.stringify(e))
    } catch {
      return { ok: false, error: 'event is not serializable' }
    }
    if (size > ANALYTICS_LIMITS.maxEventBytes) return { ok: false, error: 'event exceeds 2 KB' }
    let t = e.t
    if (Math.abs(t - nowMs) > ANALYTICS_LIMITS.clockSkewMs) {
      t = nowMs
      skewed++
    }
    events.push({ t, type: e.type as AnalyticsEventType, seq: e.seq as number, data: e.data as Record<string, unknown> | undefined })
  }
  const visitorId = input.visitorId as string
  return {
    ok: true,
    skewed,
    batch: {
      v: 1,
      sessionId: (input.sessionId as string).toLowerCase(),
      visitorId: visitorId.startsWith('0x') ? visitorId.toLowerCase() : visitorId,
      isGuest: input.isGuest as boolean,
      noticeShown: input.noticeShown as boolean,
      displayName: input.displayName as string | undefined,
      scene,
      events,
    },
  }
}

/** One visitor at an event (LIV-38): time inside the event window, across their sessions at one location. */
export interface EventAttendee {
  /** Short pseudonymous id, stable per location (the same one the sessions list shows). */
  visitorId: string
  /** Where they were: the location's title or key. */
  location: string
  displayName: string | null
  /** Only when the location shows wallets and the visitor allowed it. */
  wallet: string | null
  verified: boolean
  isGuest: boolean
  firstSeenAt: string
  secondsPresent: number
}

/** GET /api/events/:eventId/attendance: who was in the event's scenes between its start and end. */
export interface EventAttendanceReport {
  from: string
  to: string
  /** Locations counted: those of the event's scenes the caller can read analytics for. */
  locations: number
  totals: { visitors: number; verifiedVisitors: number; peakConcurrent: number; avgSecondsPresent: number }
  attendees: EventAttendee[]
  /** True when the list was cut at the row cap; the totals still count everyone. */
  truncated: boolean
}
