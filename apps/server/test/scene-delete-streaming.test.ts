import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { scenes, streamingServers } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, tokenFor, testApp } from './helpers/factories.js'

describe('deleting a scene linked to a streaming server', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(() => app.close())

  it('deletes the scene and keeps the server, unlinked', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const [server] = await db.insert(streamingServers).values({ ownerId: owner.id, name: 'Stage', sceneId: scene.id }).returning()
    const res = await app.inject({ method: 'DELETE', url: `/api/scenes/${scene.id}`, headers: { authorization: `Bearer ${tokenFor(owner)}` } })
    expect(res.statusCode, res.body).toBeLessThan(300)
    expect(await db.select().from(scenes).where(eq(scenes.id, scene.id))).toEqual([])
    const [kept] = await db.select().from(streamingServers).where(eq(streamingServers.id, server.id))
    expect(kept.sceneId).toBeNull()
  })
})
