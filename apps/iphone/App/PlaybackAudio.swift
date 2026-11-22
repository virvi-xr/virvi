import AVFoundation

/// The parts of `AVAudioSession` the app uses (a fake in tests).
protocol PlaybackAudioSession: AnyObject {
    func setCategory(_ category: AVAudioSession.Category, mode: AVAudioSession.Mode,
                     options: AVAudioSession.CategoryOptions) throws
    func setActive(_ active: Bool, options: AVAudioSession.SetActiveOptions) throws
}

extension AVAudioSession: PlaybackAudioSession {}

/// Once the scene first shows: the playback category, so the scene's video and sounds are heard with the
/// phone on silent, mixed with whatever else is playing. Never before the scene shows. False (logged) if the session refused;
/// the scene then plays as the default session allows.
@discardableResult
func activatePlaybackAudio(_ session: PlaybackAudioSession) -> Bool {
    do {
        try session.setCategory(.playback, mode: .moviePlayback, options: [.mixWithOthers])
        try session.setActive(true, options: [])
        return true
    } catch {
        print("[virvi] audio session: \(error.localizedDescription)")
        return false
    }
}
