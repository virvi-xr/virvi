import Foundation

struct StreamRow: Equatable {
    let elementId: String
    let name: String
    let isLive: Bool
    /// The image the screen shows when nothing plays (LIV-54); "" for none.
    var offImageSrc: String = ""
}

/// An image from the scene library that can be a screen's off image (LIV-54).
struct OffImageChoice: Equatable {
    let id: String
    let name: String
    let url: String
}

/// The Stream tab: the scene's video elements, their live state and off image (port of hyperfy-app's hud/model.ts
/// `streams`, and of the Decentraland HUD's off image picker in adapter-dcl's streams.ts).
final class StreamModel: Sendable {
    static let emptyCopy = "No active streams"
    /// How many images the list shows; the rest are chosen on the dashboard.
    static let offImageListMax = 8

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
            let off = (v["offImageSrc"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
            rows.append(StreamRow(elementId: id, name: name, isLive: isLive(v), offImageSrc: off))
        }
        return rows
    }

    static func isLive(_ video: Props) -> Bool {
        (video["isLive"] as? NSNumber).map { $0.boolValue } ?? false
    }

    static func buttonLabel(_ row: StreamRow) -> String { row.isLive ? "Go Offline" : "Go Live" }

    /// Image types a screen can show (as the Decentraland HUD offers).
    private static let offImageTypes: Set<String> = ["image/png", "image/jpeg", "image/webp", "image/gif"]

    /// The scene library's ready images, for the off image list.
    static func offImageChoices(_ library: [LibraryItem]) -> [OffImageChoice] {
        library.filter { $0.status == "ready" && !$0.url.isEmpty && $0.kind == "media" && offImageTypes.contains($0.contentType ?? "") }
            .map { OffImageChoice(id: $0.id, name: $0.name, url: $0.url) }
    }

    /// "Off image: Poster", by its library name as the dashboard shows it.
    static func offImageLabel(_ row: StreamRow, _ images: [OffImageChoice]) -> String {
        if row.offImageSrc.isEmpty { return "No off image" }
        return "Off image: \(images.first { $0.url == row.offImageSrc }?.name ?? "from a link")"
    }

    func setLive(_ elementId: String, _ on: Bool) async throws {
        let _: EmptyResponse = try await api.scene(sceneId, "POST", "/api/elements/\(elementId)/live", body: ["enabled": on])
    }

    /// Sets (or with "" clears) a screen's off image. PUT /api/elements replaces properties whole, so the screen's own
    /// are read first (GET /api/scenes/:id); "" rather than dropped, so the change reaches the world.
    func setOffImage(_ elementId: String, _ url: String) async throws {
        let data = try await api.sceneData(sceneId, "GET", "/api/scenes/\(sceneId)")
        let root = (try? JSONSerialization.jsonObject(with: data)) as? Props
        let presets = ((root?["scene"] as? Props)?["presets"] as? [Any]) ?? []
        let elements = presets.compactMap { ($0 as? Props)?["elements"] as? [Any] }.joined().compactMap { $0 as? Props }
        guard let element = elements.first(where: { $0["id"] as? String == elementId }) else {
            throw ApiError.status(404, code: "not_found")
        }
        var properties = element["properties"] as? Props ?? [:]
        properties["offImageSrc"] = url
        _ = try await api.sceneData(sceneId, "PUT", "/api/elements/\(elementId)", body: ["properties": properties])
    }
}
