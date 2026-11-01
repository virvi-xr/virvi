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
