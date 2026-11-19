import type { EventAttendanceReport, EventAttendee } from '@virvixr/shared'

export const ATTENDEE_CAP = 5000

export interface AttendanceSession {
  location: string
  /** Groups a visitor's sessions; per-location already, since visitor hashes are salted per location. */
  visitorKey: string
  visitorId: string
  displayName: string | null
  wallet: string | null
  verified: boolean
  isGuest: boolean
  startedAt: Date
  /** endedAt, or lastSeenAt for a session still open or closed by the sweep. */
  endAt: Date
}

/**
 * Attendance in [from, to): each session is clipped to the window, a visitor's overlapping sessions are merged so
 * reconnects aren't counted twice, and peak concurrency comes from a sweep over the clipped sessions. Pure.
 */
export function eventAttendance(from: Date, to: Date, sessions: AttendanceSession[], locations: number): EventAttendanceReport {
  const lo = from.getTime()
  const hi = to.getTime()
  const byVisitor = new Map<string, { s: AttendanceSession; spans: Array<[number, number]> }>()
  const edges: Array<[number, number]> = []
  for (const s of sessions) {
    const a = Math.max(s.startedAt.getTime(), lo)
    const b = Math.min(Math.max(s.endAt.getTime(), s.startedAt.getTime()), hi)
    if (b < a || (b === a && s.startedAt.getTime() >= hi)) continue
    const key = `${s.location}\u0000${s.visitorKey}`
    let v = byVisitor.get(key)
    if (!v) byVisitor.set(key, (v = { s: { ...s }, spans: [] }))
    else {
      // Keep the most identifying details seen across their sessions
      v.s.displayName ??= s.displayName
      v.s.wallet ??= s.wallet
      v.s.verified ||= s.verified
      v.s.isGuest &&= s.isGuest
    }
    v.spans.push([a, b])
  }

  const attendees: EventAttendee[] = []
  for (const { s, spans } of byVisitor.values()) {
    spans.sort((x, y) => x[0] - y[0])
    let total = 0
    let [cs, ce] = spans[0]
    for (const [a, b] of spans.slice(1)) {
      if (a <= ce) ce = Math.max(ce, b)
      else {
        total += ce - cs
        edges.push([cs, ce])
        ;[cs, ce] = [a, b]
      }
    }
    total += ce - cs
    edges.push([cs, ce])
    attendees.push({
      visitorId: s.visitorId,
      location: s.location,
      displayName: s.displayName,
      wallet: s.wallet,
      verified: s.verified,
      isGuest: s.isGuest,
      firstSeenAt: new Date(spans[0][0]).toISOString(),
      secondsPresent: Math.round(total / 1000),
    })
  }

  // Peak: +1 at each merged span's start, -1 at its end; ends sort before starts at the same instant.
  const points = edges.filter(([a, b]) => b > a).flatMap(([a, b]) => [[a, 1], [b, -1]] as Array<[number, number]>).sort((x, y) => x[0] - y[0] || x[1] - y[1])
  let now = 0
  let peak = 0
  for (const [, d] of points) peak = Math.max(peak, (now += d))
  // A visitor seen at a single instant still counts as present
  if (!peak && attendees.length) peak = 1

  attendees.sort((x, y) => y.secondsPresent - x.secondsPresent || x.firstSeenAt.localeCompare(y.firstSeenAt))
  const totalSeconds = attendees.reduce((n, a) => n + a.secondsPresent, 0)
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    locations,
    totals: {
      visitors: attendees.length,
      verifiedVisitors: attendees.filter((a) => a.verified).length,
      peakConcurrent: peak,
      avgSecondsPresent: attendees.length ? Math.round(totalSeconds / attendees.length) : 0,
    },
    attendees: attendees.slice(0, ATTENDEE_CAP),
    truncated: attendees.length > ATTENDEE_CAP,
  }
}
