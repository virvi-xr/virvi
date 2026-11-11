import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor } from './helpers/factories.js'
import { classifyUpload, extensionFor, IMAGE_MAX_BYTES, MODEL_MAX_BYTES, VIDEO_MAX_BYTES } from '../src/storage/upload-policy.js'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { eq } from 'drizzle-orm'
import { assetLibraryItems, mediaAssets, sceneLibrary, uploadTokens } from '../src/db/schema.js'
import { createScene } from './helpers/factories.js'

describe('classifyUpload', () => {
  it('enforces image size boundary', () => {
    expect(classifyUpload('a.png', 'image/png', IMAGE_MAX_BYTES)).toEqual({ ok: true, contentType: 'image/png' })
    expect(classifyUpload('a.png', 'image/png', IMAGE_MAX_BYTES + 1)).toEqual({ ok: false, status: 413, error: 'too_large' })
  })
  it('accepts GLB by extension case-insensitively and normalizes type', () => {
    expect(classifyUpload('DUCK.GLB', 'application/octet-stream', 10)).toEqual({ ok: true, contentType: 'model/gltf-binary' })
    expect(classifyUpload('duck.glb', 'model/gltf-binary', MODEL_MAX_BYTES)).toEqual({ ok: true, contentType: 'model/gltf-binary' })
    expect(classifyUpload('duck.glb', 'model/gltf-binary', MODEL_MAX_BYTES + 1)).toMatchObject({ ok: false, status: 413 })
  })
  it('accepts MP4 and WebM video up to 70 MB', () => {
    expect(VIDEO_MAX_BYTES).toBe(70 * 1024 * 1024)
    expect(classifyUpload('clip.mp4', 'video/mp4', VIDEO_MAX_BYTES)).toEqual({ ok: true, contentType: 'video/mp4' })
    expect(classifyUpload('clip.webm', 'VIDEO/WEBM', VIDEO_MAX_BYTES)).toEqual({ ok: true, contentType: 'video/webm' })
    expect(classifyUpload('clip.mp4', 'video/mp4', VIDEO_MAX_BYTES + 1)).toEqual({ ok: false, status: 413, error: 'too_large' })
    expect(classifyUpload('clip.webm', 'video/webm', VIDEO_MAX_BYTES + 1)).toEqual({ ok: false, status: 413, error: 'too_large' })
    expect(classifyUpload('clip.mov', 'video/quicktime', 5)).toMatchObject({ ok: false, status: 415 })
  })
  it('maps video types to mp4/webm extensions', () => {
    expect(extensionFor('video/mp4')).toBe('mp4')
    expect(extensionFor('video/webm')).toBe('webm')
  })
  it('a max-size video fits the request body limit as base64 JSON', () => {
    const base64Len = Math.ceil(VIDEO_MAX_BYTES / 3) * 4
    expect(base64Len + 1024).toBeLessThan(config.maxUploadSize)
  })
  it('rejects other types', () => {
    expect(classifyUpload('a.html', 'text/html', 5)).toEqual({ ok: false, status: 415, error: 'unsupported_type' })
    expect(classifyUpload('a.bin', 'application/octet-stream', 5)).toMatchObject({ ok: false, status: 415 })
    expect(classifyUpload('a.svg', 'image/svg+xml', 5)).toMatchObject({ ok: false, status: 415 })
  })
})

describe('POST /api/media/upload', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(() => app.close())

  async function upload(filename: string, contentType: string, bytes: number) {
    const user = await createUser()
    return app.inject({
      method: 'POST',
      url: '/api/media/upload',
      headers: { authorization: `Bearer ${tokenFor(user)}` },
      payload: { filename, contentType, data: Buffer.alloc(bytes, 1).toString('base64') },
    })
  }

  it('accepts a small PNG', async () => {
    const res = await upload('a.png', 'image/png', 1024)
    expect(res.statusCode).toBe(201)
    expect(res.json().asset.contentType).toBe('image/png')
  })
  // LIV-132: Images & Video holds images and video; 3D models go in 3D Models
  it.each([
    ['duck.glb', 'application/octet-stream'],
    ['DUCK.GLB', 'model/gltf-binary'],
    ['duck.gltf', 'model/gltf+json'],
    ['duck.gltf', 'application/octet-stream'],
    ['duck', 'model/gltf-binary'],
  ])('refuses 3D model %s (%s), pointing to 3D Models, and stores nothing', async (filename, contentType) => {
    const res = await upload(filename, contentType, 1024)
    expect(res.statusCode).toBe(415)
    expect(res.json().error).toBe('use_asset_library')
    expect(res.json().message).toMatch(/3D Models page/)
    expect(await db.select().from(mediaAssets)).toHaveLength(0)
  })
  it('accepts a small MP4 and stores it as .mp4', async () => {
    const res = await upload('clip.mp4', 'video/mp4', 1024)
    expect(res.statusCode).toBe(201)
    expect(res.json().asset.contentType).toBe('video/mp4')
    expect(res.json().asset.storageKey).toMatch(/\.mp4$/)
  })
  it('rejects text/html with 415', async () => {
    const res = await upload('a.html', 'text/html', 100)
    expect(res.statusCode).toBe(415)
    expect(res.json().error).toBe('unsupported_type')
  })
  it('rejects an 11 MB PNG with 413', async () => {
    const res = await upload('big.png', 'image/png', 11 * 1024 * 1024)
    expect(res.statusCode).toBe(413)
    expect(res.json().error).toBe('too_large')
  })
  it('refuses a 51 MB GLB as a model, not for its size', async () => {
    const res = await upload('big.glb', 'model/gltf-binary', 51 * 1024 * 1024)
    expect(res.statusCode).toBe(415)
    expect(res.json().error).toBe('use_asset_library')
  })
})

// LIV-132: scene-level uploads (the SDK's scene library upload, phone uploads) store models in 3D Models instead
describe('scene-level uploads store GLBs in 3D Models', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(() => app.close())

  it('POST /api/scenes/:id/library/upload stores a GLB as a private model, not media', async () => {
    const owner = await createUser(); const { scene } = await createScene(owner)
    const res = await app.inject({
      method: 'POST', url: `/api/scenes/${scene.id}/library/upload`, headers: { authorization: `Bearer ${tokenFor(owner)}` },
      payload: { filename: 'duck.glb', contentType: 'model/gltf-binary', data: Buffer.alloc(64, 1).toString('base64') },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().item).toMatchObject({ kind: 'model', name: 'duck' })
    expect(await db.select().from(mediaAssets)).toHaveLength(0)
    expect(await db.select().from(assetLibraryItems)).toMatchObject([{ uploadedBy: owner.id, isPublic: false, fileSizeBytes: 64 }])
  })
})

describe('POST /api/upload/:code (phone upload)', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(() => app.close())

  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  async function setup() {
    const user = await createUser(); const { scene } = await createScene(user)
    await db.insert(uploadTokens).values({ code: 'phone2', userId: user.id, sceneId: scene.id, maxUploads: 5, minterVerified: true, expiresAt: new Date(Date.now() + 60_000) })
    // start, then (when started) send the bytes
    const post = async (payload: { filename: string; contentType: string; fileData: string }) => {
      const st = await app.inject({ method: 'POST', url: '/api/upload/phone2/start', payload: { filename: payload.filename, contentType: payload.contentType, sizeBytes: Buffer.from(payload.fileData, 'base64').length } })
      if (st.statusCode !== 201) return st
      return app.inject({ method: 'POST', url: `/api/upload/phone2/${st.json().assetId}`, payload: { fileData: payload.fileData } })
    }
    return { user, scene, post }
  }

  it('stores a valid PNG as a media row and links it to the scene library', async () => {
    const { scene, post } = await setup()
    const res = await post({ filename: 'a.png', contentType: 'image/png', fileData: PNG })
    expect(res.statusCode).toBe(201)
    expect(res.json().asset.contentType).toBe('image/png')
    const [t] = await db.select().from(uploadTokens).where(eq(uploadTokens.code, 'phone2'))
    expect(t.uploadCount).toBe(1)
    const links = await db.select().from(sceneLibrary).where(eq(sceneLibrary.sceneId, scene.id))
    expect(links.map((l) => l.mediaAssetId)).toEqual([res.json().asset.id])
  })

  it('refuses html and path-laden names without spending an upload', async () => {
    const { post } = await setup()
    const html = await post({ filename: '../x.png', contentType: 'text/html', fileData: PNG })
    expect(html.statusCode).toBe(415)
    expect(html.json().error).toBe('unsupported_type')
    const [t] = await db.select().from(uploadTokens).where(eq(uploadTokens.code, 'phone2'))
    expect(t.uploadCount).toBe(0)
    const ok = await post({ filename: '../x.png', contentType: 'image/png', fileData: PNG })
    expect(ok.statusCode).toBe(201)
    expect(ok.json().asset.storageKey).not.toContain('..')
    void mediaAssets
  })

  it('clamps token limits', async () => {
    const user = await createUser()
    const res = await app.inject({ method: 'POST', url: '/api/upload-tokens', headers: { authorization: `Bearer ${tokenFor(user)}` }, payload: { maxUploads: 100000, expiresInMinutes: 100000 } })
    expect(res.statusCode).toBe(201)
    expect(res.json().token.maxUploads).toBe(50)
    expect(new Date(res.json().token.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000)
  })
})
