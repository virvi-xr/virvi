import RealityKit
import XCTest

final class PickingTests: XCTestCase {
    func testSmallItemsGetAPaddedBox() {
        XCTAssertEqual(pickShape(extents: [0.05, 0.4, 0.001]), .box([0.15, 0.4, 0.15]))
        XCTAssertEqual(pickShape(extents: [1.5, 1.5, 1.5]), .box([1.5, 1.5, 1.5]))
    }

    func testBigItemsPickByTheirSurfaces() {
        XCTAssertEqual(pickShape(extents: [1.51, 0.2, 0.2]), .mesh)
        XCTAssertEqual(pickShape(extents: [8, 3, 8]), .mesh)
    }

    func testOutlineHasABarOnEachOfTheTwelveEdges() {
        let b = BoundingBox(min: [-1, 0, -2], max: [1, 3, 2])
        let bars = outlineBars(of: b, thickness: 0.02)
        XCTAssertEqual(bars.count, 12)
        // Four bars along each axis, each the box's full length on that axis.
        XCTAssertEqual(bars.filter { $0.size == [2, 0.02, 0.02] }.count, 4)
        XCTAssertEqual(bars.filter { $0.size == [0.02, 3, 0.02] }.count, 4)
        XCTAssertEqual(bars.filter { $0.size == [0.02, 0.02, 4] }.count, 4)
        // Every bar sits on the box's edges: its two off-axis coordinates are at a min or a max.
        XCTAssertTrue(bars.contains { $0.center == [0, 0, -2] })
        XCTAssertTrue(bars.contains { $0.center == [1, 1.5, 2] })
        XCTAssertTrue(bars.contains { $0.center == [-1, 3, 0] })
        XCTAssertEqual(Set(bars.map { "\($0.center)" }).count, 12)
    }

    func testListSelectPicksTheElementsFirstVisibleCopy() {
        func item(_ key: String, _ el: String, _ kind: RenderItem.Kind) -> RenderItem {
            RenderItem(key: key, name: el, kind: kind, src: "", loop: false, volume: 0, width: 1, height: 1,
                       transform: MappedTransform(position: .zero, rotation: .zero, scale: .one), elementId: el)
        }
        let plan = [item("a:1", "a", .image), item("s:1", "s", .audio), item("m:1", "m", .model), item("m:2", "m", .model)]
        XCTAssertEqual(firstSelectableKey(plan, elementId: "m"), "m:1")
        XCTAssertEqual(firstSelectableKey(plan, elementId: "a"), "a:1")
        XCTAssertNil(firstSelectableKey(plan, elementId: "s")) // a sound has nothing to look at
        XCTAssertNil(firstSelectableKey(plan, elementId: "gone"))
    }
}

final class PlacePhaseCopyTests: XCTestCase {
    /// In Place, items don't take pinches, so the bar must not tell you to pinch one.
    func testTheBarSaysWhichModeYouAreIn() {
        XCTAssertEqual(selectionLabel(placing: true, selectedName: nil), "Placing the scene: press Done placing to pick items")
        XCTAssertEqual(selectionLabel(placing: false, selectedName: nil), "Look at an item and pinch to select it")
        XCTAssertEqual(selectionLabel(placing: false, selectedName: "Chair"), "Chair")
    }
}
