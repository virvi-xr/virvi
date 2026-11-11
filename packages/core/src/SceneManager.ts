import type { VirviPlatformAdapter, VirviStorage, EntityHandle, TransformData } from '@virvixr/shared'
import type { Selected } from './transform/session.js'
import type { ListedInstance } from './managers/transform-ops.js'
import { VideoManager, type ScreenShowingsMessage } from './managers/VideoManager.js'
import { ImageManager } from './managers/ImageManager.js'
import { MeshManager } from './managers/MeshManager.js'
import { SoundManager } from './managers/SoundManager.js'
import { AdSpaceManager } from './managers/AdSpaceManager.js'
import type { AdHost } from './ads/host.js'
import { EventBus } from './events/EventBus.js'

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

  /** `ads` serves the scene's ad spaces and ads-mode screens; without it they show their fallback or hide. */
  constructor(adapter: VirviPlatformAdapter, storage: VirviStorage, events: EventBus, ads: AdHost | null = null, now: () => number = () => Date.now()) {
    this.adapter = adapter
    this.events = events
    const video = new VideoManager(adapter, storage, ads, now)
    this.managers = {
      video,
      image: new ImageManager(adapter, storage),
      model: new MeshManager(adapter, storage, events),
      sound: new SoundManager(adapter, storage),
      // keyed by the element type on the wire
      ad_space: new AdSpaceManager(adapter, storage, ads, () => video.isStreamLive()),
    }
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
    switch (message.action) {
      case 'init':
        this.initPreset(message.scenePreset)
        this.adapter.releaseUnadopted?.()
        break
      case 'create':
        if (message.instance) {
          this.managers[message.element]?.createInstance(message.elementData, message.instanceData)
        } else {
          this.managers[message.element]?.create(message.elementData)
        }
        break
      case 'update':
        if (message.instance) {
          if (message.instanceData) {
            this.managers[message.element]?.updateInstanceData(message.instanceData)
          } else {
            this.managers[message.element]?.updateInstance(message.id, message.property, message.value)
          }
        } else {
          if (message.elementData) {
            this.managers[message.element]?.updateElement(message.elementData)
          } else {
            this.managers[message.element]?.update(message.id, message.property, message.value)
          }
        }
        break
      case 'upsert': {
        // Full element snapshot: drop whatever we have for it (no-op if absent), then rebuild.
        const manager = this.managers[message.element]
        const data = message.elementData
        if (!manager || !data?.sk) break
        if (manager.upsert) {
          manager.upsert(data)
          break
        }
        manager.delete(data.sk)
        if (data.enabled !== false) manager.create(data)
        break
      }
      case 'delete':
        if (message.instance) {
          const instanceId = message.instanceData?.sk || message.id
          this.managers[message.element]?.deleteInstance(instanceId)
        } else {
          const elementId = message.elementData?.sk || message.id
          this.managers[message.element]?.delete(elementId)
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

  /** The modelSrc of each model element the platform can't load. */
  missingModelSrcs(): string[] {
    return (this.managers.model as MeshManager).missingSrcs()
  }

  handlePresetChange(message: any): void {
    // Clear all current elements
    for (const manager of Object.values(this.managers)) {
      manager.clear()
    }
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
    this.managers.video?.init(preset.videos || [])
    this.managers.image?.init(preset.images || [])
    this.managers.model?.init(preset.models || [])
    this.managers.sound?.init(preset.sounds || [])
    this.managers.ad_space?.init(preset.adSpaces || [])
  }
}
