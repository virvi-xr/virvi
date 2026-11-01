import SwiftUI

/// "World Status": the scene's Decentraland World, its status and pending models, with Publish.
struct WorldsTab: View {
    let builder: SceneBuilder
    let onClose: () -> Void
    @Environment(\.openWindow) private var openWindow
    @State private var world: WorldRow?
    @State private var line: EditLine?

    var body: some View {
        VStack(spacing: 0) {
            PanelHeader(title: "World Status", onClose: onClose)
            VStack(alignment: .leading, spacing: 3) {
                EditLineView(line: line)
                if let w = world {
                    CardRow {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(w.world).font(.system(size: 16)).foregroundStyle(Hud.text)
                                Spacer()
                                Text("\(w.pending) pending").font(.system(size: 14)).foregroundStyle(Hud.textDim)
                            }
                            Text(w.status).font(.system(size: 13)).foregroundStyle(w.status == "deployed" ? Hud.success : Hud.textDim)
                            HudButton(label: "Publish", color: Hud.accent, width: 140, height: 34, fontSize: 14) {
                                if let u = URL(string: w.publishUrl) { openWindow(id: "browser", value: u) }
                            }
                            .padding(.top, 4)
                        }
                    }
                } else {
                    EmptyPanel(text: WorldsModel.emptyCopy)
                }
            }
            .padding(12)
        }
        .task {
            do { world = try await builder.worlds.load() } catch { line = EditLine(text: friendlyEditMessage(error), error: true) }
        }
    }
}
