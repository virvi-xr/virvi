import SwiftUI

/// "Media Library": the scene's images and GLB models, Rename, Place and Dismiss, and the Upload view.
struct AssetsTab: View {
    let app: AppModel
    let builder: SceneBuilder
    let onClose: () -> Void
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openImmersiveSpace) private var openImmersiveSpace
    @State private var library: [LibraryItem] = []
    @State private var loaded = false
    @State private var failed = false
    @State private var line: EditLine?
    @State private var renaming: (id: String, draft: String)?
    @State private var upload: UploadState?
    @State private var busy = false

    struct UploadState { var loading = true; var error: String?; var link: UploadLink? }

    var body: some View {
        VStack(spacing: 0) {
            PanelHeader(title: "Media Library", subtitle: "Images and GLB models") { upload = nil; onClose() }
            VStack(alignment: .leading, spacing: 3) {
                if !canEdit(builder.role) {
                    EmptyPanel(text: "Only the host, co-hosts and editors can place media")
                } else if let upload {
                    UploadView(state: upload, openUrl: open, newLink: mintLink, back: { self.upload = nil })
                } else {
                    list
                }
            }
            .padding(12)
        }
        .task { if canEdit(builder.role) { await load() } }
    }

    @ViewBuilder private var list: some View {
        let (rows, more) = AssetsModel.rows(library: library) // missingSrcs: the headset has no source yet
        EditLineView(line: line, onAction: open)
        if !rows.isEmpty {
            HStack { Spacer(); uploadButton }.padding(.bottom, 4)
        }
        if rows.isEmpty {
            EmptyPanel(text: failed ? AssetsModel.loadFailedCopy : loaded ? AssetsModel.emptyCopy : "Loading…")
            if loaded && !failed { uploadButton.frame(maxWidth: .infinity) }
        } else {
            ForEach(rows, id: \.id) { row($0) }
        }
        if more > 0 {
            Text(AssetsModel.moreLine(more)).font(.system(size: 14)).foregroundStyle(Hud.textMuted)
        }
    }

    private var uploadButton: some View {
        HudButton(label: "Upload", color: Hud.accent, width: 110, height: 34, fontSize: 14) { mintLink() }
    }

    @ViewBuilder private func row(_ a: AssetRow) -> some View {
        if let r = renaming, r.id == a.id {
            CardRow {
                TextField(a.name, text: Binding(get: { renaming?.draft ?? "" }, set: { renaming?.draft = $0 }))
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { rename(a) }
                HudButton(label: "Save", color: Hud.accent, width: 72, height: 34, fontSize: 14) { rename(a) }
                HudButton(label: "Cancel", width: 80, height: 34, fontSize: 14) { renaming = nil }
            }
        } else {
            CardRow {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        Text(a.tag).font(.system(size: 12, weight: .semibold)).foregroundStyle(a.kind == .model ? Hud.warning : Hud.textMuted)
                        Text(a.name).font(.system(size: 16)).foregroundStyle(Hud.text).lineLimit(1)
                        Text(a.badge).font(.system(size: 13)).foregroundStyle(badgeColor(a.status))
                    }
                    if let e = a.error { Text(e).font(.system(size: 13)).foregroundStyle(Hud.danger).lineLimit(1) }
                }
                Spacer()
                if a.action == .place {
                    HudButton(label: "Rename", width: 84, height: 34, fontSize: 14) { renaming = (a.id, a.name) }
                    HudButton(label: "Place", color: Hud.accent, width: 84, height: 34, fontSize: 14) { place(a) }
                } else if a.action == .dismiss {
                    HudButton(label: "Dismiss", width: 84, height: 34, fontSize: 14) { dismiss(a) }
                }
            }
        }
    }

    private func badgeColor(_ status: String) -> Color {
        switch status {
        case "available": Hud.success
        case "needs_sync": Hud.warning
        case "failed": Hud.danger
        default: Hud.textMuted
        }
    }

    private func load() async {
        do {
            library = try await builder.assets.load()
            failed = false
        } catch {
            failed = true
            line = EditLine(text: friendlyEditMessage(error), error: true)
        }
        loaded = true
    }

    private func rename(_ a: AssetRow) {
        guard !busy, let draft = renaming?.draft else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                try await builder.assets.rename(a.id, to: draft)
                renaming = nil
                line = nil
                await load()
            } catch {
                line = EditLine(text: friendlyRenameError(error), error: true)
            }
        }
    }

    private func dismiss(_ a: AssetRow) {
        Task {
            do {
                try await builder.assets.dismiss(a.id)
                library.removeAll { $0.id == a.id }
            } catch {
                line = EditLine(text: friendlyEditMessage(error), error: true)
            }
        }
    }

    /// Places 2 m ahead of the head, as Decentraland does, from the device pose in the build space (which Place
    /// opens if it isn't); without a pose it says so and places nothing. The new item is then selected. Models add
    /// the World's next-step line (with Publish when the World signs).
    private func place(_ a: AssetRow) {
        guard !busy else { return }
        busy = true
        line = nil
        Task {
            defer { busy = false }
            guard let head = await headPose() else {
                line = EditLine(text: Self.noPoseCopy, error: true); return
            }
            do {
                let placed = try await builder.assets.place(row: a, at: placement(kind: a.kind, headPosition: head.position, headYawDeg: head.yawDeg))
                builder.space.pendingSelect = "\(placed.elementId):\(placed.instanceId)"
            } catch let e as AssetsError {
                line = EditLine(text: e.message, error: true); return
            } catch {
                line = EditLine(text: friendlyEditMessage(error), error: true); return
            }
            if a.kind == .image { line = EditLine(text: "Placed \(a.name)", error: false); return }
            _ = try? await builder.worlds.load() // a failed lookup reads as "none"
            let d = builder.worlds.destination
            let next = placedMessage(name: a.name, destination: d)
            line = EditLine(text: next.text, error: false, actionLabel: next.publish ? "Publish" : nil,
                            actionUrl: next.publish ? d.flatMap { URL(string: $0.publishUrl) } : nil)
        }
    }

    static let noPoseCopy = "Place needs to know where you're facing: look ahead and press Place again"

    /// The head pose, opening the build space first if it isn't open and giving tracking a moment to start.
    private func headPose() async -> (position: SIMD3<Double>, yawDeg: Double)? {
        if let pose = builder.space.headPose() { return pose }
        if !app.buildSpaceOpen { _ = await openImmersiveSpace(id: "build") }
        for _ in 0..<30 {
            try? await Task.sleep(for: .milliseconds(100))
            if let pose = builder.space.headPose() { return pose }
        }
        return nil
    }

    private func mintLink() {
        upload = UploadState()
        Task {
            do { upload?.link = try await builder.assets.uploadLink() } catch { upload?.error = AssetsModel.uploadFailedCopy }
            upload?.loading = false
        }
    }

    private func open(_ url: URL) { openWindow(id: "browser", value: url) }
}

/// Upload link for this computer, the same link as a QR for a phone, and the code to type in by hand.
private struct UploadView: View {
    let state: AssetsTab.UploadState
    let openUrl: (URL) -> Void
    let newLink: () -> Void
    let back: () -> Void

    var body: some View {
        VStack(spacing: 8) {
            Text("Upload media").font(.system(size: 19, weight: .semibold)).foregroundStyle(Hud.text)
            if state.loading { Text("Making a link…").font(.system(size: 15)).foregroundStyle(Hud.textDim) }
            if let e = state.error { Text(e).font(.system(size: 15)).foregroundStyle(Hud.danger) }
            if let link = state.link {
                HudButton(label: "Open on this computer", color: Hud.accent, width: 300) {
                    if let u = URL(string: link.uploadUrl) { openUrl(u) }
                }
                QRCodeView(text: link.uploadUrl, size: 168).padding(.vertical, 6)
                Text("Scan to upload from your phone").font(.system(size: 15)).foregroundStyle(Hud.text)
                Text(link.uploadUrl).font(.system(size: 14)).foregroundStyle(Hud.textDim)
                Text("Code: \(link.code)").font(.system(size: 17, weight: .semibold)).foregroundStyle(Hud.text)
                Text(AssetsModel.expiryLine(link)).font(.system(size: 13)).foregroundStyle(Hud.textMuted)
            }
            HStack(spacing: 10) {
                HudButton(label: "New link", width: 140, height: 36, fontSize: 14, action: newLink)
                HudButton(label: "Back", width: 140, height: 36, fontSize: 14, action: back)
            }
            .padding(.top, 8)
        }
        .frame(maxWidth: .infinity)
    }
}
