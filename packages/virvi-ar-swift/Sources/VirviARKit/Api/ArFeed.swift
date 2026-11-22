import Foundation

/// `offline`: unreachable. `badData`: a 200 that couldn't be parsed. `failed`: any other error status.
public enum FeedStatus: Equatable, Sendable {
    case connecting, live, offline, rateLimited, notFound, badData, failed
}

/// Long-polls a space's feed. Each answer is a whole snapshot; `onSnapshot` fires only when the version changes.
/// Failures back off (doubling, 1 s to 30 s) and keep the last snapshot; a 404 (unpublished or unknown space) reports
/// `notFound` and stops. The callbacks run on a background task: hop to the main actor in them if needed.
public final class ArFeed: @unchecked Sendable {
    public typealias Sleep = @Sendable (TimeInterval) async -> Void

    private let api: ArApi
    private let onSnapshot: (ArFeedSnapshot) -> Void
    private let onStatus: (FeedStatus) -> Void
    private let sleep: Sleep
    private let lock = NSLock()
    private var task: Task<Void, Never>?

    /// `sleep` is the back-off wait (injectable so tests need not wait real seconds).
    public init(api: ArApi, onSnapshot: @escaping (ArFeedSnapshot) -> Void, onStatus: @escaping (FeedStatus) -> Void,
                sleep: @escaping Sleep = { try? await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) }) {
        self.api = api
        self.onSnapshot = onSnapshot
        self.onStatus = onStatus
        self.sleep = sleep
    }

    public func start(spaceId: String) {
        stop()
        onStatus(.connecting)
        let t = Task { [self] in await loop(spaceId) }
        lock.lock(); task = t; lock.unlock()
    }

    public func stop() {
        lock.lock(); let t = task; lock.unlock()
        t?.cancel()
    }

    /// Completes when the current loop has ended (a 404 or `stop()`); for tests.
    func finished() async {
        await current()?.value
    }

    private func current() -> Task<Void, Never>? {
        lock.lock(); defer { lock.unlock() }
        return task
    }

    private func loop(_ spaceId: String) async {
        var version = ""
        var wait = 0.0
        while !Task.isCancelled {
            let result = await api.feed(spaceId: spaceId, since: version.isEmpty ? nil : version)
            if Task.isCancelled { return }
            switch result {
            case .ok(let snap):
                wait = 0
                if snap.version != version {
                    version = snap.version
                    onSnapshot(snap)
                }
                onStatus(.live)
                continue
            case .notFound: return onStatus(.notFound)
            case .rateLimited: onStatus(.rateLimited)
            case .offline: onStatus(.offline)
            case .failed(let status): onStatus(status == 200 ? .badData : .failed)
            }
            wait = min(max(wait * 2, 1), 30)
            await sleep(wait)
        }
    }
}
