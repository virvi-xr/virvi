import SwiftUI

/// The Decentraland HUD's panel: the tab bar from `visibleTabs(role:)`, the sync notice, and the open tab. Stats is
/// an action tab, as in Decentraland: it opens the analytics page instead of a panel.
struct HudView: View {
    @ObservedObject var app: AppModel
    let builder: SceneBuilder
    @ObservedObject var feed: SceneFeed
    @ObservedObject var alerts: HudAlerts
    @Environment(\.openWindow) private var openWindow
    @State private var active: HudTab? = DebugLaunch.tab ?? .layout

    private var tabs: [HudTab] { visibleTabs(role: builder.role) }

    var body: some View {
        VStack(spacing: 0) {
            sceneBar
            NavBar(tabs: tabs, active: active) { tab in
                if tab == .stats {
                    openStats()
                } else {
                    active = active == tab ? nil : tab
                }
            }
            if let notice = AssetsModel.syncNotice(missing: 0) { // the headset has no missingSrcs source yet
                Text(notice).font(.system(size: 14)).foregroundStyle(Hud.warning)
                    .padding(.horizontal, 14).padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading).background(Hud.bgCard)
            }
            ScrollView {
                panel.frame(maxWidth: .infinity, alignment: .top)
            }
            .scrollBounceBehavior(.basedOnSize)
            Spacer(minLength: 0)
        }
        .background(Hud.bg)
        .overlay(alignment: .bottom) { ToastView(alerts: alerts) }
        .onAppear { if DebugLaunch.tab == .stats { openStats() } }
    }

    private var sceneBar: some View {
        HStack(spacing: 10) {
            Circle().fill(feedColor).frame(width: 10, height: 10)
            Text(builder.scene.sceneName).font(.system(size: 15, weight: .medium)).foregroundStyle(Hud.text).lineLimit(1)
            if feed.status == .offline {
                Text(friendlyEditMessage(ApiError.offline)).font(.system(size: 13)).foregroundStyle(Hud.warning).lineLimit(1)
            }
            Spacer()
            Button("Change scene") { app.closeScene() }
                .font(.system(size: 14)).foregroundStyle(Hud.textDim).buttonStyle(.plain).hoverEffect()
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
    }

    /// The launcher dot's colours: cyan when the feed is live, red on failure, amber while connecting.
    private var feedColor: Color {
        switch feed.status {
        case .live: Hud.virvi
        case .failed: Hud.danger
        default: Hud.warning
        }
    }

    @ViewBuilder private var panel: some View {
        let close = { active = nil }
        switch active {
        case .layout: LayoutTab(builder: builder, edit: builder.edit, feed: feed, onClose: close)
        case .assets: AssetsTab(app: app, builder: builder, onClose: close)
        case .events: EventsTab(builder: builder, feed: feed, onClose: close)
        case .stream: StreamTab(builder: builder, feed: feed, onClose: close)
        case .worlds: WorldsTab(builder: builder, onClose: close)
        case .alerts: AlertsTab(alerts: alerts, onClose: close)
        case .roles: RolesTab(builder: builder, onClose: close)
        case .stats, nil: EmptyView()
        }
    }

    private func openStats() {
        let url = analyticsUrlFor(apiUrl: app.baseUrl.absoluteString, sceneId: builder.sceneId)
        if let u = URL(string: url) { openWindow(id: "browser", value: u) }
    }
}

/// DclHUDRenderer's NavBar: equal-width tabs, the open one on the accent colour.
struct NavBar: View {
    let tabs: [HudTab]
    let active: HudTab?
    let onPress: (HudTab) -> Void

    var body: some View {
        HStack(spacing: 0) {
            ForEach(tabs, id: \.self) { tab in
                Button { onPress(tab) } label: {
                    Text(tab.rawValue)
                        .font(.system(size: 15, weight: .medium))
                        .lineLimit(1)
                        .foregroundStyle(active == tab ? Hud.text : Hud.textDim)
                        .frame(maxWidth: .infinity, minHeight: 48)
                        .background(active == tab ? Hud.accent : Color.clear)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .hoverEffect()
            }
        }
        .background(Hud.bgLight)
    }
}

/// Each new alert also shows as a toast for 5 seconds.
struct ToastView: View {
    @ObservedObject var alerts: HudAlerts

    var body: some View {
        if let toast = alerts.toast {
            Text(toast.text)
                .font(.system(size: 15))
                .foregroundStyle(toast.kind == .error ? Hud.danger : Hud.text)
                .padding(.horizontal, 16).padding(.vertical, 10)
                .background(Hud.bg, in: RoundedRectangle(cornerRadius: 8))
                .padding(.bottom, 20)
                .task(id: toast.id) {
                    try? await Task.sleep(for: .seconds(5))
                    if alerts.toast?.id == toast.id { alerts.dismissToast() }
                }
        }
    }
}
