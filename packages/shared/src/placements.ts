/**
 * The placements snapshot a Virvi-built Decentraland scene deploys (LIV-134): every placed copy of the active preset's
 * Virvi-synced GLB models, at `virvi/placements.json`. The runtime reads it with `readFile` and creates the models
 * before it talks to Virvi, so Decentraland's LOD/map builder (which runs the scene with no network and made-up
 * scene metadata) sees them, and visitors see the buildings before the live scene arrives. Live state then adopts each
 * entity by its instance id.
 *
 * Transforms are each instance's own, exactly as stored, as the live runtime applies them (it ignores parents). Rotation
 * is Euler degrees, turned into a quaternion the same way as the live runtime, so an adopted entity needs no change.
 */
import type { Vec3 } from './types/math.js'

export const PLACEMENTS_FILE = 'virvi/placements.json'

export interface Placement {
  instanceId: string
  elementId: string
  /** Scene-relative deployed path of the model, `models/virvi/<basename>.glb`. */
  src: string
  position: Vec3
  /** Euler degrees. */
  rotation: Vec3
  scale: Vec3
  /** Collides with its visible meshes (the live runtime's mesh collider). */
  collisions: boolean
}

type Triple = [number, number, number]
interface FileCopy { i: string; p?: Triple; r?: Triple; s?: Triple; c?: 1 }
interface FileModel { e: string; src: string; at: FileCopy[] }

const triple = (v: Vec3): Triple => [v.x, v.y, v.z]
const isDefault = (v: Vec3, d: number) => v.x === d && v.y === d && v.z === d

/** The file's text: copies grouped under their element (in the order given), default transforms left out. */
export function encodePlacements(list: Placement[]): string {
  const models: FileModel[] = []
  let last: FileModel | undefined
  for (const p of list) {
    if (!last || last.e !== p.elementId || last.src !== p.src) {
      last = { e: p.elementId, src: p.src, at: [] }
      models.push(last)
    }
    const copy: FileCopy = { i: p.instanceId }
    if (!isDefault(p.position, 0)) copy.p = triple(p.position)
    if (!isDefault(p.rotation, 0)) copy.r = triple(p.rotation)
    if (!isDefault(p.scale, 1)) copy.s = triple(p.scale)
    if (p.collisions) copy.c = 1
    last.at.push(copy)
  }
  return JSON.stringify({ v: 1, models })
}

function vec(raw: unknown, d: number): Vec3 | null {
  if (raw === undefined) return { x: d, y: d, z: d }
  if (!Array.isArray(raw) || raw.length !== 3 || !raw.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  return { x: raw[0], y: raw[1], z: raw[2] }
}

/** A scene-relative file path: no scheme, not absolute, no `..`. */
const scenePath = (s: unknown): s is string =>
  typeof s === 'string' && s.length > 0 && !/^[a-z][a-z0-9+.-]*:/i.test(s) && !s.startsWith('/') && !s.split('/').includes('..')

/** Every copy the file places; [] for anything that is not a v1 snapshot. A copy it can't place is skipped. */
export function decodePlacements(text: string): Placement[] {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return []
  }
  const models = (doc as { v?: unknown; models?: unknown } | null)
  if (!models || typeof models !== 'object' || models.v !== 1 || !Array.isArray(models.models)) return []
  const out: Placement[] = []
  for (const m of models.models as unknown[]) {
    const model = m as Partial<FileModel> | null
    if (!model || typeof model !== 'object' || !scenePath(model.src) || !Array.isArray(model.at)) continue
    for (const c of model.at as unknown[]) {
      const copy = c as Partial<FileCopy> | null
      if (!copy || typeof copy !== 'object' || typeof copy.i !== 'string' || !copy.i) continue
      const position = vec(copy.p, 0)
      const rotation = vec(copy.r, 0)
      const scale = vec(copy.s, 1)
      if (!position || !rotation || !scale) continue
      out.push({
        instanceId: copy.i, elementId: typeof model.e === 'string' ? model.e : '', src: model.src,
        position, rotation, scale, collisions: copy.c === 1,
      })
    }
  }
  return out
}
