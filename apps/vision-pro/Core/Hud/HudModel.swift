import Foundation

/// The HUD's tabs, in the Decentraland HUD's order (DclHUDRenderer NavBar).
enum HudTab: String, CaseIterable {
    case layout = "Layout", assets = "Assets", events = "Events", stream = "Stream"
    case worlds = "Worlds", alerts = "Alerts", roles = "Roles", stats = "Stats"
}

/// The builder's role on the scene, as the Decentraland HUD's `state.sceneRole`. The headset learns it from the
/// scene list (`DeviceScene.role`), which the server derives from the approver's scene access.
enum SceneRole: String {
    case host, cohost, editor, viewer
}

/// All tabs, with Roles only for host and cohost.
func visibleTabs(role: SceneRole) -> [HudTab] {
    HudTab.allCases.filter { $0 != .roles || role == .host || role == .cohost }
}

func canEdit(_ role: SceneRole) -> Bool {
    role == .host || role == .cohost || role == .editor
}

/// Wording for a failed edit (DclHUDRenderer's friendlyEditError, plus the Quest's offline copy).
func friendlyEditMessage(_ error: Error) -> String {
    switch error as? ApiError {
    case .offline: return "Can't reach virvi.io: check the connection and try again"
    case .status(401, _), .status(403, _): return "You don't have permission to edit this scene"
    case .status(404, _): return "That item no longer exists — reopen the panel to refresh"
    default: return "Something went wrong — try again"
    }
}

/// DclHUDRenderer's friendlyRenameError (packages/adapter-dcl/src/index.ts), for the Assets tab's Rename.
func friendlyRenameError(_ error: Error) -> String {
    switch error as? ApiError {
    case .status(400, _): return "Names need 1-120 characters, without slashes"
    case .status(409, _): return "That file isn't ready yet"
    default: return friendlyEditMessage(error)
    }
}

/// The adapter's friendlyRoleError, with the dashboard's Roles wording (apps/web SceneRoles.tsx). Transfer-host codes
/// stay in the table for parity even though the headset never transfers host.
func friendlyRoleError(_ error: Error) -> String {
    let words = [
        "Forbidden": "Only the host and co-hosts can manage roles.",
        "is_host": "That wallet is the host.",
        "not_a_signed_in_cohost": "They need to sign in to Virvi with that wallet before they can become host.",
        "host_has_no_wallet": "Link your wallet in Settings before transferring host.",
    ]
    if case ApiError.status(_, let code?) = error, let w = words[code] { return w }
    if case ApiError.offline = error { return friendlyEditMessage(error) }
    return "Something went wrong — try again"
}
