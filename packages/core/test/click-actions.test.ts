import { describe, it, expect, vi } from 'vitest'
import { SceneManager } from '../src/SceneManager.js'
import { VirviStorageImpl } from '../src/storage.js'
import { EventBus } from '../src/events/EventBus.js'

/** Click actions on placed items (LIV-126), as old VLM's ClickEvent.service ran them. */
function setup() {
  let next = 1
  const clicks = new Map<number, { opts: any; cb: () => void }>()
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
    onPointerDown: vi.fn((e: number, opts: any, cb: () => void) => clicks.set(e, { opts, cb })),
    removePointerEvents: vi.fn((e: number) => clicks.delete(e)),
    openUrl: vi.fn(),
    teleportPlayer: vi.fn(),
    movePlayer: vi.fn(),
  }
  const sm = new SceneManager(adapter, VirviStorageImpl.create(), new EventBus())
  return { adapter, sm, clicks }
}

const inst = (sk = 'i1', extra: Record<string, unknown> = {}) => ({ sk, enabled: true, position: { x: 1, y: 1, z: 1 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, ...extra })
const init = (sm: SceneManager, key: string, el: Record<string, unknown>, instances = [inst()]) =>
  sm.handlePresetUpdate({ action: 'init', scenePreset: { [key]: [{ sk: 'e1', enabled: true, instances, ...el }] } })
const link = { type: 1, externalLink: 'https://tickets.example/show', hoverText: 'Get tickets', showFeedback: true }

describe('click actions on placed items', () => {
  it.each([
    ['images', { textureSrc: 'https://cdn/x/poster.png' }],
    ['models', { modelSrc: 'models/chair.glb' }],
    ['videos', { offType: 1, offImageSrc: 'https://cdn/x/off.png', playlist: [] }],
  ])('%s: a link opens with its hover text', (key, el) => {
    const { sm, adapter, clicks } = setup()
    init(sm, key, { ...el, clickEvent: link })
    const [entity, c] = [...clicks.entries()][0]
    expect(c.opts).toEqual({ hoverText: 'Get tickets', showFeedback: true })
    c.cb()
    expect(adapter.openUrl).toHaveBeenCalledWith('https://tickets.example/show')
    expect(entity).toBeGreaterThan(0)
  })

  it('teleports, moves the player (with or without a camera target) and plays a sound', () => {
    const { sm, adapter, clicks } = setup()
    init(sm, 'images', { textureSrc: 'https://cdn/x/a.png' }, [
      inst('t', { clickEvent: { type: 5, teleportTo: '52,-20', hoverText: 'Go to the plaza' } }),
      inst('m', { clickEvent: { type: 4, moveTo: { position: { x: 8, y: 0, z: 8 } } } }),
      inst('c', { clickEvent: { type: 4, moveTo: { position: { x: 1, y: 2, z: 3 }, cameraTarget: { x: 4, y: 5, z: 6 } } } }),
      inst('s', { clickEvent: { type: 2, sound: 'https://cdn/x/ding.mp3' } }),
    ])
    const all = [...clicks.values()]
    all.forEach((c) => c.cb())
    expect(adapter.teleportPlayer).toHaveBeenCalledWith('52,-20')
    expect(adapter.movePlayer).toHaveBeenCalledWith({ x: 8, y: 0, z: 8 }, undefined)
    expect(adapter.movePlayer).toHaveBeenCalledWith({ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 })
    expect(adapter.setAudioSource).toHaveBeenCalledWith(expect.any(Number), { src: 'https://cdn/x/ding.mp3', playing: true, loop: false, volume: 1 })
    expect(all[0].opts).toEqual({ hoverText: 'Go to the plaza', showFeedback: false })
  })

  it("a copy's own click wins; NONE or an incomplete action falls back to the item's, or nothing", () => {
    const { sm, adapter, clicks } = setup()
    init(sm, 'images', { textureSrc: 'https://cdn/x/a.png', clickEvent: link }, [
      inst('own', { clickEvent: { type: 5, teleportTo: '0,0' } }),
      inst('none', { clickEvent: { type: 0 } }),
    ])
    expect(clicks.size).toBe(2)
    ;[...clicks.values()].forEach((c) => c.cb())
    expect(adapter.teleportPlayer).toHaveBeenCalledTimes(1)
    expect(adapter.openUrl).toHaveBeenCalledTimes(1)

    const b = setup()
    init(b.sm, 'images', { textureSrc: 'https://cdn/x/a.png', clickEvent: { type: 1, externalLink: 'javascript:alert(1)' } })
    init(b.sm, 'models', { modelSrc: 'm.glb', clickEvent: { type: 3 } }) // STREAM isn't defined: nothing to do
    expect(b.clicks.size).toBe(0)
  })

  it('an edit to the click is applied to every copy, and clearing it removes the click', () => {
    const { sm, adapter, clicks } = setup()
    init(sm, 'images', { textureSrc: 'https://cdn/x/a.png' }, [inst('a'), inst('b')])
    expect(clicks.size).toBe(0)
    sm.handlePresetUpdate({ action: 'update', element: 'image', id: 'e1', property: 'clickEvent', value: link } as any)
    expect(clicks.size).toBe(2)
    sm.handlePresetUpdate({ action: 'update', element: 'image', id: 'e1', property: 'clickEvent', value: { type: 0 } } as any)
    expect(clicks.size).toBe(0)
    expect(adapter.removePointerEvents).toHaveBeenCalled()
  })

  it("a screen showing ads keeps the ad's click", () => {
    const { sm, clicks } = setup()
    init(sm, 'videos', { offType: 4, playlist: [], clickEvent: link })
    expect([...clicks.values()].some((c) => c.opts.hoverText === 'Get tickets')).toBe(false)
  })
})
