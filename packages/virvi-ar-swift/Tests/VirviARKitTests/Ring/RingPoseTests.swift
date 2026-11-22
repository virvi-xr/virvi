import Foundation
import simd
import XCTest
@testable import VirviARKit

/// Mirrors apps/quest/app/src/test/java/io/virvi/ar/ring/RingPoseTest.kt and PoseAveragerTest.kt, with the Quest's
/// head/lens pose replaced by an ARKit camera transform. The cases that need the Quest's `lockHeading` keep only their
/// `wallFix` assertions.
final class RingPoseTests: XCTestCase {
    private let ring140 = RING_TEST_MARKERS.first { $0.name == "RING140" }!

    /// The focal length (px) the ring-marker synthetic test set was rendered at, read from its manifest.
    private static let testsetFocalPx: Double = {
        let url = RingDetectorTests.testsetDir.appendingPathComponent("manifest.json")
        guard let data = try? Data(contentsOf: url),
              let root = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            fatalError(RingDetectorTests.missingMessage)
        }
        let focals = Set(root.map { ($0["focal_px"] as! NSNumber).doubleValue })
        precondition(focals.count == 1, "test set mixes focal lengths: \(focals)")
        return focals.first!
    }()

    private var f: Double { Self.testsetFocalPx }
    /// Principal point at the stream centre.
    private var k: CameraIntrinsics { CameraIntrinsics(fx: f, fy: f, cx: 640, cy: 480, width: 1280, height: 960) }

    private func det(_ cx: Double, _ cy: Double, _ semiMajor: Double) -> RingDetection {
        RingDetection(id: ring140.id, version: 0, corrected: 0, cx: cx, cy: cy, semiMajor: semiMajor,
                      semiMinor: semiMajor * 0.95, angleDeg: 0, rotationDeg: 0)
    }

    private func len(_ v: Vec3) -> Double { (v.x * v.x + v.y * v.y + v.z * v.z).squareRoot() }

    private func assertVec(_ e: Vec3, _ a: Vec3, _ acc: Double, _ msg: String = "", line: UInt = #line) {
        XCTAssertEqual(a.x, e.x, accuracy: acc, "x \(msg)", line: line)
        XCTAssertEqual(a.y, e.y, accuracy: acc, "y \(msg)", line: line)
        XCTAssertEqual(a.z, e.z, accuracy: acc, "z \(msg)", line: line)
    }

    // MARK: - marker in camera

    func testDistanceFromSize() {
        // The semi-major a 0.14 m marker has at 0.90 m: f * (D / 2) / d.
        let p = markerInCamera(det(700, 400, f * 0.07 / 0.90), k, diameterM: ring140.diameterM)
        XCTAssertEqual(len(p), 0.90, accuracy: 0.01)
    }

    func testA140mmRingAt101PxIs60cmAway() {
        let k867 = CameraIntrinsics(fx: 867, fy: 867, cx: 640, cy: 480, width: 1280, height: 960)
        let p = markerInCamera(det(640, 480, 101.15), k867, diameterM: 0.140)
        XCTAssertEqual(len(p), 0.600, accuracy: 0.001)
    }

    func testRayThroughCentre() {
        let semiMajor = 59.1
        let p = markerInCamera(det(640, 480, semiMajor), k, diameterM: ring140.diameterM)
        XCTAssertEqual(p.x, 0, accuracy: 1e-9)
        XCTAssertEqual(p.y, 0, accuracy: 1e-9)
        XCTAssertEqual(p.z, f * 0.07 / semiMajor, accuracy: 1e-9)
    }

    func testRayOffCentreIsRightAndDown() {
        // A centre right of and below the principal point is +x, +y in camera space.
        let p = markerInCamera(det(640 + 0.1 * f, 480 + 0.05 * f, 59.1), k, diameterM: ring140.diameterM)
        XCTAssertEqual(p.x / p.z, 0.1, accuracy: 1e-9)
        XCTAssertEqual(p.y / p.z, 0.05, accuracy: 1e-9)
    }

    // MARK: - intrinsics

    func testIntrinsicsScaledToTheGreyFrame() {
        // ARKit's matrix is column-major: fx, fy on the diagonal, the principal point in the third column.
        let m = simd_float3x3(columns: (SIMD3<Float>(1500, 0, 0), SIMD3<Float>(0, 1494, 0), SIMD3<Float>(957, 723, 1)))
        let s = intrinsics(fromARKit: m, imageSize: CGSize(width: 1920, height: 1440), scaledTo: 1280, height: 960)
        XCTAssertEqual(s.fx, 1500 / 1.5, accuracy: 1e-3)
        XCTAssertEqual(s.fy, 1494 / 1.5, accuracy: 1e-3)
        XCTAssertEqual(s.cx, 957 / 1.5, accuracy: 1e-3)
        XCTAssertEqual(s.cy, 723 / 1.5, accuracy: 1e-3)
        XCTAssertEqual(s.width, 1280)
        XCTAssertEqual(s.height, 960)
    }

    // MARK: - camera to Virvi world

    private func cameraTransform(arkitPosition p: SIMD3<Float>, yawAboutARKitY rad: Float) -> simd_float4x4 {
        var m = simd_float4x4(simd_quatf(angle: rad, axis: [0, 1, 0]))
        m.columns.3 = SIMD4<Float>(p, 1)
        return m
    }

    func testCameraToVirviWorldUnturnedCamera() {
        // An unturned ARKit camera looks along ARKit -Z, which is Virvi +Z; image right is +x and image down is -y.
        let w = cameraToVirviWorld(Vec3(x: 0.1, y: 0.2, z: 1), cameraTransform: matrix_identity_float4x4)
        assertVec(Vec3(x: 0.1, y: -0.2, z: 1), w, 1e-6)
    }

    func testCameraToVirviWorldTurnedAndMoved() {
        // Turned +90° about ARKit +Y (to its left), it looks along ARKit -X, which is Virvi -X; image right is then
        // ARKit -Z, Virvi +Z. It stands at ARKit (1, 1.6, -2), Virvi (1, 1.6, 2).
        let cam = cameraTransform(arkitPosition: [1, 1.6, -2], yawAboutARKitY: .pi / 2)
        assertVec(Vec3(x: 1, y: 1.6, z: 2), cameraToVirviWorld(Vec3(x: 0, y: 0, z: 0), cameraTransform: cam), 1e-6)
        assertVec(Vec3(x: 0, y: 1.6, z: 2),cameraToVirviWorld(Vec3(x: 0, y: 0, z: 1), cameraTransform: cam), 1e-6)
        assertVec(Vec3(x: 1, y: 1.6, z: 2.5), cameraToVirviWorld(Vec3(x: 0.5, y: 0, z: 0), cameraTransform: cam), 1e-6)
        assertVec(Vec3(x: 1, y: 1.1, z: 2), cameraToVirviWorld(Vec3(x: 0, y: 0.5, z: 0), cameraTransform: cam), 1e-6)
    }

    // MARK: - walls

    /// Two walls meeting at a corner: one along x at z = 3 facing -z, one along z at x = 2 facing -x.
    private let walls = [
        WallPlane(centre: Vec3(x: 0, y: 1.5, z: 3), normal: Vec3(x: 0, y: 0, z: -1), halfWidth: 2, halfHeight: 1.5),
        WallPlane(centre: Vec3(x: 2, y: 1.5, z: 0), normal: Vec3(x: -1, y: 0, z: 0), halfWidth: 3, halfHeight: 1.5),
    ]
    private let viewer = Vec3(x: 0, y: 1.6, z: 0)

    func testWallHeadingNearest() {
        // 5 cm in front of the z = 3 wall: its normal is -z, yaw 180°.
        XCTAssertEqual(wallHeading(Vec3(x: 0.5, y: 1.5, z: 2.95), walls, viewer: viewer, tilt: nil)!, 180, accuracy: 1e-4)
        // 5 cm in front of the x = 2 wall: normal -x, yaw -90°.
        XCTAssertEqual(wallHeading(Vec3(x: 1.95, y: 1.2, z: 0.5), walls, viewer: viewer, tilt: nil)!, -90, accuracy: 1e-4)
        // 30 cm in front of the z = 3 wall (a print 10% off size): the ray from the viewer still meets that wall first.
        XCTAssertEqual(wallHeading(Vec3(x: 1.7, y: 1.5, z: 2.7), walls, viewer: viewer, tilt: nil)!, 180, accuracy: 1e-4)
        // Far short of any wall: no wall.
        XCTAssertNil(wallHeading(Vec3(x: 0.5, y: 1.5, z: 1.0), walls, viewer: viewer, tilt: nil))
        // On the z = 3 plane but past its end.
        XCTAssertNil(wallHeading(Vec3(x: -2.5, y: 1.5, z: 3), walls, viewer: viewer, tilt: nil))
    }

    func testWallNormalIntoRoom() {
        // The same z = 3 wall, its normal reported pointing away from the viewer (+z): flipped back to -z.
        let away = [WallPlane(centre: Vec3(x: 0, y: 1.5, z: 3), normal: Vec3(x: 0, y: 0, z: 1), halfWidth: 2, halfHeight: 1.5)]
        XCTAssertEqual(wallHeading(Vec3(x: 0.5, y: 1.5, z: 3.02), away, viewer: viewer, tilt: nil)!, 180, accuracy: 1e-4)
        // Seen from the other side of that wall, the normal points +z (yaw 0°).
        XCTAssertEqual(wallHeading(Vec3(x: 0.5, y: 1.5, z: 3.02), away, viewer: Vec3(x: 0, y: 1.6, z: 5), tilt: nil)!, 0, accuracy: 1e-4)
    }

    func testRangeToPlane() {
        let o = Vec3(x: 0, y: 0, z: 0)
        XCTAssertEqual(rangeToPlane(origin: o, dir: Vec3(x: 0, y: 0, z: 1), planePoint: Vec3(x: 0, y: 0, z: 2), planeNormal: Vec3(x: 0, y: 0, z: -1))!, 2, accuracy: 1e-12)
        XCTAssertNil(rangeToPlane(origin: o, dir: Vec3(x: 1, y: 0, z: 0), planePoint: Vec3(x: 0, y: 0, z: 2), planeNormal: Vec3(x: 0, y: 0, z: -1)))
        XCTAssertNil(rangeToPlane(origin: o, dir: Vec3(x: 0, y: 0, z: -1), planePoint: Vec3(x: 0, y: 0, z: 2), planeNormal: Vec3(x: 0, y: 0, z: -1)))
    }

    func testAWallMoreThan20DegreesFromTheTiltGivesNoHeading() {
        // The marker 2 cm in front of the z = 3 wall (into-room normal -z), seen head-on from the viewer.
        let marker = Vec3(x: 0, y: 1.6, z: 2.98)
        func tilt(_ deg: Double) -> [Vec3] {
            let a = deg * .pi / 180
            return [Vec3(x: sin(a), y: 0, z: -cos(a))] // -z turned by deg about +y
        }
        XCTAssertEqual(wallHeading(marker, [walls[0]], viewer: viewer, tilt: tilt(15))!, 180, accuracy: 1e-4)
        XCTAssertEqual(wallHeading(marker, [walls[0]], viewer: viewer, tilt: tilt(19.5))!, 180, accuracy: 1e-4)
        XCTAssertNil(wallHeading(marker, [walls[0]], viewer: viewer, tilt: tilt(20.5)))
        XCTAssertNil(wallHeading(marker, [walls[0]], viewer: viewer, tilt: tilt(25)))
        XCTAssertNil(wallFix(marker, [walls[0]], viewer: viewer, tilt: tilt(-30)))
    }

    // MARK: - the circle's tilt picks the wall

    private func rotY(_ v: Vec3, _ a: Double) -> Vec3 {
        Vec3(x: v.x * cos(a) + v.z * sin(a), y: v.y, z: -v.x * sin(a) + v.z * cos(a))
    }

    /// An eye at [eye] (Virvi world) looking level at [centre], as an ARKit camera transform, and the outline a 140 mm
    /// circle on a wall facing [normal] (unit, into the room) has in its image: the circle projected through the pinhole
    /// (in the Virvi frame, independent of `cameraToVirviWorld`) and fitted from its points' second moments, as the
    /// detector reports it (major axis angle from +x toward +y, image y down).
    private func view(_ eye: Vec3, _ centre: Vec3, _ normal: Vec3) -> (simd_float4x4, RingDetection) {
        let yaw = atan2(centre.x - eye.x, centre.z - eye.z) // Virvi heading of the gaze
        // ARKit camera: at the mirrored eye, turned by -yaw about ARKit +Y (its -Z then points along the mirrored gaze).
        let cam = cameraTransform(arkitPosition: [Float(eye.x), Float(eye.y), Float(-eye.z)], yawAboutARKitY: Float(-yaw))
        func pixel(_ p: Vec3) -> (Double, Double) {
            let h = rotY(Vec3(x: p.x - eye.x, y: p.y - eye.y, z: p.z - eye.z), -yaw)
            return (k.fx * h.x / h.z + k.cx, k.fy * -h.y / h.z + k.cy)
        }
        let u = Vec3(x: normal.z, y: 0, z: -normal.x)
        let r = ring140.diameterM / 2
        let pts = (0..<360).map { i -> (Double, Double) in
            let t = Double(i) * .pi / 180
            return pixel(Vec3(x: centre.x + r * cos(t) * u.x, y: centre.y + r * sin(t), z: centre.z + r * cos(t) * u.z))
        }
        let n = Double(pts.count)
        let mx = pts.map { $0.0 }.reduce(0, +) / n
        let my = pts.map { $0.1 }.reduce(0, +) / n
        let sxx = pts.map { ($0.0 - mx) * ($0.0 - mx) }.reduce(0, +) / n
        let syy = pts.map { ($0.1 - my) * ($0.1 - my) }.reduce(0, +) / n
        let sxy = pts.map { ($0.0 - mx) * ($0.1 - my) }.reduce(0, +) / n
        let half = (sxx + syy) / 2
        let root = ((sxx - syy) * (sxx - syy) / 4 + sxy * sxy).squareRoot()
        let angle = ((0.5 * atan2(2 * sxy, sxx - syy)) * 180 / .pi + 180).truncatingRemainder(dividingBy: 180)
        let (cx, cy) = pixel(centre)
        return (cam, RingDetection(id: ring140.id, version: 0, corrected: 0, cx: cx, cy: cy,
                                   semiMajor: (2 * (half + root)).squareRoot(), semiMinor: (2 * (half - root)).squareRoot(),
                                   angleDeg: angle, rotationDeg: 0))
    }

    /// [eye] [distance] m out from [centre] on a wall facing [normal], [offDeg] degrees round toward -x (level).
    private func eyeAt(_ centre: Vec3, _ normal: Vec3, _ distance: Double, _ offDeg: Double) -> Vec3 {
        let a = offDeg * .pi / 180
        let dx = normal.x * cos(a) + normal.z * sin(a)
        let dz = -normal.x * sin(a) + normal.z * cos(a)
        return Vec3(x: centre.x + distance * dx, y: centre.y, z: centre.z + distance * dz)
    }

    private let wallA = Vec3(x: 0, y: 0, z: -1) // the z = 3 wall, into the room
    private let wallB = Vec3(x: -1, y: 0, z: 0) // the x = 2 wall

    private func angleTo(_ a: Vec3, _ b: Vec3) -> Double {
        acos(min(max(a.x * b.x + a.y * b.y + a.z * b.z, -1), 1)) * 180 / .pi
    }

    func testTiltPicksTheWallTheMarkerIsOnAtACorner() {
        // 5 cm from the corner on wall A, seen from 1.2 m at 30°.
        let onA = Vec3(x: 1.95, y: 1.5, z: 3.0)
        let eye = eyeAt(onA, wallA, 1.2, 30)
        let (cam, d) = view(eye, onA, wallA)
        let tilt = circleNormals(d, k, cameraTransform: cam)
        XCTAssertEqual(tilt.count, 2)
        // The measured position errs toward the camera, closer to wall B's plane (5 cm) than to A's (7 cm).
        let measured = Vec3(x: 1.95, y: 1.5, z: 2.93)
        XCTAssertEqual(wallHeading(measured, walls, viewer: eye, tilt: nil)!, 180, accuracy: 1e-4)
        XCTAssertEqual(wallHeading(measured, walls, viewer: eye, tilt: tilt)!, 180, accuracy: 1e-4)
        XCTAssertEqual(wallHeading(onA, walls, viewer: eye, tilt: tilt)!, 180, accuracy: 1e-4)
    }

    func testTiltPicksWallBForAMarkerOnB() {
        let onB = Vec3(x: 2.0, y: 1.5, z: 2.95)
        let eye = eyeAt(onB, wallB, 1.2, -30)
        let (cam, d) = view(eye, onB, wallB)
        XCTAssertEqual(wallHeading(Vec3(x: 1.94, y: 1.5, z: 2.95), walls, viewer: eye, tilt: circleNormals(d, k, cameraTransform: cam))!,
                       -90, accuracy: 1e-4)
    }

    func testTiltCandidatesIncludeTheTrueNormal() {
        let onA = Vec3(x: 0.5, y: 1.5, z: 3.0)
        for off in [20.0, 30.0, 45.0, -40.0] {
            let eye = eyeAt(onA, wallA, 1.2, off)
            let (cam, d) = view(eye, onA, wallA)
            let best = circleNormals(d, k, cameraTransform: cam).map { angleTo($0, wallA) }.min()!
            XCTAssertLessThan(best, 5.0, "\(off)° off: \(best)° from the true normal")
        }
    }

    func testNoWallAgreesWithTheTiltGivesNoHeading() {
        // The marker is on wall A, which the scan missed; only wall B is near. Seen at 20°, B is 50° off either tilt.
        let onA = Vec3(x: 1.95, y: 1.5, z: 3.0)
        let eye = eyeAt(onA, wallA, 1.2, 20)
        let (cam, d) = view(eye, onA, wallA)
        XCTAssertNil(wallHeading(onA, [walls[1]], viewer: eye, tilt: circleNormals(d, k, cameraTransform: cam)))
    }

    func testARoundOutlineAcceptsOnlyAWallFacingTheCamera() {
        let onA = Vec3(x: 1.95, y: 1.5, z: 3.0)
        let eye = eyeAt(onA, wallA, 1.2, 0)
        let (cam, d) = view(eye, onA, wallA)
        XCTAssertGreaterThan(d.semiMinor / d.semiMajor, ROUND_RATIO)
        let tilt = circleNormals(d, k, cameraTransform: cam)
        XCTAssertEqual(tilt.count, 1)
        XCTAssertEqual(wallHeading(Vec3(x: 1.95, y: 1.5, z: 2.93), walls, viewer: eye, tilt: tilt)!, 180, accuracy: 1e-4)
        // Only the perpendicular wall near: 90° from the camera ray, so no heading.
        XCTAssertNil(wallHeading(onA, [walls[1]], viewer: eye, tilt: tilt))
    }

    func testACornerSeenAt45DegreesIsAmbiguous() {
        let onA = Vec3(x: 1.95, y: 1.5, z: 3.0)
        let eye = eyeAt(onA, wallA, 1.2, 45)
        let (cam, d) = view(eye, onA, wallA)
        XCTAssertNil(wallHeading(onA, walls, viewer: eye, tilt: circleNormals(d, k, cameraTransform: cam)))
        // The fix is still there, with no heading (the visitor is asked to look around).
        let fix = wallFix(onA, walls, viewer: eye, tilt: circleNormals(d, k, cameraTransform: cam))
        XCTAssertNotNil(fix)
        XCTAssertNil(fix?.headingDeg)
    }

    func testACornerSeenAt20Or60DegreesTakesTheMarkersWall() {
        let onA = Vec3(x: 1.95, y: 1.5, z: 3.0)
        for off in [20.0, 60.0] {
            let eye = eyeAt(onA, wallA, 1.2, off)
            let (cam, d) = view(eye, onA, wallA)
            XCTAssertEqual(wallHeading(onA, walls, viewer: eye, tilt: circleNormals(d, k, cameraTransform: cam))!, 180,
                           accuracy: 1e-4, "\(off)°")
        }
    }

    func testThePerpendicularWallAloneGivesNoHeading() {
        // Wall A unscanned; wall B 5 cm away. At 30° or 60° the false normal is 30° from B, outside the tilt gate.
        let onA = Vec3(x: 1.95, y: 1.5, z: 3.0)
        for off in [30.0, 60.0] {
            let eye = eyeAt(onA, wallA, 1.2, off)
            let (cam, d) = view(eye, onA, wallA)
            XCTAssertNil(wallHeading(onA, [walls[1]], viewer: eye, tilt: circleNormals(d, k, cameraTransform: cam)), "\(off)°")
        }
    }

    func testTheMarkersOwnWallWithinHeadOnCounts() {
        let onA = Vec3(x: 0.5, y: 1.5, z: 3.0)
        for off in [20.0, 28.0] {
            let eye = eyeAt(onA, wallA, 1.2, off)
            let (cam, d) = view(eye, onA, wallA)
            let fix = wallFix(onA, walls, viewer: eye, tilt: circleNormals(d, k, cameraTransform: cam))!
            XCTAssertEqual(fix.headingDeg!, 180, accuracy: 1e-4, "\(off)°")
            XCTAssertEqual(fix.viewAngleDeg, off, accuracy: 0.5, "\(off)°")
            XCTAssertEqual(circleTiltDeg(d), off, accuracy: 1.0, "\(off)°")
        }
    }

    func testAMisprintedRingStillGetsItsWallsHeading() {
        let onA = Vec3(x: 0.5, y: 1.5, z: 3.0)
        for off in [0.0, 20.0] {
            let eye = eyeAt(onA, wallA, 1.5, off)
            let (cam, d) = view(eye, onA, wallA)
            for scale in [0.92, 1.05] {
                let measured = Vec3(x: eye.x + (onA.x - eye.x) / scale, y: eye.y + (onA.y - eye.y) / scale,
                                    z: eye.z + (onA.z - eye.z) / scale)
                let fix = wallFix(measured, walls, viewer: eye, tilt: circleNormals(d, k, cameraTransform: cam))!
                XCTAssertEqual(fix.headingDeg!, 180, accuracy: 1e-4, "\(off)° x\(scale)")
            }
        }
    }

    func testADetectedObliqueRingHasItsTrueNormalAmongTheCandidates() throws {
        // The test set turns the plaque about the vertical by angle_deg, its +x edge away from the camera: in the image
        // camera frame (y down) the normal toward the camera is (sin a, 0, -cos a), and an unturned ARKit camera at the
        // origin gives Virvi world the same x and z.
        let dir = RingDetectorTests.testsetDir
        let entries = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: dir.appendingPathComponent("manifest.json"))) as? [[String: Any]])
        for name in ["range-RING140-1.2-30", "range-RING140-1.2-45"] {
            let e = try XCTUnwrap(entries.first { ($0["name"] as? String) == name })
            let marker = try XCTUnwrap((e["markers"] as? [[String: Any]])?.first)
            let a = (marker["angle_deg"] as! NSNumber).doubleValue * .pi / 180
            let truth = Vec3(x: sin(a), y: 0, z: -cos(a))
            let img = try RingDetectorTests.loadImage(dir.appendingPathComponent(e["file"] as! String))
            let found = img.gray.withUnsafeBufferPointer {
                RingDetector().detectFrame(gray: $0, width: img.width, height: img.height, rowStride: img.width).detections
            }
            XCTAssertEqual(found.count, 1, name)
            let d = try XCTUnwrap(found.first)
            let tilt = circleNormals(d, k, cameraTransform: matrix_identity_float4x4)
            XCTAssertEqual(tilt.count, 2, name)
            let best = tilt.map { angleTo($0, truth) }.min()!
            XCTAssertLessThan(best, 5.0, "\(name): \(best)° from the true normal")
        }
    }

    func testCircleTiltDeg() {
        let d = RingDetection(id: 1, version: 0, corrected: 0, cx: 0, cy: 0, semiMajor: 100, semiMinor: 50, angleDeg: 0, rotationDeg: 0)
        XCTAssertEqual(circleTiltDeg(d), 60, accuracy: 1e-9)
    }

    func testConstants() {
        XCTAssertEqual(TILT_TOLERANCE_DEG, 20)
        XCTAssertEqual(TILT_AMBIGUOUS_DEG, 15)
        XCTAssertEqual(WALL_TOLERANCE_M, 0.10)
        XCTAssertEqual(ROUND_RATIO, 0.97)
        XCTAssertEqual(PRINT_SCALE_TOLERANCE, 0.25)
    }

    // MARK: - ARKit plane anchors to walls

    /// A plane anchor at ARKit (1, 1.5, -3) whose normal (anchor +y) is ARKit +Z: 90° about +x, so anchor x stays
    /// horizontal and anchor z points down.
    private var wallAnchorTransform: simd_float4x4 {
        var m = simd_float4x4(simd_quatf(angle: .pi / 2, axis: [1, 0, 0]))
        m.columns.3 = [1, 1.5, -3, 1]
        return m
    }

    func testAVerticalPlaneAnchorIsAWallInVirviCoordinates() throws {
        let w = try XCTUnwrap(wallPlane(transform: wallAnchorTransform, center: [0.1, 0, 0], width: 2, height: 1,
                                        rotationOnYAxis: 0, vertical: true))
        assertVec(Vec3(x: 1.1, y: 1.5, z: 3), w.centre, 1e-5)
        assertVec(Vec3(x: 0, y: 0, z: -1), w.normal, 1e-5) // ARKit +Z is Virvi -Z
        XCTAssertEqual(w.halfWidth, 1, accuracy: 1e-5)
        XCTAssertEqual(w.halfHeight, 0.5, accuracy: 1e-5)
    }

    func testAPlaneExtentTurnedAQuarterSwapsWidthAndHeight() throws {
        let w = try XCTUnwrap(wallPlane(transform: wallAnchorTransform, center: [0, 0, 0], width: 2, height: 1,
                                        rotationOnYAxis: .pi / 2, vertical: true))
        XCTAssertEqual(w.halfWidth, 0.5, accuracy: 1e-5)
        XCTAssertEqual(w.halfHeight, 1, accuracy: 1e-5)
    }

    func testAHorizontalPlaneIsNoWall() {
        XCTAssertNil(wallPlane(transform: matrix_identity_float4x4, center: [0, 0, 0], width: 2, height: 2,
                               rotationOnYAxis: 0, vertical: false))
    }

    // MARK: - PoseAverager (PoseAveragerTest.kt)

    func testMeanOfSamples() {
        let a = PoseAverager(capacity: 10, minCount: 1)
        a.add(Vec3(x: 1, y: 2, z: 3))
        a.add(Vec3(x: 3, y: 2, z: 1))
        assertVec(Vec3(x: 2, y: 2, z: 2), a.mean()!, 1e-12)
        // Spread is the largest distance from the mean: sqrt(1 + 1).
        XCTAssertEqual(a.spread()!, 2.0.squareRoot(), accuracy: 1e-12)
    }

    func testMinimumCount() {
        let a = PoseAverager(capacity: 10, minCount: 5)
        for i in 0..<4 { a.add(Vec3(x: 0, y: 0, z: Double(i))) }
        XCTAssertFalse(a.ready)
        XCTAssertEqual(a.count, 4)
        a.add(Vec3(x: 0, y: 0, z: 4))
        XCTAssertTrue(a.ready)
        XCTAssertEqual(a.mean()!.z, 2, accuracy: 1e-12)
    }

    func testCapacityDropsOldest() {
        let a = PoseAverager(capacity: 3, minCount: 1)
        for z in [100.0, 1, 2, 3] { a.add(Vec3(x: 0, y: 0, z: z)) }
        XCTAssertEqual(a.count, 3)
        XCTAssertEqual(a.mean()!.z, 2, accuracy: 1e-12)
    }

    func testClear() {
        let a = PoseAverager(capacity: 10, minCount: 1)
        a.add(Vec3(x: 1, y: 1, z: 1))
        a.clear()
        XCTAssertEqual(a.count, 0)
        XCTAssertFalse(a.ready)
        XCTAssertNil(a.mean())
        XCTAssertNil(a.spread())
    }

    func testDefaults() {
        let a = PoseAverager()
        for _ in 0..<4 { a.add(Vec3(x: 0, y: 0, z: 0)) }
        XCTAssertFalse(a.ready)
        a.add(Vec3(x: 0, y: 0, z: 0))
        XCTAssertTrue(a.ready)
        for _ in 0..<20 { a.add(Vec3(x: 0, y: 0, z: 0)) }
        XCTAssertEqual(a.count, 15)
    }
}
