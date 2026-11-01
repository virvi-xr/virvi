import { AD_LIMITS } from '@virvixr/shared'
import type { AdFormats, AdItem, AdShape, EntityHandle, TransformData, VirviPlatformAdapter } from '@virvixr/shared'
import { add, eulerDegreesToQuat, rotateVector } from '../transform/math.js'
import { durationMs } from './rotation.js'
import type { AdHost } from './host.js'

export interface AdSlotSpec {
  /** Unique per space (the instance sk). */
  key: string
  elementId: string
  /** The name the plane (and any replacement entity) shows up under in analytics. */
  name?: string
  shape: AdShape
  formats: AdFormats
  fallbackImageSrc?: string
  withCollisions: boolean
  emission?: number
}

/** Longest a video ad may hold its slot when the platform never reports its end (e.g. it failed to load). */
const MAX_VIDEO_AD_MS = 120_000

/** Inset of the "Ad" label from the plane's top-left corner, in metres. */
const LABEL_INSET_M = 0.1

/**
 * One plane that shows ads: an ad space instance, or a video screen in an ads mode. `holder.entity` is the plane;
 * the slot replaces it with a fresh entity when it must drop a renderer or a video player (there is no adapter
 * call to remove either), so owners must always read `holder.entity`.
 */
export class AdSlot {
  private readonly adapter: VirviPlatformAdapter
  private readonly host: AdHost | null
  private readonly holder: { entity: EntityHandle }
  private readonly spec: AdSlotSpec
  private readonly isStreamLive: () => boolean
  private transform: TransformData
  private hasPlane: boolean
  private label: EntityHandle | null = null
  private current: { item: AdItem; done: () => void; holdsVideo: boolean } | null = null
  private deadline: number | null = null
  private system: ((dt: number) => void) | null = null
  private unsubscribe: (() => void) | null = null
  /** In rotation mode the slot keeps choosing ads itself; otherwise its owner calls play() (playlist + ads). */
  private rotating = false
  private disposed = false

  constructor(opts: {
    adapter: VirviPlatformAdapter
    host: AdHost | null
    holder: { entity: EntityHandle }
    spec: AdSlotSpec
    transform: TransformData
    hasPlane: boolean
    isStreamLive: () => boolean
  }) {
    this.adapter = opts.adapter
    this.host = opts.host
    this.holder = opts.holder
    this.spec = opts.spec
    this.transform = opts.transform
    this.hasPlane = opts.hasPlane
    this.isStreamLive = opts.isStreamLive
    this.attach()
    if (this.host) this.unsubscribe = this.host.onChange(() => this.onServeChange())
  }

  /** Whether the plane currently has a renderer (false while hidden). */
  get planeShown(): boolean {
    return this.hasPlane
  }

  /** Whether an ad is on the plane right now. */
  get playing(): boolean {
    return this.current !== null
  }

  /** Rotate ads on this plane until disposed; fallback or hide whenever there is nothing to show. */
  run(): void {
    this.rotating = true
    this.showNext()
  }

  /** Choose the next ad for this space (taking a video slot when a video may play), or null. */
  pick(): AdItem | null {
    if (!this.host) return null
    const wantVideo = this.spec.formats !== 'image' && !!this.adapter.onVideoEnded && !this.isStreamLive()
    const slot = wantVideo && this.host.videoSlot()
    const item = this.host.nextFor(this.spec.key, slot)
    if (slot && item?.kind !== 'video') this.host.releaseVideoSlot()
    return item
  }

  /** Show one ad (with label, click and hover); call done when its time is up or its video ends. */
  play(item: AdItem, done: () => void): void {
    this.endCurrent()
    this.ensurePlane()
    const entity = this.holder.entity
    const holdsVideo = item.kind === 'video'
    this.current = { item, done, holdsVideo }
    if (holdsVideo) {
      this.adapter.createVideoPlayer(entity, { src: item.url, playing: true, volume: 0, loop: false })
      this.adapter.onVideoEnded!(entity, () => {
        if (this.current?.item === item) this.finish()
      })
      this.setDeadline(this.host!.now() + MAX_VIDEO_AD_MS)
    } else {
      this.adapter.setMaterial(entity, { textureSrc: item.url, emission: this.spec.emission })
      this.setDeadline(this.host!.now() + (durationMs(item) ?? 0))
    }
    this.adapter.onPointerDown(entity, { hoverText: 'Open link' }, () => {
      this.adapter.openUrl(item.clickUrl)
      this.host?.tracker.click(this.spec.key)
    })
    this.adapter.onPointerHover?.(
      entity,
      () => this.host?.tracker.hoverStart(this.spec.key),
      () => this.host?.tracker.hoverEnd(this.spec.key),
      AD_LIMITS.hoverMaxDistanceM,
    )
    this.showLabel()
    this.host?.tracker.showing(this.spec.key, this.spec.elementId, item.adId)
  }

  /** Stop any ad (label, click and timer go; the video slot is released). Leaves the plane as it is. */
  clear(): void {
    this.endCurrent()
    this.host?.tracker.showing(this.spec.key, this.spec.elementId, null)
  }

  /** A stream went live or ended. */
  streamChanged(): void {
    if (this.current?.holdsVideo && this.isStreamLive()) {
      // the video ad stops at once: drop the entity (and its player), then carry on
      const { done } = this.current
      this.endCurrent()
      this.replaceEntity()
      done()
      return
    }
    if (this.rotating && !this.current) this.showNext()
  }

  /** The plane moved: keep the label in its corner and the measured geometry current. */
  setTransform(t: TransformData): void {
    this.transform = t
    if (this.label !== null) this.adapter.setTransform(this.label, this.labelTransform())
    this.attach()
  }

  /** Put the plane (and its collider) back if the slot removed it. */
  ensurePlane(): void {
    if (this.hasPlane) return
    this.adapter.setPlaneRenderer(this.holder.entity)
    if (this.spec.withCollisions) this.adapter.setCollider(this.holder.entity, { type: 'box' })
    this.hasPlane = true
  }

  setWithCollisions(on: boolean): void {
    this.spec.withCollisions = on
    if (!this.hasPlane) return
    if (on) this.adapter.setCollider(this.holder.entity, { type: 'box' })
    else this.adapter.removeCollider(this.holder.entity)
  }

  /** Stop and detach. The owner destroys holder.entity. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.rotating = false
    this.endCurrent()
    this.unsubscribe?.()
    this.host?.detach(this.spec.key)
  }

  private showNext(): void {
    if (this.disposed) return
    const item = this.pick()
    if (item) {
      this.play(item, () => this.showNext())
      return
    }
    this.showNothing()
  }

  private finish(): void {
    const done = this.current?.done
    this.endCurrent()
    done?.()
  }

  /** Fallback image (no label, no click), or no plane at all; look again in imageSeconds. */
  private showNothing(): void {
    this.clear()
    if (this.spec.fallbackImageSrc) {
      this.ensurePlane()
      this.adapter.setMaterial(this.holder.entity, { textureSrc: this.spec.fallbackImageSrc, emission: this.spec.emission })
    } else if (this.hasPlane) {
      this.replaceEntity()
    }
    if (this.host) this.setDeadline(this.host.now() + AD_LIMITS.imageSeconds * 1000)
  }

  private onServeChange(): void {
    if (this.rotating && !this.current) this.showNext()
  }

  private endCurrent(): void {
    if (this.current?.holdsVideo) this.host?.releaseVideoSlot()
    if (this.current) this.adapter.removePointerEvents(this.holder.entity)
    this.current = null
    this.setDeadline(null)
    if (this.label !== null) this.adapter.destroyEntity(this.label)
    this.label = null
  }

  /** A fresh entity with only the transform: no renderer, material, collider, pointer events or video player. */
  private replaceEntity(): void {
    this.adapter.destroyEntity(this.holder.entity)
    this.holder.entity = this.adapter.createEntity()
    if (this.spec.name) this.adapter.setName?.(this.holder.entity, this.spec.name)
    this.adapter.setTransform(this.holder.entity, this.transform)
    this.hasPlane = false
    this.attach()
  }

  private attach(): void {
    if (this.disposed) return
    const { position, scale } = this.transform
    this.host?.attach(this.spec.key, this.spec.elementId, this.holder.entity, {
      shape: this.spec.shape,
      formats: this.spec.formats,
      shortSideM: Math.min(Math.abs(scale.x), Math.abs(scale.y)),
      position,
    })
  }

  private showLabel(): void {
    if (!this.adapter.setText) return
    this.label = this.adapter.createEntity()
    this.adapter.setTransform(this.label, this.labelTransform())
    this.adapter.setText(this.label, 'Ad', { fontSize: 1 })
  }

  /** The plane's top-left corner, inset a little, slightly in front of it. */
  private labelTransform(): TransformData {
    const { position, rotation, scale } = this.transform
    const offset = { x: -scale.x / 2 + LABEL_INSET_M, y: scale.y / 2 - LABEL_INSET_M, z: -0.01 }
    return { position: add(position, rotateVector(eulerDegreesToQuat(rotation), offset)), rotation, scale: { x: 1, y: 1, z: 1 } }
  }

  private setDeadline(at: number | null): void {
    this.deadline = at
    if (at !== null && !this.system) {
      this.system = () => {
        if (this.deadline === null || this.host!.now() < this.deadline) return
        if (this.current) this.finish()
        else this.showNext()
      }
      this.adapter.registerSystem(this.system)
    } else if (at === null && this.system) {
      this.adapter.unregisterSystem(this.system)
      this.system = null
    }
  }
}
