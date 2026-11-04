import { screenStateAt, type ShowingInstance } from '@virvixr/shared'
import { AD_LIMITS, VideoSourceType } from '@virvixr/shared'
import type { VirviPlatformAdapter, VirviStorage, EntityHandle, TransformData } from '@virvixr/shared'
import { listTransformable, previewOn, restoreOn } from './transform-ops.js'
import type { ListedInstance } from './transform-ops.js'
import { AdSlot } from '../ads/slot.js'
import type { AdHost } from '../ads/host.js'
import { itemName } from './naming.js'

// Internal tracking of element config
interface VideoConfig {
  sk: string
  name: string
  enabled: boolean
  customId?: string
  liveSrc?: string
  isLive: boolean
  enableLiveStream: boolean
  offImageSrc?: string
  offType: number
  playlist: string[]
  volume: number
  playlistIndex: number
  emission: number
}

// Internal tracking of element instance -> entity mapping
interface VideoInstance {
  sk: string
  enabled: boolean
  customId?: string
  entity: EntityHandle
  configSk: string
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number }
  scale: { x: number; y: number; z: number }
  withCollisions: boolean
  /** Ads on this screen in the ads modes (4, 5); it may swap `entity` (see AdSlot). */
  slot?: AdSlot
  playlistIndex: number
  /** Playlist videos played since the last ad (mode 5). */
  sinceAd: number
  /** Bumped on each applyMediaState so callbacks from an earlier state are ignored. */
  mediaToken: number
  /** Schedule mode: the per-frame check for the next item or showing, while one is registered. */
  showingTick?: (dt: number) => void
  /** Schedule mode: what's on screen now ('<showing>@<start>#<item>' or 'between'), to act only on a change. */
  showingKey?: string
}

/** A `screen_showings` message (see apps/server src/scenes/showings.ts). */
export interface ScreenShowingsMessage {
  elementId: string
  serverTime: number
  showings: ShowingInstance[]
}

/** How often a scheduled screen checks whether it's time for the next item or showing. */
const SHOWING_CHECK_S = 0.25

export class VideoManager {
  private adapter: VirviPlatformAdapter
  private storage: VirviStorage
  private host: AdHost | null
  private configs: Map<string, VideoConfig> = new Map()
  private instances: Map<string, VideoInstance> = new Map()
  /** Per element: its showings and the server's clock minus ours (ms). Kept across upserts; may come before the screen. */
  private showings: Map<string, { showings: ShowingInstance[]; offsetMs: number }> = new Map()
  private now: () => number

  constructor(adapter: VirviPlatformAdapter, storage: VirviStorage, host: AdHost | null = null, now: () => number = () => Date.now()) {
    this.adapter = adapter
    this.storage = storage
    this.host = host
    this.now = now
  }

  /** New showings for a scheduled screen: applied at once, unless what's on screen stays the same. */
  setShowings(msg: ScreenShowingsMessage): void {
    if (!msg?.elementId || !Array.isArray(msg.showings) || typeof msg.serverTime !== 'number') return
    this.showings.set(msg.elementId, { showings: msg.showings, offsetMs: msg.serverTime - this.now() })
    const config = this.configs.get(msg.elementId)
    if (!config || !config.enabled || config.offType !== VideoSourceType.SCHEDULED || (config.isLive && config.enableLiveStream && config.liveSrc)) return
    for (const instance of this.instances.values()) {
      if (instance.configSk !== msg.elementId) continue
      if (instance.showingTick && this.showingState(msg.elementId).key === instance.showingKey) continue
      this.applyMediaState(instance, config)
    }
  }

  private showingState(elementId: string) {
    const entry = this.showings.get(elementId)
    const state = screenStateAt(entry?.showings ?? [], this.now() + (entry?.offsetMs ?? 0))
    const key = state.mode === 'playing' ? `${state.showing.showingId}@${state.showing.startsAt}#${state.index}` : 'between'
    return { state, key }
  }

  private stopShowingClock(instance: VideoInstance): void {
    if (instance.showingTick) this.adapter.unregisterSystem(instance.showingTick)
    instance.showingTick = undefined
    instance.showingKey = undefined
  }

  /** Schedule mode: show what's on now, then check a few times a second for the next item or showing. */
  private playScheduled(instance: VideoInstance, config: VideoConfig, token: number): void {
    this.renderShowing(instance, config)
    let since = 0
    const tick = (dt: number) => {
      if (instance.mediaToken !== token) return
      // A screen disabled in place keeps its entity: it must not go on changing videos
      if (!config.enabled) return this.stopShowingClock(instance)
      since += dt
      if (since < SHOWING_CHECK_S) return
      since = 0
      if (this.showingState(config.sk).key !== instance.showingKey) this.renderShowing(instance, config)
    }
    instance.showingTick = tick
    this.adapter.registerSystem(tick)
  }

  private renderShowing(instance: VideoInstance, config: VideoConfig): void {
    const { state, key } = this.showingState(config.sk)
    const prev = instance.showingKey
    instance.showingKey = key
    if (state.mode === 'playing') {
      // Everyone starts at the same second: the item, and how far into it the shared clock says the show is
      this.adapter.createVideoPlayer(instance.entity, {
        src: state.item.url, playing: true, loop: false, volume: config.volume, position: state.offset,
      })
      return
    }
    // Between showings: stop any video (a film, a stream or a playlist this screen played before), then the holding image
    if (prev !== 'between') this.adapter.createVideoPlayer(instance.entity, { src: '', playing: false, volume: 0, loop: false })
    if (config.offImageSrc) this.adapter.setMaterial(instance.entity, { textureSrc: config.offImageSrc, emission: config.emission })
  }

  /** True when any screen has a live, enabled stream (video ads stop scene-wide). */
  isStreamLive(): boolean {
    for (const c of this.configs.values()) {
      if (c.enabled && c.isLive && c.enableLiveStream && c.liveSrc) return true
    }
    return false
  }

  /** A stream went live or ended: video ads on ads-mode screens stop or come back. */
  streamChanged(): void {
    for (const instance of this.instances.values()) instance.slot?.streamChanged()
  }

  init(elements: any[]): void {
    if (!this.adapter.capabilities.video) return

    for (const element of elements) {
      if (!element.enabled) continue
      this.createConfig(element)
      for (const instance of element.instances || []) {
        if (!instance.enabled) continue
        this.createInstanceEntity(element.sk, instance)
      }
    }
  }

  /** Element fields that decide what a screen plays; an upsert that leaves them alone keeps live/playlist state. */
  private static MEDIA_FIELDS = ['liveSrc', 'enableLiveStream', 'offType', 'offImageSrc', 'playlist'] as const

  private createConfig(data: any, carry?: Pick<VideoConfig, 'isLive' | 'liveSrc' | 'playlistIndex'>): void {
    const config: VideoConfig = {
      sk: data.sk,
      name: data.name || '',
      enabled: data.enabled ?? true,
      customId: data.customId,
      liveSrc: data.liveSrc,
      isLive: data.isLive ?? false,
      enableLiveStream: data.enableLiveStream ?? false,
      offImageSrc: data.offImageSrc,
      offType: data.offType ?? 0,
      playlist: data.playlist || [],
      volume: (data.volume ?? 100) / 100, // Convert 0-100 to 0-1
      playlistIndex: 0,
      emission: data.emission ?? 0.6,
      ...carry,
    }
    this.configs.set(config.sk, config)

    // Register in storage (keyed by customId if available, else by sk)
    const key = config.customId || config.sk
    this.storage.videos.configs[key] = data
  }

  private createInstanceEntity(configSk: string, data: any): void {
    const config = this.configs.get(configSk)
    if (!config) return

    const entity = this.adapter.createEntity()
    this.adapter.setName?.(entity, itemName(config.name, undefined, 'Video screen'))

    const position = data.position || { x: 0, y: 0, z: 0 }
    const rotation = data.rotation || { x: 0, y: 0, z: 0 }
    const scale = data.scale || { x: 1, y: 1, z: 1 }

    // Set transform
    this.adapter.setTransform(entity, { position, rotation, scale })

    // Set plane mesh for the video screen
    this.adapter.setPlaneRenderer(entity)

    // Set collider if needed
    if (data.withCollisions) {
      this.adapter.setCollider(entity, { type: 'box' })
    }

    // Track the instance
    const instance: VideoInstance = {
      sk: data.sk,
      enabled: data.enabled ?? true,
      customId: data.customId,
      entity,
      configSk,
      position,
      rotation,
      scale,
      withCollisions: data.withCollisions ?? false,
      playlistIndex: config.playlistIndex,
      sinceAd: 0,
      mediaToken: 0,
    }
    this.instances.set(data.sk, instance)

    // Apply the correct media source
    this.applyMediaState(instance, config)

    // Register in storage
    const key = data.customId || data.sk
    this.storage.videos.instances[key] = data
  }

  private applyMediaState(instance: VideoInstance, config: VideoConfig): void {
    const token = ++instance.mediaToken
    this.stopShowingClock(instance)
    if (instance.slot) {
      instance.slot.ensurePlane()
      instance.slot.dispose()
      instance.slot = undefined
    }
    const entity = instance.entity

    // Live stream mode
    if (config.isLive && config.enableLiveStream && config.liveSrc) {
      this.adapter.createVideoPlayer(entity, {
        src: config.liveSrc,
        playing: true,
        loop: true,
        volume: config.volume,
      })
      return
    }

    // Offline modes based on offType
    switch (config.offType) {
      case VideoSourceType.ADS: // a 16:9 'both' ad space on the screen
        instance.slot = this.makeSlot(instance, config)
        instance.slot.run()
        break
      case VideoSourceType.PLAYLIST_ADS: // with an empty playlist, just ads (as mode 4)
        instance.slot = this.makeSlot(instance, config)
        if (config.playlist.length === 0) instance.slot.run()
        else this.playPlaylist(instance, config, token)
        break
      case 2: // PLAYLIST
        this.playPlaylist(instance, config, token)
        break
      case VideoSourceType.SCHEDULED:
        this.playScheduled(instance, config, token)
        break
      case 1: // IMAGE
        if (config.offImageSrc) {
          this.adapter.setMaterial(entity, {
            textureSrc: config.offImageSrc,
            emission: config.emission,
          })
        }
        break
      case 0: // NONE
      default:
        // No media to display
        break
    }
  }

  private makeSlot(instance: VideoInstance, config: VideoConfig): AdSlot {
    return new AdSlot({
      adapter: this.adapter,
      host: this.host,
      holder: instance,
      spec: {
        key: instance.sk,
        elementId: config.sk,
        name: itemName(config.name, undefined, 'Video screen'),
        shape: '16:9',
        formats: 'both',
        fallbackImageSrc: config.offImageSrc,
        withCollisions: instance.withCollisions,
        emission: config.emission,
      },
      transform: { position: instance.position, rotation: instance.rotation, scale: instance.scale },
      hasPlane: true,
      isStreamLive: () => this.isStreamLive(),
    })
  }

  /** Play the playlist from the instance's index; each end advances it (and, in mode 5, may play an ad first). */
  private playPlaylist(instance: VideoInstance, config: VideoConfig, token: number): void {
    const n = config.playlist.length
    if (n === 0) return
    instance.slot?.clear()
    instance.slot?.ensurePlane()
    const withAds = config.offType === VideoSourceType.PLAYLIST_ADS
    this.adapter.createVideoPlayer(instance.entity, {
      src: config.playlist[instance.playlistIndex % n],
      playing: true,
      loop: n === 1 && !withAds,
      volume: config.volume,
    })
    this.adapter.onVideoEnded?.(instance.entity, () => {
      if (instance.mediaToken !== token || instance.slot?.playing) return
      instance.playlistIndex = (instance.playlistIndex + 1) % n
      config.playlistIndex = instance.playlistIndex
      const resume = () => {
        if (instance.mediaToken === token) this.playPlaylist(instance, config, token)
      }
      if (withAds && instance.slot && ++instance.sinceAd >= AD_LIMITS.playlistItemsBetweenAds) {
        instance.sinceAd = 0
        const item = instance.slot.pick()
        if (item) {
          instance.slot.play(item, resume)
          return
        }
      }
      resume()
    })
  }

  // Called when server broadcasts video status change
  updateLiveStatus(elementId: string, status: string, url?: string): void {
    const config = this.configs.get(elementId)
    if (!config) return

    const isLive = status === 'live'
    config.isLive = isLive
    if (url) {
      config.liveSrc = url
    }

    // Re-apply media state to all instances of this config
    for (const instance of this.instances.values()) {
      if (instance.configSk === elementId) {
        this.applyMediaState(instance, config)
      }
    }
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

  /**
   * Full replace from a server snapshot (SceneManager `upsert`). When the media fields are unchanged
   * (e.g. a move, rename or volume change), the screen keeps its in-memory live status, live URL and
   * playlist position instead of falling back to its offline state.
   */
  upsert(elementData: any): void {
    const old = this.configs.get(elementData.sk)
    let carry: Pick<VideoConfig, 'isLive' | 'liveSrc' | 'playlistIndex'> | undefined
    if (old) {
      const raw: any = this.storage.videos.configs[old.customId || old.sk] ?? {}
      const same = VideoManager.MEDIA_FIELDS.every((f) => JSON.stringify(raw[f]) === JSON.stringify(elementData[f]))
      if (same) carry = { isLive: old.isLive, liveSrc: old.liveSrc, playlistIndex: old.playlistIndex }
    }
    this.delete(elementData.sk)
    if (elementData.enabled === false) return
    this.createConfig(elementData, carry)
    for (const inst of elementData.instances || []) {
      if (inst.enabled !== false) this.createInstanceEntity(elementData.sk, inst)
    }
  }

  createInstance(elementData: any, instanceData: any): void {
    const configSk = elementData?.sk || instanceData?.elementId
    this.createInstanceEntity(configSk, instanceData)
  }

  updateElement(elementData: any): void {
    const config = this.configs.get(elementData.sk)
    if (!config) return

    // Update config fields
    if (elementData.liveSrc !== undefined) config.liveSrc = elementData.liveSrc
    if (elementData.isLive !== undefined) config.isLive = elementData.isLive
    if (elementData.enableLiveStream !== undefined) config.enableLiveStream = elementData.enableLiveStream
    if (elementData.offImageSrc !== undefined) config.offImageSrc = elementData.offImageSrc
    if (elementData.offType !== undefined) config.offType = elementData.offType
    if (elementData.playlist !== undefined) config.playlist = elementData.playlist
    if (elementData.volume !== undefined) config.volume = elementData.volume / 100
    if (elementData.emission !== undefined) config.emission = elementData.emission
    if (elementData.enabled !== undefined) config.enabled = elementData.enabled
    if (elementData.name !== undefined) {
      config.name = elementData.name
      for (const instance of this.instances.values()) {
        if (instance.configSk === config.sk) this.adapter.setName?.(instance.entity, itemName(config.name, undefined, 'Video screen'))
      }
    }

    // Update storage
    const key = config.customId || config.sk
    this.storage.videos.configs[key] = { ...this.storage.videos.configs[key], ...elementData }

    // Re-apply to all instances
    for (const instance of this.instances.values()) {
      if (instance.configSk === elementData.sk) {
        if (config.enabled) {
          this.applyMediaState(instance, config)
        }
      }
    }
  }

  update(elementId: string, property: string, value: unknown): void {
    const data: any = { sk: elementId, [property]: value }
    this.updateElement(data)
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
      instance.slot?.setTransform({ position, rotation, scale })
    }

    if (instanceData.enabled !== undefined) {
      instance.enabled = instanceData.enabled
    }

    if (instanceData.withCollisions !== undefined) {
      instance.withCollisions = instanceData.withCollisions
      if (instance.slot) {
        instance.slot.setWithCollisions(instanceData.withCollisions)
      } else if (instanceData.withCollisions) {
        this.adapter.setCollider(instance.entity, { type: 'box' })
      } else {
        this.adapter.removeCollider(instance.entity)
      }
    }

    // Update storage
    const key = instance.customId || instance.sk
    this.storage.videos.instances[key] = { ...this.storage.videos.instances[key], ...instanceData }
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
    // Remove config
    const config = this.configs.get(elementId)
    if (config) {
      const configKey = config.customId || config.sk
      delete this.storage.videos.configs[configKey]
    }
    this.configs.delete(elementId)

    // Destroy all instances of this element
    for (const [sk, instance] of this.instances) {
      if (instance.configSk === elementId) {
        instance.slot?.dispose()
        this.stopShowingClock(instance)
        this.adapter.destroyEntity(instance.entity)
        const instKey = instance.customId || instance.sk
        delete this.storage.videos.instances[instKey]
        this.instances.delete(sk)
      }
    }
  }

  deleteInstance(instanceId: string): void {
    const instance = this.instances.get(instanceId)
    if (instance) {
      instance.slot?.dispose()
      this.stopShowingClock(instance)
      this.adapter.destroyEntity(instance.entity)
      const key = instance.customId || instance.sk
      delete this.storage.videos.instances[key]
      this.instances.delete(instanceId)
    }
  }

  clear(): void {
    for (const instance of this.instances.values()) {
      instance.slot?.dispose()
      this.stopShowingClock(instance)
      this.adapter.destroyEntity(instance.entity)
    }
    this.configs.clear()
    this.instances.clear()
    this.storage.videos.configs = {}
    this.storage.videos.instances = {}
  }
}
