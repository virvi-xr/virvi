import Foundation
import RealityKit
import simd

// Port of apps/quest/app/src/main/java/io/virvi/ar/space/SpaceAlignment.kt. World here is the Virvi world frame
// (see Space/ArFrame.swift); `realityKitRootTransform` takes the result back to RealityKit.

/// The scene's origin in the Virvi world and its turn about +Y. A scene point `s` lands at `position + R_y(yawDeg)·s`,
/// with `R_y(θ)·(x, y, z) = (x cos θ + z sin θ, y, −x sin θ + z cos θ)`: a heading h (degrees from +Z toward +X)
/// becomes h + yawDeg.
public struct RootPose: Equatable {
    public var position: Vec3
    public var yawDeg: Double

    public init(position: Vec3, yawDeg: Double) {
        self.position = position
        self.yawDeg = yawDeg
    }
}

func rotateY(_ deg: Double, _ v: Vec3) -> Vec3 {
    let a = deg * .pi / 180
    return Vec3(x: v.x * cos(a) + v.z * sin(a), y: v.y, z: -v.x * sin(a) + v.z * cos(a))
}

/// Where the scene root must sit so that a marker saved at `saved` (scene coordinates) is at `markerWorld` facing
/// `headingWorldDeg`. Headings are degrees from +Z toward +X, as in `wallHeading`. The scene stays level.
public func rootFromMarker(markerWorld: Vec3, headingWorldDeg: Double, saved: MarkerPose) -> RootPose {
    let yaw = headingWorldDeg - saved.headingDeg
    let r = rotateY(yaw, Vec3(x: saved.x, y: saved.y, z: saved.z))
    return RootPose(position: Vec3(x: markerWorld.x - r.x, y: markerWorld.y - r.y, z: markerWorld.z - r.z), yawDeg: yaw)
}

/// The inverse of `rootFromMarker`: where a marker seen in the world sits in scene coordinates (heading in [0, 360)).
public func markerInScene(root: RootPose, markerWorld: Vec3, headingWorldDeg: Double) -> MarkerPose {
    let d = Vec3(x: markerWorld.x - root.position.x, y: markerWorld.y - root.position.y, z: markerWorld.z - root.position.z)
    let s = rotateY(-root.yawDeg, d)
    let heading = ((headingWorldDeg - root.yawDeg).truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)
    return MarkerPose(x: s.x, y: s.y, z: s.z, headingDeg: heading)
}

/// Shortest signed difference `a − b` in degrees, in (−180, 180].
public func angleDiffDeg(_ a: Double, _ b: Double) -> Double {
    let d = ((a - b).truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)
    return d > 180 ? d - 360 : d
}

/// The scene root entity's RealityKit transform for `root`. Items sit under the root at `toRealityKitTransform`'s
/// mirrored positions, so a scene point `s` draws at `T·M·s` (M the z mirror); for that to be ARKit world
/// `M·(position + R_y(yaw)·s)`, T translates by `M·position` and turns by `M·R_y(yaw)·M = R_y(−yaw)` about RealityKit
/// +Y: exactly `toRealityKitTransform(position: position, rotation: (0, yaw, 0))`.
public func realityKitRootTransform(_ root: RootPose) -> Transform {
    let m = toRealityKitTransform(position: root.position, rotation: Vec3(x: 0, y: root.yawDeg, z: 0), scale: Vec3(x: 1, y: 1, z: 1))
    return Transform(scale: SIMD3<Float>(1, 1, 1), rotation: m.orientation.float, translation: SIMD3<Float>(m.position))
}
