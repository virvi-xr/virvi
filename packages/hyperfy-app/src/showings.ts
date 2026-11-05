/**
 * Scheduled showings on a Hyperfy screen (LIV-87): what a Schedule-mode screen shows at a moment of Virvi's clock, and
 * when to move its video to where the shared show is. Plain functions; app.ts drives them from its screen check.
 */
import { needsResync, screenStateAt, type ShowingInstance } from '@virvixr/shared'

export type ScheduledView =
  | { key: string; type: 'video'; src: string; /** Seconds into the video. */ offset: number; duration: number }
  | { key: string; type: 'image'; src: string }
  | { key: string; type: 'none' }

/**
 * What the screen shows at Virvi time `now` (UTC ms): the programme's video, or the holding image (nothing when it has
 * none) between showings. `key` changes whenever the picture must change.
 */
export function scheduledView(showings: ShowingInstance[], now: number, holdingImage: string): ScheduledView {
  const state = screenStateAt(showings, now)
  if (state.mode === 'playing') {
    const { showing, index, item, offset } = state
    return { key: `${showing.showingId}@${showing.startsAt}#${index}:${item.url}`, type: 'video', src: item.url, offset, duration: item.duration }
  }
  const key = `between:${holdingImage}`
  return holdingImage ? { key, type: 'image', src: holdingImage } : { key, type: 'none' }
}

/**
 * Virvi's clock minus the world's shared clock, in ms. The world server works it out when a feed answer arrives and
 * passes it on, so every visitor reads Virvi time as `world.getTime() * 1000 + offset`, whatever their own clock says.
 */
export function virviClockOffset(serverTimeMs: number, worldTimeS: number): number {
  return serverTimeMs - worldTimeS * 1000
}

/** The same guards as Decentraland's drift correction (packages/core VideoManager). */
export const SHOWING_DRIFT_CHECK_MS = 5_000
export const SHOWING_SETTLE_MS = 30_000
export const SHOWING_MAX_RESEEKS = 3
export const SHOWING_MIN_LEFT_S = 10

export interface SeekState {
  /** The first seek (once the video has loaded) is done. */
  seeked: boolean
  seekAt: number
  checkAt: number
  /** Re-seeks after the first. */
  seeks: number
}
export const newSeekState = (): SeekState => ({ seeked: false, seekAt: 0, checkAt: 0, seeks: 0 })

/**
 * Whether to set the video's time to `expected` now (and records it). The first seek waits until the video has loaded
 * (Hyperfy ignores a time set before then). After that a player that has slipped more than 2 s is moved back, at most
 * every 5 s, 30 s after its last seek, 3 times per video, and never in a video's last 10 s.
 */
export function seekAction(
  st: SeekState,
  now: number,
  expected: number,
  duration: number,
  video: { playing?: boolean; time?: number; duration?: number },
): boolean {
  if (!st.seeked) {
    if (!(typeof video.duration === 'number' && video.duration > 0)) return false
    st.seeked = true
    st.seekAt = now
    return true
  }
  if (video.playing !== true || typeof video.time !== 'number') return false
  if (now - st.checkAt < SHOWING_DRIFT_CHECK_MS || now - st.seekAt < SHOWING_SETTLE_MS) return false
  if (st.seeks >= SHOWING_MAX_RESEEKS || duration - expected < SHOWING_MIN_LEFT_S) return false
  st.checkAt = now
  if (!needsResync(expected, video.time)) return false
  st.seeks++
  st.seekAt = now
  return true
}
