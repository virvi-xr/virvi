import AVFoundation
import CryptoKit
import Foundation
import GLTFKit2
import ImageIO
import RealityKit
import UIKit

/// Builds and updates RealityKit entities for a Virvi scene plan. `root` is the Virvi scene frame (already mapped to
/// RealityKit axes): its origin is the parcel's south-west corner at ground level. Like the Hyperfy app, each item
/// gets its own entity carrying the mapped transform; planes and sounds take no scale (a plane's Virvi scale is its
/// width and height), models take the scale and turn half a turn inside it (MODEL_TURN).
/// Marks an item entity that can be edited locally; `bounds` is its visual bounds in its own space.
struct EditableItemComponent: Component {
    var bounds: BoundingBox
}

@MainActor
final class SceneRenderer {
    let root = Entity()
    var soundOn = false {
        didSet { if soundOn != oldValue { rebuild() } }
    }

    /// Called once an item's visible content is in place (a model only after it has loaded), so platform code can
    /// fit collision shapes to it. Not called for sounds.
    var onVisualsReady: ((String, Entity) -> Void)?
    /// Called after each feed snapshot is applied, with what changed.
    var onApplied: ((PlanDiff) -> Void)?

    private var plan: [RenderItem] = []
    private var shown: [String: Entity] = [:]
    private var tokens: [String: UUID] = [:]
    private var players: [String: (AVPlayer, AVPlayerLooper?)] = [:]

    init() {
        root.name = "virvi-scene"
        EditableItemComponent.registerComponent()
    }

    /// `holding` are the keys being edited: their entities keep their current transform; everything else follows
    /// the plan.
    func apply(_ next: [RenderItem], holding: Set<String> = []) {
        let d = diffPlans(plan, next)
        for key in d.remove { remove(key) }
        for item in d.update {
            if holding.contains(item.key), let old = plan.first(where: { $0.key == item.key }), let entity = shown[item.key] {
                var moved = old
                moved.transform = item.transform
                if moved == item { continue } // only the transform changed: leave the entity alone
                let kept = entity.transform
                remove(item.key)
                add(item)
                shown[item.key]?.transform = kept
                continue
            }
            remove(item.key)
            add(item)
        }
        for item in d.add { add(item) }
        plan = next
        onApplied?(d)
    }

    // MARK: - Lookup (for local edits)

    func entity(for key: String) -> Entity? { shown[key] }
    func item(for key: String) -> RenderItem? { plan.first { $0.key == key } }
    /// What the last snapshot shows, in plan order.
    var items: [RenderItem] { plan }

    /// The item key of `entity` or of the item entity it sits inside; nil when it isn't part of an item.
    func key(of entity: Entity) -> String? {
        var e: Entity? = entity
        while let cur = e {
            if cur.parent === root { return shown[cur.name] === cur ? cur.name : nil }
            e = cur.parent
        }
        return nil
    }

    /// The element id and instance `sk` of the item `entity` belongs to; for picking.
    func instanceKey(_ entity: Entity) -> (elementId: String, sk: String)? {
        guard let key = key(of: entity), let item = item(for: key) else { return nil }
        return (item.elementId, item.instanceSk)
    }

    /// The transform the feed gives an item's entity (what a local edit is reset to).
    func feedTransform(for key: String) -> Transform? {
        item(for: key).map(Self.transform(of:))
    }

    private static func transform(of item: RenderItem) -> Transform {
        let t = item.transform
        return Transform(
            scale: item.kind == .model ? SIMD3<Float>(t.scale) : SIMD3<Float>(1, 1, 1),
            rotation: t.orientation.float,
            translation: SIMD3<Float>(t.position)
        )
    }

    /// The transform an item's entity shows for a local edit `t` (Virvi coordinates), as `transform(of:)` maps the
    /// feed's: models take the scale; planes were built at the feed's width and height, so they scale relative to it.
    static func entityTransform(for item: RenderItem, _ t: ItemTransform) -> Transform {
        let m = toRealityKitTransform(position: Vec3(x: t.position.x, y: t.position.y, z: t.position.z),
                                      rotation: Vec3(x: t.rotation.x, y: t.rotation.y, z: t.rotation.z),
                                      scale: Vec3(x: t.scale.x, y: t.scale.y, z: t.scale.z))
        let scale: SIMD3<Float>
        switch item.kind {
        case .model: scale = SIMD3<Float>(m.scale)
        case .image, .video:
            let w = abs(item.width) > 0.001 ? item.width : 1, h = abs(item.height) > 0.001 ? item.height : 1
            scale = [Float(t.scale.x / w), Float(t.scale.y / h), 1]
        case .audio: scale = [1, 1, 1]
        }
        return Transform(scale: scale, rotation: m.orientation.float, translation: SIMD3<Float>(m.position))
    }

    private func rebuild() {
        let current = plan
        for item in current { remove(item.key) }
        plan = []
        apply(current)
    }

    // MARK: - Items

    private func add(_ item: RenderItem) {
        let token = UUID()
        tokens[item.key] = token
        let group = Entity()
        group.name = item.key
        group.transform = Self.transform(of: item)
        root.addChild(group)
        shown[item.key] = group
        let alive = { [weak self] in self?.tokens[item.key] == token }

        switch item.kind {
        case .image: addImage(item, to: group, alive: alive)
        case .video: addVideo(item, to: group)
        case .model: addModel(item, to: group, alive: alive)
        case .audio: addSound(item, to: group, alive: alive)
        }
    }

    private func remove(_ key: String) {
        tokens.removeValue(forKey: key)
        shown.removeValue(forKey: key)?.removeFromParent()
        if let (player, _) = players.removeValue(forKey: key) { player.pause() }
    }

    private func plane(_ item: RenderItem, material: any RealityKit.Material) -> ModelEntity {
        let w = Float(max(abs(item.width), 0.001))
        let h = Float(max(abs(item.height), 0.001))
        return ModelEntity(mesh: .generatePlane(width: w, height: h), materials: [material])
    }

    private func addImage(_ item: RenderItem, to group: Entity, alive: @escaping () -> Bool) {
        var placeholder = UnlitMaterial(color: UIColor(white: 0.5, alpha: 0.4))
        placeholder.blending = .transparent(opacity: 1.0)
        placeholder.faceCulling = .none
        let entity = plane(item, material: placeholder)
        group.addChild(entity)
        onVisualsReady?(item.key, group)
        Task {
            do {
                let file = try await Downloads.shared.file(for: item.src)
                guard let src = CGImageSourceCreateWithURL(file as CFURL, nil),
                      let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else { throw RenderError.badImage }
                let texture = try await TextureResource(image: cg, options: .init(semantic: .color))
                guard alive() else { return }
                var mat = UnlitMaterial()
                mat.color = .init(tint: .white, texture: .init(texture))
                mat.blending = .transparent(opacity: 1.0)
                mat.faceCulling = .none
                entity.model?.materials = [mat]
            } catch {
                print("[virvi] image failed: \(item.key) \(error.localizedDescription)")
            }
        }
    }

    private func addVideo(_ item: RenderItem, to group: Entity) {
        guard let url = URL(string: item.src) else { return }
        let player: AVPlayer
        var looper: AVPlayerLooper?
        if item.loop && extOf(item.src) == "mp4" {
            let q = AVQueuePlayer()
            looper = AVPlayerLooper(player: q, templateItem: AVPlayerItem(url: url))
            player = q
        } else {
            player = AVPlayer(url: url)
        }
        player.isMuted = !soundOn
        player.volume = Float(item.volume)
        var mat = VideoMaterial(avPlayer: player)
        mat.faceCulling = .none
        group.addChild(plane(item, material: mat))
        onVisualsReady?(item.key, group)
        players[item.key] = (player, looper)
        player.play()
    }

    private func addModel(_ item: RenderItem, to group: Entity, alive: @escaping () -> Bool) {
        let turn = Entity()
        turn.orientation = quaternionYXZ(MODEL_TURN).float
        group.addChild(turn)
        guard ["glb", "gltf"].contains(extOf(item.src)) else {
            showPlaceholder(item, in: turn, group: group)
            return
        }
        Task {
            do {
                let file = try await Downloads.shared.file(for: item.src)
                let asset = try GLTFAsset(url: file)
                guard let scene = asset.defaultScene ?? asset.scenes.first else { throw RenderError.noScene }
                let model = GLTFRealityKitLoader.convert(scene: scene, asset: asset)
                removeColliders(in: model, meshColliderNodes: meshColliderNodes(scene))
                guard alive() else { return }
                turn.addChild(model)
                self.onVisualsReady?(item.key, group)
                for anim in model.availableAnimations { model.playAnimation(anim.repeat()) }
            } catch {
                print("[virvi] model failed, showing placeholder: \(item.key) \(error.localizedDescription)")
                guard alive() else { return }
                self.showPlaceholder(item, in: turn, group: group)
            }
        }
    }

    /// The pink box stands in for a model that can't be shown. It is pickable like any other item.
    private func showPlaceholder(_ item: RenderItem, in turn: Entity, group: Entity) {
        turn.addChild(Self.placeholderBox(named: URL(string: item.src)?.lastPathComponent ?? item.src))
        let bounds = BoundingBox(min: [-0.25, 0, -0.25], max: [0.25, 0.5, 0.25])
        group.components.set(CollisionComponent(shapes: [ShapeResource.generateBox(size: bounds.extents).offsetBy(translation: bounds.center)]))
        group.components.set(EditableItemComponent(bounds: bounds))
        onVisualsReady?(item.key, group)
    }

    private func addSound(_ item: RenderItem, to group: Entity, alive: @escaping () -> Bool) {
        guard soundOn else { return }
        Task {
            do {
                let file = try await Downloads.shared.file(for: item.src)
                let res = try await AudioFileResource(contentsOf: file, configuration: .init(loadingStrategy: .preload, shouldLoop: item.loop))
                guard alive() else { return }
                group.components.set(SpatialAudioComponent(gain: 20 * log10(max(item.volume, 0.001))))
                group.playAudio(res)
            } catch {
                print("[virvi] sound failed: \(item.key) \(error.localizedDescription)")
            }
        }
    }

    static func placeholderBox(named name: String) -> Entity {
        let e = Entity()
        let box = ModelEntity(mesh: .generateBox(size: 0.5), materials: [SimpleMaterial(color: .systemPink, isMetallic: false)])
        box.position = [0, 0.25, 0]
        e.addChild(box)
        let text = ModelEntity(
            mesh: .generateText(name, extrusionDepth: 0.005, font: .systemFont(ofSize: 0.08), alignment: .center),
            materials: [UnlitMaterial(color: .white)]
        )
        let b = text.visualBounds(relativeTo: nil)
        // The box sits inside the model's half turn; turn the label back (and re-centre it) so it reads upright
        // from the scene's south side.
        text.orientation = simd_quatf(angle: .pi, axis: [0, 1, 0])
        text.position = [b.center.x, 0.6, 0]
        e.addChild(text)
        return e
    }
}

enum RenderError: LocalizedError {
    case badImage, noScene
    var errorDescription: String? {
        switch self {
        case .badImage: return "could not decode image"
        case .noScene: return "glTF has no scene"
        }
    }
}

/// Downloads media to the caches folder once per URL; keeps the URL's extension so loaders can sniff it.
actor Downloads {
    static let shared = Downloads()
    private var inflight: [String: Task<URL, Error>] = [:]
    private let dir: URL = {
        let d = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("virvi-media", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()

    func file(for src: String) async throws -> URL {
        if let t = inflight[src] { return try await t.value }
        let dir = self.dir
        let t = Task<URL, Error> {
            guard let url = URL(string: src) else { throw URLError(.badURL) }
            let hash = SHA256.hash(data: Data(src.utf8)).prefix(12).map { String(format: "%02x", $0) }.joined()
            let ext = extOf(src)
            let dest = dir.appendingPathComponent(ext.isEmpty ? hash : "\(hash).\(ext)")
            if FileManager.default.fileExists(atPath: dest.path) { return dest }
            let (tmp, resp) = try await URLSession.shared.download(from: url)
            if let code = (resp as? HTTPURLResponse)?.statusCode, code >= 400 { throw URLError(.badServerResponse) }
            try? FileManager.default.removeItem(at: dest)
            try FileManager.default.moveItem(at: tmp, to: dest)
            return dest
        }
        inflight[src] = t
        do { return try await t.value } catch { inflight[src] = nil; throw error }
    }
}

extension simd_quatd {
    var float: simd_quatf { simd_quatf(vector: SIMD4<Float>(vector)) }
}
