import Foundation

enum FeedStatus: Equatable {
    case idle
    case connecting
    case live
    /// No network; the last scene stays on screen.
    case offline
    case failed(String)
}

/// Long-polls `GET /api/ar/scenes/:id/feed?since=<version>`. Each answer is a whole snapshot; `scene` changes only
/// when the version does. Failures back off 1, 2, 4, 8 s (capped) and keep the last scene.
@MainActor
final class SceneFeed: ObservableObject {
    @Published private(set) var scene: Props?
    @Published private(set) var version: String?
    @Published private(set) var status: FeedStatus = .idle

    /// The server holds a poll for about 25 s.
    static let requestTimeout: TimeInterval = 35
    static let maxBackoff: Double = 8

    private let api: VirviApi
    private let sleep: @Sendable (Double) async -> Void
    private var task: Task<Void, Never>?

    init(api: VirviApi, sleep: @escaping @Sendable (Double) async -> Void = { seconds in
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }) {
        self.api = api
        self.sleep = sleep
    }

    func start(sceneId: String) {
        stop()
        scene = nil
        version = nil
        status = .connecting
        task = Task { [weak self] in await self?.loop(sceneId: sceneId) }
    }

    func stop() {
        task?.cancel()
        task = nil
        status = .idle
    }

    private func loop(sceneId: String) async {
        var delay: Double = 0
        while !Task.isCancelled {
            var path = "/api/ar/scenes/\(sceneId)/feed"
            if let version, let q = version.addingPercentEncoding(withAllowedCharacters: .alphanumerics) { path += "?since=\(q)" }
            do {
                let data = try await api.sceneData(sceneId, "GET", path, timeout: Self.requestTimeout)
                if Task.isCancelled { return }
                guard let snap = Self.parse(data) else { throw ApiError.decode }
                delay = 0
                status = .live
                if snap.version != version {
                    version = snap.version
                    scene = snap.scene
                }
                continue
            } catch {
                if Task.isCancelled { return }
                if case ApiError.status(401, let code) = error, code == "device_revoked" {
                    status = .failed("device_revoked")
                    return // the app goes back to pairing
                }
                if case ApiError.offline = error { status = .offline } else { status = .failed(Self.describe(error)) }
            }
            delay = min(max(delay * 2, 1), Self.maxBackoff)
            await sleep(delay)
        }
    }

    private static func describe(_ error: Error) -> String {
        switch error {
        case ApiError.status(let code, _): return "HTTP \(code)"
        case ApiError.decode: return "Unexpected feed response"
        default: return "Feed error"
        }
    }

    /// `{ v: 1, version: string, scene: object | null }`
    nonisolated static func parse(_ data: Data) -> (version: String, scene: Props?)? {
        guard let o = (try? JSONSerialization.jsonObject(with: data)) as? Props,
              (o["v"] as? NSNumber)?.intValue == 1,
              let version = o["version"] as? String,
              o.keys.contains("scene") else { return nil }
        return (version, o["scene"] as? Props)
    }
}
