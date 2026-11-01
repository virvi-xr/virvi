import Foundation
import RealityKit

/// How an item catches a look-and-pinch in Edit layout.
enum PickShape: Equatable {
    /// A box around the item, padded so small things are easy to hit from across the room.
    case box(SIMD3<Float>)
    /// The item's own surfaces, so a building or floor doesn't swallow pinches meant for things inside or behind it.
    case mesh
}

/// Items longer than this on any side pick by their surfaces.
let meshPickThreshold: Float = 1.5
/// The smallest side of a padded pick box.
let minPickSide: Float = 0.15

func pickShape(extents: SIMD3<Float>) -> PickShape {
    extents.max() > meshPickThreshold ? .mesh : .box(simd_max(extents, SIMD3(repeating: minPickSide)))
}

/// One bar of the selection outline, in the item's space.
struct OutlineBar: Equatable {
    var center: SIMD3<Float>
    var size: SIMD3<Float>
}

/// A bar along each of the box's twelve edges.
func outlineBars(of b: BoundingBox, thickness t: Float) -> [OutlineBar] {
    var bars: [OutlineBar] = []
    for axis in 0..<3 {
        let (u, v) = ((axis + 1) % 3, (axis + 2) % 3)
        for cu in [b.min[u], b.max[u]] {
            for cv in [b.min[v], b.max[v]] {
                var center = b.center, size = SIMD3<Float>(repeating: t)
                center[u] = cu
                center[v] = cv
                size[axis] = b.extents[axis]
                bars.append(OutlineBar(center: center, size: size))
            }
        }
    }
    return bars
}

/// The Layout tab's Select: the element's first copy there is something to look at (sounds have none).
func firstSelectableKey(_ plan: [RenderItem], elementId: String) -> String? {
    plan.first { $0.elementId == elementId && $0.kind != .audio }?.key
}

/// The edit bar's middle label: in Place items don't take pinches, so it says how to get to them.
func selectionLabel(placing: Bool, selectedName: String?) -> String {
    if let selectedName { return selectedName }
    return placing ? "Placing the scene: press Done placing to pick items" : "Look at an item and pinch to select it"
}
