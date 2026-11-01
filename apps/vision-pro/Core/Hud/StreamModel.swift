import Foundation

struct StreamRow: Equatable {
    let elementId: String
    let name: String
    let isLive: Bool
}

/// The Stream tab: the scene's video elements and their live state (port of hyperfy-app's hud/model.ts `streams`).
final class StreamModel: Sendable {
    static let emptyCopy = "No active streams"

    private let api: VirviApi
    private let sceneId: String

    init(api: VirviApi, sceneId: String) {
        self.api = api
        self.sceneId = sceneId
    }

    static func streams(scene: Props) -> [StreamRow] {
        var rows: [StreamRow] = []
        for case let v as Props in (scene["videos"] as? [Any]) ?? [] {
            guard let id = v["sk"] as? String else { continue }
            let name = (v["name"] as? String).flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 } ?? "Screen"
            rows.append(StreamRow(elementId: id, name: name, isLive: isLive(v)))
        }
        return rows
    }

    static func isLive(_ video: Props) -> Bool {
        (video["isLive"] as? NSNumber).map { $0.boolValue } ?? false
    }

    static func buttonLabel(_ row: StreamRow) -> String { row.isLive ? "Go Offline" : "Go Live" }

    func setLive(_ elementId: String, _ on: Bool) async throws {
        let _: EmptyResponse = try await api.scene(sceneId, "POST", "/api/elements/\(elementId)/live", body: ["enabled": on])
    }
}
