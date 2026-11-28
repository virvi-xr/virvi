import { describe, it, expect, vi } from 'vitest'
import { SceneManager } from '../src/SceneManager.js'
import { VirviStorageImpl } from '../src/storage.js'
import { EventBus } from '../src/events/EventBus.js'

/** LIV-158: elements and copies with customRendering go to scene code, not Virvi's managers. */
function setup(all = false) {
  let next = 1
  const adapter: any = {
    capabilities: { gltfModels: true, platformName: 'test' },
    createEntity: vi.fn(() => next++), destroyEntity: vi.fn(), entityExists: () => true,
    setTransform: vi.fn(), setPlaneRenderer: vi.fn(), setGltfModel: vi.fn(), setMaterial: vi.fn(),
    setCollider: vi.fn(), removeCollider: vi.fn(), onPointerDown: vi.fn(), removePointerEvents: vi.fn(),
  }
  const storage = VirviStorageImpl.create()
  const events = new EventBus()
  const sm = new SceneManager(adapter, storage, events)
  sm.custom.setAll(all)
  const log: string[] = []
  for (const e of ['element_create', 'element_update', 'element_delete']) {
    events.on(e, (type: string, el: any, inst?: any) => log.push(`${e.replace('element_', '')} ${type} ${el.sk}${inst ? `/${inst.sk}` : ''}`))
  }
  const changes: any[] = []
  events.on('storage_change', (c: any) => changes.push(c))
  return { sm, adapter, storage, log, changes }
}

const inst = (sk: string, extra: Record<string, unknown> = {}) => ({ sk, enabled: true, position: { x: 1, y: 1, z: 1 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, ...extra })
const image = (sk: string, extra: Record<string, unknown> = {}, instances = [inst(`${sk}-i1`)]) => ({ sk, name: sk, enabled: true, imageSrc: 'https://x/a.png', instances, ...extra })

describe('custom rendering', () => {
  it('a flagged element is handed over whole: events, storage, and Virvi draws nothing for it', () => {
    const { sm, adapter, storage, log, changes } = setup()
    sm.handlePresetUpdate({ action: 'init', scenePreset: { images: [image('mine', { customRendering: true, customId: 'poster' }), image('virvis')] } })
    expect(log).toEqual(['create image mine', 'create image mine/mine-i1'])
    expect(storage.images.configs['poster']).toMatchObject({ sk: 'mine' })
    expect(storage.images.configs['virvis']).toBeTruthy()
    expect(adapter.createEntity).toHaveBeenCalledTimes(1) // only Virvi's own image
    expect(changes.at(-1)).toMatchObject({ action: 'init' })

    // A snapshot that moves the copy and adds one: update + create; removing one: delete
    sm.handlePresetUpdate({ action: 'upsert', element: 'image', elementData: image('mine', { customRendering: true, customId: 'poster' }, [inst('mine-i1', { position: { x: 5, y: 1, z: 1 } }), inst('mine-i2')]) })
    sm.handlePresetUpdate({ action: 'upsert', element: 'image', elementData: image('mine', { customRendering: true, customId: 'poster' }, [inst('mine-i2')]) })
    expect(log.slice(2)).toEqual(['update image mine/mine-i1', 'create image mine/mine-i2', 'delete image mine/mine-i1'])
    expect(changes.at(-1)).toMatchObject({ action: 'upsert', type: 'image', id: 'mine' })

    // HUD property updates on its copy
    sm.handlePresetUpdate({ action: 'update', element: 'image', instance: true, id: 'mine-i2', property: 'scale', value: { x: 2, y: 2, z: 2 } })
    expect(log.at(-1)).toBe('update image mine/mine-i2')
    sm.handlePresetUpdate({ action: 'delete', element: 'image', id: 'mine' })
    expect(log.slice(-2)).toEqual(['delete image mine/mine-i2', 'delete image mine'])
    expect(storage.images.configs['poster']).toBeUndefined()
    expect(adapter.createEntity).toHaveBeenCalledTimes(1)
  })

  it('turning the flag on hands it over; turning it off gives it back to Virvi', () => {
    const { sm, adapter, log } = setup()
    sm.handlePresetUpdate({ action: 'init', scenePreset: { images: [image('a')] } })
    expect(adapter.createEntity).toHaveBeenCalledTimes(1)
    sm.handlePresetUpdate({ action: 'upsert', element: 'image', elementData: image('a', { customRendering: true }) })
    expect(adapter.destroyEntity).toHaveBeenCalled()
    expect(log).toEqual(['create image a', 'create image a/a-i1'])
    sm.handlePresetUpdate({ action: 'upsert', element: 'image', elementData: image('a', { customRendering: false }) })
    expect(log.slice(2)).toEqual(['delete image a/a-i1', 'delete image a'])
    expect(adapter.createEntity).toHaveBeenCalledTimes(2)
  })

  it('a single flagged copy is handed over while Virvi draws the others', () => {
    const { sm, adapter, log } = setup()
    sm.handlePresetUpdate({ action: 'init', scenePreset: { images: [image('a', {}, [inst('a1'), inst('a2', { customRendering: true })])] } })
    expect(log).toEqual(['create image a/a2'])
    expect(adapter.createEntity).toHaveBeenCalledTimes(1)
    sm.handlePresetUpdate({ action: 'upsert', element: 'image', elementData: image('a', {}, [inst('a1'), inst('a2')]) })
    expect(log.at(-1)).toBe('delete image a/a2')
  })

  it('createVirvi({ customRendering: true }) hands over every drawn type, but not widgets', () => {
    const { sm, adapter, log } = setup(true)
    sm.handlePresetUpdate({ action: 'init', scenePreset: {
      images: [image('i')],
      models: [{ sk: 'm', enabled: true, modelSrc: 'a.glb', instances: [] }],
      sounds: [{ sk: 's', enabled: true, audioSrc: 'a.mp3', instances: [] }],
      videos: [{ sk: 'v', enabled: true, instances: [] }],
      widgets: [{ sk: 'w', name: 'W', enabled: true, controlType: 1, value: true }],
    } })
    expect(log).toEqual(['create image i', 'create image i/i-i1', 'create video v', 'create model m', 'create sound s'])
    expect(adapter.createEntity).not.toHaveBeenCalled()
    expect(sm.widgets.value('W')).toBe(true)
    // A preset switch removes them all
    sm.handlePresetChange({ scenePreset: { images: [] } })
    expect(log.slice(-5).every((l) => l.startsWith('delete'))).toBe(true)
  })
})

import { Virvi } from '../src/Virvi.js'

describe('custom rendering through Virvi', () => {
  it('the customRendering option and onElementCreate/Update/Delete/onStorageChange', async () => {
    const adapter: any = { capabilities: { platformName: 'test' }, createEntity: vi.fn(), registerSystem: vi.fn(), unregisterSystem: vi.fn(), entityExists: () => false }
    const v = new Virvi(adapter)
    await v.authenticate({ customRendering: true, apiUrl: 'http://127.0.0.1:1' } as any).catch(() => {})
    const created: unknown[] = [], updated: unknown[] = [], deleted: unknown[] = [], changes: unknown[] = []
    v.onElementCreate((type, el, i) => created.push([type, el.sk, i?.sk]))
    v.onElementUpdate((type, el) => updated.push([type, el.sk]))
    const off = v.onElementDelete((type, el, i) => deleted.push([type, el.sk, i?.sk]))
    v.onStorageChange((c) => changes.push(c.action))
    const sm = (v as any).sceneManager
    sm.handlePresetUpdate({ action: 'init', scenePreset: { images: [{ sk: 'a', enabled: true, instances: [] }] } })
    sm.handlePresetUpdate({ action: 'update', element: 'image', id: 'a', property: 'name', value: 'Poster' })
    off()
    sm.handlePresetUpdate({ action: 'delete', element: 'image', id: 'a' })
    expect(created).toEqual([['image', 'a', undefined]])
    expect(updated).toEqual([['image', 'a']])
    expect(deleted).toEqual([])
    expect(changes).toEqual(['init', 'update', 'delete'])
    expect(adapter.createEntity).not.toHaveBeenCalled()
  })
})
