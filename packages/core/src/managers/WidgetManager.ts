import { WidgetControlType, type VirviStorage, type WidgetConfig, type TransformData } from '@virvixr/shared'
import type { ListedInstance } from './transform-ops.js'
import type { EventBus } from '../events/EventBus.js'

/**
 * Widgets (LIV-158): the scene's custom controls (toggle, text, selector, date and time, trigger, slider), set on the
 * dashboard or the HUD. Virvi draws nothing for them; scene code reads them and reacts. `storage.widgets.configs`
 * holds each one by its id (sk). Scene code names a widget by its custom id, its name, or its id.
 *
 * Events on the bus: `widget_change` (widget, value, previous) for every value change, including a widget appearing
 * or disappearing (value undefined), and `widget_click` (widget) when a Trigger fires.
 */
export interface WidgetState {
  /** The element id. */
  id: string
  customId: string | null
  name: string
  type: WidgetControlType
  value: unknown
  enabled: boolean
}

type Raw = Record<string, unknown>

const stateOf = (raw: Raw): WidgetState | null => {
  const id = typeof raw.sk === 'string' ? raw.sk : typeof raw.id === 'string' ? raw.id : null
  if (!id) return null
  const props = raw.properties && typeof raw.properties === 'object' ? (raw.properties as Raw) : {}
  const pick = (k: string) => (raw[k] !== undefined ? raw[k] : props[k])
  const type = Number(pick('controlType'))
  return {
    id,
    customId: typeof raw.customId === 'string' && raw.customId ? raw.customId : null,
    name: typeof raw.name === 'string' ? raw.name : '',
    type: Number.isInteger(type) && type >= 0 && type <= 6 ? (type as WidgetControlType) : WidgetControlType.NONE,
    value: pick('value'),
    enabled: raw.enabled !== false,
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export class WidgetManager {
  private widgets = new Map<string, WidgetState>()
  /** The scene code's `widgets` from createVirvi / init, by the id it names. */
  private defs = new Map<string, WidgetConfig>()
  private started = new Set<string>()

  constructor(private storage: VirviStorage, private events: EventBus) {}

  /** The `widgets` init option: per-widget init/update/delete handlers, and a default value until the widget exists. */
  define(defs: WidgetConfig[] | undefined): void {
    for (const d of defs ?? []) if (d && typeof d.id === 'string') this.defs.set(d.id, d)
  }

  /** The widget named `key` (custom id, then name, then id), or undefined. */
  find(key: string): WidgetState | undefined {
    const all = [...this.widgets.values()]
    return all.find((w) => w.customId === key) ?? all.find((w) => w.name === key) ?? this.widgets.get(key)
  }

  /** The current value of `key`, or the init option's default while the widget isn't in the scene. */
  value(key: string): unknown {
    const w = this.find(key)
    return w ? w.value : this.defs.get(key)?.value
  }

  list(): WidgetState[] {
    return [...this.widgets.values()]
  }

  /** Whether a listener for `key` should hear about widget `w`. */
  static matches(w: WidgetState, key: string): boolean {
    return key === '*' || w.customId === key || w.name === key || w.id === key
  }

  private defOf(w: WidgetState): WidgetConfig | undefined {
    return (w.customId ? this.defs.get(w.customId) : undefined) ?? this.defs.get(w.name) ?? this.defs.get(w.id)
  }

  private store(w: WidgetState): void {
    this.widgets.set(w.id, w)
    this.storage.widgets.configs[w.id] = { ...w } as never
  }

  private set(next: WidgetState, fromUpdate: boolean): void {
    const prev = this.widgets.get(next.id)
    this.store(next)
    const def = this.defOf(next)
    if (!this.started.has(next.id)) {
      this.started.add(next.id)
      try { def?.init?.() } catch { /* scene code */ }
    }
    if (!prev || !same(prev.value, next.value)) {
      try { def?.update?.(next.value) } catch { /* scene code */ }
      this.events.emit('widget_change', next, next.value, prev?.value)
    }
    // A Trigger fires when it's pressed: an update to its value (the HUD and dashboard bump it)
    if (fromUpdate && prev && next.type === WidgetControlType.TRIGGER && !same(prev.value, next.value)) this.events.emit('widget_click', next)
  }

  private remove(id: string): void {
    const prev = this.widgets.get(id)
    if (!prev) return
    this.widgets.delete(id)
    this.started.delete(id)
    delete this.storage.widgets.configs[id]
    try { this.defOf(prev)?.delete?.() } catch { /* scene code */ }
    this.events.emit('widget_change', prev, undefined, prev.value)
  }

  // ── ElementManager ──
  init(elements: Raw[]): void {
    const keep = new Set<string>()
    for (const raw of elements ?? []) {
      const w = stateOf(raw)
      if (!w || !w.enabled) continue
      keep.add(w.id)
      this.set(w, false)
    }
    for (const id of [...this.widgets.keys()]) if (!keep.has(id)) this.remove(id)
  }
  create(raw: Raw): void { const w = stateOf(raw); if (w && w.enabled) this.set(w, false) }
  upsert(raw: Raw): void {
    const w = stateOf(raw)
    if (!w) return
    if (!w.enabled) return this.remove(w.id)
    this.set(w, this.widgets.has(w.id))
  }
  updateElement(raw: Raw): void {
    const w = stateOf(raw)
    if (!w) return
    const prev = this.widgets.get(w.id)
    if (!w.enabled) return this.remove(w.id)
    // A partial update keeps what it doesn't carry
    const merged: WidgetState = prev ? {
      ...prev,
      ...(raw.name !== undefined ? { name: w.name } : {}),
      ...(raw.customId !== undefined ? { customId: w.customId } : {}),
      ...(w.value !== undefined ? { value: w.value } : {}),
      ...(((raw as Raw).controlType ?? ((raw.properties ?? {}) as Raw).controlType) !== undefined ? { type: w.type } : {}),
    } : w
    this.set(merged, !!prev)
  }
  update(elementId: string, property: string, value: unknown): void {
    const prev = this.widgets.get(elementId)
    if (!prev) return
    if (property === 'enabled' && value === false) return this.remove(elementId)
    if (property === 'value') this.set({ ...prev, value }, true)
    else if (property === 'name' && typeof value === 'string') this.set({ ...prev, name: value }, true)
  }
  delete(elementId: string): void { this.remove(elementId) }
  clear(): void { for (const id of [...this.widgets.keys()]) this.remove(id) }
  // Widgets have no copies or entities
  createInstance(): void {}
  updateInstance(): void {}
  updateInstanceData(): void {}
  deleteInstance(): void {}
  listInstances(): ListedInstance[] { return [] }
  previewTransform(_sk: string, _t: TransformData): void {}
  restoreTransform(_sk: string): void {}
}
