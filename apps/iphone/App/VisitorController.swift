import Foundation
import Observation
import simd
import VirviARKit

/// Draws a space's scene (`RealitySceneView` on the phone; a fake in tests). Main thread only.
@MainActor
protocol SceneView: AnyObject {
    func apply(_ items: [RenderItem])
    /// Places the scene root (the RealityKit transform is `realityKitRootTransform(root)`).
    func setRoot(_ root: RootPose)
    /// Fades the scene in or out over 400 ms from wherever the fade has got to.
    func setVisible(_ on: Bool, nowMs: Int64)
    /// Hides the scene at once, without a fade.
    func hideNow()
    /// Drops every item (video players included) and hides the scene.
    func clear()
    /// Advances the fade and keeps scheduled videos in step; every frame.
    func tick(nowMs: Int64)
    /// The server's clock minus the phone's wall clock (ms), for scheduled showings.
    func setServerOffset(_ ms: Int64)
    func setSoundOn(_ on: Bool)
    var itemCount: Int { get }
}

/// The outline flashed on a ring when the scene locks on (`RingOutline`; a fake in tests). Main thread only.
@MainActor
protocol OutlineView: AnyObject {
    /// `world` and `headingDeg` in the Virvi world.
    func flash(world: Vec3, headingDeg: Double, diameterM: Double, nowMs: Int64)
    func tick(nowMs: Int64)
    func clear()
}

/// The space page a link opens: its code, and its name and where its ring is once the lookup has answered.
struct SpacePage: Equatable {
    var code: String
    var spaceName: String?
    var whereText: String?
}

/// What the space page says, top to bottom. `hint` is the live line (step closer, hold still, a failure), or nil.
struct SpacePageLines: Equatable {
    var title: String
    var whereText: String?
    var instruction: String
    var hint: String?
}

/// The page's lines: its name (else `problem`, else "Opening…"), where to find it, the instruction, and the live
/// `hint` unless it only repeats the title. The Quest's `spacePageLines`.
func spacePageLines(_ page: SpacePage, hint: String?, problem: String?) -> SpacePageLines {
    let title = page.spaceName ?? problem ?? VisitorCopy.opening(nil)
    return SpacePageLines(title: title, whereText: page.whereText, instruction: VisitorCopy.LOOK_AT_RING,
                          hint: hint == title ? nil : hint)
}

/// The phone's uptime in ms (monotonic): the flow's clock.
func uptimeMs() -> Int64 { Int64(ProcessInfo.processInfo.systemUptime * 1000) }

/// Visitor mode, joined to the phone: owns the `VisitorFlow`, the `RingTracker`, the space's `ArFeed`, the visit's
/// `VisitAnalytics` and the scene. Turns camera frames (`onCameraFrame`), ARKit's camera pose, tracking state and
/// interruptions, the feed and links into the flow's events, and carries out its effects on the scene `view` (root,
/// fade), the `outline`, the tracker and the UI state below. The Quest's VisitorController and SpaceSession in one.
/// Main thread only.
@MainActor
@Observable
final class VisitorController {
    // MARK: UI state

    /// What the hint card says, or nil when the scene is shown.
    private(set) var hint: String? = VisitorCopy.HINT
    /// The space page a link opened, until the scene is shown or it is closed.
    private(set) var spacePage: SpacePage?
    /// A failure while the space page has no name yet.
    private(set) var spaceProblem: String?
    private(set) var sceneShown = false
    private(set) var menuButtonShown = false
    /// The space a visitor may report, or nil.
    private(set) var reportSpaceId: String?
    /// The line the menu shows once a report has been tried.
    var menuNote: String?
    private(set) var soundOn = false
    private(set) var cameraDenied = false
    private(set) var offline = false
    private(set) var state: VisitorState = .hint

    // MARK: parts

    @ObservationIgnored private let api: ArApi
    /// The BEAT card's behaviour; nil where the app has none (tests of the space alone).
    let beats: BeatModel?
    @ObservationIgnored private let view: SceneView
    @ObservationIgnored private let outline: OutlineView
    @ObservationIgnored private let analytics: VisitAnalytics
    @ObservationIgnored private let clock: () -> Int64
    @ObservationIgnored private let wallClock: () -> Int64
    @ObservationIgnored private let feedSleep: ArFeed.Sleep
    @ObservationIgnored private let flow = VisitorFlow()
    /// Updated and reset on the main thread only (the one thread `RingTracker` asks for); `registered` is set from the
    /// flow's `setRegistered` effects and nowhere else.
    @ObservationIgnored private let tracker = RingTracker(registered: nil)
    @ObservationIgnored private let trackingWatch = TrackingWatch()
    @ObservationIgnored private let unreadableWatch = UnreadableWatch()
    @ObservationIgnored private var flushTask: Task<Void, Never>?

    // MARK: the space (the Quest's SpaceSession)

    @ObservationIgnored private var feed: ArFeed?
    /// Bumped at each feed start and stop, so a stopped feed's late callbacks are dropped.
    @ObservationIgnored private var feedGeneration = 0
    @ObservationIgnored private var spaceId: String?
    @ObservationIgnored private var snapshot: ArFeedSnapshot?
    @ObservationIgnored private var basePlan: [RenderItem] = []
    @ObservationIgnored private var applied: [RenderItem]?
    @ObservationIgnored private var serverOffsetMs: Int64 = 0
    /// The space's rings in view, and each one's step on the newest frame.
    @ObservationIgnored private var tracks: [UInt32: RingLock] = [:]
    @ObservationIgnored private var lastSteps: [UInt32: LockStep] = [:]
    /// Where each ring last became steady, for its outline.
    @ObservationIgnored private var lockedAt: [UInt32: SteadyPose] = [:]

    // MARK: sightings

    @ObservationIgnored private var gather: GatherStatus = .noneInView
    @ObservationIgnored private var unreadableSince: Int64?
    @ObservationIgnored private var lastFrameMs: Int64?
    @ObservationIgnored private var lastHeadMs: Int64?
    @ObservationIgnored private var lastYawDeg = 0.0
    @ObservationIgnored private var trackingNormal = true
    @ObservationIgnored private var interrupted = false

    /// The event ARCs whose card is open, and until when their ring isn't looked up again (the phone's uptime, ms).
    @ObservationIgnored private var eventRingHeldUntil: [UInt32: Int64] = [:]

    /// An event ARC stays scanned for this long: one scan opens its card, and only a scan after this opens it again.
    static let eventHoldMs: Int64 = 5 * 60_000

    /// A camera frame older than this (the pipeline stalled or stopped) shows no rings.
    static let staleMs: Int64 = 500

    init(api: ArApi, view: SceneView, outline: OutlineView, analytics: VisitAnalytics? = nil, beats: BeatModel? = nil,
         clock: @escaping () -> Int64 = uptimeMs,
         wallClock: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
         feedSleep: @escaping ArFeed.Sleep = { try? await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) },
         flushIntervalS: Double = 10) {
        self.api = api
        self.beats = beats
        self.view = view
        self.outline = outline
        self.analytics = analytics ?? VisitAnalytics(api: api)
        self.clock = clock
        self.wallClock = wallClock
        self.feedSleep = feedSleep
        let a = self.analytics
        flushTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(flushIntervalS * 1_000_000_000))
                if Task.isCancelled { return }
                await a.flush()
            }
        }
        refreshUi()
    }

    /// The ring ids the tracker accepts (nil: any); for tests.
    var registeredRings: Set<UInt32>? { tracker.registered }

    /// The app is closing: stops the feed, the analytics timer and the scene.
    func stop() {
        beats?.stop()
        flushTask?.cancel()
        stopSpace()
    }

    // MARK: - From ARKit

    /// Every ARKit frame, with `ARCamera.transform`: the visit's position, the tracking watch, the fade and the flow's
    /// clock.
    func onCameraPose(_ cameraTransform: simd_float4x4) {
        let now = clock()
        let head = cameraToVirviWorld(Vec3(x: 0, y: 0, z: 0), cameraTransform: cameraTransform)
        if case .shown(_, let root) = flow.state {
            let p = markerInScene(root: root, markerWorld: head, headingWorldDeg: 0)
            analytics.position(Vec3(x: p.x, y: p.y, z: p.z))
        }
        // The camera looks along its -z; in the Virvi world (z mirrored) that is (-c2.x, -c2.y, c2.z). Pointed at the
        // floor or the ceiling the yaw means nothing, so the last one stands.
        let c2 = cameraTransform.columns.2
        let fx = -Double(c2.x), fz = Double(c2.z)
        if (fx * fx + fz * fz).squareRoot() > 0.3 { lastYawDeg = atan2(fx, fz) * 180 / .pi }
        let dtS = lastHeadMs.map { Double(now - $0) / 1000 } ?? 0
        lastHeadMs = now
        if trackingNormal && !interrupted && trackingWatch.onHead(head, yawDeg: lastYawDeg, dtS: dtS) {
            dispatch(.trackingJump)
        }
        if let last = lastFrameMs, now - last > Self.staleMs {
            lastFrameMs = nil
            noRings(now)
        }
        tickScene(now)
        dispatch(.tick)
    }

    /// One frame through the detector (`FramePipeline`), with the room's walls as ARKit has scanned them.
    func onCameraFrame(_ r: PipelineResult, walls: [WallPlane]) {
        let now = clock()
        // Limited tracking or an interruption: the camera pose can't be trusted, so no ring counts.
        guard trackingNormal, !interrupted else { return noRings(now) }
        lastFrameMs = now
        if let e = unreadableWatch.onFrame(seen: !r.frame.unreadable.isEmpty, nowMs: now) { onUnreadable(e) }
        let tracked = tracker.update(r.frame.detections)
        // The flow drops rings it has no use for (another space's once one is chosen, unless a link's is pending).
        // An event's ARC has opened its card: it isn't looked up again while it stays in view
        for d in tracked where (eventRingHeldUntil[d.id] ?? .min) <= now { dispatch(.ringAgreed(ringId: d.id)) }
        let steps = stepLocks(tracked, r, walls)
        gather = gatherStatus(steps, unreadableSeen: unreadableSince != nil)
        refreshUi()
    }

    /// ARKit's tracking state: anything but normal is a tracking jump (the scene hides until a ring is seen again).
    func trackingChanged(normal: Bool) {
        if normal == trackingNormal { return }
        trackingNormal = normal
        if normal {
            trackingWatch.reset()
            lastHeadMs = nil
        } else {
            dispatch(.trackingJump)
            noRings(clock())
        }
    }

    /// `sessionWasInterrupted`: a call, the app in the background, the camera taken.
    func sessionInterrupted() {
        if interrupted { return }
        interrupted = true
        dispatch(.sessionInterrupted)
        tracker.reset()
        noRings(clock())
    }

    /// The app paused the session (it went to the background): as an interruption, and tracking counts as limited
    /// until ARKit reports it normal again, so frames between the next `run` and that report can't step a lock.
    func sessionPaused() {
        trackingNormal = false
        sessionInterrupted()
    }

    /// `sessionInterruptionEnded`.
    func sessionResumed() {
        if !interrupted { return }
        interrupted = false
        trackingWatch.reset()
        lastHeadMs = nil
        dispatch(.sessionResumed)
    }

    // MARK: - From the visitor

    func lookAgain() {
        eventRingHeldUntil.removeAll()
        dispatch(.lookAgain)
    }

    /// Opens the space with `code` (from a link): shows its page and looks it up.
    func openSpace(code: String) { dispatch(.openSpace(code: code)) }

    func closeSpacePage() {
        spacePage = nil
        refreshUi()
    }

    /// Video and sound play with sound from the moment the scene first shows (owner, 2026-11-22: a native app has
    /// no autoplay rule). The audio session isn't touched before that.
    private func turnSoundOn() {
        if soundOn { return }
        soundOn = true
        view.setSoundOn(true)
    }

    /// Reports the space now up (or loading) and tells the menu how it went.
    func report(_ reason: ReportReason) {
        guard let id = flow.reportSpaceId else { return }
        menuNote = nil
        let api = api
        Task {
            let r = await api.report(spaceId: id, reason: reason)
            self.menuNote = reportNote(r)
        }
    }

    func setCameraDenied(_ denied: Bool) {
        cameraDenied = denied
        refreshUi()
    }

    func setOffline(_ isOffline: Bool) {
        offline = isOffline
        refreshUi()
    }

    /// The app went to the background: send what the visit has queued.
    func flushAnalytics() {
        let a = analytics
        Task { await a.flush() }
    }

    // MARK: - Rings

    private func noRings(_ now: Int64) {
        resetLocks()
        if let e = unreadableWatch.onFrame(seen: false, nowMs: now) { onUnreadable(e) }
        gather = .noneInView
    }

    private func onUnreadable(_ e: VisitorEvent) {
        if case .unreadableSeen(let since) = e { unreadableSince = since } else { unreadableSince = nil }
        dispatch(e)
    }

    /// Steps the lock of each of the space's rings in view (others are ignored), as the Quest's `SpaceSession.onRings`:
    /// the ring's position from its size and the frame's own camera, its heading from the wall it is on (agreeing with
    /// its own tilt). A ring that has just become steady goes to the flow.
    private func stepLocks(_ tracked: [RingDetection], _ r: PipelineResult, _ walls: [WallPlane]) -> [LockStep] {
        let now = clock()
        var seen: [UInt32: RingDetection] = [:]
        for d in tracked where seen[d.id] == nil { seen[d.id] = d }
        tracks = tracks.filter { seen[$0.key] != nil }
        lastSteps = lastSteps.filter { seen[$0.key] != nil }
        let T = r.cameraTransform
        let k = r.intrinsics
        let viewer = cameraToVirviWorld(Vec3(x: 0, y: 0, z: 0), cameraTransform: T)
        var steps: [LockStep] = []
        for (id, d) in seen.sorted(by: { $0.key < $1.key }) {
            guard let marker = snapshot?.space.markerByRing(id)?.1 else {
                lastSteps[id] = nil // so steadyPoses() is this frame's alone
                continue
            }
            let w = cameraToVirviWorld(markerInCamera(d, k, diameterM: marker.diameterMm / 1000), cameraTransform: T)
            let fix = wallFix(w, walls, viewer: viewer, tilt: circleNormals(d, k, cameraTransform: T))
            let lh = lockHeading(fix: fix, tiltDeg: circleTiltDeg(d))
            let lock = tracks[id] ?? RingLock()
            tracks[id] = lock
            let step = lock.step(w, lh.headingDeg, head: viewer, nowMs: now, steep: lh.steep)
            steps.append(step)
            lastSteps[id] = step
            if step.becameSteady, let heading = step.headingDeg {
                lockedAt[id] = SteadyPose(world: step.world, headingDeg: heading)
                dispatch(.steady(ringId: id, world: step.world, headingDeg: heading))
            }
        }
        return steps
    }

    private func resetLocks() {
        tracks.removeAll()
        lastSteps.removeAll()
    }

    /// The averaged poses of the space's rings that were steady on the newest frame.
    private func steadyPoses() -> [UInt32: SteadyPose] {
        var out: [UInt32: SteadyPose] = [:]
        for (id, s) in lastSteps where s.gate == .steady {
            if let h = s.headingDeg { out[id] = SteadyPose(world: s.world, headingDeg: h) }
        }
        return out
    }

    // MARK: - The space's feed and scene

    private func startSpace(_ id: String) {
        stopFeedOnly()
        spaceId = id
        snapshot = nil
        basePlan = []
        applied = nil
        feedGeneration += 1
        let gen = feedGeneration
        // ArFeed's callbacks run on a background task: hop to the main thread, in order.
        let f = ArFeed(api: api, onSnapshot: { [weak self] s in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.snapshotArrived(s, gen) } }
        }, onStatus: { [weak self] st in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.feedStatus(st, gen) } }
        }, sleep: feedSleep)
        feed = f
        f.start(spaceId: id)
    }

    private func stopFeedOnly() {
        feed?.stop()
        feed = nil
        feedGeneration += 1
    }

    /// Stops the feed and drops the space: its snapshot, rings, outline and scene (video players included).
    private func stopSpace() {
        stopFeedOnly()
        spaceId = nil
        snapshot = nil
        basePlan = []
        applied = nil
        resetLocks()
        lockedAt.removeAll()
        outline.clear()
        view.clear()
    }

    private func snapshotArrived(_ s: ArFeedSnapshot, _ gen: Int) {
        guard gen == feedGeneration, s.space.id == spaceId else { return }
        snapshot = s
        basePlan = planScene(s.scene)
        if let t = s.serverTime {
            serverOffsetMs = t - wallClock()
            view.setServerOffset(serverOffsetMs)
        }
        applied = nil
        applyPlan()
        dispatch(.feed(s, steady: steadyPoses()))
    }

    private func feedStatus(_ st: FeedStatus, _ gen: Int) {
        guard gen == feedGeneration else { return }
        dispatch(.feedStatus(st))
    }

    /// Applies the plan with scheduled screens as they are now; only a change reaches the view.
    private func applyPlan() {
        let next = basePlan.contains(where: \.scheduled)
            ? resolveScheduled(basePlan, snapshot?.showings ?? [:], now: wallClock() + serverOffsetMs) : basePlan
        if next == applied { return }
        applied = next
        view.apply(next)
    }

    private func tickScene(_ now: Int64) {
        if basePlan.contains(where: \.scheduled) { applyPlan() }
        view.tick(nowMs: now)
        outline.tick(nowMs: now)
    }

    private func flashOutline(_ ringId: UInt32) {
        guard let at = lockedAt[ringId], let marker = snapshot?.space.markerByRing(ringId)?.1 else { return }
        outline.flash(world: at.world, headingDeg: at.headingDeg, diameterM: marker.diameterMm / 1000, nowMs: clock())
    }

    private func endVisit() {
        analytics.end()
        flushAnalytics()
    }

    // MARK: - The flow

    /// Events raised while an event's effects are carried out wait their turn.
    @ObservationIgnored private var pending: [VisitorEvent] = []
    @ObservationIgnored private var dispatching = false

    private func dispatch(_ e: VisitorEvent) {
        pending.append(e)
        if dispatching { return }
        dispatching = true
        defer {
            pending.removeAll()
            dispatching = false
        }
        while !pending.isEmpty {
            let next = pending.removeFirst()
            for fx in flow.on(next, nowMs: clock()) { run(fx) }
        }
        refreshUi()
    }

    private func run(_ fx: VisitorEffect) {
        switch fx {
        case .lookup(let code): lookup(code)
        case .startFeed(let id): startSpace(id)
        case .stopFeed:
            stopSpace()
            endVisit()
        case .showScene(let root):
            if let s = snapshot?.space { analytics.shown(spaceId: s.id) }
            view.setRoot(root)
            turnSoundOn()
            view.setVisible(true, nowMs: clock())
        case .reanchor(let root): view.setRoot(root)
        case .hideScene:
            view.setVisible(false, nowMs: clock())
            outline.clear()
            analytics.hidden()
        case .hideNow:
            view.hideNow()
            outline.clear()
            analytics.hidden()
        case .flashOutline(let ring): flashOutline(ring)
        case .resetAveragers:
            resetLocks()
            gather = .noneInView
        case .setRegistered(let ids): tracker.registered = ids
        case .showSpacePage(let code): spacePage = SpacePage(code: code)
        case .closeSpacePage: spacePage = nil
        }
    }

    /// Looks the code up. With the BEAT card the lookup is the app's (`/api/app/arcs`): a space's ARC goes on as ever, and
    /// an event's opens that BEAT's card and nothing else (no feed, no space).
    private func lookup(_ code: String) {
        let api = api
        Task {
            let r: ApiResult<MarkerLookup>
            if let beats = self.beats {
                switch await beats.lookupArc(code) {
                case .ok(.space(let found)): r = .ok(found)
                case .ok(.beat(_, let name, let card)):
                    self.openEvent(code: code, name: name, card: card)
                    return
                case .error(let e): r = Self.apiResult(e)
                }
            } else {
                r = await api.lookup(code: code)
            }
            self.dispatch(.lookup(code: code, result: r))
            // Only a lookup the flow took names the page; one it dropped as superseded doesn't.
            guard case .ok(let found) = r, case .loading(let c, let name) = self.flow.state, c == code, name != nil,
                  self.spacePage?.code == code else { return }
            self.spacePage?.spaceName = found.spaceName
            self.spacePage?.whereText = found.whereText
            self.refreshUi()
        }
    }

    private static func apiResult(_ e: AppBeatError) -> ApiResult<MarkerLookup> {
        switch (e.status, e.code) {
        case (404, _): return .notFound
        case (429, _): return .rateLimited
        case (0, _): return .offline
        default: return .failed(e.status)
        }
    }

    /// An event's ARC was looked up: the search for a space ends (the card is the answer) and the card opens.
    private func openEvent(code: String, name: String, card: AppBeatCard?) {
        // Only the lookup that is still being waited for ends the search; one a newer look has replaced does nothing
        guard case .loading(let c, let spaceName) = flow.state, c == code, spaceName == nil else { return }
        if let ring = RingCodec.parseCode(code) { eventRingHeldUntil[ring] = clock() + Self.eventHoldMs }
        dispatch(.lookAgain)
        beats?.openEvent(code: code, name: name, card: card)
    }

    private func refreshUi() {
        let st = flow.state
        if case .shown = st, spacePage != nil { spacePage = nil }
        var problem: String?
        if spacePage?.spaceName == nil, case .failed(let message) = st { problem = message }
        let device: DeviceProblem? = cameraDenied ? .cameraDenied : offline ? .offline : nil
        let unreadableFor = unreadableSince.map { clock() - $0 } ?? 0
        set(\.state, st)
        set(\.spaceProblem, problem)
        set(\.hint, hintText(st, gather: gather, unreadableForMs: unreadableFor, problem: device))
        if case .shown = st { set(\.sceneShown, true) } else { set(\.sceneShown, false) }
        set(\.menuButtonShown, VirviARKit.menuButtonShown(st, spaceChosen: flow.spaceChosen))
        set(\.reportSpaceId, flow.reportSpaceId)
        // Locking the same space again (tracking lost for a moment) keeps its BEAT card; anything else lets it go
        switch st {
        case .shown(let space, _): beats?.spaceChanged(space.id, shown: true)
        case .locking(let space): beats?.spaceChanged(space.id, shown: false)
        default: beats?.spaceChanged(nil, shown: false)
        }
    }

    /// Assigns only a change, so SwiftUI isn't woken every camera frame for nothing.
    private func set<T: Equatable>(_ key: ReferenceWritableKeyPath<VisitorController, T>, _ value: T) {
        if self[keyPath: key] != value { self[keyPath: key] = value }
    }
}
