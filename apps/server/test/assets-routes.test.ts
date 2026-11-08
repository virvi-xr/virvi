import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { assetLibraryItems, mediaAssets, users } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { resetDb } from './helpers/db.js'
import { assertStorageQuota } from '../src/media/quota.js'
import { testApp, createUser, tokenFor } from './helpers/factories.js'

describe('asset library routes', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  const prevUnlocked = config.allFeaturesUnlocked
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { config.allFeaturesUnlocked = prevUnlocked; await app.close() })

  const post = (user: Awaited<ReturnType<typeof createUser>>, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/assets', headers: { authorization: `Bearer ${tokenFor(user)}` }, payload: { name: 'Duck', filename: 'duck.glb', contentType: 'model/gltf-binary', fileData: 'AAAA', ...payload } })

  it('stores under a server-chosen key, ignoring path segments in the filename', async () => {
    const u = await createUser()
    const res = await post(u, { filename: '../../evil.glb' })
    expect(res.statusCode).toBe(201)
    const { asset } = res.json()
    expect(asset.storageKey).toMatch(new RegExp(`^assets/${u.id}/[0-9a-f-]{36}\\.glb$`))
    expect(asset.storageKey).not.toContain('..')
    expect(asset.isPublic).toBe(false)
  })

  it('refuses html and non-model uploads', async () => {
    const u = await createUser()
    const html = await post(u, { filename: 'a.html', contentType: 'text/html' })
    expect(html.statusCode).toBe(415)
    expect(html.json().error).toBe('unsupported_type')
    const png = await post(u, { filename: 'a.png', contentType: 'image/png' })
    expect(png.statusCode).toBe(415)
  })

  it('counts media and library bytes against the quota', async () => {
    config.allFeaturesUnlocked = false
    const u = await createUser()
    await db.insert(assetLibraryItems).values({ name: 'Big', storageKey: 'big', fileSizeBytes: 600 * 1024 * 1024, uploadedBy: u.id, isPublic: false })
    const res = await post(u, {})
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('storage_limit_reached')
  })

  it('GET /api/assets/:id: a demoted admin\'s old token no longer shows private assets', async () => {
    const owner = await createUser(); const admin = await createUser({ role: 'admin' })
    const token = tokenFor(admin)
    await db.update(users).set({ role: 'creator' }).where(eq(users.id, admin.id))
    const [priv] = await db.insert(assetLibraryItems).values({ name: 'P', storageKey: 'p', uploadedBy: owner.id, isPublic: false }).returning()
    const res = await app.inject({ method: 'GET', url: `/api/assets/${priv.id}`, headers: { authorization: `Bearer ${token}` } })
    expect(res.statusCode).toBe(404)
  })

  it('GET /api/assets/:id hides private assets from anonymous callers and other users', async () => {
    const owner = await createUser(); const other = await createUser(); const admin = await createUser({ role: 'admin' })
    const [priv] = await db.insert(assetLibraryItems).values({ name: 'P', storageKey: 'p', uploadedBy: owner.id, isPublic: false }).returning()
    const [pub] = await db.insert(assetLibraryItems).values({ name: 'Q', storageKey: 'q', uploadedBy: owner.id, isPublic: true }).returning()
    const get = (id: string, user?: Awaited<ReturnType<typeof createUser>>) =>
      app.inject({ method: 'GET', url: `/api/assets/${id}`, headers: user ? { authorization: `Bearer ${tokenFor(user)}` } : {} })
    expect((await get(priv.id)).statusCode).toBe(404)
    expect((await get(priv.id, other)).statusCode).toBe(404)
    expect((await get(priv.id, owner)).statusCode).toBe(200)
    expect((await get(priv.id, admin)).statusCode).toBe(200)
    expect((await get(pub.id)).statusCode).toBe(200)
    void eq
  })

  it('GET /api/assets?mine= lists only the caller\'s assets: all, Design Studio ones, or uploads', async () => {
    const me = await createUser(); const other = await createUser()
    await db.insert(assetLibraryItems).values([
      { name: 'My upload', storageKey: 'a', uploadedBy: me.id, isPublic: false },
      { name: 'My public upload', storageKey: 'b', uploadedBy: me.id, isPublic: true, sourceRef: 'room-scan:1' },
      { name: 'My sofa', storageKey: 'c', uploadedBy: me.id, isPublic: false, sourceRef: 'studio:ent1:sofa.glb' },
      { name: 'Their public chair', storageKey: 'd', uploadedBy: other.id, isPublic: true },
      { name: 'Their studio lamp', storageKey: 'e', uploadedBy: other.id, isPublic: true, sourceRef: 'studio:ent2:lamp.glb' },
    ])
    const list = async (mine: string, user: Awaited<ReturnType<typeof createUser>> | null = me) => {
      const res = await app.inject({ method: 'GET', url: `/api/assets?mine=${mine}`, headers: user ? { authorization: `Bearer ${tokenFor(user)}` } : {} })
      const ok = res.statusCode === 200
      return { status: res.statusCode, names: ok ? res.json().assets.map((a: { name: string }) => a.name).sort() : [], total: ok ? res.json().total : null }
    }
    expect(await list('all')).toEqual({ status: 200, names: ['My public upload', 'My sofa', 'My upload'], total: 3 })
    expect(await list('studio')).toEqual({ status: 200, names: ['My sofa'], total: 1 })
    expect(await list('uploads')).toEqual({ status: 200, names: ['My public upload', 'My upload'], total: 2 })
    expect(await list('all', null)).toEqual({ status: 200, names: [], total: 0 })
    expect((await list('theirs')).status).toBe(400)
  })

  it('GET /api/assets lists public assets plus the caller\'s own private ones', async () => {
    const owner = await createUser(); const other = await createUser(); const admin = await createUser({ role: 'admin' })
    await db.insert(assetLibraryItems).values({ name: 'Priv', storageKey: 'p', uploadedBy: owner.id, isPublic: false })
    await db.insert(assetLibraryItems).values({ name: 'Pub', storageKey: 'q', uploadedBy: owner.id, isPublic: true })
    const names = async (user?: Awaited<ReturnType<typeof createUser>>) => {
      const res = await app.inject({ method: 'GET', url: '/api/assets', headers: user ? { authorization: `Bearer ${tokenFor(user)}` } : {} })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.total).toBe(body.assets.length)
      return body.assets.map((a: any) => a.name).sort()
    }
    expect(await names()).toEqual(['Pub'])
    expect(await names(owner)).toEqual(['Priv', 'Pub'])
    expect(await names(other)).toEqual(['Pub'])
    expect(await names(admin)).toEqual(['Pub'])
  })

  it('GET /api/assets?scope=public lists public assets only, even the caller\'s own private ones stay out', async () => {
    const owner = await createUser()
    await db.insert(assetLibraryItems).values([
      { name: 'Priv', storageKey: 'p', uploadedBy: owner.id, isPublic: false },
      { name: 'Pub', storageKey: 'q', uploadedBy: owner.id, isPublic: true },
    ])
    const res = await app.inject({ method: 'GET', url: '/api/assets?scope=public', headers: { authorization: `Bearer ${tokenFor(owner)}` } })
    expect(res.json().assets.map((a: any) => a.name)).toEqual(['Pub'])
    expect(res.json().total).toBe(1)
    const bad = await app.inject({ method: 'GET', url: '/api/assets?scope=everything' })
    expect(bad.statusCode).toBe(400)
  })

  it('sums media and library bytes past 2^31 as numbers', async () => {
    config.allFeaturesUnlocked = false
    const u = await createUser()
    for (const k of ['a1', 'a2']) await db.insert(mediaAssets).values({ ownerId: u.id, filename: k, contentType: 'image/png', sizeBytes: 1_500_000_000, storageKey: k, publicUrl: `https://cdn/${k}` })
    await db.insert(assetLibraryItems).values({ name: 'B', storageKey: 'qb', fileSizeBytes: 1_500_000_000, uploadedBy: u.id, isPublic: false })
    await expect(assertStorageQuota(u.id, 1)).rejects.toMatchObject({ body: { error: 'storage_limit_reached', currentUsageBytes: 4_500_000_000 } })
  })

  it('refuses when a media asset and a library asset together cross the limit', async () => {
    config.allFeaturesUnlocked = false
    const u = await createUser()
    await db.insert(mediaAssets).values({ ownerId: u.id, filename: 'a', contentType: 'image/png', sizeBytes: 300 * 1024 * 1024, storageKey: 'qa', publicUrl: 'https://cdn/a' })
    await db.insert(assetLibraryItems).values({ name: 'B', storageKey: 'qb', fileSizeBytes: 300 * 1024 * 1024, uploadedBy: u.id, isPublic: false })
    const res = await post(u, {})
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('storage_limit_reached')
  })
})
