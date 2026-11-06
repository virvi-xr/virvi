// A scene's thumbnail (LIV-88): the 16:9 crop the dashboard makes before uploading, and its messages.
// The server checks the result again (apps/server/src/scenes/thumbnail.ts).
import { SCENE_THUMBNAIL_MAX, SCENE_THUMBNAIL_MAX_BYTES, SCENE_THUMBNAIL_MIN, SCENE_THUMBNAIL_RATIO } from '@virvixr/shared'

export { SCENE_THUMBNAIL_MAX_BYTES, SCENE_THUMBNAIL_MIN }

/** Where the crop sits: zoom ≥ 1 (1 = the largest 16:9 window), x/y 0 (left/top) to 1 (right/bottom). */
export interface CropPosition {
  zoom: number
  x: number
  y: number
}

export const CENTRED: CropPosition = { zoom: 1, x: 0.5, y: 0.5 }

/** Picked files over this aren't read at all (the uploaded crop must still be at most 2 MB). */
export const PICK_MAX_BYTES = 25 * 1024 * 1024
const PICK_TYPES = ['image/png', 'image/jpeg', 'image/webp']

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** The largest 16:9 window inside a w × h image. */
function fullWindow(w: number, h: number) {
  const sw = Math.min(w, h * SCENE_THUMBNAIL_RATIO)
  return { sw, sh: sw / SCENE_THUMBNAIL_RATIO }
}

/** The source rectangle of the crop, always inside the image. */
export function cropRect(w: number, h: number, pos: CropPosition): { sx: number; sy: number; sw: number; sh: number } {
  const full = fullWindow(w, h)
  const zoom = clamp(pos.zoom, 1, maxZoom(w, h))
  const sw = Math.round(full.sw / zoom)
  const sh = Math.round(full.sh / zoom)
  return { sx: (w - sw) * clamp(pos.x, 0, 1), sy: (h - sh) * clamp(pos.y, 0, 1), sw, sh }
}

/** How far the crop may zoom in and still be at least 960 × 540. */
export function maxZoom(w: number, h: number): number {
  return Math.max(1, fullWindow(w, h).sw / SCENE_THUMBNAIL_MIN.width)
}

/** True when even the largest 16:9 window is under 960 × 540. */
export function sourceTooSmall(w: number, h: number): boolean {
  const full = fullWindow(w, h)
  return Math.round(full.sw) < SCENE_THUMBNAIL_MIN.width || Math.round(full.sh) < SCENE_THUMBNAIL_MIN.height
}

/** The size the crop is saved at: its own, scaled down to at most 1920 × 1080. */
export function outputSize(crop: { sw: number; sh: number }): { width: number; height: number } {
  const width = Math.min(SCENE_THUMBNAIL_MAX.width, Math.round(crop.sw))
  return { width, height: Math.round(width / SCENE_THUMBNAIL_RATIO) }
}

/** What the crop is saved as: JPEG stays JPEG, anything else PNG (Decentraland shows PNG and JPEG). */
export function outputType(sourceType: string): 'image/jpeg' | 'image/png' {
  return sourceType === 'image/jpeg' ? 'image/jpeg' : 'image/png'
}

/** Why a picked file can't be used, before it is read; null when it can. */
export function pickedFileError(file: { type: string; size: number }): string | null {
  if (!PICK_TYPES.includes(file.type)) return 'Use a PNG, JPEG or WebP image.'
  if (file.size > PICK_MAX_BYTES) return `The file is over ${PICK_MAX_BYTES / (1024 * 1024)} MB. Use a smaller image.`
  return null
}

export const TOO_SMALL_MESSAGE = `The image must be at least ${SCENE_THUMBNAIL_MIN.width} × ${SCENE_THUMBNAIL_MIN.height} px once cropped to 16:9. Use a bigger image.`
export const TOO_LARGE_MESSAGE = `The image is over ${SCENE_THUMBNAIL_MAX_BYTES / (1024 * 1024)} MB. Use a smaller file.`

/** The server's own words for a failed upload or removal. */
export function thumbnailError(err: unknown): string {
  const e = err as { message?: string; status?: number; body?: { message?: unknown; code?: unknown } } | null
  // Fastify's body limit on the route (its own wording is about the request, not the image)
  if (e?.status === 413 && e.body?.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return TOO_LARGE_MESSAGE
  if (e?.body && typeof e.body.message === 'string' && e.body.message) return e.body.message
  if (e?.status === 403) return "Only the scene's hosts and editors can change its thumbnail."
  // A body-size refusal before the server's own check (a proxy's 413 page)
  if (e?.status === 413 || e?.message === 'too_large') return TOO_LARGE_MESSAGE
  return 'Something went wrong. Try again in a moment.'
}
