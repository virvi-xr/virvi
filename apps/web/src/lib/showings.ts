/** Scheduled showings on a video screen in the dashboard (LIV-87): form helpers and wording. The server validates. */
import { positionAt } from '@virvixr/shared'
import { WEEKDAYS, type Recurrence } from './preset-schedules'
import { formatDuration } from './format'

export interface ShowingItem { url: string; duration: number; kind: 'video' | 'ad' }

export interface Showing {
  id: string
  elementId: string
  title: string | null
  description: string | null
  posterUrl: string | null
  items: ShowingItem[]
  recurrence: Recurrence
  startDate: string
  startTime: string
  weekdays: number[]
  timezone: string
  enabled: boolean
  lengthSeconds: number
  nextStarts: string[]
  /** Shows on now or coming up, as players see them (hosts' delays, early ends and plays applied). */
  upcoming?: Array<{ startsAt: string; lengthSeconds: number }>
}

export interface ShowingFormItem {
  url: string
  kind: 'video' | 'ad'
  /** As typed: h:mm:ss, m:ss or minutes; blank lets the server use the length measured on upload. */
  length: string
}

export interface ShowingForm {
  title: string
  description: string
  posterUrl: string
  items: ShowingFormItem[]
  recurrence: Recurrence
  weekdays: number[]
  startDate: string
  startTime: string
  timezone: string
  enabled: boolean
}

/** Seconds from "1:30:00", "12:34" or "90" (minutes); null for blank or unreadable. */
export function parseLength(text: string): number | null {
  const t = text.trim()
  if (/^\d+$/.test(t)) return Number(t) > 0 ? Number(t) * 60 : null
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(t)
  if (!m) return null
  const [h, mm, ss] = [Number(m[1] ?? 0), Number(m[2]), Number(m[3])]
  if (ss > 59 || (m[1] !== undefined && mm > 59)) return null
  const total = h * 3600 + mm * 60 + ss
  return total > 0 ? total : null
}

/** What's wrong with a programme before it's sent, or null. */
export function programmeProblem(items: ShowingFormItem[]): string | null {
  if (items.length === 0) return 'Add at least one video.'
  const bad = items.find((i) => i.length.trim() && parseLength(i.length) === null)
  if (bad) return `"${bad.length.trim()}" isn't a length: use h:mm:ss, m:ss or minutes.`
  if (items[items.length - 1].kind === 'ad') return 'Ads play before the feature: end the showing with a video.'
  return null
}

export function formToShowingBody(f: ShowingForm) {
  const text = (s: string) => s.trim() || null
  return {
    title: text(f.title),
    description: text(f.description),
    posterUrl: text(f.posterUrl),
    items: f.items.map((i) => {
      const d = parseLength(i.length)
      return { url: i.url, kind: i.kind, ...(d ? { duration: d } : {}) }
    }),
    recurrence: f.recurrence,
    weekdays: f.recurrence === 'weekly' ? [...f.weekdays].sort((a, b) => a - b) : [],
    startDate: f.startDate,
    startTime: f.startTime,
    timezone: f.timezone,
    enabled: f.enabled,
  }
}

export function showingToForm(s: Showing): ShowingForm {
  return {
    title: s.title ?? '', description: s.description ?? '', posterUrl: s.posterUrl ?? '',
    items: s.items.map((i) => ({ url: i.url, kind: i.kind, length: Math.round(i.duration) >= 1 ? formatDuration(i.duration) ?? '' : '' })),
    recurrence: s.recurrence, weekdays: s.weekdays, startDate: s.startDate, startTime: s.startTime, timezone: s.timezone, enabled: s.enabled,
  }
}

export function programmeLength(items: Pick<ShowingItem, 'duration'>[]): number {
  return items.reduce((sum, i) => sum + (i.duration > 0 ? i.duration : 0), 0)
}

const PLURAL = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']
const list = (w: string[]) => (w.length <= 1 ? w.join('') : `${w.slice(0, -1).join(', ')} and ${w.at(-1)}`)

/** "Fridays and Saturdays at 19:00 (America/New_York) · 1:40:00" */
export function describeShowing(s: Pick<Showing, 'recurrence' | 'weekdays' | 'startDate' | 'startTime' | 'timezone' | 'items'>): string {
  const when = s.recurrence === 'once' ? `Once on ${s.startDate}` : s.recurrence === 'daily' ? 'Every day' : list([...s.weekdays].sort().map((d) => PLURAL[d]))
  const length = formatDuration(programmeLength(s.items))
  return `${when} at ${s.startTime} (${s.timezone})${length ? ` · ${length}` : ''}`
}

const clock = (seconds: number) => formatDuration(seconds) ?? '0:00'

/** "14:02 into the showing: 4:02 into Night.mp4", for the editor's preview. */
export function previewAt(items: ShowingItem[], secondsIn: number, name: (url: string) => string): string {
  const pos = positionAt(items, secondsIn)
  if (!pos) return 'The showing has ended by then.'
  const item = items[pos.index]
  return `${clock(secondsIn)} into the showing: ${clock(pos.offset)} into ${name(item.url)}${item.kind === 'ad' ? ' (ad)' : ''}`
}

export { WEEKDAYS }

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * Duplicate: the next screening of the same programme, starting when this one ends (on the next 5 minutes), so it
 * never clashes with the original. Past midnight, a one-off moves to the next day and weekly days move on one.
 */
export function duplicateShowingForm(s: Showing): ShowingForm {
  const form = showingToForm(s)
  const [h, m] = s.startTime.split(':').map(Number)
  const end = h * 60 + m + Math.ceil(programmeLength(s.items) / 60)
  const start = Math.ceil(end / 5) * 5
  const days = Math.floor(start / 1440)
  const minute = start % 1440
  form.startTime = `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`
  if (days > 0) {
    if (s.recurrence === 'once') {
      const d = new Date(`${s.startDate}T00:00:00Z`)
      d.setUTCDate(d.getUTCDate() + days)
      form.startDate = d.toISOString().slice(0, 10)
    }
    if (s.recurrence === 'weekly') form.weekdays = s.weekdays.map((w) => (w + days) % 7)
  }
  return form
}

/** The same showing for another screen, with the exact lengths the server stored (blank ones left for it to fill). */
export function copyShowingBody(s: Showing) {
  return {
    title: s.title, description: s.description, posterUrl: s.posterUrl,
    items: s.items.map((i) => ({ url: i.url, kind: i.kind, ...(i.duration > 0 ? { duration: i.duration } : {}) })),
    recurrence: s.recurrence, weekdays: s.recurrence === 'weekly' ? s.weekdays : [],
    startDate: s.startDate, startTime: s.startTime, timezone: s.timezone, enabled: s.enabled,
  }
}

export interface CopyTarget { id: string; name: string; scheduled: boolean; label: string }

/** The scene's other video screens a showing can be copied to (offType 6 is Schedule mode). */
export function copyTargets(screens: { id: string; type: string; name?: string | null; properties?: Record<string, any> | null }[], currentId: string): CopyTarget[] {
  return screens
    .filter((el) => el.type === 'video' && el.id !== currentId)
    .map((el) => {
      const name = el.name?.trim() || 'Video screen'
      const scheduled = (el.properties?.offType ?? 0) === 6
      return { id: el.id, name, scheduled, label: scheduled ? name : `${name} (not in Schedule mode)` }
    })
}

export function copiedMessage(s: Pick<Showing, 'title'>, to: Pick<CopyTarget, 'name' | 'scheduled'>): string {
  const done = `Copied ${s.title || 'Untitled showing'} to ${to.name}.`
  return to.scheduled ? done : `${done} It plays there once ${to.name} is set to Scheduled showings.`
}

/** "2026-11-06" shifted by n days (calendar dates, so daylight saving can't move it). */
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay()

/** The days (0 = Sunday) a showing can be copied to: the ones it isn't already on. A daily showing has none. */
export function copyDayChoices(s: Pick<Showing, 'recurrence' | 'weekdays' | 'startDate'>): number[] {
  if (s.recurrence === 'daily') return []
  const on = s.recurrence === 'once' ? [weekdayOf(s.startDate)] : s.weekdays
  return [0, 1, 2, 3, 4, 5, 6].filter((d) => !on.includes(d))
}

/**
 * Copies of a showing on other days, at the same time. A one-off goes to the next of each chosen day after its date
 * (one showing per day, by date); a weekly one becomes one more weekly showing on the chosen days it isn't already on.
 */
export function copyToDaysBodies(s: Showing, days: number[]): ReturnType<typeof copyShowingBody>[] {
  const wanted = [...new Set(days)].filter((d) => copyDayChoices(s).includes(d)).sort((a, b) => a - b)
  if (!wanted.length) return []
  const body = copyShowingBody(s)
  if (s.recurrence === 'weekly') return [{ ...body, weekdays: wanted }]
  const from = weekdayOf(s.startDate)
  return wanted
    .map((d) => ({ ...body, startDate: addDays(s.startDate, ((d - from + 7) % 7) || 7) }))
    .sort((a, b) => a.startDate.localeCompare(b.startDate))
}

/** The Sunday-to-Saturday week around a date. */
export function thisWeek(today: string): { start: string; end: string } {
  const start = addDays(today, -weekdayOf(today))
  return { start, end: addDays(start, 6) }
}

/** This week's one-off showings, again 7 days later. Repeating showings already repeat, so they aren't copied. */
export function nextWeekBodies(showings: Showing[], today: string): ReturnType<typeof copyShowingBody>[] {
  const { start, end } = thisWeek(today)
  return showings
    .filter((s) => s.recurrence === 'once' && s.startDate >= start && s.startDate <= end)
    .sort((a, b) => `${a.startDate} ${a.startTime}`.localeCompare(`${b.startDate} ${b.startTime}`))
    .map((s) => ({ ...copyShowingBody(s), startDate: addDays(s.startDate, 7) }))
}

/** "Copied 2 showings." plus the ones refused for clashing ("Matinee on 2026-11-09"). */
export function copyResultMessage(copied: number, clashed: string[]): string {
  const done = `Copied ${copied} ${copied === 1 ? 'showing' : 'showings'}.`
  if (!clashed.length) return done
  const one = clashed.length === 1
  return `${done} Not copied, because ${one ? 'it clashes with a showing' : 'they clash with showings'} already there: ${list(clashed)}.`
}

// ── Host controls (delay, end, play now) ────────────────────────────────────

export type ShowControl = 'delay' | 'end' | 'play-now'
/** "Delay" moves the next show this many minutes; pressing again adds more (the server caps it at 3 hours). */
export const DELAY_STEP_MINUTES = 5

/** The show on now (when it ends) and the next one that hasn't started, from the server's `upcoming`. */
export function showNow(s: Pick<Showing, 'enabled' | 'upcoming'>, now: number): { on: { endsAt: string } | null; next: string | null } {
  if (!s.enabled || !s.upcoming) return { on: null, next: null }
  let on: { endsAt: string } | null = null
  let next: string | null = null
  for (const u of s.upcoming) {
    const start = Date.parse(u.startsAt)
    const end = start + u.lengthSeconds * 1000
    if (start <= now && now < end) on ??= { endsAt: new Date(end).toISOString() }
    else if (start > now) next ??= u.startsAt
  }
  return { on, next }
}

export function showControlMessage(control: ShowControl, title: string | null): string {
  const name = title || 'Untitled showing'
  if (control === 'delay') return `${name}: the next show starts ${DELAY_STEP_MINUTES} minutes later.`
  if (control === 'end') return `${name}: ended. The screen goes back to its holding image.`
  return `${name}: playing now for everyone in the scene.`
}
