import { CHECKIN_CAP_SECONDS, CHECKIN_MIN_GAP_MS, PRESENT_WINDOW_MS } from '@virvixr/shared'

/**
 * Attendance by check-in, shared by raffles (LIV-55) and BEAT. Pure: callers apply the result in an SQL update.
 * A check-in closer than CHECKIN_MIN_GAP_MS to the last is refused; otherwise the gap since the last counts as time
 * present, up to CHECKIN_CAP_SECONDS (so a client that went quiet earns no more than one interval).
 */
export function checkInDelta(lastSeenAt: Date | null, now: Date): { accepted: boolean; addSeconds: number } {
  if (!lastSeenAt) return { accepted: true, addSeconds: 0 }
  const gap = now.getTime() - lastSeenAt.getTime()
  if (gap < CHECKIN_MIN_GAP_MS) return { accepted: false, addSeconds: 0 }
  return { accepted: true, addSeconds: Math.min(Math.floor(gap / 1000), CHECKIN_CAP_SECONDS) }
}

/** Present now: checked in within PRESENT_WINDOW_MS and has been present at least minSeconds in all. */
export function isPresent(row: { lastSeenAt: Date | null; secondsPresent: number }, now: Date, minSeconds: number): boolean {
  if (!row.lastSeenAt) return false
  return now.getTime() - row.lastSeenAt.getTime() <= PRESENT_WINDOW_MS && row.secondsPresent >= minSeconds
}
