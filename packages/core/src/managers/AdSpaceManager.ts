import type { VirviPlatformAdapter, VirviStorage, EntityHandle, TransformData, AdShape, AdFormats } from '@virvixr/shared'
import { listTransformable } from './transform-ops.js'
import type { ListedInstance } from './transform-ops.js'
import { AdSlot } from '../ads/slot.js'
import type { AdHost } from '../ads/host.js'
import { itemName } from './naming.js'

// Internal tracking of element config
interface AdSpaceConfig {
  sk: string
  name: string
  enabled: boolean
  customId?: string
  shape: AdShape
  formats: AdFormats
  fallbackImageSrc?: string
}

// Internal tracking of element instance -> entity mapping
interface AdSpaceInstance {
  sk: string
  enabled: boolean
  customId?: string
  /** Owned by the slot, which may swap it (see AdSlot). */
  entity: EntityHandle
  configSk: string
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number }
  scale: { x: number; y: number; z: number }
  withCollisions: boolean
  slot: AdSlot
}

/** Plane height over width for each shape. */
const HEIGHT_PER_WIDTH: Record<AdShape, number> = { '16:9': 9 / 16, '1:1': 1, '9:16': 16 / 9, '2:5': 5 / 2 }

/** The plane's transform: its height follows its width (scale.x) and the shape, so ads are never stretched. */
function planeTransform(t: TransformData, shape: AdShape): TransformData {
  return { ...t, scale: { ...t.scale, y: t.scale.x * (HEIGHT_PER_WIDTH[shape] ?? HEIGHT_PER_WIDTH['16:9']) } }
}

export class AdSpaceManager {
  private adapter: VirviPlatformAdapter
  private storage: VirviStorage
  private host: AdHost | null
  private isStreamLive: () => boolean
  private configs: Map<string, AdSpaceConfig> = new Map()
  private instances: Map<string, AdSpaceInstance> = new Map()

  constructor(adapter: VirviPlatformAdapter, storage: VirviStorage, host: AdHost | null, isStreamLive: () => boolean) {
    this.adapter = adapter
    this.storage = storage
    this.host = host
    this.isStreamLive = isStreamLive
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

  /** A stream went live or ended: video ads stop or come back. */
  streamChanged(): void {
    for (const instance of this.instances.values()) instance.slot.streamChanged()
  }

  private createConfig(data: any): void {
    const config: AdSpaceConfig = {
      sk: data.sk,
      name: data.name || '',
      enabled: data.enabled ?? true,
      customId: data.customId,
      shape: data.shape ?? '16:9',
      formats: data.formats ?? 'both',
      fallbackImageSrc: data.fallbackImageSrc || undefined,
    }
    this.configs.set(config.sk, config)

    const key = config.customId || config.sk
    this.storage.adSpaces.configs[key] = data
  }

  private createInstanceEntity(configSk: string, data: any): void {
    const config = this.configs.get(configSk)
    if (!config) return

    const entity = this.adapter.createEntity()
    this.adapter.setName?.(entity, itemName(config.name, undefined, 'Ad space'))

    const position = data.position || { x: 0, y: 0, z: 0 }
    const rotation = data.rotation || { x: 0, y: 0, z: 0 }
    const scale = data.scale || { x: 1, y: 1, z: 1 }

    // No plane yet: the slot adds it only when there is something to show
    this.adapter.setTransform(entity, planeTransform({ position, rotation, scale }, config.shape))

    const instance = {
      sk: data.sk,
      enabled: data.enabled ?? true,
      customId: data.customId,
      entity,
      configSk,
      position,
      rotation,
      scale,
      withCollisions: data.withCollisions ?? false,
    } as AdSpaceInstance
    instance.slot = this.makeSlot(config, instance, false)
    this.instances.set(data.sk, instance)
    instance.slot.run()

    const key = data.customId || data.sk
    this.storage.adSpaces.instances[key] = data
  }

  private makeSlot(config: AdSpaceConfig, instance: AdSpaceInstance, hasPlane: boolean): AdSlot {
    return new AdSlot({
      adapter: this.adapter,
      host: this.host,
      holder: instance,
      spec: {
        key: instance.sk,
        elementId: config.sk,
        name: itemName(config.name, undefined, 'Ad space'),
        shape: config.shape,
        formats: config.formats,
        fallbackImageSrc: config.fallbackImageSrc,
        withCollisions: instance.withCollisions,
      },
      transform: planeTransform({ position: instance.position, rotation: instance.rotation, scale: instance.scale }, config.shape),
      hasPlane,
      isStreamLive: this.isStreamLive,
    })
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

    if (elementData.shape !== undefined) config.shape = elementData.shape
    if (elementData.formats !== undefined) config.formats = elementData.formats
    if (elementData.fallbackImageSrc !== undefined) config.fallbackImageSrc = elementData.fallbackImageSrc || undefined
    if (elementData.enabled !== undefined) config.enabled = elementData.enabled
    if (elementData.name !== undefined) {
      config.name = elementData.name
      for (const instance of this.instances.values()) {
        if (instance.configSk === config.sk) this.adapter.setName?.(instance.entity, itemName(config.name, undefined, 'Ad space'))
      }
    }

    const key = config.customId || config.sk
    this.storage.adSpaces.configs[key] = { ...this.storage.adSpaces.configs[key], ...elementData }

    // Shape, formats or fallback changed: restart each instance's slot with the new settings
    for (const instance of this.instances.values()) {
      if (instance.configSk !== elementData.sk) continue
      this.adapter.setTransform(instance.entity, planeTransform({ position: instance.position, rotation: instance.rotation, scale: instance.scale }, config.shape))
      const planeShown = instance.slot.planeShown
      instance.slot.dispose()
      instance.slot = this.makeSlot(config, instance, planeShown)
      instance.slot.run()
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

      const plane = planeTransform({ position, rotation, scale }, this.configs.get(instance.configSk)?.shape ?? '16:9')
      this.adapter.setTransform(instance.entity, plane)
      instance.position = position
      instance.rotation = rotation
      instance.scale = scale
      instance.slot.setTransform(plane)
    }

    if (instanceData.enabled !== undefined) {
      instance.enabled = instanceData.enabled
    }

    if (instanceData.withCollisions !== undefined) {
      instance.withCollisions = instanceData.withCollisions
      instance.slot.setWithCollisions(instanceData.withCollisions)
    }

    const key = instance.customId || instance.sk
    this.storage.adSpaces.instances[key] = { ...this.storage.adSpaces.instances[key], ...instanceData }
  }

  // In-world transform editing (see transform-ops.ts)
  listInstances(): ListedInstance[] {
    return listTransformable(this.instances, this.configs)
  }

  previewTransform(sk: string, t: TransformData): void {
    const i = this.instances.get(sk)
    if (i) this.adapter.setTransform(i.entity, planeTransform(t, this.configs.get(i.configSk)?.shape ?? '16:9'))
  }

  restoreTransform(sk: string): void {
    const i = this.instances.get(sk)
    if (i) this.previewTransform(sk, { position: i.position, rotation: i.rotation, scale: i.scale })
  }

  updateInstance(instanceId: string, property: string, value: unknown): void {
    this.updateInstanceData({ sk: instanceId, [property]: value })
  }

  delete(elementId: string): void {
    const config = this.configs.get(elementId)
    if (config) {
      const configKey = config.customId || config.sk
      delete this.storage.adSpaces.configs[configKey]
    }
    this.configs.delete(elementId)

    for (const [sk, instance] of this.instances) {
      if (instance.configSk === elementId) {
        this.destroyInstance(instance)
        const instKey = instance.customId || instance.sk
        delete this.storage.adSpaces.instances[instKey]
        this.instances.delete(sk)
      }
    }
  }

  deleteInstance(instanceId: string): void {
    const instance = this.instances.get(instanceId)
    if (instance) {
      this.destroyInstance(instance)
      const key = instance.customId || instance.sk
      delete this.storage.adSpaces.instances[key]
      this.instances.delete(instanceId)
    }
  }

  clear(): void {
    for (const instance of this.instances.values()) {
      this.destroyInstance(instance)
    }
    this.configs.clear()
    this.instances.clear()
    this.storage.adSpaces.configs = {}
    this.storage.adSpaces.instances = {}
  }

  private destroyInstance(instance: AdSpaceInstance): void {
    instance.slot.dispose()
    this.adapter.destroyEntity(instance.entity)
  }
}
