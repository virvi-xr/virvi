import ARKit
import AVFoundation
import RealityKit
import SwiftUI
import VirviARKit

/// The scene's fade: `alpha` moves toward 1 (shown) or 0 (hidden) at a rate of a whole fade per `durationMs`, from
/// wherever it has got to.
struct SceneFade {
    let durationMs: Int64
    private(set) var alpha = 0.0
    private var target = 0.0
    private var lastMs: Int64?

    init(durationMs: Int64 = 400) { self.durationMs = durationMs }

    mutating func show(nowMs: Int64) { start(1, nowMs) }
    mutating func hide(nowMs: Int64) { start(0, nowMs) }

    mutating func hideNow() {
        alpha = 0
        target = 0
        lastMs = nil
    }

    mutating func tick(nowMs: Int64) {
        guard alpha != target, let last = lastMs else { return }
        let step = Double(max(nowMs - last, 0)) / Double(durationMs)
        alpha = target > alpha ? min(alpha + step, target) : max(alpha - step, target)
        lastMs = nowMs
    }

    private mutating func start(_ to: Double, _ nowMs: Int64) {
        target = to
        lastMs = nowMs
    }
}

/// The space's scene in the ARView: the package's `SceneRenderer`, its root placed at `realityKitRootTransform` under
/// a world anchor, faded with an `OpacityComponent`. Main thread only.
@MainActor
final class RealitySceneView: SceneView {
    let renderer = SceneRenderer()
    private let anchor = AnchorEntity(world: .zero)
    private var fade = SceneFade(durationMs: 400)
    private var shownAlpha = -1.0

    init(arView: ARView) {
        anchor.addChild(renderer.root)
        arView.scene.addAnchor(anchor)
        applyFade()
    }

    var itemCount: Int { renderer.items.count }

    func apply(_ items: [RenderItem]) { renderer.apply(items) }
    func setRoot(_ root: RootPose) { renderer.root.transform = realityKitRootTransform(root) }

    func setVisible(_ on: Bool, nowMs: Int64) {
        if on { fade.show(nowMs: nowMs) } else { fade.hide(nowMs: nowMs) }
        applyFade()
    }

    func hideNow() {
        fade.hideNow()
        applyFade()
    }

    func clear() {
        renderer.apply([])
        hideNow()
    }

    func tick(nowMs: Int64) {
        fade.tick(nowMs: nowMs)
        applyFade()
        renderer.keepScheduledInStep()
    }

    func setServerOffset(_ ms: Int64) { renderer.serverOffsetMs = ms }
    /// Turned on when the scene first shows: the audio session is left alone until then.
    func setSoundOn(_ on: Bool) {
        if on && !renderer.soundOn { activatePlaybackAudio(AVAudioSession.sharedInstance()) }
        renderer.soundOn = on
    }

    private func applyFade() {
        if fade.alpha == shownAlpha { return }
        shownAlpha = fade.alpha
        renderer.root.components.set(OpacityComponent(opacity: Float(fade.alpha)))
        renderer.root.isEnabled = fade.alpha > 0
    }
}

/// What the world-tracking configuration asks ARKit for, beyond plane detection: with occlusion on (LiDAR phones),
/// scene depth and people for hiding behind people, and the scanned mesh for hiding behind things.
struct SessionSetup: Equatable {
    var frameSemantics: ARConfiguration.FrameSemantics = []
    var sceneReconstruction: ARConfiguration.SceneReconstruction = []

    init(occlusion: Bool, supportsDepth: Bool, supportsMesh: Bool) {
        guard occlusion && supportsDepth else { return }
        frameSemantics = [.sceneDepth, .personSegmentationWithDepth]
        if supportsMesh { sceneReconstruction = .mesh }
    }
}

/// The AR session: runs ARKit world tracking in the ARView and feeds the `VisitorController` (camera pose every frame,
/// camera frames through the `FrameFeeder`, the scanned walls, tracking state, interruptions). ARKit calls the
/// delegate on the main thread.
@MainActor
final class ArSessionDriver: NSObject, ARSessionDelegate {
    let arView: ARView
    let controller: VisitorController
    private let feeder = FrameFeeder()
    private var walls: [UUID: WallPlane] = [:]
    private(set) var occlusionOn = false

    /// On phones with LiDAR: scene depth, so the scene can hide behind people and things (`SessionSetup`).
    static var supportsOcclusion: Bool { ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) }

    init(arView: ARView, controller: VisitorController) {
        self.arView = arView
        self.controller = controller
        super.init()
        arView.session.delegate = self
    }

    func start() {
        guard ARWorldTrackingConfiguration.isSupported else { return } // the simulator
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .denied, .restricted: controller.setCameraDenied(true)
        default: break
        }
        arView.session.run(configuration())
        // An explicit pause may not come back through `sessionInterruptionEnded`; tracking then restarts limited, so
        // rings count again only once it is normal.
        controller.sessionResumed()
    }

    /// The app went to the background: the scene hides at once, as for an interruption.
    func pause() {
        arView.session.pause()
        controller.sessionPaused()
    }

    func setOcclusion(_ on: Bool) {
        guard Self.supportsOcclusion, on != occlusionOn else { return }
        occlusionOn = on
        if on {
            arView.environment.sceneUnderstanding.options.insert(.occlusion)
        } else {
            arView.environment.sceneUnderstanding.options.remove(.occlusion)
        }
        arView.session.run(configuration()) // no reset: tracking and the scanned walls carry on
    }

    private func configuration() -> ARWorldTrackingConfiguration {
        let c = ARWorldTrackingConfiguration()
        c.planeDetection = [.vertical, .horizontal]
        let s = SessionSetup(occlusion: occlusionOn, supportsDepth: Self.supportsOcclusion,
                             supportsMesh: ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh))
        c.frameSemantics = s.frameSemantics
        c.sceneReconstruction = s.sceneReconstruction
        return c
    }

    // MARK: ARSessionDelegate

    nonisolated func session(_ session: ARSession, didUpdate frame: ARFrame) {
        let transform = frame.camera.transform
        let k = frame.camera.intrinsics
        let luma = frame.capturedImage // sensor orientation, as the detector needs it: never rotated for the UI
        MainActor.assumeIsolated {
            controller.onCameraPose(transform)
            feeder.submit(luma: luma, intrinsics: k, cameraTransform: transform, nowMs: uptimeMs()) { [weak self] r in
                guard let self else { return }
                self.controller.onCameraFrame(r, walls: Array(self.walls.values))
            }
        }
    }

    nonisolated func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
        let normal: Bool
        if case .normal = camera.trackingState { normal = true } else { normal = false }
        MainActor.assumeIsolated { controller.trackingChanged(normal: normal) }
    }

    nonisolated func sessionWasInterrupted(_ session: ARSession) {
        MainActor.assumeIsolated { controller.sessionInterrupted() }
    }

    nonisolated func sessionInterruptionEnded(_ session: ARSession) {
        MainActor.assumeIsolated { controller.sessionResumed() }
    }

    nonisolated func session(_ session: ARSession, didFailWithError error: Error) {
        let denied = (error as? ARError)?.code == .cameraUnauthorized
        MainActor.assumeIsolated { if denied { controller.setCameraDenied(true) } }
    }

    nonisolated func session(_ session: ARSession, didAdd anchors: [ARAnchor]) { planes(anchors, removed: false) }
    nonisolated func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) { planes(anchors, removed: false) }
    nonisolated func session(_ session: ARSession, didRemove anchors: [ARAnchor]) { planes(anchors, removed: true) }

    private nonisolated func planes(_ anchors: [ARAnchor], removed: Bool) {
        let changes: [(UUID, WallPlane?)] = anchors.compactMap { a in
            guard let p = a as? ARPlaneAnchor else { return nil }
            return (p.identifier, removed ? nil : wallPlane(from: p))
        }
        if changes.isEmpty { return }
        MainActor.assumeIsolated {
            for (id, wall) in changes { walls[id] = wall }
        }
    }
}

/// The camera view: the app's one ARView.
struct ArSessionView: UIViewRepresentable {
    let arView: ARView

    func makeUIView(context: Context) -> ARView { arView }
    func updateUIView(_ uiView: ARView, context: Context) {}
}
