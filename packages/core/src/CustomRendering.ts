import type { VirviStorage } from '@virvixr/shared'
import type { EventBus } from './events/EventBus.js'

/**
 * Custom rendering (LIV-158): scene code draws an element (or one placed copy) itself instead of Virvi.
 *
 * Handed over: an element of a drawn type (image, video, model, sound) whose `customRendering` is true, or every one of
 * them with `createVirvi({ customRendering: true })`; and a single instance whose own `customRendering` is true inside
 * an element Virvi still draws. Virvi keeps their data current in `storage` and calls the scene's code instead:
 * `element_create`, `element_update` and `element_delete` events on the bus, each (type, element, instance?).
 */
export const DRAWN_TYPES = ['image', 'video', 'model', 'sound'] as const
export type DrawnType = (typeof DRAWN_TYPES)[number]
const BUCKET: Record<DrawnType, keyof VirviStorage> = { image: 'images', video: 'videos', model: 'models', sound: 'sounds' }

type Data = Record<string, any>
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const isDrawn = (t: string): t is DrawnType => (DRAWN_TYPES as readonly string[]).includes(t)

export class CustomRenderer {
  private all = false
  /** Elements handed over whole, by sk: their latest full data (with instances). */
  private elements = new Map<string, { type: DrawnType; data: Data }>()
  /** Single instances handed over inside a Virvi-drawn element, by instance sk. */
  private instances = new Map<string, { type: DrawnType; element: Data; data: Data }>()

  constructor(private storage: VirviStorage, private events: EventBus) {}

  setAll(on: boolean): void { this.all = on }
  get everything(): boolean { return this.all }

  /** Whether element data of this type belongs to scene code. */
  wantsElement(type: string, data: Data | undefined): boolean {
    return isDrawn(type) && !!data && (this.all || data.customRendering === true)
  }
  hasElement(sk: string): boolean { return this.elements.has(sk) }
  hasInstance(sk: string): boolean {
    if (this.instances.has(sk)) return true
    for (const e of this.elements.values()) if ((e.data.instances ?? []).some((i: Data) => i.sk === sk)) return true
    return false
  }

  private emit(event: 'element_create' | 'element_update' | 'element_delete', type: DrawnType, element: Data, instance?: Data): void {
    this.events.emit(event, type, element, instance)
  }
  /** Keyed like Virvi's own managers: custom id, else element id. */
  private putStorage(type: DrawnType, data: Data, prev?: Data): void {
    const configs = (this.storage[BUCKET[type]] as any).configs
    if (prev && (prev.customId || prev.sk) !== (data.customId || data.sk)) delete configs[prev.customId || prev.sk]
    configs[data.customId || data.sk] = data
  }
  private dropStorage(type: DrawnType, data: Data): void {
    delete (this.storage[BUCKET[type]] as any).configs[data.customId || data.sk]
  }

  // ── Whole elements ──
  createElement(type: DrawnType, data: Data): void {
    if (data.enabled === false) return
    this.elements.set(data.sk, { type, data })
    this.putStorage(type, data)
    this.emit('element_create', type, data)
    for (const inst of data.instances ?? []) if (inst.enabled !== false) this.emit('element_create', type, data, inst)
  }

  /** A full snapshot of a handed-over element: reports what changed. */
  replaceElement(type: DrawnType, data: Data): void {
    const prev = this.elements.get(data.sk)
    if (!prev) return this.createElement(type, data)
    if (data.enabled === false) { this.deleteElement(data.sk); return }
    this.elements.set(data.sk, { type, data })
    this.putStorage(type, data, prev.data)
    const { instances: a, ...prevEl } = prev.data
    const { instances: b, ...nextEl } = data
    if (!same(prevEl, nextEl)) this.emit('element_update', type, data)
    const before = new Map<string, Data>((a ?? []).filter((i: Data) => i.enabled !== false).map((i: Data) => [i.sk, i]))
    const after = new Map<string, Data>((b ?? []).filter((i: Data) => i.enabled !== false).map((i: Data) => [i.sk, i]))
    for (const [sk, i] of before) if (!after.has(sk)) this.emit('element_delete', type, data, i)
    for (const [sk, i] of after) {
      const old = before.get(sk)
      if (!old) this.emit('element_create', type, data, i)
      else if (!same(old, i)) this.emit('element_update', type, data, i)
    }
  }

  /** A partial change (HUD property updates): merged into what we have. */
  patchElement(sk: string, patch: Data): void {
    const e = this.elements.get(sk)
    if (!e) return
    this.replaceElement(e.type, { ...e.data, ...patch, instances: patch.instances ?? e.data.instances })
  }

  deleteElement(sk: string): Data | null {
    const e = this.elements.get(sk)
    if (!e) return null
    this.elements.delete(sk)
    this.dropStorage(e.type, e.data)
    for (const inst of e.data.instances ?? []) if (inst.enabled !== false) this.emit('element_delete', e.type, e.data, inst)
    this.emit('element_delete', e.type, e.data)
    return e.data
  }

  // ── Instances of handed-over elements, and single handed-over instances ──
  /** Returns true when scene code took the instance. */
  createInstance(type: string, element: Data | undefined, inst: Data): boolean {
    if (!isDrawn(type) || !inst?.sk) return false
    const owner = element?.sk ? this.elements.get(element.sk) : undefined
    if (owner) {
      this.replaceElement(owner.type, { ...owner.data, instances: [...(owner.data.instances ?? []).filter((i: Data) => i.sk !== inst.sk), inst] })
      return true
    }
    if (inst.customRendering === true && element) {
      this.instances.set(inst.sk, { type, element, data: inst })
      if (inst.enabled !== false) this.emit('element_create', type, element, inst)
      return true
    }
    return false
  }

  /** Returns true when the instance is scene code's. */
  patchInstance(sk: string, patch: Data): boolean {
    for (const e of this.elements.values()) {
      const list: Data[] = e.data.instances ?? []
      const i = list.findIndex((x) => x.sk === sk)
      if (i < 0) continue
      const next = [...list]
      next[i] = { ...list[i], ...patch }
      this.replaceElement(e.type, { ...e.data, instances: next })
      return true
    }
    const single = this.instances.get(sk)
    if (!single) return false
    const data = { ...single.data, ...patch }
    this.instances.set(sk, { ...single, data })
    if (data.enabled === false) this.emit('element_delete', single.type, single.element, data)
    else if (single.data.enabled === false) this.emit('element_create', single.type, single.element, data)
    else this.emit('element_update', single.type, single.element, data)
    return true
  }

  deleteInstance(sk: string): boolean {
    for (const e of this.elements.values()) {
      if (!(e.data.instances ?? []).some((x: Data) => x.sk === sk)) continue
      this.replaceElement(e.type, { ...e.data, instances: e.data.instances.filter((x: Data) => x.sk !== sk) })
      return true
    }
    const single = this.instances.get(sk)
    if (!single) return false
    this.instances.delete(sk)
    if (single.data.enabled !== false) this.emit('element_delete', single.type, single.element, single.data)
    return true
  }

  /**
   * For an element Virvi draws: hands its flagged instances to scene code and returns the element without them.
   * Forgets this element's earlier single instances that are no longer flagged (Virvi draws them again).
   */
  splitInstances(type: string, data: Data): Data {
    if (!isDrawn(type) || !data?.sk) return data
    const flagged = (data.instances ?? []).filter((i: Data) => i.customRendering === true)
    const keep = new Set(flagged.map((i: Data) => i.sk))
    for (const [sk, s] of [...this.instances]) {
      if (s.element.sk === data.sk && !keep.has(sk)) {
        this.instances.delete(sk)
        if (s.data.enabled !== false) this.emit('element_delete', s.type, s.element, s.data)
      }
    }
    if (!flagged.length) return data
    const { instances: _i, ...element } = data
    for (const inst of flagged) {
      const prev = this.instances.get(inst.sk)
      this.instances.set(inst.sk, { type, element, data: inst })
      if (inst.enabled === false) { if (prev && prev.data.enabled !== false) this.emit('element_delete', type, element, inst); continue }
      if (!prev || prev.data.enabled === false) this.emit('element_create', type, element, inst)
      else if (!same(prev.data, inst) || !same(prev.element, element)) this.emit('element_update', type, element, inst)
    }
    return { ...data, instances: (data.instances ?? []).filter((i: Data) => i.customRendering !== true) }
  }

  /** Every single instance of element `sk` goes (the element was deleted or handed over whole). */
  dropInstancesOf(sk: string): void {
    for (const [isk, s] of [...this.instances]) {
      if (s.element.sk !== sk) continue
      this.instances.delete(isk)
      if (s.data.enabled !== false) this.emit('element_delete', s.type, s.element, s.data)
    }
  }

  /** A whole preset arrives: hand over what's flagged and report what left; returns the rest for Virvi to draw. */
  initPreset(preset: Data): Data {
    const next = new Set<string>()
    const out: Data = { ...preset }
    for (const type of DRAWN_TYPES) {
      const key = BUCKET[type]
      const list: Data[] = preset[key] ?? []
      const drawn: Data[] = []
      for (const el of list) {
        if (!el?.sk) continue
        if (this.wantsElement(type, el)) {
          next.add(el.sk)
          this.dropInstancesOf(el.sk)
          this.replaceElement(type, el)
        } else {
          if (this.elements.has(el.sk)) this.deleteElement(el.sk)
          drawn.push(this.splitInstances(type, el))
        }
      }
      out[key] = drawn
    }
    for (const sk of [...this.elements.keys()]) if (!next.has(sk)) this.deleteElement(sk)
    const present = new Set(DRAWN_TYPES.flatMap((t) => (preset[BUCKET[t]] ?? []).map((e: Data) => e?.sk)))
    for (const [isk, s] of [...this.instances]) if (!present.has(s.element.sk)) this.dropInstancesOf(s.element.sk)
    return out
  }

  clear(): void {
    for (const sk of [...this.elements.keys()]) this.deleteElement(sk)
    for (const s of [...this.instances.values()]) this.dropInstancesOf(s.element.sk)
  }
}
