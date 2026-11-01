import Foundation

struct WorldRow: Equatable {
    let world: String
    let status: String
    /// Models waiting for a deploy.
    let pending: Int
    /// Opened in a browser window, where the wallet signs.
    let publishUrl: String
}

/// The Worlds tab: the scene's Decentraland World from publish-status.
final class WorldsModel: @unchecked Sendable {
    static let emptyCopy = "No connected worlds"

    private let api: VirviApi
    private let sceneId: String
    private let lock = NSLock()
    private var _destination: PublishDestination?

    init(api: VirviApi, sceneId: String) {
        self.api = api
        self.sceneId = sceneId
    }

    /// The last loaded destination, for `placedMessage`.
    var destination: PublishDestination? { lock.lock(); defer { lock.unlock() }; return _destination }

    private func store(_ d: PublishDestination?) { lock.lock(); _destination = d; lock.unlock() }

    private struct Answer: Decodable { let destination: PublishDestination? }

    @discardableResult
    func load() async throws -> WorldRow? {
        let a: Answer = try await api.scene(sceneId, "GET", "/api/scenes/\(sceneId)/dcl/publish-status", body: nil)
        store(a.destination)
        return a.destination.map { WorldRow(world: $0.world, status: $0.status, pending: $0.pending, publishUrl: $0.publishUrl) }
    }
}
