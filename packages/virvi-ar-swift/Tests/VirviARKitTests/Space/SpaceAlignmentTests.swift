import Foundation
import RealityKit
import simd
import XCTest
@testable import VirviARKit

/// Mirrors apps/quest/app/src/test/java/io/virvi/ar/space/SpaceAlignmentTest.kt, plus the round trip from what ARKit
/// sees to where RealityKit draws the scene.
/// A seeded generator, so the round trip runs the same cases every time (as the Kotlin test's `Random(42)`).
private struct SplitMix64: RandomNumberGenerator {
    var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

final class SpaceAlignmentTests: XCTestCase {
    private let eps = 1e-9

    private func assertVec(_ e: Vec3, _ a: Vec3, _ acc: Double, _ msg: String = "", line: UInt = #line) {
        XCTAssertEqual(a.x, e.x, accuracy: acc, "x \(msg)", line: line)
        XCTAssertEqual(a.y, e.y, accuracy: acc, "y \(msg)", line: line)
        XCTAssertEqual(a.z, e.z, accuracy: acc, "z \(msg)", line: line)
    }

    /// Where a scene point lands in the (Virvi) world: `position + R_y(yawDeg)·s`.
    private func toWorld(_ root: RootPose, _ s: Vec3) -> Vec3 {
        let a = root.yawDeg * .pi / 180
        return Vec3(x: root.position.x + s.x * cos(a) + s.z * sin(a), y: root.position.y + s.y,
                    z: root.position.z - s.x * sin(a) + s.z * cos(a))
    }

    func testIdentity() {
        let root = rootFromMarker(markerWorld: Vec3(x: 8, y: 1.5, z: 0), headingWorldDeg: 0,
                                  saved: MarkerPose(x: 8, y: 1.5, z: 0, headingDeg: 0))
        assertVec(Vec3(x: 0, y: 0, z: 0), root.position, eps)
        XCTAssertEqual(root.yawDeg, 0, accuracy: eps)
    }

    func testTurnedAndMoved() {
        let root = rootFromMarker(markerWorld: Vec3(x: 1, y: 1.5, z: 2), headingWorldDeg: 90,
                                  saved: MarkerPose(x: 8, y: 1.5, z: 0, headingDeg: 0))
        XCTAssertEqual(root.yawDeg, 90, accuracy: eps)
        assertVec(Vec3(x: 1, y: 1.5, z: 2), toWorld(root, Vec3(x: 8, y: 1.5, z: 0)), eps)
        assertVec(Vec3(x: 2, y: 1.5, z: 2), toWorld(root, Vec3(x: 8, y: 1.5, z: 1)), eps)
    }

    func testRoundTrip() {
        var g = SplitMix64(seed: 42)
        for _ in 0..<50 {
            let w = Vec3(x: .random(in: -20...20, using: &g), y: .random(in: 0...3, using: &g), z: .random(in: -20...20, using: &g))
            let h = Double.random(in: -360...360, using: &g)
            let s = MarkerPose(x: .random(in: 0...16, using: &g), y: .random(in: 0...3, using: &g),
                               z: .random(in: 0...16, using: &g), headingDeg: .random(in: 0...360, using: &g))
            let back = markerInScene(root: rootFromMarker(markerWorld: w, headingWorldDeg: h, saved: s), markerWorld: w, headingWorldDeg: h)
            XCTAssertEqual(back.x, s.x, accuracy: eps)
            XCTAssertEqual(back.y, s.y, accuracy: eps)
            XCTAssertEqual(back.z, s.z, accuracy: eps)
            XCTAssertEqual(angleDiffDeg(s.headingDeg, back.headingDeg), 0, accuracy: eps)
            XCTAssertGreaterThanOrEqual(back.headingDeg, 0)
            XCTAssertLessThan(back.headingDeg, 360)
        }
    }

    func testHeadingWraps() {
        let root = rootFromMarker(markerWorld: Vec3(x: 0, y: 0, z: 0), headingWorldDeg: 10,
                                  saved: MarkerPose(x: 0, y: 0, z: 0, headingDeg: 350))
        XCTAssertEqual(angleDiffDeg(root.yawDeg, 0), 20, accuracy: eps)
    }

    func testAngleDiff() {
        XCTAssertEqual(angleDiffDeg(10, 350), 20, accuracy: eps)
        XCTAssertEqual(angleDiffDeg(350, 10), -20, accuracy: eps)
        XCTAssertEqual(angleDiffDeg(0, 180), 180, accuracy: eps)
    }

    // MARK: - ARKit in, RealityKit out (Review Focus 2)

    /// Where RealityKit draws scene point `s`: SceneRenderer places it at `toRealityKitTransform`'s position under the
    /// root entity, which carries `realityKitRootTransform(root)`.
    private func arkitWorld(of s: Vec3, under root: RootPose) -> SIMD3<Double> {
        let local = toRealityKitTransform(position: s, rotation: Vec3(x: 0, y: 0, z: 0), scale: Vec3(x: 1, y: 1, z: 1)).position
        let p = realityKitRootTransform(root).matrix * SIMD4<Float>(SIMD3<Float>(local), 1)
        return SIMD3<Double>(Double(p.x), Double(p.y), Double(p.z))
    }

    private func assertNear(_ a: SIMD3<Double>, _ e: SIMD3<Double>, _ msg: String, line: UInt = #line) {
        XCTAssertLessThan(simd_distance(a, e), 0.001, "\(msg): \(a) vs \(e)", line: line)
    }

    /// A marker on an ARKit vertical plane at `markerARKit` whose normal is `facingARKit` (unit, level), seen head-on
    /// from 1.5 m by an ARKit camera; the root that lines the saved pose up with it, through the same functions the app
    /// uses (`wallPlane`, `cameraToVirviWorld`, `wallFix`, `rootFromMarker`).
    private func rootSeeing(markerARKit m: SIMD3<Float>, facingARKit fa: SIMD3<Float>, saved: MarkerPose) throws -> (RootPose, Double) {
        let yawARKit = atan2(fa.x, fa.z) // the turn about ARKit +Y taking +Z to fa
        let turn = simd_quatf(angle: yawARKit, axis: [0, 1, 0])
        var anchor = simd_float4x4(turn * simd_quatf(angle: .pi / 2, axis: [1, 0, 0])) // anchor +y = fa
        anchor.columns.3 = SIMD4<Float>(m, 1)
        let wall = try XCTUnwrap(wallPlane(transform: anchor, center: .zero, width: 1, height: 1, rotationOnYAxis: 0, vertical: true))
        // The camera 1.5 m out along the wall's normal, looking back at it: its -Z is -fa, so the same turn.
        var cam = simd_float4x4(turn)
        cam.columns.3 = SIMD4<Float>(m + 1.5 * fa, 1)
        let viewer = cameraToVirviWorld(Vec3(x: 0, y: 0, z: 0), cameraTransform: cam)
        let marker = cameraToVirviWorld(Vec3(x: 0, y: 0, z: 1.5), cameraTransform: cam) // straight ahead in the image
        let heading = try XCTUnwrap(wallFix(marker, [wall], viewer: viewer, tilt: nil)?.headingDeg)
        return (rootFromMarker(markerWorld: marker, headingWorldDeg: heading, saved: saved), heading)
    }

    func testTheSceneLandsOnTheMarkerARKitSees() throws {
        let saved = MarkerPose(x: 8, y: 1.5, z: 2, headingDeg: 180)
        let m = SIMD3<Double>(1, 1.5, -2)
        let (root, heading) = try rootSeeing(markerARKit: SIMD3<Float>(m), facingARKit: [0, 0, 1], saved: saved)
        XCTAssertEqual(heading, 180, accuracy: 1e-3) // ARKit +Z is Virvi -Z
        assertNear(arkitWorld(of: Vec3(x: 8, y: 1.5, z: 2), under: root), m, "the marker")
        // The saved marker faces scene -z (heading 180): 1 m in front of it is (8, 1.5, 1).
        assertNear(arkitWorld(of: Vec3(x: 8, y: 1.5, z: 1), under: root), m + [0, 0, 1], "1 m in front")
        // Scene +x is the marker's left (Virvi is left-handed); facing ARKit +Z, its left is ARKit +X.
        assertNear(arkitWorld(of: Vec3(x: 9, y: 1.5, z: 2), under: root), m + [1, 0, 0], "1 m to its left")
        assertNear(arkitWorld(of: Vec3(x: 8, y: 2.5, z: 2), under: root), m + [0, 1, 0], "1 m up")
    }

    func testTheSceneLandsOnAMarkerTurned37Degrees() throws {
        // Facing ARKit (sin 37°, 0, cos 37°): Virvi (sin 37°, 0, -cos 37°), heading 180 - 37 = 143.
        let a = 37.0 * .pi / 180
        let fa = SIMD3<Double>(sin(a), 0, cos(a))
        let left = SIMD3<Double>(cos(a), 0, -sin(a)) // fa turned +90° about ARKit +Y (counter-clockwise from above)
        let saved = MarkerPose(x: 8, y: 1.5, z: 2, headingDeg: 180)
        let m = SIMD3<Double>(1, 1.5, -2)
        let (root, heading) = try rootSeeing(markerARKit: SIMD3<Float>(m), facingARKit: SIMD3<Float>(fa), saved: saved)
        XCTAssertEqual(heading, 143, accuracy: 1e-3)
        XCTAssertEqual(root.yawDeg, -37, accuracy: 1e-3)
        assertNear(arkitWorld(of: Vec3(x: 8, y: 1.5, z: 2), under: root), m, "the marker")
        assertNear(arkitWorld(of: Vec3(x: 8, y: 1.5, z: 1), under: root), m + fa, "1 m in front")
        assertNear(arkitWorld(of: Vec3(x: 9, y: 1.5, z: 2), under: root), m + left, "1 m to its left")
        assertNear(arkitWorld(of: Vec3(x: 8, y: 2.5, z: 2), under: root), m + [0, 1, 0], "1 m up")
    }

    func testAMarkerSavedAtAnotherHeadingTurnsTheSceneToMatch() throws {
        // Saved facing scene +x (heading 90), seen facing ARKit -X: Virvi -X, heading -90; the scene turns 180°.
        let saved = MarkerPose(x: 3, y: 1, z: 5, headingDeg: 90)
        let m = SIMD3<Double>(-2, 1.2, 0.5)
        let (root, heading) = try rootSeeing(markerARKit: SIMD3<Float>(m), facingARKit: [-1, 0, 0], saved: saved)
        XCTAssertEqual(angleDiffDeg(heading, -90), 0, accuracy: 1e-3)
        assertNear(arkitWorld(of: Vec3(x: 3, y: 1, z: 5), under: root), m, "the marker")
        assertNear(arkitWorld(of: Vec3(x: 4, y: 1, z: 5), under: root), m + [-1, 0, 0], "1 m in front")
    }

    func testTheRootTransformIsALevelTurn() {
        let t = realityKitRootTransform(RootPose(position: Vec3(x: 1, y: 2, z: 3), yawDeg: 30))
        XCTAssertEqual(SIMD3<Double>(t.translation), [1, 2, -3])
        XCTAssertEqual(t.scale, [1, 1, 1])
        // A z mirror turns a +30° Virvi yaw into -30° about RealityKit +Y, as toRealityKitTransform does for items.
        let q = simd_quatd(angle: -30 * .pi / 180, axis: [0, 1, 0])
        XCTAssertEqual(Double(abs(simd_dot(t.rotation, q.float))), 1, accuracy: 1e-6)
    }
}
