import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { assetLibraryItems, sceneCollaborators, scenes } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { assertStorageQuota } from '../src/media/quota.js'
import { SCENE_THUMBNAIL_MAX_BYTES } from '@virvixr/shared'
import { createStorage } from '../src/storage/index.js'
import { SceneGone, bodyLimitFor, setSceneThumbnail, setThumbnailStorage } from '../src/scenes/thumbnail.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor, type TestUser } from './helpers/factories.js'

const stored = (key: string) => existsSync(join(process.env.LOCAL_STORAGE_PATH || './uploads', key))
const png = (w = 1280, h = 720, color = '#3366ff') =>
  sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer()

describe('scene thumbnail routes', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  const prevUnlocked = config.allFeaturesUnlocked
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { config.allFeaturesUnlocked = prevUnlocked; await app.close() })

  async function setup() {
    const owner = await createUser()
    const editor = await createUser()
    const viewer = await createUser()
    const stranger = await createUser()
    const { scene } = await createScene(owner)
    await db.insert(sceneCollaborators).values([
      { sceneId: scene.id, userId: editor.id, role: 'editor' },
      { sceneId: scene.id, userId: viewer.id, role: 'viewer' },
    ])
    return { owner, editor, viewer, stranger, scene }
  }
  const as = (u: TestUser) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const put = async (sceneId: string, u: TestUser, data: Buffer) =>
    app.inject({ method: 'PUT', url: `/api/scenes/${sceneId}/thumbnail`, headers: as(u), payload: { fileData: data.toString('base64') } })
  const remove = (sceneId: string, u: TestUser) => app.inject({ method: 'DELETE', url: `/api/scenes/${sceneId}/thumbnail`, headers: as(u) })
  const row = async (id: string) => (await db.query.scenes.findFirst({ where: eq(scenes.id, id) }))!

  it('a host or an editor uploads it: stored under the scene, set as the scene thumbnail', async () => {
    const s = await setup()
    const res = await put(s.scene.id, s.editor, await png())
    expect(res.statusCode).toBe(200)
    const { scene } = res.json()
    expect(scene.thumbnailKey).toMatch(new RegExp(`^scenes/${s.scene.id}/thumbnail-[0-9a-f]{16}\\.(png|jpg)$`))
    expect(scene.thumbnailUrl).toMatch(new RegExp(`/${scene.thumbnailKey}$`))
    expect(scene.thumbnailBytes).toBeGreaterThan(0)
    expect(stored(scene.thumbnailKey)).toBe(true)
    expect((await row(s.scene.id)).thumbnailUrl).toBe(scene.thumbnailUrl)
    expect((await put(s.scene.id, s.owner, await png(1920, 1080))).statusCode).toBe(200)
  })

  it('an upload is recorded as uploaded in Virvi (LIV-89), and removing it clears that', async () => {
    const s = await setup()
    await db.update(scenes).set({ thumbnailSource: 'import' }).where(eq(scenes.id, s.scene.id))
    const res = await put(s.scene.id, s.owner, await png())
    expect(res.json().scene.thumbnailSource).toBe('upload')
    expect((await row(s.scene.id)).thumbnailSource).toBe('upload')
    expect((await remove(s.scene.id, s.owner)).statusCode).toBe(200)
    expect((await row(s.scene.id)).thumbnailSource).toBeNull()
  })

  it('a body over the thumbnail limit is refused with 413 before it is read', async () => {
    const s = await setup()
    const res = await app.inject({
      method: 'PUT', url: `/api/scenes/${s.scene.id}/thumbnail`, headers: as(s.owner),
      payload: { fileData: 'A'.repeat(Math.ceil((SCENE_THUMBNAIL_MAX_BYTES * 4) / 3) + 8192) },
    })
    expect(res.statusCode).toBe(413)
    expect(res.json().code).toBe('FST_ERR_CTP_BODY_TOO_LARGE') // Fastify's own limit, not the decoded-size check
    // A full 2 MB image as base64 still fits
    expect(bodyLimitFor(SCENE_THUMBNAIL_MAX_BYTES)).toBeGreaterThan(Math.ceil((SCENE_THUMBNAIL_MAX_BYTES * 4) / 3) + 20)
  })

  it('a scene deleted while its thumbnail uploads is 404, and the uploaded file is deleted', async () => {
    const s = await setup()
    const keys: string[] = []
    const real = createStorage()
    setThumbnailStorage({
      ...real,
      upload: async (key, data, type) => {
        keys.push(key)
        const url = await real.upload(key, data, type)
        await db.delete(scenes).where(eq(scenes.id, s.scene.id)) // gone before the row is locked
        return url
      },
      delete: (key) => real.delete(key),
      getPublicUrl: (key) => real.getPublicUrl(key),
    })
    try {
      await expect(setSceneThumbnail(s.scene.id, await png())).rejects.toBeInstanceOf(SceneGone)
      expect(keys).toHaveLength(1)
      expect(stored(keys[0])).toBe(false)
    } finally {
      setThumbnailStorage(null)
    }
    await expect(setSceneThumbnail('00000000-0000-4000-8000-000000000000', await png())).rejects.toBeInstanceOf(SceneGone)
  })

  it('viewers and other accounts are refused; an unknown scene is 404', async () => {
    const s = await setup()
    expect((await put(s.scene.id, s.viewer, await png())).statusCode).toBe(403)
    expect((await put(s.scene.id, s.stranger, await png())).statusCode).toBe(403)
    expect((await remove(s.scene.id, s.viewer)).statusCode).toBe(403)
    expect((await remove(s.scene.id, s.stranger)).statusCode).toBe(403)
    expect((await put('00000000-0000-4000-8000-000000000000', s.owner, await png())).statusCode).toBe(404)
    expect((await row(s.scene.id)).thumbnailUrl).toBeNull()
  })

  it('refuses bad files with a clear message', async () => {
    const s = await setup()
    const gif = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#000' } }).gif().toBuffer()
    const bad = await put(s.scene.id, s.owner, gif)
    expect(bad.statusCode).toBe(415)
    expect(bad.json()).toMatchObject({ error: 'unsupported_type', message: 'Use a PNG, JPEG or WebP image.' })
    const square = await put(s.scene.id, s.owner, await png(1024, 1024))
    expect(square.statusCode).toBe(400)
    expect(square.json().error).toBe('wrong_shape')
    const small = await put(s.scene.id, s.owner, await png(640, 360))
    expect(small.json()).toMatchObject({ error: 'too_small' })
    const none = await app.inject({ method: 'PUT', url: `/api/scenes/${s.scene.id}/thumbnail`, headers: as(s.owner), payload: {} })
    expect(none.statusCode).toBe(400)
    expect((await row(s.scene.id)).thumbnailUrl).toBeNull()
  })

  it('replacing deletes the old file; removing deletes the file and clears the thumbnail', async () => {
    const s = await setup()
    const first = (await put(s.scene.id, s.owner, await png())).json().scene
    const second = (await put(s.scene.id, s.editor, await png(1280, 720, '#ff0000'))).json().scene
    expect(second.thumbnailKey).not.toBe(first.thumbnailKey)
    expect(stored(first.thumbnailKey)).toBe(false)
    expect(stored(second.thumbnailKey)).toBe(true)
    // The same image again keeps its file
    const same = (await put(s.scene.id, s.editor, await png(1280, 720, '#ff0000'))).json().scene
    expect(same.thumbnailKey).toBe(second.thumbnailKey)
    expect(stored(second.thumbnailKey)).toBe(true)

    const res = await remove(s.scene.id, s.editor)
    expect(res.statusCode).toBe(200)
    expect(res.json().scene).toMatchObject({ thumbnailUrl: null, thumbnailKey: null, thumbnailBytes: null })
    expect(stored(second.thumbnailKey)).toBe(false)
    expect((await remove(s.scene.id, s.editor)).statusCode).toBe(200) // nothing to remove is fine
  })

  it("counts towards the scene owner's storage quota, whoever uploads it", async () => {
    config.allFeaturesUnlocked = false
    const s = await setup()
    const file = await png()
    await db.insert(assetLibraryItems).values({ name: 'Big', storageKey: 'big', fileSizeBytes: 500 * 1024 * 1024 - 10, uploadedBy: s.owner.id, isPublic: false })
    const res = await put(s.scene.id, s.editor, file)
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('storage_limit_reached')

    await db.delete(assetLibraryItems)
    const ok = (await put(s.scene.id, s.editor, file)).json().scene
    await expect(assertStorageQuota(s.owner.id, 500 * 1024 * 1024 - ok.thumbnailBytes + 1)).rejects.toMatchObject({
      body: { error: 'storage_limit_reached', currentUsageBytes: ok.thumbnailBytes },
    })
    await expect(assertStorageQuota(s.editor.id, 1)).resolves.toBeUndefined()
  })

  it('deleting the scene deletes its thumbnail file', async () => {
    const s = await setup()
    const { thumbnailKey } = (await put(s.scene.id, s.owner, await png())).json().scene
    expect((await app.inject({ method: 'DELETE', url: `/api/scenes/${s.scene.id}`, headers: as(s.owner) })).statusCode).toBe(204)
    expect(stored(thumbnailKey)).toBe(false)
  })
})
