import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { sceneCollaborators, streamingServers } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor } from './helpers/factories.js'

async function stream(ownerId: string, name: string, status: 'ready' | 'live' | 'terminated' = 'ready') {
  const [s] = await db.insert(streamingServers).values({
    ownerId, name, status, streamKey: `key-${name}`, rtmpUrl: 'rtmp://ingest.virvi.io/live', hlsPlaylistUrl: `https://cdn.virvi.io/streams/${name}/playlist.m3u8`,
  }).returning()
  return s
}

describe('GET /api/scenes/:sceneId/streams', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(() => app.close())
  const as = (u: any) => ({ authorization: `Bearer ${tokenFor(u)}` })

  it("lists the scene owner's streams by name with live status, and never the stream key", async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    await stream(owner.id, 'Main Stage', 'live')
    await stream(owner.id, 'Backstage')
    await stream(owner.id, 'Old', 'terminated')
    const res = await app.inject({ method: 'GET', url: `/api/scenes/${scene.id}/streams`, headers: as(owner) })
    expect(res.statusCode).toBe(200)
    const { streams } = res.json()
    expect(streams.map((s: any) => [s.name, s.live, s.hlsPlaylistUrl]).sort()).toEqual([
      ['Backstage', false, 'https://cdn.virvi.io/streams/Backstage/playlist.m3u8'],
      ['Main Stage', true, 'https://cdn.virvi.io/streams/Main Stage/playlist.m3u8'],
    ])
    expect(JSON.stringify(streams)).not.toContain('key-')
    expect(Object.keys(streams[0]).sort()).toEqual(['hlsPlaylistUrl', 'id', 'live', 'mine', 'name'])
  })

  it("an editor sees the owner's streams and their own; a viewer or stranger is refused", async () => {
    const owner = await createUser()
    const editor = await createUser()
    const viewer = await createUser()
    const stranger = await createUser()
    const { scene } = await createScene(owner)
    await db.insert(sceneCollaborators).values([
      { sceneId: scene.id, userId: editor.id, role: 'editor' },
      { sceneId: scene.id, userId: viewer.id, role: 'viewer' },
    ])
    await stream(owner.id, 'Owner Stage')
    await stream(editor.id, 'Editor Cam')
    await stream(stranger.id, 'Not Yours')
    const res = await app.inject({ method: 'GET', url: `/api/scenes/${scene.id}/streams`, headers: as(editor) })
    expect(res.statusCode).toBe(200)
    expect(res.json().streams.map((s: any) => [s.name, s.mine]).sort()).toEqual([['Editor Cam', true], ['Owner Stage', false]])
    for (const u of [viewer, stranger]) {
      expect((await app.inject({ method: 'GET', url: `/api/scenes/${scene.id}/streams`, headers: as(u) })).statusCode).toBe(403)
    }
  })

  it('a malformed scene id is 404', async () => {
    const owner = await createUser()
    expect((await app.inject({ method: 'GET', url: '/api/scenes/nope/streams', headers: as(owner) })).statusCode).toBe(404)
  })
})
