import Foundation

// Port of apps/quest/app/src/main/java/io/virvi/ar/visitor/UnreadableWatch.kt.

/// Turns "this camera frame had a ring seen but not readable" into the flow's events: `VisitorEvent.unreadableSeen`
/// with when the run of sightings began (short gaps don't restart it), and one `VisitorEvent.unreadableGone` once none
/// has been seen for `goneAfterMs`.
public final class UnreadableWatch {
    private let goneAfterMs: Int64
    private var since: Int64?
    private var lastSeen: Int64 = 0

    public init(goneAfterMs: Int64 = VisitorTuning.UNREADABLE_HINT_MS) {
        self.goneAfterMs = goneAfterMs
    }

    public func onFrame(seen: Bool, nowMs: Int64) -> VisitorEvent? {
        if seen {
            let s = since ?? nowMs
            since = s
            lastSeen = nowMs
            return .unreadableSeen(sinceMs: s)
        }
        if since != nil && nowMs - lastSeen >= goneAfterMs {
            since = nil
            return .unreadableGone
        }
        return nil
    }

    public func reset() { since = nil }
}
