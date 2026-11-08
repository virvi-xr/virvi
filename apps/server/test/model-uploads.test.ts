import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { assetLibraryItems, mediaAssets, sceneLibrary, sceneRoles } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { listSceneLibrary } from '../src/library/scene-library.js'
import { reserveMedia, storeMedia, StoreMediaError } from '../src/media/store.js'
import { assertStorageQuota, storageUsedBytes } from '../src/media/quota.js'
import { createStorage } from '../src/storage/index.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor, type TestUser } from './helpers/factories.js'

// Not a real GLB: uploads check the name, declared type and size only
const GLB = Buffer.from('glTF-model-bytes').toString('base64')
const GLB_BYTES = Buffer.from(GLB, 'base64').length

/** LIV-132: models uploaded in-world go in 3D Models (asset_library_items), private, linked to the scene. */
describe('in-world model uploads go to 3D Models', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  const prev = config.allFeaturesUnlocked
  beforeEach(async () => { await resetDb(); config.allFeaturesUnlocked = true; app = await testApp() })
  afterEach(async () => { config.allFeaturesUnlocked = prev; await app.close() })

  async function setup() {
    const owner = await createUser()
    const editor = await createUser({ wallet: '0x00000000000000000000000000000000000000e2' })
    const { scene } = await createScene(owner)
    await db.insert(sceneRoles).values({ sceneId: scene.id, userId: editor.id, walletAddress: editor.wallet!, role: 'editor' } as any)
    return { owner, editor, scene }
  }
  const mint = async (user: TestUser, sceneId: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/upload-tokens', headers: { authorization: `Bearer ${tokenFor(user)}` }, payload: { sceneId, kinds: ['image', 'model'] } })
    expect(res.statusCode).toBe(201)
    return res.json().token.code as string
  }
  const start = (code: string, body: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: `/api/upload/${code}/start`, payload: { filename: 'Chair.glb', contentType: 'model/gltf-binary', sizeBytes: GLB_BYTES, ...body } })
  const send = (code: string, id: string, data = GLB) => app.inject({ method: 'POST', url: `/api/upload/${code}/${id}`, payload: { fileData: data } })
  const model = async (id: string) => (await db.query.assetLibraryItems.findFirst({ where: eq(assetLibraryItems.id, id) }))!

  it('a phone upload reserves a private model in the owner account, linked to the scene, then stores it', async () => {
    const s = await setup()
    const code = await mint(s.editor, s.scene.id)
    const st = await start(code)
    expect(st.statusCode).toBe(201)
    const { assetId } = st.json()
    expect(await db.select().from(mediaAssets)).toHaveLength(0)
    expect(await model(assetId)).toMatchObject({ status: 'uploading', uploadedBy: s.owner.id, isPublic: false, cdnUrl: null, name: 'Chair', fileSizeBytes: GLB_BYTES })
    const [link] = await db.select().from(sceneLibrary).where(eq(sceneLibrary.assetItemId, assetId))
    expect(link).toMatchObject({ sceneId: s.scene.id, addedBy: s.editor.id, mediaAssetId: null })
    expect((await listSceneLibrary(s.scene.id))[0]).toMatchObject({ id: link.id, kind: 'model', status: 'uploading', url: '' })

    expect((await send(code, assetId)).statusCode).toBe(201)
    const stored = await model(assetId)
    expect(stored.status).toBe('ready')
    expect(stored.cdnUrl).toMatch(/\/assets\/.+\.glb$/)
    const [item] = await listSceneLibrary(s.scene.id)
    expect(item).toMatchObject({ id: link.id, kind: 'model', status: 'ready', url: stored.cdnUrl, contentType: 'model/gltf-binary' })
    // The file is served where its URL says
    const file = await app.inject({ method: 'GET', url: new URL(stored.cdnUrl!).pathname })
    expect(file.statusCode).toBe(200)
    expect(file.rawPayload.toString('base64')).toBe(GLB)
    // It shows in the owner's 3D Models, not anyone's Images & Video
    const mine = await app.inject({ method: 'GET', url: '/api/assets?mine=all', headers: { authorization: `Bearer ${tokenFor(s.owner)}` } })
    expect(mine.json().assets.map((a: { id: string }) => a.id)).toEqual([assetId])
    const media = await app.inject({ method: 'GET', url: '/api/media', headers: { authorization: `Bearer ${tokenFor(s.owner)}` } })
    expect(media.json().assets).toEqual([])
  })

  it('images from the same code still go to Images & Video', async () => {
    const s = await setup()
    const code = await mint(s.editor, s.scene.id)
    const { assetId } = (await start(code, { filename: 'a.png', contentType: 'image/png', sizeBytes: 68 })).json()
    expect(await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.id, assetId) })).toBeTruthy()
    expect(await db.select().from(assetLibraryItems)).toHaveLength(0)
  })

  it('a second data post is 409, another code is 404, bad bytes mark the model failed', async () => {
    const s = await setup()
    const a = await mint(s.editor, s.scene.id)
    const b = await mint(s.editor, s.scene.id)
    const { assetId } = (await start(a)).json()
    expect((await send(b, assetId)).statusCode).toBe(404)
    expect((await send(a, assetId)).statusCode).toBe(201)
    // Stored: its upload code is cleared, so the code no longer reaches it
    expect((await send(a, assetId)).statusCode).toBe(404)
    expect((await model(assetId)).uploadCode).toBeNull()
    const small = (await start(a, { sizeBytes: 3 })).json().assetId
    expect((await send(a, small)).statusCode).toBe(413)
    expect(await model(small)).toMatchObject({ status: 'failed', error: 'too_large', cdnUrl: null, uploadCode: null })
  })

  it('in-flight and failed models stay out of 3D Models browsing until stored', async () => {
    const s = await setup()
    const code = await mint(s.owner, s.scene.id)
    await start(code)
    const res = await app.inject({ method: 'GET', url: '/api/assets?mine=all', headers: { authorization: `Bearer ${tokenFor(s.owner)}` } })
    expect(res.json()).toMatchObject({ assets: [], total: 0 })
  })

  it('abandoned model uploads are marked failed, and any editor can dismiss one (removing it)', async () => {
    const s = await setup()
    const code = await mint(s.owner, s.scene.id)
    const { assetId } = (await start(code)).json()
    await db.update(assetLibraryItems).set({ createdAt: new Date(Date.now() - 16 * 60_000) }).where(eq(assetLibraryItems.id, assetId))
    const [item] = await listSceneLibrary(s.scene.id)
    expect(item).toMatchObject({ kind: 'model', status: 'failed', error: "Upload didn't finish" })
    const del = await app.inject({ method: 'DELETE', url: `/api/scenes/${s.scene.id}/library/${item.id}`, headers: { authorization: `Bearer ${tokenFor(s.editor)}` } })
    expect(del.statusCode).toBe(204)
    expect(await db.query.assetLibraryItems.findFirst({ where: eq(assetLibraryItems.id, assetId) })).toBeUndefined()
  })

  it('unlinking a stored model keeps it in 3D Models', async () => {
    const s = await setup()
    const code = await mint(s.owner, s.scene.id)
    const { assetId } = (await start(code)).json()
    await send(code, assetId)
    const [item] = await listSceneLibrary(s.scene.id)
    const del = await app.inject({ method: 'DELETE', url: `/api/scenes/${s.scene.id}/library/${item.id}`, headers: { authorization: `Bearer ${tokenFor(s.owner)}` } })
    expect(del.statusCode).toBe(204)
    expect((await model(assetId)).status).toBe('ready')
  })

  it('a reserved model counts toward the owner storage, like a reserved image', async () => {
    const s = await setup()
    const code = await mint(s.owner, s.scene.id)
    await start(code, { sizeBytes: 40 * 1024 * 1024 })
    expect(await storageUsedBytes(s.owner.id)).toBe(40 * 1024 * 1024)
    config.allFeaturesUnlocked = false
    // Free tier: 500 MB
    await expect(assertStorageQuota(s.owner.id, 470 * 1024 * 1024)).rejects.toBeInstanceOf(StoreMediaError)
  })

  it('the SDK scene-library upload stores a GLB in 3D Models, private, linked', async () => {
    const s = await setup()
    const res = await app.inject({
      method: 'POST', url: `/api/scenes/${s.scene.id}/library/upload`, headers: { authorization: `Bearer ${tokenFor(s.editor, { kind: 'scene', sceneId: s.scene.id, orgId: null })}` },
      payload: { filename: 'Lamp.glb', contentType: 'model/gltf-binary', data: GLB },
    })
    expect(res.statusCode).toBe(201)
    const { item } = res.json()
    expect(item).toMatchObject({ kind: 'model', status: 'ready', name: 'Lamp', contentType: 'model/gltf-binary' })
    const a = await db.query.assetLibraryItems.findFirst({ where: eq(assetLibraryItems.cdnUrl, item.url) })
    expect(a).toMatchObject({ uploadedBy: s.owner.id, isPublic: false, status: 'ready' })
    expect(await db.select().from(mediaAssets)).toHaveLength(0)
    const link = await db.query.sceneLibrary.findFirst({ where: eq(sceneLibrary.id, item.id) })
    expect(link).toMatchObject({ assetItemId: a!.id, addedBy: s.editor.id })
  })

  it('an editor renames an uploaded model in-world; catalog models stay dashboard-only', async () => {
    const s = await setup()
    const code = await mint(s.owner, s.scene.id)
    const { assetId } = (await start(code)).json()
    const [busy] = await listSceneLibrary(s.scene.id)
    const rename = (linkId: string, name: string) =>
      app.inject({ method: 'PATCH', url: `/api/scenes/${s.scene.id}/library/${linkId}`, headers: { authorization: `Bearer ${tokenFor(s.editor)}` }, payload: { name } })
    expect((await rename(busy.id, 'x')).statusCode).toBe(409)
    await send(code, assetId)
    const res = await rename(busy.id, '  Big chair ')
    expect(res.statusCode).toBe(200)
    expect(res.json().item).toMatchObject({ id: busy.id, kind: 'model', name: 'Big chair' })
    expect((await model(assetId)).name).toBe('Big chair')
    // Someone else's shared model, linked by the backfill: not renamable from this scene
    const other = await createUser()
    const [shared] = await db.insert(assetLibraryItems).values({ name: 'Theirs', storageKey: 'k', cdnUrl: 'https://x/t.glb', isPublic: true, uploadedBy: other.id }).returning()
    const [l] = await db.insert(sceneLibrary).values({ sceneId: s.scene.id, assetItemId: shared.id }).returning()
    expect((await rename(l.id, 'Mine now')).statusCode).toBe(400)
  })

  it('every way into Images & Video refuses models', async () => {
    const s = await setup()
    for (const file of [{ filename: 'm.glb', contentType: 'model/gltf-binary' }, { filename: 'm.glb', contentType: 'application/octet-stream' }, { filename: 'm.gltf', contentType: 'model/gltf+json' }]) {
      await expect(reserveMedia(s.owner.id, { ...file, sizeBytes: 3 })).rejects.toMatchObject({ status: 415, body: { error: 'use_asset_library' } })
      await expect(storeMedia(s.owner.id, { ...file, data: Buffer.from('abc') })).rejects.toMatchObject({ status: 415 })
    }
    expect(await db.select().from(mediaAssets)).toHaveLength(0)
  })

  it('never shows an upload code in asset responses', async () => {
    const s = await setup()
    const code = await mint(s.owner, s.scene.id)
    const { assetId } = (await start(code)).json()
    const one = await app.inject({ method: 'GET', url: `/api/assets/${assetId}`, headers: { authorization: `Bearer ${tokenFor(s.owner)}` } })
    expect(one.statusCode).toBe(200)
    expect(one.json().asset).not.toHaveProperty('uploadCode')
    const sent = await send(code, assetId)
    expect(sent.json().asset).not.toHaveProperty('uploadCode')
    await db.update(assetLibraryItems).set({ isPublic: true, uploadCode: 'leaked' }).where(eq(assetLibraryItems.id, assetId))
    const list = await app.inject({ method: 'GET', url: '/api/assets' })
    expect(list.json().assets[0]).not.toHaveProperty('uploadCode')
  })

  it("a model can't be deleted from 3D Models while it uploads, and a dismissed one leaves no file", async () => {
    const s = await setup()
    const code = await mint(s.owner, s.scene.id)
    const { assetId } = (await start(code)).json()
    const del = await app.inject({ method: 'DELETE', url: `/api/assets/${assetId}`, headers: { authorization: `Bearer ${tokenFor(s.owner)}` } })
    expect(del.statusCode).toBe(409)
    // Removed while its bytes were being stored: the fill finds no row and deletes the file it wrote
    const { fillModel } = await import('../src/library/model-uploads.js')
    const row = await model(assetId)
    await db.update(assetLibraryItems).set({ status: 'uploading' }).where(eq(assetLibraryItems.id, assetId))
    const proto = Object.getPrototypeOf(createStorage())
    const original = proto.upload
    const upload = vi.spyOn(proto, 'upload').mockImplementationOnce(async function (this: unknown, ...args: unknown[]) {
      await db.delete(assetLibraryItems).where(eq(assetLibraryItems.id, assetId)) // dismissed mid-store
      return original.apply(this, args)
    })
    await expect(fillModel(assetId, Buffer.from(GLB, 'base64'))).rejects.toMatchObject({ status: 404 })
    upload.mockRestore()
    const file = await app.inject({ method: 'GET', url: `/uploads/${row.storageKey}` })
    expect(file.statusCode).toBe(404)
  })

  it('My Models lists newest first, so a just-uploaded model is on the first page', async () => {
    const s = await setup()
    const at = (m: number) => new Date(Date.now() - m * 60_000)
    await db.insert(assetLibraryItems).values([
      { name: 'old', storageKey: 'a', cdnUrl: 'https://x/a.glb', isPublic: false, uploadedBy: s.owner.id, createdAt: at(30) },
      { name: 'new', storageKey: 'b', cdnUrl: 'https://x/b.glb', isPublic: false, uploadedBy: s.owner.id, createdAt: at(1) },
      { name: 'mid', storageKey: 'c', cdnUrl: 'https://x/c.glb', isPublic: false, uploadedBy: s.owner.id, createdAt: at(10) },
    ])
    const res = await app.inject({ method: 'GET', url: '/api/assets?mine=all&limit=2', headers: { authorization: `Bearer ${tokenFor(s.owner)}` } })
    expect(res.json().assets.map((a: { name: string }) => a.name)).toEqual(['new', 'mid'])
    expect(res.json().total).toBe(3)
  })
})
