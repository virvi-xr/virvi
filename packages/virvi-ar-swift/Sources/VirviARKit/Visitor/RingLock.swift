import Foundation

// Port of apps/quest/app/src/main/java/io/virvi/ar/visitor/RingLock.kt.

/// One frame's verdict on a ring: its `gate`, whether it has just become steady, its averaged pose, whether its
/// position has held still for over `VisitorTuning.NO_WALL_HINT_MS` with no wall heading (`wallMissing`), its averaged
/// position's distance from the head (`distanceM`), and whether it holds still with its wall found but seen too far
/// from head-on to count (`tooSteep`).
public struct LockStep: Equatable, Sendable {
    public var gate: Gate
    public var becameSteady: Bool
    public var world: Vec3
    public var headingDeg: Double?
    public var wallMissing: Bool
    public var distanceM: Double
    public var tooSteep: Bool

    public init(gate: Gate, becameSteady: Bool, world: Vec3, headingDeg: Double?, wallMissing: Bool = false,
                distanceM: Double = 0, tooSteep: Bool = false) {
        self.gate = gate
        self.becameSteady = becameSteady
        self.world = world
        self.headingDeg = headingDeg
        self.wallMissing = wallMissing
        self.distanceM = distanceM
        self.tooSteep = tooSteep
    }
}

/// The wall heading one frame gives a ring's lock (nil for none), and whether the frame was `steep`.
public struct LockHeading: Equatable, Sendable {
    public var headingDeg: Double?
    public var steep: Bool

    public init(headingDeg: Double?, steep: Bool) {
        self.headingDeg = headingDeg
        self.steep = steep
    }
}

/// The heading a lock may take from `fix` (see `wallFix`), given the circle's own `tiltDeg` (see `circleTiltDeg`). Near
/// 45° one circle can't tell its own wall from a perpendicular one, so a frame is steep, and gives no heading, when the
/// picked wall or the tilt says the view is over `VisitorTuning.MAX_VIEW_ANGLE_DEG` from head-on. The two are
/// independent: a perpendicular wall taken for an unscanned one looks near head-on by the wall but steep by the tilt.
public func lockHeading(fix: WallFix?, tiltDeg: Double) -> LockHeading {
    guard let fix else { return LockHeading(headingDeg: nil, steep: false) }
    let steep = fix.viewAngleDeg > VisitorTuning.MAX_VIEW_ANGLE_DEG || tiltDeg > VisitorTuning.MAX_VIEW_ANGLE_DEG
    return LockHeading(headingDeg: steep ? nil : fix.headingDeg, steep: steep)
}

/// One ring in view: its averaged world position and wall heading, put through `LockGate` each camera frame. Heading
/// comes from the wall the ring is on, so with no wall heading in the window the ring is gathering, never too far or
/// steady (its `LockStep.distanceM` still tells `gatherStatus` it is too far). `LockStep.becameSteady` marks a new
/// steady pose (the gate has just become steady). Main thread only.
public final class RingLock {
    private let minFrames: Int
    private let positions: PoseAverager
    private let headings: HeadingAverager
    private var steady = false
    /// Since when the position has held still with no wall heading, or nil.
    private var noWallSince: Int64?

    public init(capacity: Int = VisitorTuning.AVERAGE_FRAMES, minFrames: Int = VisitorTuning.MIN_FRAMES) {
        self.minFrames = minFrames
        positions = PoseAverager(capacity: capacity, minCount: minFrames)
        headings = HeadingAverager(capacity: capacity)
    }

    /// `steep`: this frame found the ring's wall but too far from head-on, so `headingDeg` is nil (see `lockHeading`).
    public func step(_ world: Vec3, _ headingDeg: Double?, head: Vec3, nowMs: Int64, steep: Bool = false) -> LockStep {
        positions.add(world)
        headings.add(headingDeg)
        let mean = positions.mean()!
        let heading = headings.mean()
        let dx = mean.x - head.x, dy = mean.y - head.y, dz = mean.z - head.z
        let distance = (dx * dx + dy * dy + dz * dz).squareRoot()
        let gate: Gate = heading == nil ? .gathering
            : LockGate.evaluate(count: positions.count, spreadM: positions.spread()!, headingSpreadDeg: headings.spread()!,
                                distanceM: distance)
        let now = gate == .steady
        let edge = now && !steady
        steady = now
        let still = heading == nil && positions.count >= minFrames && positions.spread()! <= VisitorTuning.MAX_SPREAD_M
        // Seen too steeply the wall is there: the visitor is told where to stand, not that the wall is missing.
        let stillWithoutWall = still && !steep
        if !stillWithoutWall { noWallSince = nil } else if noWallSince == nil { noWallSince = nowMs }
        let wallMissing = noWallSince.map { nowMs - $0 > VisitorTuning.NO_WALL_HINT_MS } ?? false
        return LockStep(gate: gate, becameSteady: edge, world: mean, headingDeg: heading, wallMissing: wallMissing,
                        distanceM: distance, tooSteep: still && steep)
    }

    public func clear() {
        positions.clear()
        headings.clear()
        steady = false
        noWallSince = nil
    }
}

/// How gathering a steady pose from the space's rings is going, for the hint while locking.
public enum GatherStatus: Sendable, Equatable {
    /// None of the space's rings in view, and no unreadable ring either.
    case noneInView
    /// A ring of the space is in view and its pose is settling (or has settled).
    case gathering
    /// The only rings in view are too far away to lock.
    case tooFar
    /// No ring of the space is readable, but a ring is seen that can't be read.
    case unreadable
    /// Every ring in view holds still but has had no wall heading for a while.
    case noWall
    /// Every ring in view holds still with its wall found, but is seen too far from head-on to lock.
    case tooSteep
}

/// The gather status for one camera frame: `steps` are the space's rings in view this frame, and `unreadableSeen` says
/// an unreadable ring is being seen. A ring with no wall heading never reaches the gate's too far, so its distance is
/// checked here: stepping closer comes before finding the wall.
public func gatherStatus(_ steps: [LockStep], unreadableSeen: Bool) -> GatherStatus {
    if steps.isEmpty { return unreadableSeen ? .unreadable : .noneInView }
    if steps.contains(where: { $0.gate == .steady }) { return .gathering }
    if steps.contains(where: { $0.gate == .tooFar || ($0.headingDeg == nil && $0.distanceM > VisitorTuning.MAX_LOCK_DISTANCE_M) }) {
        return .tooFar
    }
    if steps.allSatisfy({ $0.tooSteep }) { return .tooSteep }
    if steps.allSatisfy({ $0.wallMissing }) { return .noWall }
    return .gathering
}
