import { kioskItemsOf, kioskSettings } from '@virvixr/shared'
import type { VirviPlatformAdapter, VirviStorage, EntityHandle, TransformData, KioskItem, KioskSettings } from '@virvixr/shared'
import type { ListedInstance } from './transform-ops.js'
import type { EventBus } from '../events/EventBus.js'
import { itemName } from './naming.js'
import { roomFor } from './frame.js'
import { KIOSK_SPIN_DEG_PER_S, kioskParts, partLookKey, placePart, type KioskPart } from '../kiosk/layout.js'

/** Every scene runtime (Decentraland, Hyperfy, Node) has a console; core's lib setting doesn't declare one. */
declare const console: { log(...args: unknown[]): void }

/** What a kiosk click tells the scene: which kiosk, and the giveaway it is for (null when none is picked). */
export interface KioskClick { elementId: string; instanceId: string; giveawayId: string | null }

interface KioskConfig {
  sk: string
  name: string
  customId?: string
  settings: KioskSettings
  items: KioskItem[]
}

interface KioskInstance {
  sk: string
  customId?: string
  configSk: string
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number }
  scale: { x: number; y: number; z: number }
  /** One entity per drawn part, in the order of `parts`. */
  entities: (EntityHandle | null)[]
  parts: KioskPart[]
  /** How the parts look; when it changes they are made again. */
  look: string
}

const stored = (i: KioskInstance): TransformData => ({ position: i.position, rotation: i.rotation, scale: i.scale })

/**
 * Giveaway kiosks (scene elements of type `claim_point`, the preset's `claimPoints`): draws each copy from
 * kiosk/layout.ts and reports clicks on the event bus (`kiosk_click`, a KioskClick) for the platform's giveaway card.
 * `kiosks_changed` carries how many kiosk copies the scene shows, whenever that changes. Parts the platform can't draw
 * are left out: boxes need `setSolidShape`, the label `setText`, a mannequin `setAvatarShape`, and a model the platform
 * can't load (resolveModelSrc null) shows nothing. Not editable in-world (the dashboard places kiosks).
 */
export class KioskManager {
  private configs = new Map<string, KioskConfig>()
  private instances = new Map<string, KioskInstance>()
  private spinDeg = 0
  private spinSystem: ((dt: number) => void) | null = null
  private shown = 0
  private toldLimit = false

  constructor(private adapter: VirviPlatformAdapter, private storage: VirviStorage, private events?: EventBus) {}

  init(elements: any[]): void {
    for (const element of elements) {
      if (!element.enabled) continue
      this.createConfig(element)
      for (const instance of element.instances || []) {
        if (instance.enabled === false) continue
        this.createInstanceEntity(element.sk, instance)
      }
    }
    this.changed()
  }

  private createConfig(data: any): void {
    const config: KioskConfig = {
      sk: data.sk, name: data.name || '', customId: data.customId, settings: kioskSettings(data), items: kioskItemsOf(data),
    }
    this.configs.set(config.sk, config)
    this.storage.claimPoints.configs[config.customId || config.sk] = data
  }

  private createInstanceEntity(configSk: string, data: any): void {
    const config = this.configs.get(configSk)
    if (!config || !data?.sk) return
    const instance: KioskInstance = {
      sk: data.sk,
      customId: data.customId,
      configSk,
      position: data.position || { x: 0, y: 0, z: 0 },
      rotation: data.rotation || { x: 0, y: 0, z: 0 },
      scale: data.scale || { x: 1, y: 1, z: 1 },
      entities: [],
      parts: [],
      look: '',
    }
    this.instances.set(instance.sk, instance)
    this.storage.claimPoints.instances[data.customId || data.sk] = data
    this.draw(instance)
  }

  /** Make (or move) the copy's entities for its config's current look. */
  private draw(instance: KioskInstance): void {
    const config = this.configs.get(instance.configSk)
    if (!config) return
    const parts = kioskParts(config.settings, config.items)
    const look = parts.map(partLookKey).join('|')
    if (look !== instance.look) {
      this.disposeEntities(instance)
      instance.look = look
      instance.parts = parts
      if (parts.length && !roomFor(this.adapter, parts.length)) {
        if (!this.toldLimit) {
          this.toldLimit = true
          console.log("[Virvi] A giveaway kiosk isn't shown: the scene is at Decentraland's entity limit for its parcels")
        }
        instance.entities = parts.map(() => null)
      } else {
        instance.entities = parts.map((p) => this.makePart(p, config, instance))
      }
    } else {
      instance.parts = parts
    }
    this.place(instance)
    this.watchSpin()
  }

  /** The item's turn: the shared spin angle while the kiosk spins, else none. */
  private spinOf(instance: KioskInstance): number {
    return this.configs.get(instance.configSk)?.settings.enableSpin ? this.spinDeg : 0
  }

  private place(instance: KioskInstance): void {
    const at = stored(instance)
    const spin = this.spinOf(instance)
    instance.parts.forEach((p, i) => {
      const e = instance.entities[i]
      if (e !== null && e !== undefined) this.adapter.setTransform(e, placePart(p, at, spin))
    })
  }

  /** One part's entity, or null when the platform can't draw it. */
  private makePart(p: KioskPart, config: KioskConfig, instance: KioskInstance): EntityHandle | null {
    const a = this.adapter
    let src: string | null = null
    switch (p.kind) {
      case 'box': if (!a.setSolidShape) return null; break
      case 'text': if (!a.setText) return null; break
      case 'mannequin': if (!a.setAvatarShape) return null; break
      case 'model':
        src = a.resolveModelSrc ? a.resolveModelSrc(p.src) : p.src
        if (src === null) return null
        break
    }
    const e = a.createEntity()
    a.setTransform(e, placePart(p, stored(instance), this.spinOf(instance)))
    switch (p.kind) {
      case 'box':
        a.setSolidShape!(e, 'box', { r: p.color.r, g: p.color.g, b: p.color.b })
        break
      case 'image':
        a.setPlaneRenderer(e)
        a.setMaterial(e, { textureSrc: p.src, isTransparent: true, emission: 0.6 })
        break
      case 'text':
        a.setText!(e, p.text, { fontSize: p.fontSize })
        break
      case 'model':
        // Clicks land on the model's own meshes
        if (p.click) a.setCollider(e, { type: 'mesh', isTrigger: true })
        a.setGltfModel(e, src!)
        break
      case 'mannequin':
        a.setAvatarShape!(e, { bodyShape: p.bodyShape, wearables: p.wearables })
        break
      case 'hit':
        break
    }
    if (p.click) {
      if (p.kind !== 'model') a.setCollider(e, { type: 'box', isTrigger: true })
      a.setName?.(e, itemName(config.name, undefined, 'Giveaway kiosk'))
      // The giveaway as it is when clicked (picking another one doesn't remake the parts)
      a.onPointerDown(e, { hoverText: config.settings.hoverText, showFeedback: true }, () => {
        const click: KioskClick = { elementId: config.sk, instanceId: instance.sk, giveawayId: this.configs.get(config.sk)?.settings.giveawayId ?? null }
        this.events?.emit('kiosk_click', click)
      })
    }
    return e
  }

  private disposeEntities(instance: KioskInstance): void {
    for (const e of instance.entities) if (e !== null && e !== undefined) this.adapter.destroyEntity(e)
    instance.entities = []
    instance.parts = []
    instance.look = ''
  }

  /** A frame system turns spinning items while any copy has one; it goes when none does. */
  private watchSpin(): void {
    const spinning = [...this.instances.values()].some((i) => i.parts.some((p) => p.spins) && this.configs.get(i.configSk)?.settings.enableSpin)
    if (spinning && !this.spinSystem) {
      this.spinSystem = (dt: number) => {
        this.spinDeg = (this.spinDeg + KIOSK_SPIN_DEG_PER_S * dt) % 360
        for (const i of this.instances.values()) {
          if (!this.configs.get(i.configSk)?.settings.enableSpin) continue
          const at = stored(i)
          i.parts.forEach((p, n) => {
            const e = i.entities[n]
            if (p.spins && e !== null && e !== undefined) this.adapter.setTransform(e, placePart(p, at, this.spinDeg))
          })
        }
      }
      this.adapter.registerSystem(this.spinSystem)
    } else if (!spinning && this.spinSystem) {
      this.adapter.unregisterSystem(this.spinSystem)
      this.spinSystem = null
    }
  }

  private changed(): void {
    if (this.instances.size === this.shown) return
    this.shown = this.instances.size
    this.events?.emit('kiosks_changed', this.shown)
  }

  /** How many kiosk copies the scene shows. */
  count(): number { return this.instances.size }

  // CRUD, as the other managers

  create(elementData: any): void {
    if (!elementData?.sk) return
    this.createConfig(elementData)
    for (const inst of elementData.instances || []) if (inst.enabled !== false) this.createInstanceEntity(elementData.sk, inst)
    this.changed()
  }

  createInstance(elementData: any, instanceData: any): void {
    const configSk = elementData?.sk || instanceData?.elementId
    if (instanceData?.enabled === false) return
    this.createInstanceEntity(configSk, instanceData)
    this.changed()
  }

  updateElement(elementData: any): void {
    const config = this.configs.get(elementData?.sk)
    if (!config) return
    const key = config.customId || config.sk
    const merged = { ...this.storage.claimPoints.configs[key], ...elementData }
    this.storage.claimPoints.configs[key] = merged
    if (elementData.name !== undefined) config.name = elementData.name || ''
    config.settings = kioskSettings(merged)
    config.items = kioskItemsOf(merged)
    for (const i of this.instances.values()) if (i.configSk === config.sk) this.draw(i)
  }

  update(elementId: string, property: string, value: unknown): void {
    this.updateElement({ sk: elementId, [property]: value })
  }

  updateInstanceData(instanceData: any): void {
    const instance = this.instances.get(instanceData?.sk)
    if (!instance) return
    if (instanceData.position) instance.position = instanceData.position
    if (instanceData.rotation) instance.rotation = instanceData.rotation
    if (instanceData.scale) instance.scale = instanceData.scale
    const key = instance.customId || instance.sk
    this.storage.claimPoints.instances[key] = { ...this.storage.claimPoints.instances[key], ...instanceData }
    if (instanceData.enabled === false) {
      this.deleteInstance(instance.sk)
      return
    }
    this.place(instance)
  }

  updateInstance(instanceId: string, property: string, value: unknown): void {
    this.updateInstanceData({ sk: instanceId, [property]: value })
  }

  delete(elementId: string): void {
    const config = this.configs.get(elementId)
    if (config) delete this.storage.claimPoints.configs[config.customId || config.sk]
    this.configs.delete(elementId)
    for (const [sk, i] of this.instances) {
      if (i.configSk !== elementId) continue
      this.disposeEntities(i)
      delete this.storage.claimPoints.instances[i.customId || i.sk]
      this.instances.delete(sk)
    }
    this.watchSpin()
    this.changed()
  }

  deleteInstance(instanceId: string): void {
    const i = this.instances.get(instanceId)
    if (!i) return
    this.disposeEntities(i)
    delete this.storage.claimPoints.instances[i.customId || i.sk]
    this.instances.delete(instanceId)
    this.watchSpin()
    this.changed()
  }

  clear(): void {
    for (const i of this.instances.values()) this.disposeEntities(i)
    this.instances.clear()
    this.configs.clear()
    this.storage.claimPoints.configs = {}
    this.storage.claimPoints.instances = {}
    this.watchSpin()
    this.changed()
  }

  // Kiosks aren't moved in-world (the dashboard places them)
  listInstances(): ListedInstance[] { return [] }
  previewTransform(_sk: string, _t: TransformData): void {}
  restoreTransform(_sk: string): void {}
}
