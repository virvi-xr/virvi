import { describe, it, expect, vi, beforeEach } from 'vitest'

// SDK 7 stand-ins that remember GltfContainer and MeshCollider values per entity.
const sdk = vi.hoisted(() => {
  const gltf = new Map<number, any>()
  const colliders = new Map<number, any>()
  const stub = () => ({})
  const component = { createOrReplace: stub, getMutableOrNull: stub, getOrNull: () => null, has: () => false, deleteFrom: stub }
  return {
    gltf,
    colliders,
    reset() { gltf.clear(); colliders.clear() },
    ecs: {
      engine: { addEntity: () => 1, removeEntity: stub, addSystem: stub },
      GltfContainer: {
        createOrReplace: (e: number, v: any) => void gltf.set(e, { ...v }),
        getMutableOrNull: (e: number) => gltf.get(e) ?? null,
        getOrNull: (e: number) => gltf.get(e) ?? null,
        has: (e: number) => gltf.has(e),
        deleteFrom: (e: number) => void gltf.delete(e),
      },
      MeshCollider: {
        setBox: (e: number, l: any) => void colliders.set(e, { box: l }),
        setSphere: (e: number, l: any) => void colliders.set(e, { sphere: l }),
        setPlane: (e: number, l: any) => void colliders.set(e, { plane: l }),
        deleteFrom: (e: number) => void colliders.delete(e),
      },
      ColliderLayer: { CL_NONE: 0, CL_POINTER: 1, CL_PHYSICS: 2 },
      Transform: component, MeshRenderer: { setPlane: stub }, Material: { setPbrMaterial: stub, setBasicMaterial: stub, Texture: { Common: stub, Video: stub } },
      AudioSource: component, Name: component, TextShape: component, PointerEvents: component, VideoPlayer: component, VideoEvent: { has: () => false },
      videoEventsSystem: { getVideoState: stub }, VideoState: {}, pointerEventsSystem: { onPointerDown: stub, removeOnPointerDown: stub }, InputAction: {},
    },
  }
})
vi.mock('@dcl/sdk/ecs', () => sdk.ecs)
vi.mock('@dcl/sdk/math', () => ({
  Vector3: { create: (x: number, y: number, z: number) => ({ x, y, z }) },
  Quaternion: { fromEulerDegrees: () => ({ x: 0, y: 0, z: 0, w: 1 }) },
  Color3: { White: () => ({}), create: () => ({}) }, Color4: { create: () => ({}) },
}))

import { DclAdapter } from '../src/DclAdapter.js'

describe('model collisions use the model\'s own meshes', () => {
  let adapter: DclAdapter
  beforeEach(() => { sdk.reset(); adapter = new DclAdapter() })

  it('a mesh collider on a model turns on its visible-mesh physics collisions, with no flat plane', () => {
    adapter.setGltfModel(7, 'models/virvi/chair.glb')
    adapter.setCollider(7, { type: 'mesh' })
    expect(sdk.gltf.get(7)).toMatchObject({ src: 'models/virvi/chair.glb', visibleMeshesCollisionMask: 2 })
    expect(sdk.colliders.has(7)).toBe(false)
  })

  it('survives the model being swapped, whichever comes first', () => {
    adapter.setCollider(8, { type: 'mesh' }) // before the model loads
    adapter.setGltfModel(8, 'models/virvi/a.glb')
    expect(sdk.gltf.get(8).visibleMeshesCollisionMask).toBe(2)
    adapter.setGltfModel(8, 'models/virvi/b.glb')
    expect(sdk.gltf.get(8)).toMatchObject({ src: 'models/virvi/b.glb', visibleMeshesCollisionMask: 2 })
  })

  it('removing collisions turns the mask off and stays off after a swap', () => {
    adapter.setGltfModel(9, 'models/virvi/a.glb')
    adapter.setCollider(9, { type: 'mesh' })
    adapter.removeCollider(9)
    expect(sdk.gltf.get(9).visibleMeshesCollisionMask).toBe(0)
    adapter.setGltfModel(9, 'models/virvi/b.glb')
    expect(sdk.gltf.get(9).visibleMeshesCollisionMask ?? 0).toBe(0)
  })

  it('box colliders are unchanged', () => {
    adapter.setCollider(10, { type: 'box' })
    expect(sdk.colliders.get(10)).toEqual({ box: [2] })
  })
})

describe('a destroyed entity forgets its collisions', () => {
  it('a reused entity number starts without collisions', () => {
    sdk.reset()
    const adapter = new DclAdapter()
    adapter.setCollider(11, { type: 'mesh' })
    adapter.destroyEntity(11)
    adapter.setGltfModel(11, 'models/virvi/c.glb')
    expect(sdk.gltf.get(11).visibleMeshesCollisionMask ?? 0).toBe(0)
  })
})
