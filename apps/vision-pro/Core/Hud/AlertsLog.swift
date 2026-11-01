import Foundation

struct AlertEntry: Equatable, Identifiable {
    enum Kind { case info, error }
    let id: Int
    let text: String
    let kind: Kind
}

/// The Alerts tab: the last 20 alerts of the session, newest first.
final class AlertsLog: @unchecked Sendable {
    static let emptyCopy = "No notifications"
    static let capacity = 20
    static let streamLive = "Stream is live"
    static let streamOffline = "Stream went offline"

    private let lock = NSLock()
    private var items: [AlertEntry] = []
    private var next = 0

    var entries: [AlertEntry] { lock.lock(); defer { lock.unlock() }; return items }

    func push(_ text: String, kind: AlertEntry.Kind) {
        lock.lock(); defer { lock.unlock() }
        next += 1
        items.insert(AlertEntry(id: next, text: text, kind: kind), at: 0)
        if items.count > Self.capacity { items.removeLast(items.count - Self.capacity) }
    }

    /// Port of model.ts `alertsFromSnapshot`: one alert per video whose `isLive` changed between two snapshots.
    static func diff(prev: Props?, next: Props?) -> [String] {
        guard let prev, let next else { return [] }
        var before: [String: Bool] = [:]
        for case let v as Props in (prev["videos"] as? [Any]) ?? [] {
            if let sk = v["sk"] as? String { before[sk] = StreamModel.isLive(v) }
        }
        var out: [String] = []
        for case let v as Props in (next["videos"] as? [Any]) ?? [] {
            guard let sk = v["sk"] as? String, let was = before[sk] else { continue }
            let now = StreamModel.isLive(v)
            if was != now { out.append(now ? streamLive : streamOffline) }
        }
        return out
    }
}
