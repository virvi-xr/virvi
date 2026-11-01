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

// MARK: - The Exact panel (packages/adapter-dcl/src/hud/EditModeBar.tsx)

extension ExactField {
    /// The Exact panel types the current mode's field.
    init(_ mode: EditMode) {
        switch mode {
        case .move: self = .position
        case .rotate: self = .rotation
        case .resize: self = .scale
        }
    }
}

/// EditModeBar's `EXACT_TITLE`.
func exactTitle(_ mode: EditMode) -> String {
    switch mode {
    case .move: "Position (m)"
    case .rotate: "Rotation (degrees)"
    case .resize: "Scale"
    }
}

/// EditModeBar's `fmt`: rounded to the millimetre (or thousandth), without trailing zeros.
func formatExact(_ n: Double) -> String {
    let r = (n * 1000).rounded() / 1000
    return r == r.rounded() && abs(r) < 1e15 ? String(Int64(r)) : String(r)
}

/// EditModeBar's `parseExact`: a typed number, or nil for anything else (empty, "1abc").
func parseExact(_ text: String) -> Double? {
    let t = text.trimmingCharacters(in: .whitespaces)
    guard !t.isEmpty, let n = Double(t), n.isFinite else { return nil }
    return n
}

/// The live value with each typed axis (0, 1, 2) that parses put in; nil when nothing typed parses, so there is
/// nothing to apply (junk shows the old value again).
func exactValue(_ current: SIMD3<Double>, typed: [Int: String]) -> SIMD3<Double>? {
    var v = current
    var any = false
    for (axis, text) in typed {
        guard let n = parseExact(text) else { continue }
        v[axis] = n
        any = true
    }
    return any ? v : nil
}
