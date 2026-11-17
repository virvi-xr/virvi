// Which event the Command Center opens on.

type PickableEvent = { id: string; startTime?: string | null; endTime?: string | null; createdAt?: string | null }

/** An event with a start but no end counts as live only for its first day, so an old event nobody closed can't keep winning. */
export const OPEN_ENDED_LIVE_MS = 24 * 60 * 60 * 1000

/** Live right now: its start has passed and its end hasn't (or it has no end and started within the last day). */
export function isOngoing(e: PickableEvent, now = Date.now()): boolean {
  const start = e.startTime ? Date.parse(e.startTime) : NaN
  if (Number.isNaN(start) || start > now) return false
  const end = e.endTime ? Date.parse(e.endTime) : NaN
  return Number.isNaN(end) ? now - start <= OPEN_ENDED_LIVE_MS : end >= now
}

/**
 * The event to open: the one the link names if the account has it, otherwise the longest-running live event
 * (earliest start, then earliest created), otherwise none ('').
 */
export function initialEventId(events: PickableEvent[], linked: string | null, now = Date.now()): string {
  if (linked && events.some((e) => e.id === linked)) return linked
  const time = (iso?: string | null) => (iso ? Date.parse(iso) : Infinity)
  const live = events.filter((e) => isOngoing(e, now))
    .sort((a, b) => time(a.startTime) - time(b.startTime) || time(a.createdAt) - time(b.createdAt))
  return live[0]?.id ?? ''
}
