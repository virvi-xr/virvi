import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { events, eventSceneLinks, scenes } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor } from './helpers/factories.js'

describe('GET /api/command-center/:eventId/status', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(() => app.close())

  it("carries each linked scene's thumbnail (LIV-88)", async () => {
    const u = await createUser()
    const { scene } = await createScene(u, 'Ship')
    const { scene: plain } = await createScene(u, 'Plain')
    await db.update(scenes).set({ thumbnailUrl: 'https://cdn.example/t.png' }).where(eq(scenes.id, scene.id))
    const [event] = await db.insert(events).values({ ownerId: u.id, name: 'Launch' }).returning()
    await db.insert(eventSceneLinks).values([{ eventId: event.id, sceneId: scene.id }, { eventId: event.id, sceneId: plain.id }])
    const res = await app.inject({ method: 'GET', url: `/api/command-center/${event.id}/status`, headers: { authorization: `Bearer ${tokenFor(u)}` } })
    expect(res.statusCode).toBe(200)
    const by = Object.fromEntries(res.json().worlds.map((w: any) => [w.sceneName, w.sceneThumbnailUrl]))
    expect(by).toEqual({ Ship: 'https://cdn.example/t.png', Plain: null })
  })
})
