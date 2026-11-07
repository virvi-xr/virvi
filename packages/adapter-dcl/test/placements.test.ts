/**
 * LIV-134: the deployed placements snapshot, against Decentraland's real ECS engine. The runtime places every model
 * before it talks to Virvi; the live scene then adopts each entity by instance id (nothing re-sent, nothing duplicated)
 * and removes the rest.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ content: [] as Array<{ file: string; hash: string }> }))
vi.mock('~system/Runtime', () => ({
  getSceneInformation: async () => ({ urn: 'u', baseUrl: '', content: runtime.content, metadataJson: '{}' }),
  readFile: async () => { throw new Error('not deployed') },
}))

import { engine, Transform, GltfContainer, Entity } from '@dcl/sdk/ecs'
import { Quaternion } from '@dcl/sdk/math'
import { SceneManager, EventBus, VirviStorageImpl } from '@virvixr/core'
import { PLACEMENTS_FILE, encodePlacements, type Placement } from '@virvixr/shared'
import { DclAdapter } from '../src/DclAdapter.js'
import { placeDeployedModels, placeModels, adoptPlaced, releasePlaced, resetPlacedForTests, utf8, PLACEMENTS_READ_TIMEOUT_S } from '../src/placements.js'

const at = (i: string, over: Partial<Placement> = {}): Placement => ({
  instanceId: i, elementId: 'chair', src: 'models/virvi/Chair.glb',
  position: { x: 1, y: 0, z: 2 }, rotation: { x: 0, y: 90, z: 0 }, scale: { x: 2, y: 2, z: 2 }, collisions: false, ...over,
})
const file = (list: Placement[]) => new TextEncoder().encode(encodePlacements(list))

/** Every CRDT update the engine sends on its next update, as [type, entity, componentId]. */
const sent: Array<[number, number, number | undefined]> = []
engine.addTransport({ send: async () => {}, filter: (m: any) => { sent.push([m.type, m.entityId, m.componentId]); return true } })
async function flush() { sent.length = 0; await engine.update(1); return [...sent] }

const models = () => [...engine.getEntitiesWith(GltfContainer, Transform)].map(([e, g, t]) => ({ e, src: g.src, mask: g.visibleMeshesCollisionMask, t }))

beforeEach(async () => {
  for (const { e } of models()) engine.removeEntity(e)
  resetPlacedForTests()
  await flush()
})

describe('placeDeployedModels', () => {
  it('reads virvi/placements.json and creates each model with its transform and collisions', async () => {
    const read = vi.fn(async () => file([at('i1'), at('i2', { position: { x: 5, y: 1, z: 5 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, collisions: true })]))
    expect(await placeDeployedModels(read)).toBe(2)
    expect(read).toHaveBeenCalledWith(PLACEMENTS_FILE)
    const got = models()
    expect(got.map((m) => [m.src, m.mask])).toEqual([['models/virvi/Chair.glb', undefined], ['models/virvi/Chair.glb', 2]])
    expect(got[0].t.position).toEqual({ x: 1, y: 0, z: 2 })
    expect(got[0].t.scale).toEqual({ x: 2, y: 2, z: 2 })
    expect(got[0].t.rotation).toEqual(Quaternion.fromEulerDegrees(0, 90, 0))
    expect(got[1].t.position).toEqual({ x: 5, y: 1, z: 5 })
  })

  it('places nothing, and never throws, when the file is missing, empty or not a snapshot', async () => {
    expect(await placeDeployedModels(async () => { throw new Error('missing') })).toBe(0)
    expect(await placeDeployedModels(async () => undefined)).toBe(0)
    expect(await placeDeployedModels(async () => new TextEncoder().encode('{"oops"'))).toBe(0)
    expect(models()).toEqual([])
  })

  it('places nothing once live state has arrived', async () => {
    releasePlaced()
    expect(placeModels([at('i1')])).toBe(0)
    expect(models()).toEqual([])
  })

  it('decodes UTF-8 without TextDecoder', () => {
    const s = 'models/virvi/Café-椅子-🪑.glb'
    expect(utf8(new TextEncoder().encode(s))).toBe(s)
  })
})

describe('a deployed-file read that stalls', () => {
  /** A read that settles only when the test says so. */
  function stalled() {
    let resolve!: (b: Uint8Array) => void
    const read = vi.fn(() => new Promise<Uint8Array>((r) => { resolve = r }))
    return { read, resolve: (list: Placement[]) => resolve(file(list)) }
  }
  /** Runs engine frames of `dt` seconds until `done()` or `max` frames; returns how many ran. */
  async function frames(dt: number, max: number, done: () => boolean) {
    let n = 0
    while (n < max && !done()) { await engine.update(dt); await new Promise((r) => setImmediate(r)); n++ }
    return n
  }

  it(`gives up after ${PLACEMENTS_READ_TIMEOUT_S} s of engine frames, so the scene still connects`, async () => {
    const { read } = stalled()
    let result: number | undefined
    void placeDeployedModels(read).then((n) => { result = n })
    const ran = await frames(0.1, 1000, () => result !== undefined)
    expect(result).toBe(0)
    // Not before the timeout (frames of 0.1 s), and not long after it
    expect(ran).toBeGreaterThanOrEqual(PLACEMENTS_READ_TIMEOUT_S * 10 - 1)
    expect(ran).toBeLessThanOrEqual(PLACEMENTS_READ_TIMEOUT_S * 10 + 2)
  })

  it('a read that wins leaves no timer running', async () => {
    const add = vi.spyOn(engine, 'addSystem')
    const remove = vi.spyOn(engine, 'removeSystem')
    expect(await placeDeployedModels(async () => file([at('i1')]))).toBe(1)
    await frames(0.1, 3, () => false)
    expect(add).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith(add.mock.calls[0][0])
    add.mockRestore()
    remove.mockRestore()
  })

  it('a read that settles after the timeout but before live state still places, and live state adopts it', async () => {
    const { read, resolve } = stalled()
    let done = false
    void placeDeployedModels(read).then(() => { done = true })
    await frames(1, 100, () => done)
    resolve([at('i1')])
    await new Promise((r) => setImmediate(r))
    expect(models()).toHaveLength(1)
    expect(adoptPlaced('i1')).toBe(models()[0].e)
  })

  it('a read that settles after live state took over places nothing, leaving no orphans', async () => {
    const { read, resolve } = stalled()
    let done = false
    void placeDeployedModels(read).then(() => { done = true })
    await frames(1, 100, () => done)
    releasePlaced() // the live scene's init
    resolve([at('i1'), at('i2')])
    await new Promise((r) => setImmediate(r))
    expect(models()).toEqual([])
    expect(adoptPlaced('i1')).toBeNull()
  })
})

describe('handoff to the live scene', () => {
  const chairSrc = 'https://cdn.virvi.io/u/Chair.glb'
  const instance = (sk: string, over: Record<string, unknown> = {}) => ({
    sk, enabled: true, position: { x: 1, y: 0, z: 2 }, rotation: { x: 0, y: 90, z: 0 }, scale: { x: 2, y: 2, z: 2 }, withCollisions: false, ...over,
  })
  const preset = (instances: unknown[], sk = 'p1') => ({ sk, models: [{ sk: 'chair', name: 'Chair', enabled: true, modelSrc: chairSrc, instances }] })

  async function liveScene() {
    runtime.content = [{ file: 'models/virvi/Chair.glb', hash: 'h' }]
    const adapter = new DclAdapter()
    await adapter.getSceneInfo() // scene files loaded, as before joining the room
    return new SceneManager(adapter, VirviStorageImpl.create(), new EventBus())
  }

  it('adopts the placed entity for each live copy: same entity, nothing re-sent, nothing duplicated', async () => {
    placeModels([at('i1'), at('i2', { collisions: true })])
    await flush()
    const before = models()
    const scene = await liveScene()
    scene.handlePresetUpdate({ action: 'init', scenePreset: preset([instance('i1'), instance('i2', { withCollisions: true })]) })
    const after = models()
    expect(after.map((m) => m.e)).toEqual(before.map((m) => m.e))
    expect(after.map((m) => m.mask)).toEqual([undefined, 2])
    const updates = await flush()
    const gltfOrTransform = updates.filter(([, , c]) => c === GltfContainer.componentId || c === Transform.componentId)
    expect(gltfOrTransform).toEqual([])
    expect(updates.filter(([type]) => type === 3 /* DELETE_ENTITY */)).toEqual([])
  })

  it('a copy that moved since the deploy moves the same entity; deleted copies and the old preset leave nothing behind', async () => {
    placeModels([at('i1'), at('gone')])
    const [kept, gone] = models().map((m) => m.e)
    const scene = await liveScene()
    scene.handlePresetUpdate({ action: 'init', scenePreset: preset([instance('i1', { position: { x: 3, y: 0, z: 3 } }), instance('new')]) })
    const got = models()
    expect(got).toHaveLength(2)
    expect(got.find((m) => m.e === kept)!.t.position).toEqual({ x: 3, y: 0, z: 3 })
    expect(got.some((m) => m.e === gone)).toBe(false)
    expect(adoptPlaced('gone')).toBeNull()

    scene.handlePresetChange({ scenePreset: { sk: 'p2', models: [] } })
    expect(models()).toEqual([])
  })

  it('a preset switch before init also clears whatever was placed', async () => {
    placeModels([at('i1')])
    const scene = await liveScene()
    scene.handlePresetChange({ scenePreset: { sk: 'p2', models: [] } })
    expect(models()).toEqual([])
  })

  it('a model the live scene cannot load is not kept from the snapshot', async () => {
    placeModels([at('i1')])
    const scene = await liveScene()
    runtime.content = []
    const adapter = new DclAdapter()
    await adapter.getSceneInfo()
    new SceneManager(adapter, VirviStorageImpl.create(), new EventBus()).handlePresetUpdate({ action: 'init', scenePreset: preset([instance('i1')]) })
    expect(models()).toEqual([])
    void scene
  })

  it('placed models stay when the live scene never arrives', async () => {
    placeModels([at('i1')])
    await liveScene()
    expect(models()).toHaveLength(1)
    expect(adoptPlaced('i1')).toBe(models()[0].e as Entity)
  })
})
