/**
 * Wall-clock schedules in a timezone (LIV-86). A schedule is a local date and time ("19:00 from 2026-03-06, daily, in
 * America/New_York"), so its instants are worked out per occurrence: 7pm stays 7pm across daylight-saving changes.
 * Only what's asked for is computed; nothing is stored ahead of time.
 */

export type Recurrence = 'once' | 'daily' | 'weekly'

export interface ScheduleSpec {
  recurrence: Recurrence
  /** YYYY-MM-DD: the one-off date, or the first day a repeating schedule can run. */
  startDate: string
  /** HH:MM, 24-hour, local to `timezone`. */
  startTime: string
  /** Weekly only: 0 = Sunday … 6 = Saturday. */
  weekdays: number[]
  /** null: stays live until the next schedule or a manual switch. */
  durationMinutes: number | null
  timezone: string
}

export interface Occurrence { start: Date; end: Date | null }

const DAY = 86_400_000
const fmt = new Map<string, Intl.DateTimeFormat>()

export function isTimeZone(tz: string): boolean {
  if (!tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** The timezone's offset from UTC at an instant, in ms (positive east of Greenwich). */
function offsetAt(instant: number, tz: string): number {
  let f = fmt.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    fmt.set(tz, f)
  }
  const p = Object.fromEntries(f.formatToParts(new Date(instant)).map((x) => [x.type, x.value]))
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
  return wall - Math.floor(instant / 1000) * 1000
}

/**
 * The instant a local date and time happens in `tz`. A time skipped by a spring-forward change lands just after the
 * gap (02:30 → 03:30); a repeated autumn hour uses its first occurrence.
 */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  const wall = Date.UTC(y, m - 1, d, hh, mm)
  const first = wall - offsetAt(wall, tz)
  const second = wall - offsetAt(first, tz)
  if (first === second) return new Date(first)
  // Offsets differ around a change: take the earlier instant that reads as this wall time, else (a gap) the later one
  const candidates = [first, second].sort((a, b) => a - b)
  for (const c of candidates) if (c + offsetAt(c, tz) === wall) return new Date(c)
  return new Date(Math.max(first, second))
}

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** The local calendar date of an instant in `tz`. */
function localDate(instant: Date, tz: string): string {
  return ymd(instant.getTime() + offsetAt(instant.getTime(), tz))
}

function occurrenceOn(spec: ScheduleSpec, date: string): Occurrence {
  const start = zonedToUtc(date, spec.startTime, spec.timezone)
  return { start, end: spec.durationMinutes == null ? null : new Date(start.getTime() + spec.durationMinutes * 60_000) }
}

function runsOn(spec: ScheduleSpec, date: string): boolean {
  if (date < spec.startDate) return false
  if (spec.recurrence === 'once') return date === spec.startDate
  if (spec.recurrence === 'daily') return true
  return spec.weekdays.includes(new Date(`${date}T00:00:00Z`).getUTCDay())
}

/** Occurrences whose start is within [from, to], in order. */
export function occurrencesBetween(spec: ScheduleSpec, from: Date, to: Date): Occurrence[] {
  if (spec.recurrence === 'once') {
    const o = occurrenceOn(spec, spec.startDate)
    return o.start >= from && o.start <= to ? [o] : []
  }
  const out: Occurrence[] = []
  // Local dates from a day before `from` to a day after `to` cover every timezone's offset
  let cursor = Date.parse(`${localDate(new Date(from.getTime() - DAY), spec.timezone)}T00:00:00Z`)
  const last = Date.parse(`${localDate(new Date(to.getTime() + DAY), spec.timezone)}T00:00:00Z`)
  if (cursor < Date.parse(`${spec.startDate}T00:00:00Z`)) cursor = Date.parse(`${spec.startDate}T00:00:00Z`)
  for (; cursor <= last; cursor += DAY) {
    const date = ymd(cursor)
    if (!runsOn(spec, date)) continue
    const o = occurrenceOn(spec, date)
    if (o.start >= from && o.start <= to) out.push(o)
  }
  return out
}

/** The occurrence that started most recently at or before `at`, or null if none has. */
export function latestStart(spec: ScheduleSpec, at: Date): Occurrence | null {
  if (spec.recurrence === 'once') {
    const o = occurrenceOn(spec, spec.startDate)
    return o.start <= at ? o : null
  }
  // A weekly schedule runs at least once in any 8 days
  const recent = occurrencesBetween(spec, new Date(at.getTime() - 8 * DAY), at)
  return recent.at(-1) ?? null
}

/** The next `n` occurrence starts after `after`. */
export function nextStarts(spec: ScheduleSpec, after: Date, n: number): Date[] {
  const out: Date[] = []
  let from = new Date(after.getTime() + 1)
  // Look ahead in 31-day windows; a once-schedule or sparse weekly needs at most a few
  for (let i = 0; i < 60 && out.length < n; i++) {
    const to = new Date(from.getTime() + 31 * DAY)
    for (const o of occurrencesBetween(spec, from, to)) if (out.length < n) out.push(o.start)
    if (spec.recurrence === 'once') break
    from = new Date(to.getTime() + 1)
  }
  return out
}
