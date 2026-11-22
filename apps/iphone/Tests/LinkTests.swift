import XCTest
@testable import VirviAR

final class LinkTests: XCTestCase {
    private func code(_ s: String) -> String? { spaceCode(fromLink: URL(string: s)!) }

    func testASpaceLinkOpensThatSpace() {
        XCTAssertEqual(code("https://virvi.io/s/2E3D4C5"), "2E3D4C5")
    }

    func testALinkCodeIsReadAsTheServerReadsIt() {
        XCTAssertEqual(code("https://virvi.io/s/2e3d4c5"), "2E3D4C5")
        XCTAssertEqual(code("https://virvi.io/s/2E3D4C5/"), "2E3D4C5")
        XCTAssertEqual(code("https://virvi.io/s/2E3D4C5?from=poster"), "2E3D4C5")
    }

    func testAnyOtherLinkIsIgnored() {
        XCTAssertNil(code("https://virvi.io/summit/"))
        XCTAssertNil(code("https://evil.example/s/2E3D4C5"))
        XCTAssertNil(code("http://virvi.io/s/2E3D4C5"))
        XCTAssertNil(code("https://virvi.io.evil.example/s/2E3D4C5"))
        XCTAssertNil(code("https://virvi.io/s/"))
        XCTAssertNil(code("https://virvi.io/s/NOTACODE"))
        XCTAssertNil(code("https://virvi.io/s/2E3D4C5/extra"))
        XCTAssertNil(code("virvi://s/2E3D4C5"))
    }
}
