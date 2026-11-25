// An in-person BEAT's venue pin: when to suggest it from the address, the radius, and the host's ARC download choices.
import { BEAT_PIN_RADIUS } from '@virvixr/shared'

export interface LatLng { lat: number; lng: number }
export interface AddressParts { venue?: string; address?: string; city?: string; country?: string }
export type AddressWithPin = AddressParts & { pin: LatLng | null }

export const PIN_COPY = {
  suggested: "Suggested from the address. Drag it to the entrance if it's off.",
  failed: "Couldn't find that address on the map. Drop the pin yourself.",
  button: 'Suggest from address',
  clear: 'Clear pin',
} as const

export const ARC_PRINT_COPY = (venue: string) =>
  `Print this ARC and put it up at ${venue}. Visitors scan it with the Virvi app to earn this BEAT.`

/** The server's `style` values, as the host reads them. */
export const ARC_STYLES = [
  { value: 'normal', label: 'Black on white' },
  { value: 'inverted', label: 'White on black' },
] as const
export type ArcStyle = (typeof ARC_STYLES)[number]['value']

/** A country plus a street or a city: enough for the address lookup to mean something. */
export function addressComplete(l: AddressParts): boolean {
  return !!l.country?.trim() && (!!l.address?.trim() || !!l.city?.trim())
}

/** True once: the address has just become complete, no pin is set, and no suggestion has run yet. */
export function shouldAutoSuggest(prev: AddressWithPin, next: AddressWithPin, alreadySuggested: boolean): boolean {
  return !alreadySuggested && !next.pin && !addressComplete(prev) && addressComplete(next)
}

/** The radius in metres: 50 to 1000, whole metres; anything that isn't a number is the default. */
export function clampRadius(n: number): number {
  if (!Number.isFinite(n)) return BEAT_PIN_RADIUS.defaultM
  return Math.min(BEAT_PIN_RADIUS.maxM, Math.max(BEAT_PIN_RADIUS.minM, Math.round(n)))
}

/** A longitude in -180..180 (a map panned past the date line reports one beyond it). */
export function wrapLng(lng: number): number {
  if (!Number.isFinite(lng) || (lng >= -180 && lng <= 180)) return lng // in range: untouched, so no rounding drift
  return ((((lng + 180) % 360) + 360) % 360) - 180
}

/** The `pin` of the create/update body, or null. */
export function pinBody(pin: LatLng | null, radiusM: number): { lat: number; lng: number; radiusM: number } | null {
  return pin ? { lat: pin.lat, lng: wrapLng(pin.lng), radiusM: clampRadius(radiusM) } : null
}

/** The server makes an ARC only for an in-person BEAT that is paid, live or ended (else 409 `no_arc`). */
export function arcAvailable(b: { status: string; location: { type: string } }): boolean {
  return b.location.type === 'in_person' && (b.status === 'paid' || b.status === 'live' || b.status === 'ended')
}
