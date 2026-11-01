import Foundation

/// The item being edited. `elementId` and `sk` make up the renderer's item key; `kind` is the draft route's
/// `element` ("image", "video", "model", "sound"). `sk` is the instance id, the one PUT /api/instances/:id takes.
struct Selection: Equatable {
    var elementId: String
    var sk: String
    var name: String
    var kind: String
    var original: ItemTransform
    var current: ItemTransform

    init(elementId: String, sk: String, name: String, kind: String, transform: ItemTransform) {
        self.elementId = elementId
        self.sk = sk
        self.name = name
        self.kind = kind
        original = transform
        current = transform
    }

    /// The item key `SceneRenderer.apply(_:holding:)` uses.
    var key: String { "\(elementId):\(sk)" }
}

/// Move / Rotate / Resize of one item: local transform, live drafts, and Save / Revert / Done as in the Decentraland
/// edit bar. The gizmo (Task 12) calls `update`; the bar reads the published state.
@MainActor
final class EditSession: ObservableObject {
    @Published var mode: EditMode = .move
    @Published var lock: AxisLock = .free
    @Published var snap = false
    @Published private(set) var selected: Selection?
    @Published private(set) var dirty = false
    @Published private(set) var saving = false
    @Published private(set) var message: String?
    @Published private(set) var heldBy: String?

    private let api: VirviApi
    private let sceneId: String
    private var sender: DraftSender!
    private var ending: Task<Void, Never>?

    init(api: VirviApi, sceneId: String, now: @escaping () -> TimeInterval = { Date().timeIntervalSinceReferenceDate },
         schedule: @escaping DraftSender.Schedule = { delay, run in
             Task { @MainActor in
                 try? await Task.sleep(for: .seconds(delay))
                 run()
             }
         }) {
        self.api = api
        self.sceneId = sceneId
        sender = DraftSender(now: now, schedule: schedule, send: { [weak self] draft in await self?.post(draft) })
    }

    var saveEnabled: Bool { dirty && !saving && heldBy == nil }
    var revertEnabled: Bool { dirty && !saving }

    /// The keys the renderer must not move while the feed brings new transforms.
    var editingKeys: Set<String> {
        guard let selected, dirty || saving else { return [] }
        return [selected.key]
    }

    func cycleLock() { lock = lock.next() }

    // MARK: - Selecting

    @discardableResult
    func select(_ s: Selection) -> Bool {
        if dirty, let cur = selected, cur.sk != s.sk {
            message = "Save or revert changes to \(cur.name) first."
            return false
        }
        if selected?.sk != s.sk || selected == nil { selected = s }
        message = nil
        heldBy = nil
        sender.resume()
        return true
    }

    func done() -> Bool {
        if dirty, let selected {
            message = "Save or revert changes to \(selected.name) first."
            return false
        }
        selected = nil
        message = nil
        heldBy = nil
        sender.cancelPending()
        return true
    }

    // MARK: - Editing

    func update(_ t: ItemTransform) {
        guard var s = selected, !saving else { return }
        s.current = snap ? snapped(t, from: s.original) : t
        apply(s)
    }

    func exact(_ field: ExactField, _ v: SIMD3<Double>) {
        guard var s = selected, !saving else { return }
        switch field {
        case .position: s.current.position = v
        case .rotation: s.current.rotation = v
        case .scale: s.current.scale = v
        }
        apply(s)
    }

    private func apply(_ s: Selection) {
        selected = s
        dirty = s.current != s.original
        if message?.hasPrefix("Save or revert") == true { message = nil }
        if dirty, heldBy == nil { sender.submit(DraftPayload(element: s.kind, sk: s.sk, transform: s.current)) }
    }

    // MARK: - Save / Revert

    func save() async {
        guard saveEnabled, let s = selected else { return }
        saving = true
        message = nil
        sender.cancelPending()
        await sender.settle()
        let sent = s.current
        do {
            let _: EmptyResponse = try await api.scene(sceneId, "PUT", "/api/instances/\(s.sk)", body: [
                "position": Self.vec(sent.position), "rotation": Self.vec(sent.rotation), "scale": Self.vec(sent.scale),
            ])
        } catch {
            saving = false
            fail(error)
            return
        }
        saving = false
        if var cur = selected, cur.sk == s.sk {
            cur.original = sent
            selected = cur
            dirty = cur.current != cur.original
        }
        await endDraft(sk: s.sk, saved: true)
    }

    func revert() {
        guard revertEnabled, var s = selected else { return }
        sender.cancelPending()
        s.current = s.original
        selected = s
        dirty = false
        message = nil
        heldBy = nil
        let previous = ending
        ending = Task { @MainActor [sk = s.sk] in
            await previous?.value
            await self.sender.settle()
            await self.endDraft(sk: sk, saved: false)
        }
    }

    /// Completes when every request the session started has been answered (for tests and teardown).
    func idle() async {
        await sender.settle()
        await ending?.value
    }

    // MARK: - Network

    private func post(_ draft: DraftPayload) async {
        do {
            let _: EmptyResponse = try await api.scene(sceneId, "POST", "/api/ar/drafts", body: draft.body)
        } catch ApiError.held(let holder) {
            guard selected?.sk == draft.sk else { return }
            heldBy = holder
            message = "being moved by \(holder)"
            sender.cancelPending(stop: true)
        } catch ApiError.status(401, "device_revoked") {
            dropEverything()
        } catch {
            // A draft is a live preview: a failed one is dropped, and the next update or Save carries the state.
        }
    }

    private func endDraft(sk: String, saved: Bool) async {
        do {
            let _: EmptyResponse = try await api.scene(sceneId, "POST", "/api/ar/drafts/end", body: ["sk": sk, "saved": saved])
        } catch ApiError.status(401, "device_revoked") {
            dropEverything()
        } catch {
            // The hold lapses by itself on the server.
        }
    }

    private func fail(_ error: Error) {
        if case ApiError.status(401, "device_revoked") = error {
            dropEverything()
        } else {
            message = friendlyEditMessage(error)
        }
    }

    /// The headset was revoked: the app is returning to pairing, so nothing is kept or sent.
    private func dropEverything() {
        sender.cancelPending(stop: true)
        selected = nil
        dirty = false
        saving = false
        message = nil
        heldBy = nil
    }

    private static func vec(_ v: SIMD3<Double>) -> [String: Double] { ["x": v.x, "y": v.y, "z": v.z] }
}
