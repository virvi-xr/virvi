import { BEAT_LOCATION_MAX } from '@virvixr/shared'

/**
 * Suggests a venue pin from its address (Nominatim, OpenStreetMap's geocoder). The host can always drag the pin, so a
 * miss or an outage is just `null`. Nominatim's usage policy asks for a User-Agent that names us and at most one request
 * a second, so every lookup in this process waits its turn in one queue. Answers (misses too) are kept for 24 hours.
 */

export interface GeocodeParts { venue?: string; address?: string; city?: string; country: string }
export interface GeoPoint { lat: number; lng: number }
export type GeocodeFetcher = typeof fetch

const ENDPOINT = 'https://nominatim.openstreetmap.org/search'
const USER_AGENT = 'Virvi/1.0 (+https://virvi.io)'
const TIMEOUT_MS = 5000
const SPACING_MS = 1000
const CACHE_MS = 24 * 3_600_000
const CACHE_MAX = 1000

const cache = new Map<string, { at: number; point: GeoPoint | null }>()
let tail: Promise<unknown> = Promise.resolve()
let lastStartedAt = -Infinity

/** Forgets the cache and the queue's clock (tests). */
export function resetGeocoder(): void {
  cache.clear()
  tail = Promise.resolve()
  lastStartedAt = -Infinity
}

const normalise = (q: string) => q.toLowerCase().replace(/\s+/g, ' ').trim()

/** Runs `job` once every earlier lookup has started and a second has passed since the last one did. */
function queued<T>(job: () => Promise<T>): Promise<T> {
  const run = tail.then(async () => {
    const wait = lastStartedAt + SPACING_MS - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastStartedAt = Date.now()
    return job()
  })
  tail = run.catch(() => {})
  return run
}

function parsePoint(body: unknown): GeoPoint | null {
  const first = Array.isArray(body) ? (body[0] as { lat?: unknown; lon?: unknown } | undefined) : undefined
  if (!first) return null
  const lat = Number(first.lat)
  const lng = Number(first.lon)
  if (typeof first.lat !== 'string' || typeof first.lon !== 'string' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  return { lat, lng }
}

/** One query: the cache, else the queue and the geocoder. Throws when the geocoder can't be reached (not cached). */
async function lookup(query: string, fetcher: GeocodeFetcher): Promise<GeoPoint | null> {
  const key = normalise(query)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.point
  const point = await queued(async () => {
    const url = `${ENDPOINT}?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`
    const res = await fetcher(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new Error(`geocoder answered ${res.status}`)
    return parsePoint(await res.json())
  })
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!)
  cache.set(key, { at: Date.now(), point })
  return point
}

const join = (...parts: (string | undefined)[]) => parts.map((p) => p?.trim()).filter(Boolean).join(', ')

/** The address's point; if the address alone finds nothing, the venue's name in the same city. Null when unknown. */
export async function geocodeAddress(parts: GeocodeParts, fetcher: GeocodeFetcher = fetch): Promise<GeoPoint | null> {
  const queries: string[] = []
  if (parts.address?.trim()) queries.push(join(parts.address, parts.city, parts.country))
  if (parts.venue?.trim()) queries.push(join(parts.venue, parts.city, parts.country))
  try {
    for (const q of queries) {
      const point = await lookup(q, fetcher)
      if (point) return point
    }
  } catch {
    return null
  }
  return null
}

/** The geocode route's body: text parts within the location limits, a country, and an address or a venue. */
export function parseGeocodeBody(v: unknown): GeocodeParts | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const text = (x: unknown, max: number): string | undefined | null => {
    if (x === undefined || x === null) return undefined
    if (typeof x !== 'string' || [...x.trim()].length > max) return null
    return x.trim() || undefined
  }
  const venue = text(o.venue, BEAT_LOCATION_MAX.venue)
  const address = text(o.address, BEAT_LOCATION_MAX.address)
  const city = text(o.city, BEAT_LOCATION_MAX.city)
  const country = text(o.country, BEAT_LOCATION_MAX.country)
  if (venue === null || address === null || city === null || country === null || !country || (!venue && !address)) return null
  return { venue, address, city, country }
}
