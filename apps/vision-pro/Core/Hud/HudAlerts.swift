import Foundation

/// Feeds the Alerts tab: every failure or refusal the edit session reports becomes an error alert, and each new feed
/// scene is compared with the last for "Stream is live" / "Stream went offline". The newest alert is also the toast.
@MainActor
final class HudAlerts: ObservableObject {
    let log: AlertsLog
    @Published private(set) var entries: [AlertEntry] = []
    @Published private(set) var toast: AlertEntry?

    private var lastScene: Props?
    private var lastEditMessage: String?

    init(log: AlertsLog = AlertsLog()) {
        self.log = log
        entries = log.entries
    }

    /// `EditSession.message` as it changes. Every message the session sets is a failure or a refusal (save failed,
    /// offline, held, refused, or "Save or revert … first"); the same message republished counts once.
    func editMessage(_ message: String?) {
        defer { lastEditMessage = message }
        guard let message, message != lastEditMessage else { return }
        push(message, kind: .error)
    }

    /// Each new feed scene.
    func scene(_ next: Props?) {
        for text in AlertsLog.diff(prev: lastScene, next: next) { push(text, kind: .info) }
        if next != nil { lastScene = next }
    }

    func push(_ text: String, kind: AlertEntry.Kind) {
        log.push(text, kind: kind)
        entries = log.entries
        toast = entries.first
    }

    func dismissToast() { toast = nil }
}
