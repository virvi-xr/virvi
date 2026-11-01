import Foundation

struct RoleRow: Equatable {
    let wallet: String
    let role: String
    let displayName: String?
    /// "<name or short wallet> — <role label>" (DclHUDRenderer).
    var title: String { "\(displayName.flatMap { $0.isEmpty ? nil : $0 } ?? RolesModel.shortWallet(wallet)) — \(RolesModel.roleLabel(role))" }
}

struct RolesList: Equatable {
    let hostWallets: [String]
    let roles: [RoleRow]
}

/// The Roles tab. There is no transfer host on the headset: transfers stay on the dashboard.
final class RolesModel: Sendable {
    static let transferLine = "To hand this scene to another host, use Roles on the dashboard."
    static let assignable = ["cohost", "editor", "viewer"]

    private let api: VirviApi
    private let sceneId: String

    init(api: VirviApi, sceneId: String) {
        self.api = api
        self.sceneId = sceneId
    }

    static func roleLabel(_ role: String) -> String {
        switch role {
        case "cohost": return "Co-host"
        case "editor": return "Editor"
        case "viewer": return "Viewer"
        default: return role
        }
    }

    static func shortWallet(_ w: String) -> String { "\(w.prefix(6))…\(w.suffix(4))" }

    private struct Answer: Decodable {
        struct Host: Decodable { let wallets: [String]? }
        struct Role: Decodable { let wallet: String; let role: String; let displayName: String? }
        let host: Host?
        let roles: [Role]
    }

    func load() async throws -> RolesList {
        let a: Answer = try await api.scene(sceneId, "GET", "/api/scenes/\(sceneId)/roles", body: nil)
        return RolesList(hostWallets: a.host?.wallets ?? [],
                         roles: a.roles.map { RoleRow(wallet: $0.wallet, role: $0.role, displayName: $0.displayName) })
    }

    func add(wallet: String, role: String) async throws {
        let _: EmptyResponse = try await api.scene(sceneId, "POST", "/api/scenes/\(sceneId)/roles", body: ["wallet": wallet, "role": role])
    }

    func remove(wallet: String) async throws {
        let _: EmptyResponse = try await api.scene(sceneId, "DELETE", "/api/scenes/\(sceneId)/roles/\(wallet)", body: nil)
    }
}
