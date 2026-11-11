/**
 * Frames around images and video screens (LIV-129): the geometry, and the entities that draw it.
 *
 * A frame is four boxes around the picture's edges (Gallery adds a mat of four plane strips between them and the
 * picture): 48 triangles, 56 for Gallery, no models to download. The picture is the item's 1×1 plane scaled by its instance scale, so the
 * frame is sized from |scale.x| × |scale.y| (frameParts, in @virvixr/shared) and placed with the instance's position and rotation; managers redraw it
 * whenever the instance moves, is resized or previewed. Pictures show on both sides, so a frame has no front.
 * Drawn only on platforms with `setSolidShape`; elsewhere nothing is created.
 */
import { frameColorRgb, frameParts } from '@virvixr/shared'
import type { EntityHandle, FramePart, FrameSettings, TransformData, VirviPlatformAdapter } from '@virvixr/shared'
import { add, eulerDegreesToQuat, rotateVector } from '../transform/math.js'

/** The geometry lives in @virvixr/shared (the server's backup bakes the same parts); re-exported for core's callers. */
export { frameParts }
export type { FramePart, FramePartRole } from '@virvixr/shared'

/** The parts placed in the world around a picture with this transform. */
export function framePartTransforms(frame: FrameSettings, t: TransformData): (FramePart & { transform: TransformData })[] {
  const q = eulerDegreesToQuat(t.rotation)
  return frameParts(frame, t.scale).map((p) => ({
    ...p,
    transform: { position: add(t.position, rotateVector(q, p.position)), rotation: t.rotation, scale: p.scale },
  }))
}

/** Every scene runtime (Decentraland, Hyperfy, Node) has a console; core's lib setting doesn't declare one. */
declare const console: { log(...args: unknown[]): void }

/** Adapters that have already said frames were left off (said once per scene runtime). */
const toldLimit = new WeakSet<object>()

/**
 * Room for `n` more entities under the platform's limit. Without a known limit (capabilities.maxEntities) or a count
 * (entityCount), there is always room.
 */
function roomFor(adapter: VirviPlatformAdapter, n: number): boolean {
  const max = adapter.capabilities?.maxEntities
  if (max === undefined || !adapter.entityCount) return true
  return adapter.entityCount() + n <= max
}

/** One item copy's frame: its entities, redrawn in place while the frame looks the same. */
export class ItemFrame {
  private entities: EntityHandle[] = []
  /** What the entities show (shape and colour of each), to know when they must be made again. */
  private look = ''

  constructor(private adapter: VirviPlatformAdapter) {}

  /**
   * Draw the frame around a picture with this transform; null (or a platform without solid shapes) removes it.
   * A frame that would take the scene over its entity limit is left off (never the picture itself), until it changes.
   */
  draw(frame: FrameSettings | null, t: TransformData): void {
    const parts = frame && this.adapter.setSolidShape ? framePartTransforms(frame, t) : []
    const look = parts.map((p) => `${p.shape}:${p.color}`).join('|')
    if (look !== this.look && `skipped:${look}` !== this.look) {
      this.dispose()
      if (parts.length && !roomFor(this.adapter, parts.length)) {
        this.look = `skipped:${look}`
        if (!toldLimit.has(this.adapter)) {
          toldLimit.add(this.adapter)
          console.log("[Virvi] Some frames aren't shown: the scene is at Decentraland's entity limit for its parcels")
        }
        return
      }
      this.look = look
      for (const p of parts) {
        const e = this.adapter.createEntity()
        this.adapter.setSolidShape!(e, p.shape, frameColorRgb(p.color))
        this.entities.push(e)
      }
    }
    parts.forEach((p, i) => { if (this.entities[i] !== undefined) this.adapter.setTransform(this.entities[i], p.transform) })
  }

  dispose(): void {
    for (const e of this.entities) this.adapter.destroyEntity(e)
    this.entities = []
    this.look = ''
  }
}
