import Foundation

// Port of apps/quest/app/src/main/java/io/virvi/ar/visitor/TrackingWatch.kt.

/// Spots tracking jumping (a relocalization): a head (camera) move faster than a person moves. A stalled tick (the
/// main thread busy for a moment while walking) allows for the time that passed, up to `VisitorTuning.MAX_TICK_GAP_S`:
/// past that, a move still has to beat what that much time allows to count as a jump.
public final class TrackingWatch {
    private var last: Vec3?
    private var lastYaw = 0.0

    public init() {}

    /// True when the head moved or turned too far for the `dtS` seconds since the previous call.
    public func onHead(_ position: Vec3, yawDeg: Double, dtS: Double) -> Bool {
        let dt = min(max(dtS, 0), VisitorTuning.MAX_TICK_GAP_S)
        let maxMove = max(VisitorTuning.JUMP_DISTANCE_M, VisitorTuning.MAX_WALK_SPEED_M_S * dt)
        let maxTurn = max(VisitorTuning.JUMP_YAW_DEG, VisitorTuning.MAX_TURN_DEG_S * dt)
        var jumped = false
        if let p = last {
            let dx = p.x - position.x, dy = p.y - position.y, dz = p.z - position.z
            jumped = (dx * dx + dy * dy + dz * dz).squareRoot() > maxMove || abs(angleDiffDeg(yawDeg, lastYaw)) > maxTurn
        }
        last = position
        lastYaw = yawDeg
        return jumped
    }

    public func reset() { last = nil }
}
