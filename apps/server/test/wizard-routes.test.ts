import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { assetLibraryItems, catalogPacks, roomScans, roomSets, scenes, scenePresets, sceneElements, sceneElementInstances, sceneLibrary, subscriptions } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor } from './helpers/factories.js'
import { THEMES } from '../src/wizard/themes.js'
import { dclBudget, type RoomScanLayout } from '@virvixr/shared'
import type { StorageProvider } from '../src/storage/index.js'
import { setRoomSetStorage } from '../src/room-scan/sets.js'
import { wallsFromOutline } from '../src/room-scan/geometry.js'

describe('wizard routes', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  const prevUnlocked = config.allFeaturesUnlocked
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { config.allFeaturesUnlocked = prevUnlocked; await app.close() })

  const as = (u: Awaited<ReturnType<typeof createUser>>) => ({ authorization: `Bearer ${tokenFor(u)}` })
  const plot2 = { width: 2, depth: 2, base: { x: 0, y: 0 } }

  async function seedPack(id = 'dcl-builder-minitown', enabled = true) {
    await db.insert(catalogPacks).values({ id, name: id, source: 'test', license: 'x', attribution: 'x', sourceUrl: 'x', enabled }).onConflictDoNothing()
  }
  async function seedAsset(sourceRef: string, o: Partial<typeof assetLibraryItems.$inferInsert> = {}) {
    await seedPack(o.packId ?? 'dcl-builder-minitown')
    const [a] = await db.insert(assetLibraryItems).values({
      name: sourceRef, storageKey: `k/${sourceRef}`, cdnUrl: `https://cdn.test/${sourceRef}.glb`, packId: 'dcl-builder-minitown',
      sourceRef, triangleCount: 1000, fileSizeBytes: 5000, isPublic: true, ...o,
    }).returning()
    return a
  }
  const book = (user: any, payload: any) => app.inject({ method: 'POST', url: '/api/wizard/scenes', headers: as(user), payload })
  const counts = async () => ({
    scenes: (await db.select().from(scenes)).length,
    presets: (await db.select().from(scenePresets)).length,
    elements: (await db.select().from(sceneElements)).length,
    instances: (await db.select().from(sceneElementInstances)).length,
    links: (await db.select().from(sceneLibrary)).length,
  })

  it('requires authentication', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/wizard/catalog' })).statusCode).toBe(401)
  })

  it('catalog resolves known refs, drops unknown and disabled-pack ones', async () => {
    const u = await createUser()
    const gal = THEMES.find((t) => t.id === 'gallery')!
    const first = gal.items[0] // a dcl-gallery piece
    const second = gal.items.find((i) => i.pack !== first.pack)! // a minitown piece, whose pack gets switched off
    const a = await seedAsset(first.sourceRef, { packId: first.pack, dimensions: { width: 2, height: 3, depth: 4 } })
    await seedAsset(second.sourceRef, { packId: second.pack })
    await db.update(catalogPacks).set({ enabled: false }).where(eq(catalogPacks.id, second.pack))
    const res = await app.inject({ method: 'GET', url: '/api/wizard/catalog', headers: as(u) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    const t = body.themes.find((x: any) => x.id === 'gallery')
    expect(t.items.every((i: any) => i.asset.id === a.id)).toBe(true)
    expect(t.items.length).toBe(gal.items.filter((i) => i.sourceRef === first.sourceRef).length)
    expect(t.items[0]).toMatchObject({ x: first.x, z: first.z, rotationY: first.rotationY })
    expect(t.items[0].asset).toMatchObject({ name: a.name, cdnUrl: a.cdnUrl, triangleCount: 1000, fileSizeBytes: 5000, dimensions: { x: 2, y: 3, z: 4 } })
    expect(body.themes.find((x: any) => x.id === 'empty').items).toEqual([])
    expect(body.chips.map((c: any) => c.id)).toEqual(['nature', 'furniture', 'lighting', 'buildings', 'decor'])
  })

  it('bootstrap creates one preset, N elements, M instances and N library links', async () => {
    const u = await createUser()
    const a = await seedAsset('Tree'); const b = await seedAsset('Bench')
    const res = await book(u, {
      name: 'My park', plot: plot2, spawn: { x: 16, z: 3 },
      items: [
        { assetId: a.id, x: 4, z: 5, rotationY: 90 },
        { assetId: a.id, x: 10, z: 12, rotationY: 0 },
        { assetId: b.id, x: 20, z: 20, rotationY: 45 },
      ],
    })
    expect(res.statusCode).toBe(201)
    const { sceneId } = res.json()
    expect(await counts()).toEqual({ scenes: 1, presets: 1, elements: 2, instances: 3, links: 2 })
    const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) })
    expect(scene).toMatchObject({ name: 'My park', ownerId: u.id })
    const [preset] = await db.select().from(scenePresets)
    expect(preset.name).toBe('Default')
    expect(scene!.activePresetId).toBe(preset.id)
    const els = await db.select().from(sceneElements)
    const tree = els.find((e) => e.name === a.name)!
    expect(tree).toMatchObject({ type: 'model', presetId: preset.id, properties: { modelSrc: a.cdnUrl } })
    const inst = (await db.select().from(sceneElementInstances).where(eq(sceneElementInstances.elementId, tree.id)))
    expect(inst.map((i) => i.position).sort((x: any, y: any) => x.x - y.x)).toEqual([{ x: 4, y: 0, z: 5 }, { x: 10, y: 0, z: 12 }])
    expect(inst.find((i: any) => i.position.x === 4)!.rotation).toEqual({ x: 0, y: 90, z: 0 })
  })

  it('accepts an empty plot (no items)', async () => {
    const u = await createUser()
    const res = await book(u, { name: 'Empty', plot: plot2, spawn: { x: 16, z: 3 }, items: [] })
    expect(res.statusCode).toBe(201)
    expect(await counts()).toEqual({ scenes: 1, presets: 1, elements: 0, instances: 0, links: 0 })
  })

  it('400s on a position outside the plot (x = 33 on 2x2), an invalid plot, a missing name or a non-catalog asset', async () => {
    const u = await createUser()
    const a = await seedAsset('Tree')
    const [priv] = await db.insert(assetLibraryItems).values({ name: 'Mine', storageKey: 'm', uploadedBy: u.id, isPublic: false }).returning()
    const ok = { name: 'S', plot: plot2, spawn: { x: 1, z: 1 }, items: [{ assetId: a.id, x: 1, z: 1, rotationY: 0 }] }
    expect((await book(u, { ...ok, items: [{ assetId: a.id, x: 33, z: 1, rotationY: 0 }] })).statusCode).toBe(400)
    expect((await book(u, { ...ok, items: [{ assetId: a.id, x: 1, z: -1, rotationY: 0 }] })).statusCode).toBe(400)
    expect((await book(u, { ...ok, spawn: { x: 40, z: 1 } })).statusCode).toBe(400)
    expect((await book(u, { ...ok, plot: { width: 0, depth: 2, base: { x: 0, y: 0 } } })).statusCode).toBe(400)
    expect((await book(u, { ...ok, name: '  ' })).statusCode).toBe(400)
    expect((await book(u, { ...ok, items: [{ assetId: priv.id, x: 1, z: 1, rotationY: 0 }] })).statusCode).toBe(400)
    expect((await book(u, { ...ok, items: [{ assetId: '00000000-0000-0000-0000-000000000000', x: 1, z: 1, rotationY: 0 }] })).statusCode).toBe(400)
    expect((await book(u, { ...ok, items: [{ assetId: 'nope', x: 1, z: 1, rotationY: 0 }] })).statusCode).toBe(400)
    expect(await counts()).toEqual({ scenes: 0, presets: 0, elements: 0, instances: 0, links: 0 })
  })

  it('400s when items exceed the entity budget', async () => {
    const u = await createUser()
    const a = await seedAsset('Tree', { triangleCount: 1 })
    const plot1 = { width: 1, depth: 1, base: { x: 0, y: 0 } }
    const items = Array.from({ length: 181 }, () => ({ assetId: a.id, x: 1, z: 1, rotationY: 0 }))
    expect((await book(u, { name: 'S', plot: plot1, spawn: { x: 1, z: 1 }, items, dcl: true })).statusCode).toBe(400)
    expect((await book(u, { name: 'S', plot: plot1, spawn: { x: 1, z: 1 }, items: items.slice(0, 180), dcl: true })).statusCode).toBe(201)
  })

  it('Hyperfy/AR only (dcl: false) skips the Decentraland triangle and entity budget', async () => {
    const u = await createUser()
    const big = await seedAsset('Big', { triangleCount: 6000 })
    const plot1 = { width: 1, depth: 1, base: { x: 0, y: 0 } }
    const items = (n: number) => Array.from({ length: n }, () => ({ assetId: big.id, x: 1, z: 1, rotationY: 0 }))
    const res = await book(u, { name: 'Hyperfy', plot: plot1, spawn: { x: 1, z: 1 }, items: items(3), dcl: false })
    expect(res.statusCode).toBe(201)
    expect(await counts()).toMatchObject({ scenes: 1, instances: 3 })
    expect((await book(u, { name: 'Many', plot: plot1, spawn: { x: 1, z: 1 }, items: items(181), dcl: false })).statusCode).toBe(201)
    // Everything else is still checked
    expect((await book(u, { name: 'Out', plot: plot1, spawn: { x: 1, z: 1 }, items: [{ assetId: big.id, x: 17, z: 1, rotationY: 0 }], dcl: false })).statusCode).toBe(400)
    expect((await book(u, { name: 'Bad', plot: plot1, spawn: { x: 1, z: 1 }, items: [], dcl: 'no' })).statusCode).toBe(400)
  })

  it('422 over_budget when the summed triangles exceed the plot budget, and creates nothing', async () => {
    const u = await createUser()
    const big = await seedAsset('Big', { triangleCount: 6000 })
    const plot1 = { width: 1, depth: 1, base: { x: 0, y: 0 } }
    const body = (n: number) => ({ name: 'S', plot: plot1, spawn: { x: 1, z: 1 }, dcl: true, items: Array.from({ length: n }, () => ({ assetId: big.id, x: 1, z: 1, rotationY: 0 })) })
    const res = await book(u, body(2))
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ error: 'over_budget', triangles: 12000, limit: 10000 })
    expect(await counts()).toEqual({ scenes: 0, presets: 0, elements: 0, instances: 0, links: 0 })
    expect((await book(u, body(1))).statusCode).toBe(201)
  })

  it('400 unmeasured_asset when an item has no triangle count, creating nothing', async () => {
    const u = await createUser()
    const a = await seedAsset('Tree'); const n = await seedAsset('Unmeasured', { triangleCount: null })
    const res = await book(u, { name: 'S', plot: plot2, spawn: { x: 1, z: 1 }, items: [{ assetId: a.id, x: 1, z: 1, rotationY: 0 }, { assetId: n.id, x: 2, z: 2, rotationY: 0 }] })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('unmeasured_asset')
    expect(await counts()).toEqual({ scenes: 0, presets: 0, elements: 0, instances: 0, links: 0 })
  })

  it('catalog leaves out assets with no triangle count or no model URL', async () => {
    const u = await createUser()
    const gal = THEMES.find((t) => t.id === 'gallery')!
    const [i0, i1, i2] = gal.items.filter((i, n, all) => all.findIndex((j) => j.sourceRef === i.sourceRef) === n)
    const ok = await seedAsset(i0.sourceRef, { packId: i0.pack })
    await seedAsset(i1.sourceRef, { packId: i1.pack, triangleCount: null })
    await seedAsset(i2.sourceRef, { packId: i2.pack, cdnUrl: null })
    const body = (await app.inject({ method: 'GET', url: '/api/wizard/catalog', headers: as(u) })).json()
    const ids = new Set(body.themes.flatMap((t: any) => t.items.map((i: any) => i.asset.id)))
    expect([...ids]).toEqual([ok.id])
  })

  it('no plan limits scenes: a free user books a fourth', async () => {
    config.allFeaturesUnlocked = false
    const u = await createUser()
    for (let i = 0; i < 4; i++) expect((await book(u, { name: `S${i}`, plot: plot2, spawn: { x: 1, z: 1 }, items: [] })).statusCode).toBe(201)
    expect((await counts()).scenes).toBe(4)
  })

  it('options: the wizard is open to everyone: Hyperfy allowed and no scene limit on the free plan', async () => {
    config.allFeaturesUnlocked = false
    const u = await createUser()
    const get = async (user: any) => (await app.inject({ method: 'GET', url: '/api/wizard/options', headers: as(user) })).json()
    const o = await get(u)
    expect(o.hyperfy.allowed).toBe(true)
    expect(o.scenes).toEqual({ used: 0, limit: null })
    expect(o.dcl).toEqual({ virviDeploys: false, virviAddress: null })
  })

  it('GET /api/assets?category matches any of the comma-separated categories', async () => {
    const a = await seedAsset('A', { category: 'Building' }); const b = await seedAsset('B', { category: 'Structure' }); await seedAsset('C', { category: 'Decor' })
    const res = await app.inject({ method: 'GET', url: '/api/assets?category=Building,Structure' })
    expect(res.json().assets.map((x: any) => x.id).sort()).toEqual([a.id, b.id].sort())
    expect((await app.inject({ method: 'GET', url: '/api/assets?category=Decor' })).json().assets).toHaveLength(1)
  })

  describe('starting from a room scan', () => {
    const files = new Map<string, Buffer>()
    const storage: StorageProvider = {
      upload: async (key, data) => { files.set(key, data); return `https://cdn.test/${key}` },
      delete: async (key) => { files.delete(key) },
      getPublicUrl: (key) => `https://cdn.test/${key}`,
    }
    beforeEach(() => { files.clear(); setRoomSetStorage(storage) })
    afterEach(() => setRoomSetStorage(null))

    const plot1 = { width: 1, depth: 1, base: { x: 0, y: 0 } }
    const layout = (): RoomScanLayout => {
      const floor: Array<[number, number]> = [[0, 0], [4, 0], [4, 3], [0, 3]]
      return {
        version: 1,
        rooms: [{ label: 'Room', floor, floorY: 0, ceilingHeight: 2.5, walls: wallsFromOutline(floor), objects: [],
          anchor: { source: 'quest-mruk', roomId: 'r', floorAnchorId: null, floorPose: { position: [0, 0, 0], yaw: 0 } } }],
      }
    }
    const scanFor = async (u: { id: string }) =>
      (await db.insert(roomScans).values({ userId: u.id, name: 'Lounge', source: 'quest-mruk', layout: layout() }).returning())[0]
    const withSet = (scanId: string, extra: Record<string, unknown> = {}) =>
      ({ name: 'Lounge scene', plot: plot1, spawn: { x: 8, z: 8 }, dcl: true, items: [], roomSet: { scanId, options: { style: 'plain' } }, ...extra })

    it('creates the set, a model element at the origin and links the set to it', async () => {
      const u = await createUser()
      const scan = await scanFor(u)
      const res = await book(u, withSet(scan.id))
      expect(res.statusCode).toBe(201)
      const [set] = await db.select().from(roomSets)
      expect(set).toMatchObject({ scanId: scan.id, userId: u.id })
      const [el] = await db.select().from(sceneElements)
      expect(el).toMatchObject({ type: 'model', name: 'Lounge scene room', properties: { modelSrc: set.glbUrl } })
      expect(set.sceneElementId).toBe(el.id)
      const [inst] = await db.select().from(sceneElementInstances)
      expect(inst).toMatchObject({ elementId: el.id, position: { x: 0, y: 0, z: 0 } })
      expect(files.size).toBe(1)
    })

    it('keeps the client-chosen plot base and adds the set to items', async () => {
      const u = await createUser()
      const scan = await scanFor(u)
      const a = await seedAsset('Tree')
      const res = await book(u, withSet(scan.id, { plot: { width: 1, depth: 1, base: { x: 5, y: -3 } }, items: [{ assetId: a.id, x: 4, z: 5, rotationY: 0 }] }))
      expect(res.statusCode).toBe(201)
      expect((await counts()).elements).toBe(2)
    })

    it("404s another user's scan and creates nothing", async () => {
      const u = await createUser(); const other = await createUser()
      const scan = await scanFor(other)
      const res = await book(u, withSet(scan.id))
      expect(res.statusCode).toBe(404)
      expect(await counts()).toEqual({ scenes: 0, presets: 0, elements: 0, instances: 0, links: 0 })
      expect(files.size).toBe(0)
    })

    it('400 plot_mismatch on the wrong plot size, storing nothing', async () => {
      const u = await createUser()
      const scan = await scanFor(u)
      const res = await book(u, withSet(scan.id, { plot: plot2 }))
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ error: 'plot_mismatch' })
      expect(await counts()).toEqual({ scenes: 0, presets: 0, elements: 0, instances: 0, links: 0 })
      expect(files.size).toBe(0)
    })

    it('422 too_big for a home larger than the largest plot, before the plot size check, storing nothing', async () => {
      const u = await createUser()
      const floor: Array<[number, number]> = [[0, 0], [160, 0], [160, 4], [0, 4]]
      const big: RoomScanLayout = { version: 1, rooms: [{ ...layout().rooms[0], floor, walls: wallsFromOutline(floor) }] }
      const [scan] = await db.insert(roomScans).values({ userId: u.id, name: 'Mansion', source: 'quest-mruk', layout: big }).returning()
      const res = await book(u, withSet(scan.id))
      expect(res.statusCode).toBe(422)
      expect(res.json()).toEqual({ error: 'too_big' })
      expect(await counts()).toEqual({ scenes: 0, presets: 0, elements: 0, instances: 0, links: 0 })
      expect(files.size).toBe(0)
    })

    it('400 on invalid options, storing nothing', async () => {
      const u = await createUser()
      const scan = await scanFor(u)
      const res = await book(u, withSet(scan.id, { roomSet: { scanId: scan.id, options: { style: 'castle' } } }))
      expect(res.statusCode).toBe(400)
      expect(files.size).toBe(0)
    })

    it('422 over_budget when the items fill the entity budget and the room would be one more, storing nothing', async () => {
      const u = await createUser()
      const scan = await scanFor(u)
      const a = await seedAsset('Pebble', { triangleCount: 1 })
      const limit = dclBudget(1).entities
      const items = Array.from({ length: limit }, () => ({ assetId: a.id, x: 1, z: 1, rotationY: 0 }))
      const res = await book(u, withSet(scan.id, { items }))
      expect(res.statusCode).toBe(422)
      expect(res.json()).toMatchObject({ error: 'over_budget', entities: limit + 1, entityLimit: limit })
      expect(await counts()).toEqual({ scenes: 0, presets: 0, elements: 0, instances: 0, links: 0 })
      expect(files.size).toBe(0)
      expect((await book(u, withSet(scan.id, { items: items.slice(1) }))).statusCode).toBe(201)
    })

    it('422 over_budget when the set plus items exceed the triangle budget, storing nothing', async () => {
      const u = await createUser()
      const scan = await scanFor(u)
      const big = await seedAsset('Big', { triangleCount: 10000 })
      const res = await book(u, withSet(scan.id, { items: [{ assetId: big.id, x: 1, z: 1, rotationY: 0 }] }))
      expect(res.statusCode).toBe(422)
      expect(res.json()).toMatchObject({ error: 'over_budget', limit: 10000 })
      expect(res.json().triangles).toBeGreaterThan(10000)
      expect(await counts()).toEqual({ scenes: 0, presets: 0, elements: 0, instances: 0, links: 0 })
      expect(await db.select().from(roomSets)).toEqual([])
      expect(files.size).toBe(0)
    })
  })
})
