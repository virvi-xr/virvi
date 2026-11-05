/**
 * The HUD's Stream panel (LIV-53): the live preset's video screens, the scene's streams they can play, and wording.
 * Pure (no @dcl/sdk), so it is unit-tested. Mirrors the dashboard (apps/web src/lib/streams.ts).
 */

/** A stream as GET /api/scenes/:sceneId/streams lists it (never the stream key). */
export interface HUDStream { id: string; name: string; hlsPlaylistUrl: string; live: boolean; mine: boolean }

export interface HUDScreen { id: string; name: string; liveSrc: string; liveOn: boolean }

export function screensFromPreset(preset: { elements?: any[] } | null | undefined): HUDScreen[] {
  return (preset?.elements ?? [])
    .filter((el) => el?.type === 'video')
    .map((el) => ({
      id: String(el.id),
      name: el.name || 'Video screen',
      liveSrc: typeof el.properties?.liveSrc === 'string' ? el.properties.liveSrc.trim() : '',
      liveOn: el.properties?.enableLiveStream === true,
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
