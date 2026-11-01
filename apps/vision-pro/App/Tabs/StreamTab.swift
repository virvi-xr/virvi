import SwiftUI

/// "Stream Control": the scene's video elements, live or not, with Go Live / Go Offline.
struct StreamTab: View {
    let builder: SceneBuilder
    @ObservedObject var feed: SceneFeed
    let onClose: () -> Void
    @State private var line: EditLine?

    var body: some View {
        let streams = feed.scene.map { StreamModel.streams(scene: $0) } ?? []
        VStack(spacing: 0) {
            PanelHeader(title: "Stream Control", onClose: onClose)
            VStack(alignment: .leading, spacing: 3) {
                EditLineView(line: line)
                if streams.isEmpty {
                    EmptyPanel(text: StreamModel.emptyCopy)
                } else {
                    ForEach(streams, id: \.elementId) { s in
                        CardRow {
                            VStack(alignment: .leading, spacing: 8) {
                                HStack(spacing: 10) {
                                    Text(s.isLive ? "* LIVE" : "  OFFLINE").font(.system(size: 13, weight: .semibold))
                                        .foregroundStyle(s.isLive ? Hud.success : Hud.textDim)
                                    Text(s.name).font(.system(size: 16)).foregroundStyle(Hud.text)
                                }
                                HudButton(label: StreamModel.buttonLabel(s), color: s.isLive ? Hud.danger : Hud.success,
                                          width: 140, height: 34, fontSize: 14) { toggle(s) }
                            }
                        }
                    }
                }
            }
            .padding(12)
        }
    }

    /// The new state arrives through the feed.
    private func toggle(_ s: StreamRow) {
        line = nil
        Task {
            do { try await builder.stream.setLive(s.elementId, !s.isLive) } catch {
                line = EditLine(text: friendlyEditMessage(error), error: true)
            }
        }
    }
}
