import Foundation
import simd

/// Port of packages/hyperfy-app/src/transform.ts.
///
/// Virvi (Decentraland, left-handed, Y-up, +Z forward) to RealityKit (right-handed, Y-up, -Z forward), which is
/// the same frame as three.js/Hyperfy. Position z is mirrored; rotation goes degrees to radians with x and y
/// negated (a z-mirror flips turns about x and y), applied in Decentraland's yaw-pitch-roll order, which is
/// three.js 'YXZ'. Scale is unchanged.
struct Vec3: Equatable {
    var x: Double
    var y: Double
    var z: Double
}

struct MappedTransform: Equatable {
    /// Meters, RealityKit frame.
    var position: SIMD3<Double>
    /// Euler radians, applied in YXZ order (see `quaternionYXZ`).
    var rotation: SIMD3<Double>
    var scale: SIMD3<Double>

    var orientation: simd_quatd { quaternionYXZ(rotation) }
}

private let DEG = Double.pi / 180

func toRealityKitTransform(position p: Vec3, rotation r: Vec3, scale s: Vec3) -> MappedTransform {
    MappedTransform(
        position: [p.x, p.y, -p.z],
        rotation: [-r.x * DEG, -r.y * DEG, r.z * DEG],
        scale: [s.x, s.y, s.z]
    )
}

/// The turn a loaded model gets inside the entity that carries its mapped transform. Decentraland shows a glTF
/// x-mirrored (glTF (x, y, z) at (-x, y, z)); with the z-mirror above that is a half turn about Y.
let MODEL_TURN = SIMD3<Double>(0, .pi, 0)

/// three.js Euler order 'YXZ' as a quaternion: q = qY * qX * qZ (Z applied first to a vector, then X, then Y).
func quaternionYXZ(_ r: SIMD3<Double>) -> simd_quatd {
    let qx = simd_quatd(angle: r.x, axis: [1, 0, 0])
    let qy = simd_quatd(angle: r.y, axis: [0, 1, 0])
    let qz = simd_quatd(angle: r.z, axis: [0, 0, 1])
    return qy * qx * qz
}

/// Where the scene's middle sits in Virvi coordinates: the centre of a single 16 m parcel, at ground level.
let VIRVI_SCENE_CENTER = Vec3(x: 8, y: 0, z: 8)

// MARK: - The inverse: RealityKit to Virvi

/// A position in the scene root's RealityKit frame, back in Virvi scene coordinates (z mirrored back).
func fromRealityKitPosition(_ p: SIMD3<Double>) -> SIMD3<Double> { [p.x, p.y, -p.z] }

/// Where the builder's head is in Virvi scene coordinates, and the yaw it faces in Virvi degrees (0 is north, +z;
/// 90 is east, +x), for `placement`. `worldFromHead` is the device anchor's `originFromAnchorTransform`;
/// `worldFromScene` is the scene root's transform (the Virvi origin, already on RealityKit axes). The head looks
/// down its -z; looking straight down, the top of the head gives the heading instead.
func headPoseInScene(worldFromHead: simd_double4x4, worldFromScene: simd_double4x4) -> (position: SIMD3<Double>, yawDeg: Double) {
    let m = worldFromScene.inverse * worldFromHead
    let position = fromRealityKitPosition(SIMD3(m.columns.3.x, m.columns.3.y, m.columns.3.z))
    var f = fromRealityKitPosition(-SIMD3(m.columns.2.x, m.columns.2.y, m.columns.2.z))
    if simd_length(SIMD2(f.x, f.z)) < 0.01 {
        f = fromRealityKitPosition(SIMD3(m.columns.1.x, m.columns.1.y, m.columns.1.z))
    }
    return (position, atan2(f.x, f.z) * 180 / .pi)
}
