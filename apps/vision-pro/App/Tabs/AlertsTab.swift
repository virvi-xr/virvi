import SwiftUI

/// "Notifications": the session's last 20 alerts, newest first.
struct AlertsTab: View {
    @ObservedObject var alerts: HudAlerts
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            PanelHeader(title: "Notifications", onClose: onClose)
            VStack(alignment: .leading, spacing: 3) {
                if alerts.entries.isEmpty {
                    EmptyPanel(text: AlertsLog.emptyCopy)
                } else {
                    ForEach(alerts.entries) { a in
                        CardRow {
                            Text(a.text).font(.system(size: 15)).foregroundStyle(a.kind == .error ? Hud.danger : Hud.text)
                        }
                    }
                }
            }
            .padding(12)
        }
    }
}
