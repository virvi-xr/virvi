import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { events, eventSceneLinks, scenePresets, scenePresetSchedules } from '../src/db/schema.js'
import { utcToZoned } from '../src/scenes/schedule-time.js'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, testApp, tokenFor, type TestUser } from './helpers/factories.js'

describe('utcToZoned', () => {
  it('reads an instant as a local date and time', () => {
    expect(utcToZoned(new Date('2030-07-05T19:30:00Z'), 'Europe/London')).toEqual({ date: '2030-07-05', time: '20:30' })
    expect(utcToZoned(new Date('2030-01-04T01:00:00Z'), 'America/New_York')).toEqual({ date: '2030-01-03', time: '20:00' })
    expect(utcToZoned(new Date('2030-01-04T01:00:00Z'), 'UTC')).toEqual({ date: '2030-01-04', time: '01:00' })
  })
})

describe('scheduled presets linked to events (LIV-86)', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let host: TestUser
  let scene: Awaited<ReturnType<typeof createScene>>['scene']
  let concert: typeof scenePresets.$inferSelect
  let event: typeof events.$inferSelect

  beforeEach(async () => {
    await resetDb()
    app = await testApp()
    host = await createUser()
    ;({ scene } = await createScene(host))
    ;[concert] = await db.insert(scenePresets).values({ sceneId: scene.id, name: 'Concert' }).returning()
    ;[event] = await db.insert(events).values({
      ownerId: host.id, name: 'Launch party', timezone: 'Europe/London',
      startTime: new Date('2030-07-05T19:00:00Z'), endTime: new Date('2030-07-05T22:30:00Z'),
    }).returning()
    await db.insert(eventSceneLinks).values({ eventId: event.id, sceneId: scene.id })
  })
  afterEach(() => app.close())

  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const useDuring = (u: TestUser, v: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: `/api/scenes/${scene.id}/preset-schedules`, headers: as(u), payload: { presetId: concert.id, eventId: event.id, ...v } })
  const row = async (id: string) => (await db.query.scenePresetSchedules.findFirst({ where: eq(scenePresetSchedules.id, id) }))!

  it("takes its times from the event, in the event's timezone", async () => {
    const res = await useDuring(host, { recurrence: 'daily', startDate: '2031-01-01', startTime: '09:00' }) // ignored
    expect(res.statusCode).toBe(201)
    const s = res.json().schedule
    expect(s).toMatchObject({ eventId: event.id, recurrence: 'once', startDate: '2030-07-05', startTime: '20:00', durationMinutes: 210, timezone: 'Europe/London', weekdays: [] })
    expect(s.nextRuns[0]).toBe('2030-07-05T19:00:00.000Z')
  })

  it('moves when the event times are edited', async () => {
    const s = (await useDuring(host)).json().schedule
    const res = await app.inject({ method: 'PUT', url: `/api/events/${event.id}`, headers: as(host), payload: { startTime: '2030-07-12T18:00:00Z', endTime: '2030-07-12T20:00:00Z' } })
    expect(res.statusCode).toBe(200)
    expect(await row(s.id)).toMatchObject({ startDate: '2030-07-12', startTime: '19:00', durationMinutes: 120, enabled: true })
  })

  it('pauses when the event loses its times, and resumes when they come back', async () => {
    const s = (await useDuring(host)).json().schedule
    await app.inject({ method: 'PUT', url: `/api/events/${event.id}`, headers: as(host), payload: { endTime: null } })
    expect((await row(s.id)).enabled).toBe(false)
    await app.inject({ method: 'PUT', url: `/api/events/${event.id}`, headers: as(host), payload: { endTime: '2030-07-05T23:00:00Z' } })
    expect(await row(s.id)).toMatchObject({ enabled: true, durationMinutes: 240 })
  })

  it("refuses an event that isn't linked to the scene, or has no times", async () => {
    const [other] = await db.insert(events).values({ ownerId: host.id, name: 'Elsewhere', startTime: new Date('2030-08-01T10:00:00Z'), endTime: new Date('2030-08-01T11:00:00Z') }).returning()
    const notLinked = await useDuring(host, { eventId: other.id })
    expect(notLinked.statusCode).toBe(400)
    expect(notLinked.json()).toMatchObject({ error: 'bad_schedule', message: 'Link the event to this scene first.' })
    await db.update(events).set({ endTime: null }).where(eq(events.id, event.id))
    const noTimes = await useDuring(host)
    expect(noTimes.statusCode).toBe(400)
    expect(noTimes.json().message).toBe('The event needs a start and an end time.')
  })

  it('unlinking the scene from the event removes its event schedules', async () => {
    const s = (await useDuring(host)).json().schedule
    const res = await app.inject({ method: 'DELETE', url: `/api/events/${event.id}/unlink-scene/${scene.id}`, headers: as(host) })
    expect(res.statusCode).toBeLessThan(300)
    expect(await db.query.scenePresetSchedules.findFirst({ where: eq(scenePresetSchedules.id, s.id) })).toBeUndefined()
  })

  it('a PATCH with eventId null keeps the times and stops following the event', async () => {
    const s = (await useDuring(host)).json().schedule
    const res = await app.inject({ method: 'PATCH', url: `/api/preset-schedules/${s.id}`, headers: as(host), payload: { eventId: null } })
    expect(res.statusCode).toBe(200)
    expect(res.json().schedule).toMatchObject({ eventId: null, startDate: '2030-07-05', startTime: '20:00' })
    await app.inject({ method: 'PUT', url: `/api/events/${event.id}`, headers: as(host), payload: { startTime: '2030-07-12T18:00:00Z', endTime: '2030-07-12T20:00:00Z' } })
    expect((await row(s.id)).startDate).toBe('2030-07-05')
  })

  it("the event page lists the presets scheduled for it", async () => {
    await useDuring(host)
    const res = await app.inject({ method: 'GET', url: `/api/events/${event.id}`, headers: as(host) })
    expect(res.statusCode).toBe(200)
    expect(res.json().presetSchedules).toEqual([expect.objectContaining({ sceneId: scene.id, presetId: concert.id, presetName: 'Concert', enabled: true })])
    expect(res.json().scenePresets).toEqual(expect.arrayContaining([expect.objectContaining({ sceneId: scene.id, id: concert.id, name: 'Concert' })]))
  })
})
