/**
 * LIV-134: Virvi-built Decentraland scenes deploy `virvi/placements.json`, the active preset's placed Virvi GLBs, so
 * the runtime can create them before it talks to Virvi (Decentraland's LOD/map builder runs scenes with no network).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PLACEMENTS_FILE, decodePlacements, type Placement } from '@virvixr/shared'
import { eq } from 'drizzle-orm'
import { config } from '../src/config.js'
import { db } from '../src/db/connection.js'
import { sceneElementInstances, sceneElements, scenePresets } from '../src/db/schema.js'
import {
  assembleFresh, assembleRedeploy, pendingModels, placementsInScene, wizardSceneJson, PLACEMENTS_MAX_BYTES, type ModelNeed,
} from '../src/services/dcl/assemble.js'
import { dclHash } from '../src/services/dcl/entity.js'
import { runtimeFiles, DCL_RUNTIME_VERSION } from '../src/services/dcl/runtime.js'
import type { LiveEntity } from '../src/services/dcl/worlds-client.js'
import { createUser, createScene, createElement } from './helpers/factories.js'

const CDN = 'https://cdn.virvi.test'
const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)
const need = (n: string, url = `${CDN}/m/${n}.glb`): ModelNeed => ({
  elementId: n, name: n, url, file: `models/virvi/${n}.glb`, triangles: 100, bytes: 10, instances: 1,
})
const at = (i: string, model: string, over: Partial<Placement> = {}): Placement => ({
  instanceId: i, elementId: model, src: `models/virvi/${model}.glb`,
  position: { x: 1, y: 0, z: 2 }, rotation: { x: 0, y: 90, z: 0 }, scale: { x: 1, y: 1, z: 1 }, collisions: false, ...over,
})
const fetcher = () => vi.fn(async (url: string) => enc(`bytes of ${url}`))
const metadata = () => wizardSceneJson({ title: 'T', world: 'w.dcl.eth', base: '0,0', parcels: ['0,0'], spawn: { x: 8, y: 0, z: 8 } })

let savedCdn: string | null
beforeEach(() => { savedCdn = config.cdnUrl; (config as { cdnUrl: string | null }).cdnUrl = CDN })
afterEach(() => { (config as { cdnUrl: string | null }).cdnUrl = savedCdn })

/** The deployment's placements file (new or kept by hash), decoded; null when it has none. */
function placementsOf(r: Awaited<ReturnType<typeof assembleFresh>>): Placement[] | null {
  const entity = JSON.parse(dec(r.files.get(r.entityId)!)) as { content: Array<{ file: string; hash: string }> }
  const ref = entity.content.find((c) => c.file === PLACEMENTS_FILE)
  if (!ref) return null
  const bytes = r.files.get(ref.hash)
  return bytes ? decodePlacements(dec(bytes)) : []
}

/** A live wizard World on the current runtime with a.glb, plus `extra` content. */
async function live(extra: Array<{ file: string; hash: string }> = [], runtime = DCL_RUNTIME_VERSION): Promise<LiveEntity> {
  const rt = runtime === DCL_RUNTIME_VERSION ? await runtimeFiles() : new Map([['bin/index.js', enc(`runtime v${runtime}`)]])
  const meta = metadata()
  meta.virvi = { ...meta.virvi!, runtime }
  return {
    id: 'bafyold', pointers: ['0,0'], metadata: meta,
    content: [
      ...(await Promise.all([...rt].map(async ([file, bytes]) => ({ file, hash: await dclHash(bytes) })))),
      { file: 'scene.json', hash: await dclHash(enc('scene')) },
      { file: 'models/virvi/a.glb', hash: await dclHash(enc('a')) },
      ...extra,
    ],
  }
}

describe('placementsInScene', () => {
  it("lists the active preset's enabled copies of Virvi GLB models with their own stored transforms", async () => {
    const user = await createUser()
    const { scene, preset } = await createScene(user)
    const chair = await createElement(preset.id, { type: 'model', name: 'Chair', properties: { modelSrc: `${CDN}/m/Chair.glb` } })
    const table = await createElement(preset.id, { type: 'model', name: 'Table', properties: { modelSrc: `${CDN}/m/Table.glb?v=2` } })
    const off = await createElement(preset.id, { type: 'model', name: 'Off', properties: { modelSrc: `${CDN}/m/Off.glb` } })
    await db.update(sceneElements).set({ enabled: false }).where(eq(sceneElements.id, off.id))
    const fbx = await createElement(preset.id, { type: 'model', name: 'Fbx', properties: { modelSrc: `${CDN}/m/x.fbx` } })
    const image = await createElement(preset.id, { type: 'image', name: 'Poster', properties: { textureSrc: `${CDN}/i.png` } })
    const [other] = await db.insert(scenePresets).values({ sceneId: scene.id, name: 'Other' }).returning()
    const elsewhere = await createElement(other.id, { type: 'model', name: 'Elsewhere', properties: { modelSrc: `${CDN}/m/Else.glb` } })

    const ins = async (elementId: string, v: Partial<typeof sceneElementInstances.$inferInsert> = {}) =>
      (await db.insert(sceneElementInstances).values({ elementId, ...v }).returning())[0]
    const c1 = await ins(chair.id, { position: { x: 1, y: 0, z: 2 }, rotation: { x: 0, y: 90, z: 0 }, scale: { x: 2, y: 2, z: 2 }, withCollisions: true })
    const parent = await ins(table.id, { position: { x: 4, y: 0, z: 4 } })
    // The live runtime ignores parents: the copy is placed by its own transform, as stored
    const child = await ins(chair.id, { position: { x: 0.5, y: 1, z: 0 }, parentInstanceId: parent.id })
    await ins(chair.id, { enabled: false, position: { x: 9, y: 9, z: 9 } })
    for (const e of [off.id, fbx.id, image.id, elsewhere.id]) await ins(e)

    const list = await placementsInScene(scene.id)
    expect(list).toEqual([
      { instanceId: c1.id, elementId: chair.id, src: 'models/virvi/Chair.glb', position: { x: 1, y: 0, z: 2 }, rotation: { x: 0, y: 90, z: 0 }, scale: { x: 2, y: 2, z: 2 }, collisions: true },
      { instanceId: child.id, elementId: chair.id, src: 'models/virvi/Chair.glb', position: { x: 0.5, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, collisions: false },
      { instanceId: parent.id, elementId: table.id, src: 'models/virvi/Table.glb', position: { x: 4, y: 0, z: 4 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, collisions: false },
    ])
  })
})

describe('assembleFresh writes the placements', () => {
  it('places the copies of every model the deployment holds, by its deployed path', async () => {
    const r = await assembleFresh({
      metadata: metadata(), timestamp: 1, fetch: fetcher(),
      models: [need('a'), need('x', 'https://evil.example/x.glb')],
      placements: [at('i1', 'a', { src: 'models/virvi/A.GLB' }), at('i2', 'x'), at('i3', 'a', { collisions: true })],
    })
    expect(r.refused.map((m) => m.file)).toEqual(['models/virvi/x.glb'])
    expect(r.deployedFiles).toContain(PLACEMENTS_FILE)
    expect(r.added).not.toContain(PLACEMENTS_FILE) // added lists models only
    expect(placementsOf(r)).toEqual([at('i1', 'a'), at('i3', 'a', { collisions: true })])
  })

  it('ships no placements file when nothing is placed', async () => {
    const r = await assembleFresh({ metadata: metadata(), models: [need('a')], timestamp: 1, fetch: fetcher(), placements: [] })
    expect(r.deployedFiles).not.toContain(PLACEMENTS_FILE)
    expect(placementsOf(r)).toBeNull()
  })

  it(`stays within ${PLACEMENTS_MAX_BYTES} bytes, keeping the first copies`, async () => {
    const many = Array.from({ length: 12_000 }, (_, n) => at(`instance-${String(n).padStart(6, '0')}-with-a-long-uuid-like-id`, 'a'))
    const r = await assembleFresh({ metadata: metadata(), models: [need('a')], timestamp: 1, fetch: fetcher(), placements: many })
    const list = placementsOf(r)!
    expect(list.length).toBeGreaterThan(1000)
    expect(list.length).toBeLessThan(many.length)
    expect(list).toEqual(many.slice(0, list.length))
    const entity = JSON.parse(dec(r.files.get(r.entityId)!)) as { content: Array<{ file: string; hash: string }> }
    expect(r.files.get(entity.content.find((c) => c.file === PLACEMENTS_FILE)!.hash)!.byteLength).toBeLessThanOrEqual(PLACEMENTS_MAX_BYTES)
  })
})

describe('assembleRedeploy and the placements', () => {
  it('a placements-only difference is no change to deploy, and the live file stays as it is', async () => {
    const r = await assembleRedeploy({ live: await live(), adopted: false, models: [need('a')], timestamp: 1, fetch: fetcher(), placements: [at('i1', 'a')] })
    expect(r.changed).toBe(false)
    expect(r.deployedFiles).not.toContain(PLACEMENTS_FILE)
  })

  it('any deploy that goes ahead rewrites them from the current scene, new models included', async () => {
    const stale = { file: PLACEMENTS_FILE, hash: await dclHash(enc('{"v":1,"models":[]}')) }
    const r = await assembleRedeploy({
      live: await live([stale]), adopted: false, models: [need('a'), need('b')], timestamp: 1, fetch: fetcher(),
      placements: [at('i1', 'a'), at('i2', 'b')],
    })
    expect(r.changed).toBe(true)
    expect(r.existing.map((c) => c.file)).not.toContain(PLACEMENTS_FILE)
    expect(placementsOf(r)).toEqual([at('i1', 'a'), at('i2', 'b')])
    expect(r.deployedFiles.filter((f) => f === PLACEMENTS_FILE)).toHaveLength(1)
  })

  it('an unchanged placements file is kept by its hash, not uploaded again', async () => {
    const first = await assembleFresh({ metadata: metadata(), models: [need('a')], timestamp: 1, fetch: fetcher(), placements: [at('i1', 'a')] })
    const entity = JSON.parse(dec(first.files.get(first.entityId)!)) as { content: Array<{ file: string; hash: string }> }
    const ref = entity.content.find((c) => c.file === PLACEMENTS_FILE)!
    const r = await assembleRedeploy({ live: await live([ref]), adopted: false, models: [need('a'), need('b')], timestamp: 1, fetch: fetcher(), placements: [at('i1', 'a')] })
    expect(r.changed).toBe(true)
    expect(r.existing).toContainEqual(ref)
    expect(r.files.has(ref.hash)).toBe(false)
  })

  it('a deploy with nothing placed any more removes the file', async () => {
    const stale = { file: PLACEMENTS_FILE, hash: await dclHash(enc('old')) }
    const r = await assembleRedeploy({ live: await live([stale]), adopted: false, models: [need('a'), need('b')], timestamp: 1, fetch: fetcher(), placements: [] })
    expect(r.changed).toBe(true)
    expect(r.deployedFiles).not.toContain(PLACEMENTS_FILE)
  })

  it('upgrading an older runtime writes them', async () => {
    const r = await assembleRedeploy({ live: await live([], 8), adopted: false, models: [need('a')], timestamp: 1, fetch: fetcher(), placements: [at('i1', 'a')] })
    expect(r.changed).toBe(true)
    expect(placementsOf(r)).toEqual([at('i1', 'a')])
  })

  it("never touches an adopted scene's files", async () => {
    const l = await live()
    delete (l.metadata as { virvi?: unknown }).virvi
    const r = await assembleRedeploy({ live: l, adopted: true, models: [need('a'), need('b')], timestamp: 1, fetch: fetcher(), placements: [at('i1', 'a')] })
    expect(r.changed).toBe(true)
    expect(r.deployedFiles).not.toContain(PLACEMENTS_FILE)
  })
})

describe('the placements file is never a pending change', () => {
  it('pendingModels ignores it', async () => {
    const user = await createUser()
    const { scene, preset } = await createScene(user)
    await createElement(preset.id, { type: 'model', name: 'Chair', properties: { modelSrc: `${CDN}/m/Chair.glb` } })
    expect(await pendingModels({ sceneId: scene.id, deployedFiles: ['models/virvi/chair.glb', PLACEMENTS_FILE] })).toEqual([])
  })
})
