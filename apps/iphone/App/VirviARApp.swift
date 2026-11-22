import ARKit
import Network
import RealityKit
import SwiftUI
import VirviARKit

/// The space code a universal link opens, or nil for any other URL: only `https://virvi.io/s/<code>` counts, with the
/// code read as the server reads it (`RingCodec.parseCode`) and given back in its canonical form.
func spaceCode(fromLink url: URL) -> String? {
    guard url.scheme?.lowercased() == "https", url.host?.lowercased() == "virvi.io" else { return nil }
    let parts = url.path.split(separator: "/", omittingEmptySubsequences: true)
    guard parts.count == 2, parts[0] == "s", let id = RingCodec.parseCode(String(parts[1])) else { return nil }
    return RingCodec.codeOf(id)
}

/// The app's parts, made once at launch (before any view) so a link that launches the app has somewhere to go.
@MainActor
final class AppModel {
    let arView: ARView
    let controller: VisitorController
    let driver: ArSessionDriver
    private let network = NWPathMonitor()

    init() {
        let arView = ARView(frame: .zero, cameraMode: ARWorldTrackingConfiguration.isSupported ? .ar : .nonAR,
                            automaticallyConfigureSession: false)
        self.arView = arView
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        let api = ArApi(baseUrl: AppConfig.baseUrl, transport: URLSessionTransport(), appVersion: version)
        controller = VisitorController(api: api, view: RealitySceneView(arView: arView), outline: RingOutline(arView: arView))
        driver = ArSessionDriver(arView: arView, controller: controller)
        let controller = controller
        network.pathUpdateHandler = { path in
            let offline = path.status != .satisfied
            DispatchQueue.main.async { MainActor.assumeIsolated { controller.setOffline(offline) } }
        }
        network.start(queue: DispatchQueue(label: "io.virvi.ar.network"))
    }

    func open(_ url: URL) {
        if let code = spaceCode(fromLink: url) { controller.openSpace(code: code) }
    }
}

@main
struct VirviARApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var phase

    var body: some SwiftUI.Scene {
        WindowGroup {
            VisitorScreen(model: model)
                .onOpenURL { model.open($0) }
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { a in
                    if let url = a.webpageURL { model.open(url) }
                }
        }
        .onChange(of: phase) { _, p in
            switch p {
            case .active: model.driver.start()
            case .background:
                model.driver.pause()
                model.controller.flushAnalytics()
            default: break
            }
        }
    }
}

/// The camera view, the "⋯" button top right and the hint card at the bottom.
struct VisitorScreen: View {
    let model: AppModel
    @State private var menuOpen = false
    @State private var occlusionOn = false

    var body: some View {
        let controller = model.controller
        ZStack {
            ArSessionView(arView: model.arView).ignoresSafeArea()
            VStack {
                HStack {
                    Spacer()
                    if controller.menuButtonShown {
                        MenuButton { menuOpen = true }.padding(.trailing, 16).padding(.top, 8)
                    }
                }
                Spacer()
                HintCard(controller: controller)
            }
        }
        .sheet(isPresented: $menuOpen) {
            VisitorMenu(controller: controller, occlusionSupported: ArSessionDriver.supportsOcclusion,
                        occlusionOn: $occlusionOn) { menuOpen = false }
                .presentationDetents([.height(320)])
        }
        .onChange(of: occlusionOn) { _, on in model.driver.setOcclusion(on) }
        .onChange(of: controller.menuButtonShown) { _, shown in if !shown { menuOpen = false } }
    }
}
