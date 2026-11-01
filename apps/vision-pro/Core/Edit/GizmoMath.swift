import Foundation
import simd

/// The gizmo's drag math, in Virvi scene coordinates (Decentraland's scene-local frame), ported from
/// packages/core/src/transform/session.ts for a pinch: the hand's position stands in for the mouse ray's hit.
enum GizmoAxis: CaseIterable, Equatable {
    case x, y, z
    var index: Int { self == .x ? 0 : self == .y ? 1 : 2 }
    var unit: SIMD3<Double> {
        var v = SIMD3<Double>(repeating: 0)
        v[index] = 1
        return v
    }
}

/// What a pinch-drag grabbed: the item itself, a move arrow, a rotation ring or a resize handle.
enum GizmoHandle: Equatable {
    case body
    case arrow(GizmoAxis)
    case ring(GizmoAxis)
    case uniform
    case stretch(GizmoAxis)

    func fits(_ mode: EditMode) -> Bool {
        switch (self, mode) {
        case (.body, .move), (.arrow, .move), (.ring, .rotate), (.uniform, .resize), (.stretch, .resize): true
        default: false
        }
    }
}

/// session.ts MIN_SCALE and MIN_GRAB_DISTANCE.
let GIZMO_MIN_SCALE = 0.05
let GIZMO_MIN_GRAB_DISTANCE = 0.01

private extension AxisLock {
    var axis: GizmoAxis? {
        switch self {
        case .free: nil
        case .x: .x
        case .y: .y
        case .z: .z
        }
    }
}

/// One pinch-drag of one handle. `grab` is where the hand was when the pinch started, `update(to:)` takes where it
/// is now (both in Virvi scene coordinates). The lock is the one the drag started with; it only applies to Move.
/// Returns nil from `init` when the handle doesn't work in this mode (or lock), and from `update` when the frame
/// can't be evaluated (the transform should stay as it is). Snap is applied by `EditSession.update`.
struct GizmoDrag {
    let handle: GizmoHandle
    let start: ItemTransform
    let grab: SIMD3<Double>
    private let moveAxis: GizmoAxis?
    private let startQuat: simd_quatd
    private var lastRing: SIMD3<Double>?
    private var total = 0.0

    init?(handle: GizmoHandle, mode: EditMode, lock: AxisLock, start: ItemTransform, grab: SIMD3<Double>) {
        guard handle.fits(mode) else { return nil }
        switch handle {
        case .arrow(let a):
            if let l = lock.axis, l != a { return nil }
            moveAxis = a
        case .body:
            moveAxis = lock.axis
        default:
            moveAxis = nil
        }
        self.handle = handle
        self.start = start
        self.grab = grab
        startQuat = eulerDegreesToQuat(start.rotation)
        if case .ring(let a) = handle { lastRing = Self.inPlane(grab - start.position, a.unit) }
    }

    mutating func update(to now: SIMD3<Double>) -> ItemTransform? {
        var out = start
        let c = start.position
        switch handle {
        case .body, .arrow:
            let d = now - grab
            if let a = moveAxis {
                out.position = c + a.unit * simd_dot(d, a.unit)
            } else {
                out.position = c + d
            }
        case .ring(let a):
            guard let v = Self.inPlane(now - c, a.unit) else { return nil }
            if let last = lastRing {
                total += atan2(simd_dot(simd_cross(last, v), a.unit), simd_dot(last, v)) * 180 / .pi
            }
            lastRing = v
            // No net rotation: keep the exact start Euler (the quaternion round trip wraps angles).
            out.rotation = abs(total) < 1e-6
                ? start.rotation
                : quatToEulerDegrees(simd_quatd(angle: total * .pi / 180, axis: a.unit) * startQuat)
        case .uniform:
            let g = simd_length(grab - c)
            guard g >= GIZMO_MIN_GRAB_DISTANCE else { return nil }
            let f = simd_length(now - c) / g
            out.scale = simd_max(start.scale * f, SIMD3(repeating: GIZMO_MIN_SCALE))
        case .stretch(let a):
            let dir = startQuat.act(a.unit)
            let g = abs(simd_dot(grab - c, dir))
            guard g >= GIZMO_MIN_GRAB_DISTANCE else { return nil }
            let f = abs(simd_dot(now - c, dir)) / g
            out.scale[a.index] = max(GIZMO_MIN_SCALE, start.scale[a.index] * f)
        }
        return out
    }

    /// `v` flattened onto the plane square to `axis`, or nil when it is too close to the axis to give an angle.
    private static func inPlane(_ v: SIMD3<Double>, _ axis: SIMD3<Double>) -> SIMD3<Double>? {
        let p = v - axis * simd_dot(v, axis)
        return simd_length(p) < GIZMO_MIN_GRAB_DISTANCE ? nil : p
    }
}

// MARK: - Sizes

/// A handle's hit size (and the size its shapes are built from): at least 6 cm across, and about 2.9 degrees of
/// view (5 cm per metre) so it stays as easy to hit 5 m away as 2 m away.
func gizmoHandleSize(distance: Double) -> Double {
    max(0.06, 0.05 * distance)
}

/// gizmo.ts `ringRadius`: 0.6 × the largest scale component, at least 0.5 m.
func gizmoRingRadius(scale s: SIMD3<Double>) -> Double {
    max(0.5, 0.6 * max(abs(s.x), abs(s.y), abs(s.z)))
}

/// gizmo.ts `offset`: how far a resize handle (or move arrow) sits from the item's centre along one axis.
func gizmoHandleOffset(_ s: Double) -> Double {
    max(0.3, abs(s) / 2 + 0.15)
}

/// An item's mesh bounds in its own frame (Virvi axes, before its rotation), in metres: what it really takes up.
struct GizmoBounds: Equatable {
    var min: SIMD3<Double>
    var max: SIMD3<Double>
}

/// Where the handles go. `arrowOffset` is on the scene's axes (arrows and rings don't turn with the item);
/// `handleOffset` is on the item's own axes (resize handles do).
struct GizmoLayout: Equatable {
    var ringRadius: Double
    var arrowOffset: SIMD3<Double>
    var handleOffset: SIMD3<Double>
}

/// Decentraland's layout from the scale, pushed out where the mesh is bigger than its scale says, so every handle
/// sits clear of the item (15 cm, gizmo.ts HANDLE_GAP) and a pinch on it isn't taken by the item's hit box.
func gizmoLayout(scale s: SIMD3<Double>, rotation: SIMD3<Double>, bounds: GizmoBounds?) -> GizmoLayout {
    let dcl = SIMD3(gizmoHandleOffset(s.x), gizmoHandleOffset(s.y), gizmoHandleOffset(s.z))
    var l = GizmoLayout(ringRadius: gizmoRingRadius(scale: s), arrowOffset: dcl, handleOffset: dcl)
    guard let b = bounds else { return l }
    let gap = 0.15
    let q = eulerDegreesToQuat(rotation)
    var far = 0.0
    var reach = SIMD3<Double>(repeating: -.infinity)
    for i in 0..<8 {
        let c = SIMD3(i & 1 == 0 ? b.min.x : b.max.x, i & 2 == 0 ? b.min.y : b.max.y, i & 4 == 0 ? b.min.z : b.max.z)
        far = Swift.max(far, simd_length(c))
        reach = simd_max(reach, q.act(c))
    }
    l.ringRadius = Swift.max(l.ringRadius, far + gap)
    l.arrowOffset = simd_max(dcl, reach + gap)
    l.handleOffset = simd_max(dcl, b.max + gap)
    return l
}

// MARK: - Decentraland's Euler degrees (packages/core/src/transform/math.ts)

func eulerDegreesToQuat(_ e: SIMD3<Double>) -> simd_quatd {
    let r = Double.pi / 180 * 0.5
    let (c1, s1) = (cos(e.x * r), sin(e.x * r))
    let (c2, s2) = (cos(e.y * r), sin(e.y * r))
    let (c3, s3) = (cos(e.z * r), sin(e.z * r))
    return simd_quatd(ix: c2 * s1 * c3 + s2 * c1 * s3,
                      iy: s2 * c1 * c3 - c2 * s1 * s3,
                      iz: c2 * c1 * s3 - s2 * s1 * c3,
                      r: c2 * c1 * c3 + s2 * s1 * s3)
}

/// Same result as DCL `Quaternion.toEulerAngles(q)`, in degrees, each component in [0, 360).
func quatToEulerDegrees(_ q: simd_quatd) -> SIMD3<Double> {
    let (x0, y0, z0, w) = (q.imag.x, q.imag.y, q.imag.z, q.real)
    let unit = x0 * x0 + y0 * y0 + z0 * z0 + w * w
    let test = x0 * w - y0 * z0
    var x: Double, y: Double, z: Double
    if test > 0.4995 * unit {
        x = .pi / 2; y = 2 * atan2(y0, x0); z = 0
    } else if test < -0.4995 * unit {
        x = -.pi / 2; y = -2 * atan2(y0, x0); z = 0
    } else {
        x = asin(2 * (w * x0 - y0 * z0))
        y = atan2(2 * w * y0 + 2 * z0 * x0, 1 - 2 * (x0 * x0 + y0 * y0))
        z = atan2(2 * w * z0 + 2 * x0 * y0, 1 - 2 * (z0 * z0 + x0 * x0))
    }
    let repeat360 = { (d: Double) -> Double in
        let r = d - (d / 360).rounded(.down) * 360
        return abs(r - 360) < 1e-9 ? 0 : r
    }
    return [repeat360(x * 180 / .pi), repeat360(y * 180 / .pi), repeat360(z * 180 / .pi)]
}
