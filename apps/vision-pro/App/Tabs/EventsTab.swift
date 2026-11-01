import SwiftUI

/// "Event Control": the events this scene is part of, then Switch layout over the scene's presets.
struct EventsTab: View {
    let builder: SceneBuilder
    @ObservedObject var feed: SceneFeed
    let onClose: () -> Void
    @State private var events: [EventRow] = []
    @State private var presets: [PresetRow]?
    @State private var picking = false
    @State private var line: EditLine?

    var body: some View {
        VStack(spacing: 0) {
            PanelHeader(title: "Event Control", onClose: onClose)
            VStack(alignment: .leading, spacing: 3) {
                EditLineView(line: line)
                if events.isEmpty {
                    EmptyPanel(text: EventsModel.emptyCopy)
                } else {
                    ForEach(events.prefix(10), id: \.id) { e in
                        CardRow {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(e.name).font(.system(size: 16)).foregroundStyle(Hud.text).lineLimit(1)
                                Text(Self.when(e)).font(.system(size: 13)).foregroundStyle(Hud.textDim)
                            }
                            Spacer()
                            if e.live { Text("* LIVE").font(.system(size: 13, weight: .semibold)).foregroundStyle(Hud.success) }
                        }
                    }
                }
                HudButton(label: EventsModel.switchLabel, color: Hud.accent) { picking.toggle() }
                    .padding(.top, 10)
                if picking, let scene = feed.scene {
                    ForEach(EventsModel.presets(scene: scene, loaded: presets), id: \.id) { p in
                        Button { switchTo(p) } label: {
                            CardRow {
                                Text(p.name).font(.system(size: 16)).foregroundStyle(Hud.text)
                                Spacer()
                                if p.active { Text("✓").font(.system(size: 16)).foregroundStyle(Hud.success) }
                            }
                            .background(p.active ? Hud.accentSoft : .clear)
                        }
                        .buttonStyle(.plain)
                        .disabled(p.active)
                    }
                }
            }
            .padding(12)
        }
        .task {
            do { events = try await builder.events.load() } catch { line = EditLine(text: friendlyEditMessage(error), error: true) }
            presets = try? await builder.events.loadPresets() // the feed carries only the active preset
            if DebugLaunch.tab == .events { picking = true }
        }
    }

    private func switchTo(_ p: PresetRow) {
        line = nil
        Task {
            do {
                try await builder.events.switchLayout(p.id)
                presets = try? await builder.events.loadPresets()
            } catch {
                line = EditLine(text: friendlyEditMessage(error), error: true)
            }
        }
    }

    /// "Sat 1 Nov, 20:00 – 22:00" in local time.
    static func when(_ e: EventRow) -> String {
        func parse(_ s: String?) -> Date? {
            guard let s else { return nil }
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return f.date(from: s) ?? ISO8601DateFormatter().date(from: s)
        }
        let day = Date.FormatStyle().weekday(.abbreviated).day().month(.abbreviated).hour().minute()
        let time = Date.FormatStyle().hour().minute()
        let start = parse(e.startTime).map { $0.formatted(day) } ?? ""
        let end = parse(e.endTime).map { $0.formatted(time) }
        return end.map { "\(start) – \($0)" } ?? start
    }
}
