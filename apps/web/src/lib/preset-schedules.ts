/** Scheduled presets in the dashboard (LIV-86): wording and form helpers. The server works out the runs. */

export type Recurrence = 'once' | 'daily' | 'weekly'

export interface PresetSchedule {
  id: string
  presetId: string
  recurrence: Recurrence
  startDate: string
  startTime: string
  weekdays: number[]
  durationMinutes: number | null
  timezone: string
  returnToPresetId: string | null
  enabled: boolean
  /** Set: the times follow this event (change them on the event's page). */
  eventId?: string | null
  nextRuns: string[]
  /** Upcoming runs skipped ahead of time (they won't switch the preset). */
  skippedRuns?: string[]
}

export interface ScheduleRun {
  id: string
  scheduleId: string
  occurrenceStart: string
  status: 'active' | 'held' | 'ended' | 'overridden' | 'skipped'
  outcome: string | null
}

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const PLURAL = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']

function length(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  return [h ? `${h} h` : '', m ? `${m} min` : ''].filter(Boolean).join(' ')
}

function list(words: string[]): string {
  return words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`
}

/** "Fridays and Saturdays at 20:00 for 3 h (Europe/London)" */
export function describeSchedule(s: Pick<PresetSchedule, 'recurrence' | 'weekdays' | 'startDate' | 'startTime' | 'durationMinutes' | 'timezone'>): string {
  const when = s.recurrence === 'once' ? `Once on ${s.startDate}` : s.recurrence === 'daily' ? 'Every day' : list(s.weekdays.map((d) => PLURAL[d]))
  const howLong = s.durationMinutes == null ? ', until the next switch' : ` for ${length(s.durationMinutes)}`
  return `${when} at ${s.startTime}${howLong} (${s.timezone})`
}

const fmt = (iso: string, tz: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso))

/** A run time in the schedule's timezone, plus the viewer's own when they differ. */
export function formatRunTime(iso: string, scheduleTz: string, viewerTz: string): string {
  const there = fmt(iso, scheduleTz)
  const here = fmt(iso, viewerTz)
  return there === here ? there : `${there} (${here} your time)`
}

export function viewerTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** A date as YYYY-MM-DD in the browser's own timezone (the date pickers' default: not the UTC date). */
export function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * The timezone picker's options with `current` first: some browsers leave UTC and aliases (Asia/Calcutta) out of
 * the list, and a select without its value shows the first option while the form keeps the real one.
 */
export function timezoneOptions(current: string): string[] {
  return [...new Set([current, ...timezones()].filter(Boolean))]
}

/** Every IANA timezone the browser knows, or a short list when it can't say. */
export function timezones(): string[] {
  try {
    return (Intl as any).supportedValuesOf('timeZone') as string[]
  } catch {
    return ['UTC', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Asia/Tokyo', 'Australia/Sydney']
  }
}

export interface ScheduleForm {
  presetId: string
  recurrence: Recurrence
  weekdays: number[]
  startDate: string
  startTime: string
  hasEnd: boolean
  durationMinutes: number
  timezone: string
  /** '' = back to whatever was live before */
  returnToPresetId: string
}

export function formToBody(f: ScheduleForm) {
  return {
    presetId: f.presetId,
    recurrence: f.recurrence,
    weekdays: f.recurrence === 'weekly' ? [...f.weekdays].sort() : [],
    startDate: f.startDate,
    startTime: f.startTime,
    durationMinutes: f.hasEnd ? f.durationMinutes : null,
    timezone: f.timezone,
    returnToPresetId: f.returnToPresetId || null,
  }
}

export function runLabel(r: Pick<ScheduleRun, 'status' | 'outcome'>): string {
  switch (r.status) {
    case 'active': return 'Live now'
    case 'held': return 'Waiting for a booking to end'
    case 'overridden': return 'Switched manually'
    case 'skipped': return r.outcome === 'skipped by hand' ? 'Skipped' : 'Missed (the server was offline)'
    default: return r.outcome === 'finished' || !r.outcome ? 'Finished' : `Ended: ${r.outcome}`
  }
}

export type LiveReason =
  | { kind: 'none' }
  | { kind: 'booking'; title: string; until: string }
  | { kind: 'schedule'; scheduleId: string; until: string | null }
  | { kind: 'manual' }

export interface LiveStatus {
  reason: LiveReason
  nextSwitch: { at: string; presetId: string | null; scheduleId: string } | null
}

/** The preset bar's "why is this live" and "next switch" lines, in the viewer's timezone. */
export function liveStatusText(s: LiveStatus, presetName: (id: string | null) => string | null, viewerTz: string): { why: string | null; next: string | null } {
  const when = (iso: string) => fmt(iso, viewerTz)
  const r = s.reason
  const why = r.kind === 'booking' ? `Booking: ${r.title}, until ${when(r.until)}`
    : r.kind === 'schedule' ? (r.until ? `Scheduled until ${when(r.until)}` : 'Scheduled, until the next switch')
    : r.kind === 'manual' ? (s.nextSwitch ? `Switched manually; the schedule resumes ${when(s.nextSwitch.at)}` : 'Switched manually')
    : null
  const n = s.nextSwitch
  const next = n ? `Next switch: ${presetName(n.presetId) ?? 'back to the previous preset'} at ${when(n.at)}` : null
  return { why, next }
}

export interface WeekOccurrence { scheduleId: string; presetId: string; start: string; end: string | null; skipped?: boolean }
export interface WeekBlock { scheduleId: string; presetId: string; top: number; height: number; time: string; skipped?: boolean }
export interface WeekDay { date: string; label: string; blocks: WeekBlock[] }

/** The local date (YYYY-MM-DD) and minutes past local midnight of an instant in `tz`. */
function localParts(ms: number, tz: string): { date: string; minutes: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map((p) => [p.type, p.value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) }
}

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`

/**
 * The schedule's week view: `days` days from today in the viewer's timezone, each run placed by local time (top and
 * height as % of the day). A run past midnight continues on the next day; an open-ended run lasts until the next run
 * starts, or to the end of the week.
 */
export function weekGrid(occurrences: WeekOccurrence[], viewerTz: string, now: Date, days = 7): WeekDay[] {
  const first = localParts(now.getTime(), viewerTz).date
  const grid: WeekDay[] = Array.from({ length: days }, (_, i) => {
    const date = addDays(first, i)
    const d = new Date(`${date}T12:00:00Z`)
    return { date, label: `${d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })} ${d.getUTCDate()}`, blocks: [] }
  })
  const lastDate = grid[grid.length - 1].date
  const sorted = [...occurrences].sort((a, b) => a.start.localeCompare(b.start))
  sorted.forEach((o, i) => {
    const startMs = Date.parse(o.start)
    // A skipped run doesn't switch, so an open-ended run carries on past it
    const nextStart = sorted.slice(i + 1).find((x) => Date.parse(x.start) > startMs && !x.skipped)
    const s = localParts(startMs, viewerTz)
    const e = o.end ? localParts(Date.parse(o.end), viewerTz) : nextStart ? localParts(Date.parse(nextStart.start), viewerTz) : { date: addDays(lastDate, 1), minutes: 0 }
    const time = o.end ? `${hhmm(s.minutes)}–${hhmm(e.minutes)}` : `${hhmm(s.minutes)} →`
    for (let date = s.date; date <= e.date; date = addDays(date, 1)) {
      const from = date === s.date ? s.minutes : 0
      const to = date === e.date ? e.minutes : 1440
      const day = grid.find((g) => g.date === date)
      if (!day || to <= from) continue
      day.blocks.push({ scheduleId: o.scheduleId, presetId: o.presetId, top: (from / 1440) * 100, height: ((to - from) / 1440) * 100, time, ...(o.skipped ? { skipped: true } : {}) })
    }
  })
  return grid
}
