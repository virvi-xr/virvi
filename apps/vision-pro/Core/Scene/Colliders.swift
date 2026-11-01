import Foundation
import GLTFKit2
import RealityKit

/// Decentraland's convention: a node or mesh named with "_collider" is collision only and is never drawn.
func isColliderName(_ name: String?) -> Bool {
    name?.lowercased().contains("_collider") == true
}

/// The nodes whose mesh (rather than the node itself) carries a collider name: the converted entity keeps only the
/// node's name.
func meshColliderNodes(_ scene: GLTFScene) -> Set<String> {
    var names: Set<String> = []
    var stack = scene.nodes
    while let node = stack.popLast() {
        stack.append(contentsOf: node.childNodes)
        if let name = node.name, isColliderName(node.mesh?.name) { names.insert(name) }
    }
    return names
}

/// Takes the collider parts (and everything under them) out of a converted model; returns how many it took.
@MainActor @discardableResult
func removeColliders(in model: Entity, meshColliderNodes: Set<String>) -> Int {
    var removed = 0
    var stack = Array(model.children)
    while let e = stack.popLast() {
        if isColliderName(e.name) || meshColliderNodes.contains(e.name) {
            e.removeFromParent()
            removed += 1
        } else {
            stack.append(contentsOf: e.children)
        }
    }
    return removed
}
