import Foundation

/// One entry of `GET /api/scenes/:id/library` (`items`).
struct LibraryItem: Decodable, Equatable {
    let id: String
    /// "media" or "model".
    let kind: String
    let name: String
    let url: String
    let contentType: String?
    /// "uploading", "processing", "ready" or "failed".
    let status: String
    let error: String?
}

struct AssetRow: Equatable {
    enum Action: Equatable { case place, dismiss, none }
    let id: String
    /// "GLB" or "IMG".
    let tag: String
    let name: String
    let badge: String
    let action: Action
    let kind: PlaceKind
    let url: String
    let status: String
    let error: String?
}

/// An upload token (`POST /api/upload-tokens`), as the Decentraland Upload view shows it.
struct UploadLink: Decodable, Equatable {
    let code: String
    let uploadUrl: String
    let qrUrl: String
    let expiresAt: String
    let maxUploads: Int
}

struct PlacedItem: Equatable {
    let elementId: String
    let instanceId: String
}

struct AssetsError: Error, Equatable {
    let message: String
}

/// The Assets tab: the scene's library, placing, renaming and upload links.
final class AssetsModel: Sendable {
    static let maxRows = 10
    static let emptyCopy = "No images or models yet"
    static let loadFailedCopy = "Couldn't load your media library"
    static let uploadFailedCopy = "Couldn't make an upload link — try again"
    /// The upload link's error line: the offline copy without a network, otherwise `uploadFailedCopy`.
    static func uploadLinkError(_ error: Error) -> String {
        if case ApiError.offline = error { return friendlyEditMessage(error) }
        return uploadFailedCopy
    }
    private static let imageTypes: Set<String> = ["image/png", "image/jpeg", "image/webp", "image/gif"]

    private let api: VirviApi
    private let sceneId: String

    init(api: VirviApi, sceneId: String) {
        self.api = api
        self.sceneId = sceneId
    }

    /// Placeable kinds only (images and GLBs), as `toHUDMedia`. `missingSrcs` are placed models whose file isn't
    /// deployed with the scene yet.
    static func rows(library: [LibraryItem], missingSrcs: Set<String> = []) -> (rows: [AssetRow], more: Int) {
        var all: [AssetRow] = []
        for a in library {
            let kind: PlaceKind
            if a.url.isEmpty && a.status == "ready" { continue }
            if a.kind == "model" { kind = .model }
            else if let t = a.contentType, imageTypes.contains(t) { kind = .image }
            else if a.contentType == "model/gltf-binary" || a.name.lowercased().hasSuffix(".glb") { kind = .model }
            else { continue }
            let status = a.status == "ready" ? (kind == .model && missingSrcs.contains(a.url) ? "needs_sync" : "available") : a.status
            let (badge, action): (String, AssetRow.Action) = switch status {
            case "uploading": ("• Uploading", .none)
            case "processing": ("• Processing", .none)
            case "needs_sync": ("⟳ Needs sync", .place)
            case "failed": ("✕ Failed", .dismiss)
            default: ("✓ Available", .place)
            }
            all.append(AssetRow(id: a.id, tag: kind == .model ? "GLB" : "IMG", name: a.name, badge: badge, action: action,
                                kind: kind, url: a.url, status: status, error: status == "failed" ? a.error : nil))
        }
        return (Array(all.prefix(maxRows)), max(0, all.count - maxRows))
    }

    static func moreLine(_ n: Int) -> String { "+\(n) more — place them from the dashboard" }

    /// DclHUDRenderer's SyncNotice.
    static func syncNotice(missing n: Int) -> String? {
        n > 0 ? "\(n) model(s) need sync + redeploy — run npx @virvixr/dcl sync" : nil
    }

    private struct LibraryList: Decodable { let items: [LibraryItem] }
    private struct SceneAnswer: Decodable {
        struct S: Decodable { let activePresetId: String? }
        let scene: S
    }
    private struct ElementAnswer: Decodable { struct E: Decodable { let id: String }; let element: E }
    private struct InstanceAnswer: Decodable { struct I: Decodable { let id: String }; let instance: I }
    private struct TokenAnswer: Decodable { struct T: Decodable { let uploadUrl: String }; let token: T }
    private struct LinkAnswer: Decodable { let token: UploadLink }

    func load() async throws -> [LibraryItem] {
        let list: LibraryList = try await api.scene(sceneId, "GET", "/api/scenes/\(sceneId)/library", body: nil)
        return list.items
    }

    func rename(_ id: String, to name: String) async throws {
        let _: EmptyResponse = try await api.scene(sceneId, "PATCH", "/api/scenes/\(sceneId)/library/\(id)", body: ["name": name])
    }

    /// Removes a failed entry from the library.
    func dismiss(_ id: String) async throws {
        let _: EmptyResponse = try await api.scene(sceneId, "DELETE", "/api/scenes/\(sceneId)/library/\(id)", body: nil)
    }

    func uploadUrl() async throws -> String {
        let a: TokenAnswer = try await api.scene(sceneId, "POST", "/api/upload-tokens", body: ["sceneId": sceneId])
        return a.token.uploadUrl
    }

    /// The Upload view's link, as the Decentraland HUD mints it (images and models, 10 uploads, 30 minutes).
    func uploadLink() async throws -> UploadLink {
        let a: LinkAnswer = try await api.scene(sceneId, "POST", "/api/upload-tokens", body: [
            "sceneId": sceneId, "maxUploads": 10, "expiresInMinutes": 30, "kinds": ["image", "model"],
        ])
        return a.token
    }

    /// "Link expires HH:mm · N uploads" (DclHUDRenderer's UploadView), in local time.
    static func expiryLine(_ link: UploadLink, timeZone: TimeZone = .current) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = f.date(from: link.expiresAt) ?? ISO8601DateFormatter().date(from: link.expiresAt)
        var hhmm = ""
        if let date {
            var cal = Calendar(identifier: .gregorian)
            cal.timeZone = timeZone
            let c = cal.dateComponents([.hour, .minute], from: date)
            hhmm = String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
        }
        return "Link expires \(hhmm) · \(link.maxUploads) uploads"
    }

    /// The element, then its instance, as the Decentraland HUD and the Quest do; if the instance can't be made the
    /// element is deleted again so no empty one is left behind.
    func place(row: AssetRow, at t: ItemTransform) async throws -> PlacedItem {
        if row.action == .dismiss || row.status == "uploading" || row.status == "processing" || row.status == "failed" {
            throw AssetsError(message: "That file isn't ready yet")
        }
        let scene: SceneAnswer = try await api.scene(sceneId, "GET", "/api/scenes/\(sceneId)", body: nil)
        guard let presetId = scene.scene.activePresetId else {
            throw AssetsError(message: "This scene has no active preset — pick one on the dashboard")
        }
        let props: [String: Any] = row.kind == .image ? ["textureSrc": row.url] : ["modelSrc": row.url]
        let el: ElementAnswer = try await api.scene(sceneId, "POST", "/api/presets/\(presetId)/elements", body: [
            "type": row.kind == .image ? "image" : "model", "name": row.name, "enabled": true, "properties": props,
        ])
        do {
            let inst: InstanceAnswer = try await api.scene(sceneId, "POST", "/api/elements/\(el.element.id)/instances", body: [
                "position": Self.vec(t.position), "rotation": Self.vec(t.rotation), "scale": Self.vec(t.scale), "enabled": true,
            ])
            return PlacedItem(elementId: el.element.id, instanceId: inst.instance.id)
        } catch {
            let _: EmptyResponse? = try? await api.scene(sceneId, "DELETE", "/api/elements/\(el.element.id)", body: nil)
            throw error
        }
    }

    private static func vec(_ v: SIMD3<Double>) -> [String: Double] { ["x": v.x, "y": v.y, "z": v.z] }
}
