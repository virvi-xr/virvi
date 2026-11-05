import SwiftUI

/// "Scene Layout": the active preset's elements from the feed, Hide/Show and Delete, and Edit layout for editors.
/// Select (not in the Decentraland HUD) picks an element in the room, for things too small, far or buried to pinch.
struct LayoutTab: View {
    @ObservedObject var app: AppModel
    @ObservedObject var builder: SceneBuilder
    @ObservedObject var edit: EditSession
    @ObservedObject var feed: SceneFeed
    let onClose: () -> Void
    @Environment(\.openImmersiveSpace) private var openImmersiveSpace
    @State private var confirmDelete: String?
    /// The element whose "remove every copy" is being confirmed (LIV-12).
    @State private var confirmClear: String?
    @State private var line: EditLine?

    private var editable: Bool { canEdit(builder.role) }

    var body: some View {
        let (rows, more) = feed.scene.map { LayoutModel.rows(scene: $0) } ?? ([], 0)
        VStack(spacing: 0) {
            PanelHeader(title: "Scene Layout", subtitle: builder.scene.sceneName) { confirmDelete = nil; confirmClear = nil; onClose() }
            VStack(alignment: .leading, spacing: 3) {
                EditLineView(line: line)
                if editable {
                    HudButton(label: "Edit layout", color: Hud.accent, height: 40) { startEditing() }
                    .padding(.bottom, 6)
                }
                if rows.isEmpty {
                    let failed = { if case .failed = feed.status { return feed.scene == nil } else { return false } }()
                    let loaded = feed.scene != nil
                    EmptyPanel(text: failed ? LayoutModel.loadFailedCopy : loaded ? LayoutModel.emptyCopy : LayoutModel.loadingCopy,
                               hint: loaded && editable ? LayoutModel.emptyHint : nil)
                } else {
                    ForEach(rows, id: \.elementId) { row($0) }
                }
                if more > 0 {
                    Text(LayoutModel.moreLine(more)).font(.system(size: 14)).foregroundStyle(Hud.textMuted)
                }
                if confirmDelete != nil {
                    Text(LayoutModel.confirmDeleteCopy).font(.system(size: 14)).foregroundStyle(Hud.warning)
                }
                if let id = confirmClear, let r = rows.first(where: { $0.elementId == id }) {
                    Text(LayoutModel.clearPrompt(r)).font(.system(size: 14)).foregroundStyle(Hud.warning)
                }
            }
            .padding(12)
        }
    }

    @ViewBuilder private func row(_ el: LayoutRow) -> some View {
        CardRow {
            Text(el.typeTag).font(.system(size: 12, weight: .semibold)).foregroundStyle(Hud.textMuted).frame(width: 40, alignment: .leading)
            Text(el.name).font(.system(size: 16)).foregroundStyle(el.enabled ? Hud.text : Hud.textDim).lineLimit(1)
            if el.copies > 0 {
                Text(LayoutModel.copiesTag(el)).font(.system(size: 13)).foregroundStyle(Hud.textMuted)
            }
            Spacer()
            if !editable {
                Text(el.enabled ? "ON" : "OFF").font(.system(size: 13, weight: .semibold)).foregroundStyle(el.enabled ? Hud.success : Hud.textDim)
            } else if confirmDelete == el.elementId {
                HudButton(label: "Delete", color: Hud.danger, width: 84, height: 34, fontSize: 14) {
                    confirmDelete = nil
                    run { try await builder.layout.delete(el.elementId) }
                }
                HudButton(label: "Cancel", width: 84, height: 34, fontSize: 14) { confirmDelete = nil }
            } else if confirmClear == el.elementId {
                HudButton(label: "Remove", color: Hud.danger, width: 84, height: 34, fontSize: 14) {
                    confirmClear = nil
                    clear(el)
                }
                HudButton(label: "Cancel", width: 84, height: 34, fontSize: 14) { confirmClear = nil }
            } else {
                if el.enabled, el.typeTag != "SOU" { // a sound has nothing to look at
                    HudButton(label: "Select", color: Hud.accent, width: 84, height: 34, fontSize: 14) {
                        if builder.space.selectElement(el.elementId) { startEditing() }
                    }
                }
                HudButton(label: el.enabled ? "Hide" : "Show", color: el.enabled ? Hud.bgHover : Hud.accent, width: 84, height: 34, fontSize: 14) {
                    run { try await builder.layout.setEnabled(el.elementId, !el.enabled) }
                }
                if el.copies > 0 {
                    HudButton(label: "Clear", width: 84, height: 34, fontSize: 14) { confirmDelete = nil; confirmClear = el.elementId }
                }
                HudButton(label: "Delete", color: Hud.danger, width: 84, height: 34, fontSize: 14) { confirmClear = nil; confirmDelete = el.elementId }
            }
        }
    }

    /// Editing over the scene already in the room (or bringing it back if it was closed).
    private func startEditing() {
        builder.space.editing = true
        onClose()
        if !app.buildSpaceOpen { Task { await openImmersiveSpace(id: "build") } }
    }

    /// Every copy goes, the element stays; the panel says how many went (the copies leave through the feed).
    private func clear(_ el: LayoutRow) {
        line = nil
        Task {
            do {
                let n = try await builder.layout.clearCopies(el.elementId)
                line = EditLine(text: LayoutModel.clearedLine(name: el.name, deleted: n), error: false)
            } catch {
                line = EditLine(text: friendlyEditMessage(error), error: true)
            }
        }
    }

    /// Changes show up through the feed; a failure shows on the panel.
    private func run(_ call: @escaping () async throws -> Void) {
        line = nil
        Task {
            do { try await call() } catch { line = EditLine(text: friendlyEditMessage(error), error: true) }
        }
    }
}
