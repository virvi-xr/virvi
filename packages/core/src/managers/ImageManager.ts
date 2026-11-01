import type { VirviPlatformAdapter, VirviStorage, EntityHandle, TransformData } from '@virvixr/shared'
import { listTransformable, previewOn, restoreOn } from './transform-ops.js'
import type { ListedInstance } from './transform-ops.js'
import { itemName } from './naming.js'

// Internal tracking of element config
interface ImageConfig {
  sk: string
  name: string
  enabled: boolean
  customId?: string
  textureSrc?: string
  emission: number
  isTransparent: boolean
}

// Internal tracking of element instance -> entity mapping
interface ImageInstance {
  sk: string
  enabled: boolean
  customId?: string
  entity: EntityHandle
  configSk: string
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number }
  scale: { x: number; y: number; z: number }
  withCollisions: boolean
}

export class ImageManager {
  private adapter: VirviPlatformAdapter
  private storage: VirviStorage
  private configs: Map<string, ImageConfig> = new Map()
  private instances: Map<string, ImageInstance> = new Map()

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
    const config: ImageConfig = {
      sk: data.sk,
      name: data.name || '',
      enabled: data.enabled ?? true,
      customId: data.customId,
      textureSrc: data.textureSrc,
      emission: data.emission ?? 0,
      isTransparent: data.isTransparent ?? false,
    }
    this.configs.set(config.sk, config)

    const key = config.customId || config.sk
    this.storage.images.configs[key] = data
  }

  private createInstanceEntity(configSk: string, data: any): void {
    const config = this.configs.get(configSk)
    if (!config) return

    const entity = this.adapter.createEntity()
    this.adapter.setName?.(entity, itemName(config.name, config.textureSrc, 'Image'))

    const position = data.position || { x: 0, y: 0, z: 0 }
    const rotation = data.rotation || { x: 0, y: 0, z: 0 }
    const scale = data.scale || { x: 1, y: 1, z: 1 }

    this.adapter.setTransform(entity, { position, rotation, scale })
    this.adapter.setPlaneRenderer(entity)

    // Apply texture material
    if (config.textureSrc) {
      this.adapter.setMaterial(entity, {
        textureSrc: config.textureSrc,
        emission: config.emission,
        isTransparent: config.isTransparent,
      })
    }

    // Set collider if needed
    if (data.withCollisions) {
      this.adapter.setCollider(entity, { type: 'box' })
    }

    const instance: ImageInstance = {
      sk: data.sk,
      enabled: data.enabled ?? true,
      customId: data.customId,
      entity,
      configSk,
      position,
      rotation,
      scale,
      withCollisions: data.withCollisions ?? false,
    }
    this.instances.set(data.sk, instance)

    const key = data.customId || data.sk
    this.storage.images.instances[key] = data
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

    if (elementData.textureSrc !== undefined) config.textureSrc = elementData.textureSrc
    if (elementData.emission !== undefined) config.emission = elementData.emission
    if (elementData.isTransparent !== undefined) config.isTransparent = elementData.isTransparent
    if (elementData.enabled !== undefined) config.enabled = elementData.enabled
    if (elementData.name !== undefined) config.name = elementData.name
    // A file-name label follows the file
    if (elementData.name !== undefined || elementData.textureSrc !== undefined) {
      for (const instance of this.instances.values()) {
        if (instance.configSk === config.sk) this.adapter.setName?.(instance.entity, itemName(config.name, config.textureSrc, 'Image'))
      }
    }

    // Update storage
    const key = config.customId || config.sk
    this.storage.images.configs[key] = { ...this.storage.images.configs[key], ...elementData }

    // Re-apply material to all instances
    for (const instance of this.instances.values()) {
      if (instance.configSk === elementData.sk && config.textureSrc) {
        this.adapter.setMaterial(instance.entity, {
          textureSrc: config.textureSrc,
          emission: config.emission,
          isTransparent: config.isTransparent,
        })
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

    if (instanceData.withCollisions !== undefined) {
      instance.withCollisions = instanceData.withCollisions
      if (instanceData.withCollisions) {
        this.adapter.setCollider(instance.entity, { type: 'box' })
      } else {
        this.adapter.removeCollider(instance.entity)
      }
    }

    // Update storage
    const key = instance.customId || instance.sk
    this.storage.images.instances[key] = { ...this.storage.images.instances[key], ...instanceData }
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
      delete this.storage.images.configs[configKey]
    }
    this.configs.delete(elementId)

    for (const [sk, instance] of this.instances) {
      if (instance.configSk === elementId) {
        this.adapter.destroyEntity(instance.entity)
        const instKey = instance.customId || instance.sk
        delete this.storage.images.instances[instKey]
        this.instances.delete(sk)
      }
    }
  }

  deleteInstance(instanceId: string): void {
    const instance = this.instances.get(instanceId)
    if (instance) {
      this.adapter.destroyEntity(instance.entity)
      const key = instance.customId || instance.sk
      delete this.storage.images.instances[key]
      this.instances.delete(instanceId)
    }
  }

  clear(): void {
    for (const instance of this.instances.values()) {
      this.adapter.destroyEntity(instance.entity)
    }
    this.configs.clear()
    this.instances.clear()
    this.storage.images.configs = {}
    this.storage.images.instances = {}
  }
}
