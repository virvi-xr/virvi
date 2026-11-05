import { and, desc, eq, gt, inArray, ne, or } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { bookings, eventSceneLinks, events, scenePresets, scenePresetScheduleRuns, scenePresetSchedules, scenes, venues } from '../db/schema.js'
import { publishVenueEvent } from '../realtime/bus.js'
import { isTimeZone, latestStart, utcToZoned, nextStarts, occurrencesBetween, type Occurrence, type ScheduleSpec } from './schedule-time.js'

/**
 * Scheduled presets (LIV-86): a scene's live preset switches on its own at set times. The sweep follows the venue
 * booking sweep's pattern: every change is claimed with a conditional write in one transaction, and each occurrence
 * is a run row unique per (schedule, start), so several servers sweeping at once apply it only once.
 *
 * Priority: a live venue booking wins (the run waits, then applies if its window is still open); a manual switch
 * overrides the run in progress (the next occurrence applies as normal).
 */

type ScheduleRow = typeof scenePresetSchedules.$inferSelect
type RunRow = typeof scenePresetScheduleRuns.$inferSelect

const DAY = 86_400_000
export const MAX_DURATION_MINUTES = 7 * 24 * 60

export class ScheduleError extends Error {
  constructor(public status: 400 | 404 | 409, public code: string, message: string) {
    super(message)
  }
}

export const specOf = (s: Pick<ScheduleRow, 'recurrence' | 'startDate' | 'startTime' | 'weekdays' | 'durationMinutes' | 'timezone'>): ScheduleSpec => ({
  recurrence: s.recurrence, startDate: s.startDate, startTime: s.startTime, weekdays: s.weekdays, durationMinutes: s.durationMinutes, timezone: s.timezone,
})

export interface ScheduleInput {
  presetId: string
  recurrence: 'once' | 'daily' | 'weekly'
  startDate: string
  startTime: string
  weekdays: number[]
  durationMinutes: number | null
  timezone: string
  returnToPresetId: string | null
  enabled: boolean
  /** Set: the times come from this event (see eventTimes) and follow it when it's edited. */
  eventId: string | null
}

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type WhenFields = Pick<ScheduleInput, 'recurrence' | 'startDate' | 'startTime' | 'weekdays' | 'timezone'>

/** The time fields every wall-clock schedule has (scheduled presets, screen showings); throws `bad(message)`. */
export function parseWhen(pick: (k: keyof WhenFields) => unknown, bad: (message: string) => Error): WhenFields {
  const recurrence = pick('recurrence')
  if (recurrence !== 'once' && recurrence !== 'daily' && recurrence !== 'weekly') throw bad('Repeat must be once, daily or weekly.')
  const startDate = pick('startDate')
  if (typeof startDate !== 'string' || !DATE_RE.test(startDate) || Number.isNaN(Date.parse(`${startDate}T00:00:00Z`))) throw bad('The date must be YYYY-MM-DD.')
  const startTime = pick('startTime')
  if (typeof startTime !== 'string' || !TIME_RE.test(startTime)) throw bad('The time must be HH:MM (24-hour).')
  const timezone = pick('timezone')
  if (typeof timezone !== 'string' || !isTimeZone(timezone)) throw bad('Choose a timezone.')
  const rawDays = pick('weekdays') ?? []
  if (!Array.isArray(rawDays) || rawDays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw bad('Weekdays are 0 (Sunday) to 6 (Saturday).')
  const weekdays = recurrence === 'weekly' ? [...new Set(rawDays as number[])].sort() : []
  if (recurrence === 'weekly' && weekdays.length === 0) throw bad('Choose at least one day.')
  return { recurrence, startDate, startTime, weekdays, timezone }
}

/** Validates a whole schedule (a create, or an edit laid over the current one). Throws ScheduleError(400). */
export function parseScheduleInput(body: Record<string, unknown>, base?: ScheduleInput): ScheduleInput {
  const pick = <K extends keyof ScheduleInput>(k: K): unknown => (body[k] !== undefined ? body[k] : base?.[k])
  const bad = (message: string) => new ScheduleError(400, 'bad_schedule', message)
  const presetId = pick('presetId')
  if (typeof presetId !== 'string' || !UUID_RE.test(presetId)) throw bad('Choose a preset.')
  const { recurrence, startDate, startTime, timezone, weekdays } = parseWhen(pick as (k: keyof WhenFields) => unknown, bad)
  const duration = pick('durationMinutes') ?? null
  if (duration !== null && (!Number.isInteger(duration) || (duration as number) < 1 || (duration as number) > MAX_DURATION_MINUTES)) {
    throw bad('The length must be 1 minute to 7 days, or none (stays live until the next switch).')
  }
  if (recurrence === 'daily' && duration !== null && (duration as number) > 24 * 60) throw bad('A daily schedule can last up to 24 hours.')
  const returnTo = pick('returnToPresetId') ?? null
  if (returnTo !== null && (typeof returnTo !== 'string' || !UUID_RE.test(returnTo))) throw bad('Choose a preset to return to.')
  const enabled = pick('enabled') ?? true
  if (typeof enabled !== 'boolean') throw bad('enabled must be true or false.')
  const eventId = pick('eventId') ?? null
  if (eventId !== null && (typeof eventId !== 'string' || !UUID_RE.test(eventId))) throw bad('Choose an event.')
  return { presetId, recurrence, startDate, startTime, weekdays, durationMinutes: duration as number | null, timezone, returnToPresetId: returnTo as string | null, enabled, eventId: eventId as string | null }
}

// ── Schedules that follow an event ──────────────────────────────────────────

type EventTimes = Pick<typeof events.$inferSelect, 'startTime' | 'endTime' | 'timezone'>
type TimeFields = Pick<ScheduleInput, 'recurrence' | 'startDate' | 'startTime' | 'weekdays' | 'durationMinutes' | 'timezone'>

/** A one-off run over the event's start and end, in the event's timezone; null when the event can't be one. */
export function eventTimes(e: EventTimes): TimeFields | null {
  if (!e.startTime || !e.endTime || e.endTime <= e.startTime) return null
  const minutes = Math.round((e.endTime.getTime() - e.startTime.getTime()) / 60_000)
  if (minutes < 1 || minutes > MAX_DURATION_MINUTES) return null
  const tz = e.timezone && isTimeZone(e.timezone) ? e.timezone : 'UTC'
  const { date, time } = utcToZoned(e.startTime, tz)
  return { recurrence: 'once', startDate: date, startTime: time, weekdays: [], durationMinutes: minutes, timezone: tz }
}

/** The input with its times taken from its event, which must be linked to the scene. Throws ScheduleError(400). */
export async function withEventTimes(sceneId: string, input: ScheduleInput): Promise<ScheduleInput> {
  if (!input.eventId) return input
  const [link] = await db.select({ e: events }).from(eventSceneLinks).innerJoin(events, eq(eventSceneLinks.eventId, events.id))
    .where(and(eq(eventSceneLinks.sceneId, sceneId), eq(eventSceneLinks.eventId, input.eventId)))
  if (!link) throw new ScheduleError(400, 'bad_schedule', 'Link the event to this scene first.')
  const times = eventTimes(link.e)
  if (!times) throw new ScheduleError(400, 'bad_schedule', 'The event needs a start and an end time.')
  return { ...input, ...times }
}

/**
 * After an event's times change: every schedule following it moves with it. One whose event no longer has usable
 * times is paused (and resumes when they come back). Clashes aren't re-checked: the event's time is the host's choice.
 */
export async function syncEventSchedules(eventId: string): Promise<void> {
  const event = await db.query.events.findFirst({ where: eq(events.id, eventId) })
  if (!event) return
  const times = eventTimes(event)
  const rows = await db.select().from(scenePresetSchedules).where(eq(scenePresetSchedules.eventId, eventId))
  for (const s of rows) {
    const set = times ? { ...times, enabled: true, updatedAt: new Date() } : { enabled: false, updatedAt: new Date() }
    await db.update(scenePresetSchedules).set(set).where(eq(scenePresetSchedules.id, s.id))
    if (!times || s.startDate !== times.startDate || s.startTime !== times.startTime || s.durationMinutes !== times.durationMinutes || s.timezone !== times.timezone) {
      // The old window is gone: end a run in progress (the live preset stays as it is; the sweep starts the new one)
      await db.update(scenePresetScheduleRuns).set({ status: 'ended', endedAt: new Date(), outcome: 'event times changed' })
        .where(and(eq(scenePresetScheduleRuns.scheduleId, s.id), inArray(scenePresetScheduleRuns.status, ['active', 'held'])))
    }
  }
}

/** Unlinking a scene from an event removes the schedules that only existed for that event there. */
export async function dropEventSchedules(eventId: string, sceneId: string): Promise<void> {
  await db.delete(scenePresetSchedules).where(and(eq(scenePresetSchedules.eventId, eventId), eq(scenePresetSchedules.sceneId, sceneId)))
}

/** The schedules following an event, with their preset names, for the event page. */
export async function eventPresetSchedules(eventId: string) {
  return db.select({
    id: scenePresetSchedules.id, sceneId: scenePresetSchedules.sceneId, presetId: scenePresetSchedules.presetId,
    presetName: scenePresets.name, enabled: scenePresetSchedules.enabled,
  }).from(scenePresetSchedules).innerJoin(scenePresets, eq(scenePresetSchedules.presetId, scenePresets.id))
    .where(eq(scenePresetSchedules.eventId, eventId)).orderBy(scenePresetSchedules.createdAt)
}

function overlaps(a: Occurrence, b: Occurrence): boolean {
  // Open-ended runs give way to the next start, so only a shared start time clashes with them
  if (!a.end || !b.end) return a.start.getTime() === b.start.getTime() || (!!a.end && b.start >= a.start && b.start < a.end) || (!!b.end && a.start >= b.start && a.start < b.end)
  return a.start < b.end && b.start < a.end
}

/** The first enabled schedule of the scene that `input` would clash with, over the next ~5 weeks of both. */
export async function findClash(sceneId: string, input: ScheduleInput, now: Date, ignoreId?: string): Promise<ScheduleRow | null> {
  if (!input.enabled) return null
  const others = await db.select().from(scenePresetSchedules)
    .where(and(eq(scenePresetSchedules.sceneId, sceneId), eq(scenePresetSchedules.enabled, true), ignoreId ? ne(scenePresetSchedules.id, ignoreId) : undefined))
  if (others.length === 0) return null
  const mine = specOf(input as ScheduleRow)
  const firstStart = (s: ScheduleSpec) => Date.parse(`${s.startDate}T00:00:00Z`)
  for (const other of others) {
    const theirs = specOf(other)
    const from = new Date(Math.max(now.getTime(), Math.min(firstStart(mine), firstStart(theirs))) - 8 * DAY)
    const to = new Date(Math.max(now.getTime(), firstStart(mine), firstStart(theirs)) + 36 * DAY)
    const a = occurrencesBetween(mine, from, to)
    const b = occurrencesBetween(theirs, from, to)
    if (a.some((x) => b.some((y) => overlaps(x, y)))) return other
  }
  return null
}

/** "Concert, Fridays at 20:00 (Europe/London)" */
export function describeSchedule(s: ScheduleSpec, presetName: string): string {
  const days = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']
  const when = s.recurrence === 'once' ? `on ${s.startDate}` : s.recurrence === 'daily' ? 'daily' : s.weekdays.map((d) => days[d]).join(', ')
  return `${presetName}, ${when} at ${s.startTime} (${s.timezone})`
}

/** Whether the schedule still has a run to come, or one in progress. */
export function stillScheduled(s: ScheduleRow, now: Date): boolean {
  if (!s.enabled) return false
  if (s.recurrence !== 'once') return true
  const o = latestStart(specOf(s), now)
  return !o || o.end === null || o.end > now
}

/** The next `n` runs, passing over the starts in `skipped` (ms; runs skipped ahead of time). */
export function nextRunsOf(s: ScheduleRow, now: Date, n = 5, skipped: ReadonlySet<number> = new Set()): string[] {
  if (!s.enabled) return []
  return nextStarts(specOf(s), now, n + skipped.size).filter((d) => !skipped.has(d.getTime())).slice(0, n).map((d) => d.toISOString())
}

// ── Skipping a run ahead of time ─────────────────────────────────────────────
// A skipped run is a run row with status 'skipped' made before its start: the sweep starts each occurrence only
// once per (schedule, start), so it passes over it. Undoing it deletes the row.

export const SKIPPED_BY_HAND = 'skipped by hand'

/** Upcoming starts (after `now`) that already have a run row, so won't start: schedule id → start ms. */
export async function skippedStarts(scheduleIds: string[], now: Date): Promise<Map<string, Set<number>>> {
  const out = new Map<string, Set<number>>()
  if (scheduleIds.length === 0) return out
  const rows = await db.select({ scheduleId: scenePresetScheduleRuns.scheduleId, start: scenePresetScheduleRuns.occurrenceStart })
    .from(scenePresetScheduleRuns)
    .where(and(inArray(scenePresetScheduleRuns.scheduleId, scheduleIds), gt(scenePresetScheduleRuns.occurrenceStart, now)))
  for (const r of rows) {
    if (!out.has(r.scheduleId)) out.set(r.scheduleId, new Set())
    out.get(r.scheduleId)!.add(r.start.getTime())
  }
  return out
}

/** A schedule as the API returns it: its next runs (skipped ones left out) and the runs skipped ahead. */
export function withRuns(s: ScheduleRow, now: Date, skipped: ReadonlySet<number> = new Set()) {
  // Only starts that are still runs of it (an edit to its time leaves older skips behind, which never match)
  const real = s.enabled ? [...skipped].filter((ms) => occurrencesBetween(specOf(s), new Date(ms), new Date(ms)).length > 0) : []
  return { ...s, nextRuns: nextRunsOf(s, now, 5, skipped), skippedRuns: real.sort((a, b) => a - b).map((ms) => new Date(ms).toISOString()) }
}

/** Skip one upcoming run: the one starting at `start`, or the next one not already skipped. Returns its start. */
export async function skipRun(s: ScheduleRow, start: Date | null, now = new Date()): Promise<Date> {
  const skipped = (await skippedStarts([s.id], now)).get(s.id) ?? new Set<number>()
  let occ: Occurrence | undefined
  if (start) {
    if (start <= now) throw new ScheduleError(400, 'not_a_run', "That isn't one of this schedule's runs.")
    occ = occurrencesBetween(specOf(s), start, start).find((o) => o.start.getTime() === start.getTime())
    if (!occ) throw new ScheduleError(400, 'not_a_run', "That isn't one of this schedule's runs.")
  } else {
    const [next] = nextRunsOf(s, now, 1, skipped)
    if (next) occ = occurrencesBetween(specOf(s), new Date(next), new Date(next))[0]
    if (!occ) throw new ScheduleError(400, 'not_a_run', 'This schedule has no run coming up to skip.')
  }
  const [row] = await db.insert(scenePresetScheduleRuns)
    .values({ scheduleId: s.id, sceneId: s.sceneId, occurrenceStart: occ.start, occurrenceEnd: occ.end, status: 'skipped', outcome: SKIPPED_BY_HAND })
    .onConflictDoNothing().returning({ id: scenePresetScheduleRuns.id })
  if (!row) throw new ScheduleError(409, 'already_skipped', 'That run is already skipped.')
  return occ.start
}

/** Undo a skip that hasn't come round yet. False when there was none. */
export async function unskipRun(s: ScheduleRow, start: Date, now = new Date()): Promise<boolean> {
  if (start <= now) return false
  const gone = await db.delete(scenePresetScheduleRuns)
    .where(and(eq(scenePresetScheduleRuns.scheduleId, s.id), eq(scenePresetScheduleRuns.occurrenceStart, start), eq(scenePresetScheduleRuns.status, 'skipped')))
    .returning({ id: scenePresetScheduleRuns.id })
  return gone.length > 0
}

// ── The sweep ────────────────────────────────────────────────────────────────

async function liveBookingScenes(sceneIds: string[]): Promise<Set<string>> {
  if (sceneIds.length === 0) return new Set()
  const rows = await db.select({ sceneId: venues.sceneId }).from(bookings).innerJoin(venues, eq(bookings.venueId, venues.id))
    .where(and(eq(bookings.status, 'live'), inArray(venues.sceneId, sceneIds)))
  return new Set(rows.map((r) => r.sceneId))
}

async function presetOfScene(sceneId: string, presetId: string | null): Promise<string | null> {
  if (!presetId) return null
  const p = await db.query.scenePresets.findFirst({ where: and(eq(scenePresets.id, presetId), eq(scenePresets.sceneId, sceneId)), columns: { id: true } })
  return p?.id ?? null
}

async function announce(sceneId: string, presetId: string) {
  try {
    await publishVenueEvent({ type: 'preset_changed', sceneId, presetId })
  } catch (err) {
    console.error('[preset-schedules] preset_changed publish failed:', err)
  }
}

export interface SweepResult { started: string[]; ended: string[]; held: string[]; resumed: string[]; overridden: string[]; skipped: string[] }

export async function runPresetScheduleSweep(at = new Date()): Promise<SweepResult> {
  const result: SweepResult = { started: [], ended: [], held: [], resumed: [], overridden: [], skipped: [] }

  // ── Runs in progress: end, hold for a booking, resume after one, or notice a manual switch ──
  const open = await db.select({ run: scenePresetScheduleRuns, schedule: scenePresetSchedules, activePresetId: scenes.activePresetId })
    .from(scenePresetScheduleRuns)
    .innerJoin(scenePresetSchedules, eq(scenePresetScheduleRuns.scheduleId, scenePresetSchedules.id))
    .innerJoin(scenes, eq(scenePresetScheduleRuns.sceneId, scenes.id))
    .where(inArray(scenePresetScheduleRuns.status, ['active', 'held']))
  const booked = await liveBookingScenes([...new Set(open.map((o) => o.run.sceneId))])

  for (const { run, schedule, activePresetId } of open) {
    const claim = (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], set: Partial<RunRow>) =>
      tx.update(scenePresetScheduleRuns).set(set).where(and(eq(scenePresetScheduleRuns.id, run.id), eq(scenePresetScheduleRuns.status, run.status))).returning({ id: scenePresetScheduleRuns.id })

    if (run.occurrenceEnd && run.occurrenceEnd <= at) {
      const target = await presetOfScene(run.sceneId, schedule.returnToPresetId ?? run.previousPresetId)
      const switched = await db.transaction(async (tx) => {
        const [won] = await claim(tx, { status: 'ended', endedAt: at, outcome: 'finished' })
        if (!won || run.status !== 'active' || !target || booked.has(run.sceneId)) return null
        // Only switch back if the scheduled preset is still the live one
        const [moved] = await tx.update(scenes).set({ activePresetId: target, updatedAt: at })
          .where(and(eq(scenes.id, run.sceneId), eq(scenes.activePresetId, schedule.presetId))).returning({ id: scenes.id })
        return moved ? target : null
      })
      result.ended.push(run.id)
      if (switched) await announce(run.sceneId, switched)
      continue
    }

    if (booked.has(run.sceneId)) {
      if (run.status === 'active') {
        const won = await db.transaction(async (tx) => (await claim(tx, { status: 'held', outcome: 'held for a booking' }))[0])
        if (won) result.held.push(run.id)
      }
      continue
    }

    if (run.status === 'held') {
      // The booking is over and the window is still open: apply the schedule now
      const won = await db.transaction(async (tx) => {
        const [w] = await claim(tx, { status: 'active', outcome: 'resumed after a booking' })
        if (!w) return null
        await tx.update(scenes).set({ activePresetId: schedule.presetId, updatedAt: at }).where(eq(scenes.id, run.sceneId))
        return w
      })
      if (won) {
        result.resumed.push(run.id)
        await announce(run.sceneId, schedule.presetId)
      }
      continue
    }

    if (activePresetId !== schedule.presetId) {
      const won = await db.transaction(async (tx) => (await claim(tx, { status: 'overridden', endedAt: at, outcome: 'switched manually' }))[0])
      if (won) result.overridden.push(run.id)
    }
  }

  // ── Due starts ──
  const schedules = await db.select({ schedule: scenePresetSchedules, activePresetId: scenes.activePresetId })
    .from(scenePresetSchedules)
    .innerJoin(scenes, eq(scenePresetSchedules.sceneId, scenes.id))
    .where(eq(scenePresetSchedules.enabled, true))
  const bookedNow = await liveBookingScenes([...new Set(schedules.map((s) => s.schedule.sceneId))])

  for (const { schedule } of schedules) {
    const occ = latestStart(specOf(schedule), at)
    if (!occ) continue
    const existing = await db.query.scenePresetScheduleRuns.findFirst({
      where: and(eq(scenePresetScheduleRuns.scheduleId, schedule.id), eq(scenePresetScheduleRuns.occurrenceStart, occ.start)),
      columns: { id: true },
    })
    if (existing) continue

    const windowOpen = occ.end === null || occ.end > at
    if (!windowOpen) {
      // Missed while the server was down (or held by a booking until it closed): log it, once
      if (occ.start >= schedule.createdAt) {
        const [row] = await db.insert(scenePresetScheduleRuns)
          .values({ scheduleId: schedule.id, sceneId: schedule.sceneId, occurrenceStart: occ.start, occurrenceEnd: occ.end, status: 'skipped', outcome: 'window passed before it could start' })
          .onConflictDoNothing().returning({ id: scenePresetScheduleRuns.id })
        if (row) result.skipped.push(row.id)
      }
      continue
    }
    if (bookedNow.has(schedule.sceneId)) continue // bookings win; it starts once the booking ends, if still open

    const started = await db.transaction(async (tx) => {
      const scene = await tx.query.scenes.findFirst({ where: eq(scenes.id, schedule.sceneId), columns: { activePresetId: true } })
      const [row] = await tx.insert(scenePresetScheduleRuns)
        .values({
          scheduleId: schedule.id, sceneId: schedule.sceneId, occurrenceStart: occ.start, occurrenceEnd: occ.end,
          status: 'active', previousPresetId: scene?.activePresetId ?? null, startedAt: at, outcome: occ.start < new Date(at.getTime() - 60_000) ? 'started late' : null,
        })
        .onConflictDoNothing()
        .returning({ id: scenePresetScheduleRuns.id })
      if (!row) return null
      // A newer run takes over from any other run still open on this scene
      await tx.update(scenePresetScheduleRuns).set({ status: 'ended', endedAt: at, outcome: 'superseded by the next schedule' })
        .where(and(eq(scenePresetScheduleRuns.sceneId, schedule.sceneId), inArray(scenePresetScheduleRuns.status, ['active', 'held']), ne(scenePresetScheduleRuns.id, row.id)))
      await tx.update(scenes).set({ activePresetId: schedule.presetId, updatedAt: at }).where(eq(scenes.id, schedule.sceneId))
      return { id: row.id, changed: scene?.activePresetId !== schedule.presetId }
    })
    if (!started) continue
    result.started.push(started.id)
    if (started.changed) await announce(schedule.sceneId, schedule.presetId)
  }

  return result
}

// ── Why the live preset is live (shown in the preset bar) ───────────────────────

export type LiveReason =
  | { kind: 'none' }
  | { kind: 'booking'; title: string; until: string }
  | { kind: 'schedule'; scheduleId: string; until: string | null }
  | { kind: 'manual' }

export interface LiveStatus {
  reason: LiveReason
  /** The next switch the schedules will make; presetId null when it returns to a preset that no longer exists. */
  nextSwitch: { at: string; presetId: string | null; scheduleId: string } | null
}

/**
 * Why the scene's live preset is live, and the next scheduled switch. A live booking comes first; then a schedule's
 * run in progress; a run the host switched away from (whether or not the sweep has noticed yet) reads as "switched
 * manually" until its window closes.
 */
export async function liveStatus(sceneId: string, now = new Date()): Promise<LiveStatus> {
  const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId), columns: { activePresetId: true } })
  const rows = await db.select().from(scenePresetSchedules).where(and(eq(scenePresetSchedules.sceneId, sceneId), eq(scenePresetSchedules.enabled, true)))
  const runs = await db.select({ run: scenePresetScheduleRuns, presetId: scenePresetSchedules.presetId, returnTo: scenePresetSchedules.returnToPresetId })
    .from(scenePresetScheduleRuns)
    .innerJoin(scenePresetSchedules, eq(scenePresetScheduleRuns.scheduleId, scenePresetSchedules.id))
    .where(and(eq(scenePresetScheduleRuns.sceneId, sceneId), inArray(scenePresetScheduleRuns.status, ['active', 'held', 'overridden'])))
    .orderBy(desc(scenePresetScheduleRuns.occurrenceStart))
  const open = runs.find((r) => r.run.status !== 'overridden')
  const windowOpen = (r: RunRow) => r.occurrenceEnd === null || r.occurrenceEnd > now

  const [booking] = await db.select({ title: bookings.title, endsAt: bookings.endsAt }).from(bookings).innerJoin(venues, eq(bookings.venueId, venues.id))
    .where(and(eq(bookings.status, 'live'), eq(venues.sceneId, sceneId))).limit(1)

  let reason: LiveReason = { kind: 'none' }
  let ending: LiveStatus['nextSwitch'] = null
  if (booking) {
    reason = { kind: 'booking', title: booking.title, until: booking.endsAt.toISOString() }
  } else if (open?.run.status === 'active' && scene?.activePresetId === open.presetId) {
    const until = open.run.occurrenceEnd?.toISOString() ?? null
    reason = { kind: 'schedule', scheduleId: open.run.scheduleId, until }
    if (until) {
      const back = await presetOfScene(sceneId, open.returnTo ?? open.run.previousPresetId)
      ending = { at: until, presetId: back, scheduleId: open.run.scheduleId }
    }
  } else if (runs.some((r) => windowOpen(r.run) && (r.run.status === 'overridden' || (r.run.status === 'active' && scene?.activePresetId !== r.presetId)))) {
    reason = { kind: 'manual' }
  }

  let next: LiveStatus['nextSwitch'] = ending
  const skipped = await skippedStarts(rows.map((s) => s.id), now)
  for (const s of rows) {
    const [start] = nextRunsOf(s, now, 1, skipped.get(s.id))
    if (start && (!next || Date.parse(start) < Date.parse(next.at))) next = { at: start, presetId: s.presetId, scheduleId: s.id }
  }
  return { reason, nextSwitch: next }
}

/** `skipped`: it won't run (skipped ahead of time, or already logged as skipped). */
export interface WeekOccurrence { scheduleId: string; presetId: string; start: string; end: string | null; skipped: boolean }

/** Every enabled schedule's occurrences starting within [from, to], in start order: the dashboard's week view. */
export async function weekOccurrences(sceneId: string, from: Date, to: Date): Promise<WeekOccurrence[]> {
  const rows = await db.select().from(scenePresetSchedules).where(and(eq(scenePresetSchedules.sceneId, sceneId), eq(scenePresetSchedules.enabled, true)))
  const skipped = rows.length
    ? await db.select({ scheduleId: scenePresetScheduleRuns.scheduleId, start: scenePresetScheduleRuns.occurrenceStart }).from(scenePresetScheduleRuns)
      .where(and(inArray(scenePresetScheduleRuns.scheduleId, rows.map((s) => s.id)), eq(scenePresetScheduleRuns.status, 'skipped')))
    : []
  const isSkipped = new Set(skipped.map((r) => `${r.scheduleId}@${r.start.getTime()}`))
  return rows
    .flatMap((s) => occurrencesBetween(specOf(s), from, to).map((o) => ({
      scheduleId: s.id, presetId: s.presetId, start: o.start.toISOString(), end: o.end?.toISOString() ?? null, skipped: isSkipped.has(`${s.id}@${o.start.getTime()}`),
    })))
    .sort((a, b) => a.start.localeCompare(b.start))
}

/** The scene's schedules (with their next runs) and its recent run history, newest first. */
export async function listSchedules(sceneId: string, now = new Date()) {
  const rows = await db.select().from(scenePresetSchedules).where(eq(scenePresetSchedules.sceneId, sceneId)).orderBy(scenePresetSchedules.createdAt)
  const runs = await db.select().from(scenePresetScheduleRuns).where(eq(scenePresetScheduleRuns.sceneId, sceneId))
    .orderBy(desc(scenePresetScheduleRuns.occurrenceStart)).limit(20)
  const skipped = await skippedStarts(rows.map((s) => s.id), now)
  return { schedules: rows.map((s) => withRuns(s, now, skipped.get(s.id))), runs, status: await liveStatus(sceneId, now), week: await weekOccurrences(sceneId, new Date(now.getTime() - DAY), new Date(now.getTime() + 8 * DAY)) }
}

/** Enabled schedules that still have runs to come and use the preset (as theirs or as where they return to). */
export async function schedulesUsingPreset(presetId: string, now = new Date()): Promise<ScheduleRow[]> {
  const rows = await db.select().from(scenePresetSchedules)
    .where(or(eq(scenePresetSchedules.presetId, presetId), eq(scenePresetSchedules.returnToPresetId, presetId)))
  return rows.filter((s) => stillScheduled(s, now))
}
