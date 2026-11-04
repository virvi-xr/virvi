import { and, eq, inArray, sql } from 'drizzle-orm'
import { programmeLength, type ProgrammeItem, type ShowingInstance } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { mediaAssets, screenShowings } from '../db/schema.js'
import { nextStarts, occurrencesBetween, zonedToUtc, type ScheduleSpec } from './schedule-time.js'
import { parseWhen, type WhenFields } from './preset-schedules.js'

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

// ── Stored showings: validation and lookups ─────────────────────────────────

export class ShowingError extends Error {
  constructor(public status: 400 | 404 | 409, public code: string, message: string, public extra: Record<string, unknown> = {}) {
    super(message)
  }
}

export type ShowingRow = typeof screenShowings.$inferSelect
type Item = ShowingRow['items'][number]

export interface ShowingInput {
  title: string | null
  description: string | null
  posterUrl: string | null
  /** As sent: lengths are resolved by resolveItems. */
  items: Array<{ url: string; kind: 'video' | 'ad'; duration: number | null }>
  recurrence: 'once' | 'daily' | 'weekly'
  startDate: string
  startTime: string
  weekdays: number[]
  timezone: string
  enabled: boolean
}

export const MAX_ITEMS = 50
/** One video, and a whole programme: no film or marathon runs longer. */
export const MAX_ITEM_SECONDS = 24 * 3600
export const MAX_PROGRAMME_SECONDS = 48 * 3600
const MAX_URL = 2048

const httpUrl = (u: unknown): u is string => {
  if (typeof u !== 'string' || u.length > MAX_URL) return false
  try {
    const p = new URL(u).protocol
    return p === 'https:' || p === 'http:'
  } catch {
    return false
  }
}

const optText = (v: unknown, max: number, what: string, bad: (m: string) => Error): string | null => {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string' || v.length > max) throw bad(`${what} must be text up to ${max} characters.`)
  return v.trim() || null
}

/** Validates a whole showing (a create, or an edit laid over the current one). Throws ShowingError(400). */
export function parseShowingInput(body: Record<string, unknown>, base?: ShowingRow): ShowingInput {
  const pick = (k: string): unknown => (body[k] !== undefined ? body[k] : (base as Record<string, unknown> | undefined)?.[k])
  const bad = (message: string) => new ShowingError(400, 'bad_showing', message)
  const when = parseWhen(pick as (k: keyof WhenFields) => unknown, bad)
  const title = optText(pick('title'), 200, 'The title', bad)
  const description = optText(pick('description'), 2000, 'The description', bad)
  const posterUrl = pick('posterUrl') ?? null
  if (posterUrl !== null && !httpUrl(posterUrl)) throw bad('The poster must be a web address.')
  const enabled = pick('enabled') ?? true
  if (typeof enabled !== 'boolean') throw bad('enabled must be true or false.')
  const raw = pick('items')
  if (!Array.isArray(raw) || raw.length === 0) throw bad('Add at least one video.')
  if (raw.length > MAX_ITEMS) throw bad(`A showing can have up to ${MAX_ITEMS} videos.`)
  const items = raw.map((it) => {
    const o = (it ?? {}) as Record<string, unknown>
    if (!httpUrl(o.url)) throw bad('Each video needs a web address (https://…).')
    const kind = o.kind ?? 'video'
    if (kind !== 'video' && kind !== 'ad') throw bad('Each item is a video or an ad slot.')
    const d = o.duration ?? null
    if (d !== null && (typeof d !== 'number' || !Number.isFinite(d) || d <= 0 || d > MAX_ITEM_SECONDS)) throw bad('A video length must be up to 24 hours, in seconds.')
    return { url: o.url, kind: kind as 'video' | 'ad', duration: d as number | null }
  })
  if (items[items.length - 1].kind === 'ad') throw bad('Ads play before the feature, never after it: end the showing with a video.')
  return { title, description, posterUrl: posterUrl as string | null, items, enabled, ...when }
}

/**
 * Fills in each video's length: a length measured on upload (any Media Library file at that address) wins; else the
 * one sent (an external video whose length the host typed). Throws ShowingError(400, 'unknown_length') naming the rest.
 */
export async function resolveItems(items: ShowingInput['items']): Promise<Item[]> {
  const urls = [...new Set(items.map((i) => i.url))]
  const rows = await db.select({ url: mediaAssets.publicUrl, duration: sql<unknown>`${mediaAssets.metadata}->'duration'` })
    .from(mediaAssets)
    .where(and(inArray(mediaAssets.publicUrl, urls), eq(mediaAssets.status, 'ready')))
  const measured = new Map<string, number>()
  for (const r of rows) if (r.url && typeof r.duration === 'number' && r.duration > 0) measured.set(r.url, r.duration)
  const resolved = items.map((i) => ({ url: i.url, kind: i.kind, duration: measured.get(i.url) ?? i.duration ?? 0 }))
  const missing = itemsWithoutLength(resolved)
  if (missing.length) {
    throw new ShowingError(400, 'unknown_length', "These videos have no known length, so they can't be scheduled. Upload them to the Media Library, or enter their length.", { urls: [...new Set(missing)] })
  }
  if (programmeLength(resolved) > MAX_PROGRAMME_SECONDS) throw new ShowingError(400, 'bad_showing', 'A showing can run up to 48 hours.')
  return resolved
}

export const specOfShowing = (row: Pick<ShowingRow, 'id' | 'items' | 'recurrence' | 'startDate' | 'startTime' | 'weekdays' | 'timezone' | 'title' | 'posterUrl'>): ShowingSpec => ({
  id: row.id, items: row.items, title: row.title ?? undefined, posterUrl: row.posterUrl ?? undefined,
  schedule: { recurrence: row.recurrence, startDate: row.startDate, startTime: row.startTime, weekdays: row.weekdays, timezone: row.timezone },
})

type Db = Pick<typeof db, 'select'>

const firstDayOf = (spec: ShowingSpec) => zonedToUtc(spec.schedule.startDate, '00:00', spec.schedule.timezone).getTime() - DAY

/**
 * The first enabled showing on the screen this one would run into (from `now`), or null. Each pair is checked from
 * when both have begun (the later first day, or now), so a showing starting years ahead is still compared.
 */
export async function findShowingClash(elementId: string, candidate: ShowingSpec, now: Date, ignoreId?: string, tx: Db = db): Promise<{ row: ShowingRow; at: string } | null> {
  const others = (await tx.select().from(screenShowings).where(and(eq(screenShowings.elementId, elementId), eq(screenShowings.enabled, true))))
    .filter((r) => r.id !== ignoreId)
  const from = (...specs: ShowingSpec[]) => new Date(Math.max(now.getTime(), ...specs.map(firstDayOf)))
  const self = showingOverlaps([candidate], from(candidate))[0]
  const clashes: Array<{ row: ShowingRow; at: string }> = self ? [{ row: { id: candidate.id, title: candidate.title ?? null } as ShowingRow, at: self.at }] : []
  for (const row of others) {
    const other = specOfShowing(row)
    const hit = showingOverlaps([other, candidate], from(other, candidate)).find((o) => o.first !== o.second)
    if (hit) clashes.push({ row, at: hit.at })
  }
  return clashes.sort((a, b) => a.at.localeCompare(b.at))[0] ?? null
}

/** A showing as the API returns it: its length and next three starts. */
export function presentShowing(row: ShowingRow, now: Date) {
  return {
    ...row,
    lengthSeconds: programmeLength(row.items),
    nextStarts: nextStarts({ ...specOfShowing(row).schedule, durationMinutes: null }, now, 3).map((d) => d.toISOString()),
  }
}
