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
  nextRuns: string[]
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
    case 'skipped': return 'Missed (the server was offline)'
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
