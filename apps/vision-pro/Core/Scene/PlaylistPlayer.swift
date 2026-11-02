import AVFoundation

/// Plays a playlist on one AVQueuePlayer: each video in turn, then the first again after the last (AVPlayerLooper only
/// repeats a single item). Each video that plays to its end is queued again last, so the queue never runs dry.
final class PlaylistPlayer {
    let player = AVQueuePlayer()
    /// The items this player queued, so another player's end notifications are ignored.
    private var mine: Set<ObjectIdentifier> = []
    private let center: NotificationCenter
    private var observer: NSObjectProtocol?

    init(urls: [URL], center: NotificationCenter = .default) {
        self.center = center
        player.actionAtItemEnd = .advance
        for url in urls { enqueue(url) }
        observer = center.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: nil, queue: .main) { [weak self] note in
            guard let item = note.object as? AVPlayerItem else { return }
            self?.ended(item)
        }
    }

    deinit {
        if let observer { center.removeObserver(observer) }
    }

    /// `item` played to its end (the player moves on to the next one): queue a fresh copy of it last.
    func ended(_ item: AVPlayerItem) {
        guard mine.remove(ObjectIdentifier(item)) != nil, let asset = item.asset as? AVURLAsset else { return }
        enqueue(asset.url)
    }

    private func enqueue(_ url: URL) {
        let item = AVPlayerItem(url: url)
        guard player.canInsert(item, after: nil) else { return }
        player.insert(item, after: nil)
        mine.insert(ObjectIdentifier(item))
    }
}
