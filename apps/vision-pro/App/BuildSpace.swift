import ARKit
import Combine
import QuartzCore
import RealityKit
import SwiftUI
import UIKit

/// Putting the scene down (the floor disc and outline move and turn it) or editing items (picking, the gizmo).
/// Edit never moves the whole scene.
enum BuildPhase { case place, edit }

/// Marks the floor disc and parcel outline: in Place, pinch-drag on them slides the scene and a two-hand twist turns it.
struct PlaceHandleComponent: Component {}

/// The `build` immersive space for one scene, ported from the AR spike's SpaceController: the scene life-size with
/// its centre 2 m ahead and north pointing away, the room pin (a `WorldAnchor`, its id in `UserDefaults` per scene),
/// look-and-pinch picking into `EditSession`, the gizmo, and the head pose Assets → Place uses.
///
/// `placement` is the scene's pivot, at its centre (Virvi 8, 0, 8); the renderer's root sits inside it, shifted so the
/// Virvi origin is the parcel's south-west corner.
@MainActor
final class BuildSpace: ObservableObject {
    let sceneId: String
    let edit: EditSession
    let renderer = SceneRenderer()
    let placement = Entity()
    let guides = Entity()
    let gizmo = Gizmo()

    @Published var phase: BuildPhase = .edit { didSet { updateTargets(); refreshGizmo() } }
    @Published private(set) var pinStatus: String
    /// True while world tracking runs, so the head pose is known.
    @Published private(set) var tracking = false
    /// Exact panel open (EditModeBar's `exactOpen`).
    @Published var exactOpen = false

    #if targetEnvironment(simulator)
    // The simulator has no world tracking: the scene goes down at the fixed spot 2 m ahead of the origin, unpinned.
    private let trackingSupported = false
    #else
    private let trackingSupported = WorldTrackingProvider.isSupported
    #endif
    private var session: ARKitSession?
    private var world: WorldTrackingProvider?
    private var pinKey: String { "virvi.pinnedWorldAnchorID.\(sceneId)" }
    private var pinnedID: UUID? {
        didSet { UserDefaults.standard.set(pinnedID?.uuidString, forKey: pinKey) }
    }

    /// An item placed from Assets, selected once the feed shows it.
    private var pendingSelect: String?

    private struct ItemDrag {
        let key: String
        var drag: GizmoDrag
    }

    private var itemDrag: ItemDrag?
    private var dragIgnored = false
    /// Where the current pinch-drag started, in the floor's space (it doesn't move with the scene).
    private var gestureStart: SIMD3<Float>?
    private var placeDragStart: SIMD3<Float>?
    private var placeRotateStart: simd_quatf?
    private var placeGestureActive: Bool { placeDragStart != nil || placeRotateStart != nil }
    private var handleSize = gizmoHandleSize(distance: 2)
    private var subscriptions: Set<AnyCancellable> = []

    init(sceneId: String, feed: SceneFeed, edit: EditSession) {
        self.sceneId = sceneId
        self.edit = edit
        PlaceHandleComponent.registerComponent()
        pinnedID = UserDefaults.standard.string(forKey: "virvi.pinnedWorldAnchorID.\(sceneId)").flatMap(UUID.init(uuidString:))
        pinStatus = "Pinning needs a device"
        if trackingSupported { pinStatus = pinnedID == nil ? "Not pinned" : "Pinned · enter the space to restore" }
        phase = pinnedID == nil ? .place : .edit

        let c = toRealityKitTransform(position: VIRVI_SCENE_CENTER, rotation: Vec3(x: 0, y: 0, z: 0), scale: Vec3(x: 1, y: 1, z: 1))
        renderer.root.position = -SIMD3<Float>(c.position)
        placement.addChild(renderer.root)
        renderer.root.addChild(gizmo.root)
        guides.name = "virvi-guides"
        guides.addChild(Self.makeMarker())
        guides.addChild(Self.makeFootprint())
        placement.addChild(guides)

        renderer.onVisualsReady = { [weak self] key, entity in self?.makeEditable(key: key, entity: entity) }
        renderer.onApplied = { [weak self] d in self?.feedChanged(d) }
        // Every feed change: render, holding the item being edited where the builder has it.
        feed.$scene.sink { [weak self] scene in self?.render(scene) }.store(in: &subscriptions)
        // The selected item's entity follows the session's transform (drags, Exact, Save, and Revert back to the
        // original), looked up by its key each time: the renderer may have rebuilt it.
        edit.$selected.sink { [weak self] s in self?.selectionChanged(s) }.store(in: &subscriptions)
        edit.$mode.sink { [weak self] m in
            self?.dropStaleDrag()
            self?.updateTargets(mode: m); self?.refreshGizmo(mode: m)
        }.store(in: &subscriptions)
        edit.$lock.sink { [weak self] l in self?.refreshGizmo(lock: l) }.store(in: &subscriptions)
        updateTargets()
    }

    /// Change scene, revoke or closing the scene: no more feed or edits into this space, and tracking stops.
    func teardown() {
        subscriptions.removeAll()
        itemDrag = nil
        pendingSelect = nil
        spaceClosed()
    }

    // MARK: - Rendering and selection

    private func render(_ scene: Props?) {
        renderer.apply(planScene(scene), holding: edit.editingKeys)
        if let key = pendingSelect, renderer.item(for: key) != nil {
            pendingSelect = nil
            phase = .edit
            _ = select(key: key)
        }
        refreshGizmo()
    }

    /// Someone else changed or removed the selected item: an unchanged selection takes the feed's new transform; a
    /// removed one is dropped.
    private func feedChanged(_ d: PlanDiff) {
        guard let s = edit.selected else { return }
        if d.remove.contains(s.key) {
            itemDrag = nil
            edit.end()
        } else if itemDrag == nil, !edit.dirty, !edit.saving, let item = d.update.first(where: { $0.key == s.key }),
                  item.source != s.original, edit.done() {
            _ = select(key: item.key)
        }
    }

    @discardableResult
    func select(key: String) -> Bool {
        guard let item = renderer.item(for: key) else { return false }
        return edit.select(Selection(elementId: item.elementId, sk: item.instanceSk, name: item.name, kind: item.elementKind,
                                     transform: item.source))
    }

    private var highlighted: String?

    private func selectionChanged(_ s: Selection?) {
        if let d = itemDrag, d.key != s?.key { dropStaleDrag() }
        if highlighted != s?.key {
            if let old = highlighted, let e = renderer.entity(for: old) { Self.setHighlight(false, on: e) }
            highlighted = s?.key
            if let key = s?.key, let e = renderer.entity(for: key) { Self.setHighlight(true, on: e) }
        }
        if let s, let item = renderer.item(for: s.key), let e = renderer.entity(for: s.key) {
            e.transform = SceneRenderer.entityTransform(for: item, s.current)
        }
        updateTargets(selection: s)
        refreshGizmo(selection: s)
    }

    /// `mode`, `lock` and `selection` are passed by the publishers, which fire before the session's value changes.
    private func refreshGizmo(mode: EditMode? = nil, lock: AxisLock? = nil, selection: Selection?? = nil) {
        let s = selection ?? edit.selected
        let kind = s.flatMap { renderer.item(for: $0.key)?.kind }
        gizmo.show(mode: mode ?? edit.mode, lock: lock ?? edit.lock, transform: phase == .edit ? s?.current : nil,
                   flat: kind == .image || kind == .video, handleSize: handleSize,
                   bounds: s.flatMap { meshBounds(key: $0.key) }, frozen: itemDrag != nil)
    }

    /// The item's mesh in metres in its own frame, on Virvi axes: its hit box times its entity's scale, z mirrored.
    private func meshBounds(key: String) -> GizmoBounds? {
        guard let e = renderer.entity(for: key), let b = e.components[EditableItemComponent.self]?.bounds else { return nil }
        let lo = SIMD3<Double>(b.min * e.scale), hi = SIMD3<Double>(b.max * e.scale)
        return GizmoBounds(min: [lo.x, lo.y, -hi.z], max: [hi.x, hi.y, -lo.z])
    }

    /// Called every frame: handles keep their size in view as the builder walks nearer or further.
    func frameUpdate() {
        guard gizmo.root.isEnabled else { return }
        var distance = 2.0
        if let head = devicePose() {
            let g = gizmo.root.position(relativeTo: nil)
            distance = Double(simd_distance(SIMD3(head.columns.3.x, head.columns.3.y, head.columns.3.z), g))
        }
        let size = gizmoHandleSize(distance: distance)
        if abs(size - handleSize) >= 0.01 {
            handleSize = size
            refreshGizmo()
        }
    }

    // MARK: - Gestures

    /// A pinch-drag. In Place, the floor disc or outline slides the scene; in Edit, a gizmo handle drives the session
    /// under its mode and lock, and the item itself (picked if it wasn't) moves freely in Move.
    func dragChanged(on entity: Entity, start: SIMD3<Float>, now: SIMD3<Float>, parentStart: SIMD3<Float>, parentNow: SIMD3<Float>) {
        // A gesture can end without onEnded (its entity went away): a drag that starts somewhere else is a new one.
        if let last = gestureStart, simd_distance(last, parentStart) > 0.001 { resetDrag() }
        gestureStart = parentStart
        if dragIgnored { return }
        if phase == .place {
            guard placeDragStart != nil || entity.components.has(PlaceHandleComponent.self) else { dragIgnored = true; return }
            if placeDragStart == nil { placeDragStart = placement.position }
            var t = parentNow - parentStart
            t.y = 0 // the scene stays on the floor
            placement.position = placeDragStart! + t
            return
        }
        let grab = fromRealityKitPosition(SIMD3<Double>(start)), here = fromRealityKitPosition(SIMD3<Double>(now))
        if itemDrag == nil {
            guard let started = beginItemDrag(on: entity, grab: grab) else { dragIgnored = true; return }
            itemDrag = started
        }
        // The selection can end mid-drag (Done, a removal, revoke): stop following the hand.
        guard var d = itemDrag, edit.selected?.key == d.key else { itemDrag = nil; dragIgnored = true; return }
        if let t = d.drag.update(to: here) { edit.update(t) }
        itemDrag = d
    }

    private func beginItemDrag(on entity: Entity, grab: SIMD3<Double>) -> ItemDrag? {
        let handle: GizmoHandle
        if let h = gizmo.handle(of: entity) {
            handle = h
        } else if let key = renderer.key(of: entity) {
            if edit.selected?.key != key, !select(key: key) { return nil }
            handle = .body
        } else {
            return nil
        }
        guard let s = edit.selected,
              let drag = GizmoDrag(handle: handle, mode: edit.mode, lock: edit.lock, start: s.current, grab: grab) else { return nil }
        return ItemDrag(key: s.key, drag: drag)
    }

    func dragEnded() {
        let placed = placeDragStart != nil
        resetDrag()
        gestureStart = nil
        if placed { repin() }
    }

    /// A drag whose item or mode changed under it (or whose gesture never ended) stops: the gizmo unfreezes, and
    /// the rest of that gesture is ignored rather than restarting from a stale grab point.
    private func dropStaleDrag() {
        guard itemDrag != nil else { return }
        itemDrag = nil
        dragIgnored = true
    }

    private func resetDrag() {
        let dragged = itemDrag != nil
        itemDrag = nil
        dragIgnored = false
        placeDragStart = nil
        if dragged { refreshGizmo() } // the layout was frozen during the drag
    }

    /// Selects an item placed from Assets: now if the feed already shows it, otherwise as soon as it does.
    func selectWhenShown(_ key: String) {
        if renderer.item(for: key) != nil {
            pendingSelect = nil
            phase = .edit
            select(key: key)
        } else {
            pendingSelect = key
        }
    }

    /// A look-and-pinch on an item selects it.
    func tapped(_ entity: Entity) {
        guard phase == .edit, gizmo.handle(of: entity) == nil, let key = renderer.key(of: entity) else { return }
        select(key: key)
    }

    /// Two-hand twist on the floor disc or outline, in Place: `yaw` about world up since the twist began.
    func twistChanged(on entity: Entity, yaw: Float) {
        guard phase == .place, placeRotateStart != nil || entity.components.has(PlaceHandleComponent.self) else { return }
        if placeRotateStart == nil { placeRotateStart = placement.orientation(relativeTo: nil) }
        placement.setOrientation(simd_quatf(angle: yaw, axis: [0, 1, 0]) * placeRotateStart!, relativeTo: nil)
    }

    func twistEnded() {
        let turned = placeRotateStart != nil
        placeRotateStart = nil
        if turned { repin() }
    }

    // MARK: - Space lifecycle, placing and pinning

    /// The space opened: put the scene 2 m ahead and, on a device, start world tracking and restore the pin.
    func spaceOpened() async {
        placeAhead()
        guard trackingSupported else {
            pinStatus = "Pinning needs a device"
            return
        }
        let session = ARKitSession()
        let world = WorldTrackingProvider()
        do {
            try await session.run([world])
        } catch {
            pinStatus = "World tracking failed: \(error.localizedDescription)"
            return
        }
        self.session = session
        self.world = world
        tracking = true
        if pinnedID == nil {
            placeAhead() // now that the head pose is known
        } else {
            pinStatus = "Pinned · looking for the pinned spot…"
        }
        for await update in world.anchorUpdates {
            guard update.anchor.id == pinnedID else { continue }
            switch update.event {
            case .added, .updated:
                guard update.anchor.isTracked, !placeGestureActive else { continue }
                placement.setTransformMatrix(update.anchor.originFromAnchorTransform, relativeTo: nil)
                pinStatus = "Pinned to this room"
            case .removed:
                pinStatus = "Pinned spot lost · Re-place to start over"
            }
        }
    }

    func spaceClosed() {
        session?.stop()
        session = nil
        world = nil
        tracking = false
    }

    private func devicePose() -> simd_float4x4? {
        guard let world, world.state == .running,
              let head = world.queryDeviceAnchor(atTimestamp: CACurrentMediaTime()), head.isTracked else { return nil }
        return head.originFromAnchorTransform
    }

    /// Where the builder's head is in Virvi scene coordinates and its yaw, from the device pose; nil while the space
    /// isn't open or tracking isn't running (Place then never guesses a spot).
    func headPose() -> (position: SIMD3<Double>, yawDeg: Double)? {
        guard let head = devicePose() else { return nil }
        return headPoseInScene(worldFromHead: Self.double(head), worldFromScene: Self.double(renderer.root.transformMatrix(relativeTo: nil)))
    }

    private static func double(_ m: simd_float4x4) -> simd_double4x4 {
        simd_double4x4(columns: (SIMD4<Double>(m.columns.0), SIMD4<Double>(m.columns.1), SIMD4<Double>(m.columns.2), SIMD4<Double>(m.columns.3)))
    }

    /// The scene's centre 2 m ahead of the builder on the floor, with Virvi north pointing away from them.
    private func placeAhead() {
        var position = SIMD3<Float>(0, 0, -2)
        #if DEBUG
        // `-sceneAhead <m>`: the simulator's fixed spot further away, so a screenshot takes in more of the scene.
        if let ahead = DebugLaunch.sceneAhead { position.z = -Float(ahead) }
        #endif
        var yaw: Float = 0
        if let m = devicePose() {
            var f = SIMD2<Float>(-m.columns.2.x, -m.columns.2.z) // the head looks down its -Z
            if simd_length(f) > 0.01 {
                f = simd_normalize(f)
                position = [m.columns.3.x + 2 * f.x, 0, m.columns.3.z + 2 * f.y]
                yaw = atan2(-f.x, -f.y)
            }
        }
        placement.setPosition(position, relativeTo: nil)
        placement.setOrientation(simd_quatf(angle: yaw, axis: [0, 1, 0]), relativeTo: nil)
    }

    func pin() async {
        guard trackingSupported else {
            pinStatus = "Pinning needs a device"
            return
        }
        guard let world, world.state == .running else {
            pinStatus = "Enter the space first, then pin"
            return
        }
        if let old = pinnedID { try? await world.removeAnchor(forID: old) }
        let anchor = WorldAnchor(originFromAnchorTransform: placement.transformMatrix(relativeTo: nil))
        do {
            try await world.addAnchor(anchor)
            pinnedID = anchor.id
            pinStatus = "Pinned to this room"
        } catch {
            pinStatus = "Pin failed: \(error.localizedDescription)"
        }
    }

    /// Clears the pin and puts the scene 2 m ahead again.
    func replace() async {
        if let old = pinnedID, let world, world.state == .running { try? await world.removeAnchor(forID: old) }
        pinnedID = nil
        pinStatus = trackingSupported ? "Not pinned" : "Pinning needs a device"
        placeAhead()
    }

    /// Keeps the pin where the scene now is after it was slid or turned.
    private func repin() {
        if pinnedID != nil, world != nil { Task { await pin() } }
    }

    #if DEBUG
    /// DEBUG `-select`: select an item for screenshots without a pinch.
    func debugSelect(_ key: String) {
        selectWhenShown(key)
    }
    #endif

    // MARK: - Targets, highlight and guides

    /// Place: only the floor disc and outline take pinches. Edit: items do, except the selected one in Rotate and
    /// Resize, so a pinch near it reaches the rings and handles (in Move it stays grabbable for body drags, and the
    /// arrows sit outside its mesh). `mode` and `selection` come from publishers that fire before the change.
    private func updateTargets(mode: EditMode? = nil, selection: Selection?? = nil) {
        for e in guides.children { e.components[InputTargetComponent.self]?.isEnabled = phase == .place }
        let selected = (selection ?? edit.selected)?.key, m = mode ?? edit.mode
        for e in renderer.root.children where e !== gizmo.root {
            e.components[InputTargetComponent.self]?.isEnabled = itemTargetable(e.name, selected: selected, mode: m)
        }
    }

    private func itemTargetable(_ key: String, selected: String?, mode: EditMode) -> Bool {
        phase == .edit && !(key == selected && mode != .move)
    }

    private func makeEditable(key: String, entity: Entity) {
        var b = entity.visualBounds(recursive: true, relativeTo: entity)
        if b.isEmpty { b = BoundingBox(min: [-0.25, 0, -0.25], max: [0.25, 0.5, 0.25]) }
        let size = simd_max(b.extents, SIMD3<Float>(repeating: 0.02)) // planes get a thin box
        entity.components.set(CollisionComponent(shapes: [ShapeResource.generateBox(size: size).offsetBy(translation: b.center)]))
        var input = InputTargetComponent()
        input.isEnabled = itemTargetable(key, selected: edit.selected?.key, mode: edit.mode)
        entity.components.set(input)
        entity.components.set(HoverEffectComponent())
        entity.components.set(EditableItemComponent(bounds: BoundingBox(min: b.center - size / 2, max: b.center + size / 2)))
        if key == edit.selected?.key {
            Self.setHighlight(true, on: entity)
            refreshGizmo() // the mesh is known now: handles move clear of it
        }
    }

    private static let highlightName = "virvi-selection"

    /// The spike's cyan selection box.
    private static func setHighlight(_ on: Bool, on entity: Entity) {
        entity.findEntity(named: highlightName)?.removeFromParent()
        guard on, let b = entity.components[EditableItemComponent.self]?.bounds else { return }
        var mat = UnlitMaterial(color: UIColor(red: 0.2, green: 0.85, blue: 1, alpha: 1))
        mat.blending = .transparent(opacity: 0.22)
        let box = ModelEntity(mesh: .generateBox(size: b.extents * 1.04 + 0.03), materials: [mat])
        box.name = highlightName
        box.position = b.center
        entity.addChild(box)
    }

    private static func translucent(_ color: UIColor, _ opacity: Float) -> UnlitMaterial {
        var m = UnlitMaterial(color: color)
        m.blending = .transparent(opacity: .init(floatLiteral: opacity))
        return m
    }

    private static func makeHandle(_ e: Entity, collision: ShapeResource) {
        e.components.set(CollisionComponent(shapes: [collision]))
        e.components.set(InputTargetComponent())
        e.components.set(HoverEffectComponent())
        e.components.set(PlaceHandleComponent())
    }

    /// A 0.6 m disc at the scene's centre with an arrow and an "N" pointing to Virvi north (+Z, RealityKit -Z).
    static func makeMarker() -> Entity {
        let marker = Entity()
        marker.name = "virvi-marker"
        let accent = UIColor(red: 0.2, green: 0.85, blue: 1, alpha: 1)
        let disc = ModelEntity(mesh: .generateCylinder(height: 0.004, radius: 0.3), materials: [translucent(.white, 0.35)])
        disc.position.y = 0.002
        marker.addChild(disc)
        let shaft = ModelEntity(mesh: .generateBox(size: [0.04, 0.006, 0.3]), materials: [translucent(accent, 0.9)])
        shaft.position = [0, 0.006, -0.1]
        marker.addChild(shaft)
        let head = ModelEntity(mesh: .generateCone(height: 0.12, radius: 0.07), materials: [translucent(accent, 0.9)])
        head.orientation = simd_quatf(angle: -.pi / 2, axis: [1, 0, 0]) // cone tip (+Y) to -Z
        head.scale = [1, 1, 0.1] // flatten it onto the floor
        head.position = [0, 0.006, -0.31]
        marker.addChild(head)
        let n = ModelEntity(mesh: .generateText("N", extrusionDepth: 0.002, font: .boldSystemFont(ofSize: 0.12), alignment: .center),
                            materials: [UnlitMaterial(color: accent)])
        let nb = n.visualBounds(relativeTo: nil)
        n.orientation = simd_quatf(angle: -.pi / 2, axis: [1, 0, 0]) // lie flat, reading from the south
        n.position = [-nb.center.x, 0.006, -0.42 + nb.center.y]
        marker.addChild(n)
        makeHandle(marker, collision: .generateBox(size: [0.6, 0.06, 0.6]).offsetBy(translation: [0, 0.03, 0]))
        return marker
    }

    /// A thin outline of one 16 m parcel around the scene's centre (Virvi 0…16 on x and z).
    static func makeFootprint() -> Entity {
        let footprint = Entity()
        footprint.name = "virvi-footprint"
        let mat = translucent(UIColor(red: 0.2, green: 0.85, blue: 1, alpha: 1), 0.6)
        let half: Float = 8, w: Float = 0.03
        for (pos, size) in [
            (SIMD3<Float>(0, 0.003, -half), SIMD3<Float>(2 * half, 0.005, w)),
            (SIMD3<Float>(0, 0.003, half), SIMD3<Float>(2 * half, 0.005, w)),
            (SIMD3<Float>(-half, 0.003, 0), SIMD3<Float>(w, 0.005, 2 * half)),
            (SIMD3<Float>(half, 0.003, 0), SIMD3<Float>(w, 0.005, 2 * half)),
        ] {
            let edge = ModelEntity(mesh: .generateBox(size: size), materials: [mat])
            edge.position = pos
            footprint.addChild(edge)
        }
        makeHandle(footprint, collision: .generateBox(size: [2 * half, 0.04, 2 * half]).offsetBy(translation: [0, 0.02, 0]))
        return footprint
    }
}

/// The `build` immersive space: the scene life-size on the floor (an immersive space's origin is at floor level
/// below the builder), with pinch-drag, tap and twist routed to the open scene's `BuildSpace`. One RealityView for
/// the space's whole life, so `buildSpaceOpen` is exact even while the scene changes under it.
struct BuildSpaceView: View {
    @ObservedObject var app: AppModel
    @State private var floor = AnchorEntity(world: .zero)
    @State private var updates: EventSubscription?

    private var space: BuildSpace? { app.builder?.space }

    var body: some View {
        RealityView { content in
            content.add(floor)
            updates = content.subscribe(to: SceneEvents.Update.self) { _ in
                MainActor.assumeIsolated { app.builder?.space.frameUpdate() }
            }
        } update: { _ in
            // Only the open scene's placement is in the room.
            for child in floor.children where child !== space?.placement { child.removeFromParent() }
            if let p = space?.placement, p.parent !== floor { floor.addChild(p) }
        }
        .gesture(
            DragGesture(minimumDistance: 0.01)
                .targetedToAnyEntity()
                .onChanged { v in
                    guard let space else { return }
                    let root = space.renderer.root
                    space.dragChanged(on: v.entity,
                                      start: v.convert(v.startLocation3D, from: .local, to: root),
                                      now: v.convert(v.location3D, from: .local, to: root),
                                      parentStart: v.convert(v.startLocation3D, from: .local, to: floor),
                                      parentNow: v.convert(v.location3D, from: .local, to: floor))
                }
                .onEnded { _ in space?.dragEnded() }
        )
        .simultaneousGesture(
            RotateGesture3D(constrainedToAxis: .y)
                .targetedToAnyEntity()
                .onChanged { v in
                    // SwiftUI's y axis points down; a turn about its +y is a turn about RealityKit's +y with x and z
                    // flipped, so the angle keeps the sign of axis.y.
                    let r = v.rotation
                    space?.twistChanged(on: v.entity, yaw: Float(r.angle.radians) * (r.axis.y >= 0 ? 1 : -1))
                }
                .onEnded { _ in space?.twistEnded() }
        )
        .simultaneousGesture(
            SpatialTapGesture().targetedToAnyEntity().onEnded { v in space?.tapped(v.entity) }
        )
        .onAppear { app.buildSpaceOpen = true }
        .onDisappear {
            app.buildSpaceOpen = false
            space?.spaceClosed()
        }
        .task(id: app.builder.map(ObjectIdentifier.init)) {
            guard let space else { return }
            #if DEBUG
            if let key = DebugLaunch.selectKey { space.debugSelect(key) }
            if let mode = DebugLaunch.editMode { space.edit.mode = mode }
            if DebugLaunch.exact { space.exactOpen = true }
            #endif
            await space.spaceOpened()
        }
    }
}
