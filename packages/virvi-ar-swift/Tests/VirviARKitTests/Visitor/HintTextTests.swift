import XCTest
@testable import VirviARKit

/// Mirrors apps/quest/app/src/test/java/io/virvi/ar/visitor/HintTextTest.kt. The headset-only cases (room scan,
/// spatial data, the permission rationale and its strings.xml check) aren't ported; the iPhone's device problems are
/// camera access and the connection.
final class HintTextTests: XCTestCase {
    private let space = ArSpace(id: "sp", name: "Cafe", published: true, floors: [])
    private var locking: VisitorState { .locking(space: space) }
    private var shown: VisitorState { .shown(space: space, root: RootPose(position: Vec3(x: 0, y: 0, z: 0), yawDeg: 0)) }

    func testTheVisitorCopyWordForWord() {
        XCTAssertEqual(hintText(.hint), "Look for a ring like this, at eye level near the entrance.")
        XCTAssertEqual(hintText(.stepCloser), "Step closer to the ring")
        XCTAssertEqual(hintText(.loading(code: "ABC", spaceName: "Cafe")), "Opening Cafe…")
        XCTAssertEqual(hintText(.loading(code: "ABC", spaceName: nil)), "Opening…")
        XCTAssertEqual(hintText(locking, gather: .gathering), "Hold still…")
        XCTAssertEqual(hintText(.notSetUp(spaceName: "Cafe")), "This space isn't set up yet")
        XCTAssertEqual(hintText(.failed(message: VisitorCopy.OFFLINE)), VisitorCopy.OFFLINE)
    }

    func testTheRestOfTheCopyWordForWord() {
        XCTAssertEqual(VisitorCopy.NOT_OPEN, "This space isn't open right now.")
        XCTAssertEqual(VisitorCopy.OFFLINE, "Can't reach Virvi. Check the phone's connection.")
        XCTAssertEqual(VisitorCopy.BUSY, "Virvi is busy. Trying again…")
        XCTAssertEqual(VisitorCopy.COULDNT_OPEN, "Couldn't open this space. Try again in a moment.")
        XCTAssertEqual(VisitorCopy.BAD_DATA, "Something's wrong with this space's data.")
        XCTAssertEqual(VisitorCopy.LOOK_AGAIN, "Look at the ring again")
        XCTAssertEqual(VisitorCopy.LOOK_AT_RING, "Look at the ring when you get there")
        XCTAssertEqual(VisitorCopy.SPACES, "Spaces")
        XCTAssertEqual(VisitorCopy.NO_SPACES, "No spaces yet")
        XCTAssertEqual(VisitorCopy.CLOSE, "Close")
        XCTAssertEqual(VisitorCopy.REPORT_SPACE, "Report this space")
        XCTAssertEqual(VisitorCopy.REPORT_OFFENSIVE, "Offensive")
        XCTAssertEqual(VisitorCopy.REPORT_UNSAFE, "Unsafe")
        XCTAssertEqual(VisitorCopy.REPORT_SPAM, "Spam")
        XCTAssertEqual(VisitorCopy.REPORT_OTHER, "Something else")
        XCTAssertEqual(VisitorCopy.REPORT_CANCEL, "Cancel")
    }

    func testTheNewDeviceAndWallCopy() {
        XCTAssertEqual(VisitorCopy.NO_CAMERA, "Virvi AR needs camera access to find rings. Allow it in Settings → Apps → Virvi AR.")
        XCTAssertEqual(VisitorCopy.NO_WALL, "Can't see the wall behind this ring. Look around the room so the phone can map it.")
    }

    func testARingSeenTooSteeplySaysStandInFront() {
        XCTAssertEqual(VisitorCopy.STAND_IN_FRONT, "Stand in front of the ring")
        XCTAssertEqual(lockingHint(.tooSteep, unreadableForMs: 0), VisitorCopy.STAND_IN_FRONT)
        XCTAssertEqual(hintText(locking, gather: .tooSteep), VisitorCopy.STAND_IN_FRONT)
    }

    func testLockingSaysHoldStillOnlyWhileARingIsBeingGathered() {
        XCTAssertEqual(lockingHint(.noneInView, unreadableForMs: 0), VisitorCopy.HINT)
        XCTAssertEqual(lockingHint(.gathering, unreadableForMs: 0), VisitorCopy.HOLD_STILL)
        XCTAssertEqual(lockingHint(.tooFar, unreadableForMs: 0), VisitorCopy.TOO_FAR)
        XCTAssertEqual(lockingHint(.unreadable, unreadableForMs: VisitorTuning.UNREADABLE_HINT_MS - 1), VisitorCopy.HINT)
        XCTAssertEqual(lockingHint(.unreadable, unreadableForMs: VisitorTuning.UNREADABLE_HINT_MS), VisitorCopy.TOO_FAR)
        XCTAssertEqual(lockingHint(.noWall, unreadableForMs: 0), VisitorCopy.NO_WALL)
    }

    func testTheHintCardWhileLockingFollowsTheGatherStatus() {
        XCTAssertEqual(hintText(locking), VisitorCopy.HINT)
        XCTAssertEqual(hintText(locking, gather: .noneInView), VisitorCopy.HINT)
        XCTAssertEqual(hintText(locking, gather: .tooFar), VisitorCopy.TOO_FAR)
        XCTAssertEqual(hintText(locking, gather: .unreadable, unreadableForMs: 2_000), VisitorCopy.TOO_FAR)
        XCTAssertEqual(hintText(locking, gather: .noWall), VisitorCopy.NO_WALL)
    }

    func testTheGatherStatusOnlyMattersWhileLocking() {
        XCTAssertEqual(hintText(.hint, gather: .tooFar), VisitorCopy.HINT)
        XCTAssertEqual(hintText(.notSetUp(spaceName: "Cafe"), gather: .noWall), VisitorCopy.NOT_SET_UP)
    }

    func testADeviceProblemComesFirstCameraBeforeConnection() {
        let states: [VisitorState] = [.hint, .stepCloser, .loading(code: "ABC", spaceName: "Cafe"), locking,
                                      .failed(message: VisitorCopy.BUSY), .notSetUp(spaceName: "Cafe")]
        for st in states {
            XCTAssertEqual(hintText(st, gather: .gathering, unreadableForMs: 0, problem: .cameraDenied), VisitorCopy.NO_CAMERA)
            XCTAssertEqual(hintText(st, gather: .gathering, unreadableForMs: 0, problem: .offline), VisitorCopy.OFFLINE)
        }
    }

    func testNoCardWhileTheSceneIsShown() {
        XCTAssertNil(hintText(shown))
        XCTAssertNil(hintText(shown, gather: .noWall, unreadableForMs: 0, problem: .cameraDenied))
        XCTAssertNil(hintText(shown, gather: .noWall, unreadableForMs: 0, problem: .offline))
    }

    /// The brief's summary: each locking line, and none once shown.
    func testTheLinesTheBriefNames() {
        XCTAssertEqual(hintText(.hint, gather: .noneInView, unreadableForMs: 0, problem: nil), VisitorCopy.HINT)
        XCTAssertEqual(hintText(locking, gather: .tooFar, unreadableForMs: 0, problem: nil), VisitorCopy.TOO_FAR)
        XCTAssertEqual(hintText(locking, gather: .gathering, unreadableForMs: 0, problem: nil), VisitorCopy.HOLD_STILL)
        XCTAssertEqual(hintText(locking, gather: .tooSteep, unreadableForMs: 0, problem: nil), VisitorCopy.STAND_IN_FRONT)
        XCTAssertNil(hintText(shown, gather: .gathering, unreadableForMs: 0, problem: nil))
    }

    func testTheMenuButtonShowsWheneverASpaceIsUpNeverOnThePlainHint() {
        XCTAssertTrue(menuButtonShown(shown, spaceChosen: true))
        XCTAssertTrue(menuButtonShown(locking, spaceChosen: true))
        XCTAssertTrue(menuButtonShown(.notSetUp(spaceName: "Cafe"), spaceChosen: true))
        XCTAssertTrue(menuButtonShown(.failed(message: VisitorCopy.OFFLINE), spaceChosen: true))
        XCTAssertFalse(menuButtonShown(.failed(message: VisitorCopy.NOT_OPEN), spaceChosen: false))
        XCTAssertFalse(menuButtonShown(.hint, spaceChosen: false))
        XCTAssertFalse(menuButtonShown(.stepCloser, spaceChosen: false))
    }
}
