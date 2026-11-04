/**
 * Scheduled showings on a video screen (LIV-87): everyone works out the same moment of the same video from the show's
 * start instant and the server's clock, so a visitor who walks in mid-film joins where everyone else is.
 *
 * Start instants are UTC milliseconds. The server expands a showing's local time, timezone and repetition into them
 * (daylight-saving changes included); everything here is plain arithmetic on those instants.
 */

export interface ProgrammeItem {
  url: string
  /** Seconds. Items without a positive length take no time and are never played. */
  duration: number
  /** 'ad': an ad slot before the feature. Ads never go after the feature. */
  kind?: 'video' | 'ad'
}

export interface ShowingInstance {
  showingId: string
  /** UTC ms. */
  startsAt: number
  items: ProgrammeItem[]
  title?: string
  posterUrl?: string
}

export type ScreenState =
  | {
      mode: 'playing'
      showing: ShowingInstance
      item: ProgrammeItem
      index: number
      /** Seconds into `item`: seek here. */
      offset: number
      /** Seconds since the showing started ("Started 12 minutes ago"). */
      elapsed: number
      /** UTC ms. */
      endsAt: number
      next: ShowingInstance | null
    }
  | {
      mode: 'between'
      next: ShowingInstance | null
      /** Seconds until `next` starts, or null with nothing scheduled. */
      startsIn: number | null
    }

const playable = (d: number) => Number.isFinite(d) && d > 0

/** Seconds a programme runs. */
export function programmeLength(items: ProgrammeItem[]): number {
  return items.reduce((sum, i) => sum + (playable(i.duration) ? i.duration : 0), 0)
}

/** Which item plays `elapsed` seconds into a programme, and how far into it; null before the start or from the end. */
export function positionAt(items: ProgrammeItem[], elapsed: number): { index: number; offset: number } | null {
  if (!(elapsed >= 0)) return null
  let start = 0
  for (let index = 0; index < items.length; index++) {
    const d = items[index].duration
    if (!playable(d)) continue
    if (elapsed < start + d) return { index, offset: elapsed - start }
    start += d
  }
  return null
}

const endOf = (s: ShowingInstance) => s.startsAt + programmeLength(s.items) * 1000

/** What a scheduled screen shows at server time `now` (UTC ms). If showings overlap, the later start wins. */
export function screenStateAt(showings: ShowingInstance[], now: number): ScreenState {
  const sorted = [...showings].sort((a, b) => a.startsAt - b.startsAt)
  const nextAfter = (t: number) => sorted.find((s) => s.startsAt > t) ?? null
  for (let i = sorted.length - 1; i >= 0; i--) {
    const showing = sorted[i]
    if (showing.startsAt > now) continue
    const elapsed = (now - showing.startsAt) / 1000
    const pos = positionAt(showing.items, elapsed)
    if (!pos) break // the most recent showing has ended
    return {
      mode: 'playing', showing, item: showing.items[pos.index], index: pos.index, offset: pos.offset, elapsed,
      endsAt: endOf(showing), next: nextAfter(showing.startsAt),
    }
  }
  const next = nextAfter(now)
  return { mode: 'between', next, startsIn: next ? (next.startsAt - now) / 1000 : null }
}

/** Pairs of showing ids where the second starts before the first has ended, in start order. Back to back is fine. */
export function findShowingOverlaps(showings: ShowingInstance[]): Array<[string, string]> {
  const sorted = [...showings].sort((a, b) => a.startsAt - b.startsAt)
  const out: Array<[string, string]> = []
  for (let i = 0; i < sorted.length; i++) {
    const end = endOf(sorted[i])
    for (let j = i + 1; j < sorted.length && sorted[j].startsAt < end; j++) out.push([sorted[i].showingId, sorted[j].showingId])
  }
  return out
}

/** Server time from the local clock and the measured offset (server minus local, ms), e.g. from the room connection. */
export function serverNow(localNow: number, offsetMs: number): number {
  return localNow + offsetMs
}

/** Seconds a player may drift from where it should be before it re-seeks. */
export const SHOWING_DRIFT_TOLERANCE_S = 2

/** True when a player at `actual` seconds should re-seek to `expected`. */
export function needsResync(expected: number, actual: number, toleranceS = SHOWING_DRIFT_TOLERANCE_S): boolean {
  return Math.abs(expected - actual) > toleranceS
}

/** Seconds the film's name stays up once the feature starts. */
export const NOW_SHOWING_S = 15

const until = (seconds: number): string => {
  const s = Math.max(0, Math.ceil(seconds))
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  if (s < 86_400) {
    const m = Math.ceil(s / 60)
    return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`
  }
  const d = Math.floor(s / 86_400)
  return `${d} ${d === 1 ? 'day' : 'days'}`
}

/**
 * The line a scheduled screen shows over its picture, or null for none: a countdown on the holding image, a countdown
 * to the feature during the ads before it, and the film's name for its first seconds. Nothing over the film after that.
 */
export function showingSign(state: ScreenState): string | null {
  if (state.mode === 'between') {
    if (!state.next || state.startsIn === null) return null
    const title = state.next.title?.trim()
    return `${title ? `Next: ${title}` : 'Next showing'}\nin ${until(state.startsIn)}`
  }
  const items = state.showing.items
  const feature = items.findIndex((i) => i.kind !== 'ad' && playable(i.duration))
  if (feature < 0) return null
  const title = state.showing.title?.trim()
  if (state.index < feature) {
    let left = state.item.duration - state.offset
    for (let i = state.index + 1; i < feature; i++) if (playable(items[i].duration)) left += items[i].duration
    return `${title || 'The film'} starts in ${until(left)}`
  }
  if (state.index === feature && title && state.offset < NOW_SHOWING_S) return `Now showing: ${title}`
  return null
}
