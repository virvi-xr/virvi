import type { VirviPlatformAdapter, VirviStorage, EntityHandle, TransformData } from '@virvixr/shared'
import type { Selected } from './transform/session.js'
import type { ListedInstance } from './managers/transform-ops.js'
import { VideoManager, type ScreenShowingsMessage } from './managers/VideoManager.js'
import { ImageManager } from './managers/ImageManager.js'
import { MeshManager } from './managers/MeshManager.js'
import { SoundManager } from './managers/SoundManager.js'
import { AdSpaceManager } from './managers/AdSpaceManager.js'
import { KioskManager } from './managers/KioskManager.js'
import { WidgetManager } from './managers/WidgetManager.js'
import type { AdHost } from './ads/host.js'
import { EventBus } from './events/EventBus.js'
import { CustomRenderer, type DrawnType } from './CustomRendering.js'

// Manager interface — shared by all element managers
interface ElementManager {
  init(elements: any[]): void
  create(elementData: any): void
  createInstance(elementData: any, instanceData: any): void
  update(elementId: string, property: string, value: unknown): void
  updateInstance(instanceId: string, property: string, value: unknown): void
  updateElement(elementData: any): void
  updateInstanceData(instanceData: any): void
  delete(elementId: string): void
  deleteInstance(instanceId: string): void
  clear(): void
  listInstances(): ListedInstance[]
  previewTransform(sk: string, t: TransformData): void
  restoreTransform(sk: string): void
  /** Optional full replace that can keep in-memory state (see VideoManager.upsert). */
  upsert?(elementData: any): void
}

const EDITABLE: Selected['element'][] = ['image', 'video', 'model', 'sound', 'ad_space']

export class SceneManager {
  private managers: Record<string, ElementManager>
  private events: EventBus
  private adapter: VirviPlatformAdapter
  /** LIV-158: elements and copies the scene's code draws itself. */
  readonly custom: CustomRenderer

  /** `ads` serves the scene's ad spaces and ads-mode screens; without it they show their fallback or hide. */
  constructor(adapter: VirviPlatformAdapter, storage: VirviStorage, events: EventBus, ads: AdHost | null = null, now: () => number = () => Date.now()) {
    this.adapter = adapter
    this.events = events
    this.custom = new CustomRenderer(storage, events)
    const video = new VideoManager(adapter, storage, ads, now)
    this.managers = {
      video,
      image: new ImageManager(adapter, storage),
      model: new MeshManager(adapter, storage, events),
      sound: new SoundManager(adapter, storage),
      // keyed by the element type on the wire
      ad_space: new AdSpaceManager(adapter, storage, ads, () => video.isStreamLive()),
      claim_point: new KioskManager(adapter, storage, events),
      widget: new WidgetManager(storage, events),
    }
  }

  /** The scene's widgets (LIV-158). */
  get widgets(): WidgetManager {
    return this.managers.widget as unknown as WidgetManager
  }

  /** True when any video config has a live, enabled stream. */
  isStreamLive(): boolean {
    return (this.managers.video as VideoManager).isStreamLive()
  }

  /** Any edit can start or end a live stream (live fields, enabled, create, delete); an init always rechecks. */
  handlePresetUpdate(message: any): void {
    const wasLive = this.isStreamLive()
    this.applyPresetUpdate(message)
    if (message.action === 'init' || this.isStreamLive() !== wasLive) this.streamChanged()
  }

  private applyPresetUpdate(message: any): void {
    this.routePresetUpdate(message)
    if (message.action !== 'init') {
      const id = message.elementData?.sk || message.instanceData?.sk || message.id
      this.events.emit('storage_change', { action: message.action, type: message.element, id: id ?? null, instance: !!message.instance })
    }
  }

  /** Each change goes to scene code (custom rendering) or to Virvi's manager for the type. */
  private routePresetUpdate(message: any): void {
    const custom = this.custom
    const manager = this.managers[message.element]
    const type = message.element as DrawnType
    switch (message.action) {
      case 'init':
        this.initPreset(message.scenePreset)
        this.adapter.releaseUnadopted?.()
        break
      case 'create':
        if (message.instance) {
          if (custom.createInstance(type, message.elementData, message.instanceData)) break
          manager?.createInstance(message.elementData, message.instanceData)
        } else if (custom.wantsElement(type, message.elementData)) {
          custom.createElement(type, message.elementData)
        } else {
          manager?.create(custom.splitInstances(type, message.elementData))
        }
        break
      case 'update':
        if (message.instance) {
          const sk = message.instanceData?.sk || message.id
          const patch = message.instanceData ?? { [message.property]: message.value }
          if (sk && custom.patchInstance(sk, patch)) break
          if (message.instanceData) manager?.updateInstanceData(message.instanceData)
          else manager?.updateInstance(message.id, message.property, message.value)
        } else {
          const sk = message.elementData?.sk || message.id
          const patch = message.elementData ?? { [message.property]: message.value }
          if (sk && custom.hasElement(sk)) {
            // Turned off for this element (and not on for everything): Virvi draws it again
            if (patch.customRendering === false && !custom.everything) {
              const data = custom.deleteElement(sk)
              if (data && manager) manager.create({ ...data, ...patch })
            } else custom.patchElement(sk, patch)
            break
          }
          if (message.elementData) manager?.updateElement(message.elementData)
          else manager?.update(message.id, message.property, message.value)
        }
        break
      case 'upsert': {
        // Full element snapshot: drop whatever we have for it (no-op if absent), then rebuild.
        const data = message.elementData
        if (!manager || !data?.sk) break
        if (custom.wantsElement(type, data)) {
          // Handed over (newly, or still): Virvi stops drawing it
          if (!custom.hasElement(data.sk)) { manager.delete(data.sk); custom.dropInstancesOf(data.sk) }
          custom.replaceElement(type, data)
          break
        }
        if (custom.hasElement(data.sk)) custom.deleteElement(data.sk)
        const drawn = custom.splitInstances(type, data)
        if (manager.upsert) {
          manager.upsert(drawn)
          break
        }
        manager.delete(drawn.sk)
        if (drawn.enabled !== false) manager.create(drawn)
        break
      }
      case 'delete':
        if (message.instance) {
          const instanceId = message.instanceData?.sk || message.id
          if (custom.deleteInstance(instanceId)) break
          manager?.deleteInstance(instanceId)
        } else {
          const elementId = message.elementData?.sk || message.id
          custom.dropInstancesOf(elementId)
          if (custom.deleteElement(elementId)) break
          manager?.delete(elementId)
        }
        break
    }
  }

  /** Which editable instance (if any) owns this entity. */
  findByEntity(entity: EntityHandle): Selected | null {
    for (const element of EDITABLE) {
      const hit = this.managers[element].listInstances().find((i) => i.entity === entity)
      if (hit) return { element, sk: hit.sk, name: hit.name, transform: hit.transform }
    }
    return null
  }

  /** Every instance of the editable element types that has a live entity (visible ones). */
  listEditable(): (Selected & { entity: EntityHandle })[] {
    const out: (Selected & { entity: EntityHandle })[] = []
    for (const element of EDITABLE) {
      for (const i of this.managers[element].listInstances()) {
        if (!this.adapter.entityExists(i.entity)) continue
        out.push({ element, sk: i.sk, name: i.name, transform: i.transform, entity: i.entity })
      }
    }
    return out
  }

  previewTransform(element: Selected['element'], sk: string, t: TransformData): void {
    this.managers[element]?.previewTransform(sk, t)
  }

  restoreTransform(element: Selected['element'], sk: string): void {
    this.managers[element]?.restoreTransform(sk)
  }

  /** How many giveaway kiosk copies the scene shows. */
  kioskCount(): number {
    return (this.managers.claim_point as KioskManager).count()
  }

  /** The modelSrc of each model element the platform can't load. */
  missingModelSrcs(): string[] {
    return (this.managers.model as MeshManager).missingSrcs()
  }

  handlePresetChange(message: any): void {
    // Clear all current elements
    for (const manager of Object.values(this.managers)) {
      manager.clear()
    }
    this.custom.clear()
    // Re-init with new preset
    if (message.scenePreset) {
      this.initPreset(message.scenePreset)
    }
    // Whatever the platform placed before live state and no manager adopted (LIV-134) is gone with the old state
    this.adapter.releaseUnadopted?.()
    // Screens are created in preset order: an ads-mode screen may have started a video ad before the live screen existed
    this.streamChanged()
  }

  /** A scheduled screen's showings (`screen_showings`, LIV-87). */
  handleScreenShowings(message: ScreenShowingsMessage): void {
    ;(this.managers.video as VideoManager).setShowings(message)
  }

  handleVideoStatus(message: any): void {
    const videoManager = this.managers.video as VideoManager
    videoManager.updateLiveStatus(message.elementId, message.status, message.url)
    this.streamChanged()
  }

  /** What every ad space and ads-mode screen may play depends on whether any stream is live. */
  private streamChanged(): void {
    ;(this.managers.video as VideoManager).streamChanged()
    ;(this.managers.ad_space as AdSpaceManager).streamChanged()
  }

  private initPreset(preset: any): void {
    if (!preset) return
    // Scene code takes what it draws itself; Virvi draws the rest
    preset = this.custom.initPreset(preset)
    this.managers.video?.init(preset.videos || [])
    this.managers.image?.init(preset.images || [])
    this.managers.model?.init(preset.models || [])
    this.managers.sound?.init(preset.sounds || [])
    this.managers.ad_space?.init(preset.adSpaces || [])
    this.managers.claim_point?.init(preset.claimPoints || [])
    this.managers.widget?.init(preset.widgets || [])
    this.events.emit('storage_change', { action: 'init', type: null, id: null, instance: false })
  }
}
