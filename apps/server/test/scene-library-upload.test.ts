import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { bookings, mediaAssets, sceneLibrary, sceneRoles, assetLibraryItems, uploadTokens } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, createElement, tokenFor } from './helpers/factories.js'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

describe('scene library uploads', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  const prevUnlocked = config.allFeaturesUnlocked
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { config.allFeaturesUnlocked = prevUnlocked; await app.close() })

  const upload = (token: string, sceneId: string) => app.inject({ method: 'POST', url: `/api/scenes/${sceneId}/library/upload`, headers: { authorization: `Bearer ${token}` }, payload: { filename: 'a.png', contentType: 'image/png', data: PNG } })

  async function bookedRenter() {
    const H = 3600_000
    const admin = await createUser({ role: 'admin' })
    const { scene, preset } = await createScene(admin)
    const screen = await createElement(preset.id, { type: 'video' })
    const v = await app.inject({ method: 'POST', url: '/api/venues', headers: { authorization: `Bearer ${tokenFor(admin)}` }, payload: { sceneId: scene.id, name: 'Lounge', slug: 'lounge', rentableElementIds: [screen.id] } })
    const renter = await createUser({ wallet: '0x00000000000000000000000000000000000000f1' })
    const startsAt = new Date(Date.now() - 10 * 60_000)
    const b = await app.inject({
      method: 'POST', url: `/api/venues/${v.json().venue.id}/bookings`, headers: { authorization: `Bearer ${tokenFor(admin)}` },
      payload: { renterWallet: renter.wallet, title: 'Set', startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 2 * H).toISOString() },
    })
    expect(b.statusCode).toBe(201)
    return { admin, scene, renter, bookingId: b.json().booking.id as string }
  }

  it("an editor's upload lands in the owner's account and the scene library", async () => {
    const owner = await createUser(); const ed = await createUser({ wallet: '0x00000000000000000000000000000000000000e2' })
    const { scene } = await createScene(owner)
    await db.insert(sceneRoles).values({ sceneId: scene.id, userId: ed.id, walletAddress: ed.wallet!, role: 'editor' } as any)
    const res = await upload(tokenFor(ed, { kind: 'scene', sceneId: scene.id, orgId: null }), scene.id)
    expect(res.statusCode).toBe(201)
    const m = await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.publicUrl, res.json().item.url) })
    expect(m!.ownerId).toBe(owner.id)
    const link = await db.query.sceneLibrary.findFirst({ where: eq(sceneLibrary.mediaAssetId, m!.id) })
    expect(link!.addedBy).toBe(ed.id)
  })

  it('a viewer cannot upload', async () => {
    const owner = await createUser(); const v = await createUser({ wallet: '0x00000000000000000000000000000000000000e3' })
    const { scene } = await createScene(owner)
    await db.insert(sceneRoles).values({ sceneId: scene.id, userId: v.id, walletAddress: v.wallet!, role: 'viewer' } as any)
    expect((await upload(tokenFor(v), scene.id)).statusCode).toBe(403)
  })

  it("owner over quota → 413 with the owner's-storage message", async () => {
    config.allFeaturesUnlocked = false
    const owner = await createUser(); const { scene } = await createScene(owner)
    await db.insert(mediaAssets).values({ ownerId: owner.id, filename: 'big', contentType: 'image/png', sizeBytes: 2_000_000_000, storageKey: 'big', publicUrl: 'https://cdn/big' })
    const res = await upload(tokenFor(owner), scene.id)
    expect(res.statusCode).toBe(413)
    expect(res.json()).toEqual(expect.objectContaining({ error: 'storage_limit_reached', message: "The scene owner's storage is full" }))
  })

  it("a renter's upload during a booking lands in the renter's account with the booking and hides after it ends", async () => {
    const { admin, scene, renter, bookingId } = await bookedRenter()
    const res = await upload(tokenFor(renter), scene.id)
    expect(res.statusCode).toBe(201)
    const m = await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.publicUrl, res.json().item.url) })
    expect(m!.ownerId).toBe(renter.id)
    expect((await db.query.sceneLibrary.findFirst({ where: eq(sceneLibrary.mediaAssetId, m!.id) }))!.bookingId).toBe(bookingId)
    const list = (t: string) => app.inject({ method: 'GET', url: `/api/scenes/${scene.id}/library`, headers: { authorization: `Bearer ${t}` } })
    expect((await list(tokenFor(admin))).json().items.map((i: any) => i.url)).toContain(m!.publicUrl)
    await db.update(bookings).set({ status: 'ended' }).where(eq(bookings.id, bookingId))
    expect((await list(tokenFor(admin))).json().items.map((i: any) => i.url)).not.toContain(m!.publicUrl)
    expect((await upload(tokenFor(renter), scene.id)).statusCode).toBe(403)
  })

  it('a renter over their own quota gets the default quota message, not the owner one', async () => {
    config.allFeaturesUnlocked = false
    const { scene, renter } = await bookedRenter()
    await db.insert(mediaAssets).values({ ownerId: renter.id, filename: 'big', contentType: 'image/png', sizeBytes: 2_000_000_000, storageKey: 'big2', publicUrl: 'https://cdn/big2' })
    const res = await upload(tokenFor(renter), scene.id)
    expect(res.statusCode).toBe(413)
    expect(res.json().error).toBe('storage_limit_reached')
    expect(res.json().message).not.toContain("scene owner's")
  })

  it('a crew grant with only non-media scopes (performer) cannot upload', async () => {
    const { admin, scene, bookingId } = await bookedRenter()
    const perf = await createUser({ wallet: '0x00000000000000000000000000000000000000f2' })
    const g = await app.inject({ method: 'POST', url: `/api/venues/bookings/${bookingId}/grants`, headers: { authorization: `Bearer ${tokenFor(admin)}` }, payload: { walletAddress: perf.wallet, role: 'performer' } })
    expect(g.statusCode).toBe(201)
    expect((await upload(tokenFor(perf), scene.id)).statusCode).toBe(403)
  })

  it("companion upload stores into the scene owner's account and links it; a stranger's code is refused", async () => {
    const owner = await createUser(); const stranger = await createUser()
    const { scene } = await createScene(owner)
    const mk = async (userId: string, code: string) => { await db.insert(uploadTokens).values({ code, userId, sceneId: scene.id, maxUploads: 5, minterVerified: true, expiresAt: new Date(Date.now() + 60_000) }) }
    await mk(owner.id, 'ownr22'); await mk(stranger.id, 'strg22')
    const start = (code: string) => app.inject({ method: 'POST', url: `/api/upload/${code}/start`, payload: { filename: 'm.glb', contentType: 'model/gltf-binary', sizeBytes: 3 } })
    const a = await start('ownr22'); expect(a.statusCode).toBe(201)
    const sent = await app.inject({ method: 'POST', url: `/api/upload/ownr22/${a.json().assetId}`, payload: { fileData: 'AAAA' } })
    expect(sent.statusCode).toBe(201)
    expect((await start('strg22')).statusCode).toBe(403)
    // A model lands in 3D Models (LIV-132)
    const links = await db.select().from(sceneLibrary).where(eq(sceneLibrary.sceneId, scene.id))
    expect(links.map((l) => l.assetItemId)).toEqual([a.json().assetId])
    expect(links[0].addedBy).toBe(owner.id)
    expect((await db.query.assetLibraryItems.findFirst({ where: eq(assetLibraryItems.id, a.json().assetId) }))!.uploadedBy).toBe(owner.id)
    void mediaAssets
  })

})
