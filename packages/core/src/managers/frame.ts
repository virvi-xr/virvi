/**
 * Frames around images and video screens (LIV-129): the geometry, and the entities that draw it.
 *
 * A frame is four boxes around the picture's edges (Gallery adds a mat of four plane strips between them and the
 * picture): 48 triangles, 56 for Gallery, no models to download. The picture is the item's 1×1 plane scaled by its instance scale, so the
 * frame is sized from |scale.x| × |scale.y| and placed with the instance's position and rotation; managers redraw it
 * whenever the instance moves, is resized or previewed. Pictures show on both sides, so a frame has no front.
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

/**
 * Bar depth as a multiple of the bar width, and the most it may be (metres). Bars are centred on the picture plane:
 * pictures show on both sides, so a frame must read the same from either. The cap keeps a thick frame from reaching
 * far behind the picture (through a wall it hangs on): never more than 2 cm either side.
 */
const DEPTH: Record<FrameStyle, { k: number; max: number }> = {
  thin: { k: 1, max: 0.02 },
  classic: { k: 2, max: 0.04 }, // deeper, raised
  gallery: { k: 1.2, max: 0.03 },
}

/**
 * The parts of a frame around a picture of this scale, in the picture's own space; none for a zero-size picture.
 * Nothing overlaps the picture: the bars are outside its edges and Gallery's mat is four strips in the band between
 * the picture and the bars, in the picture's plane (so it covers neither side and nothing z-fights).
 */
export function frameParts(frame: FrameSettings, scale: Vec3): FramePart[] {
  const w = Math.abs(scale.x)
  const h = Math.abs(scale.y)
  if (!(w > 0) || !(h > 0)) return []
  const short = Math.min(w, h)
  const t = (frame.thickness / 100) * short
  const mat = frame.style === 'gallery' ? (FRAME_MAT.width / 100) * short : 0
  const { k, max } = DEPTH[frame.style]
  const depth = Math.min(k * t, max)
  // The opening the bars go around: the picture, or the picture and its mat
  const ix = w / 2 + mat
  const iy = h / 2 + mat
  const box = (role: FramePartRole, x: number, y: number, sx: number, sy: number): FramePart => ({
    role, shape: 'box', color: frame.color, position: { x, y, z: 0 }, scale: { x: sx, y: sy, z: depth },
  })
  const parts = [
    box('top', 0, iy + t / 2, 2 * (ix + t), t),
    box('bottom', 0, -(iy + t / 2), 2 * (ix + t), t),
    box('left', -(ix + t / 2), 0, t, 2 * iy),
    box('right', ix + t / 2, 0, t, 2 * iy),
  ]
  if (mat > 0) {
    const strip = (x: number, y: number, sx: number, sy: number): FramePart => ({
      role: 'mat', shape: 'plane', color: FRAME_MAT.color, position: { x, y, z: 0 }, scale: { x: sx, y: sy, z: 1 },
    })
    parts.push(
      strip(0, h / 2 + mat / 2, 2 * ix, mat), // top and bottom span the band's full width
      strip(0, -(h / 2 + mat / 2), 2 * ix, mat),
      strip(-(w / 2 + mat / 2), 0, mat, h), // the sides fill between them
      strip(w / 2 + mat / 2, 0, mat, h),
    )
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
