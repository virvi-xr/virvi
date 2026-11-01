import Foundation

enum PlaceKind: Equatable { case image, model }

struct ItemTransform: Equatable {
    var position: SIMD3<Double>
    var rotation: SIMD3<Double>
    var scale: SIMD3<Double>
}

/// JS `Math.round` (halves go up).
private func jsRound(_ n: Double) -> Double { (n + 0.5).rounded(.down) }
private func round2(_ n: Double) -> Double { jsRound(n * 100) / 100 }

/// Port of `placementInFrontOfPlayer` (packages/adapter-dcl/src/index.ts): 2 m ahead of the head along its yaw,
/// turned to face the builder and squared to the nearest 90 degrees. As in the source, the position uses the raw
/// yaw and only the rotation is squared. Virvi scene space is the Decentraland scene-local space. `feet` is the
/// floor (scene y 0), where the source reads it from the player's transform.
func placement(kind: PlaceKind, headPosition p: SIMD3<Double>, headYawDeg: Double) -> ItemTransform {
    let yaw = headYawDeg * .pi / 180
    let yawDeg = jsRound(headYawDeg / 90) * 90
    let feet = 0.0
    let turn = (fmod(fmod(yawDeg + 180, 360) + 360, 360))
    return ItemTransform(
        position: [round2(p.x + sin(yaw) * 2), round2(kind == .image ? feet + 1.2 : feet), round2(p.z + cos(yaw) * 2)],
        rotation: [0, round2(turn), 0],
        scale: kind == .image ? [2, 2, 1] : [1, 1, 1]
    )
}
