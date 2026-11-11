import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  MODEL_TURN, toThreeTransform, composeThree, worldMatrices, applyMat4, footprintXZ, sceneToThree, threeToScene, orthoTopDown,
} from './scene-transform'
import { toSvg } from './analytics/parcel-map'

const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9))
const t = (p: [number, number, number], r: [number, number, number] = [0, 0, 0], s: [number, number, number] = [1, 1, 1]) => ({
  position: { x: p[0], y: p[1], z: p[2] }, rotation: { x: r[0], y: r[1], z: r[2] }, scale: { x: s[0], y: s[1], z: s[2] },
})

describe('scene transform (Virvi / Decentraland → three.js)', () => {
  it('mirrors z, negates the x and y turns, keeps yaw-pitch-roll (three.js YXZ) and the scale', () => {
    const m = toThreeTransform(t([20, 1, 10], [10, 90, 30], [2, 1, 3]))
    expect(m.position).toEqual([20, 1, -10])
    close(m.rotation, [(-10 * Math.PI) / 180, (-90 * Math.PI) / 180, (30 * Math.PI) / 180])
    expect(m.order).toBe('YXZ')
    expect(m.scale).toEqual([2, 1, 3])
    expect(MODEL_TURN).toBe(Math.PI)
  })

  it("composes the same matrix as three.js's Object3D", () => {
    const tr = t([3, 2, -7], [15, -40, 25], [1.5, 2, 0.5])
    const m = toThreeTransform(tr)
    const o = new THREE.Object3D()
    o.position.set(...m.position)
    o.rotation.set(m.rotation[0], m.rotation[1], m.rotation[2], 'YXZ')
    o.scale.set(...m.scale)
    o.updateMatrix()
    close(composeThree(tr), o.matrix.elements)
  })

  it('a 90° turn is clockwise seen from above: a child 2 m north of its parent ends up 2 m east', () => {
    const ms = worldMatrices([
      { id: 'p', parentId: null, ...t([20, 0, 10], [0, 90, 0]) },
      { id: 'c', parentId: 'p', ...t([0, 0, 2]) },
    ])
    close(threeToScene(applyMat4(ms.get('c')!, [0, 0, 0])), [22, 0, 10])
  })

  it('ignores a missing parent and breaks parent cycles', () => {
    const ms = worldMatrices([
      { id: 'a', parentId: 'gone', ...t([1, 0, 1]) },
      { id: 'b', parentId: 'c', ...t([1, 0, 0]) },
      { id: 'c', parentId: 'b', ...t([0, 0, 1]) },
    ])
    close(threeToScene(applyMat4(ms.get('a')!, [0, 0, 0])), [1, 0, 1])
    expect(ms.get('b')).toBeDefined()
    expect(ms.get('c')).toBeDefined()
  })

  it('an off-origin, rotated model: its footprint is where its rendered corners land, and the top-down camera puts both on the heat map', () => {
    // 4 m wide (x), 2 m deep (z), at (20, 10), turned 90°: 2 m east-west, 4 m north-south.
    const item = { id: 'm', parentId: null, ...t([20, 0, 10], [0, 90, 0]) }
    const matrix = worldMatrices([item]).get('m')!
    const poly = footprintXZ(matrix, { x: 4, y: 3, z: 2 })
    const xs = poly.map((p) => p.x)
    const zs = poly.map((p) => p.z)
    expect(Math.min(...xs)).toBeCloseTo(19)
    expect(Math.max(...xs)).toBeCloseTo(21)
    expect(Math.min(...zs)).toBeCloseTo(8)
    expect(Math.max(...zs)).toBeCloseTo(12)

    // The model as three.js draws it (group carrying the mapped transform, the model given MODEL_TURN inside).
    const group = new THREE.Group()
    const m = toThreeTransform(item)
    group.position.set(...m.position)
    group.rotation.set(m.rotation[0], m.rotation[1], m.rotation[2], 'YXZ')
    const model = new THREE.Object3D()
    model.rotation.y = MODEL_TURN
    group.add(model)
    group.updateMatrixWorld(true)
    // A glTF point 2 m along +x: Decentraland shows it x-mirrored, so 2 m along the model's own west...
    const p = model.localToWorld(new THREE.Vector3(2, 0, 0))
    // ...which, turned 90° clockwise, is north: (20, 12) in scene terms, on the footprint's edge.
    close(threeToScene([p.x, p.y, p.z]), [20, 0, 12])

    // The bird's-eye camera over a 2×2 parcel map projects that point to the same SVG spot as a heat cell there.
    const bounds = { minX: 0, minZ: 0, maxX: 32, maxZ: 32 }
    const W = 480
    const svg = toSvg(bounds, W)
    const o = orthoTopDown(bounds)
    const cam = new THREE.OrthographicCamera(o.left, o.right, o.top, o.bottom, o.near, o.far)
    cam.position.set(...o.position)
    cam.up.set(...o.up)
    cam.lookAt(...o.target)
    cam.updateMatrixWorld(true)
    const ndc = p.clone().project(cam)
    expect(((ndc.x + 1) / 2) * W).toBeCloseTo(svg.px(20), 6)
    expect(((1 - ndc.y) / 2) * svg.height).toBeCloseTo(svg.py(12), 6)
  })

  it('sceneToThree and threeToScene are inverses', () => {
    expect(sceneToThree({ x: 1, y: 2, z: 3 })).toEqual([1, 2, -3])
    expect(threeToScene([1, 2, -3])).toEqual([1, 2, 3])
  })
})
