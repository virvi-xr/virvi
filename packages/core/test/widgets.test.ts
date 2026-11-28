import { describe, it, expect, vi } from 'vitest'
import { WidgetControlType } from '@virvixr/shared'
import { SceneManager } from '../src/SceneManager.js'
import { VirviStorageImpl } from '../src/storage.js'
import { EventBus } from '../src/events/EventBus.js'
import { Virvi } from '../src/Virvi.js'

/** LIV-158: widgets reach scene code: storage, onWidgetChange, onWidgetClick, and the widgets option. */
const adapter: any = { capabilities: { platformName: 'test' }, createEntity: vi.fn(), destroyEntity: vi.fn(), entityExists: () => false }
const widget = (sk: string, over: Record<string, unknown> = {}) => ({ sk, name: 'Stage lights', customId: 'lights', enabled: true, controlType: WidgetControlType.TOGGLE, value: false, ...over })

function setup() {
  const storage = VirviStorageImpl.create()
  const events = new EventBus()
  const sm = new SceneManager(adapter, storage, events)
  return { storage, events, sm }
}

describe('widgets', () => {
  it('fills storage from the preset and follows live updates', () => {
    const { storage, sm, events } = setup()
    const seen: unknown[] = []
    events.on('widget_change', (_w: unknown, v: unknown) => seen.push(v))
    sm.handlePresetUpdate({ action: 'init', scenePreset: { widgets: [widget('w1'), widget('w2', { name: 'Hidden', customId: null, enabled: false })] } })
    expect(Object.keys(storage.widgets.configs)).toEqual(['w1'])
    expect(sm.widgets.value('lights')).toBe(false)
    // The dashboard turns it on (full snapshot), then the HUD sends a property update
    sm.handlePresetUpdate({ action: 'upsert', element: 'widget', elementData: widget('w1', { value: true }) })
    sm.handlePresetUpdate({ action: 'update', element: 'widget', id: 'w1', property: 'value', value: false })
    expect(seen).toEqual([false, true, false])
    // An unchanged value is not news
    sm.handlePresetUpdate({ action: 'upsert', element: 'widget', elementData: widget('w1', { value: false }) })
    expect(seen).toHaveLength(3)
    // Deleted: storage drops it and listeners hear undefined
    sm.handlePresetUpdate({ action: 'delete', element: 'widget', elementData: { sk: 'w1' } })
    expect(storage.widgets.configs).toEqual({})
    expect(seen.at(-1)).toBeUndefined()
  })

  it('reads nested properties as the dashboard stores them', () => {
    const { sm } = setup()
    sm.handlePresetUpdate({ action: 'init', scenePreset: { widgets: [{ sk: 'w9', name: 'Volume', properties: { controlType: WidgetControlType.SLIDER, value: 0.4 } }] } })
    expect(sm.widgets.find('Volume')).toMatchObject({ id: 'w9', type: WidgetControlType.SLIDER, value: 0.4 })
  })

  it("a Selector's options come with it, from the new shape or an old comma list", () => {
    const { sm } = setup()
    sm.handlePresetUpdate({ action: 'init', scenePreset: { widgets: [
      { sk: 'a', name: 'Film', properties: { controlType: WidgetControlType.SELECTOR, options: ['One', 'Two'], value: 'Two' } },
      { sk: 'b', name: 'Old', properties: { controlType: WidgetControlType.SELECTOR, value: 'x, y' } },
      { sk: 'c', name: 'Lights', properties: { controlType: WidgetControlType.TOGGLE, value: true } },
    ] } })
    expect(sm.widgets.find('Film')).toMatchObject({ options: ['One', 'Two'], value: 'Two' })
    expect(sm.widgets.find('Old')!.options).toEqual(['x', 'y'])
    expect(sm.widgets.find('Lights')!.options).toEqual([])
  })

  it('a Trigger fires onWidgetClick when pressed, not when it first loads', () => {
    const { sm, events } = setup()
    const clicks: string[] = []
    events.on('widget_click', (w: any) => clicks.push(w.id))
    sm.handlePresetUpdate({ action: 'init', scenePreset: { widgets: [widget('t1', { name: 'Fireworks', customId: 'fw', controlType: WidgetControlType.TRIGGER, value: 0 })] } })
    expect(clicks).toEqual([])
    sm.handlePresetUpdate({ action: 'update', element: 'widget', id: 't1', property: 'value', value: 1 })
    sm.handlePresetUpdate({ action: 'upsert', element: 'widget', elementData: widget('t1', { name: 'Fireworks', customId: 'fw', controlType: WidgetControlType.TRIGGER, value: 2 }) })
    expect(clicks).toEqual(['t1', 't1'])
  })

  it("the widgets option's handlers and defaults, and the Virvi API by custom id, name or id", async () => {
    const v = new Virvi(adapter)
    const init = vi.fn(), update = vi.fn(), del = vi.fn()
    // authenticate() takes the option first; stop it before it reaches the network
    await v.authenticate({ widgets: [{ id: 'lights', value: true, init, update, delete: del }, { id: 'missing', value: 'default' }], apiUrl: 'http://127.0.0.1:1' } as any).catch(() => {})
    expect(v.getWidgetValue('missing')).toBe('default')
    expect(v.getWidgetValue('lights')).toBe(true) // its default until the scene has it
    const byName: unknown[] = []
    const off = v.onWidgetChange('Stage lights', (value) => byName.push(value))
    const sm = (v as any).sceneManager as SceneManager
    sm.handlePresetUpdate({ action: 'init', scenePreset: { widgets: [widget('w1')] } })
    expect(init).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith(false)
    expect(v.getWidgetValue('lights')).toBe(false)
    expect(v.listWidgets().map((w) => w.customId)).toEqual(['lights'])
    sm.handlePresetUpdate({ action: 'update', element: 'widget', id: 'w1', property: 'value', value: true })
    off()
    sm.handlePresetUpdate({ action: 'update', element: 'widget', id: 'w1', property: 'value', value: false })
    expect(byName).toEqual([false, true])
    const any: unknown[] = []
    v.onWidgetChange('*', (value, w) => any.push([w.id, value]))
    sm.handlePresetUpdate({ action: 'update', element: 'widget', id: 'w1', property: 'value', value: true })
    expect(any).toEqual([['w1', true]])
    sm.handlePresetChange({ scenePreset: { widgets: [] } })
    expect(del).toHaveBeenCalledTimes(1)
  })
})
