import ARKit
import Network
import RealityKit
import SwiftUI
import UserNotifications
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
    let signIn: SignInModel
    let session: AppSession
    let myBeats: MyBeatsModel
    let beats: BeatModel
    private let network = NWPathMonitor()
    /// Kept for the app's life: the notification centre holds its delegate weakly.
    private let notifications: ClaimNotificationRouter

    init() {
        let arView = ARView(frame: .zero, cameraMode: ARWorldTrackingConfiguration.isSupported ? .ar : .nonAR,
                            automaticallyConfigureSession: false)
        self.arView = arView
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        let session = AppSession(baseUrl: AppConfig.baseUrl, transport: URLSessionTransport(), store: KeychainSessionStore())
        self.session = session
        signIn = SignInModel(session: session)
        let api = ArApi(baseUrl: AppConfig.baseUrl, transport: URLSessionTransport(), appVersion: version, session: session)
        let attester = AppAttester(baseUrl: AppConfig.baseUrl, transport: URLSessionTransport(), session: session)
        let beatApi = AppBeatApi(baseUrl: AppConfig.baseUrl, transport: URLSessionTransport(), session: session, attest: attester,
                                 appVersion: version)
        let beats = BeatModel(api: beatApi, session: session, location: VenueLocation(), notifier: SystemClaimNotifier())
        self.beats = beats
        beats.signIn = { [signIn] in signIn.signIn() }
        signIn.onChange = { [weak beats] in beats?.accountChanged() }
        myBeats = MyBeatsModel(api: beatApi)
        myBeats.openCard = { [weak beats] card in beats?.openBeat(card) }
        // Set before launch finishes, so a tap on a reminder that launches the app reaches it
        notifications = ClaimNotificationRouter { [weak beats] id in Task { await beats?.openBeat(id: id) } }
        UNUserNotificationCenter.current().delegate = notifications
        controller = VisitorController(api: api, view: RealitySceneView(arView: arView), outline: RingOutline(arView: arView),
                                       beats: beats)
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
            // SwiftUI hands universal links to `onOpenURL` too; one handler, so a link is looked up once.
            VisitorScreen(model: model)
                .onOpenURL { model.open($0) }
        }
        // `initial`: the phase may already be active when the scene appears. Starting twice is harmless.
        .onChange(of: phase, initial: true) { _, p in
            switch p {
            case .active:
                model.driver.start()
                // An in-person claim may have finished counting while the app was away
                model.beats.appBecameActive()
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
    /// The menu's own height, so its sheet fits it.
    @State private var menuHeight: CGFloat = 320

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
            VisitorMenu(controller: controller, signIn: model.signIn, myBeats: model.myBeats, occlusionSupported: ArSessionDriver.supportsOcclusion,
                        occlusionOn: $occlusionOn) { menuOpen = false }
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { menuHeight = $0 }
                .presentationDetents([.height(menuHeight)])
        }
        .onChange(of: occlusionOn) { _, on in model.driver.setOcclusion(on) }
        .onChange(of: controller.menuButtonShown) { _, shown in if !shown { menuOpen = false } }
    }
}
