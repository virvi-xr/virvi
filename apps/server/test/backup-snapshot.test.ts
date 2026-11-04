import { describe, it, expect, beforeEach } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { assetLibraryItems, catalogPacks, mediaAssets, roomSets, sceneElementInstances, scenePresets, scenes, streamingServers } from '../src/db/schema.js'
import { backupSnapshot } from '../src/services/backup/snapshot.js'
import { resetDb } from './helpers/db.js'
import { createElement, createScene, createUser } from './helpers/factories.js'

const CDN = 'https://cdn.virvi.test'

async function place(elementId: string, o: Partial<typeof sceneElementInstances.$inferInsert> = {}) {
  const [i] = await db.insert(sceneElementInstances).values({ elementId, position: { x: 1, y: 2, z: 3 }, ...o }).returning()
  return i
}

let user: Awaited<ReturnType<typeof createUser>>
let scene: Awaited<ReturnType<typeof createScene>>['scene']
let preset: Awaited<ReturnType<typeof createScene>>['preset']

beforeEach(async () => {
  await resetDb()
  user = await createUser()
  ;({ scene, preset } = await createScene(user, 'Cafe'))
})

describe('backupSnapshot', () => {
  it('bakes transforms exactly as stored', async () => {
    const el = await createElement(preset.id, { type: 'image', name: 'Poster', properties: { textureSrc: `${CDN}/p.png`, emission: 2, isTransparent: true } })
    await place(el.id, {
      position: { x: 1.5, y: -2, z: 3 }, rotation: { x: 0, y: 90, z: 0 }, scale: { x: -1, y: 2, z: 0.5 },
      withCollisions: true,
    })
    const [other] = await db.insert(sceneElementInstances).values({ elementId: el.id, position: { x: 0, y: 0, z: 0 } }).returning()
    await place(el.id, { parentInstanceId: other.id, position: { x: 9, y: 9, z: 9 } })
    const snap = await backupSnapshot(scene.id)
    expect(snap.sceneName).toBe('Cafe')
    expect(snap.presetName).toBe('Default')
    expect(snap.items).toHaveLength(3)
    const it0 = snap.items.find((i) => i.position.x === 1.5)!
    expect(it0).toMatchObject({
      type: 'image', name: 'Poster', position: { x: 1.5, y: -2, z: 3 }, rotation: { x: 0, y: 90, z: 0 },
      scale: { x: -1, y: 2, z: 0.5 }, withCollisions: true, props: { emission: 2, isTransparent: true },
    })
    // parent is ignored: the child keeps its stored (local) numbers
    expect(snap.items.find((i) => i.position.x === 9)!.scale).toEqual({ x: 1, y: 1, z: 1 })
  })

  it('only the live preset', async () => {
    const [other] = await db.insert(scenePresets).values({ sceneId: scene.id, name: 'Night' }).returning()
    const a = await createElement(preset.id, { type: 'image', name: 'Live one', properties: {} })
    const b = await createElement(other.id, { type: 'image', name: 'Other one', properties: {} })
    await place(a.id)
    await place(b.id)
    const snap = await backupSnapshot(scene.id)
    expect(snap.items.map((i) => i.name)).toEqual(['Live one'])
    expect(snap.otherPresets).toEqual(['Night'])
    await db.update(scenes).set({ activePresetId: other.id }).where(eq(scenes.id, scene.id))
    const snap2 = await backupSnapshot(scene.id)
    expect(snap2.presetName).toBe('Night')
    expect(snap2.otherPresets).toEqual(['Default'])
    expect(snap2.items.map((i) => i.name)).toEqual(['Other one'])
  })

  it('disabled elements and instances are left out', async () => {
    const on = await createElement(preset.id, { type: 'image', name: 'On', properties: {} })
    const off = await createElement(preset.id, { type: 'image', name: 'Off', properties: {} })
    await place(on.id)
    await place(on.id, { enabled: false, position: { x: 7, y: 7, z: 7 } })
    await place(off.id)
    await db.execute(sql`update scene_elements set enabled = false where id = ${off.id}`)
    const snap = await backupSnapshot(scene.id)
    expect(snap.items).toHaveLength(1)
    expect(snap.items[0].name).toBe('On')
    expect(snap.skipped).toEqual([])
  })

  it('nft and widget elements are skipped with a reason', async () => {
    const w = await createElement(preset.id, { type: 'widget', name: 'Toggle', properties: {} })
    await place(w.id)
    const snap = await backupSnapshot(scene.id)
    expect(snap.items).toEqual([])
    expect(snap.skipped).toEqual([{ name: 'Toggle', type: 'widget', why: 'not shown in Decentraland by Virvi today' }])
  })

  it('classifies uploads, MIT, NC/unstated catalog items and outside URLs', async () => {
    await db.insert(catalogPacks).values([
      { id: 'dhingia-dj', name: 'Mr Dhingia: DJ & Club Kit', source: 'dhingia', license: 'mit', attribution: 'MIT (c) Mr Dhingia', sourceUrl: 'https://github.com/MrDhingia/DhingiaBuilds' },
      { id: 'dcl-builder-fantasy', name: 'Decentraland Builder: Fantasy', source: 'decentraland', license: 'cc-by-nc-3.0', attribution: 'Decentraland, CC BY-NC 3.0', sourceUrl: 'https://github.com/decentraland/builder-assets' },
      { id: 'dcl-gallery', name: 'Decentraland: Gallery', source: 'decentraland', license: 'unstated', attribution: 'Decentraland Foundation', sourceUrl: 'https://github.com/decentraland/asset-packs' },
    ])
    const item = (name: string, o: Partial<typeof assetLibraryItems.$inferInsert>) =>
      db.insert(assetLibraryItems).values({ name, storageKey: `k/${name}`, cdnUrl: `${CDN}/lib/${name}.glb`, ...o })
    await item('own', { uploadedBy: user.id })
    await item('mit', { packId: 'dhingia-dj', sourceRef: 'x' })
    await item('nc', { packId: 'dcl-builder-fantasy', sourceRef: '05_Fantasy_Pack/Anvil_01' })
    await item('unstated', { packId: 'dcl-gallery', sourceRef: 'gallery/armchair_purple' })
    await db.insert(mediaAssets).values({ ownerId: user.id, filename: 'logo.png', contentType: 'image/png', sizeBytes: 5, publicUrl: `${CDN}/u/logo.png` })
    await db.insert(mediaAssets).values({ ownerId: user.id, filename: 'a.mp3', contentType: 'audio/mpeg', sizeBytes: 5, publicUrl: `${CDN}/u/a.mp3` })
    const [rs] = await db.insert(roomSets).values({
      userId: user.id, options: {}, storageKey: 'rs', glbUrl: `${CDN}/rooms/room.glb`, triangles: 1, plot: {}, offset: {},
    }).returning()
    expect(rs).toBeTruthy()

    const models = ['own', 'mit', 'nc', 'unstated'].map((n) => `${CDN}/lib/${n}.glb`)
    for (const url of [...models, `${CDN}/rooms/room.glb`]) {
      const e = await createElement(preset.id, { type: 'model', name: url.split('/').pop()!, properties: { modelSrc: url } })
      await place(e.id)
    }
    const img = await createElement(preset.id, { type: 'image', name: 'logo', properties: { textureSrc: `${CDN}/u/logo.png` } })
    const snd = await createElement(preset.id, { type: 'sound', name: 'tune', properties: { audioSrc: `${CDN}/u/a.mp3`, volume: 40, sourceType: 1 } })
    const out = await createElement(preset.id, { type: 'image', name: 'outside', properties: { textureSrc: 'https://example.com/pic.jpg' } })
    for (const e of [img, snd, out]) await place(e.id)

    const snap = await backupSnapshot(scene.id)
    const a = (name: string) => snap.items.find((i) => i.name === name)!
    expect(a('own.glb').assets.model).toEqual({ kind: 'bundle', url: models[0], path: 'models/own.glb', use: 'model' })
    expect(a('mit.glb').assets.model).toEqual({
      kind: 'bundle', url: models[1], path: 'models/mit.glb', use: 'model',
      attribution: { pack: 'Mr Dhingia: DJ & Club Kit', text: 'MIT (c) Mr Dhingia' },
    })
    expect(a('nc.glb').assets.model).toMatchObject({
      kind: 'reference', path: 'models/nc.glb', use: 'model', pack: 'Decentraland Builder: Fantasy', license: 'cc-by-nc-3.0',
    })
    expect(a('unstated.glb').assets.model).toMatchObject({ kind: 'reference', license: 'unstated', pack: 'Decentraland: Gallery' })
    expect(a('room.glb').assets.model).toMatchObject({ kind: 'bundle', path: 'models/room.glb' })
    expect(a('logo').assets.texture).toEqual({ kind: 'bundle', url: `${CDN}/u/logo.png`, path: 'images/logo.png', use: 'texture' })
    expect(a('logo').props).toEqual({})
    expect(a('tune').assets.audio).toMatchObject({ kind: 'bundle', path: 'sounds/a.mp3', use: 'audio' })
    expect(a('tune').props).toEqual({ volume: 40, sourceType: 1 })
    expect(a('outside').assets.texture).toEqual({ kind: 'link', url: 'https://example.com/pic.jpg', use: 'texture' })
  })

  it('reference source URLs point at the file in the pack source repo', async () => {
    await db.insert(catalogPacks).values([
      { id: 'dcl-builder-fantasy', name: 'B', source: 'decentraland', license: 'cc-by-nc-3.0', attribution: 'x', sourceUrl: 'https://github.com/decentraland/builder-assets' },
      { id: 'last-slice-kirzoz', name: 'K', source: 'last-slice', license: 'unstated', attribution: 'x', sourceUrl: 'https://github.com/last-slice/dcl-iwb' },
    ])
    await db.insert(assetLibraryItems).values([
      { name: 'Anvil', storageKey: 'a', cdnUrl: `${CDN}/c/anvil.glb`, packId: 'dcl-builder-fantasy', sourceRef: '05_Fantasy_Pack/Anvil_01' },
      { name: 'Other', storageKey: 'b', cdnUrl: `${CDN}/c/other.glb`, packId: 'last-slice-kirzoz', sourceRef: 'a41b5b9a-8c75-48db-9fc6-994014bf9566' },
    ])
    for (const n of ['anvil', 'other']) {
      const e = await createElement(preset.id, { type: 'model', name: n, properties: { modelSrc: `${CDN}/c/${n}.glb` } })
      await place(e.id)
    }
    const snap = await backupSnapshot(scene.id)
    const src = (n: string) => (snap.items.find((i) => i.name === n)!.assets.model as { sourceUrl: string }).sourceUrl
    expect(src('anvil')).toBe('https://github.com/decentraland/builder-assets/blob/HEAD/assets/05_Fantasy_Pack/Anvil_01/Anvil_01.glb')
    expect(src('other')).toBe('https://github.com/last-slice/dcl-iwb/blob/HEAD/assets/a41b5b9a-8c75-48db-9fc6-994014bf9566.glb')
  })

  it('distinct files with the same name get distinct paths', async () => {
    await db.insert(mediaAssets).values([
      { ownerId: user.id, filename: 'a', contentType: 'image/png', sizeBytes: 1, publicUrl: `${CDN}/one/pic.png` },
      { ownerId: user.id, filename: 'b', contentType: 'image/png', sizeBytes: 1, publicUrl: `${CDN}/two/pic.png` },
      { ownerId: user.id, filename: 'c', contentType: 'image/png', sizeBytes: 1, publicUrl: `${CDN}/three/pic.png` },
    ])
    for (const d of ['one', 'two', 'three', 'one']) {
      const e = await createElement(preset.id, { type: 'image', name: d, properties: { textureSrc: `${CDN}/${d}/pic.png` } })
      await place(e.id)
    }
    const snap = await backupSnapshot(scene.id)
    const paths = snap.items.map((i) => (i.assets.texture as { path: string }).path)
    expect(paths).toEqual(['images/pic.png', 'images/pic-2.png', 'images/pic-3.png', 'images/pic.png'])
  })

  it('a non-Virvi model is skipped with a reason', async () => {
    const e = await createElement(preset.id, { type: 'model', name: 'Elsewhere', properties: { modelSrc: 'https://example.com/m.glb' } })
    await place(e.id)
    const snap = await backupSnapshot(scene.id)
    expect(snap.items).toEqual([])
    expect(snap.skipped).toHaveLength(1)
    expect(snap.skipped[0]).toMatchObject({ name: 'Elsewhere', type: 'model' })
    expect(snap.skipped[0].why).toMatch(/not hosted by Virvi/i)
  })

  it('elements with click events are listed', async () => {
    const e = await createElement(preset.id, { type: 'image', name: 'Button', properties: {} })
    const plain = await createElement(preset.id, { type: 'image', name: 'Plain', properties: {} })
    await db.execute(sql`update scene_elements set click_event = '{"type":1,"url":"https://x.test"}' where id = ${e.id}`)
    await place(e.id)
    await place(plain.id)
    const i = await place(plain.id)
    await db.execute(sql`update scene_element_instances set click_event = '{"type":1}' where id = ${i.id}`)
    const snap = await backupSnapshot(scene.id)
    expect(snap.withClickEvents.sort()).toEqual(['Button', 'Plain'])
  })

  it('videos keep their live state; ad spaces bake empty with their own fallback image', async () => {
    await db.insert(streamingServers).values({
      ownerId: user.id, name: 's', status: 'live', hlsPlaylistUrl: 'https://stream.virvi.test/live.m3u8',
    })
    const v = await createElement(preset.id, {
      type: 'video', name: 'Screen',
      properties: {
        liveSrc: 'https://stream.virvi.test/live.m3u8', enableLiveStream: true, offType: 1, offImageSrc: `${CDN}/off.png`,
        playlist: ['https://example.com/a.mp4'], volume: 30,
      },
    })
    const ad = await createElement(preset.id, {
      type: 'ad_space', name: 'Banner', properties: { shape: '16:9', formats: { image: true }, fallbackImageSrc: 'https://example.com/fb.png' },
    })
    await place(v.id)
    await place(ad.id)
    const snap = await backupSnapshot(scene.id)
    const screen = snap.items.find((i) => i.name === 'Screen')!
    expect(screen.props).toMatchObject({ isLive: true, enableLiveStream: true, offType: 1, volume: 30 })
    expect(screen.assets.liveSrc).toEqual({ kind: 'link', url: 'https://stream.virvi.test/live.m3u8', use: 'video' })
    expect(screen.assets['playlist.0']).toEqual({ kind: 'link', url: 'https://example.com/a.mp4', use: 'video' })
    expect(screen.assets.offImage).toMatchObject({ kind: 'link', use: 'texture' })
    const banner = snap.items.find((i) => i.name === 'Banner')!
    expect(banner.type).toBe('ad_space')
    expect(banner.props).toMatchObject({ shape: '16:9' })
    expect(banner.assets.fallbackImage).toMatchObject({ kind: 'link', use: 'texture', url: 'https://example.com/fb.png' })
  })
})
