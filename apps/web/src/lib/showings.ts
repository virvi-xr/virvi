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
