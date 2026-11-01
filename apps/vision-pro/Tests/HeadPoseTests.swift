import RealityKit
import simd
import XCTest

/// The device pose in Virvi scene coordinates (Mapping's inverse), for Assets → Place, and the edited transform an
/// item entity shows during a drag.
final class HeadPoseTests: XCTestCase {
    private func pose(_ position: SIMD3<Double>, yawRad: Double = 0, pitchRad: Double = 0) -> simd_double4x4 {
        let q = simd_quatd(angle: yawRad, axis: [0, 1, 0]) * simd_quatd(angle: pitchRad, axis: [1, 0, 0])
        var m = simd_double4x4(q)
        m.columns.3 = SIMD4(position, 1)
        return m
    }

    private func assertClose(_ a: SIMD3<Double>, _ b: SIMD3<Double>, file: StaticString = #filePath, line: UInt = #line) {
        for i in 0..<3 { XCTAssertEqual(a[i], b[i], accuracy: 1e-9, file: file, line: line) }
    }

    func testPositionIsMappingsInverse() {
        assertClose(fromRealityKitPosition([1, 2, -3]), [1, 2, 3])
        let mapped = toRealityKitTransform(position: Vec3(x: 4, y: 5, z: 6), rotation: Vec3(x: 0, y: 0, z: 0), scale: Vec3(x: 1, y: 1, z: 1))
        assertClose(fromRealityKitPosition(mapped.position), [4, 5, 6])
    }

    func testHeadLookingDownMinusZFacesVirviNorth() {
        let p = headPoseInScene(worldFromHead: pose([1, 1.6, -2]), worldFromScene: matrix_identity_double4x4)
        assertClose(p.position, [1, 1.6, 2])
        XCTAssertEqual(p.yawDeg, 0, accuracy: 1e-9)
    }

    func testHeadTurnedToPlusXIsYaw90() {
        // A -90 degree turn about +y takes the head's forward (-z) to +x.
        let p = headPoseInScene(worldFromHead: pose([0, 1.6, 0], yawRad: -.pi / 2), worldFromScene: matrix_identity_double4x4)
        XCTAssertEqual(p.yawDeg, 90, accuracy: 1e-9)
    }

    func testTheScenesOwnPlacementIsTakenOut() {
        // The scene root 2 m ahead and turned half round: the head at the origin is 2 m on the scene's north side,
        // looking south.
        let root = pose([0, 0, -2], yawRad: .pi)
        let p = headPoseInScene(worldFromHead: pose([0, 1.6, 0]), worldFromScene: root)
        assertClose(p.position, [0, 1.6, 2])
        XCTAssertEqual(abs(p.yawDeg), 180, accuracy: 1e-9)
    }

    func testLookingStraightDownUsesTheHeadsUpForHeading() {
        let p = headPoseInScene(worldFromHead: pose([0, 1.6, 0], pitchRad: -.pi / 2), worldFromScene: matrix_identity_double4x4)
        XCTAssertEqual(p.yawDeg, 0, accuracy: 1e-6)
    }

    func testPlacingFromTheHeadPoseLands2mAheadOnTheFloor() {
        let root = pose([3, 0, -1], yawRad: 0.7)
        let head = pose([0.5, 1.7, 0.2], yawRad: 0.3)
        let p = headPoseInScene(worldFromHead: head, worldFromScene: root)
        let t = placement(kind: .model, headPosition: p.position, headYawDeg: p.yawDeg)
        let local = toRealityKitTransform(position: Vec3(x: t.position.x, y: t.position.y, z: t.position.z),
                                          rotation: Vec3(x: 0, y: 0, z: 0), scale: Vec3(x: 1, y: 1, z: 1)).position
        let world = root * SIMD4(local, 1)
        let forward = simd_normalize(SIMD2(-head.columns.2.x, -head.columns.2.z))
        let expected = SIMD2(head.columns.3.x, head.columns.3.z) + 2 * forward
        XCTAssertEqual(world.x, expected.x, accuracy: 0.01) // placement rounds to the centimetre
        XCTAssertEqual(world.z, expected.y, accuracy: 0.01)
        XCTAssertEqual(world.y, 0, accuracy: 1e-9)
    }

    // MARK: - The entity transform for an edited item

    private func item(_ kind: RenderItem.Kind, width: Double = 2, height: Double = 2) -> RenderItem {
        RenderItem(key: "e:1", name: "n", kind: kind, src: "https://x/a.png", loop: false, volume: 0, width: width, height: height,
                   transform: MappedTransform(position: .zero, rotation: .zero, scale: [width, height, 1]), clickUrl: nil)
    }

    @MainActor
    func testEditedModelTakesTheScaleAndMappedPose() {
        let t = SceneRenderer.entityTransform(for: item(.model),
                                              ItemTransform(position: [1, 2, 3], rotation: [0, 90, 0], scale: [4, 1, 1]))
        XCTAssertEqual(t.translation, [1, 2, -3])
        XCTAssertEqual(t.scale, [4, 1, 1])
        let fwd = t.rotation.act([0, 0, -1])
        XCTAssertEqual(fwd.x, 1, accuracy: 1e-5)
    }

    @MainActor
    func testEditedPlaneScalesRelativeToItsMesh() {
        let t = SceneRenderer.entityTransform(for: item(.image), ItemTransform(position: .zero, rotation: .zero, scale: [4, 1, 1]))
        XCTAssertEqual(t.scale, [2, 0.5, 1])
    }
}
