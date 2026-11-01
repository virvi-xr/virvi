import Combine
import Foundation

/// Hands PassProvider's revoke callback to the app once it exists.
private final class RevokeRelay: @unchecked Sendable {
    weak var model: AppModel?
}

/// The app's state: pairing, the scene being built, and the per-scene models. Views read it; logic lives in Core.
@MainActor
final class AppModel: ObservableObject {
    let baseUrl = AppConfig.baseUrl
    let auth: DeviceAuth
    let api: VirviApi
    @Published private(set) var builder: SceneBuilder?
    /// The `build` immersive space is open (it shows the edit bar under the HUD). RootView dismisses it whenever the
    /// scene changes or closes.
    @Published var buildSpaceOpen = false

    init() {
        let store = KeychainStore()
        let transport = URLSessionTransport()
        let relay = RevokeRelay()
        auth = DeviceAuth(baseUrl: baseUrl, transport: transport, store: store)
        let passes = PassProvider(baseUrl: baseUrl, transport: transport, secrets: store, onRevoked: {
            await MainActor.run { relay.model?.revoked() }
        })
        api = VirviApi(baseUrl: baseUrl, transport: transport, passes: passes)
        relay.model = self
    }

    func open(_ scene: DeviceScene) {
        builder?.stop()
        builder = SceneBuilder(api: api, scene: scene)
        builder?.start()
    }

    func closeScene() {
        builder?.stop()
        builder = nil
    }

    /// The headset was revoked (or pairing was lost): drop the scene, its drafts and passes, and go back to pairing.
    func revoked() {
        closeScene()
        auth.onRevoked()
    }
}

/// One scene being built: its feed, edit session, Alerts and the tab models.
@MainActor
final class SceneBuilder: ObservableObject {
    let scene: DeviceScene
    let role: SceneRole
    let feed: SceneFeed
    let edit: EditSession
    let alerts = HudAlerts()
    let layout: LayoutModel
    let assets: AssetsModel
    let events: EventsModel
    let stream: StreamModel
    let worlds: WorldsModel
    let roles: RolesModel
    /// The `build` immersive space's scene, gizmo and head pose.
    let space: BuildSpace
    private var subscriptions: Set<AnyCancellable> = []

    init(api: VirviApi, scene: DeviceScene) {
        self.scene = scene
        role = scene.sceneRole
        feed = SceneFeed(api: api)
        edit = EditSession(api: api, sceneId: scene.sceneId)
        layout = LayoutModel(api: api, sceneId: scene.sceneId)
        assets = AssetsModel(api: api, sceneId: scene.sceneId)
        events = EventsModel(api: api, sceneId: scene.sceneId)
        stream = StreamModel(api: api, sceneId: scene.sceneId)
        worlds = WorldsModel(api: api, sceneId: scene.sceneId)
        roles = RolesModel(api: api, sceneId: scene.sceneId)
        space = BuildSpace(sceneId: scene.sceneId, feed: feed, edit: edit)

        // The spec's Alerts: edit failures and refusals, and stream changes between feed snapshots.
        edit.$message.sink { [alerts] in alerts.editMessage($0) }.store(in: &subscriptions)
        feed.$scene.sink { [alerts] in alerts.scene($0) }.store(in: &subscriptions)
    }

    var sceneId: String { scene.sceneId }

    func start() { feed.start(sceneId: sceneId) }

    /// Change scene, revoke or sign-out: the feed stops, the edit session drops its selection and waiting drafts,
    /// and the build space lets go of the scene (RootView dismisses the space itself).
    func stop() {
        feed.stop()
        edit.end()
        space.teardown()
        subscriptions.removeAll()
    }
}
