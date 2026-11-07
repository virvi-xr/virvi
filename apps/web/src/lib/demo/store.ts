/**
 * The guest demos' data layer (LIV-91 phase 2): the `useApi()` methods the demo Analytics, Events and Giveaways pages call,
 * answered from sample data in this browser. Writes are kept under `virvi.demo.<trialId>` and never sent anywhere; any
 * other method is refused (`overlayDemoApi`), so nothing a demo page does reaches the server.
 */
import type { Api as RealApi } from '../api'
import type { AnalyticsRangeQuery, AnalyticsSession, AnalyticsSummary, TimeseriesPoint } from '../analytics/types'
import { demoFixtures, type DemoData, type DemoEditable, type DemoEvent, type DemoGiveaway } from './fixtures'

export const DEMO_METHODS = [
  'getAnalyticsLocations', 'getAnalyticsSummary', 'getAnalyticsTimeseries', 'getAnalyticsHeatmap', 'getAnalyticsSessions', 'getAnalyticsLive',
  'getEvents', 'getEvent', 'createEvent', 'updateEvent', 'deleteEvent',
  'linkSceneToEvent', 'unlinkSceneFromEvent', 'linkGiveawayToEvent', 'unlinkGiveawayFromEvent',
  'getScenes', 'getGiveaways', 'getGiveaway', 'createGiveaway', 'updateGiveaway', 'deleteGiveaway',
  'addGiveawayItem', 'deleteGiveawayItem', 'getGiveawayClaims',
] as const satisfies ReadonlyArray<keyof RealApi>

/** The demo's methods: the same signatures and return shapes as the real api's. */
export type DemoApi = Pick<RealApi, (typeof DEMO_METHODS)[number]>

const PREFIX = 'virvi.demo.'
export const demoStorageKey = (trialId: string) => `${PREFIX}${trialId}`
const VERSION = 1
const EDITABLE_LISTS = ['events', 'eventScenes', 'eventGiveaways', 'giveaways', 'items', 'claims'] as const satisfies ReadonlyArray<keyof DemoEditable>
const PAGE = 25

/** Forgets every demo kept in this browser (the trial ended, or the person signed out). */
export function clearDemoStores(storage: Pick<Storage, 'length' | 'key' | 'removeItem'>): void {
  try {
    const keys: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i)
      if (k?.startsWith(PREFIX)) keys.push(k)
    }
    for (const k of keys) storage.removeItem(k)
  } catch {}
}

function apiError(status: number, body: Record<string, unknown>): Error {
  return Object.assign(new Error(String(body.error ?? `API error ${status}`)), { status, body })
}
const notFound = () => apiError(404, { error: 'Not found' })

/** A demo refusal: what a trial gets from a real account-only route, so the sign-up sheet reads it the same way. */
export function demoRefusal(name: string): Error {
  return apiError(403, { error: 'account_required', action: `demo:${name}` })
}

/**
 * `real`'s methods, each replaced by the demo's or, when the demo has none, by one that rejects with `demoRefusal`
 * (after telling `onRefused`, which opens the sign-up sheet). `real` gives only the names: none of its functions is kept,
 * and a name it doesn't have is refused too, so no call can fall through to the server.
 */
export function overlayDemoApi<T extends object>(real: T, demo: DemoApi, onRefused?: (action: string) => void): T {
  const own = demo as unknown as Record<string, unknown>
  const refuse = (name: string) => (..._args: unknown[]) => {
    onRefused?.(`demo:${name}`)
    return Promise.reject(demoRefusal(name))
  }
  const pick = (name: string) => (Object.prototype.hasOwnProperty.call(own, name) ? own[name] : refuse(name))
  const closed: Record<string, unknown> = {}
  for (const name of Object.keys(real)) closed[name] = pick(name)
  return new Proxy(closed, {
    get(target, prop) {
      // Not a thenable, and no symbol lookups (inspection, iteration) turn into calls
      if (typeof prop === 'symbol' || prop === 'then') return undefined
      if (!(prop in target)) target[prop] = pick(prop)
      return target[prop]
    },
    set: () => false,
  }) as unknown as T
}

let counter = 0
const newId = (kind: string) => {
  counter += 1
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10)
  return `demo-${kind}-${rand}${counter}`
}

const inRange = (iso: string, q: AnalyticsRangeQuery) => {
  const t = Date.parse(iso)
  return t >= Date.parse(q.from) && t <= Date.parse(q.to)
}
const tally = (values: string[]) => values.reduce<Record<string, number>>((m, v) => ((m[v] = (m[v] ?? 0) + 1), m), {})

const NO_ORIGIN = 'https://demo.invalid'

/**
 * A giveaway item's image as the demo keeps it (LIV-138): a `data:image/` URL, or a relative or same-origin http(s) URL;
 * anything else is null (the page then shows no picture), so a guest's demo never loads an outside address.
 */
export function demoImageUrl(url: unknown, origin?: string | null): string | null {
  if (typeof url !== 'string' || url === '') return null
  if (/^data:image\//i.test(url)) return url
  const home = origin || NO_ORIGIN
  try {
    const u = new URL(url, home)
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === new URL(home).origin ? url : null
  } catch {
    return null
  }
}

export function createDemoApi(opts: { trialId: string; now: () => number; storage?: Storage; origin?: string | null }): DemoApi {
  const key = demoStorageKey(opts.trialId)
  const base: DemoData = demoFixtures(opts.now())
  const origin = opts.origin !== undefined ? opts.origin : typeof location !== 'undefined' ? location.origin : null
  const sampleEvent = new Map(base.events.map((e) => [e.id, e]))
  const editable = (d: DemoData): DemoEditable => ({
    events: d.events, eventScenes: d.eventScenes, eventGiveaways: d.eventGiveaways, giveaways: d.giveaways, items: d.items, claims: d.claims,
  })

  /**
   * The sample events the guest hasn't edited are the sample's again, placed around this visit's `now` (LIV-138), so the
   * live one is still live days later. `sampleEvents` lists them; a store from before it counts a sample event the guest
   * never saved (updatedAt still its createdAt) as untouched.
   */
  const reanchor = (data: DemoEditable, kept: unknown): Set<string> => {
    const untouched = new Set(
      Array.isArray(kept)
        ? kept.filter((id): id is string => typeof id === 'string')
        : data.events.filter((e) => sampleEvent.has(e.id) && e.updatedAt === e.createdAt).map((e) => e.id),
    )
    for (const id of [...untouched]) if (!sampleEvent.has(id)) untouched.delete(id)
    data.events = data.events.map((e) => (untouched.has(e.id) ? structuredClone(sampleEvent.get(e.id)!) : e))
    for (const item of data.items) item.imageUrl = demoImageUrl(item.imageUrl, origin)
    return untouched
  }
  const load = (): { data: DemoEditable; untouched: Set<string> } => {
    try {
      const raw = opts.storage?.getItem(key)
      if (raw) {
        const v = JSON.parse(raw)
        // Every list the demo keeps, or none of it: a partial store (an older shape, a hand edit) is the sample again
        if (v?.v === VERSION && v.data && EDITABLE_LISTS.every((k) => Array.isArray(v.data[k]))) {
          const data = v.data as DemoEditable
          return { data, untouched: reanchor(data, v.sampleEvents) }
        }
      }
    } catch {}
    return { data: structuredClone(editable(base)), untouched: new Set(sampleEvent.keys()) }
  }
  // Kept in memory too: a browser that refuses storage (private window, full) still gets a working demo for the visit
  const { data: state, untouched } = load()
  const save = () => {
    try { opts.storage?.setItem(key, JSON.stringify({ v: VERSION, data: state, sampleEvents: [...untouched] })) } catch {}
  }
  const write = <R>(fn: (s: DemoEditable) => R): R => {
    const out = fn(state)
    save()
    return out
  }
  const stamp = () => new Date(opts.now()).toISOString()
  const done = <R>(v: R) => Promise.resolve(structuredClone(v))
  const noLocation = (id: string) => id !== base.location.id

  const eventOf = (id: string) => state.events.find((e) => e.id === id)
  const giveawayOf = (id: string) => state.giveaways.find((g) => g.id === id)
  const giveawayView = (g: DemoGiveaway) => ({
    ...g,
    items: state.items.filter((i) => i.giveawayId === g.id),
    claimCount: state.claims.filter((c) => c.giveawayId === g.id).length,
  })
  const eventDetail = (e: DemoEvent) => ({
    ...e,
    sceneLinks: state.eventScenes.filter((l) => l.eventId === e.id)
      .map((l) => ({ ...l, scene: l.sceneId === base.scene.id ? { id: base.scene.id, name: base.scene.name } : null })),
    giveawayLinks: state.eventGiveaways.filter((l) => l.eventId === e.id).map((l) => {
      const g = giveawayOf(l.giveawayId)
      return { ...l, giveaway: g ? { id: g.id, name: g.name, enabled: g.enabled } : null }
    }),
  })

  const visitsIn = (q: AnalyticsRangeQuery) => base.visits.filter((v) => inRange(v.startedAt, q))

  const api: DemoApi = {
    // ── Analytics ─────────────────────────────────────────────────────────
    getAnalyticsLocations: () => done({ scenes: [base.location] }),
    getAnalyticsSummary: (id, q) => {
      if (noLocation(id)) return Promise.reject(notFound())
      const vs = visitsIn(q)
      const users = new Set(vs.map((v) => v.userId))
      const returning = new Set(vs.filter((v) => v.isReturning).map((v) => v.userId))
      const summary: AnalyticsSummary = {
        sessions: vs.length,
        uniqueVisitors: users.size,
        newVisitors: users.size - returning.size,
        returningVisitors: returning.size,
        peakConcurrency: Math.max(0, ...hourly(vs).map((h) => h.length)),
        dwellAvgSec: vs.length ? Math.round(vs.reduce((n, v) => n + v.durationSec, 0) / vs.length) : 0,
        verifiedShare: vs.length ? vs.filter((v) => v.verified).length / vs.length : 0,
        interactions: { click: Math.round(vs.length * 1.8), trigger: Math.round(vs.length * 0.6) },
        emotes: { wave: Math.round(vs.length * 0.5), dance: Math.round(vs.length * 0.3), clap: Math.round(vs.length * 0.2) },
        emoteLabels: {},
        countries: tally(vs.map((v) => v.country)),
        platforms: tally(vs.map((v) => v.platform)),
      }
      return done(summary)
    },
    getAnalyticsTimeseries: (id, q) => {
      if (noLocation(id)) return Promise.reject(notFound())
      const size = q.bucket === 'day' ? 86_400_000 : 3_600_000
      const buckets = new Map<number, typeof base.visits>()
      for (const v of visitsIn(q)) {
        const b = Math.floor(Date.parse(v.startedAt) / size) * size
        buckets.set(b, [...(buckets.get(b) ?? []), v])
      }
      const points: TimeseriesPoint[] = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([t, vs]) => ({
        t: new Date(t).toISOString(),
        sessions: vs.length,
        uniqueVisitors: new Set(vs.map((v) => v.userId)).size,
        peakConcurrency: Math.max(1, ...hourly(vs).map((h) => h.length)),
        dwellAvgSec: Math.round(vs.reduce((n, v) => n + v.durationSec, 0) / vs.length),
      }))
      return done({ points })
    },
    getAnalyticsHeatmap: (id, q) => {
      if (noLocation(id)) return Promise.reject(notFound())
      // The week's cells, scaled to the share of the week's visits in the range
      const share = base.visits.length ? visitsIn(q).length / base.visits.length : 0
      const cells = base.cells
        .map((c) => ({ ...c, visits: Math.round(c.visits * share), dwellSec: Math.round(c.dwellSec * share) }))
        .filter((c) => c.visits > 0)
      return done({ cells })
    },
    getAnalyticsSessions: (id, cursor) => {
      if (noLocation(id)) return Promise.reject(notFound())
      const all = [...base.visits].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      const from = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0
      const sessions: AnalyticsSession[] = all.slice(from, from + PAGE).map((v) => ({
        id: v.id, userId: v.userId, walletAddress: null, displayName: null, platform: v.platform, country: v.country,
        startedAt: v.startedAt, endedAt: v.endedAt, durationSec: v.durationSec, isReturning: v.isReturning, verified: v.verified,
      }))
      return done({ sessions, nextCursor: from + PAGE < all.length ? String(from + PAGE) : null })
    },
    getAnalyticsLive: (id) => {
      if (noLocation(id)) return Promise.reject(notFound())
      // A few visitors near the hotspots, moving a little each minute
      const minute = Math.floor(opts.now() / 60_000)
      const count = 2 + (minute % 4)
      const positions = Array.from({ length: count }, (_, i) => {
        const s = base.hotspots[i % base.hotspots.length]
        const wobble = (n: number) => ((Math.sin(minute * 1.3 + i * 7 + n) + 1) / 2) * 6 - 3
        return { x: clamp(s.x + wobble(0)), z: clamp(s.z + wobble(1)) }
      })
      return done({ count, positions })
    },

    // ── Events ────────────────────────────────────────────────────────────
    getEvents: () => done({ events: state.events }),
    getEvent: (id) => {
      const e = eventOf(id)
      if (!e) return Promise.reject(notFound())
      return done({ event: eventDetail(e), presetSchedules: [], scenePresets: [], showings: [] })
    },
    createEvent: (data) => {
      const at = stamp()
      const event: DemoEvent = {
        id: newId('event'), name: data.name, description: data.description ?? null,
        startTime: data.startTime ? new Date(data.startTime).toISOString() : null,
        endTime: data.endTime ? new Date(data.endTime).toISOString() : null,
        timezone: data.timezone || 'UTC', createdAt: at, updatedAt: at,
      }
      return done({ event: write((s) => { s.events.unshift(event); return event }) })
    },
    updateEvent: (id, data) => {
      const e = eventOf(id)
      if (!e) return Promise.reject(notFound())
      return done({
        event: write(() => {
          untouched.delete(id)
          if (data.name !== undefined) e.name = data.name
          if (data.description !== undefined) e.description = data.description
          if (data.startTime !== undefined) e.startTime = data.startTime ? new Date(data.startTime).toISOString() : null
          if (data.endTime !== undefined) e.endTime = data.endTime ? new Date(data.endTime).toISOString() : null
          if (data.timezone !== undefined) e.timezone = data.timezone
          e.updatedAt = stamp()
          return e
        }),
      })
    },
    deleteEvent: (id) => {
      if (!eventOf(id)) return Promise.reject(notFound())
      write((s) => {
        untouched.delete(id)
        s.events = s.events.filter((e) => e.id !== id)
        s.eventScenes = s.eventScenes.filter((l) => l.eventId !== id)
        s.eventGiveaways = s.eventGiveaways.filter((l) => l.eventId !== id)
      })
      return done(undefined)
    },
    linkSceneToEvent: (eventId, sceneId) => {
      if (!eventOf(eventId) || sceneId !== base.scene.id) return Promise.reject(notFound())
      const link = { eventId, sceneId }
      write((s) => { if (!s.eventScenes.some((l) => l.eventId === eventId && l.sceneId === sceneId)) s.eventScenes.push(link) })
      return done({ link })
    },
    unlinkSceneFromEvent: (eventId, sceneId) => {
      write((s) => { s.eventScenes = s.eventScenes.filter((l) => !(l.eventId === eventId && l.sceneId === sceneId)) })
      return done(undefined)
    },
    linkGiveawayToEvent: (eventId, giveawayId) => {
      if (!eventOf(eventId) || !giveawayOf(giveawayId)) return Promise.reject(notFound())
      const link = { eventId, giveawayId }
      write((s) => { if (!s.eventGiveaways.some((l) => l.eventId === eventId && l.giveawayId === giveawayId)) s.eventGiveaways.push(link) })
      return done({ link })
    },
    unlinkGiveawayFromEvent: (eventId, giveawayId) => {
      write((s) => { s.eventGiveaways = s.eventGiveaways.filter((l) => !(l.eventId === eventId && l.giveawayId === giveawayId)) })
      return done(undefined)
    },
    getScenes: () => done({ scenes: [base.scene] }),

    // ── Giveaways ─────────────────────────────────────────────────────────
    getGiveaways: () => done({ giveaways: state.giveaways.map(giveawayView) }),
    getGiveaway: (id) => {
      const g = giveawayOf(id)
      return g ? done({ giveaway: giveawayView(g) }) : Promise.reject(notFound())
    },
    createGiveaway: (data) => {
      const at = stamp()
      const g: DemoGiveaway = { id: newId('giveaway'), name: data.name, enabled: data.enabled ?? true, claimLimit: data.claimLimit ?? 1, createdAt: at, updatedAt: at }
      write((s) => { s.giveaways.unshift(g) })
      return done({ giveaway: giveawayView(g) })
    },
    updateGiveaway: (id, data) => {
      const g = giveawayOf(id)
      if (!g) return Promise.reject(notFound())
      write(() => {
        if (data.name !== undefined) g.name = data.name
        if (data.enabled !== undefined) g.enabled = data.enabled
        if (data.claimLimit !== undefined) g.claimLimit = data.claimLimit
        g.updatedAt = stamp()
      })
      return done({ giveaway: giveawayView(g) })
    },
    deleteGiveaway: (id) => {
      if (!giveawayOf(id)) return Promise.reject(notFound())
      write((s) => {
        s.giveaways = s.giveaways.filter((g) => g.id !== id)
        s.items = s.items.filter((i) => i.giveawayId !== id)
        s.claims = s.claims.filter((c) => c.giveawayId !== id)
        s.eventGiveaways = s.eventGiveaways.filter((l) => l.giveawayId !== id)
      })
      return done(undefined)
    },
    addGiveawayItem: (giveawayId, data) => {
      if (!giveawayOf(giveawayId)) return Promise.reject(notFound())
      const item = {
        id: newId('item'), giveawayId, name: data.name ?? null, imageUrl: demoImageUrl(data.imageUrl, origin),
        contractAddress: data.contractAddress ?? null, tokenId: data.tokenId ?? null, metadata: data.metadata ?? null, createdAt: stamp(),
      }
      write((s) => { s.items.push(item) })
      return done({ item })
    },
    deleteGiveawayItem: (giveawayId, itemId) => {
      write((s) => { s.items = s.items.filter((i) => !(i.giveawayId === giveawayId && i.id === itemId)) })
      return done(undefined)
    },
    getGiveawayClaims: (giveawayId) => {
      if (!giveawayOf(giveawayId)) return Promise.reject(notFound())
      const claims = state.claims.filter((c) => c.giveawayId === giveawayId).map((c) => ({
        ...c, item: (() => { const i = state.items.find((x) => x.id === c.itemId); return i ? { id: i.id, name: i.name } : null })(),
      }))
      return done({ claims })
    },
  }
  return api
}

const clamp = (v: number) => Math.max(0.5, Math.min(31.5, v))

/** Visits grouped by the hour they started in: a stand-in for "at once". */
function hourly<V extends { startedAt: string }>(vs: V[]): V[][] {
  const m = new Map<number, V[]>()
  for (const v of vs) {
    const h = Math.floor(Date.parse(v.startedAt) / 3_600_000)
    m.set(h, [...(m.get(h) ?? []), v])
  }
  return [...m.values()]
}
