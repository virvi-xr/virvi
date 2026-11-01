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
