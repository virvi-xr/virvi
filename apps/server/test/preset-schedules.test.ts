import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DEFAULT_VENUE_RULES, VENUE_ROLE_SCOPES } from '@virvixr/shared'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { accessGrants, bookings, sceneCollaborators, scenePresets, scenePresetScheduleRuns, scenePresetSchedules, scenes, venues } from '../src/db/schema.js'
import { listSchedules, liveStatus, runPresetScheduleSweep, weekOccurrences } from '../src/scenes/preset-schedules.js'
import { initBus } from '../src/realtime/bus.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, testApp, tokenFor, type TestUser } from './helpers/factories.js'

const H = 3600_000
const M = 60_000

describe('scheduled presets (LIV-86)', () => {
  let host: TestUser
  let scene: Awaited<ReturnType<typeof createScene>>['scene']
  let day: Awaited<ReturnType<typeof createScene>>['preset']
  let concert: typeof scenePresets.$inferSelect
  let published: any[]

  beforeEach(async () => {
    await resetDb()
    published = []
    initBus({ publish: (_t: string, d: unknown) => { published.push(d) }, subscribe: () => {}, unsubscribe: () => {} })
    host = await createUser()
    ;({ scene, preset: day } = await createScene(host))
    ;[concert] = await db.insert(scenePresets).values({ sceneId: scene.id, name: 'Concert' }).returning()
  })
  afterEach(() => { initBus(null as any) })

  const live = async () => (await db.query.scenes.findFirst({ where: eq(scenes.id, scene.id) }))!.activePresetId
  const runs = () => db.select().from(scenePresetScheduleRuns)
  const switches = () => published.filter((e) => e?.type === 'preset_changed').map((e) => e.presetId)
  async function schedule(v: Partial<typeof scenePresetSchedules.$inferInsert>) {
    const [s] = await db.insert(scenePresetSchedules).values({
      sceneId: scene.id, presetId: concert.id, recurrence: 'once', startDate: '2026-11-06', startTime: '20:00',
      durationMinutes: 180, timezone: 'UTC', createdAt: new Date('2026-11-01T00:00:00Z'), ...v,
    }).returning()
    return s
  }
  async function liveBooking(startsAt: Date, endsAt: Date, status: 'live' | 'ended' = 'live') {
    const [venue] = await db.insert(venues).values({ sceneId: scene.id, name: 'V', slug: `v-${crypto.randomUUID()}`, defaultPresetId: day.id, rules: DEFAULT_VENUE_RULES, rentableElementIds: [] }).returning()
    const [b] = await db.insert(bookings).values({ venueId: venue.id, renterUserId: host.id, title: 'Show', startsAt, endsAt, status, blockedRange: `[${startsAt.toISOString()},${endsAt.toISOString()})` }).returning()
    return b
  }

  describe('the sweep', () => {
    it('starts a one-off schedule on time, ends it on time and returns to the previous preset', async () => {
      await schedule({})
      await runPresetScheduleSweep(new Date('2026-11-06T19:59:00Z'))
      expect(await live()).toBe(day.id)
      await runPresetScheduleSweep(new Date('2026-11-06T20:00:03Z'))
      expect(await live()).toBe(concert.id)
      await runPresetScheduleSweep(new Date('2026-11-06T22:59:00Z'))
      expect(await live()).toBe(concert.id)
      await runPresetScheduleSweep(new Date('2026-11-06T23:00:02Z'))
      expect(await live()).toBe(day.id)
      expect(switches()).toEqual([concert.id, day.id])
      const [run] = await runs()
      expect(run).toMatchObject({ status: 'ended', outcome: 'finished', previousPresetId: day.id })
    })

    it('returns to the chosen preset instead, when one is set', async () => {
      const [night] = await db.insert(scenePresets).values({ sceneId: scene.id, name: 'Night' }).returning()
      await schedule({ returnToPresetId: night.id })
      await runPresetScheduleSweep(new Date('2026-11-06T20:00:00Z'))
      await runPresetScheduleSweep(new Date('2026-11-06T23:00:00Z'))
      expect(await live()).toBe(night.id)
    })

    it('a daily schedule keeps its local time across a daylight-saving change', async () => {
      await schedule({ recurrence: 'daily', startDate: '2026-03-06', startTime: '19:00', durationMinutes: 60, timezone: 'America/New_York' })
      await runPresetScheduleSweep(new Date('2026-03-07T00:00:10Z')) // Mar 6, 19:00 EST
      expect(await live()).toBe(concert.id)
      await runPresetScheduleSweep(new Date('2026-03-07T01:00:10Z'))
      expect(await live()).toBe(day.id)
      await runPresetScheduleSweep(new Date('2026-03-08T23:00:10Z')) // Mar 8, 19:00 EDT
      expect(await live()).toBe(concert.id)
      const starts = (await runs()).map((r) => r.occurrenceStart.toISOString()).sort()
      expect(starts).toEqual(['2026-03-07T00:00:00.000Z', '2026-03-08T23:00:00.000Z'])
    })

    it('two servers sweeping at once apply a run only once', async () => {
      await schedule({})
      const at = new Date('2026-11-06T20:00:05Z')
      await Promise.all([runPresetScheduleSweep(at), runPresetScheduleSweep(at), runPresetScheduleSweep(at)])
      expect(await runs()).toHaveLength(1)
      expect(switches()).toEqual([concert.id])
    })

    it("a live booking holds a schedule back; it applies after the booking if its window is still open", async () => {
      const b = await liveBooking(new Date('2026-11-06T19:00:00Z'), new Date('2026-11-06T21:00:00Z'))
      await schedule({})
      await runPresetScheduleSweep(new Date('2026-11-06T20:00:00Z'))
      expect(await live()).toBe(day.id)
      expect(await runs()).toHaveLength(0)
      await db.update(bookings).set({ status: 'ended' }).where(eq(bookings.id, b.id))
      await runPresetScheduleSweep(new Date('2026-11-06T21:00:05Z'))
      expect(await live()).toBe(concert.id)
    })

    it('a booking that starts during a run holds it, and the run resumes when the booking ends', async () => {
      await schedule({})
      await runPresetScheduleSweep(new Date('2026-11-06T20:00:00Z'))
      const b = await liveBooking(new Date('2026-11-06T20:30:00Z'), new Date('2026-11-06T21:30:00Z'))
      await db.update(scenes).set({ activePresetId: day.id }).where(eq(scenes.id, scene.id)) // the booking's preset
      await runPresetScheduleSweep(new Date('2026-11-06T20:31:00Z'))
      expect((await runs())[0].status).toBe('held')
      await db.update(bookings).set({ status: 'ended' }).where(eq(bookings.id, b.id))
      await runPresetScheduleSweep(new Date('2026-11-06T21:31:00Z'))
      expect(await live()).toBe(concert.id)
      expect((await runs())[0]).toMatchObject({ status: 'active', outcome: 'resumed after a booking' })
    })

    it('a manual switch overrides the run in progress, and the next run still applies', async () => {
      await schedule({ recurrence: 'daily', startDate: '2026-11-06' })
      await runPresetScheduleSweep(new Date('2026-11-06T20:00:00Z'))
      await db.update(scenes).set({ activePresetId: day.id }).where(eq(scenes.id, scene.id)) // host switches by hand
      await runPresetScheduleSweep(new Date('2026-11-06T20:10:00Z'))
      expect((await runs())[0]).toMatchObject({ status: 'overridden', outcome: 'switched manually' })
      await runPresetScheduleSweep(new Date('2026-11-06T23:00:00Z'))
      expect(await live()).toBe(day.id) // not switched back over the host's choice, and not re-applied
      await runPresetScheduleSweep(new Date('2026-11-07T20:00:00Z'))
      expect(await live()).toBe(concert.id)
    })

    it('a missed start with the window still open starts late', async () => {
      await schedule({})
      await runPresetScheduleSweep(new Date('2026-11-06T21:30:00Z')) // server was down at 20:00
      expect(await live()).toBe(concert.id)
      expect((await runs())[0].outcome).toBe('started late')
    })

    it('a window that passed entirely is skipped and logged once', async () => {
      await schedule({})
      await runPresetScheduleSweep(new Date('2026-11-07T01:00:00Z')) // down through the whole window
      expect(await live()).toBe(day.id)
      expect((await runs())[0]).toMatchObject({ status: 'skipped' })
      await runPresetScheduleSweep(new Date('2026-11-07T01:00:10Z'))
      expect(await runs()).toHaveLength(1)
    })

    it('an open-ended schedule stays live until the next one takes over', async () => {
      const [night] = await db.insert(scenePresets).values({ sceneId: scene.id, name: 'Night' }).returning()
      await schedule({ durationMinutes: null })
      await schedule({ presetId: night.id, startDate: '2026-11-08', startTime: '20:00', durationMinutes: null })
      await runPresetScheduleSweep(new Date('2026-11-06T20:00:00Z'))
      await runPresetScheduleSweep(new Date('2026-11-07T20:00:00Z'))
      expect(await live()).toBe(concert.id)
      await runPresetScheduleSweep(new Date('2026-11-08T20:00:00Z'))
      expect(await live()).toBe(night.id)
      const all = await runs()
      expect(all.find((r) => r.status === 'ended')?.outcome).toBe('superseded by the next schedule')
    })

    it('ignores paused schedules', async () => {
      await schedule({ enabled: false })
      await runPresetScheduleSweep(new Date('2026-11-06T20:00:00Z'))
      expect(await live()).toBe(day.id)
    })
  })

  describe('why the live preset is live', () => {
    const at = (iso: string) => new Date(iso)

    it('says nothing when no schedule or booking is involved', async () => {
      expect(await liveStatus(scene.id, at('2026-11-06T12:00:00Z'))).toEqual({ reason: { kind: 'none' }, nextSwitch: null })
    })

    it('before a run: the next switch is its start, to its preset', async () => {
      const s = await schedule({})
      expect(await liveStatus(scene.id, at('2026-11-06T19:00:00Z'))).toEqual({
        reason: { kind: 'none' },
        nextSwitch: { at: '2026-11-06T20:00:00.000Z', presetId: concert.id, scheduleId: s.id },
      })
    })

    it('during a run: scheduled until its end, then back to the previous preset', async () => {
      const s = await schedule({})
      await runPresetScheduleSweep(at('2026-11-06T20:00:00Z'))
      expect(await liveStatus(scene.id, at('2026-11-06T21:00:00Z'))).toEqual({
        reason: { kind: 'schedule', scheduleId: s.id, until: '2026-11-06T23:00:00.000Z' },
        nextSwitch: { at: '2026-11-06T23:00:00.000Z', presetId: day.id, scheduleId: s.id },
      })
    })

    it('an open-ended run has no end; the next switch is the next schedule to start', async () => {
      const [night] = await db.insert(scenePresets).values({ sceneId: scene.id, name: 'Night' }).returning()
      const s = await schedule({ durationMinutes: null })
      const n = await schedule({ presetId: night.id, startDate: '2026-11-08', durationMinutes: null })
      await runPresetScheduleSweep(at('2026-11-06T20:00:00Z'))
      expect(await liveStatus(scene.id, at('2026-11-07T10:00:00Z'))).toEqual({
        reason: { kind: 'schedule', scheduleId: s.id, until: null },
        nextSwitch: { at: '2026-11-08T20:00:00.000Z', presetId: night.id, scheduleId: n.id },
      })
    })

    it('after a manual switch: switched manually, and the schedule resumes at its next run', async () => {
      const s = await schedule({ recurrence: 'daily' })
      await runPresetScheduleSweep(at('2026-11-06T20:00:00Z'))
      await db.update(scenes).set({ activePresetId: day.id }).where(eq(scenes.id, scene.id))
      const expected = {
        reason: { kind: 'manual' },
        nextSwitch: { at: '2026-11-07T20:00:00.000Z', presetId: concert.id, scheduleId: s.id },
      }
      expect(await liveStatus(scene.id, at('2026-11-06T20:05:00Z'))).toEqual(expected) // before the sweep notices
      await runPresetScheduleSweep(at('2026-11-06T20:10:00Z'))
      expect(await liveStatus(scene.id, at('2026-11-06T20:15:00Z'))).toEqual(expected)
      expect((await liveStatus(scene.id, at('2026-11-07T00:00:00Z'))).reason).toEqual({ kind: 'none' }) // window over
    })

    it('a live booking says so, with its end', async () => {
      await schedule({})
      await liveBooking(at('2026-11-06T18:00:00Z'), at('2026-11-06T21:30:00Z'))
      expect((await liveStatus(scene.id, at('2026-11-06T19:00:00Z'))).reason).toEqual({ kind: 'booking', title: 'Show', until: '2026-11-06T21:30:00.000Z' })
    })

    it('ignores paused schedules', async () => {
      await schedule({ enabled: false })
      expect((await liveStatus(scene.id, at('2026-11-06T19:00:00Z'))).nextSwitch).toBeNull()
    })
  })

  describe('skipping a run', () => {
    const at = (iso: string) => new Date(iso)
    const skipRow = (scheduleId: string, start: string) => db.insert(scenePresetScheduleRuns).values({
      scheduleId, sceneId: scene.id, occurrenceStart: at(start), occurrenceEnd: null, status: 'skipped', outcome: 'skipped by hand',
    })

    it('the sweep leaves a skipped run alone and starts the one after', async () => {
      const s = await schedule({ recurrence: 'daily', durationMinutes: 60 })
      await skipRow(s.id, '2026-11-06T20:00:00Z')
      await runPresetScheduleSweep(at('2026-11-06T20:00:05Z'))
      expect(await live()).toBe(day.id)
      await runPresetScheduleSweep(at('2026-11-07T20:00:05Z'))
      expect(await live()).toBe(concert.id)
    })

    it('the next switch, next runs and week view pass over it', async () => {
      const s = await schedule({ recurrence: 'daily', durationMinutes: 60 })
      await skipRow(s.id, '2026-11-06T20:00:00Z')
      expect((await liveStatus(scene.id, at('2026-11-06T12:00:00Z'))).nextSwitch).toEqual({ at: '2026-11-07T20:00:00.000Z', presetId: concert.id, scheduleId: s.id })
      const list = await listSchedules(scene.id, at('2026-11-06T12:00:00Z'))
      expect(list.schedules[0].nextRuns[0]).toBe('2026-11-07T20:00:00.000Z')
      expect(list.schedules[0].nextRuns).toHaveLength(5)
      expect(list.schedules[0].skippedRuns).toEqual(['2026-11-06T20:00:00.000Z'])
      const week = await weekOccurrences(scene.id, at('2026-11-06T12:00:00Z'), at('2026-11-07T23:00:00Z'))
      expect(week.map((o) => [o.start, o.skipped])).toEqual([['2026-11-06T20:00:00.000Z', true], ['2026-11-07T20:00:00.000Z', false]])
    })
  })

  describe('the week ahead', () => {
    it('lists every enabled occurrence starting in the window, with its end, in order', async () => {
      const [night] = await db.insert(scenePresets).values({ sceneId: scene.id, name: 'Night' }).returning()
      const daily = await schedule({ recurrence: 'daily', startDate: '2026-11-01', startTime: '19:00', durationMinutes: 60, timezone: 'America/New_York' })
      const open = await schedule({ presetId: night.id, startDate: '2026-11-07', startTime: '02:00', durationMinutes: null })
      await schedule({ startDate: '2026-11-06', startTime: '10:00', enabled: false })
      const week = await weekOccurrences(scene.id, new Date('2026-11-06T01:00:00Z'), new Date('2026-11-08T00:00:00Z'))
      expect(week).toEqual([
        { scheduleId: daily.id, presetId: concert.id, start: '2026-11-07T00:00:00.000Z', end: '2026-11-07T01:00:00.000Z', skipped: false }, // 19:00 EST on the 6th
        { scheduleId: open.id, presetId: night.id, start: '2026-11-07T02:00:00.000Z', end: null, skipped: false },
        { scheduleId: daily.id, presetId: concert.id, start: '2026-11-08T00:00:00.000Z', end: '2026-11-08T01:00:00.000Z', skipped: false },
      ])
    })
  })

  describe('routes', () => {
    let app: Awaited<ReturnType<typeof testApp>>
    beforeEach(async () => { app = await testApp() })
    afterEach(async () => { await app.close() })
    const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
    const body = (v: Record<string, unknown> = {}) => ({ presetId: concert.id, recurrence: 'weekly', weekdays: [5], startDate: '2030-01-01', startTime: '20:00', durationMinutes: 180, timezone: 'Europe/London', ...v })
    const create = (u: TestUser, v?: Record<string, unknown>) => app.inject({ method: 'POST', url: `/api/scenes/${scene.id}/preset-schedules`, headers: as(u), payload: body(v) })

    it('creates, lists with the next five runs, edits, pauses and deletes', async () => {
      const res = await create(host)
      expect(res.statusCode).toBe(201)
      const s = res.json().schedule
      expect(s.nextRuns).toHaveLength(5)
      expect(s.nextRuns[0]).toBe('2030-01-04T20:00:00.000Z') // first Friday of 2030, 20:00 GMT
      const list = (await app.inject({ method: 'GET', url: `/api/scenes/${scene.id}/preset-schedules`, headers: as(host) })).json()
      expect(list.status.reason).toEqual({ kind: 'none' })
      expect(list.schedules.map((x: any) => x.id)).toEqual([s.id])
      const paused = await app.inject({ method: 'PATCH', url: `/api/preset-schedules/${s.id}`, headers: as(host), payload: { enabled: false } })
      expect(paused.json().schedule).toMatchObject({ enabled: false, nextRuns: [], startTime: '20:00' })
      expect((await app.inject({ method: 'DELETE', url: `/api/preset-schedules/${s.id}`, headers: as(host) })).statusCode).toBe(204)
    })

    it('skips the next run, or a chosen one, and undoes it', async () => {
      const s = (await create(host)).json().schedule // Fridays 20:00 London from 2030
      const skip = (payload: Record<string, unknown> = {}, u = host) => app.inject({ method: 'POST', url: `/api/preset-schedules/${s.id}/skip`, headers: as(u), payload })
      const first = await skip()
      expect(first.statusCode).toBe(201)
      expect(first.json().skipped).toBe('2030-01-04T20:00:00.000Z')
      expect(first.json().schedule.nextRuns[0]).toBe('2030-01-11T20:00:00.000Z')
      expect(first.json().schedule.skippedRuns).toEqual(['2030-01-04T20:00:00.000Z'])
      // "Skip next" again moves on to the next one; a chosen one is skipped as given
      expect((await skip()).json().skipped).toBe('2030-01-11T20:00:00.000Z')
      expect((await skip({ occurrenceStart: '2030-02-01T20:00:00.000Z' })).json().skipped).toBe('2030-02-01T20:00:00.000Z')
      // Not one of its runs, already skipped, or in the past
      expect((await skip({ occurrenceStart: '2030-02-02T20:00:00.000Z' })).json()).toMatchObject({ error: 'not_a_run', message: "That isn't one of this schedule's runs." })
      expect((await skip({ occurrenceStart: '2030-02-01T20:00:00.000Z' })).statusCode).toBe(409)
      expect((await skip({ occurrenceStart: '2020-01-03T20:00:00.000Z' })).json()).toMatchObject({ error: 'not_a_run' })
      expect((await skip({ occurrenceStart: 'soon' })).statusCode).toBe(400)
      // Undo
      const undo = (start: string, u = host) => app.inject({ method: 'DELETE', url: `/api/preset-schedules/${s.id}/skip?occurrenceStart=${encodeURIComponent(start)}`, headers: as(u) })
      const undone = await undo('2030-01-04T20:00:00.000Z')
      expect(undone.statusCode).toBe(200)
      expect(undone.json().schedule.nextRuns[0]).toBe('2030-01-04T20:00:00.000Z')
      expect(undone.json().schedule.skippedRuns).toEqual(['2030-01-11T20:00:00.000Z', '2030-02-01T20:00:00.000Z'])
      expect((await undo('2030-01-04T20:00:00.000Z')).statusCode).toBe(404)
      // Moved to Saturdays: the Friday skips no longer show
      const moved = await app.inject({ method: 'PATCH', url: `/api/preset-schedules/${s.id}`, headers: as(host), payload: { weekdays: [6] } })
      expect(moved.json().schedule.skippedRuns).toEqual([])
      await app.inject({ method: 'PATCH', url: `/api/preset-schedules/${s.id}`, headers: as(host), payload: { weekdays: [5] } })
      // Viewers can't skip or undo
      const viewer = await createUser()
      await db.insert(sceneCollaborators).values({ sceneId: scene.id, userId: viewer.id, role: 'viewer' })
      expect((await skip({}, viewer)).statusCode).toBe(403)
      expect((await undo('2030-01-11T20:00:00.000Z', viewer)).statusCode).toBe(403)
    })

    it("the in-world HUD's scene pass can list and skip runs of its own scene only, not change schedules", async () => {
      const s = (await create(host)).json().schedule
      const pass = (sceneId: string) => ({ authorization: `Bearer ${tokenFor(host, { kind: 'scene', sceneId, orgId: null })}` })
      const mine = pass(scene.id)
      expect((await app.inject({ method: 'GET', url: `/api/scenes/${scene.id}/preset-schedules`, headers: mine })).statusCode).toBe(200)
      const skipped = await app.inject({ method: 'POST', url: `/api/preset-schedules/${s.id}/skip`, headers: mine, payload: {} })
      expect(skipped.statusCode).toBe(201)
      const undo = await app.inject({ method: 'DELETE', url: `/api/preset-schedules/${s.id}/skip?occurrenceStart=${encodeURIComponent(skipped.json().skipped)}`, headers: mine })
      expect(undo.statusCode).toBe(200)
      // Changing schedules stays on the dashboard
      expect((await app.inject({ method: 'PATCH', url: `/api/preset-schedules/${s.id}`, headers: mine, payload: { enabled: false } })).statusCode).toBe(403)
      expect((await app.inject({ method: 'DELETE', url: `/api/preset-schedules/${s.id}`, headers: mine })).statusCode).toBe(403)
      expect((await app.inject({ method: 'POST', url: `/api/scenes/${scene.id}/preset-schedules`, headers: mine, payload: body({ startDate: '2031-01-01' }) })).statusCode).toBe(403)
      // Another scene's pass gets nothing
      const other = await createScene(host, 'Other')
      const theirs = pass(other.scene.id)
      expect((await app.inject({ method: 'GET', url: `/api/scenes/${scene.id}/preset-schedules`, headers: theirs })).statusCode).toBe(403)
      expect((await app.inject({ method: 'POST', url: `/api/preset-schedules/${s.id}/skip`, headers: theirs, payload: {} })).statusCode).toBe(403)
    })

    it("a paused schedule has no next run to skip", async () => {
      const s = (await create(host, { enabled: false })).json().schedule
      const res = await app.inject({ method: 'POST', url: `/api/preset-schedules/${s.id}/skip`, headers: as(host), payload: {} })
      expect(res.json()).toMatchObject({ error: 'not_a_run', message: 'This schedule has no run coming up to skip.' })
    })

    it('validates the schedule with clear messages', async () => {
      const msg = async (v: Record<string, unknown>) => (await create(host, v)).json().message
      expect(await msg({ timezone: 'Mars/Base' })).toBe('Choose a timezone.')
      expect(await msg({ startTime: '25:00' })).toBe('The time must be HH:MM (24-hour).')
      expect(await msg({ weekdays: [] })).toBe('Choose at least one day.')
      expect(await msg({ recurrence: 'daily', durationMinutes: 1500 })).toBe('A daily schedule can last up to 24 hours.')
      const other = await createScene(host, 'Other')
      expect(await msg({ presetId: other.preset.id })).toBe('Use presets of this scene.')
    })

    it('refuses an overlapping schedule and names the one it clashes with', async () => {
      const first = (await create(host)).json().schedule
      const res = await create(host, { recurrence: 'once', startDate: '2030-01-11', startTime: '22:00', durationMinutes: 60, presetId: day.id })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ error: 'schedule_overlap', scheduleId: first.id, message: 'This overlaps the schedule "Concert, Fridays at 20:00 (Europe/London)".' })
      // Back to back is fine, and so is a paused clash
      expect((await create(host, { recurrence: 'once', startDate: '2030-01-11', startTime: '23:00', durationMinutes: 60 })).statusCode).toBe(201)
      expect((await create(host, { recurrence: 'once', startDate: '2030-01-11', startTime: '21:00', enabled: false })).statusCode).toBe(201)
    })

    it('a preset used by an upcoming schedule cannot be deleted', async () => {
      await create(host)
      const res = await app.inject({ method: 'DELETE', url: `/api/presets/${concert.id}`, headers: as(host) })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ error: 'preset_scheduled', message: 'The schedule "Concert, Fridays at 20:00 (Europe/London)" uses this preset.' })
    })

    it('host and editor can schedule; viewers, strangers and booking crew get 403', async () => {
      const editor = await createUser()
      await db.insert(sceneCollaborators).values({ sceneId: scene.id, userId: editor.id, role: 'editor' })
      const viewer = await createUser()
      await db.insert(sceneCollaborators).values({ sceneId: scene.id, userId: viewer.id, role: 'viewer' })
      const crew = await createUser()
      const b = await liveBooking(new Date(Date.now() - H), new Date(Date.now() + H))
      await db.insert(accessGrants).values({ bookingId: b.id, sceneId: scene.id, userId: crew.id, role: 'vj', scopes: [...new Set(Object.values(VENUE_ROLE_SCOPES).flat())] as any, validFrom: new Date(Date.now() - H), validUntil: new Date(Date.now() + H) })
      const stranger = await createUser()
      expect((await create(editor)).statusCode).toBe(201)
      const s = (await app.inject({ method: 'GET', url: `/api/scenes/${scene.id}/preset-schedules`, headers: as(editor) })).json().schedules[0]
      for (const u of [viewer, crew, stranger]) {
        expect((await create(u, { startDate: '2031-01-01' })).statusCode).toBe(403)
        expect((await app.inject({ method: 'GET', url: `/api/scenes/${scene.id}/preset-schedules`, headers: as(u) })).statusCode).toBe(403)
        expect((await app.inject({ method: 'PATCH', url: `/api/preset-schedules/${s.id}`, headers: as(u), payload: { enabled: false } })).statusCode).toBe(403)
        expect((await app.inject({ method: 'DELETE', url: `/api/preset-schedules/${s.id}`, headers: as(u) })).statusCode).toBe(403)
      }
      void M
    })
  })
})
