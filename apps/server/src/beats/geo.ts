import type { BeatPin } from '@virvixr/shared'
import { BeatError } from './errors.js'

/** What a phone sends about where it is. Never stored: only the pass/fail decision is used. */
export interface Fix { lat: number; lng: number; accuracyM: number }

const EARTH_RADIUS_M = 6_371_000
/** A fix less accurate than this is refused; the accuracy credited to a visitor never exceeds the second figure. */
export const MAX_ACCURACY_M = 500
export const MAX_ACCURACY_CREDIT_M = 200

const rad = (d: number) => (d * Math.PI) / 180

/** Great-circle distance in metres (haversine, Earth radius 6 371 000 m). */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Whether a fix is at the venue pin. No pin: `ok` (no check). A pin needs a fix (`missing`); accuracy above 500 m is
 * `poor`; otherwise it passes when `distance - min(accuracyM, 200) <= radius`, else `outside`.
 */
export function locationCheck(pin: BeatPin | null, loc?: Fix): 'ok' | 'outside' | 'poor' | 'missing' {
  if (!pin) return 'ok'
  if (!loc) return 'missing'
  if (loc.accuracyM > MAX_ACCURACY_M) return 'poor'
  return distanceM(pin, loc) - Math.min(loc.accuracyM, MAX_ACCURACY_CREDIT_M) <= pin.radiusM ? 'ok' : 'outside'
}

/** A client's location as sent, untrusted: absent stays absent; present but out of range or not numbers is a 400. */
export function parseFix(v: unknown): Fix | undefined {
  if (v === undefined || v === null) return undefined
  const l = v as Partial<Fix>
  const bad = () => new BeatError(400, 'bad_location', 'Send your location as latitude, longitude and accuracy.')
  if (typeof v !== 'object') throw bad()
  const { lat, lng, accuracyM } = l
  if (typeof lat !== 'number' || typeof lng !== 'number' || typeof accuracyM !== 'number') throw bad()
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(accuracyM)) throw bad()
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180 || accuracyM < 0) throw bad()
  return { lat, lng, accuracyM }
}
