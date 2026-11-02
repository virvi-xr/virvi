// Triangle count and real-world size of a GLB, for catalog models whose source doesn't give them.
import { NodeIO, type Node } from '@gltf-transform/core'
import { getBounds } from '@gltf-transform/functions'

const TRIANGLES = 4
// Decentraland: a mesh named *_collider (optionally _box/_sphere/_capsule) is invisible collision, never drawn
const COLLIDER = /_collider(_(box|sphere|capsule))?$/i
const round = (n: number) => Math.round(n * 1000) / 1000

/**
 * Throws when the file isn't a readable GLB. The bbox is the default scene's world-space size in meters. `visibleOnly`
 * leaves *_collider meshes out of the triangle count (they're never drawn).
 */
export async function glbStats(buf: Buffer, opts: { visibleOnly?: boolean } = {}): Promise<{ triangles: number; bbox: { x: number; y: number; z: number } }> {
  const doc = await new NodeIO().readBinary(new Uint8Array(buf))
  const root = doc.getRoot()
  const scene = root.getDefaultScene() ?? root.listScenes()[0]
  if (!scene) throw new Error('GLB has no scene')
  let triangles = 0
  scene.traverse((node: Node) => {
    if (opts.visibleOnly && (COLLIDER.test(node.getName()) || COLLIDER.test(node.getMesh()?.getName() ?? ''))) return
    for (const prim of node.getMesh()?.listPrimitives() ?? []) {
      if (prim.getMode() !== TRIANGLES) continue
      const count = prim.getIndices()?.getCount() ?? prim.getAttribute('POSITION')?.getCount() ?? 0
      triangles += Math.floor(count / 3)
    }
  })
  const { min, max } = getBounds(scene)
  const size = (i: number) => (Number.isFinite(max[i] - min[i]) ? round(max[i] - min[i]) : 0)
  return { triangles, bbox: { x: size(0), y: size(1), z: size(2) } }
}
