import Foundation

struct EventRow: Equatable, Decodable {
    let id: String
    let name: String
    let startTime: String?
    let endTime: String?
    let live: Bool
}

struct PresetRow: Equatable {
    let id: String
    let name: String
    let active: Bool
}

/// The Events tab: events this scene is part of, and Switch layout.
final class EventsModel: Sendable {
    static let emptyCopy = "No active events"
    static let switchLabel = "Switch layout"

    private let api: VirviApi
    private let sceneId: String

    init(api: VirviApi, sceneId: String) {
        self.api = api
        self.sceneId = sceneId
    }

    private struct EventList: Decodable { let events: [EventRow] }
    private struct SceneAnswer: Decodable {
        struct S: Decodable {
            struct P: Decodable { let id: String; let name: String? }
            let activePresetId: String?
            let presets: [P]?
        }
        let scene: S
    }

    func load() async throws -> [EventRow] {
        let l: EventList = try await api.scene(sceneId, "GET", "/api/scenes/\(sceneId)/events", body: nil)
        return l.events
    }

    /// All of the scene's presets (the feed carries only the active one).
    func loadPresets() async throws -> [PresetRow] {
        let a: SceneAnswer = try await api.scene(sceneId, "GET", "/api/scenes/\(sceneId)", body: nil)
        return (a.scene.presets ?? []).map { PresetRow(id: $0.id, name: $0.name ?? "Preset", active: $0.id == a.scene.activePresetId) }
    }

    /// The scene's presets with the active one (the feed's `sk`) marked. Without a loaded list, just the active preset.
    static func presets(scene: Props, loaded: [PresetRow]?) -> [PresetRow] {
        let active = scene["sk"] as? String
        if let loaded {
            return loaded.map { PresetRow(id: $0.id, name: $0.name, active: $0.id == active) }
        }
        guard let active else { return [] }
        return [PresetRow(id: active, name: (scene["name"] as? String) ?? "Preset", active: true)]
    }

    func switchLayout(_ presetId: String) async throws {
        let _: EmptyResponse = try await api.scene(sceneId, "PUT", "/api/scenes/\(sceneId)", body: ["activePresetId": presetId])
    }
}
