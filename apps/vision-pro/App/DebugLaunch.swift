import Foundation

/// DEBUG-only launch arguments that land on a screen, so simulator screenshots don't need UI automation:
/// `-screen pairing` forgets the pairing first; `-screen picker` stays on the scene picker; `-tab <Name>` opens the
/// first scene (or `-scene <id>`) on that HUD tab. `-build YES` opens the build space once a scene is open;
/// `-select <elementId:instanceId>` selects that item in it; `-editMode Move|Rotate|Resize` and `-exact YES` set
/// the edit bar; `-sceneAhead <m>` puts the scene's centre that far ahead instead of 2 m (the simulator has no head
/// pose and no WorldAnchor, so the scene always goes down at that fixed spot there). Release builds ignore them.
enum DebugLaunch {
    static var screen: String? { value("screen") }
    static var build: Bool { value("build") == "YES" }
    static var selectKey: String? { value("select") }
    static var editMode: EditMode? { value("editMode").flatMap { EditMode(rawValue: $0) } }
    static var exact: Bool { value("exact") == "YES" }
    static var sceneAhead: Double? { value("sceneAhead").flatMap(Double.init) }
    static var sceneId: String? { value("scene") }
    static var tab: HudTab? { value("tab").flatMap { HudTab(rawValue: $0) } }

    private static func value(_ key: String) -> String? {
        #if DEBUG
        return UserDefaults.standard.string(forKey: key)
        #else
        return nil
        #endif
    }
}
