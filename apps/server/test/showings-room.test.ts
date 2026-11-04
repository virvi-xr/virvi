import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { VideoSourceType } from '@virvixr/shared'
import { db } from '../src/db/connection.js'
import { sceneElements, scenePresets, scenes, screenShowings } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, createElement, tokenFor, testApp } from './helpers/factories.js'
import { startGameServer, joinScene } from './helpers/game-server.js'
import { SHOWINGS_WINDOW_MS } from '../src/scenes/showings.js'

const items = [{ url: 'https://cdn.example/film.mp4', duration: 5400, kind: 'video' as const }]
const today = () => new Date().toISOString().slice(0, 10)

describe('scene room: showings for scheduled screens', () => {
  let gs: Awaited<ReturnType<typeof startGameServer>>
  beforeEach(async () => {
    await resetDb()
    gs = await startGameServer()
  })
  afterEach(() => gs.stop())

  async function setup() {
    const owner = await createUser()
    const { scene, preset } = await createScene(owner)
    const screen = await createElement(preset.id, { type: 'video', properties: { offType: VideoSourceType.SCHEDULED, playlist: [] } })
    const plain = await createElement(preset.id, { type: 'video', name: 'Plain', properties: { offType: VideoSourceType.PLAYLIST, playlist: [] } })
    // Daily at 00:00 UTC, so one is always running or due within the window
    await db.insert(screenShowings).values({ sceneId: scene.id, elementId: screen.id, title: 'Film', items, recurrence: 'daily', startDate: '2020-01-01', startTime: '00:00', timezone: 'UTC' })
    return { owner, scene, preset, screen, plain }
  }

  it('sends each scheduled screen its showings and the server time on join', async () => {
    const s = await setup()
    const before = Date.now()
    const client = await joinScene(gs.url, s.scene.id)
    const msg = await client.waitFor('screen_showings')
    expect(msg.elementId).toBe(s.screen.id)
    expect(msg.serverTime).toBeGreaterThanOrEqual(before)
    expect(msg.serverTime).toBeLessThanOrEqual(Date.now())
    expect(msg.showings.length).toBeGreaterThanOrEqual(1)
    expect(msg.showings[0]).toMatchObject({ title: 'Film', items })
    for (const sh of msg.showings) expect(sh.startsAt).toBeLessThanOrEqual(msg.serverTime + SHOWINGS_WINDOW_MS)
    await client.expectNone('screen_showings', 300) // not for the playlist screen
  })

  it('skips disabled showings', async () => {
    const s = await setup()
    await db.update(screenShowings).set({ enabled: false })
    const client = await joinScene(gs.url, s.scene.id)
    expect(await client.waitFor('screen_showings')).toMatchObject({ elementId: s.screen.id, showings: [] })
  })

  it('sends the new showings when they change through the API', async () => {
    const s = await setup()
    const client = await joinScene(gs.url, s.scene.id)
    await client.waitFor('screen_showings')
    const app = await testApp()
    try {
      const res = await app.inject({
        method: 'POST', url: `/api/elements/${s.screen.id}/showings`, headers: { authorization: `Bearer ${tokenFor(s.owner)}` },
        payload: { title: 'Late', items: [{ url: 'https://cdn.example/short.mp4', duration: 60 }], recurrence: 'daily', startDate: today(), startTime: '12:00', timezone: 'UTC' },
      })
      expect(res.statusCode).toBe(201)
      const msg = await client.waitFor('screen_showings')
      expect(msg.showings.map((x: any) => x.title)).toContain('Late')
    } finally {
      await app.close()
    }
  })

  it('sends the showings of the new preset when the live preset switches', async () => {
    const s = await setup()
    const [other] = await db.insert(scenePresets).values({ sceneId: s.scene.id, name: 'Other' }).returning()
    const [screen2] = await db.insert(sceneElements).values({ presetId: other.id, type: 'video', name: 'S2', properties: { offType: VideoSourceType.SCHEDULED } }).returning()
    await db.insert(screenShowings).values({ sceneId: s.scene.id, elementId: screen2.id, title: 'Other film', items, recurrence: 'daily', startDate: '2020-01-01', startTime: '06:00', timezone: 'UTC' })
    const client = await joinScene(gs.url, s.scene.id)
    await client.waitFor('screen_showings')
    const app = await testApp()
    try {
      const res = await app.inject({ method: 'POST', url: `/api/presets/${other.id}/activate`, headers: { authorization: `Bearer ${tokenFor(s.owner)}` } })
      expect([200, 204]).toContain(res.statusCode)
      const msg = await client.waitFor('screen_showings')
      expect(msg).toMatchObject({ elementId: screen2.id })
      expect(msg.showings[0].title).toBe('Other film')
    } finally {
      await app.close()
    }
    expect((await db.query.scenes.findFirst({ where: eq(scenes.id, s.scene.id) }))!.activePresetId).toBe(other.id)
  })
})
