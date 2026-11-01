import { describe, it, expect, vi } from 'vitest'
import { SceneManager } from '../src/SceneManager.js'
import { VirviStorageImpl } from '../src/storage.js'
import { EventBus } from '../src/events/EventBus.js'
import { AdSlot } from '../src/ads/slot.js'

function setup(withSetName = true) {
  let next = 1
  const names = new Map<number, string>()
  const adapter: any = {
    capabilities: { video: true, gltfModels: true, platformName: 'test' },
    createEntity: vi.fn(() => next++),
    destroyEntity: vi.fn(),
    entityExists: vi.fn(() => true),
    setTransform: vi.fn(),
    setPlaneRenderer: vi.fn(),
    setGltfModel: vi.fn(),
    setMaterial: vi.fn(),
    setCollider: vi.fn(),
    removeCollider: vi.fn(),
    createVideoPlayer: vi.fn(),
    setAudioSource: vi.fn(),
    registerSystem: vi.fn(),
    unregisterSystem: vi.fn(),
  }
  if (withSetName) adapter.setName = vi.fn((e: number, n: string) => names.set(e, n))
  const sm = new SceneManager(adapter, VirviStorageImpl.create(), new EventBus())
  return { adapter, sm, names }
}

const inst = (sk = 'i1') => ({ sk, enabled: true, position: { x: 1, y: 1, z: 1 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } })
const init = (sm: SceneManager, key: string, el: Record<string, unknown>) =>
  sm.handlePresetUpdate({ action: 'init', scenePreset: { [key]: [{ sk: 'e1', enabled: true, instances: [inst()], ...el }] } })
const lastEntity = (adapter: any) => adapter.createEntity.mock.results.at(-1).value as number

describe('Virvi items are named for analytics', () => {
  it.each([
    ['images', { name: 'Poster', textureSrc: 'https://cdn/x/poster.png' }],
    ['videos', { name: 'Poster', liveSrc: 'https://live/a.m3u8', playlist: [] }],
    ['models', { name: 'Poster', modelSrc: 'models/chair.glb' }],
    ['sounds', { name: 'Poster', audioSrc: 'https://cdn/x/song.mp3' }],
    ['adSpaces', { name: 'Poster', shape: '16:9', formats: 'both' }],
  ])('%s: the entity gets the element name', (key, el) => {
    const { sm, adapter, names } = setup()
    init(sm, key, el)
    expect(names.get(lastEntity(adapter))).toBe('Poster')
  })

  it.each([
    ['images', { textureSrc: 'https://cdn/x/poster.png?v=2' }, 'poster.png'],
    ['models', { modelSrc: 'models/chair.glb' }, 'chair.glb'],
    ['sounds', { audioSrc: 'https://cdn/x/song.mp3' }, 'song.mp3'],
    ['videos', { liveSrc: 'https://live/a.m3u8' }, 'Video screen'],
    ['adSpaces', { shape: '16:9', formats: 'both' }, 'Ad space'],
    ['videos', {}, 'Video screen'],
  ])('%s without a name falls back to %j -> %s', (key, el, expected) => {
    const { sm, adapter, names } = setup()
    init(sm, key, el)
    expect(names.get(lastEntity(adapter))).toBe(expected)
  })

  it('renaming an element renames its entities', () => {
    const { sm, adapter, names } = setup()
    init(sm, 'images', { name: 'Poster', textureSrc: 'https://cdn/poster.png' })
    const e = lastEntity(adapter)
    sm.handlePresetUpdate({ action: 'update', element: 'image', elementData: { sk: 'e1', name: 'Banner' } })
    expect(names.get(e)).toBe('Banner')
  })

  it.each([
    ['images', 'image', { textureSrc: 'https://cdn/a.png' }, { textureSrc: 'https://cdn/b.png' }, 'a.png', 'b.png'],
    ['models', 'model', { modelSrc: 'models/a.glb' }, { modelSrc: 'models/b.glb' }, 'a.glb', 'b.glb'],
    ['sounds', 'sound', { audioSrc: 'https://cdn/a.mp3' }, { audioSrc: 'https://cdn/b.mp3' }, 'a.mp3', 'b.mp3'],
  ])('%s: a source change refreshes a file-name fallback', (key, element, before, after, nameBefore, nameAfter) => {
    const { sm, adapter, names } = setup()
    init(sm, key, before)
    const e = lastEntity(adapter)
    expect(names.get(e)).toBe(nameBefore)
    sm.handlePresetUpdate({ action: 'update', element, elementData: { sk: 'e1', ...after } })
    expect(names.get(e)).toBe(nameAfter)
  })

  it('works on adapters without setName', () => {
    const { sm, adapter } = setup(false)
    expect(() => init(sm, 'images', { name: 'Poster', textureSrc: 'https://cdn/poster.png' })).not.toThrow()
    expect(adapter.createEntity).toHaveBeenCalled()
  })

  it('an ad slot names the fresh entity it swaps in', () => {
    const { adapter, names } = setup()
    const holder = { entity: adapter.createEntity() }
    new AdSlot({
      adapter,
      host: null,
      holder,
      spec: { key: 'k', elementId: 'e', name: 'Lobby ad', shape: '16:9', formats: 'both', withCollisions: false },
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      hasPlane: true,
      isStreamLive: () => false,
    }).run()
    expect(holder.entity).not.toBe(1)
    expect(names.get(holder.entity)).toBe('Lobby ad')
  })
})
