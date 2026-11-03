/** A live stream a video screen can play, as GET /api/scenes/:sceneId/streams lists it (never the stream key). */
export interface SceneStream {
  id: string
  name: string
  hlsPlaylistUrl: string
  live: boolean
  mine: boolean
}

/** The Virvi stream behind a screen's live source, or null for a custom URL (or none). */
export function streamForSource(src: string | undefined, streams: SceneStream[] | null): SceneStream | null {
  const url = src?.trim()
  if (!url || !streams) return null
  return streams.find((s) => s.hlsPlaylistUrl === url) ?? null
}

/** How a stream reads in the picker: "Main Stage (live)", "Editor Cam (offline, yours)". */
export function streamOptionLabel(s: SceneStream): string {
  return `${s.name} (${s.live ? 'live' : 'offline'}${s.mine ? ', yours' : ''})`
}
