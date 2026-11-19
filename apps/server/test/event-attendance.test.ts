import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { events, eventSceneLinks, locationSetups } from '../src/db/schema.js'
import { eventAttendance, type AttendanceSession } from '../src/analytics/event-attendance.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor, randomWallet } from './helpers/factories.js'
import { createAnalyticsScene, insertSession } from './helpers/analytics.js'
import { createSetup } from './helpers/setups.js'

const MIN = 60_000
const T0 = new Date('2030-01-01T18:00:00Z')
const at = (m: number) => new Date(T0.getTime() + m * MIN)
const sess = (o: Partial<AttendanceSession> & { s: number; e: number }): AttendanceSession => ({
  location: 'Hall', visitorKey: 'v1', visitorId: 'v1', displayName: null, wallet: null, verified: false, isGuest: false,
  startedAt: at(o.s), endAt: at(o.e), ...o,
})

describe('eventAttendance (pure)', () => {
  it('clips sessions to the window, merges a visitor\'s overlapping sessions, and finds the peak', () => {
    const r = eventAttendance(at(0), at(60), [
      sess({ visitorKey: 'a', visitorId: 'a', s: -30, e: 10 }), // 10 min inside
      sess({ visitorKey: 'a', visitorId: 'a', s: 5, e: 20, displayName: 'Ann', wallet: '0xa', verified: true }), // overlaps: 0–20
      sess({ visitorKey: 'b', visitorId: 'b', s: 15, e: 90 }), // 15–60 = 45 min
      sess({ visitorKey: 'c', visitorId: 'c', s: 70, e: 80 }), // after the window
      sess({ visitorKey: 'd', visitorId: 'd', s: -20, e: -5 }), // before the window
    ], 1)
    expect(r.totals).toEqual({ visitors: 2, verifiedVisitors: 1, peakConcurrent: 2, avgSecondsPresent: (20 * 60 + 45 * 60) / 2 })
    expect(r.attendees.map((a) => [a.visitorId, a.secondsPresent])).toEqual([['b', 2700], ['a', 1200]])
    expect(r.attendees[1]).toMatchObject({ displayName: 'Ann', wallet: '0xa', verified: true, firstSeenAt: at(0).toISOString() })
    expect(r.truncated).toBe(false)
  })

  it('keeps the same hash at two locations apart, and back-to-back visitors never overlap', () => {
    const r = eventAttendance(at(0), at(60), [
      sess({ location: 'A', s: 0, e: 10 }),
      sess({ location: 'B', s: 10, e: 20 }),
    ], 2)
    expect(r.totals.visitors).toBe(2)
    expect(r.totals.peakConcurrent).toBe(1)
  })

  it('counts a visitor seen for an instant, and an empty event', () => {
    expect(eventAttendance(at(0), at(60), [sess({ s: 5, e: 5 })], 1).totals).toMatchObject({ visitors: 1, peakConcurrent: 1, avgSecondsPresent: 0 })
    expect(eventAttendance(at(0), at(60), [], 0).totals).toEqual({ visitors: 0, verifiedVisitors: 0, peakConcurrent: 0, avgSecondsPresent: 0 })
  })
})

describe('GET /api/events/:eventId/attendance', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(() => app.close())

  const get = (u: any, id: string) => app.inject({ method: 'GET', url: `/api/events/${id}/attendance`, headers: { authorization: `Bearer ${tokenFor(u)}` } })

  async function world() {
    const host = await createUser({ wallet: randomWallet() })
    const { scene } = await createScene(host)
    const loc = await createAnalyticsScene({ title: 'Main Hall' })
    const start = new Date(Date.now() - 3 * 3600_000)
    const end = new Date(Date.now() - 1 * 3600_000)
    await createSetup(loc.id, scene.id, { startedAt: new Date(Date.now() - 10 * 86400_000) })
    const [event] = await db.insert(events).values({ ownerId: host.id, name: 'Launch', startTime: start, endTime: end }).returning()
    await db.insert(eventSceneLinks).values({ eventId: event.id, sceneId: scene.id })
    return { host, scene, loc, event, start, end }
  }

  it('lists who came during the event, only from the linked scenes\' locations', async () => {
    const { host, loc, event, start, end } = await world()
    await insertSession(loc.id, { startedAt: new Date(start.getTime() + 10 * MIN), lastSeenAt: new Date(start.getTime() + 40 * MIN), displayName: 'Ann', wallet: '0xann', verified: true })
    await insertSession(loc.id, { startedAt: new Date(end.getTime() + 10 * MIN), lastSeenAt: new Date(end.getTime() + 20 * MIN) }) // after
    const other = await createAnalyticsScene()
    await insertSession(other.id, { startedAt: new Date(start.getTime() + 10 * MIN), lastSeenAt: new Date(start.getTime() + 20 * MIN) }) // elsewhere
    const res = await get(host, event.id)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.locations).toBe(1)
    expect(body.totals).toMatchObject({ visitors: 1, verifiedVisitors: 1, peakConcurrent: 1, avgSecondsPresent: 1800 })
    expect(body.attendees[0]).toMatchObject({ location: 'Main Hall', displayName: 'Ann', wallet: '0xann', secondsPresent: 1800 })
  })

  it('leaves out sessions from before the scene\'s setup at that location', async () => {
    const { host, loc, event, start, scene } = await world()
    // Another scene ran the location until 30 minutes into the event
    await db.delete(locationSetups)
    const switchAt = new Date(start.getTime() + 30 * MIN)
    const { scene: before } = await createScene(await createUser())
    await createSetup(loc.id, before.id, { startedAt: new Date(start.getTime() - 86400_000), endedAt: switchAt })
    await createSetup(loc.id, scene.id, { startedAt: switchAt })
    await insertSession(loc.id, { startedAt: new Date(start.getTime() + 5 * MIN), lastSeenAt: new Date(start.getTime() + 20 * MIN) })
    await insertSession(loc.id, { startedAt: new Date(start.getTime() + 35 * MIN), lastSeenAt: new Date(start.getTime() + 45 * MIN) })
    const body = (await get(host, event.id)).json()
    expect(body.totals.visitors).toBe(1)
    expect(body.attendees[0].secondsPresent).toBe(600)
  })

  it('another account 403, no times 400, unknown id 404, and a linked scene without analytics access is skipped', async () => {
    const { host, event, scene, loc, start } = await world()
    const stranger = await createUser()
    expect((await get(stranger, event.id)).statusCode).toBe(403)
    expect((await get(host, 'nope')).statusCode).toBe(404)
    const [bare] = await db.insert(events).values({ ownerId: host.id, name: 'No time' }).returning()
    expect((await get(host, bare.id)).statusCode).toBe(400)

    // An event that links a scene its owner can't read analytics for (linked before they lost access) shows nothing from it
    await insertSession(loc.id, { startedAt: new Date(start.getTime() + 5 * MIN), lastSeenAt: new Date(start.getTime() + 20 * MIN) })
    const stranger2 = await createUser()
    const [ev3] = await db.insert(events).values({ ownerId: stranger2.id, name: 'Linked by hand', startTime: event.startTime, endTime: event.endTime }).returning()
    await db.insert(eventSceneLinks).values({ eventId: ev3.id, sceneId: scene.id })
    expect((await get(stranger2, ev3.id)).json().totals.visitors).toBe(0)
  })
})
