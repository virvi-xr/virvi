export type MapBounds = { minX: number; minZ: number; maxX: number; maxZ: number }
const TILE = 16

function parse(p: string | null): [number, number] | null {
  const m = p ? /^(-?\d+),(-?\d+)$/.exec(p.trim()) : null
  return m ? [Number(m[1]), Number(m[2])] : null
}

export function parcelRects(parcels: string[], baseParcel: string | null) {
  const base = parse(baseParcel) ?? parse(parcels[0] ?? null)
  if (!base) return []
  return parcels.flatMap((label) => {
    const p = parse(label)
    return p ? [{ label, x: (p[0] - base[0]) * TILE, z: (p[1] - base[1]) * TILE, size: TILE as 16 }] : []
  })
}

export function mapBounds(parcels: string[], baseParcel: string | null, points: Array<{ x: number; z: number }>): MapBounds {
  const rects = parcelRects(parcels, baseParcel)
  if (rects.length) {
    return {
      minX: Math.min(...rects.map((r) => r.x)),
      minZ: Math.min(...rects.map((r) => r.z)),
      maxX: Math.max(...rects.map((r) => r.x + TILE)),
      maxZ: Math.max(...rects.map((r) => r.z + TILE)),
    }
  }
  if (!points.length) return { minX: 0, minZ: 0, maxX: TILE, maxZ: TILE }
  const snapDown = (v: number) => Math.floor(v / TILE) * TILE
  const snapUp = (v: number) => (Math.floor(v / TILE) + 1) * TILE
  // Loops, not Math.min(...): a big heatmap has more points than a call can take as arguments.
  let [minX, minZ, maxX, maxZ] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.z < minZ) minZ = p.z
    if (p.z > maxZ) maxZ = p.z
  }
  return { minX: snapDown(minX), minZ: snapDown(minZ), maxX: snapUp(maxX), maxZ: snapUp(maxZ) }
}

export function toSvg(b: MapBounds, width: number) {
  const w = b.maxX - b.minX
  const h = b.maxZ - b.minZ
  const k = width / w
  return { height: h * k, px: (x: number) => (x - b.minX) * k, py: (z: number) => (b.maxZ - z) * k }
}
