import { describe, it, expect, vi, beforeEach } from 'vitest'

// SDK 7 stand-ins that remember MeshRenderer and Material values per entity.
const sdk = vi.hoisted(() => {
  const meshes = new Map<number, any>()
  const materials = new Map<number, any>()
  const colliders = new Map<number, any>()
  const stub = () => ({})
  const component = { createOrReplace: stub, getMutableOrNull: stub, getOrNull: () => null, has: () => false, deleteFrom: stub }
  return {
    meshes,
    materials,
    colliders,
    reset() { meshes.clear(); materials.clear(); colliders.clear() },
    ecs: {
      engine: { addEntity: () => 1, removeEntity: stub, addSystem: stub },
      GltfContainer: component,
      MeshCollider: { setBox: (e: number) => void colliders.set(e, 'box'), setPlane: (e: number) => void colliders.set(e, 'plane'), deleteFrom: stub },
      ColliderLayer: { CL_NONE: 0, CL_POINTER: 1, CL_PHYSICS: 2 },
      Transform: component,
      MeshRenderer: {
        setPlane: (e: number, uvs?: number[]) => void meshes.set(e, { plane: uvs ?? null }),
        setBox: (e: number, uvs?: number[]) => void meshes.set(e, { box: uvs ?? null }),
      },
      Material: { setPbrMaterial: (e: number, m: any) => void materials.set(e, m), setBasicMaterial: stub, Texture: { Common: stub, Video: stub } },
      AudioSource: component, Name: component, TextShape: component, PointerEvents: component, VideoPlayer: component, VideoEvent: { has: () => false },
      videoEventsSystem: { getVideoState: stub }, VideoState: {}, pointerEventsSystem: { onPointerDown: stub, removeOnPointerDown: stub }, InputAction: {},
    },
  }
})
vi.mock('@dcl/sdk/ecs', () => sdk.ecs)
vi.mock('@dcl/sdk/math', () => ({
  Vector3: { create: (x: number, y: number, z: number) => ({ x, y, z }) },
  Quaternion: { fromEulerDegrees: () => ({ x: 0, y: 0, z: 0, w: 1 }) },
  Color3: { White: () => ({ r: 1, g: 1, b: 1 }), Black: () => ({ r: 0, g: 0, b: 0 }), create: (r: number, g: number, b: number) => ({ r, g, b }) },
  Color4: { create: (r: number, g: number, b: number, a: number) => ({ r, g, b, a }) },
}))

import { DclAdapter } from '../src/DclAdapter.js'

/** Frame parts (LIV-129): solid colour boxes and planes, with no texture, no glow and nothing to click or bump into. */
describe('setSolidShape', () => {
  let adapter: DclAdapter
  beforeEach(() => { sdk.reset(); adapter = new DclAdapter() })

  it('a box is a MeshRenderer box with an opaque, unlit-free colour material', () => {
    adapter.setSolidShape(3, 'box', { r: 0.4, g: 0.3, b: 0.2 })
    expect(sdk.meshes.get(3)).toHaveProperty('box')
    const m = sdk.materials.get(3)
    expect(m.albedoColor).toEqual({ r: 0.4, g: 0.3, b: 0.2, a: 1 })
    expect(m.texture).toBeUndefined()
    expect(m.emissiveIntensity ?? 0).toBe(0)
    expect(m.metallic).toBe(0)
  })

  it('a plane is a MeshRenderer plane', () => {
    adapter.setSolidShape(4, 'plane', { r: 1, g: 1, b: 1 })
    expect(sdk.meshes.get(4)).toHaveProperty('plane')
    expect(sdk.materials.get(4).albedoColor).toEqual({ r: 1, g: 1, b: 1, a: 1 })
  })

  it('adds no collider, so frames never block players or clicks', () => {
    adapter.setSolidShape(5, 'box', { r: 0, g: 0, b: 0 })
    expect(sdk.colliders.has(5)).toBe(false)
  })
})
