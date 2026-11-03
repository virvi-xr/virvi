import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { assetLibraryItems, studioEntitlements, studioJobs, studioRevisions } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { memoryStudioStore, setStudioStore, jobFileKey } from '../src/studio/store.js'
import { addMissingLibraryRows, addToLibrary, setLibraryStorage } from '../src/studio/library.js'
import type { StorageProvider } from '../src/storage/index.js'
import { resetDb } from './helpers/db.js'
import { createUser } from './helpers/factories.js'
import { addRevision, createDesign, entitle } from './helpers/studio.js'

const FIXTURES = new URL('../../studio-worker/tests/fixtures/scene/', import.meta.url)
const CHAIR_GLB = readFileSync(new URL('furniture_chair/chair.glb', FIXTURES))
const SEATS = JSON.parse(readFileSync(new URL('furniture_chair/chair.sittables.json', FIXTURES), 'utf8'))
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

function memoryStorage(fail = { on: false }) {
  const files = new Map<string, Buffer>()
  const storage: StorageProvider = {
    upload: async (key, data) => {
      if (fail.on) throw new Error('storage is down')
      files.set(key, data)
      return `https://cdn.test/${key}`
    },
    delete: async (key) => { files.delete(key) },
    getPublicUrl: (key) => `https://cdn.test/${key}`,
  }
  return { storage, files, fail }
}

/** Finalized scene pieces become private rows in their designer's asset library. */
describe('studio library', () => {
  let store: ReturnType<typeof memoryStudioStore>
  let pub: ReturnType<typeof memoryStorage>
  const prev = config.studioEnabled
  beforeAll(() => { ;(config as any).studioEnabled = true })
  afterAll(() => {
    ;(config as any).studioEnabled = prev
    setStudioStore(null)
    setLibraryStorage(null)
  })
  beforeEach(async () => {
    await resetDb()
    store = memoryStudioStore()
    setStudioStore(store)
    pub = memoryStorage()
    setLibraryStorage(pub.storage)
  })

  /** A scene design's chair, revision `n` paid for and packaged, its files in the studio store. */
  async function paidChair(design?: Awaited<ReturnType<typeof createDesign>>) {
    const d = design ?? await createDesign(await createUser(), { kind: 'scene' })
    const rev = await addRevision(d, 'furniture_chair', { pass: true, failures: 0, warnings: 0 }, { kind: 'furniture', type: 'chair', name: 'Neon Chair' })
    const files = ['pieces/furniture_chair/chair.glb', 'pieces/furniture_chair/piece.json', 'pieces/furniture_chair/chair.sittables.json', 'checks/furniture_chair.txt']
    await db.update(studioRevisions).set({ files }).where(eq(studioRevisions.id, rev.id))
    await store.put(jobFileKey(d.id, rev.jobId, files[0]), CHAIR_GLB, 'model/gltf-binary')
    await store.put(jobFileKey(d.id, rev.jobId, files[2]), Buffer.from(JSON.stringify(SEATS)), 'application/json')
    const [finalize] = await db.insert(studioJobs).values({ designId: d.id, type: 'finalize', status: 'done', payload: {} }).returning()
    await store.put(jobFileKey(d.id, finalize.id, 'final/furniture_chair/thumbnail.png'), PNG, 'image/png')
    const { entitlement } = await entitle(d, rev)
    await db.update(studioEntitlements).set({ jobId: finalize.id }).where(eq(studioEntitlements.id, entitlement.id))
    return { design: d, rev, entitlement }
  }

  it('a finalized chair becomes one private row with its size, thumbnail and seats', async () => {
    const { design, entitlement } = await paidChair()
    const ids = await addToLibrary(entitlement.id, new Date())
    expect(ids).toHaveLength(1)
    const [row] = await db.select().from(assetLibraryItems)
    expect(row).toMatchObject({
      id: ids[0], name: 'Neon Chair', category: 'furniture', tags: ['chair'], isPublic: false, uploadedBy: design.ownerId,
      fileSizeBytes: CHAIR_GLB.length, sourceRef: `studio:${entitlement.id}:chair.glb`, sittables: SEATS,
    })
    expect(row.triangleCount).toBe(36)
    expect(row.dimensions).toMatchObject({ x: expect.closeTo(0.5, 2), y: expect.closeTo(1, 2), z: expect.closeTo(0.5, 2) })
    expect(row.cdnUrl).toMatch(new RegExp(`^https://cdn.test/assets/${design.ownerId}/.+\\.glb$`))
    expect(row.thumbnailUrl).toMatch(/\.png$/)
    expect(pub.files.get(row.storageKey)).toEqual(CHAIR_GLB)
    const [ent] = await db.select().from(studioEntitlements).where(eq(studioEntitlements.id, entitlement.id))
    expect(ent.assetItemIds).toEqual(ids)
  })

  it('adding it twice adds nothing the second time', async () => {
    const { entitlement } = await paidChair()
    const first = await addToLibrary(entitlement.id, new Date())
    expect(await addToLibrary(entitlement.id, new Date())).toEqual(first)
    expect(await db.select().from(assetLibraryItems)).toHaveLength(1)
  })

  it('two adds at once (the finalize result and the sweep) add one row', async () => {
    const { entitlement } = await paidChair()
    const slow = memoryStorage()
    const upload = slow.storage.upload
    slow.storage.upload = async (key, data, type) => { await new Promise((r) => setTimeout(r, 50)); return upload(key, data, type) }
    setLibraryStorage(slow.storage)  // a big GLB still uploading when the second add starts
    const [a, b] = await Promise.all([addToLibrary(entitlement.id, new Date()), addToLibrary(entitlement.id, new Date())])
    expect(a).toEqual(b)
    expect(await db.select().from(assetLibraryItems)).toHaveLength(1)
  })

  it('a second revision adds a second row and leaves the first', async () => {
    const a = await paidChair()
    await addToLibrary(a.entitlement.id, new Date())
    const b = await paidChair(a.design)
    await addToLibrary(b.entitlement.id, new Date())
    const names = (await db.select().from(assetLibraryItems)).map((r) => r.name).sort()
    expect(names).toEqual(['Neon Chair', 'Neon Chair (revision 2)'])
  })

  it('a wearable finalize adds no row', async () => {
    const d = await createDesign(await createUser())
    const { entitlement } = await entitle(d, await addRevision(d, 'hat'))
    expect(await addToLibrary(entitlement.id, new Date())).toEqual([])
    expect(await db.select().from(assetLibraryItems)).toHaveLength(0)
  })

  it('storage down: the paid piece stays ready, and the sweep adds the row once it is back', async () => {
    const { entitlement } = await paidChair()
    pub.fail.on = true
    await expect(addToLibrary(entitlement.id, new Date())).rejects.toThrow('storage is down')
    const [ent] = await db.select().from(studioEntitlements).where(eq(studioEntitlements.id, entitlement.id))
    expect(ent).toMatchObject({ status: 'ready', assetItemIds: null })
    expect(await db.select().from(assetLibraryItems)).toHaveLength(0)
    expect(await addMissingLibraryRows(new Date())).toBe(0)  // still down: nothing added, nothing thrown
    pub.fail.on = false
    expect(await addMissingLibraryRows(new Date())).toBe(1)
    expect(await db.select().from(assetLibraryItems)).toHaveLength(1)
  })

  it('an unreadable GLB is set aside once: the sweep stops retrying it', async () => {
    const { entitlement, design, rev } = await paidChair()
    await store.put(jobFileKey(design.id, rev.jobId, 'pieces/furniture_chair/chair.glb'), Buffer.from('not a glb'), 'model/gltf-binary')
    await expect(addToLibrary(entitlement.id, new Date())).rejects.toThrow("chair.glb isn't a readable GLB")
    const [ent] = await db.select().from(studioEntitlements).where(eq(studioEntitlements.id, entitlement.id))
    expect(ent).toMatchObject({ status: 'ready', assetItemIds: null })
    expect(ent.libraryError).toMatch(/chair\.glb isn't a readable GLB/)
    const get = vi.spyOn(store, 'get')
    expect(await addMissingLibraryRows(new Date())).toBe(0)
    expect(get).not.toHaveBeenCalled()  // the sweep doesn't open the file again
  })

  it('a GLB missing from the studio store is set aside too', async () => {
    const { entitlement, design, rev } = await paidChair()
    await store.delete(jobFileKey(design.id, rev.jobId, 'pieces/furniture_chair/chair.glb'))
    await expect(addToLibrary(entitlement.id, new Date())).rejects.toThrow('chair.glb is missing from the studio store')
    const [ent] = await db.select().from(studioEntitlements).where(eq(studioEntitlements.id, entitlement.id))
    expect(ent.libraryError).toMatch(/missing/)
  })
})

describe('glbStats visibleOnly', () => {
  it('leaves collider meshes out of the triangle count when asked', async () => {
    const { glbStats } = await import('../src/catalog/glb-stats.js')
    expect((await glbStats(CHAIR_GLB)).triangles).toBe(48)  // 3 boxes and the collider box
    expect((await glbStats(CHAIR_GLB, { visibleOnly: true })).triangles).toBe(36)
  })
})

describe('library storage quota', () => {
  beforeEach(async () => {
    await resetDb()
    setStudioStore(memoryStudioStore())
  })
  it('paid scene pieces never count against the upload quota; uploads still do', async () => {
    const { assertStorageQuota } = await import('../src/media/quota.js')
    const unlocked = config.allFeaturesUnlocked
    ;(config as any).allFeaturesUnlocked = false  // tests otherwise run every plan unlimited
    const u = await createUser()
    const big = 500 * 1024 * 1024  // a free plan's whole allowance
    await db.insert(assetLibraryItems).values({ name: 'Paid building', storageKey: 'k1', cdnUrl: 'https://cdn.test/k1',
      fileSizeBytes: big, isPublic: false, uploadedBy: u.id, sourceRef: 'studio:ent-1:house.glb' })
    await expect(assertStorageQuota(u.id, 1)).resolves.not.toThrow()
    await db.insert(assetLibraryItems).values({ name: 'An upload', storageKey: 'k2', cdnUrl: 'https://cdn.test/k2',
      fileSizeBytes: big, isPublic: false, uploadedBy: u.id })
    await expect(assertStorageQuota(u.id, 1)).rejects.toThrow()
    ;(config as any).allFeaturesUnlocked = unlocked
  })
})
