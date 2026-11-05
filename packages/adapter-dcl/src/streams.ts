/**
 * The HUD's Stream panel (LIV-53): the live preset's video screens, the scene's streams they can play, and wording.
 * Pure (no @dcl/sdk), so it is unit-tested. Mirrors the dashboard (apps/web src/lib/streams.ts).
 */

/** A stream as GET /api/scenes/:sceneId/streams lists it (never the stream key). */
export interface HUDStream { id: string; name: string; hlsPlaylistUrl: string; live: boolean; mine: boolean }

import type { SceneLibraryItemData } from '@virvixr/shared'

/**
 * `offImageSrc` is the image the screen shows when nothing plays (LIV-54); '' for none. `scheduled`: the screen is
 * in Schedule mode (offType 6) and plays its showings (LIV-87).
 */
export interface HUDScreen { id: string; name: string; liveSrc: string; liveOn: boolean; offImageSrc: string; scheduled: boolean }

/** An image from the scene library that can be a screen's off image. */
export interface HUDImage { id: string; name: string; url: string }

export function screensFromPreset(preset: { elements?: any[] } | null | undefined): HUDScreen[] {
  return (preset?.elements ?? [])
    .filter((el) => el?.type === 'video')
    .map((el) => ({
      id: String(el.id),
      name: el.name || 'Video screen',
      liveSrc: typeof el.properties?.liveSrc === 'string' ? el.properties.liveSrc.trim() : '',
      liveOn: el.properties?.enableLiveStream === true,
      offImageSrc: typeof el.properties?.offImageSrc === 'string' ? el.properties.offImageSrc.trim() : '',
      scheduled: el.properties?.offType === 6,
    }))
}

/** "Main Stage (live)", "Editor Cam (offline, yours)". */
export const streamOptionLabel = (s: HUDStream) => `${s.name} (${s.live ? 'live' : 'offline'}${s.mine ? ', yours' : ''})`

/** What a screen's live source is: one of the scene's streams, a link pasted elsewhere, or nothing. */
export function screenSourceLabel(screen: Pick<HUDScreen, 'liveSrc'>, streams: HUDStream[]): string {
  if (!screen.liveSrc) return 'No stream'
  const s = streams.find((x) => x.hlsPlaylistUrl === screen.liveSrc)
  return s ? streamOptionLabel(s) : 'Custom link'
}

/** The element's properties with a new live source; PUT /api/elements replaces properties whole. */
export function withLiveSource(properties: Record<string, unknown> | null | undefined, url: string): Record<string, unknown> {
  return { ...(properties ?? {}), liveSrc: url }
}

/** Image types a Decentraland texture can show (as the Assets panel places). */
const OFF_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** The scene library's ready images, for the off image list. */
export function offImageChoices(items: SceneLibraryItemData[]): HUDImage[] {
  return items
    .filter((a) => a.status === 'ready' && !!a.url && a.kind === 'media' && !!a.contentType && OFF_IMAGE_TYPES.has(a.contentType))
    .map((a) => ({ id: a.id, name: a.name, url: a.url }))
}

/** "Off image: Poster.png", by its library name as the dashboard shows it. */
export function offImageLabel(screen: Pick<HUDScreen, 'offImageSrc'>, images: HUDImage[]): string {
  if (!screen.offImageSrc) return 'No off image'
  const img = images.find((i) => i.url === screen.offImageSrc)
  return `Off image: ${img ? img.name : 'from a link'}`
}

/**
 * The element's properties with a new off image ('' clears it). Cleared to '' rather than dropped, since the
 * in-world update only applies keys that are present.
 */
export function withOffImage(properties: Record<string, unknown> | null | undefined, url: string): Record<string, unknown> {
  return { ...(properties ?? {}), offImageSrc: url }
}
