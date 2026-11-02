import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { assetLibraryItems, mediaAssets, sceneCollaborators } from '../src/db/schema.js'
import { linkToScene } from '../src/library/scene-library.js'
import { createStorage } from '../src/storage/index.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, createElement, tokenFor, type TestUser } from './helpers/factories.js'

const storage = createStorage()
/** A URL shaped like a stored upload: `<owner>/<uuid>.<ext>` under our storage. */
const storedUrl = (ownerId: string, ext = 'mp4') => storage.getPublicUrl(`${ownerId}/${randomUUID()}.${ext}`)

const video = async (ownerId: string, filename: string, url = storedUrl(ownerId)) =>
  (await db.insert(mediaAssets).values({ ownerId, filename, contentType: 'video/mp4', sizeBytes: 10, storageKey: url, publicUrl: url }).returning())[0]

describe('POST /api/scenes/:sceneId/media-names', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { await app.close() })

  const names = (user: TestUser, sceneId: string, urls: unknown) =>
    app.inject({ method: 'POST', url: `/api/scenes/${sceneId}/media-names`, headers: { authorization: `Bearer ${tokenFor(user)}` }, payload: { urls } })

  it('a playlist built from library assets resolves to their names, and a rename shows up', async () => {
    const owner = await createUser(); const { scene, preset } = await createScene(owner)
    const intro = await video(owner.id, 'Intro trailer.mp4')
    const outro = await video(owner.id, 'Outro.mp4')
    await createElement(preset.id, { properties: { playlist: [intro.publicUrl, outro.publicUrl] } })

    const res = await names(owner, scene.id, [intro.publicUrl, outro.publicUrl])
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ names: { [intro.publicUrl!]: 'Intro trailer.mp4', [outro.publicUrl!]: 'Outro.mp4' }, missing: [] })

    await db.update(mediaAssets).set({ filename: 'Intro (final).mp4' }).where(eq(mediaAssets.id, intro.id))
    expect((await names(owner, scene.id, [intro.publicUrl])).json().names[intro.publicUrl!]).toBe('Intro (final).mp4')
  })

  it('a deleted upload is missing; an external URL is neither named nor missing', async () => {
    const owner = await createUser(); const { scene } = await createScene(owner)
    const gone = storedUrl(owner.id)
    const external = 'https://example.com/videos/3cb079fe-bc44-4ebf-87db-459e003c7c3f.mp4'
    const ourOther = storage.getPublicUrl('thumbnails/abc.webp') // ours, but not an upload key
    const res = await names(owner, scene.id, [gone, external, ourOther])
    expect(res.json()).toEqual({ names: {}, missing: [gone] })
  })

  it("names a collaborator's file placed in the scene, but not someone's file the scene doesn't use", async () => {
    const owner = await createUser(); const ed = await createUser(); const stranger = await createUser()
    const { scene, preset } = await createScene(owner)
    await db.insert(sceneCollaborators).values({ sceneId: scene.id, userId: ed.id, role: 'editor' } as any)
    const edFile = await video(ed.id, 'Editor cut.mp4')
    const strangerFile = await video(stranger.id, 'Private.mp4')
    await createElement(preset.id, { properties: { playlist: [edFile.publicUrl] } })

    const res = await names(owner, scene.id, [edFile.publicUrl, strangerFile.publicUrl])
    // The stranger's row exists, so it isn't "missing" either: the editor falls back to the URL's filename
    expect(res.json()).toEqual({ names: { [edFile.publicUrl!]: 'Editor cut.mp4' }, missing: [] })
  })

  it("names the scene library's items and catalog models", async () => {
    const owner = await createUser(); const ed = await createUser(); const { scene } = await createScene(owner)
    await db.insert(sceneCollaborators).values({ sceneId: scene.id, userId: ed.id, role: 'editor' } as any)
    const linked = await video(owner.id, 'Linked.mp4')
    await linkToScene(scene.id, { mediaAssetId: linked.id }, owner.id)
    const [duck] = await db.insert(assetLibraryItems).values({ name: 'Duck', storageKey: 'catalog/p/duck.glb', cdnUrl: 'https://cdn.example/catalog/p/duck.glb', isPublic: true } as any).returning()
    const res = await names(ed, scene.id, [linked.publicUrl, duck.cdnUrl])
    expect(res.json().names).toEqual({ [linked.publicUrl!]: 'Linked.mp4', [duck.cdnUrl!]: 'Duck' })
  })

  it('refuses users without scene access and bad bodies', async () => {
    const owner = await createUser(); const other = await createUser(); const { scene } = await createScene(owner)
    expect((await names(other, scene.id, [])).statusCode).toBe(403)
    expect((await names(owner, scene.id, 'nope')).statusCode).toBe(400)
    expect((await names(owner, scene.id, Array.from({ length: 501 }, (_, i) => `https://x/${i}`))).statusCode).toBe(400)
    expect((await names(owner, 'not-a-uuid', [])).statusCode).toBe(404)
  })
})
