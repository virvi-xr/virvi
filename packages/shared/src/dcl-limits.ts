/**
 * Decentraland land geometry and per-parcel scene budget. A plot is a
 * rectangle of whole parcels; the server and web both derive limits from here.
 */

/** Edge length of one parcel in metres. */
export const DCL_PARCEL_M = 16
/** Largest single file a Decentraland scene deployment accepts. */
export const DCL_MAX_FILE_BYTES = 52_428_800
/** Decentraland's entity limit per parcel. */
export const DCL_ENTITIES_PER_PARCEL = 200
/**
 * Entities the runtime itself needs on top of the scene's own. Frames around images and video screens (LIV-129) are
 * made by the runtime too, but per framed copy: count them with `frameEntitiesIn` (frames.ts).
 */
export const RUNTIME_ENTITY_RESERVE = 20
/** Longest side of a plot, in parcels. */
export const MAX_PLOT_SIDE = 10

const BASE_LIMIT = 150

export interface Plot {
  width: number
  depth: number
  base: { x: number; y: number }
}

/** Every parcel of the plot as `"x,y"`, row-major from `base`. */
export function plotParcels(plot: Plot): string[] {
  const out: string[] = []
  for (let dy = 0; dy < plot.depth; dy++)
    for (let dx = 0; dx < plot.width; dx++) out.push(`${plot.base.x + dx},${plot.base.y + dy}`)
  return out
}

/** Parses an `"x,y"` parcel string; null when it is not two integers. */
export function parseParcel(p: string): { x: number; y: number } | null {
  const m = /^(-?\d+),(-?\d+)$/.exec(p)
  if (!m) return null
  return { x: Number(m[1]), y: Number(m[2]) }
}

/** Scene budget for a deployment covering `parcelCount` parcels. */
export function dclBudget(parcelCount: number): {
  triangles: number
  entities: number
  files: number
  maxFileBytes: number
} {
  return {
    triangles: parcelCount * 10_000,
    entities: parcelCount * DCL_ENTITIES_PER_PARCEL - RUNTIME_ENTITY_RESERVE,
    files: parcelCount * 200,
    maxFileBytes: DCL_MAX_FILE_BYTES,
  }
}

/** Plot footprint in metres along x and z. */
export function plotSizeM(plot: Plot): { x: number; z: number } {
  return { x: plot.width * DCL_PARCEL_M, z: plot.depth * DCL_PARCEL_M }
}

/** True when `plot` is a whole-parcel rectangle within the size and base limits. */
export function validPlot(plot: unknown): plot is Plot {
  if (!plot || typeof plot !== 'object') return false
  const p = plot as Partial<Plot>
  const side = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= MAX_PLOT_SIDE
  const coord = (n: unknown) => Number.isInteger(n) && Math.abs(n as number) <= BASE_LIMIT
  return (
    side(p.width) &&
    side(p.depth) &&
    !!p.base &&
    typeof p.base === 'object' &&
    coord(p.base.x) &&
    coord(p.base.y)
  )
}
