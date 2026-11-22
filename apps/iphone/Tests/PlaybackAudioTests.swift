import AVFoundation
import XCTest
@testable import VirviAR

final class FakeAudioSession: PlaybackAudioSession {
    var calls: [String] = []
    var fails = false

    func setCategory(_ category: AVAudioSession.Category, mode: AVAudioSession.Mode,
                     options: AVAudioSession.CategoryOptions) throws {
        calls.append("category \(category.rawValue) \(mode.rawValue) \(options.rawValue)")
        if fails { throw NSError(domain: "test", code: 1) }
    }

    func setActive(_ active: Bool, options: AVAudioSession.SetActiveOptions) throws {
        calls.append("active \(active)")
        if fails { throw NSError(domain: "test", code: 2) }
    }
}

final class PlaybackAudioTests: XCTestCase {
    func testPlaysThroughTheSilentSwitchMixedWithOtherAudio() {
        let s = FakeAudioSession()
        XCTAssertTrue(activatePlaybackAudio(s))
        let mix = AVAudioSession.CategoryOptions.mixWithOthers.rawValue
        XCTAssertEqual(s.calls, ["category \(AVAudioSession.Category.playback.rawValue) " +
                                 "\(AVAudioSession.Mode.moviePlayback.rawValue) \(mix)", "active true"])
    }

    func testASessionThatRefusesIsReportedNotFatal() {
        let s = FakeAudioSession()
        s.fails = true
        XCTAssertFalse(activatePlaybackAudio(s))
    }
}
