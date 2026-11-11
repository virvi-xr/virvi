/**
 * LIV-134: a platform that placed models before live state (Decentraland's deployed snapshot) hands each one to the
 * model manager by instance id, and removes the rest once live state has arrived.
 */
import { describe, it, expect, vi } from 'vitest'
import { SceneManager } from '../src/SceneManager.js'
import { VirviStorageImpl } from '../src/storage.js'
import { EventBus } from '../src/events/EventBus.js'

function setup(placed: Record<string, number>) {
  let next = 100
  const order: string[] = []
  const adapter: any = {
    capabilities: { gltfModels: true, platformName: 'test' },
    createEntity: vi.fn(() => next++),
    adoptEntity: vi.fn((sk: string) => {
      const e = placed[sk]
      delete placed[sk]
      return e ?? null
    }),
    releaseUnadopted: vi.fn(() => order.push('release')),
    destroyEntity: vi.fn(),
    entityExists: vi.fn(() => true),
    setTransform: vi.fn(),
    setGltfModel: vi.fn(() => order.push('model')),
    setCollider: vi.fn(() => order.push('collider')),
    removeCollider: vi.fn(),
    onPointerDown: vi.fn(),
    removePointerEvents: vi.fn(),
  }
  const sm = new SceneManager(adapter, VirviStorageImpl.create(), new EventBus())
  return { adapter, sm, order }
}

const preset = (...sks: Array<[string, boolean?]>) => ({
  models: [{
    sk: 'm', name: 'Chair', enabled: true, modelSrc: 'models/chair.glb',
    instances: sks.map(([sk, withCollisions]) => ({ sk, enabled: true, position: { x: 1, y: 0, z: 0 }, withCollisions: !!withCollisions })),
  }],
})

describe('adopting placed models', () => {
  it('uses the placed entity for the same instance and creates the others', () => {
    const { adapter, sm } = setup({ i1: 7 })
    sm.handlePresetUpdate({ action: 'init', scenePreset: preset(['i1'], ['i2']) })
    expect(adapter.adoptEntity.mock.calls.map((c: unknown[]) => c[0])).toEqual(['i1', 'i2'])
    expect(adapter.createEntity).toHaveBeenCalledTimes(1)
    expect(adapter.setGltfModel.mock.calls.map((c: unknown[]) => c[0])).toEqual([7, 100])
  })

  it('sets collisions before the model, so the model is set once with them', () => {
    const { sm, order } = setup({})
    sm.handlePresetUpdate({ action: 'init', scenePreset: preset(['i1', true]) })
    expect(order).toEqual(['collider', 'model', 'release'])
  })

  it('releases what nobody adopted after init and after a preset switch, never on other updates', () => {
    const { adapter, sm } = setup({})
    sm.handlePresetUpdate({ action: 'init', scenePreset: preset(['i1']) })
    expect(adapter.releaseUnadopted).toHaveBeenCalledTimes(1)
    sm.handlePresetUpdate({ action: 'create', element: 'model', elementData: preset(['i2']).models[0] })
    expect(adapter.releaseUnadopted).toHaveBeenCalledTimes(1)
    sm.handlePresetChange({ scenePreset: preset() })
    expect(adapter.releaseUnadopted).toHaveBeenCalledTimes(2)
  })

  it('works with adapters that place nothing', () => {
    const { adapter, sm } = setup({})
    delete adapter.adoptEntity
    delete adapter.releaseUnadopted
    sm.handlePresetUpdate({ action: 'init', scenePreset: preset(['i1']) })
    expect(adapter.createEntity).toHaveBeenCalledTimes(1)
  })
})
