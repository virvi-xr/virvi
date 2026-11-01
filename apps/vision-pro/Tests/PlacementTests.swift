import XCTest

final class PlacementTests: XCTestCase {
    func testPlacementMatchesDclForYaw0And100() {
        // yaw 0: 2 m along +z, facing back toward the builder
        let a = placement(kind: .model, headPosition: [1, 1.6, 1], headYawDeg: 0)
        XCTAssertEqual(a.position, [1, 0, 3])
        XCTAssertEqual(a.rotation, [0, 180, 0])
        XCTAssertEqual(a.scale, [1, 1, 1])
        // yaw 100: position uses the raw yaw (sin 100° * 2, cos 100° * 2), only the rotation is squared (90 -> 270)
        let b = placement(kind: .model, headPosition: [0, 1.6, 0], headYawDeg: 100)
        XCTAssertEqual(b.position.x, 1.97, accuracy: 1e-9)
        XCTAssertEqual(b.position.y, 0)
        XCTAssertEqual(b.position.z, -0.35, accuracy: 1e-9)
        XCTAssertEqual(b.rotation, [0, 270, 0])
        let img = placement(kind: .image, headPosition: [0, 1.6, 0], headYawDeg: 100)
        XCTAssertEqual(img.position.y, 1.2)
        XCTAssertEqual(img.scale, [2, 2, 1])
    }

    func testRotationWrapsAndNegativeYaw() {
        XCTAssertEqual(placement(kind: .model, headPosition: [0, 0, 0], headYawDeg: 180).rotation.y, 0)
        XCTAssertEqual(placement(kind: .model, headPosition: [0, 0, 0], headYawDeg: -90).rotation.y, 90)
        XCTAssertEqual(placement(kind: .model, headPosition: [0, 0, 0], headYawDeg: -100).position.x, -1.97, accuracy: 1e-9)
    }
}
