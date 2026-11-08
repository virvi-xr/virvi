import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { assetLibraryItems, mediaAssets, organizations, sceneLibrary, uploadTokens } from '../src/db/schema.js'
import { createStorage } from '../src/storage/index.js'
import { moveMediaModel, moveMediaModels } from '../src/library/move-media-models.js'
import { listSceneLibrary, resolveMediaNames } from '../src/library/scene-library.js'
import { storageUsedBytes } from '../src/media/quota.js'
import { modelsInScene } from '../src/services/dcl/assemble.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, createElement, createInstance, tokenFor } from './helpers/factories.js'

const storage = createStorage()
const GLB = Buffer.from('glTF-moved-model')

/** LIV-132: 3D models uploaded to media before the split move to 3D Models, file and URL untouched. */
describe('moving 3D models out of media', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { await app.close() })

  async function setup() {
    const owner = await createUser()
    const [org] = await db.insert(organizations).values({ name: 'Org', slug: `org-${randomUUID().slice(0, 8)}` }).returning()
    const { scene, preset } = await createScene(owner)
    const key = `${owner.id}/${randomUUID()}.glb`
    const url = await storage.upload(key, GLB, 'model/gltf-binary')
    const at = new Date(Date.now() - 86_400_000)
    const [glb] = await db.insert(mediaAssets).values({ ownerId: owner.id, orgId: org.id, filename: 'Chair.glb', contentType: 'model/gltf-binary', sizeBytes: GLB.length, storageKey: key, publicUrl: url, createdAt: at }).returning()
    // An old upload stored as octet-stream, known as a model by its name
    const key2 = `${owner.id}/${randomUUID()}.glb`
    const url2 = await storage.upload(key2, GLB, 'application/octet-stream')
    const [old] = await db.insert(mediaAssets).values({ ownerId: owner.id, filename: 'lamp.GLB', contentType: 'application/octet-stream', sizeBytes: 7, storageKey: key2, publicUrl: url2 }).returning()
    const [png] = await db.insert(mediaAssets).values({ ownerId: owner.id, filename: 'a.png', contentType: 'image/png', sizeBytes: 100, storageKey: 'k.png', publicUrl: 'https://x/a.png' }).returning()
    const model = await createElement(preset.id, { type: 'model', name: 'Chair', properties: { modelSrc: url } })
    await createInstance(model.id)
    const [link] = await db.insert(sceneLibrary).values({ sceneId: scene.id, mediaAssetId: glb.id, addedBy: owner.id }).returning()
    const [pngLink] = await db.insert(sceneLibrary).values({ sceneId: scene.id, mediaAssetId: png.id, addedBy: owner.id }).returning()
    return { owner, scene, glb, old, png, url, key, link, pngLink, at }
  }

  it("moves each stored model to the owner's 3D Models, private, same file and URL, same library link", async () => {
    const s = await setup()
    const before = await storageUsedBytes(s.owner.id)
    expect(await moveMediaModels()).toEqual({ moved: 2, dropped: 0, failed: 0 })

    // Media keeps only the image
    expect((await db.select().from(mediaAssets)).map((m) => m.id)).toEqual([s.png.id])
    const [chair] = await db.select().from(assetLibraryItems).where(eq(assetLibraryItems.cdnUrl, s.url))
    expect(chair).toMatchObject({ name: 'Chair', storageKey: s.key, fileSizeBytes: GLB.length, isPublic: false, uploadedBy: s.owner.id, status: 'ready', packId: null })
    expect(chair.createdAt.getTime()).toBe(s.at.getTime())
    expect(await db.select().from(assetLibraryItems)).toHaveLength(2)

    // The same link row now points at the model; the image's link is untouched
    expect(await db.query.sceneLibrary.findFirst({ where: eq(sceneLibrary.id, s.link.id) })).toMatchObject({ mediaAssetId: null, assetItemId: chair.id, addedBy: s.owner.id })
    expect(await db.query.sceneLibrary.findFirst({ where: eq(sceneLibrary.id, s.pngLink.id) })).toMatchObject({ mediaAssetId: s.png.id })
    const items = await listSceneLibrary(s.scene.id)
    expect(items.find((i) => i.id === s.link.id)).toMatchObject({ kind: 'model', url: s.url, status: 'ready', name: 'Chair' })

    // Storage use is unchanged: the bytes moved from one library to the other, and Billing shows the same total
    expect(await storageUsedBytes(s.owner.id)).toBe(before)
    const usage = await app.inject({ method: 'GET', url: '/api/billing/usage', headers: { authorization: `Bearer ${tokenFor(s.owner)}` } })
    expect(usage.json().usage.storageBytes).toBe(before)
    // And the admin overview's storage total doesn't drop either
    const admin = await createUser({ role: 'admin' })
    const stats = await app.inject({ method: 'GET', url: '/api/admin/stats', headers: { authorization: `Bearer ${tokenFor(admin)}` } })
    expect(stats.json().totalStorageBytes).toBe(before)
  })

  it('a scene that places a moved model still carries its working URL', async () => {
    const s = await setup()
    await moveMediaModels()
    const res = await app.inject({ method: 'GET', url: `/api/scenes/${s.scene.id}`, headers: { authorization: `Bearer ${tokenFor(s.owner)}` } })
    const el = res.json().scene.presets[0].elements.find((e: { type: string }) => e.type === 'model')
    expect(el.properties.modelSrc).toBe(s.url)
    expect(el.instances).toHaveLength(1)
    // The file is still served at that URL
    const file = await app.inject({ method: 'GET', url: new URL(s.url).pathname })
    expect(file.statusCode).toBe(200)
    expect(file.rawPayload.equals(GLB)).toBe(true)
    // The editor still names it, and a Decentraland deploy still knows its size
    expect((await resolveMediaNames(s.scene.id, s.owner.id, [s.url])).names[s.url]).toBe('Chair')
    expect((await modelsInScene(s.scene.id))[0]).toMatchObject({ url: s.url, bytes: GLB.length })
    // It shows in the owner's 3D Models
    const mine = await app.inject({ method: 'GET', url: '/api/assets?mine=all', headers: { authorization: `Bearer ${tokenFor(s.owner)}` } })
    expect(mine.json().assets.map((a: { cdnUrl: string }) => a.cdnUrl).sort()).toEqual([s.url, (await db.query.assetLibraryItems.findFirst({ where: eq(assetLibraryItems.name, 'lamp') }))!.cdnUrl].sort())
  })

  it('is safe to run twice, and concurrently', async () => {
    await setup()
    const [a, b] = await Promise.all([moveMediaModels(), moveMediaModels()])
    expect(a.moved + b.moved).toBe(2)
    expect(await moveMediaModels()).toEqual({ moved: 0, dropped: 0, failed: 0 })
    expect(await db.select().from(assetLibraryItems)).toHaveLength(2)
  })

  it('drops model uploads that never stored a file, and leaves ones still in flight', async () => {
    const s = await setup()
    const [failed] = await db.insert(mediaAssets).values({ ownerId: s.owner.id, filename: 'x.glb', contentType: 'model/gltf-binary', sizeBytes: 5, status: 'failed', error: 'too_large' }).returning()
    const [stale] = await db.insert(mediaAssets).values({ ownerId: s.owner.id, filename: 'y.glb', contentType: 'model/gltf-binary', sizeBytes: 5, status: 'uploading', createdAt: new Date(Date.now() - 20 * 60_000) }).returning()
    const [fresh] = await db.insert(mediaAssets).values({ ownerId: s.owner.id, filename: 'z.glb', contentType: 'model/gltf-binary', sizeBytes: 5, status: 'uploading' }).returning()
    await db.insert(sceneLibrary).values({ sceneId: s.scene.id, mediaAssetId: failed.id })
    expect(await moveMediaModels()).toEqual({ moved: 2, dropped: 2, failed: 0 })
    const left = (await db.select().from(mediaAssets)).map((m) => m.id).sort()
    expect(left).toEqual([s.png.id, fresh.id].sort())
    void stale
  })

  it("doesn't touch existing 3D Models items (public ones stay public) or images", async () => {
    const s = await setup()
    const [pub] = await db.insert(assetLibraryItems).values({ name: 'Shared', storageKey: 'assets/x.glb', cdnUrl: 'https://x/s.glb', isPublic: true, uploadedBy: s.owner.id }).returning()
    await moveMediaModels()
    expect((await db.query.assetLibraryItems.findFirst({ where: eq(assetLibraryItems.id, pub.id) }))!.isPublic).toBe(true)
    expect((await moveMediaModel(s.png.id)).result).toBe('skipped')
  })

  it('a phone upload of a model reserved in media before the deploy moves once its bytes arrive, keeping its link', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    await db.insert(uploadTokens).values({ code: 'legacy', userId: owner.id, sceneId: scene.id, maxUploads: 5, minterVerified: true, expiresAt: new Date(Date.now() + 60_000) })
    const [m] = await db.insert(mediaAssets).values({ ownerId: owner.id, filename: 'Old.glb', contentType: 'model/gltf-binary', sizeBytes: GLB.length, status: 'uploading', metadata: { uploadCode: 'legacy' } }).returning()
    const [link] = await db.insert(sceneLibrary).values({ sceneId: scene.id, mediaAssetId: m.id, addedBy: owner.id }).returning()
    const res = await app.inject({ method: 'POST', url: `/api/upload/legacy/${m.id}`, payload: { fileData: GLB.toString('base64') } })
    expect(res.statusCode).toBe(201)
    expect(await db.select().from(mediaAssets)).toHaveLength(0)
    const [item] = await listSceneLibrary(scene.id)
    expect(item).toMatchObject({ id: link.id, kind: 'model', status: 'ready', name: 'Old' })
    expect(res.json().asset).toMatchObject({ cdnUrl: item.url, uploadedBy: owner.id, isPublic: false })
  })

  it('decides "model" by type: an image named .glb stays in media; an octet-stream .glb moves', async () => {
    const s = await setup()
    const [img] = await db.insert(mediaAssets).values({ ownerId: s.owner.id, filename: 'poster.glb', contentType: 'image/png', sizeBytes: 9, storageKey: 'p.png', publicUrl: 'https://x/p.png' }).returning()
    expect(await moveMediaModels()).toEqual({ moved: 2, dropped: 0, failed: 0 })
    expect(await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.id, img.id) })).toBeTruthy()
    expect(await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.id, s.old.id) })).toBeUndefined()
  })

  it('one row that fails is logged and left for next boot; the others still move', async () => {
    const s = await setup()
    await db.execute(sql`CREATE OR REPLACE FUNCTION liv132_refuse() RETURNS trigger AS $$ BEGIN IF NEW.name = 'Chair' THEN RAISE EXCEPTION 'refused'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`)
    await db.execute(sql`CREATE TRIGGER liv132_refuse BEFORE INSERT ON asset_library_items FOR EACH ROW EXECUTE FUNCTION liv132_refuse()`)
    try {
      expect(await moveMediaModels()).toEqual({ moved: 1, dropped: 0, failed: 1 })
      expect(await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.id, s.glb.id) })).toBeTruthy()
    } finally {
      await db.execute(sql`DROP TRIGGER liv132_refuse ON asset_library_items`)
      await db.execute(sql`DROP FUNCTION liv132_refuse()`)
    }
    expect(await moveMediaModels()).toEqual({ moved: 1, dropped: 0, failed: 0 })
    expect(await db.query.sceneLibrary.findFirst({ where: eq(sceneLibrary.id, s.link.id) })).toMatchObject({ mediaAssetId: null })
  })
})
