import Foundation

struct LayoutRow: Equatable {
    let elementId: String
    /// First three letters of the element type, upper case (DclHUDRenderer).
    let typeTag: String
    let name: String
    let enabled: Bool
}

/// The Layout tab: the active preset's elements, hide/show and delete.
final class LayoutModel: Sendable {
    static let maxRows = 12
    static let emptyCopy = "No elements yet"
    static let emptyHint = "Place images and models from the Assets panel"
    static let loadFailedCopy = "Couldn't load the layout"
    static let loadingCopy = "Loading…"
    static let confirmDeleteCopy = "Delete this element and all its copies? This can't be undone."

    /// Feed keys and the element type each holds, for the types the Decentraland layout lists.
    private static let groups: [(key: String, type: String)] = [
        ("images", "image"), ("videos", "video"), ("models", "model"), ("sounds", "sound"), ("adSpaces", "ad_space"),
    ]

    private let api: VirviApi
    private let sceneId: String

    init(api: VirviApi, sceneId: String) {
        self.api = api
        self.sceneId = sceneId
    }

    static func rows(scene: Props) -> (rows: [LayoutRow], more: Int) {
        var all: [LayoutRow] = []
        for (key, type) in groups {
            for case let el as Props in (scene[key] as? [Any]) ?? [] {
                guard let id = el["sk"] as? String else { continue }
                let name = (el["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Unnamed"
                let off = (el["enabled"] as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() && !$0.boolValue } ?? false
                all.append(LayoutRow(elementId: id, typeTag: String(type.uppercased().prefix(3)), name: name, enabled: !off))
            }
        }
        return (Array(all.prefix(maxRows)), max(0, all.count - maxRows))
    }

    static func moreLine(_ n: Int) -> String { "+\(n) more — manage them on the dashboard" }

    func setEnabled(_ elementId: String, _ enabled: Bool) async throws {
        let _: EmptyResponse = try await api.scene(sceneId, "PUT", "/api/elements/\(elementId)", body: ["enabled": enabled])
    }

    func delete(_ elementId: String) async throws {
        let _: EmptyResponse = try await api.scene(sceneId, "DELETE", "/api/elements/\(elementId)", body: nil)
    }
}
