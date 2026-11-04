import { programmeLength, type ProgrammeItem, type ShowingInstance } from '@virvixr/shared'
import { occurrencesBetween, type ScheduleSpec } from './schedule-time.js'

/**
 * Scheduled showings on a video screen (LIV-87): a programme of videos at a local time, timezone and repetition,
 * using the same wall-clock schedules as scheduled presets (LIV-86). This file turns them into the UTC start instants
 * players work from (`screenStateAt` in @virvixr/shared) and checks a screen's showings don't overlap.
 */

export interface ShowingSpec {
  id: string
  items: ProgrammeItem[]
  /** A showing's length is its programme's, so the schedule has no duration of its own. */
  schedule: Omit<ScheduleSpec, 'durationMinutes'>
  title?: string
  posterUrl?: string
}

const DAY = 86_400_000
/** How far ahead overlaps are checked: a year and a week covers every weekday against every daylight-saving season. */
export const OVERLAP_HORIZON_DAYS = 371

const spec = (s: ShowingSpec): ScheduleSpec => ({ ...s.schedule, durationMinutes: null })

/**
 * Every instance of the showings that is on screen at some point in [from, to]: those starting in it, and one that
 * started earlier and is still running at `from`. In start order.
 */
export function showingInstancesBetween(showings: ShowingSpec[], from: Date, to: Date): ShowingInstance[] {
  const out: ShowingInstance[] = []
  for (const s of showings) {
    const lengthMs = programmeLength(s.items) * 1000
    for (const o of occurrencesBetween(spec(s), new Date(from.getTime() - lengthMs), to)) {
      if (o.start.getTime() + lengthMs <= from.getTime()) continue
      out.push({
        showingId: s.id, startsAt: o.start.getTime(), items: s.items,
        ...(s.title ? { title: s.title } : {}), ...(s.posterUrl ? { posterUrl: s.posterUrl } : {}),
      })
    }
  }
  return out.sort((a, b) => a.startsAt - b.startsAt || a.showingId.localeCompare(b.showingId))
}

export interface ShowingOverlap {
  /** The showing that starts first, */
  first: string
  /** and the one that starts before it ends, */
  second: string
  /** at this instant (ISO), the first time it happens. */
  at: string
}

/**
 * Showings on one screen that run into each other from `from` on, one entry per pair (its first clash). A showing whose
 * programme is longer than the gap to its own next start overlaps itself (first === second).
 */
export function showingOverlaps(showings: ShowingSpec[], from: Date, horizonDays = OVERLAP_HORIZON_DAYS): ShowingOverlap[] {
  const instances = showingInstancesBetween(showings, from, new Date(from.getTime() + horizonDays * DAY))
  const out: ShowingOverlap[] = []
  const seen = new Set<string>()
  for (let i = 0; i < instances.length; i++) {
    const a = instances[i]
    const end = a.startsAt + programmeLength(a.items) * 1000
    for (let j = i + 1; j < instances.length && instances[j].startsAt < end; j++) {
      const b = instances[j]
      const key = `${a.showingId}\u0000${b.showingId}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ first: a.showingId, second: b.showingId, at: new Date(b.startsAt).toISOString() })
    }
  }
  return out
}

/** URLs of programme items with no known length: those can't be scheduled. */
export function itemsWithoutLength(items: ProgrammeItem[]): string[] {
  return items.filter((i) => !(Number.isFinite(i.duration) && i.duration > 0)).map((i) => i.url)
}
