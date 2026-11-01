import Foundation

/// DEBUG-only launch arguments that land on a screen, so simulator screenshots don't need UI automation:
/// `-screen pairing` forgets the pairing first; `-screen picker` stays on the scene picker; `-tab <Name>` opens the
/// first scene (or `-scene <id>`) on that HUD tab. Release builds ignore them.
enum DebugLaunch {
    static var screen: String? { value("screen") }
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
