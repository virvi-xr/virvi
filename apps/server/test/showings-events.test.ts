import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { events, eventSceneLinks, mediaAssets, screenShowings } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { createElement, createScene, createUser, testApp, tokenFor, type TestUser } from './helpers/factories.js'

const FILM = 'https://cdn.example/film.mp4'

describe('scheduled showings linked to events (LIV-87)', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let host: TestUser
  let sceneId: string
  let screenId: string
  let event: typeof events.$inferSelect

  beforeEach(async () => {
    await resetDb()
    app = await testApp()
    host = await createUser()
    const { scene, preset } = await createScene(host)
    sceneId = scene.id
    screenId = (await createElement(preset.id, { type: 'video', name: 'Big screen' })).id
    await db.insert(mediaAssets).values({ ownerId: host.id, filename: 'film.mp4', contentType: 'video/mp4', sizeBytes: 1, storageKey: 'k', publicUrl: FILM, status: 'ready', metadata: { duration: 5400 } })
    ;[event] = await db.insert(events).values({
      ownerId: host.id, name: 'Premiere', timezone: 'Europe/London',
      startTime: new Date('2030-07-05T19:00:00Z'), endTime: new Date('2030-07-05T22:30:00Z'),
    }).returning()
    await db.insert(eventSceneLinks).values({ eventId: event.id, sceneId })
  })
  afterEach(() => app.close())

  const call = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as any, url, headers: { authorization: `Bearer ${tokenFor(host)}` }, payload: payload as any })
  const forEvent = (extra: Record<string, unknown> = {}) =>
    call('POST', `/api/elements/${screenId}/showings`, { title: 'Film', items: [{ url: FILM }], eventId: event.id, ...extra })
  const row = async (id: string) => (await db.query.screenShowings.findFirst({ where: eq(screenShowings.id, id) }))!

  it("plays once at the event's start, in the event's timezone, whatever times are sent", async () => {
    const res = await forEvent({ recurrence: 'daily', startDate: '2031-01-01', startTime: '09:00', timezone: 'UTC' })
    expect(res.statusCode).toBe(201)
    const s = res.json().showing
    expect(s).toMatchObject({ eventId: event.id, recurrence: 'once', startDate: '2030-07-05', startTime: '20:00', weekdays: [], timezone: 'Europe/London' })
    expect(s.nextStarts[0]).toBe('2030-07-05T19:00:00.000Z')
  })

  it('refuses an event not linked to the scene, or one with no start time', async () => {
    const [other] = await db.insert(events).values({ ownerId: host.id, name: 'Elsewhere', startTime: new Date('2030-08-01T10:00:00Z') }).returning()
    const res = await forEvent({ eventId: other.id })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'bad_showing', message: 'Link the event to this scene first.' })
    await db.update(events).set({ startTime: null }).where(eq(events.id, event.id))
    const res2 = await forEvent()
    expect(res2.statusCode).toBe(400)
    expect(res2.json().message).toBe('The event needs a start time.')
    expect((await forEvent({ eventId: 'nope' })).statusCode).toBe(400)
  })

  it("still refuses a clash with the screen's other showings", async () => {
    await call('POST', `/api/elements/${screenId}/showings`, { title: 'Matinee', items: [{ url: FILM }], recurrence: 'once', startDate: '2030-07-05', startTime: '19:30', timezone: 'Europe/London' })
    expect((await forEvent()).statusCode).toBe(409)
  })

  it('moves with the event, forgetting hosts\' changes to the old time; pauses while the event has no start', async () => {
    const id = (await forEvent()).json().showing.id
    await db.update(screenShowings).set({ adjustments: [{ kind: 'delay', occurrence: Date.parse('2030-07-05T19:00:00Z'), minutes: 5 }] }).where(eq(screenShowings.id, id))
    const moved = await call('PUT', `/api/events/${event.id}`, { startTime: '2030-07-12T18:00:00Z' })
    expect(moved.statusCode).toBe(200)
    expect(await row(id)).toMatchObject({ startDate: '2030-07-12', startTime: '19:00', timezone: 'Europe/London', enabled: true, adjustments: [] })
    await call('PUT', `/api/events/${event.id}`, { startTime: null })
    expect((await row(id)).enabled).toBe(false)
    await call('PUT', `/api/events/${event.id}`, { startTime: '2030-07-19T18:00:00Z' })
    expect(await row(id)).toMatchObject({ startDate: '2030-07-19', enabled: true })
  })

  it('an edit keeps following the event; clearing the event keeps the times it had', async () => {
    const id = (await forEvent()).json().showing.id
    const edited = await call('PATCH', `/api/showings/${id}`, { title: 'Film (restored)', startTime: '09:00' })
    expect(edited.json().showing).toMatchObject({ title: 'Film (restored)', startTime: '20:00', eventId: event.id })
    const freed = await call('PATCH', `/api/showings/${id}`, { eventId: null })
    expect(freed.json().showing).toMatchObject({ eventId: null, startDate: '2030-07-05', startTime: '20:00', recurrence: 'once' })
  })

  it('unlinking the scene or deleting the event pauses the showing and keeps its programme', async () => {
    const a = (await forEvent()).json().showing.id
    expect((await call('DELETE', `/api/events/${event.id}/unlink-scene/${sceneId}`)).statusCode).toBe(204)
    expect(await row(a)).toMatchObject({ eventId: null, enabled: false, title: 'Film' })

    await db.insert(eventSceneLinks).values({ eventId: event.id, sceneId })
    const b = (await forEvent({ title: 'Encore', startTime: '23:00' })).json().showing
    expect(b.eventId).toBe(event.id)
    await db.delete(screenShowings).where(eq(screenShowings.id, a))
    expect((await call('DELETE', `/api/events/${event.id}`)).statusCode).toBe(204)
    expect(await row(b.id)).toMatchObject({ eventId: null, enabled: false, title: 'Encore' })
  })

  it("the event page lists its showings, and a screen's showings list offers the scene's events", async () => {
    const id = (await forEvent()).json().showing.id
    const page = await call('GET', `/api/events/${event.id}`)
    expect(page.json().showings).toEqual([{ id, sceneId, elementId: screenId, screenName: 'Big screen', title: 'Film', enabled: true }])
    const list = await call('GET', `/api/elements/${screenId}/showings`)
    expect(list.json().events).toEqual([{ id: event.id, name: 'Premiere', startTime: '2030-07-05T19:00:00.000Z', timezone: 'Europe/London' }])
  })
})
