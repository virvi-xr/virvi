// The linked scene's layout for the bird's-eye heatmap (LIV-85): models placed by their world matrix (for the
// top-down render, and their footprint when the GLB can't be drawn), other elements as icons at their positions.
import { applyMat4, footprintXZ, threeToScene, worldMatrices, type Mat4 } from '@/lib/scene-transform'
import type { LayoutItem } from './types'

export interface PlacedModel { id: string; name: string; src: string | null; matrix: Mat4; footprint: Array<{ x: number; z: number }> }
export interface PlacedIcon { id: string; name: string; type: string; x: number; y: number; z: number }

export function placeLayout(items: LayoutItem[]): { models: PlacedModel[]; icons: PlacedIcon[] } {
  const matrices = worldMatrices(items)
  const models: PlacedModel[] = []
  const icons: PlacedIcon[] = []
  for (const i of items) {
    const matrix = matrices.get(i.id)!
    if (i.type === 'model') {
      models.push({ id: i.id, name: i.name, src: i.src, matrix, footprint: footprintXZ(matrix, i.dimensions) })
    } else {
      const [x, y, z] = threeToScene(applyMat4(matrix, [0, 0, 0]))
      icons.push({ id: i.id, name: i.name, type: i.type, x, y, z })
    }
  }
  return { models, icons }
}

export { iconFor } from './icons'
