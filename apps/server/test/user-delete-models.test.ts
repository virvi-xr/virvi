import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import bcrypt from 'bcryptjs'
import { db } from '../src/db/connection.js'
import { assetLibraryItems, catalogPacks, mediaAssets, sceneLibrary, userAuthMethods, users } from '../src/db/schema.js'
import { createStorage } from '../src/storage/index.js'
import { moveMediaModels } from '../src/library/move-media-models.js'
import { sweepTrials } from '../src/auth/trial-sweep.js'
import { mergeTrial } from '../src/auth/trial-convert.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, createElement, tokenFor, type TestUser } from './helpers/factories.js'

const storage = createStorage()
const GLB = Buffer.from('glTF-user-model')

/** LIV-132 fix round 1 (I1): deleting an account takes its private 3D Models with it; public ones stay, ownerless. */
describe('deleting an account with 3D Models', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { await app.close() })

  const served = async (url: string) => (await app.inject({ method: 'GET', url: new URL(url).pathname })).statusCode
  const exists = async (id: string) => !!(await db.query.assetLibraryItems.findFirst({ where: eq(assetLibraryItems.id, id) }))

  /** A moved Media GLB (private, linked in their scene), a public upload, and a catalog model they linked. */
  async function owner(u?: TestUser) {
    const user = u ?? await createUser()
    const { scene } = await createScene(user)
    const key = `${user.id}/${randomUUID()}.glb`
    const url = await storage.upload(key, GLB, 'model/gltf-binary')
    const [m] = await db.insert(mediaAssets).values({ ownerId: user.id, filename: 'Old.glb', contentType: 'model/gltf-binary', sizeBytes: GLB.length, storageKey: key, publicUrl: url }).returning()
    await db.insert(sceneLibrary).values({ sceneId: scene.id, mediaAssetId: m.id, addedBy: user.id })
    await moveMediaModels()
    const priv = (await db.query.assetLibraryItems.findFirst({ where: eq(assetLibraryItems.cdnUrl, url) }))!
    const pubKey = `assets/${user.id}/${randomUUID()}.glb`
    const pubUrl = await storage.upload(pubKey, GLB, 'model/gltf-binary')
    const [pub] = await db.insert(assetLibraryItems).values({ name: 'Shared', storageKey: pubKey, cdnUrl: pubUrl, isPublic: true, uploadedBy: user.id }).returning()
    await db.insert(catalogPacks).values({ id: 'p1', name: 'P', source: 'decentraland', license: 'mit', attribution: 'a', sourceUrl: 'https://x' }).onConflictDoNothing()
    const [cat] = await db.insert(assetLibraryItems).values({ name: 'Cat', storageKey: 'catalog/c.glb', cdnUrl: 'https://cdn/c.glb', isPublic: true, packId: 'p1' }).returning()
    return { user, scene, priv, pub, cat, url, pubUrl }
  }

  async function expectReleased(o: Awaited<ReturnType<typeof owner>>) {
    expect(await exists(o.priv.id)).toBe(false)
    expect(await served(o.url)).toBe(404) // its file went after the delete committed
    const pub = await db.query.assetLibraryItems.findFirst({ where: eq(assetLibraryItems.id, o.pub.id) })
    expect(pub).toMatchObject({ uploadedBy: null, isPublic: true })
    expect(await served(o.pubUrl)).toBe(200)
    expect(await exists(o.cat.id)).toBe(true)
  }

  it('self-delete: 204, private models and their files go, public ones stay ownerless', async () => {
    const o = await owner()
    await db.insert(userAuthMethods).values({ userId: o.user.id, type: 'email', identifier: o.user.email!, credentialHash: await bcrypt.hash('pw-1234', 4) })
    const r = await app.inject({ method: 'DELETE', url: '/api/auth/account', payload: { password: 'pw-1234' }, headers: { authorization: `Bearer ${tokenFor(o.user)}` } })
    expect(r.statusCode).toBe(204)
    await expectReleased(o)
  })

  it('admin delete: 204, same', async () => {
    const o = await owner()
    const admin = await createUser({ role: 'admin' })
    const r = await app.inject({ method: 'DELETE', url: `/api/admin/users/${o.user.id}`, headers: { authorization: `Bearer ${tokenFor(admin)}` } })
    expect(r.statusCode).toBe(204)
    await expectReleased(o)
  })

  it("keeps a private model's file that a surviving scene still places", async () => {
    const o = await owner()
    const other = await createUser()
    const { preset } = await createScene(other)
    await createElement(preset.id, { type: 'model', properties: { modelSrc: o.url } })
    const admin = await createUser({ role: 'admin' })
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/users/${o.user.id}`, headers: { authorization: `Bearer ${tokenFor(admin)}` } })).statusCode).toBe(204)
    expect(await exists(o.priv.id)).toBe(false)
    expect(await served(o.url)).toBe(200)
  })

  it('the trial sweep expires a trial that owns models', async () => {
    const t = await createUser({ email: null, name: 'Guest' })
    await db.update(users).set({ isTrial: true, trialLastActiveAt: new Date(Date.now() - 400 * 86400_000) }).where(eq(users.id, t.id))
    const o = await owner(t)
    expect(await sweepTrials(new Date())).toEqual({ expired: 1 })
    expect(await db.query.users.findFirst({ where: eq(users.id, t.id) })).toBeUndefined()
    await expectReleased(o)
  })

  it("a trial the sweep doesn't expire keeps its models", async () => {
    const t = await createUser({ email: null, name: 'Guest' })
    await db.update(users).set({ isTrial: true, trialLastActiveAt: new Date() }).where(eq(users.id, t.id))
    const o = await owner(t)
    expect(await sweepTrials(new Date())).toEqual({ expired: 0 })
    expect(await exists(o.priv.id)).toBe(true)
  })

  it("merging a trial into an account moves the trial's models to the account, as they are", async () => {
    const t = await createUser({ email: null, name: 'Guest' })
    await db.update(users).set({ isTrial: true, trialLastActiveAt: new Date() }).where(eq(users.id, t.id))
    const o = await owner(t)
    const account = await createUser()
    expect(await mergeTrial(t.id, account.id)).toEqual({ headsets: 0 })
    expect(await db.query.assetLibraryItems.findFirst({ where: eq(assetLibraryItems.id, o.priv.id) })).toMatchObject({ uploadedBy: account.id, isPublic: false })
    expect(await db.query.assetLibraryItems.findFirst({ where: eq(assetLibraryItems.id, o.pub.id) })).toMatchObject({ uploadedBy: account.id, isPublic: true })
    expect(await served(o.url)).toBe(200)
  })
})
