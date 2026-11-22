import Foundation

/// Scheduled showings on a video screen (LIV-87), a port of packages/shared src/showings.ts (as the Quest's
/// Showings.kt): everyone works out the same moment of the same video from the show's start instant (UTC ms) and the
/// server's clock, so a visitor who walks in mid-film joins where everyone else is. The server applies hosts' delays
/// and early ends before it sends the shows.
public struct ProgrammeItem: Equatable {
    public var url: String
    /// Seconds. Items without a positive length take no time and are never played.
    public var duration: Double
    public var kind: String = "video"

    public init(url: String, duration: Double, kind: String = "video") {
        self.url = url
        self.duration = duration
        self.kind = kind
    }
}

public struct ShowingInstance: Equatable {
    public var showingId: String
    /// UTC ms.
    public var startsAt: Int64
    public var items: [ProgrammeItem]
    public var title: String?

    public init(showingId: String, startsAt: Int64, items: [ProgrammeItem], title: String? = nil) {
        self.showingId = showingId
        self.startsAt = startsAt
        self.items = items
        self.title = title
    }
}

public enum ScreenState: Equatable {
    /// `offset` is seconds into `item`; `itemStartsAt` (UTC ms) is when `item` began, the same for every frame of it.
    case playing(showing: ShowingInstance, item: ProgrammeItem, index: Int, offset: Double, itemStartsAt: Int64)
    /// `startsIn` is seconds until `next`, or nil with nothing scheduled.
    case between(next: ShowingInstance?, startsIn: Double?)
}

private func playable(_ d: Double) -> Bool { d.isFinite && d > 0 }

/// What a scheduled screen shows at server time `now` (UTC ms). If showings overlap, the later start wins.
public func screenStateAt(_ showings: [ShowingInstance], now: Int64) -> ScreenState {
    let sorted = showings.sorted { $0.startsAt < $1.startsAt }
    let nextAfter = { (t: Int64) in sorted.first { $0.startsAt > t } }
    for showing in sorted.reversed() {
        if showing.startsAt > now { continue }
        let elapsed = Double(now - showing.startsAt) / 1000
        var start = 0.0
        for (index, item) in showing.items.enumerated() where playable(item.duration) {
            if elapsed < start + item.duration {
                return .playing(showing: showing, item: item, index: index, offset: elapsed - start,
                                itemStartsAt: showing.startsAt + Int64((start * 1000).rounded()))
            }
            start += item.duration
        }
        break // the most recent showing has ended
    }
    let next = nextAfter(now)
    return .between(next: next, startsIn: next.map { Double($0.startsAt - now) / 1000 })
}

private func isNumber(_ v: Any?) -> NSNumber? {
    guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite else { return nil }
    return n
}

/// The feed's `showings` (`[{ elementId, showings }]`) by screen element id; malformed entries are dropped.
public func parseShowings(_ v: Any?) -> [String: [ShowingInstance]] {
    var out: [String: [ShowingInstance]] = [:]
    for case let entry as Props in (v as? [Any]) ?? [] {
        guard let id = entry["elementId"] as? String, let list = entry["showings"] as? [Any] else { continue }
        out[id] = list.compactMap { e -> ShowingInstance? in
            guard let o = e as? Props, let sid = o["showingId"] as? String, let at = isNumber(o["startsAt"]),
                  let raw = o["items"] as? [Any] else { return nil }
            let items = raw.compactMap { i -> ProgrammeItem? in
                guard let io = i as? Props, let url = io["url"] as? String, let d = isNumber(io["duration"]) else { return nil }
                return ProgrammeItem(url: url, duration: d.doubleValue, kind: io["kind"] as? String ?? "video")
            }
            return ShowingInstance(showingId: sid, startsAt: at.int64Value, items: items, title: o["title"] as? String)
        }
    }
    return out
}

/// A scheduled screen's video: it began at `itemStartsAtMs` (UTC ms) and runs `durationS`. Players start where the show is.
public struct ScheduledPlay: Equatable {
    public var itemStartsAtMs: Int64
    public var durationS: Double

    public init(itemStartsAtMs: Int64, durationS: Double) {
        self.itemStartsAtMs = itemStartsAtMs
        self.durationS = durationS
    }
}

/// The formats the headset plays for a showing (as `planScene`).
private let SHOWING_VIDEO_EXT = ["mp4", "m3u8"]

/// The plan with each Schedule-mode screen as it is at server time `now`: the programme's video (with where it began,
/// which stays the same while it plays, so the plan only changes when the show moves on), else the holding image, else
/// nothing. A video the headset can't play counts as between shows. Other items pass through.
public func resolveScheduled(_ plan: [RenderItem], _ showings: [String: [ShowingInstance]], now: Int64) -> [RenderItem] {
    plan.compactMap { item in
        guard item.scheduled else { return item }
        var out = item
        if case let .playing(_, programme, _, _, itemStartsAt) = screenStateAt(showings[item.elementId] ?? [], now: now),
           SHOWING_VIDEO_EXT.contains(extOf(programme.url)) {
            out.kind = .video
            out.src = programme.url
            out.loop = false
            out.play = ScheduledPlay(itemStartsAtMs: itemStartsAt, durationS: programme.duration)
            return out
        }
        guard let holding = item.holdingImage else { return nil }
        out.kind = .image
        out.src = holding
        out.loop = false
        out.volume = 0
        out.play = nil
        return out
    }
}

/// When to move a scheduled video back to where the show is, with Decentraland's, Hyperfy's and the Quest's guards: a
/// player that has slipped more than 2 s, checked at most every 5 s, 30 s after its last start or seek, 3 times per
/// video, never in a video's last 10 s. Times in ms of any one clock; positions in seconds.
public final class SeekGuard {
    public static let driftCheckMs: Int64 = 5_000
    public static let settleMs: Int64 = 30_000
    public static let maxReseeks = 3
    public static let minLeftS = 10.0
    public static let toleranceS = 2.0

    private var seekAt: Int64
    private var checkAt: Int64
    private var seeks = 0

    public init(startedAt: Int64) {
        seekAt = startedAt
        checkAt = startedAt
    }

    public func shouldSeek(now: Int64, expected: Double, actual: Double, duration: Double, playing: Bool) -> Bool {
        guard playing else { return false }
        if now - checkAt < Self.driftCheckMs || now - seekAt < Self.settleMs { return false }
        if seeks >= Self.maxReseeks || duration - expected < Self.minLeftS { return false }
        checkAt = now
        if abs(expected - actual) <= Self.toleranceS { return false }
        seeks += 1
        seekAt = now
        return true
    }
}
