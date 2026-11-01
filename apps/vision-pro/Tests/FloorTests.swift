import XCTest

final class FloorTests: XCTestCase {
    /// The floor under the scene is the detected floor whose centre is nearest the scene's centre.
    func testNearestFloorHeight() {
        let floors: [SIMD3<Float>] = [[0, -0.04, 0], [6, 0.12, 0]] // the room, and a raised floor next door
        XCTAssertEqual(nearestFloorY(floors, to: [1, -2]), -0.04)
        XCTAssertEqual(nearestFloorY(floors, to: [5, 0]), 0.12)
        XCTAssertNil(nearestFloorY([], to: [0, 0]))
    }

    func testHeightReadout() {
        XCTAssertEqual(heightLabel(sceneY: -0.04, floorY: -0.04), "On the floor")
        XCTAssertEqual(heightLabel(sceneY: -0.036, floorY: -0.04), "On the floor") // within half a centimetre
        XCTAssertEqual(heightLabel(sceneY: 0, floorY: -0.04), "4 cm above the floor")
        XCTAssertEqual(heightLabel(sceneY: -0.06, floorY: -0.04), "2 cm below the floor")
        XCTAssertEqual(heightLabel(sceneY: 0.03, floorY: nil), "Height +3 cm · floor not found yet")
        XCTAssertEqual(heightLabel(sceneY: -0.01, floorY: nil), "Height −1 cm · floor not found yet")
    }
}

final class FloorClipTests: XCTestCase {
    /// Sunk below the floor, the scene's marker and outline stay up on the floor so they can still be grabbed.
    func testMarkerStaysOnTheFloor() {
        XCTAssertEqual(markerLift(sceneY: -0.05, floorY: -0.01), 0.04, accuracy: 1e-6)
        XCTAssertEqual(markerLift(sceneY: 0.02, floorY: -0.01), 0) // above the floor it stays with the scene
        XCTAssertEqual(markerLift(sceneY: -0.05, floorY: nil), 0)
    }

    /// The occluder's top face is the floor.
    func testOccluderTopIsTheFloor() {
        let c = floorOccluderCenter(floorY: -0.03)
        XCTAssertEqual(c.y + floorOccluderSize.y / 2, -0.03, accuracy: 1e-6)
    }
}
