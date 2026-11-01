import RealityKit
import UIKit

/// Marks a gizmo part that a pinch-drag can grab.
struct GizmoHandleComponent: Component {
    var handle: GizmoHandle
}

/// The selected item's handles as RealityKit entities, in the Decentraland gizmo's colours
/// (packages/adapter-dcl/src/transform/gizmo.ts): Move arrows (X, Y, Z; only the locked one when Move is locked),
/// rotation rings and resize handles (white uniform corner, coloured stretch handles; no Z stretch on flat items).
/// Arrows and rings sit on the scene's axes; resize handles are turned with the item, as in Decentraland.
///
/// `root` lives in the scene root (Virvi coordinates on RealityKit axes). Every part's collision shape is at least
/// `gizmoHandleSize(distance:)` across, which grows with the builder's distance so it stays easy to hit at 2–5 m.
@MainActor
final class Gizmo {
    let root = Entity()
    private let itemRoot = Entity()
    private var builtFor: String?

    /// gizmo.ts COLORS and UNIFORM_COLOR.
    static func color(_ axis: GizmoAxis) -> UIColor {
        switch axis {
        case .x: UIColor(red: 0.95, green: 0.2, blue: 0.2, alpha: 1)
        case .y: UIColor(red: 0.2, green: 0.85, blue: 0.3, alpha: 1)
        case .z: UIColor(red: 0.25, green: 0.45, blue: 1, alpha: 1)
        }
    }

    static let uniformColor = UIColor.white
    private static let ringSegments = 32
    private static let arrowLength = 0.3

    init() {
        root.name = "virvi-gizmo"
        GizmoHandleComponent.registerComponent()
        root.addChild(itemRoot)
        root.isEnabled = false
    }

    /// The handle a pinch on `entity` grabbed, or nil when it isn't one of the gizmo's.
    func handle(of entity: Entity) -> GizmoHandle? {
        var e: Entity? = entity
        while let cur = e, cur !== root {
            if let h = cur.components[GizmoHandleComponent.self] { return h.handle }
            e = cur.parent
        }
        return nil
    }

    /// Shows this mode's handles at `t` (Virvi coordinates), or hides the gizmo when `t` is nil.
    func show(mode: EditMode, lock: AxisLock, transform t: ItemTransform?, flat: Bool, handleSize: Double) {
        guard let t else {
            root.isEnabled = false
            return
        }
        root.isEnabled = true
        let size = (handleSize * 100).rounded() / 100 // whole centimetres, so a small head move doesn't rebuild
        let built = "\(mode.rawValue):\(lock):\(flat):\(size):\(Self.key(t.scale))"
        if built != builtFor {
            builtFor = built
            build(mode: mode, lock: lock, scale: t.scale, flat: flat, size: size)
        }
        root.position = SIMD3<Float>(fromRealityKitPosition(t.position)) // the z mirror is its own inverse
        let r = toRealityKitTransform(position: Vec3(x: 0, y: 0, z: 0), rotation: Vec3(x: t.rotation.x, y: t.rotation.y, z: t.rotation.z),
                                      scale: Vec3(x: 1, y: 1, z: 1))
        itemRoot.orientation = r.orientation.float
    }

    private static func key(_ v: SIMD3<Double>) -> String {
        "\((v.x * 1000).rounded()),\((v.y * 1000).rounded()),\((v.z * 1000).rounded())"
    }

    // MARK: - Building

    private func build(mode: EditMode, lock: AxisLock, scale s: SIMD3<Double>, flat: Bool, size: Double) {
        for c in root.children where c !== itemRoot { c.removeFromParent() }
        for c in itemRoot.children { c.removeFromParent() }
        switch mode {
        case .move:
            for axis in GizmoAxis.allCases where Self.shows(axis, lock) {
                root.addChild(arrow(axis, from: gizmoHandleOffset(s[axis.index]), size: size))
            }
        case .rotate:
            let r = gizmoRingRadius(scale: s)
            for axis in GizmoAxis.allCases { root.addChild(ring(axis, radius: r, size: size)) }
        case .resize:
            let corner = SIMD3(gizmoHandleOffset(s.x), gizmoHandleOffset(s.y), gizmoHandleOffset(s.z))
            itemRoot.addChild(cube(.uniform, Self.uniformColor, at: corner, size: size))
            for axis in GizmoAxis.allCases where !(flat && axis == .z) {
                itemRoot.addChild(cube(.stretch(axis), Self.color(axis), at: axis.unit * gizmoHandleOffset(s[axis.index]), size: size))
            }
        }
    }

    private static func shows(_ axis: GizmoAxis, _ lock: AxisLock) -> Bool {
        switch lock {
        case .free: true
        case .x: axis == .x
        case .y: axis == .y
        case .z: axis == .z
        }
    }

    /// A Virvi direction or point on RealityKit axes.
    private static func rk(_ v: SIMD3<Double>) -> SIMD3<Float> { SIMD3<Float>(fromRealityKitPosition(v)) }

    private static func material(_ color: UIColor) -> UnlitMaterial {
        UnlitMaterial(color: color)
    }

    private func grabbable(_ e: Entity, _ handle: GizmoHandle, shape: ShapeResource) {
        e.components.set(CollisionComponent(shapes: [shape]))
        e.components.set(InputTargetComponent())
        e.components.set(HoverEffectComponent())
        e.components.set(GizmoHandleComponent(handle: handle))
    }

    /// A shaft and a cone tip pointing along +axis, starting `from` the item's centre; the whole arrow is the hit
    /// shape, `size` across.
    private func arrow(_ axis: GizmoAxis, from: Double, size: Double) -> Entity {
        let e = Entity()
        let dir = Self.rk(axis.unit)
        let length = Self.arrowLength + size
        e.orientation = simd_quatf(from: [0, 1, 0], to: dir)
        e.position = dir * Float(from + length / 2)
        let mat = Self.material(Self.color(axis))
        let shaftW = Float(max(0.012, size * 0.25))
        let shaft = ModelEntity(mesh: .generateBox(size: [shaftW, Float(Self.arrowLength), shaftW]), materials: [mat])
        shaft.position.y = Float(-size / 2)
        e.addChild(shaft)
        let tip = ModelEntity(mesh: .generateCone(height: Float(size), radius: Float(size * 0.45)), materials: [mat])
        tip.position.y = Float(Self.arrowLength / 2)
        e.addChild(tip)
        grabbable(e, .arrow(axis), shape: .generateBox(size: [Float(size), Float(length), Float(size)]))
        return e
    }

    /// A ring of short boxes around the item, square to `axis`; each segment's hit shape is `size` thick.
    private func ring(_ axis: GizmoAxis, radius r: Double, size: Double) -> Entity {
        let e = Entity()
        let (u, v): (SIMD3<Double>, SIMD3<Double>) = switch axis {
        case .x: ([0, 1, 0], [0, 0, 1])
        case .y: ([0, 0, 1], [1, 0, 0])
        case .z: ([1, 0, 0], [0, 1, 0])
        }
        let n = Self.ringSegments
        let segment = (2 * .pi * r / Double(n)) * 1.1
        let thick = Float(max(0.015, size * 0.3))
        let mat = Self.material(Self.color(axis))
        let mesh = MeshResource.generateBox(size: [thick, thick, Float(segment)])
        let shape = ShapeResource.generateBox(size: [Float(size), Float(size), Float(segment)])
        for i in 0..<n {
            let theta = (Double(i) + 0.5) / Double(n) * 2 * .pi
            let p = u * (r * cos(theta)) + v * (r * sin(theta))
            let tangent = u * -sin(theta) + v * cos(theta)
            let part = ModelEntity(mesh: mesh, materials: [mat])
            part.position = Self.rk(p)
            part.orientation = simd_quatf(from: [0, 0, 1], to: simd_normalize(Self.rk(tangent)))
            grabbable(part, .ring(axis), shape: shape)
            e.addChild(part)
        }
        return e
    }

    private func cube(_ handle: GizmoHandle, _ color: UIColor, at p: SIMD3<Double>, size: Double) -> Entity {
        let s = Float(size)
        let e = ModelEntity(mesh: .generateBox(size: s * 0.8), materials: [Self.material(color)])
        e.position = Self.rk(p)
        grabbable(e, handle, shape: .generateBox(size: SIMD3(repeating: s)))
        return e
    }
}
