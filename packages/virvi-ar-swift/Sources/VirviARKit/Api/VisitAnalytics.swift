import Foundation

/// Anonymous visit analytics, reported as platform `ar-ios`. One visit runs from the first `shown` of a space until
/// `end`; `hidden` only pauses it (a tracking jump re-shows the same space). The playerId is a fresh random UUID per
/// visit, never stored and never tied to the device. Events are timestamped with `clock` (epoch ms, as the server
/// checks them) and queued until `flush` posts them; a post to retry keeps them (up to `maxQueued`) for the next
/// flush, and one the server refused for good (`.drop`) drops that space's batch. Safe to call from any thread.
public final class VisitAnalytics: @unchecked Sendable {
    public static let maxQueued = 200
    public static let posIntervalMs: Int64 = 5_000

    public typealias Send = @Sendable (_ spaceId: String, _ events: [VisitEvent]) async -> AnalyticsResult

    private struct Queued {
        let id: Int
        let spaceId: String
        let event: VisitEvent
    }

    private let send: Send
    private let clock: @Sendable () -> Int64
    private let lock = NSLock()
    private var queue: [Queued] = []
    private var nextId = 0
    private var spaceId: String?
    private var playerId: String?
    private var lastPosAt: Int64?
    private var paused = false
    private var flushTail: Task<Void, Never>?

    public init(send: @escaping Send, clock: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.send = send
        self.clock = clock
    }

    public convenience init(api: ArApi, clock: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.init(send: { await api.sendAnalytics(spaceId: $0, events: $1) }, clock: clock)
    }

    /// The scene is up. Starts a visit, unless this space's visit is already running (a re-show).
    public func shown(spaceId: String) {
        lock.lock(); defer { lock.unlock() }
        if self.spaceId == spaceId && playerId != nil {
            paused = false
            return
        }
        endLocked()
        self.spaceId = spaceId
        playerId = UUID().uuidString.lowercased()
        lastPosAt = nil
        paused = false
        add("enter", nil)
    }

    /// The head in scene coordinates; at most one `pos` per 5 s. Ignored while paused or between visits.
    public func position(_ scenePos: Vec3) {
        lock.lock(); defer { lock.unlock() }
        guard playerId != nil, !paused, scenePos.x.isFinite, scenePos.y.isFinite, scenePos.z.isFinite else { return }
        let now = clock()
        if let last = lastPosAt, now - last < Self.posIntervalMs { return }
        lastPosAt = now
        add("pos", scenePos)
    }

    /// The scene is hidden but the visit goes on.
    public func hidden() {
        lock.lock(); defer { lock.unlock() }
        paused = true
    }

    /// Ends the visit with `leave`; the caller flushes after it.
    public func end() {
        lock.lock(); defer { lock.unlock() }
        endLocked()
    }

    private func endLocked() {
        if spaceId != nil && playerId != nil { add("leave", nil) }
        spaceId = nil
        playerId = nil
        paused = false
    }

    private func add(_ type: String, _ pos: Vec3?) {
        let e = VisitEvent(type: type, playerId: playerId!, t: clock(), x: pos?.x, y: pos?.y, z: pos?.z)
        queue.append(Queued(id: nextId, spaceId: spaceId!, event: e))
        nextId += 1
        if queue.count > Self.maxQueued { queue.removeFirst(queue.count - Self.maxQueued) }
    }

    /// Posts what is queued, one request per space and at most `maxQueued` events each. Retries stay queued.
    /// Flushes never overlap: a second one waits for the first.
    public func flush() async {
        lock.lock()
        let previous = flushTail
        let t = Task { [self] in
            await previous?.value
            await flushNow()
        }
        flushTail = t
        lock.unlock()
        await t.value
    }

    private func flushNow() async {
        lock.lock()
        var spaces: [String] = []
        for q in queue where !spaces.contains(q.spaceId) { spaces.append(q.spaceId) }
        lock.unlock()
        for id in spaces {
            lock.lock()
            let batch = Array(queue.filter { $0.spaceId == id }.prefix(Self.maxQueued))
            lock.unlock()
            if batch.isEmpty { continue }
            let result = await send(id, batch.map(\.event))
            if result != .retry {
                let sent = Set(batch.map(\.id))
                lock.lock()
                queue.removeAll { sent.contains($0.id) }
                lock.unlock()
            }
        }
    }
}
