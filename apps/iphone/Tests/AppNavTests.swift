import XCTest
@testable import VirviAR

@MainActor
final class AppNavTests: XCTestCase {
    func testTheAppOpensOnBeatsWithTheCameraOff() {
        let nav = AppNav()
        XCTAssertEqual(nav.tab, .beats, "BEATs first, not the scanner")
        XCTAssertFalse(nav.cameraRuns(active: true), "no camera until the visitor asks to scan")
    }

    func testTheCameraRunsOnlyOnTheScanTabWhileTheAppIsActive() {
        let nav = AppNav()
        nav.scan()
        XCTAssertEqual(nav.tab, .scan)
        XCTAssertTrue(nav.cameraRuns(active: true))
        XCTAssertFalse(nav.cameraRuns(active: false))
        nav.tab = .beats
        XCTAssertFalse(nav.cameraRuns(active: true))
    }

    func testOpeningABeatShowsItOnTheBeatsTabFromAnywhere() {
        let nav = AppNav()
        nav.scan()
        nav.showBeat("b1")
        XCTAssertEqual(nav.tab, .beats)
        XCTAssertEqual(nav.path, ["b1"])
        nav.showBeat("b2")
        XCTAssertEqual(nav.path, ["b2"], "one BEAT open at a time")
    }
}
