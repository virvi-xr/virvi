/**
 * Frames around images and video screens (LIV-129): the geometry, and the entities that draw it.
 *
 * A frame is four boxes around the picture's edges (Gallery adds one plane behind it, the mat): at most 50
 * triangles, no models to download. The picture is the item's 1×1 plane scaled by its instance scale, so the
 * frame is sized from |scale.x| × |scale.y| and placed with the instance's position and rotation; managers redraw it
 * whenever the instance moves, is resized or previewed. Its front is -z, the side the screen's showing sign sits on.
 * Drawn only on platforms with `setSolidShape`; elsewhere nothing is created.
 */
import { FRAME_MAT, frameColorRgb } from '@virvixr/shared'
import type { EntityHandle, FrameSettings, FrameStyle, TransformData, Vec3, VirviPlatformAdapter } from '@virvixr/shared'
import { add, eulerDegreesToQuat, rotateVector } from '../transform/math.js'

export type FramePartRole = 'top' | 'bottom' | 'left' | 'right' | 'mat'

export interface FramePart {
  role: FramePartRole
  shape: 'box' | 'plane'
  color: string
  /** In the picture's own space (metres, unrotated, centred on the picture). */
  position: Vec3
  scale: Vec3
}

/** How far the bars stand out in front of the picture and reach behind it, as multiples of the bar width. */
const PROFILE: Record<FrameStyle, { front: number; back: number }> = {
  thin: { front: 0.6, back: 0.4 },
  classic: { front: 1.2, back: 0.4 }, // deeper, raised
  gallery: { front: 0.8, back: 0.4 },
}

/** The mat sits this far behind the picture (at most), always inside the bars' depth. */
const MAT_GAP_M = 0.01

/** The parts of a frame around a picture of this scale, in the picture's own space; none for a zero-size picture. */
export function frameParts(frame: FrameSettings, scale: Vec3): FramePart[] {
  const w = Math.abs(scale.x)
  const h = Math.abs(scale.y)
  if (!(w > 0) || !(h > 0)) return []
  const short = Math.min(w, h)
  const t = (frame.thickness / 100) * short
  const mat = frame.style === 'gallery' ? (FRAME_MAT.width / 100) * short : 0
  const { front, back } = PROFILE[frame.style]
  const depth = (front + back) * t
  const z = ((back - front) * t) / 2
  // The opening the bars go around: the picture, or the picture and its mat
  const ix = w / 2 + mat
  const iy = h / 2 + mat
  const bar = (role: FramePartRole, x: number, y: number, sx: number, sy: number): FramePart => ({
    role, shape: 'box', color: frame.color, position: { x, y, z }, scale: { x: sx, y: sy, z: depth },
  })
  const parts = [
    bar('top', 0, iy + t / 2, 2 * (ix + t), t),
    bar('bottom', 0, -(iy + t / 2), 2 * (ix + t), t),
    bar('left', -(ix + t / 2), 0, t, 2 * iy),
    bar('right', ix + t / 2, 0, t, 2 * iy),
  ]
  if (mat > 0) {
    const gap = Math.min(MAT_GAP_M, (back * t) / 2)
    parts.push({ role: 'mat', shape: 'plane', color: FRAME_MAT.color, position: { x: 0, y: 0, z: gap }, scale: { x: 2 * ix, y: 2 * iy, z: 1 } })
  }
  return parts
}

/** The parts placed in the world around a picture with this transform. */
export function framePartTransforms(frame: FrameSettings, t: TransformData): (FramePart & { transform: TransformData })[] {
  const q = eulerDegreesToQuat(t.rotation)
  return frameParts(frame, t.scale).map((p) => ({
    ...p,
    transform: { position: add(t.position, rotateVector(q, p.position)), rotation: t.rotation, scale: p.scale },
  }))
}

/** One item copy's frame: its entities, redrawn in place while the frame looks the same. */
export class ItemFrame {
  private entities: EntityHandle[] = []
  /** What the entities show (shape and colour of each), to know when they must be made again. */
  private look = ''

  constructor(private adapter: VirviPlatformAdapter) {}

  /** Draw the frame around a picture with this transform; null (or a platform without solid shapes) removes it. */
  draw(frame: FrameSettings | null, t: TransformData): void {
    const parts = frame && this.adapter.setSolidShape ? framePartTransforms(frame, t) : []
    const look = parts.map((p) => `${p.shape}:${p.color}`).join('|')
    if (look !== this.look) {
      this.dispose()
      this.look = look
      for (const p of parts) {
        const e = this.adapter.createEntity()
        this.adapter.setSolidShape!(e, p.shape, frameColorRgb(p.color))
        this.entities.push(e)
      }
    }
    parts.forEach((p, i) => this.adapter.setTransform(this.entities[i], p.transform))
  }

  dispose(): void {
    for (const e of this.entities) this.adapter.destroyEntity(e)
    this.entities = []
    this.look = ''
  }
}
