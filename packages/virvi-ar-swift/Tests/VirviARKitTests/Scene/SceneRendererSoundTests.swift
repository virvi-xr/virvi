@testable import VirviARKit
import AVFoundation
import RealityKit
import XCTest

@MainActor
final class SceneRendererSoundTests: XCTestCase {
    private static let still = MappedTransform(position: .zero, rotation: .zero, scale: [1, 1, 1])

    private func item(_ key: String, _ kind: RenderItem.Kind, _ src: String) -> RenderItem {
        RenderItem(key: key, name: key, kind: kind, src: src, loop: true, volume: 1, width: 1, height: 1,
                   transform: Self.still)
    }

    /// A short silent WAV in the temporary folder (a sound item the renderer can load without the network).
    private func soundFile() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("virvi-test-\(UUID().uuidString).wav")
        let format = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 1)!
        let file = try AVAudioFile(forWriting: url, settings: format.settings)
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4_410)!
        buffer.frameLength = 4_410
        try file.write(from: buffer)
        return url
    }

    private func waitUntil(_ what: String, _ ok: () -> Bool) {
        let end = Date().addingTimeInterval(5)
        while !ok() && Date() < end { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
        XCTAssertTrue(ok(), what)
    }

    /// The first tap turns the sound on: nothing is rebuilt (models would vanish and reload, videos restart), the
    /// videos already playing are unmuted, and the sounds start; turning it off again mutes and stops them in place.
    func testTurningTheSoundOnAndOffActsInPlace() throws {
        let r = SceneRenderer()
        let sound = try soundFile()
        r.apply([
            item("v:1", .video, "https://virvi.test/v.mp4"),
            item("m:1", .model, "https://virvi.test/box.fbx"), // not glTF: the placeholder, at once
            item("a:1", .audio, sound.absoluteString),
        ])
        let before = ["v:1", "m:1", "a:1"].map { r.entity(for: $0) }
        let player = try XCTUnwrap(r.player(for: "v:1"))
        XCTAssertTrue(player.isMuted, "video starts muted")
        XCTAssertNil(r.entity(for: "a:1")?.components[SpatialAudioComponent.self], "no sound before the tap")

        r.soundOn = true

        let after = ["v:1", "m:1", "a:1"].map { r.entity(for: $0) }
        for (b, a) in zip(before, after) { XCTAssertTrue(b != nil && b === a, "same entity kept") }
        XCTAssertTrue(r.player(for: "v:1") === player, "same player kept")
        XCTAssertFalse(player.isMuted, "video unmuted")
        waitUntil("sound started") { r.entity(for: "a:1")?.components[SpatialAudioComponent.self] != nil }

        r.soundOn = false

        XCTAssertTrue(r.entity(for: "v:1") === before[0])
        XCTAssertTrue(player.isMuted, "video muted again")
        XCTAssertNil(r.entity(for: "a:1")?.components[SpatialAudioComponent.self], "sound stopped")
    }
}
