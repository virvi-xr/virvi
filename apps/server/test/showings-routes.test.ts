import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { mediaAssets, sceneCollaborators, screenShowings } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, createElement, tokenFor, type TestUser } from './helpers/factories.js'

const FILM = 'https://cdn.example/film.mp4'
const REEL = 'https://cdn.example/reel.mp4'

describe('screen showings routes', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let owner: TestUser
  let screenId: string
  let sceneId: string
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
    owner = await createUser()
    const { scene, preset } = await createScene(owner)
    sceneId = scene.id
    screenId = (await createElement(preset.id, { type: 'video' })).id
    // The film is in someone's library with its length measured
    await db.insert(mediaAssets).values({ ownerId: owner.id, filename: 'film.mp4', contentType: 'video/mp4', sizeBytes: 1, storageKey: 'k', publicUrl: FILM, status: 'ready', metadata: { duration: 5400 } })
  })
  afterEach(() => app.close())

  const call = (user: TestUser, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as any, url, headers: { authorization: `Bearer ${tokenFor(user)}` }, payload: payload as any })
  const fridays = (time: string, extra: Record<string, unknown> = {}) => ({
    title: 'Night of the Living Dead', items: [{ url: REEL, kind: 'ad', duration: 600 }, { url: FILM }],
    recurrence: 'weekly', startDate: '2030-01-01', startTime: time, weekdays: [5], timezone: 'America/New_York', ...extra,
  })

  it('creates a showing, taking the film length from the library, and lists it with its next starts', async () => {
    const res = await call(owner, 'POST', `/api/elements/${screenId}/showings`, fridays('19:00'))
    expect(res.statusCode).toBe(201)
    const { showing } = res.json()
    expect(showing).toMatchObject({ sceneId, elementId: screenId, title: 'Night of the Living Dead', lengthSeconds: 6000, enabled: true })
    expect(showing.items).toEqual([{ url: REEL, kind: 'ad', duration: 600 }, { url: FILM, kind: 'video', duration: 5400 }])
    expect(showing.nextStarts[0]).toBe('2030-01-05T00:00:00.000Z') // Fri 4 Jan 2030, 7pm EST
    const list = await call(owner, 'GET', `/api/elements/${screenId}/showings`)
    expect(list.statusCode).toBe(200)
    expect(list.json().showings.map((s: any) => s.id)).toEqual([showing.id])
  })

  it('the library length wins over one the client sends', async () => {
    const res = await call(owner, 'POST', `/api/elements/${screenId}/showings`, fridays('19:00', { items: [{ url: FILM, duration: 10 }] }))
    expect(res.json().showing.items[0].duration).toBe(5400)
  })

  it('refuses videos with no known length, naming them', async () => {
    const res = await call(owner, 'POST', `/api/elements/${screenId}/showings`, fridays('19:00', { items: [{ url: 'https://elsewhere.example/x.mp4' }, { url: FILM }] }))
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: 'unknown_length', urls: ['https://elsewhere.example/x.mp4'] })
  })

  it('refuses an ad after the feature, an empty programme and bad URLs', async () => {
    for (const items of [
      [{ url: FILM }, { url: REEL, kind: 'ad', duration: 30 }],
      [],
      [{ url: 'javascript:alert(1)', duration: 30 }],
      [{ url: FILM, kind: 'trailer' }],
    ]) {
      const res = await call(owner, 'POST', `/api/elements/${screenId}/showings`, fridays('19:00', { items }))
      expect(res.statusCode, JSON.stringify(items)).toBe(400)
    }
  })

  it('refuses bad times with the schedule messages', async () => {
    const res = await call(owner, 'POST', `/api/elements/${screenId}/showings`, fridays('25:00'))
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toBe('The time must be HH:MM (24-hour).')
  })

  it('refuses a showing that overlaps another on the same screen, but allows it on another screen or when paused', async () => {
    const first = (await call(owner, 'POST', `/api/elements/${screenId}/showings`, fridays('19:00'))).json().showing
    const clash = await call(owner, 'POST', `/api/elements/${screenId}/showings`, fridays('20:00', { title: 'Late show' }))
    expect(clash.statusCode).toBe(409)
    expect(clash.json()).toMatchObject({ error: 'showing_overlap', showingId: first.id })
    expect(clash.json().message).toContain('Night of the Living Dead')
    expect((await call(owner, 'POST', `/api/elements/${screenId}/showings`, fridays('20:40'))).statusCode).toBe(201) // back to back
    const { preset } = await createScene(owner, 'Other')
    const other = await createElement(preset.id, { type: 'video' })
    expect((await call(owner, 'POST', `/api/elements/${other.id}/showings`, fridays('20:00'))).statusCode).toBe(201)
    expect((await call(owner, 'POST', `/api/elements/${screenId}/showings`, fridays('20:00', { enabled: false }))).statusCode).toBe(201)
  })

  it('refuses a daily showing longer than a day (it would run into itself)', async () => {
    const items = [{ url: 'https://cdn.example/a.mp4', duration: 13 * 3600 }, { url: 'https://cdn.example/b.mp4', duration: 13 * 3600 }]
    const res = await call(owner, 'POST', `/api/elements/${screenId}/showings`, fridays('12:00', { items, recurrence: 'daily', weekdays: [] }))
    expect(res.statusCode).toBe(409)
    expect(res.json().message).toMatch(/^This runs into itself on 2030-01-02 at 12:00\.$/)
  })

  it('edits a showing (checked again, ignoring itself) and deletes it', async () => {
    const s = (await call(owner, 'POST', `/api/elements/${screenId}/showings`, fridays('19:00'))).json().showing
    const moved = await call(owner, 'PATCH', `/api/showings/${s.id}`, { startTime: '19:30' })
    expect(moved.statusCode).toBe(200)
    expect(moved.json().showing).toMatchObject({ startTime: '19:30', title: 'Night of the Living Dead', lengthSeconds: 6000 })
    const cleared = await call(owner, 'PATCH', `/api/showings/${s.id}`, { title: null })
    expect(cleared.json().showing.title).toBeNull()
    expect((await call(owner, 'DELETE', `/api/showings/${s.id}`)).statusCode).toBe(204)
    expect(await db.select().from(screenShowings)).toEqual([])
  })

  it('only works on video screens', async () => {
    const { preset } = await createScene(owner, 'Images')
    const image = await createElement(preset.id, { type: 'image' })
    expect((await call(owner, 'POST', `/api/elements/${image.id}/showings`, fridays('19:00'))).statusCode).toBe(400)
  })

  it('editors can manage showings; other accounts get 403 and missing ids 404', async () => {
    const editor = await createUser()
    await db.insert(sceneCollaborators).values({ sceneId, userId: editor.id, role: 'editor' })
    const s = await call(editor, 'POST', `/api/elements/${screenId}/showings`, fridays('19:00'))
    expect(s.statusCode).toBe(201)
    const stranger = await createUser()
    expect((await call(stranger, 'GET', `/api/elements/${screenId}/showings`)).statusCode).toBe(403)
    expect((await call(stranger, 'POST', `/api/elements/${screenId}/showings`, fridays('22:00'))).statusCode).toBe(403)
    expect((await call(stranger, 'PATCH', `/api/showings/${s.json().showing.id}`, { enabled: false })).statusCode).toBe(403)
    expect((await call(stranger, 'DELETE', `/api/showings/${s.json().showing.id}`)).statusCode).toBe(403)
    expect((await db.select().from(screenShowings).where(eq(screenShowings.id, s.json().showing.id)))[0].enabled).toBe(true)
    expect((await call(owner, 'GET', `/api/elements/00000000-0000-4000-8000-000000000000/showings`)).statusCode).toBe(404)
    expect((await call(owner, 'PATCH', `/api/showings/not-a-uuid`, {})).statusCode).toBe(404)
  })

  it('a viewer of the scene cannot manage showings', async () => {
    const viewer = await createUser()
    await db.insert(sceneCollaborators).values({ sceneId, userId: viewer.id, role: 'viewer' })
    expect((await call(viewer, 'POST', `/api/elements/${screenId}/showings`, fridays('19:00'))).statusCode).toBe(403)
  })
})
