import Foundation
import simd

/// The detected floor nearest the scene: `floors` are floor planes' centres in the room, `point` the scene's centre
/// on the room's x and z.
func nearestFloorY(_ floors: [SIMD3<Float>], to point: SIMD2<Float>) -> Float? {
    floors.min { simd_distance(SIMD2($0.x, $0.z), point) < simd_distance(SIMD2($1.x, $1.z), point) }?.y
}

/// The Place row's height readout: against the detected floor once there is one, else against the room's origin
/// (visionOS's own floor guess).
func heightLabel(sceneY: Float, floorY: Float?) -> String {
    guard let floorY else {
        let cm = Int((sceneY * 100).rounded())
        return "Height \(cm < 0 ? "−" : "+")\(abs(cm)) cm · floor not found yet"
    }
    let cm = Int(((sceneY - floorY) * 100).rounded())
    if abs(sceneY - floorY) < 0.005 || cm == 0 { return "On the floor" }
    return cm > 0 ? "\(cm) cm above the floor" : "\(-cm) cm below the floor"
}

/// How far the marker and outline rise above the scene's centre so they stay on the floor when the scene is sunk
/// into it (the scene's floors are often a few centimetres up in Decentraland).
func markerLift(sceneY: Float, floorY: Float?) -> Float {
    guard let floorY else { return 0 }
    return max(0, floorY - sceneY)
}

/// The invisible slab under the detected floor: whatever of the scene goes below the floor is hidden behind it, as
/// the real floor would hide it.
let floorOccluderSize = SIMD3<Float>(200, 20, 200)

func floorOccluderCenter(floorY: Float) -> SIMD3<Float> {
    [0, floorY - floorOccluderSize.y / 2, 0]
}
