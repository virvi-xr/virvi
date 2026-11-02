import AVFoundation
import XCTest

final class PlaylistPlayerTests: XCTestCase {
    private let urls = ["1", "2", "3"].map { URL(string: "https://x/\($0).mp4")! }

    private func queued(_ p: PlaylistPlayer) -> [String] {
        p.player.items().compactMap { ($0.asset as? AVURLAsset)?.url.lastPathComponent }
    }

    /// What AVQueuePlayer does when the current video ends (`actionAtItemEnd = .advance`), then the end notification.
    private func endCurrent(_ p: PlaylistPlayer, center: NotificationCenter) {
        let item = p.player.currentItem!
        p.player.advanceToNextItem()
        center.post(name: AVPlayerItem.didPlayToEndTimeNotification, object: item)
        RunLoop.main.run(until: Date().addingTimeInterval(0.01))
    }

    func testPlaysEachVideoInTurnAndLoopsBackToTheFirst() {
        let center = NotificationCenter()
        let p = PlaylistPlayer(urls: urls, center: center)
        XCTAssertEqual(p.player.actionAtItemEnd, .advance)
        XCTAssertEqual(queued(p), ["1.mp4", "2.mp4", "3.mp4"])
        var playing = [queued(p)[0]]
        for _ in 0..<4 {
            endCurrent(p, center: center)
            playing.append(queued(p)[0])
            XCTAssertEqual(queued(p).count, 3)
        }
        XCTAssertEqual(playing, ["1.mp4", "2.mp4", "3.mp4", "1.mp4", "2.mp4"])
    }

    func testIgnoresOtherPlayersItems() {
        let center = NotificationCenter()
        let p = PlaylistPlayer(urls: urls, center: center)
        center.post(name: AVPlayerItem.didPlayToEndTimeNotification, object: AVPlayerItem(url: urls[0]))
        RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        XCTAssertEqual(queued(p), ["1.mp4", "2.mp4", "3.mp4"])
    }
}
