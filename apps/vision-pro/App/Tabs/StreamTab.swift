import SwiftUI

/// "Stream Control": the scene's video elements, live or not, with Go Live / Go Offline.
struct StreamTab: View {
    let builder: SceneBuilder
    @ObservedObject var feed: SceneFeed
    let onClose: () -> Void
    @State private var line: EditLine?
    /// The screen whose off image list is open, the library's images, and an off image change in flight (LIV-54).
    @State private var picking: String?
    @State private var images: [OffImageChoice] = []
    @State private var busy = false
    /// The screen whose stream list is open, and the scene's streams (LIV-53).
    @State private var choosing: String?
    @State private var sceneStreams: [SceneStream] = []

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
                                Text(StreamModel.sourceLabel(s, sceneStreams)).font(.system(size: 13)).foregroundStyle(Hud.textDim)
                                HStack(spacing: 10) {
                                    HudButton(label: choosing == s.elementId ? "Close list" : "Choose stream", width: 140, height: 34, fontSize: 14) {
                                        picking = nil
                                        choosing = choosing == s.elementId ? nil : s.elementId
                                    }
                                    HudButton(label: StreamModel.buttonLabel(s), color: s.isLive ? Hud.danger : Hud.success,
                                              width: 140, height: 34, fontSize: 14) { toggle(s) }
                                }
                                if choosing == s.elementId { streamList(s) }
                                HStack(spacing: 10) {
                                    Text(StreamModel.offImageLabel(s, images)).font(.system(size: 13)).foregroundStyle(Hud.textDim)
                                    Spacer()
                                    HudButton(label: picking == s.elementId ? "Close list" : "Change", width: 110, height: 30, fontSize: 13) {
                                        choosing = nil
                                        picking = picking == s.elementId ? nil : s.elementId
                                    }
                                }
                                if picking == s.elementId { offImageList(s) }
                            }
                        }
                    }
                }
            }
            .padding(12)
        }
        .task { await loadImages() }
        .task { await loadStreams() }
    }

    /// The scene's streams, the current one ticked.
    @ViewBuilder private func streamList(_ s: StreamRow) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if sceneStreams.isEmpty {
                Text("No streams yet: set one up on the Streaming page at virvi.io").font(.system(size: 13)).foregroundStyle(Hud.textDim)
            }
            ForEach(sceneStreams, id: \.id) { st in
                let current = st.hlsPlaylistUrl == s.liveSrc
                HudButton(label: (current ? "✓ " : "") + StreamModel.optionLabel(st),
                          color: current ? Hud.accent : Hud.bgHover, width: 300, height: 30, fontSize: 13) { chooseStream(s, st) }
            }
        }
    }

    /// Without the list (an older server, a shared headset) Go Live and the off image still work.
    private func loadStreams() async {
        sceneStreams = (try? await builder.stream.loadStreams()) ?? []
    }

    /// The new stream arrives through the feed.
    private func chooseStream(_ s: StreamRow, _ st: SceneStream) {
        guard !busy else { return }
        busy = true
        line = nil
        Task {
            defer { busy = false }
            do {
                try await builder.stream.chooseStream(s.elementId, st.hlsPlaylistUrl)
                choosing = nil
            } catch {
                line = EditLine(text: friendlyEditMessage(error), error: true)
            }
        }
    }

    /// Shown when the screen has nothing to play: the library's images (up to 8), and None.
    @ViewBuilder private func offImageList(_ s: StreamRow) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Shown when the screen has nothing to play").font(.system(size: 12)).foregroundStyle(Hud.textDim)
            if images.isEmpty {
                Text("No images yet: upload one from the Assets tab").font(.system(size: 13)).foregroundStyle(Hud.textDim)
            }
            ForEach(images.prefix(StreamModel.offImageListMax), id: \.id) { img in
                HudButton(label: img.url == s.offImageSrc ? "✓ \(img.name)" : img.name,
                          color: img.url == s.offImageSrc ? Hud.accent : Hud.bgHover, width: 300, height: 30, fontSize: 13) { setOffImage(s, img.url) }
            }
            if images.count > StreamModel.offImageListMax {
                Text("+\(images.count - StreamModel.offImageListMax) more: choose them on the dashboard").font(.system(size: 12)).foregroundStyle(Hud.textDim)
            }
            if !s.offImageSrc.isEmpty {
                HudButton(label: "No off image", width: 300, height: 30, fontSize: 13) { setOffImage(s, "") }
            }
        }
    }

    /// The scene library's images; without them the stream controls still work.
    private func loadImages() async {
        images = StreamModel.offImageChoices((try? await builder.assets.load()) ?? [])
    }

    /// The new image arrives through the feed.
    private func setOffImage(_ s: StreamRow, _ url: String) {
        guard !busy else { return }
        busy = true
        line = nil
        Task {
            defer { busy = false }
            do {
                try await builder.stream.setOffImage(s.elementId, url)
                picking = nil
            } catch {
                line = EditLine(text: friendlyEditMessage(error), error: true)
            }
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
