@testable import VirviARKit
import AVFoundation
import XCTest

final class PlaylistPlayerTests: XCTestCase {
    /// Real, playable videos on disk: an item that fails to load (an unreachable URL) is dropped from an
    /// AVQueuePlayer's queue at some point during the test, which made these tests fail in full runs.
    private static var dir: URL!
    private var urls: [URL] { ["1", "2", "3"].map { Self.dir.appendingPathComponent("\($0).mp4") } }

    override class func setUp() {
        super.setUp()
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("virvi-playlist-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        for name in ["1", "2", "3"] { try! writeVideo(to: dir.appendingPathComponent("\(name).mp4")) }
    }

    override class func tearDown() {
        try? FileManager.default.removeItem(at: dir)
        super.tearDown()
    }

    /// A 64 x 64 H.264 video, three frames at 10 fps.
    private static func writeVideo(to url: URL) throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 64, AVVideoHeightKey: 64,
        ])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: 64, kCVPixelBufferHeightKey as String: 64,
        ])
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? CocoaError(.fileWriteUnknown) }
        writer.startSession(atSourceTime: .zero)
        for i in 0..<3 {
            while !input.isReadyForMoreMediaData { RunLoop.current.run(until: Date().addingTimeInterval(0.005)) }
            var buffer: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &buffer)
            guard let buffer, adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(i), timescale: 10))
            else { throw writer.error ?? CocoaError(.fileWriteUnknown) }
        }
        input.markAsFinished()
        let done = DispatchSemaphore(value: 0)
        writer.finishWriting { done.signal() }
        done.wait()
        guard writer.status == .completed else { throw writer.error ?? CocoaError(.fileWriteUnknown) }
    }

    private func queued(_ p: PlaylistPlayer) -> [String] {
        p.player.items().compactMap { ($0.asset as? AVURLAsset)?.url.lastPathComponent }
    }

    /// What AVQueuePlayer does when the current video ends (`actionAtItemEnd = .advance`), then the end notification.
    private func endCurrent(_ p: PlaylistPlayer, center: NotificationCenter) {
        guard let item = p.player.currentItem else { return XCTFail("the queue ran dry") }
        p.player.advanceToNextItem()
        center.post(name: AVPlayerItem.didPlayToEndTimeNotification, object: item)
        RunLoop.main.run(until: Date().addingTimeInterval(0.01))
    }

    func testPlaysEachVideoInTurnAndLoopsBackToTheFirst() {
        let center = NotificationCenter()
        let p = PlaylistPlayer(urls: urls, center: center)
        XCTAssertEqual(p.player.actionAtItemEnd, .advance)
        XCTAssertEqual(queued(p), ["1.mp4", "2.mp4", "3.mp4"])
        var playing = [queued(p).first]
        for _ in 0..<4 {
            endCurrent(p, center: center)
            playing.append(queued(p).first)
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
