import SwiftUI

@main
struct VirviBuilderApp: App {
    @StateObject private var app = AppModel()

    var body: some SwiftUI.Scene {
        WindowGroup(id: "main") {
            RootView(app: app, auth: app.auth)
        }
        .defaultSize(width: 680, height: 860)

        WindowGroup(id: "browser", for: URL.self) { $url in
            if let url { BrowserWindow(url: url) }
        }
        .defaultSize(width: 1000, height: 760)

        ImmersiveSpace(id: "build") {
            BuildSpaceView(app: app)
        }
        .immersionStyle(selection: .constant(.mixed), in: .mixed)
    }
}
