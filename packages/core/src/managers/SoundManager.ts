import type { VirviPlatformAdapter, VirviStorage, EntityHandle, TransformData } from '@virvixr/shared'
import { listTransformable, previewOn, restoreOn } from './transform-ops.js'
import type { ListedInstance } from './transform-ops.js'
import { itemName } from './naming.js'

// Internal tracking of element config
interface SoundConfig {
  sk: string
  name: string
  enabled: boolean
  customId?: string
  audioSrc?: string
  volume: number
  sourceType: number // 0 = CLIP, 1 = LOOP
}

// Internal tracking of element instance -> entity mapping
interface SoundInstance {
  sk: string
  enabled: boolean
  customId?: string
  entity: EntityHandle
  configSk: string
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number }
  scale: { x: number; y: number; z: number }
}

export class SoundManager {
  private adapter: VirviPlatformAdapter
  private storage: VirviStorage
  private configs: Map<string, SoundConfig> = new Map()
  private instances: Map<string, SoundInstance> = new Map()

  constructor(adapter: VirviPlatformAdapter, storage: VirviStorage) {
    this.adapter = adapter
    this.storage = storage
  }

  init(elements: any[]): void {
    for (const element of elements) {
      if (!element.enabled) continue
      this.createConfig(element)
      for (const instance of element.instances || []) {
        if (!instance.enabled) continue
        this.createInstanceEntity(element.sk, instance)
      }
    }
  }

  private createConfig(data: any): void {
    const config: SoundConfig = {
      sk: data.sk,
      name: data.name || '',
      enabled: data.enabled ?? true,
      customId: data.customId,
      audioSrc: data.audioSrc,
      volume: (data.volume ?? 100) / 100, // Convert 0-100 to 0-1
      sourceType: data.sourceType ?? 0,
    }
    this.configs.set(config.sk, config)

    const key = config.customId || config.sk
    this.storage.sounds.configs[key] = data
  }

  private createInstanceEntity(configSk: string, data: any): void {
    const config = this.configs.get(configSk)
    if (!config || !config.audioSrc) return

    const entity = this.adapter.createEntity()
    this.adapter.setName?.(entity, itemName(config.name, config.audioSrc, 'Sound'))

    const position = data.position || { x: 0, y: 0, z: 0 }
    const rotation = data.rotation || { x: 0, y: 0, z: 0 }
    const scale = data.scale || { x: 1, y: 1, z: 1 }

    this.adapter.setTransform(entity, { position, rotation, scale })

    const isLoop = config.sourceType === 1
    this.adapter.setAudioSource(entity, {
      src: config.audioSrc,
      volume: config.volume,
      loop: isLoop,
      playing: isLoop, // Loops auto-play, clips wait for trigger
    })

    const instance: SoundInstance = {
      sk: data.sk,
      enabled: data.enabled ?? true,
      customId: data.customId,
      entity,
      configSk,
      position,
      rotation,
      scale,
    }
    this.instances.set(data.sk, instance)

    const key = data.customId || data.sk
    this.storage.sounds.instances[key] = data
  }

  // CRUD operations
  create(elementData: any): void {
    this.createConfig(elementData)
    for (const inst of elementData.instances || []) {
      if (inst.enabled !== false) {
        this.createInstanceEntity(elementData.sk, inst)
      }
    }
  }

  createInstance(elementData: any, instanceData: any): void {
    const configSk = elementData?.sk || instanceData?.elementId
    this.createInstanceEntity(configSk, instanceData)
  }

  updateElement(elementData: any): void {
    const config = this.configs.get(elementData.sk)
    if (!config) return

    if (elementData.audioSrc !== undefined) config.audioSrc = elementData.audioSrc
    if (elementData.volume !== undefined) config.volume = elementData.volume / 100
    if (elementData.sourceType !== undefined) config.sourceType = elementData.sourceType
    if (elementData.enabled !== undefined) config.enabled = elementData.enabled
    if (elementData.name !== undefined) config.name = elementData.name
    // A file-name label follows the file
    if (elementData.name !== undefined || elementData.audioSrc !== undefined) {
      for (const instance of this.instances.values()) {
        if (instance.configSk === config.sk) this.adapter.setName?.(instance.entity, itemName(config.name, config.audioSrc, 'Sound'))
      }
    }

    // Update storage
    const key = config.customId || config.sk
    this.storage.sounds.configs[key] = { ...this.storage.sounds.configs[key], ...elementData }

    // Re-apply audio to all instances
    if (config.audioSrc) {
      const isLoop = config.sourceType === 1
      for (const instance of this.instances.values()) {
        if (instance.configSk === elementData.sk) {
          this.adapter.setAudioSource(instance.entity, {
            src: config.audioSrc,
            volume: config.volume,
            loop: isLoop,
            playing: isLoop,
          })
        }
      }
    }
  }

  update(elementId: string, property: string, value: unknown): void {
    this.updateElement({ sk: elementId, [property]: value })
  }

  updateInstanceData(instanceData: any): void {
    const instance = this.instances.get(instanceData.sk)
    if (!instance) return

    if (instanceData.position || instanceData.rotation || instanceData.scale) {
      const position = instanceData.position || instance.position
      const rotation = instanceData.rotation || instance.rotation
      const scale = instanceData.scale || instance.scale

      this.adapter.setTransform(instance.entity, { position, rotation, scale })
      instance.position = position
      instance.rotation = rotation
      instance.scale = scale
    }

    if (instanceData.enabled !== undefined) {
      instance.enabled = instanceData.enabled
    }

    // Update storage
    const key = instance.customId || instance.sk
    this.storage.sounds.instances[key] = { ...this.storage.sounds.instances[key], ...instanceData }
  }

  // In-world transform editing (see transform-ops.ts)
  listInstances(): ListedInstance[] {
    return listTransformable(this.instances, this.configs)
  }

  previewTransform(sk: string, t: TransformData): void {
    previewOn(this.adapter, this.instances, sk, t)
  }

  restoreTransform(sk: string): void {
    restoreOn(this.adapter, this.instances, sk)
  }

  updateInstance(instanceId: string, property: string, value: unknown): void {
    this.updateInstanceData({ sk: instanceId, [property]: value })
  }

  delete(elementId: string): void {
    const config = this.configs.get(elementId)
    if (config) {
      const configKey = config.customId || config.sk
      delete this.storage.sounds.configs[configKey]
    }
    this.configs.delete(elementId)

    for (const [sk, instance] of this.instances) {
      if (instance.configSk === elementId) {
        this.adapter.stopAudio(instance.entity)
        this.adapter.destroyEntity(instance.entity)
        const instKey = instance.customId || instance.sk
        delete this.storage.sounds.instances[instKey]
        this.instances.delete(sk)
      }
    }
  }

  deleteInstance(instanceId: string): void {
    const instance = this.instances.get(instanceId)
    if (instance) {
      this.adapter.stopAudio(instance.entity)
      this.adapter.destroyEntity(instance.entity)
      const key = instance.customId || instance.sk
      delete this.storage.sounds.instances[key]
      this.instances.delete(instanceId)
    }
  }

  clear(): void {
    for (const instance of this.instances.values()) {
      this.adapter.stopAudio(instance.entity)
      this.adapter.destroyEntity(instance.entity)
    }
    this.configs.clear()
    this.instances.clear()
    this.storage.sounds.configs = {}
    this.storage.sounds.instances = {}
  }
}
