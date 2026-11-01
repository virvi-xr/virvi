import RealityKit
import XCTest

final class SceneVisibilityTests: XCTestCase {
    /// Decentraland treats any part named with "_collider" as collision only, never drawn.
    func testDecentralandColliderNames() {
        XCTAssertTrue(isColliderName("Wall_collider"))
        XCTAssertTrue(isColliderName("box_Collider.001"))
        XCTAssertFalse(isColliderName("Collider"))
        XCTAssertFalse(isColliderName("Chair"))
        XCTAssertFalse(isColliderName(nil))
    }

    @MainActor func testColliderPartsAreTakenOutOfTheModel() {
        let root = Entity(), chair = Entity(), collider = Entity(), inside = Entity(), byMesh = Entity()
        chair.name = "Chair"
        collider.name = "Chair_collider"
        inside.name = "Mesh"
        byMesh.name = "Node12" // its mesh is the one named "_collider"
        root.addChild(chair)
        chair.addChild(collider)
        collider.addChild(inside)
        root.addChild(byMesh)
        XCTAssertEqual(removeColliders(in: root, meshColliderNodes: ["Node12"]), 2)
        XCTAssertEqual(root.children.map(\.name), ["Chair"])
        XCTAssertTrue(chair.children.isEmpty)
    }

    /// The scene shows whenever it is open; items take pinches only while editing, and not while placing.
    func testItemsTakePinchesOnlyWhileEditing() {
        XCTAssertFalse(itemPickable(placing: false, editing: false, isSelected: false, mode: .move))
        XCTAssertFalse(itemPickable(placing: true, editing: true, isSelected: false, mode: .move))
        XCTAssertTrue(itemPickable(placing: false, editing: true, isSelected: false, mode: .move))
        XCTAssertTrue(itemPickable(placing: false, editing: true, isSelected: true, mode: .move))
        XCTAssertFalse(itemPickable(placing: false, editing: true, isSelected: true, mode: .rotate)) // the rings take it
    }
}
