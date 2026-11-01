import Foundation

enum EditMode: String { case move = "Move", rotate = "Rotate", resize = "Resize" }

enum AxisLock {
    case free, x, y, z
    func next() -> AxisLock {
        switch self {
        case .free: return .x
        case .x: return .y
        case .y: return .z
        case .z: return .free
        }
    }
}

enum ExactField { case position, rotation, scale }

/// The snap steps of packages/core/src/transform/session.ts.
enum SnapStep {
    static let rotationDegrees = 15.0
    static let uniformScale = 0.1
    static let stretchScale = 0.25
}

/// JS `Math.round` (halves go up) of value / step, times step.
func snapValue(_ value: Double, _ step: Double) -> Double {
    ((value / step) + 0.5).rounded(.down) * step
}

private func close(_ a: Double, _ b: Double) -> Bool { abs(a - b) < 1e-6 }

/// Applies snap to a transform the gizmo produced, relative to `original` (the drag's start). Position is never
/// snapped. Rotation: each turned axis snaps its turn since the drag's start to 15 degrees. Scale: one changed axis snaps its size to 0.25 (min 0.25);
/// all axes changed by one factor snap that factor to 0.1 (min 0.1); anything else is left as it is.
func snapped(_ t: ItemTransform, from original: ItemTransform) -> ItemTransform {
    var out = t
    for i in 0..<3 where !close(t.rotation[i], original.rotation[i]) {
        out.rotation[i] = original.rotation[i] + snapValue(t.rotation[i] - original.rotation[i], SnapStep.rotationDegrees)
    }
    let changed = (0..<3).filter { !close(t.scale[$0], original.scale[$0]) }
    if changed.count == 1, let i = changed.first {
        out.scale[i] = max(SnapStep.stretchScale, snapValue(t.scale[i], SnapStep.stretchScale))
    } else if changed.count > 1, (0..<3).allSatisfy({ original.scale[$0] != 0 }) {
        let factors = (0..<3).map { t.scale[$0] / original.scale[$0] }
        if factors.allSatisfy({ close($0, factors[0]) }) {
            let f = max(SnapStep.uniformScale, snapValue(factors[0], SnapStep.uniformScale))
            out.scale = original.scale * f
        }
    }
    return out
}
