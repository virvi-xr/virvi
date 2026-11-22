import Foundation
import RealityKit
import UIKit
import VirviARKit

// The Quest's apps/quest/app/src/main/java/io/virvi/ar/visitor/RingOutline.kt, in RealityKit.

let OUTLINE_THICKNESS_M = 0.004
let OUTLINE_SEGMENTS = 48
let OUTLINE_SHOW_MS: Int64 = 1_200

/// One short box of the outline, in the ring's plane (x right, y up, z out of the wall): its centre and turn about z.
struct OutlineSegment: Equatable {
    var x: Double
    var y: Double
    var angleRad: Double
    var lengthM: Double
}

/// `count` boxes laid round a ring of printed diameter `diameterM`, just outside its edge, overlapping slightly.
func outlineSegments(diameterM: Double, count: Int = OUTLINE_SEGMENTS) -> [OutlineSegment] {
    let r = diameterM / 2 + OUTLINE_THICKNESS_M / 2
    let length = 2 * .pi * r / Double(count) * 1.1
    return (0..<count).map { i in
        let a = 2 * .pi * Double(i) / Double(count)
        return OutlineSegment(x: r * cos(a), y: r * sin(a), angleRad: a, lengthM: length)
    }
}

/// The thin cyan ring flashed on a ring marker when the scene locks on: 48 boxes, 4 mm thick, the marker's printed
/// diameter, facing the marker's heading, shown for `OUTLINE_SHOW_MS`. Main thread only.
@MainActor
final class RingOutline: OutlineView {
    private let anchor = AnchorEntity(world: .zero)
    private var entity: Entity?
    private var hideAt: Int64 = 0

    init(arView: ARView) {
        arView.scene.addAnchor(anchor)
    }

    /// Shows the outline at `world` (Virvi world) facing `headingDeg` (degrees from +Z toward +X, into the room).
    func flash(world: Vec3, headingDeg: Double, diameterM: Double, nowMs: Int64) {
        clear()
        // Into the room in the Virvi world is (sin h, 0, cos h); in ARKit (z mirrored) (sin h, 0, -cos h), which is
        // local +z turned by pi - h about +y.
        let h = headingDeg * .pi / 180
        let normal = SIMD3<Float>(Float(sin(h)), 0, Float(-cos(h)))
        let root = Entity()
        root.orientation = simd_quatf(angle: Float(Double.pi - h), axis: [0, 1, 0])
        // A few millimetres off the wall, so the outline isn't lost in it.
        root.position = SIMD3<Float>(Float(world.x), Float(world.y), Float(-world.z)) + normal * 0.005
        let t = Float(OUTLINE_THICKNESS_M)
        let material = UnlitMaterial(color: UIColor(red: 0.2, green: 0.95, blue: 1, alpha: 1))
        let segments = outlineSegments(diameterM: diameterM)
        let mesh = MeshResource.generateBox(width: t, height: Float(segments.first?.lengthM ?? 0), depth: t)
        for s in segments {
            let box = ModelEntity(mesh: mesh, materials: [material]) // x radial, y along the ring
            box.position = [Float(s.x), Float(s.y), 0]
            box.orientation = simd_quatf(angle: Float(s.angleRad), axis: [0, 0, 1])
            root.addChild(box)
        }
        anchor.addChild(root)
        entity = root
        hideAt = nowMs + OUTLINE_SHOW_MS
    }

    func tick(nowMs: Int64) {
        if entity != nil && nowMs >= hideAt { clear() }
    }

    func clear() {
        entity?.removeFromParent()
        entity = nil
    }
}
