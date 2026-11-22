import Foundation

// Port of apps/quest/app/src/main/java/io/virvi/ar/visitor/VisitorFlow.kt. The Quest's `HeadsetOff`/`HeadsetOn` are
// `sessionInterrupted`/`sessionResumed` here (a call, backgrounding, ARKit's limited tracking); builder mode's `Adopt`
// isn't ported. Two iPhone additions (the spec): a ring of another space wins over a space opened from a link until a
// ring of the linked space has shown it, and a snapshot of an unpublished space is treated as the feed's not found.

public enum VisitorState: Equatable, Sendable {
    case hint
    case stepCloser
    /// `spaceName` is nil until the lookup has answered.
    case loading(code: String, spaceName: String?)
    case notSetUp(spaceName: String)
    case failed(message: String)
    case locking(space: ArSpace)
    case shown(space: ArSpace, root: RootPose)
}

public enum VisitorEvent: Sendable {
    case unreadableSeen(sinceMs: Int64)
    case ringAgreed(ringId: UInt32)
    /// The answer to a `VisitorEffect.lookup` for `code`; answers for any other code are dropped.
    case lookup(code: String, result: ApiResult<MarkerLookup>)
    /// No unreadable candidate has been seen for a while: "Step closer" goes back to the hint.
    case unreadableGone
    /// A new snapshot, with the averaged poses of the space's rings steady in view as it arrived.
    case feed(ArFeedSnapshot, steady: [UInt32: SteadyPose] = [:])
    case feedStatus(FeedStatus)
    case steady(ringId: UInt32, world: Vec3, headingDeg: Double)
    case trackingJump
    /// The AR session stopped seeing the world (a call, the app in the background, tracking limited).
    case sessionInterrupted
    case sessionResumed
    case lookAgain
    case openSpace(code: String)
    /// Time has passed (sent every frame): lets a stale "isn't open" go back to the hint.
    case tick
}

public enum VisitorEffect: Equatable, Sendable {
    case lookup(code: String)
    case startFeed(spaceId: String)
    case stopFeed
    case showScene(RootPose)
    case reanchor(RootPose)
    /// Fade the scene out.
    case hideScene
    /// Hide the scene at once, without a fade (tracking jumped: it is in the wrong place).
    case hideNow
    case flashOutline(ringId: UInt32)
    case resetAveragers
    /// nil = accept any ring (used while searching).
    case setRegistered(Set<UInt32>?)
    /// Open the space page for `code` (a link or a Spaces pick).
    case showSpacePage(code: String)
    /// Close the space page: the space it was for is forgotten.
    case closeSpacePage
}

/// The visitor's journey as a pure state machine: rings in, effects out. Wrong placement is worse than a delay, so a
/// scene appears only on `VisitorEvent.steady` and any doubt hides it. Once a space is shown only its own rings count.
/// No timers and no I/O: time comes in as `nowMs`, and the caller turns effects into actions.
public final class VisitorFlow {
    public private(set) var state: VisitorState = .hint

    /// The space whose feed we are following, from the lookup answer; nil while searching.
    private var feedSpaceId: String?
    /// The space itself, from its first snapshot.
    private var space: ArSpace?
    /// The ring the shown scene was last placed from.
    private var anchorRing: UInt32?
    /// The code of the lookup we are waiting on, and the ring that started it (nil for `openSpace`).
    private var pendingCode: String?
    private var lookupRing: UInt32?
    /// The ring whose lookup started the feed we are following (nil for `openSpace`).
    private var feedRing: UInt32?
    /// While "isn't open" is up for a ring (one on the do-not-ask list, or one whose space's feed said not found): that
    /// ring, and when it was last agreed.
    private var notOpenRing: UInt32?
    private var notOpenSeenMs: Int64 = 0
    /// The chosen space's feed said not found, and "isn't open" is still up for it.
    private var chosenNotOpen = false
    /// The space was opened from a link (or a Spaces pick) and no ring of it has shown it yet: any ring stays readable,
    /// and a ring of another space wins.
    private var linkPending = false
    private var doNotAskUntil: [UInt32: Int64] = [:]
    private var retryAt: [UInt32: Int64] = [:]
    private var retryDelay: [UInt32: Int64] = [:]

    public init() {}

    /// A space has been chosen (its lookup answered) and not forgotten; its feed may still be loading, or have said the
    /// space isn't open (while that message is up).
    public var spaceChosen: Bool { feedSpaceId != nil || chosenNotOpen }

    /// The id of the space a visitor may report: the one whose feed is up or loading, else nil (nothing chosen, or not
    /// open).
    public var reportSpaceId: String? { feedSpaceId }

    public func on(_ e: VisitorEvent, nowMs: Int64) -> [VisitorEffect] {
        switch e {
        case .unreadableSeen(let sinceMs): return unreadable(sinceMs, nowMs)
        case .unreadableGone:
            if state == .stepCloser { state = .hint }
            return []
        case .ringAgreed(let ringId): return ringAgreed(ringId, nowMs)
        case .lookup(let code, let result): return lookup(code, result, nowMs)
        case .feed(let snapshot, let steady): return feed(snapshot, steady, nowMs)
        case .feedStatus(let status): return feedStatus(status, nowMs)
        case .steady(let ringId, let world, let headingDeg): return steady(ringId, world, headingDeg)
        case .trackingJump, .sessionInterrupted: return hide()
        case .sessionResumed: return []
        case .lookAgain: return forget([.setRegistered(nil)]) { .hint }
        case .openSpace(let code):
            var fx = forget([.setRegistered(nil)]) { .loading(code: code, spaceName: nil) }
            pendingCode = code
            linkPending = true
            fx += [.showSpacePage(code: code), .lookup(code: code)]
            return fx
        case .tick: return tick(nowMs)
        }
    }

    /// A ring whose space isn't open that has left view for a while no longer holds "isn't open": back to the hint.
    private func tick(_ nowMs: Int64) -> [VisitorEffect] {
        if notOpenRing != nil, state == .failed(message: VisitorCopy.NOT_OPEN),
           nowMs - notOpenSeenMs >= VisitorTuning.UNREADABLE_HINT_MS {
            notOpenRing = nil
            chosenNotOpen = false
            state = .hint
        }
        return []
    }

    private func unreadable(_ sinceMs: Int64, _ nowMs: Int64) -> [VisitorEffect] {
        if state == .hint || state == .stepCloser {
            state = nowMs - sinceMs >= VisitorTuning.UNREADABLE_HINT_MS ? .stepCloser : .hint
        }
        return []
    }

    private var isLoading: Bool {
        if case .loading = state { return true }
        return false
    }

    private func held(_ ringId: UInt32, _ nowMs: Int64) -> Bool {
        (doNotAskUntil[ringId] ?? .min) > nowMs || (retryAt[ringId] ?? .min) > nowMs
    }

    private func ringAgreed(_ ringId: UInt32, _ nowMs: Int64) -> [VisitorEffect] {
        // Once a space is chosen (looked up or loaded) other rings never swap it; only LookAgain does. A space opened
        // from a link is the exception until one of its rings has shown it: a ring of another space wins (one held by
        // a failed or not-found lookup doesn't, so the link's space stays).
        if feedSpaceId != nil || isLoading {
            guard linkPending, space?.markerByRing(ringId) == nil, !held(ringId, nowMs) else { return [] }
        }
        if (doNotAskUntil[ringId] ?? .min) > nowMs {
            state = .failed(message: VisitorCopy.NOT_OPEN)
            notOpenRing = ringId
            notOpenSeenMs = nowMs
            return []
        }
        // A failed lookup holds its message until the retry time, so it can't flicker or hammer the server.
        if (retryAt[ringId] ?? .min) > nowMs {
            if ringId == notOpenRing { notOpenSeenMs = nowMs }
            return []
        }
        // The ring wins over the link: the link's space, its feed and its page go.
        let fx = linkPending ? forget([]) { .hint } : []
        notOpenRing = nil
        chosenNotOpen = false
        let code = RingCodec.codeOf(ringId)
        lookupRing = ringId
        pendingCode = code
        state = .loading(code: code, spaceName: nil)
        return fx + [.lookup(code: code)]
    }

    private func lookup(_ code: String, _ result: ApiResult<MarkerLookup>, _ nowMs: Int64) -> [VisitorEffect] {
        guard case .loading(let loadingCode, let loadingName) = state else { return [] }
        if loadingName != nil || feedSpaceId != nil { return [] }
        if pendingCode != code { return [] }
        let ring = lookupRing
        switch result {
        case .ok(let found):
            feedSpaceId = found.spaceId
            feedRing = ring
            pendingCode = nil
            lookupRing = nil
            // The backoff itself is only reset by the feed's first snapshot: a space that answers here but whose feed
            // says not found must not loop on lookups.
            if let ring { retryAt[ring] = nil }
            state = .loading(code: loadingCode, spaceName: found.spaceName)
            return [.startFeed(spaceId: found.spaceId)]
        case .notFound:
            if let ring {
                doNotAskUntil[ring] = nowMs + VisitorTuning.NOT_FOUND_RETRY_MS
                notOpenRing = ring
                notOpenSeenMs = nowMs
            }
            state = .failed(message: VisitorCopy.NOT_OPEN)
        case .offline: failed(ring, nowMs, VisitorCopy.OFFLINE)
        case .rateLimited: failed(ring, nowMs, VisitorCopy.BUSY)
        case .failed(let status): failed(ring, nowMs, status == 200 ? VisitorCopy.BAD_DATA : VisitorCopy.COULDNT_OPEN)
        }
        pendingCode = nil
        lookupRing = nil
        return []
    }

    private func failed(_ ring: UInt32?, _ nowMs: Int64, _ message: String) {
        state = .failed(message: message)
        guard let ring else { return }
        let delay = retryDelay[ring].map { min($0 * 2, VisitorTuning.LOOKUP_RETRY_MAX_MS) } ?? VisitorTuning.LOOKUP_RETRY_MIN_MS
        retryDelay[ring] = delay
        retryAt[ring] = nowMs + delay
    }

    private func feed(_ snapshot: ArFeedSnapshot, _ steady: [UInt32: SteadyPose], _ nowMs: Int64) -> [VisitorEffect] {
        guard let id = feedSpaceId, snapshot.space.id == id else { return [] }
        // The published feed shouldn't send an unpublished space; if it does, it isn't open, as when the feed says so.
        if !snapshot.space.published { return feedStatus(.notFound, nowMs) }
        let s = snapshot.space
        let ids = ringIds(s)
        let old = space
        let changed = old.map { ringIds($0) != ids } ?? true
        let first = old == nil
        space = s
        if first, let ring = feedRing { retryDelay[ring] = nil }
        var fx: [VisitorEffect] = []
        switch state {
        case .shown(let shownSpace, let root): state = reanchor(shownSpace, root, old, s, steady, &fx)
        case .locking: state = .locking(space: s)
        case .notSetUp, .failed: state = .locking(space: s)
        default: if first { state = .locking(space: s) }
        }
        // While a link's space waits for one of its rings, any ring stays readable (a ring of another space wins).
        if changed && !linkPending { fx.append(.setRegistered(ids)) }
        return fx
    }

    /// The shown scene after a newer snapshot `s`: where it was, unless the anchor ring's saved pose has changed. Then it
    /// is placed afresh from that ring's averaged pose if the ring is steady in view (`steady`); otherwise it is hidden
    /// at once (it is in the wrong place) to lock again. A changed printed diameter always hides it: the averaged pose
    /// was ranged from the old size.
    private func reanchor(_ shownSpace: ArSpace, _ root: RootPose, _ old: ArSpace?, _ s: ArSpace,
                          _ steady: [UInt32: SteadyPose], _ fx: inout [VisitorEffect]) -> VisitorState {
        guard let ring = anchorRing else { return .shown(space: s, root: root) }
        let now = s.markerByRing(ring)?.1
        let was = old?.markerByRing(ring)?.1
        let saved = now?.pose
        let resized = now != nil && was != nil && now!.diameterMm != was!.diameterMm
        if !resized, let saved, saved == was?.pose { return .shown(space: s, root: root) }
        if !resized, let saved, let seen = steady[ring] {
            let newRoot = rootFromMarker(markerWorld: seen.world, headingWorldDeg: seen.headingDeg, saved: saved)
            fx.append(.reanchor(newRoot))
            return .shown(space: s, root: newRoot)
        }
        anchorRing = nil
        fx.append(.hideNow)
        fx.append(.resetAveragers)
        return .locking(space: s)
    }

    private func feedStatus(_ status: FeedStatus, _ nowMs: Int64) -> [VisitorEffect] {
        if feedSpaceId == nil { return [] }
        switch status {
        case .notFound:
            // The feed reports this but doesn't clear the scene, so do it here, shown or not. The ring goes on the retry
            // backoff: its lookup may well answer again, and the feed say not found again. "Isn't open" clears like a
            // ring the server doesn't know, once the ring is out of view (a space opened by code has no ring, so it
            // stays).
            feedSpaceId = nil
            space = nil
            anchorRing = nil
            failed(feedRing, nowMs, VisitorCopy.NOT_OPEN)
            notOpenRing = feedRing
            notOpenSeenMs = nowMs
            chosenNotOpen = true
            feedRing = nil
            return [.hideScene, .stopFeed, .resetAveragers, .setRegistered(nil)]
        case .offline:
            if space == nil { state = .failed(message: VisitorCopy.OFFLINE) }
            return []
        case .rateLimited:
            if space == nil { state = .failed(message: VisitorCopy.BUSY) }
            return []
        case .badData:
            if space == nil { state = .failed(message: VisitorCopy.BAD_DATA) }
            return []
        case .failed:
            if space == nil { state = .failed(message: VisitorCopy.COULDNT_OPEN) }
            return []
        case .connecting, .live:
            return []
        }
    }

    private func steady(_ ringId: UInt32, _ world: Vec3, _ headingDeg: Double) -> [VisitorEffect] {
        guard let s = space, let (_, marker) = s.markerByRing(ringId) else { return [] }
        let wasShown: Bool
        if case .shown = state { wasShown = true } else { wasShown = false }
        guard let saved = marker.pose else {
            // Never place from a guess. A scene already shown from another ring stays.
            if !wasShown { state = .notSetUp(spaceName: s.name) }
            return []
        }
        let root = rootFromMarker(markerWorld: world, headingWorldDeg: headingDeg, saved: saved)
        state = .shown(space: s, root: root)
        anchorRing = ringId
        if wasShown { return [.reanchor(root)] }
        var fx: [VisitorEffect] = [.showScene(root), .flashOutline(ringId: ringId)]
        if linkPending {
            // Arrived at the linked space: from now on only its rings count, as for a space found by its ring.
            linkPending = false
            fx.append(.setRegistered(ringIds(s)))
        }
        return fx
    }

    /// Tracking jumped or the session was interrupted: hide at once (the scene must not linger at a stale root), and
    /// wait for a ring to be seen again. The feed keeps running.
    private func hide() -> [VisitorEffect] {
        guard let s = space else { return [] }
        state = .locking(space: s)
        anchorRing = nil
        return [.hideNow, .resetAveragers]
    }

    /// Drops the current space, its page and everything pending, moving to the state `next` gives.
    private func forget(_ extra: [VisitorEffect], _ next: () -> VisitorState) -> [VisitorEffect] {
        var fx: [VisitorEffect] = []
        if space != nil { fx.append(.hideScene) }
        fx += [.stopFeed, .resetAveragers, .closeSpacePage]
        fx += extra
        feedSpaceId = nil
        feedRing = nil
        space = nil
        anchorRing = nil
        lookupRing = nil
        pendingCode = nil
        notOpenRing = nil
        chosenNotOpen = false
        linkPending = false
        // A fresh look starts fresh: a failed lookup's backoff would otherwise hold the hint for up to 30 s.
        retryAt.removeAll()
        retryDelay.removeAll()
        state = next()
        return fx
    }

    private func ringIds(_ s: ArSpace) -> Set<UInt32> { Set(s.floors.flatMap { $0.markers.map(\.ringId) }) }
}
