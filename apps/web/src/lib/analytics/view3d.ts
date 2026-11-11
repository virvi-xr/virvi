// What the 3D heatmap frames (LIV-85). The ground covers everything drawn, live dots included; the camera frames only
// the parcels, or without parcels the heat and the models. Live dots move every few seconds, and on a location without
// parcels a dot entering a new 16 m tile would otherwise re-frame the camera and snap it back mid-orbit.
import { mapBounds, type MapBounds } from './parcel-map'

type XZ = { x: number; z: number }

export interface Camera3D {
  /** Changes only when the framed area does: the camera is set again only then. */
  key: string
  position: [number, number, number]
  target: [number, number, number]
  maxDistance: number
}

export function view3d(parcels: string[], baseParcel: string | null, cells: XZ[], live: XZ[], footprints: XZ[]): { ground: MapBounds; camera: Camera3D } {
  const frame = mapBounds(parcels, baseParcel, [...cells, ...footprints])
  const ground = live.length ? mapBounds(parcels, baseParcel, [...cells, ...live, ...footprints]) : frame
  const size = Math.max(frame.maxX - frame.minX, frame.maxZ - frame.minZ)
  // Scene z is north; three.js north is -Z. The camera starts south of the map looking north.
  const cx = (frame.minX + frame.maxX) / 2
  const cz = -(frame.minZ + frame.maxZ) / 2
  return {
    ground,
    camera: {
      key: `${cx},${cz},${size}`,
      position: [cx, size * 0.8 + 6, cz + size * 1.1 + 8],
      target: [cx, 0, cz],
      maxDistance: size * 4 + 40,
    },
  }
}
