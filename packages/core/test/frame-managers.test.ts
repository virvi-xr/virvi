import { describe, it, expect, vi } from 'vitest'
import { defaultFrame } from '@virvixr/shared'
import { SceneManager } from '../src/SceneManager.js'
import { VirviStorageImpl } from '../src/storage.js'
import { EventBus } from '../src/events/EventBus.js'

/** Frames on images and video screens, as the scene runtime draws them (LIV-129). */
function setup(opts: { shapes?: boolean } = {}) {
  let next = 1
  const live = new Set<number>()
  const shapes = new Map<number, string>()
  const transforms = new Map<number, any>()
  const adapter: any = {
    capabilities: { video: true, gltfModels: true, platformName: 'test' },
    createEntity: vi.fn(() => { const e = next++; live.add(e); return e }),
    destroyEntity: vi.fn((e: number) => { live.delete(e); shapes.delete(e) }),
    entityExists: vi.fn((e: number) => live.has(e)),
    setTransform: vi.fn((e: number, t: any) => transforms.set(e, t)),
    setPlaneRenderer: vi.fn(),
    setGltfModel: vi.fn(),
    setMaterial: vi.fn(),
    setCollider: vi.fn(),
    removeCollider: vi.fn(),
    onPointerDown: vi.fn(),
    removePointerEvents: vi.fn(),
    createVideoPlayer: vi.fn(),
    registerSystem: vi.fn(),
    unregisterSystem: vi.fn(),
  }
  if (opts.shapes !== false) adapter.setSolidShape = vi.fn((e: number, shape: string) => shapes.set(e, shape))
  const storage = VirviStorageImpl.create()
  const sm = new SceneManager(adapter, storage, new EventBus())
  const bars = () => [...shapes.keys()].filter((e) => live.has(e))
  return { adapter, sm, live, shapes, transforms, bars }
}

const inst = (sk: string, scale = { x: 2, y: 1, z: 1 }) => ({
  sk, enabled: true, position: { x: 8, y: 2, z: 8 }, rotation: { x: 0, y: 0, z: 0 }, scale,
})
const image = (over: Record<string, unknown> = {}) => ({ sk: 'img', name: 'Poster', enabled: true, textureSrc: 'a.png', instances: [inst('i1')], ...over })
const video = (over: Record<string, unknown> = {}) => ({ sk: 'vid', name: 'Screen', enabled: true, offType: 1, offImageSrc: 'off.png', instances: [inst('v1', { x: 4, y: 2.25, z: 1 })], ...over })
const top = (h: ReturnType<typeof setup>) => h.bars().map((e) => h.transforms.get(e)).sort((a, b) => b.position.y - a.position.y)[0]

describe('image frames', () => {
  it('an image without a frame looks as before: only its plane', () => {
    const h = setup()
    h.sm.handlePresetUpdate({ action: 'init', scenePreset: { images: [image(), image({ sk: 'img2', frame: { ...defaultFrame(), enabled: false }, instances: [inst('i2')] })] } })
    expect(h.live.size).toBe(2)
    expect(h.adapter.setSolidShape).not.toHaveBeenCalled()
  })

  it('a framed image gets four bars per copy, around its scale', () => {
    const h = setup()
    h.sm.handlePresetUpdate({ action: 'init', scenePreset: { images: [image({ frame: defaultFrame(), instances: [inst('i1'), inst('i2', { x: 1, y: 3, z: 1 })] })] } })
    expect(h.bars()).toHaveLength(8)
    expect(h.live.size).toBe(10)
  })

  it('a live upsert adds, restyles and removes the frame (the dashboard and HUD save through REST)', () => {
    const h = setup()
    h.sm.handlePresetUpdate({ action: 'init', scenePreset: { images: [image()] } })
    h.sm.handlePresetUpdate({ action: 'upsert', element: 'image', elementData: image({ frame: defaultFrame() }) })
    expect(h.bars()).toHaveLength(4)
    h.sm.handlePresetUpdate({ action: 'upsert', element: 'image', elementData: image({ frame: defaultFrame('gallery') }) })
    expect(h.bars()).toHaveLength(8)
    h.sm.handlePresetUpdate({ action: 'upsert', element: 'image', elementData: image({ frame: { ...defaultFrame(), enabled: false } }) })
    expect(h.bars()).toHaveLength(0)
    expect(h.live.size).toBe(1)
  })

  it('a partial element update (scene room) changes the frame too', () => {
    const h = setup()
    h.sm.handlePresetUpdate({ action: 'init', scenePreset: { images: [image()] } })
    h.sm.handlePresetUpdate({ action: 'update', element: 'image', elementData: { sk: 'img', frame: defaultFrame('classic') } })
    expect(h.bars()).toHaveLength(4)
    expect(h.adapter.setSolidShape).toHaveBeenLastCalledWith(expect.any(Number), 'box', expect.objectContaining({ r: 0x6b / 255 }))
    h.sm.handlePresetUpdate({ action: 'update', element: 'image', elementData: { sk: 'img', frame: null } })
    expect(h.bars()).toHaveLength(0)
  })

  it('swapping the picture keeps the frame', () => {
    const h = setup()
    h.sm.handlePresetUpdate({ action: 'init', scenePreset: { images: [image({ frame: defaultFrame() })] } })
    h.sm.handlePresetUpdate({ action: 'update', element: 'image', elementData: { sk: 'img', textureSrc: 'b.png' } })
    expect(h.bars()).toHaveLength(4)
    h.sm.handlePresetUpdate({ action: 'upsert', element: 'image', elementData: image({ textureSrc: 'c.png', frame: defaultFrame() }) })
    expect(h.bars()).toHaveLength(4)
  })

  it('resizing, moving and previewing a copy keeps the frame fitted', () => {
    const h = setup()
    h.sm.handlePresetUpdate({ action: 'init', scenePreset: { images: [image({ frame: defaultFrame() })] } })
    expect(top(h).position.y).toBeCloseTo(2 + 0.5 + 0.01) // 2% of the 1 m side, half of it above the edge
    h.sm.handlePresetUpdate({ action: 'update', element: 'image', instance: true, instanceData: { sk: 'i1', scale: { x: 1, y: 4, z: 1 } } })
    expect(top(h).position.y).toBeCloseTo(2 + 2 + 0.01)
    expect(top(h).scale.x).toBeCloseTo(1 + 0.04)
    h.sm.previewTransform('image', 'i1', { position: { x: 0, y: 10, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } })
    expect(top(h).position.y).toBeCloseTo(10.51)
    h.sm.restoreTransform('image', 'i1')
    expect(top(h).position.y).toBeCloseTo(4.01)
  })

  it('deleting a copy or the image removes its frame', () => {
    const h = setup()
    h.sm.handlePresetUpdate({ action: 'init', scenePreset: { images: [image({ frame: defaultFrame(), instances: [inst('i1'), inst('i2')] })] } })
    h.sm.handlePresetUpdate({ action: 'delete', element: 'image', instance: true, id: 'i1' })
    expect(h.bars()).toHaveLength(4)
    h.sm.handlePresetUpdate({ action: 'delete', element: 'image', id: 'img' })
    expect(h.live.size).toBe(0)
  })

  it('a platform without solid shapes shows the image, unframed', () => {
    const h = setup({ shapes: false })
    h.sm.handlePresetUpdate({ action: 'init', scenePreset: { images: [image({ frame: defaultFrame() })] } })
    expect(h.live.size).toBe(1)
  })
})

describe('frames and the entity limit', () => {
  it('a frame that would take the scene over its limit is left off; the image itself is always made', () => {
    const h = setup()
    h.adapter.capabilities.maxEntities = 7
    h.adapter.entityCount = () => h.live.size
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    h.sm.handlePresetUpdate({ action: 'init', scenePreset: { images: [image({ frame: defaultFrame(), instances: [inst('i1'), inst('i2'), inst('i3')] })] } })
    // i1: plane + 4 bars = 5; i2: plane (6), 4 more bars would be 10 > 7, so none; i3: plane (7)
    expect(h.live.size).toBe(7)
    expect(h.bars()).toHaveLength(4)
    log.mockRestore()
  })
})

describe('video screen frames', () => {
  it('a framed screen gets bars; restyling and removing work live', () => {
    const h = setup()
    h.sm.handlePresetUpdate({ action: 'init', scenePreset: { videos: [video()] } })
    expect(h.bars()).toHaveLength(0)
    h.sm.handlePresetUpdate({ action: 'upsert', element: 'video', elementData: video({ frame: defaultFrame('classic') }) })
    expect(h.bars()).toHaveLength(4)
    h.sm.handlePresetUpdate({ action: 'update', element: 'video', elementData: { sk: 'vid', frame: defaultFrame('gallery') } })
    expect(h.bars()).toHaveLength(8)
    h.sm.handlePresetUpdate({ action: 'upsert', element: 'video', elementData: video() })
    expect(h.bars()).toHaveLength(0)
  })

  it('the frame follows a resized screen and goes with it', () => {
    const h = setup()
    h.sm.handlePresetUpdate({ action: 'init', scenePreset: { videos: [video({ frame: defaultFrame() })] } })
    h.sm.handlePresetUpdate({ action: 'update', element: 'video', instance: true, instanceData: { sk: 'v1', scale: { x: 8, y: 4.5, z: 1 } } })
    expect(top(h).scale.x).toBeCloseTo(8 + 2 * 0.09)
    h.sm.handlePresetUpdate({ action: 'delete', element: 'video', id: 'vid' })
    expect(h.bars()).toHaveLength(0)
  })

  it('a screen in an ads mode keeps its frame (ad spaces are the ones left unframed)', () => {
    const h = setup()
    h.sm.handlePresetUpdate({ action: 'init', scenePreset: { videos: [video({ offType: 4, frame: defaultFrame() })], adSpaces: [{ sk: 'ad', enabled: true, shape: '16:9', formats: 'both', frame: defaultFrame(), instances: [inst('a1')] }] } })
    expect(h.bars()).toHaveLength(4)
  })
})
