import { describe, it, expect } from 'vitest'
import { view3d } from './view3d'

describe('3D heatmap view (LIV-85)', () => {
  const cells = [{ x: 3, z: 4 }, { x: 20, z: 2 }]
  const footprint = [{ x: 1, z: 1 }]

  it('frames heat and models; without parcels, live dots grow the ground but never move the camera', () => {
    const still = view3d([], null, cells, [], footprint)
    const moved = view3d([], null, cells, [{ x: 70, z: -30 }], footprint)
    expect(moved.camera).toEqual(still.camera)
    expect(moved.ground).not.toEqual(still.ground)
    expect(moved.ground).toMatchObject({ maxX: 80, minZ: -32 })
  })

  it('the camera key changes only when what it frames does', () => {
    const a = view3d([], null, cells, [], [])
    expect(view3d([], null, cells.map((c) => ({ ...c })), [{ x: 1, z: 1 }], []).camera.key).toBe(a.camera.key)
    expect(view3d([], null, [...cells, { x: 100, z: 100 }], [], []).camera.key).not.toBe(a.camera.key)
  })

  it('with parcels, the parcels are the frame and the ground', () => {
    const v = view3d(['0,0', '1,0'], '0,0', cells, [{ x: 70, z: 70 }], [])
    expect(v.ground).toEqual({ minX: 0, minZ: 0, maxX: 32, maxZ: 16 })
    // South of the map (three.js +Z), above it, looking at its middle (north is -Z).
    expect(v.camera.target).toEqual([16, 0, -8])
    expect(v.camera.position[0]).toBe(16)
    expect(v.camera.position[2]).toBeGreaterThan(-8)
  })
})
