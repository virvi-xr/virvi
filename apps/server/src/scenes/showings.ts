import { and, eq, inArray, sql } from 'drizzle-orm'
import { programmeLength, type ProgrammeItem, type ShowingInstance } from '@virvixr/shared'
import { db } from '../db/connection.js'
import { events, eventSceneLinks, mediaAssets, sceneElements, screenShowings } from '../db/schema.js'
import { publishSceneTouched, publishVenueEvent } from '../realtime/bus.js'
import { isTimeZone, nextStarts, occurrencesBetween, utcToZoned, zonedToUtc, type ScheduleSpec } from './schedule-time.js'
import { parseWhen, type WhenFields } from './preset-schedules.js'

/**
 * Scheduled showings on a video screen (LIV-87): a programme of videos at a local time, timezone and repetition,
 * using the same wall-clock schedules as scheduled presets (LIV-86). This file turns them into the UTC start instants
 * players work from (`screenStateAt` in @virvixr/shared) and checks a screen's showings don't overlap.
 */

/**
 * A host's change to one show (LIV-87, from the HUD or dashboard), kept on the showing. `occurrence` is the show's
 * scheduled start (UTC ms), or a played-now show's start. Applied when showings are expanded, so players need nothing new.
 */
export type ShowingAdjustment =
  /** Starts `minutes` later; several add up. */
  | { kind: 'delay'; occurrence: number; minutes: number }
  /** Ended early at `at` (UTC ms): the programme is cut there. */
  | { kind: 'end'; occurrence: number; at: number }
  /** An extra show of the programme starting at `startsAt`. */
  | { kind: 'play'; startsAt: number }

export const MAX_DELAY_STEP_MINUTES = 60
export const MAX_DELAY_TOTAL_MINUTES = 180

export interface ShowingSpec {
  id: string
  items: ProgrammeItem[]
  adjustments?: ShowingAdjustment[]
  /** A showing's length is its programme's, so the schedule has no duration of its own. */
  schedule: Omit<ScheduleSpec, 'durationMinutes'>
  title?: string
  posterUrl?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY = 86_400_000
/** How far ahead overlaps are checked: a year and a week covers every weekday against every daylight-saving season. */
export const OVERLAP_HORIZON_DAYS = 371

const spec = (s: ShowingSpec): ScheduleSpec => ({ ...s.schedule, durationMinutes: null })

/** The programme cut `seconds` in: what plays before that point, the last item shortened. */
function cutItems(items: ProgrammeItem[], seconds: number): ProgrammeItem[] {
  const out: ProgrammeItem[] = []
  let used = 0
  for (const item of items) {
    if (!(item.duration > 0)) continue
    const left = seconds - used
    if (left <= 0) break
    out.push(left < item.duration ? { ...item, duration: left } : item)
    used += item.duration
  }
  return out
}

type Instance = ShowingInstance & { occurrence: number }
const adjustmentTime = (a: ShowingAdjustment) => (a.kind === 'play' ? a.startsAt : a.occurrence)

/** One showing's shows on screen at some point in [from, to], adjustments applied, each with its occurrence. */
function instancesOf(s: ShowingSpec, from: Date, to: Date): Instance[] {
  const adj = s.adjustments ?? []
  const lookback = programmeLength(s.items) * 1000 + MAX_DELAY_TOTAL_MINUTES * 60_000
  const earliest = from.getTime() - lookback
  const starts = new Set(occurrencesBetween(spec(s), new Date(earliest), to).map((o) => o.start.getTime()))
  for (const a of adj) if (a.kind === 'play' && a.startsAt >= earliest && a.startsAt <= to.getTime()) starts.add(a.startsAt)
  const out: Instance[] = []
  for (const occurrence of starts) {
    const delay = adj.reduce((m, a) => (a.kind === 'delay' && a.occurrence === occurrence ? m + a.minutes : m), 0)
    const startsAt = occurrence + delay * 60_000
    const end = adj.find((a): a is Extract<ShowingAdjustment, { kind: 'end' }> => a.kind === 'end' && a.occurrence === occurrence)
    const items = end ? cutItems(s.items, (end.at - startsAt) / 1000) : s.items
    if (!items.length || startsAt + programmeLength(items) * 1000 <= from.getTime() || startsAt > to.getTime()) continue
    out.push({
      showingId: s.id, startsAt, items, occurrence,
      ...(s.title ? { title: s.title } : {}), ...(s.posterUrl ? { posterUrl: s.posterUrl } : {}),
    })
  }
  return out.sort((a, b) => a.startsAt - b.startsAt)
}

/**
 * Every instance of the showings that is on screen at some point in [from, to]: those starting in it, and one that
 * started earlier and is still running at `from`. In start order. Hosts' delays, early ends and plays are applied.
 */
export function showingInstancesBetween(showings: ShowingSpec[], from: Date, to: Date): ShowingInstance[] {
  return showings
    .flatMap((s) => instancesOf(s, from, to).map(({ occurrence: _o, ...i }) => i))
    .sort((a, b) => a.startsAt - b.startsAt || a.showingId.localeCompare(b.showingId))
}

// ── Hosts' changes to single shows ──────────────────────────────────────────

/** Adjustments still worth keeping: their show is under 3 days old (no programme runs over 2 days). */
const kept = (s: ShowingSpec, now: Date) => (s.adjustments ?? []).filter((a) => adjustmentTime(a) >= now.getTime() - 3 * DAY)

/** The showing's adjustments with its next show (not yet started, within the delivery window) `minutes` later. */
export function planDelay(s: ShowingSpec, now: Date, minutes: unknown): ShowingAdjustment[] {
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_DELAY_STEP_MINUTES) {
    throw new ShowingError(400, 'bad_delay', `Delay by 1 to ${MAX_DELAY_STEP_MINUTES} minutes.`)
  }
  const next = instancesOf(s, now, new Date(now.getTime() + SHOWINGS_WINDOW_MS)).find((i) => i.startsAt > now.getTime())
  if (!next) throw new ShowingError(409, 'nothing_to_delay', 'This showing has no show coming up to delay.')
  const adj = kept(s, now)
  const total = minutes + adj.reduce((m, a) => (a.kind === 'delay' && a.occurrence === next.occurrence ? m + a.minutes : m), 0)
  if (total > MAX_DELAY_TOTAL_MINUTES) throw new ShowingError(409, 'delay_too_long', 'A show can be delayed by up to 3 hours in all.')
  return [...adj, { kind: 'delay', occurrence: next.occurrence, minutes }]
}

/** The showing's adjustments with the show that is on now ended at `now`. */
export function planEnd(s: ShowingSpec, now: Date): ShowingAdjustment[] {
  const on = instancesOf(s, now, now).find((i) => i.startsAt <= now.getTime() && now.getTime() < i.startsAt + programmeLength(i.items) * 1000)
  if (!on) throw new ShowingError(409, 'not_playing', "This showing isn't on right now.")
  const adj = kept(s, now).filter((a) => !(a.kind === 'end' && a.occurrence === on.occurrence))
  return [...adj, { kind: 'end', occurrence: on.occurrence, at: now.getTime() }]
}

/** The showing's adjustments with an extra show of its programme starting at `now`. */
export function planPlayNow(s: ShowingSpec, now: Date): ShowingAdjustment[] {
  return [...kept(s, now), { kind: 'play', startsAt: now.getTime() }]
}

/**
 * After a change to showing `changedId`, the first show on the screen one of its shows now runs into (within the
 * delivery window from `now`), or null. Clashes that don't involve it are left alone.
 */
export function screenClash(showings: ShowingSpec[], changedId: string, now: Date): { showingId: string; title: string | null; at: string } | null {
  const all = showingInstancesBetween(showings, now, new Date(now.getTime() + SHOWINGS_WINDOW_MS))
  const endOf = (i: ShowingInstance) => i.startsAt + programmeLength(i.items) * 1000
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length && all[j].startsAt < endOf(all[i]); j++) {
      const [a, b] = [all[i], all[j]]
      if (a.showingId !== changedId && b.showingId !== changedId) continue
      const other = a.showingId === changedId ? b : a
      return { showingId: other.showingId, title: other.title ?? null, at: new Date(b.startsAt).toISOString() }
    }
  }
  return null
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
  /** Set: times come from this event (withEventTimes). */
  eventId: string | null
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
  const eventId = pick('eventId') ?? null
  if (eventId !== null && (typeof eventId !== 'string' || !UUID_RE.test(eventId))) throw bad('Choose an event.')
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
  return { title, description, posterUrl: posterUrl as string | null, items, enabled, eventId: eventId as string | null, ...when }
}

/**
 * Fills in each video's length: a length measured on upload (any Images & Video file at that address) wins; else the
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
    throw new ShowingError(400, 'unknown_length', "These videos have no known length, so they can't be scheduled. Upload them to Images & Video, or enter their length.", { urls: [...new Set(missing)] })
  }
  if (programmeLength(resolved) > MAX_PROGRAMME_SECONDS) throw new ShowingError(400, 'bad_showing', 'A showing can run up to 48 hours.')
  return resolved
}

export const specOfShowing = (row: Pick<ShowingRow, 'id' | 'items' | 'recurrence' | 'startDate' | 'startTime' | 'weekdays' | 'timezone' | 'title' | 'posterUrl'> & { adjustments?: ShowingAdjustment[] }): ShowingSpec => ({
  id: row.id, items: row.items, title: row.title ?? undefined, posterUrl: row.posterUrl ?? undefined, adjustments: row.adjustments ?? [],
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
    /** The shows on now or coming up within the delivery window, as players will see them (hosts' changes applied). */
    upcoming: showingInstancesBetween([specOfShowing(row)], now, new Date(now.getTime() + SHOWINGS_WINDOW_MS))
      .slice(0, 3)
      .map((i) => ({ startsAt: new Date(i.startsAt).toISOString(), lengthSeconds: programmeLength(i.items) })),
  }
}

// ── Showings that follow an event ───────────────────────────────────────────

type EventTimes = Pick<typeof events.$inferSelect, 'startTime' | 'timezone'>
type WhenOf = Pick<ShowingInput, 'recurrence' | 'startDate' | 'startTime' | 'weekdays' | 'timezone'>

/** One show at the event's start, in the event's timezone; null when the event has no start. */
export function eventShowTimes(e: EventTimes): WhenOf | null {
  if (!e.startTime) return null
  const timezone = e.timezone && isTimeZone(e.timezone) ? e.timezone : 'UTC'
  const { date, time } = utcToZoned(e.startTime, timezone)
  return { recurrence: 'once', startDate: date, startTime: time, weekdays: [], timezone }
}

/**
 * The body with its times taken from its event (sent, or the showing's own), which must be linked to the scene.
 * Throws ShowingError(400). A body without an event comes back as it was.
 */
export async function withEventTimes(sceneId: string, body: Record<string, unknown>, base?: ShowingRow): Promise<Record<string, unknown>> {
  const eventId = body.eventId !== undefined ? body.eventId : base?.eventId ?? null
  if (eventId === null) return body
  const bad = (message: string) => new ShowingError(400, 'bad_showing', message)
  if (typeof eventId !== 'string' || !UUID_RE.test(eventId)) throw bad('Choose an event.')
  const [link] = await db.select({ e: events }).from(eventSceneLinks).innerJoin(events, eq(eventSceneLinks.eventId, events.id))
    .where(and(eq(eventSceneLinks.sceneId, sceneId), eq(eventSceneLinks.eventId, eventId)))
  if (!link) throw bad('Link the event to this scene first.')
  const times = eventShowTimes(link.e)
  if (!times) throw bad('The event needs a start time.')
  return { ...body, ...times }
}

/** Players in the scene get the screen's new showings (after the write). Never throws. */
export async function publishShowingsChanged(sceneId: string, elementId: string): Promise<void> {
  await publishVenueEvent({ type: 'showings_changed', sceneId, elementId }).catch((err) => console.error('[showings] publish failed:', err))
  await publishSceneTouched(sceneId) // wakes the Hyperfy feed's held polls; never throws
}

/**
 * After an event's times change, its showings move with it (hosts' changes to the old show are dropped). One whose event
 * has no start is paused, and resumes when it gets one. Clashes aren't re-checked: the event's time is the host's choice.
 */
export async function syncEventShowings(eventId: string): Promise<void> {
  const event = await db.query.events.findFirst({ where: eq(events.id, eventId) })
  if (!event) return
  const times = eventShowTimes(event)
  const rows = await db.select().from(screenShowings).where(eq(screenShowings.eventId, eventId))
  for (const s of rows) {
    const moved = !times || s.startDate !== times.startDate || s.startTime !== times.startTime || s.timezone !== times.timezone
    const set = times ? { ...times, enabled: true } : { enabled: false }
    await db.update(screenShowings).set({ ...set, ...(moved ? { adjustments: [] } : {}), updatedAt: new Date() }).where(eq(screenShowings.id, s.id))
    await publishShowingsChanged(s.sceneId, s.elementId)
  }
}

/** The event no longer runs at these scenes (unlinked, or deleted: all of them): its showings there pause, keeping their programmes. */
export async function releaseEventShowings(eventId: string, sceneId?: string): Promise<void> {
  const rows = await db.update(screenShowings).set({ eventId: null, enabled: false, updatedAt: new Date() })
    .where(and(eq(screenShowings.eventId, eventId), sceneId ? eq(screenShowings.sceneId, sceneId) : undefined))
    .returning({ sceneId: screenShowings.sceneId, elementId: screenShowings.elementId })
  for (const r of rows) await publishShowingsChanged(r.sceneId, r.elementId)
}

/** The showings following an event, with their screens' names, for the event page. */
export async function eventShowings(eventId: string) {
  return db.select({
    id: screenShowings.id, sceneId: screenShowings.sceneId, elementId: screenShowings.elementId,
    screenName: sceneElements.name, title: screenShowings.title, enabled: screenShowings.enabled,
  }).from(screenShowings).innerJoin(sceneElements, eq(screenShowings.elementId, sceneElements.id))
    .where(eq(screenShowings.eventId, eventId)).orderBy(screenShowings.createdAt)
}

/** The events linked to a scene, which its showings can follow. */
export async function sceneEventsForShowings(sceneId: string) {
  const rows = await db.select({ id: events.id, name: events.name, startTime: events.startTime, timezone: events.timezone })
    .from(eventSceneLinks).innerJoin(events, eq(eventSceneLinks.eventId, events.id))
    .where(eq(eventSceneLinks.sceneId, sceneId)).orderBy(events.startTime)
  return rows.map((r) => ({ ...r, startTime: r.startTime ? r.startTime.toISOString() : null }))
}

// ── Delivery to in-world players ────────────────────────────────────────────

/** How far ahead players are sent showings; the room re-sends every SHOWINGS_REFRESH_MS, so they never run out. */
export const SHOWINGS_WINDOW_MS = 36 * 3600_000
export const SHOWINGS_REFRESH_MS = 3600_000

export interface ScreenShowingsMessage {
  elementId: string
  /** The server's clock when this was built (UTC ms): players work out their offset from it. */
  serverTime: number
  /** Running now or starting within SHOWINGS_WINDOW_MS, in start order. */
  showings: ShowingInstance[]
}

/** The `screen_showings` message for each video element given, from its enabled showings. */
export async function screenShowingsMessages(elementIds: string[], now = new Date()): Promise<ScreenShowingsMessage[]> {
  if (elementIds.length === 0) return []
  const rows = await db.select().from(screenShowings)
    .where(and(inArray(screenShowings.elementId, elementIds), eq(screenShowings.enabled, true)))
  const to = new Date(now.getTime() + SHOWINGS_WINDOW_MS)
  return elementIds.map((elementId) => ({
    elementId,
    serverTime: now.getTime(),
    showings: showingInstancesBetween(rows.filter((r) => r.elementId === elementId).map(specOfShowing), now, to),
  }))
}
