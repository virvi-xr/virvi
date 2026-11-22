import { parseRingCode, ringCodeOf } from '@virvixr/shared'
import type { ArMarkerView, ArSpaceView } from '@virvixr/shared'

export const AR_MIN_DIAMETER_MM = 60
export const AR_MAX_DIAMETER_MM = 256
export const AR_DEFAULT_DIAMETER_MM = 140

export type ArFileFormat = 'stl-base' | 'stl-raised' | '3mf' | 'pdf' | 'svg'
export type ArMounting = 'none' | 'tape' | 'magnets' | 'screws' | 'keyhole'
/** Black marks on a white plaque, or white marks on a black one (print files only). */
export type ArMarkerStyle = 'normal' | 'inverted'

/** The line under the download buttons: which filament goes first depends on the marker style. */
export function printHint(style: ArMarkerStyle): string {
  const order = style === 'inverted' ? 'Start with dark filament and change to light at 4.0 mm.' : 'Start with light filament and change to dark at 4.0 mm.'
  return `Print at 100%. ${order} Matte filament works best.`
}

/** A marker is aligned once the headset has stored its pose. */
export function alignmentStatus(m: ArMarkerView): 'not_aligned' | 'aligned' {
  return m.pose ? 'aligned' : 'not_aligned'
}

/** What a space still needs before visitors can use it. Publishing is allowed regardless; the UI says what is missing. */
export function spaceReadiness(s: ArSpaceView): { ok: boolean; missing: Array<'marker' | 'alignment'> } {
  const markers = s.floors.flatMap((f) => f.markers)
  const missing: Array<'marker' | 'alignment'> = []
  if (markers.length === 0) missing.push('marker')
  else if (markers.some((m) => alignmentStatus(m) === 'not_aligned')) missing.push('alignment')
  return { ok: missing.length === 0, missing }
}

/** What a size change costs: the ring must be printed again, and aligned again if it already was. */
export function resizeNote(m: ArMarkerView): string {
  return alignmentStatus(m) === 'aligned'
    ? 'Changing the size means reprinting this ARC and aligning it again.'
    : 'Changing the size means reprinting this ARC.'
}

export const shareUrl = (code: string): string => `https://virvi.io/s/${code}`

/** The ring code in a /s/<code> address, normalised; null when the last segment isn't a valid code (or is the static placeholder). */
export function spaceCodeFromPath(path: string): string | null {
  const last = path.split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? ''
  let decoded = last
  try { decoded = decodeURIComponent(last) } catch { /* keep the raw segment */ }
  const id = parseRingCode(decoded)
  return id === null ? null : ringCodeOf(id)
}

const ERRORS: Record<string, string> = {
  no_access: "You don't have access to build AR spaces in this scene.",
  bad_diameter: 'Size must be between 60 and 256 mm.',
  last_floor: "A space needs at least one floor: you can't remove the last floor.",
  bad_request: "Something in that entry isn't valid",
  not_found: 'That item no longer exists. Reload the page.',
  no_room_for_screws: 'Not enough room for screw holes at this size: pick another mounting',
  too_large_for_paper: 'Too big for Letter paper at 100%: use the 3D print files',
}

export const friendlyArError = (code: string): string => ERRORS[code] ?? (code || 'Something went wrong')

const REPORT_REASONS: Record<string, string> = { offensive: 'Offensive', unsafe: 'Unsafe', spam: 'Spam', other: 'Something else' }

/** What a visitor picked in the headset's "Report this space", as the admin page names it. */
export const reportReasonLabel = (reason: string): string => REPORT_REASONS[reason] ?? reason
