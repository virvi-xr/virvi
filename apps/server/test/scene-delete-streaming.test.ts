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

  it('a delete keeps the server linked (restorable); deleting forever keeps it, unlinked', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const [server] = await db.insert(streamingServers).values({ ownerId: owner.id, name: 'Stage', sceneId: scene.id }).returning()
    const headers = { authorization: `Bearer ${tokenFor(owner)}` }
    const res = await app.inject({ method: 'DELETE', url: `/api/scenes/${scene.id}`, headers })
    expect(res.statusCode, res.body).toBeLessThan(300)
    expect((await db.select().from(streamingServers).where(eq(streamingServers.id, server.id)))[0].sceneId).toBe(scene.id)
    const purge = await app.inject({ method: 'POST', url: `/api/scenes/${scene.id}/purge`, headers, payload: { name: scene.name } })
    expect(purge.statusCode, purge.body).toBe(204)
    expect(await db.select().from(scenes).where(eq(scenes.id, scene.id))).toEqual([])
    const [kept] = await db.select().from(streamingServers).where(eq(streamingServers.id, server.id))
    expect(kept.sceneId).toBeNull()
  })
})
