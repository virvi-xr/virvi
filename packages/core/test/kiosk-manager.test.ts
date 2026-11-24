import { describe, it, expect, vi } from 'vitest'
import { SceneManager } from '../src/SceneManager.js'
import { VirviStorageImpl } from '../src/storage.js'
import { EventBus } from '../src/events/EventBus.js'

/** Giveaway kiosks as the scene runtime draws them, and their clicks. */
const G = '0f0e0d0c-0000-4000-8000-000000000001'
const G2 = '0f0e0d0c-0000-4000-8000-000000000002'

function setup(opts: { avatars?: boolean; shapes?: boolean; maxEntities?: number } = {}) {
  let next = 1
  const live = new Set<number>()
  const clicks = new Map<number, { hoverText?: string; cb: () => void }>()
  const systems = new Set<(dt: number) => void>()
  const kinds = new Map<number, string>()
  const transforms = new Map<number, any>()
  const adapter: any = {
    capabilities: { video: true, gltfModels: true, platformName: 'test', maxEntities: opts.maxEntities },
    createEntity: vi.fn(() => { const e = next++; live.add(e); return e }),
    destroyEntity: vi.fn((e: number) => { live.delete(e); clicks.delete(e); kinds.delete(e) }),
    entityExists: vi.fn((e: number) => live.has(e)),
    entityCount: () => live.size,
    setTransform: vi.fn((e: number, t: any) => transforms.set(e, t)),
    setPlaneRenderer: vi.fn((e: number) => kinds.set(e, 'plane')),
    setGltfModel: vi.fn((e: number) => kinds.set(e, 'model')),
    resolveModelSrc: (src: string) => (src.startsWith('http') ? null : src),
    setMaterial: vi.fn(),
    setText: vi.fn((e: number) => kinds.set(e, 'text')),
    setCollider: vi.fn(),
    removeCollider: vi.fn(),
    setName: vi.fn(),
    onPointerDown: vi.fn((e: number, o: any, cb: () => void) => clicks.set(e, { hoverText: o.hoverText, cb })),
    removePointerEvents: vi.fn(),
    registerSystem: vi.fn((s: any) => systems.add(s)),
    unregisterSystem: vi.fn((s: any) => systems.delete(s)),
  }
  if (opts.shapes !== false) adapter.setSolidShape = vi.fn((e: number) => kinds.set(e, 'box'))
  if (opts.avatars !== false) adapter.setAvatarShape = vi.fn((e: number) => kinds.set(e, 'avatar'))
  const storage = VirviStorageImpl.create()
  const events = new EventBus()
  const sm = new SceneManager(adapter, storage, events)
  const clicked: any[] = []
  events.on('kiosk_click', (c: any) => clicked.push(c))
  const counts: number[] = []
  events.on('kiosks_changed', (n: number) => counts.push(n))
  const tick = (dt: number) => { for (const s of [...systems]) s(dt) }
  return { adapter, sm, live, clicks, kinds, transforms, clicked, counts, systems, tick, storage }
}

const inst = (sk: string) => ({ sk, enabled: true, position: { x: 8, y: 0, z: 8 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } })
const kiosk = (over: Record<string, unknown> = {}) => ({
  sk: 'k1', name: 'Front kiosk', enabled: true, giveawayId: G, claimPointType: 1, imgSrc: 'https://cdn/prize.png', instances: [inst('i1')], ...over,
})
const init = (h: ReturnType<typeof setup>, claimPoints: unknown[]) => h.sm.handlePresetUpdate({ action: 'init', scenePreset: { claimPoints } })

describe('KioskManager', () => {
  it('draws a booth with the item, and every clickable part opens the kiosk’s giveaway', () => {
    const h = setup()
    init(h, [kiosk({ hoverText: 'Grab it' })])
    expect(h.live.size).toBe(8)
    expect([...h.kinds.values()].filter((k) => k === 'box')).toHaveLength(6)
    expect(h.clicks.size).toBe(4)
    for (const c of h.clicks.values()) expect(c.hoverText).toBe('Grab it')
    ;[...h.clicks.values()][0].cb()
    expect(h.clicked).toEqual([{ elementId: 'k1', instanceId: 'i1', giveawayId: G }])
    expect(h.storage.claimPoints.configs.k1).toBeTruthy()
    expect(h.counts).toEqual([1])
    expect(h.sm.kioskCount()).toBe(1)
  })

  it('without the booth, only the item is drawn', () => {
    const h = setup()
    init(h, [kiosk({ enableKiosk: false })])
    expect(h.live.size).toBe(1)
    expect([...h.kinds.values()]).toEqual(['plane'])
  })

  it('a marketplace image kiosk uses the server’s item thumbnail', () => {
    const h = setup()
    init(h, [kiosk({ enableKiosk: false, claimPointType: 0, imgSrc: undefined, giveawayItems: [{ name: 'Hat', thumbnail: 'https://peer/hat.png', urn: 'urn:x' }] })])
    expect(h.adapter.setMaterial).toHaveBeenCalledWith(expect.any(Number), expect.objectContaining({ textureSrc: 'https://peer/hat.png' }))
  })

  it('a mannequin wears the giveaway wearables; a platform without avatars shows only the click box', () => {
    const items = [{ name: 'Hat', thumbnail: null, urn: 'urn:hat' }]
    const h = setup()
    init(h, [kiosk({ enableKiosk: false, claimPointType: 3, mannequinType: 0, giveawayItems: items })])
    expect(h.adapter.setAvatarShape).toHaveBeenCalledWith(expect.any(Number), { bodyShape: 'male', wearables: ['urn:hat'] })
    expect(h.clicks.size).toBe(1)
    const bare = setup({ avatars: false })
    init(bare, [kiosk({ enableKiosk: false, claimPointType: 3, giveawayItems: items })])
    expect(bare.live.size).toBe(1)
    expect(bare.clicks.size).toBe(1)
  })

  it('a model the platform can’t load shows nothing; platforms without solid shapes leave the booth out', () => {
    const h = setup()
    init(h, [kiosk({ enableKiosk: false, claimPointType: 2, modelSrc: 'https://cdn/x.glb' })])
    expect(h.live.size).toBe(0)
    const plain = setup({ shapes: false })
    init(plain, [kiosk()])
    expect([...plain.kinds.values()].sort()).toEqual(['plane', 'text'])
  })

  it('a kiosk that would take the scene over its entity limit is left off', () => {
    const h = setup({ maxEntities: 5 })
    init(h, [kiosk()])
    expect(h.live.size).toBe(0)
  })

  it('spins the item only while the kiosk spins', () => {
    const h = setup()
    init(h, [kiosk({ enableKiosk: false, enableSpin: true })])
    expect(h.systems.size).toBe(1)
    const [e] = [...h.live]
    h.tick(1)
    expect(h.transforms.get(e).rotation.y).toBeCloseTo(45)
    h.sm.handlePresetUpdate({ action: 'update', element: 'claim_point', elementData: { sk: 'k1', enableSpin: false } })
    expect(h.systems.size).toBe(0)
    expect(h.transforms.get(e).rotation.y).toBe(0)
  })

  it('edits redraw the copy: a new look makes new parts, a new giveaway is what the next click opens', () => {
    const h = setup()
    init(h, [kiosk()])
    const before = [...h.live]
    h.sm.handlePresetUpdate({ action: 'update', element: 'claim_point', elementData: { sk: 'k1', giveawayId: G2 } })
    expect([...h.live]).toEqual(before)
    ;[...h.clicks.values()][0].cb()
    expect(h.clicked.at(-1).giveawayId).toBe(G2)
    h.sm.handlePresetUpdate({ action: 'update', element: 'claim_point', elementData: { sk: 'k1', enableKiosk: false } })
    expect(h.live.size).toBe(1)
    expect(before.some((e) => h.live.has(e))).toBe(false)
  })

  it('moves every part with the instance', () => {
    const h = setup()
    init(h, [kiosk()])
    h.sm.handlePresetUpdate({ action: 'update', element: 'claim_point', instance: true, instanceData: { sk: 'i1', position: { x: 2, y: 0, z: 2 } } })
    for (const e of h.live) expect(Math.abs(h.transforms.get(e).position.x - 2)).toBeLessThan(1.2)
  })

  it('an upsert from the dashboard rebuilds it; deleting and clearing remove it and report the count', () => {
    const h = setup()
    init(h, [kiosk()])
    h.sm.handlePresetUpdate({ action: 'upsert', element: 'claim_point', elementData: kiosk({ instances: [inst('i1'), inst('i2')] }) })
    expect(h.live.size).toBe(16)
    expect(h.sm.kioskCount()).toBe(2)
    h.sm.handlePresetUpdate({ action: 'delete', element: 'claim_point', instance: true, id: 'i2' })
    expect(h.live.size).toBe(8)
    h.sm.handlePresetChange({ scenePreset: { claimPoints: [] } })
    expect(h.live.size).toBe(0)
    expect(h.counts).toEqual([1, 0, 2, 1, 0])
  })

  it('a disabled kiosk or copy is not drawn', () => {
    const h = setup()
    init(h, [kiosk({ enabled: false }), kiosk({ sk: 'k2', instances: [{ ...inst('i9'), enabled: false }] })])
    expect(h.live.size).toBe(0)
    expect(h.counts).toEqual([])
  })
})
