import XCTest
@testable import VirviARKit

/// Mirrors apps/quest/app/src/test/java/io/virvi/ar/visitor/HeadingAveragerTest.kt.
final class HeadingAveragerTests: XCTestCase {
    func testEmptyHasNoMean() {
        let h = HeadingAverager()
        XCTAssertNil(h.mean())
        XCTAssertNil(h.spread())
    }

    func testAveragesAcrossThePlusMinus180Seam() {
        let h = HeadingAverager()
        h.add(179)
        h.add(-179)
        XCTAssertEqual(abs(h.mean()!), 180, accuracy: 1e-9)
        XCTAssertEqual(h.spread()!, 1, accuracy: 1e-9)
    }

    func testSpreadIsTheLargestDistanceFromTheMean() {
        let h = HeadingAverager()
        for d in [10.0, 10.0, 10.0, 14.0] { h.add(d) }
        XCTAssertEqual(h.mean()!, 11, accuracy: 0.01)
        XCTAssertEqual(h.spread()!, 3, accuracy: 0.01)
    }

    func testAFrameWithNoWallInTheWindowMeansNoHeading() {
        let h = HeadingAverager(capacity: 3)
        h.add(10)
        h.add(nil)
        h.add(10)
        XCTAssertNil(h.mean())
        XCTAssertNil(h.spread())
        h.add(10)
        XCTAssertNil(h.mean())
        h.add(10) // the nil slides out
        XCTAssertEqual(h.mean()!, 10, accuracy: 1e-9)
    }

    func testKeepsOnlyTheLastCapacityHeadings() {
        let h = HeadingAverager(capacity: 2)
        for d in [90.0, 0.0, 0.0] { h.add(d) }
        XCTAssertEqual(h.mean()!, 0, accuracy: 1e-9)
        XCTAssertEqual(h.spread()!, 0, accuracy: 1e-9)
        h.clear()
        XCTAssertNil(h.mean())
    }
}
