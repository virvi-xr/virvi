import Foundation

/// One live draft, as POST /api/ar/drafts takes it.
struct DraftPayload: Equatable {
    var element: String
    var sk: String
    var transform: ItemTransform

    var body: [String: Any] {
        func v(_ x: SIMD3<Double>) -> [String: Double] { ["x": x.x, "y": x.y, "z": x.z] }
        return ["element": element, "sk": sk, "position": v(transform.position), "rotation": v(transform.rotation), "scale": v(transform.scale)]
    }
}

/// Sends at most one draft per `interval`: the first at once, then a trailing one carrying the latest. Sends are
/// serialized so they reach the server in order. The clock and the scheduler are injected for tests.
@MainActor
final class DraftSender {
    typealias Schedule = @MainActor (TimeInterval, @escaping @MainActor () -> Void) -> Void

    static let interval: TimeInterval = 0.1

    private let now: () -> TimeInterval
    private let schedule: Schedule
    private let send: @MainActor (DraftPayload) async -> Void
    private var lastSent: TimeInterval?
    private var latest: DraftPayload?
    private var trailingScheduled = false
    private var generation = 0
    private var tail: Task<Void, Never>?
    /// True while drafts are held back (someone else holds the item).
    private(set) var stopped = false

    init(now: @escaping () -> TimeInterval, schedule: @escaping Schedule, send: @escaping @MainActor (DraftPayload) async -> Void) {
        self.now = now
        self.schedule = schedule
        self.send = send
    }

    func submit(_ draft: DraftPayload) {
        guard !stopped else { return }
        latest = draft
        let t = now()
        if let last = lastSent, t - last < Self.interval {
            guard !trailingScheduled else { return }
            trailingScheduled = true
            let gen = generation
            schedule(Self.interval - (t - last)) { [weak self] in
                guard let self, self.generation == gen else { return }
                self.trailingScheduled = false
                self.flushLatest()
            }
        } else {
            flushLatest()
        }
    }

    private func flushLatest() {
        guard !stopped, let draft = latest else { return }
        latest = nil
        lastSent = now()
        let previous = tail
        tail = Task { @MainActor [send] in
            await previous?.value
            await send(draft)
        }
    }

    /// Drops what's waiting (a trailing draft), and optionally stops sending until `resume`.
    func cancelPending(stop: Bool = false) {
        generation += 1
        trailingScheduled = false
        latest = nil
        if stop { stopped = true }
    }

    func resume() {
        cancelPending()
        stopped = false
        lastSent = nil
    }

    /// Completes when every draft sent so far has been answered.
    func settle() async { await tail?.value }
}
