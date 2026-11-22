import Foundation

// Port of apps/quest/app/src/main/java/io/virvi/ar/visitor/VisitorTuning.kt: the Quest's values, unchanged.

/// The numbers the range test will adjust, in one place.
public enum VisitorTuning {
    /// The scene appears only when the ring is within this distance of the head.
    public static let MAX_LOCK_DISTANCE_M = 1.5
    public static let MIN_FRAMES = 5
    /// Camera frames averaged per ring position and heading.
    public static let AVERAGE_FRAMES = 15
    public static let MAX_SPREAD_M = 0.01
    public static let MAX_HEADING_SPREAD_DEG = 1.0
    /// A wall heading counts only when the visitor is within this of head-on to the ring, by the picked wall and by the
    /// circle's own tilt (see `lockHeading`). When only the wall check passes, the tilt's false normal (at twice the view
    /// angle from the true one) sits at least 30° from a perpendicular wall's, 10° beyond the 20° tilt gate. The tilt
    /// check is what raises that margin to 30°: a perpendicular wall can't be taken for an unscanned one even when the
    /// tilt reads a little low (blur does that).
    public static let MAX_VIEW_ANGLE_DEG = 30.0
    /// Tracking is taken to have jumped when the head moves more than the larger of `JUMP_DISTANCE_M` and
    /// `MAX_WALK_SPEED_M_S` × the time since the last tick, or turns more than the larger of `JUMP_YAW_DEG` and
    /// `MAX_TURN_DEG_S` × that time. The time counts up to `MAX_TICK_GAP_S`.
    public static let JUMP_DISTANCE_M = 0.25
    public static let JUMP_YAW_DEG = 25.0
    public static let MAX_WALK_SPEED_M_S = 2.5
    public static let MAX_TURN_DEG_S = 300.0
    public static let MAX_TICK_GAP_S = 0.5
    /// How long a ring the server doesn't know stays on the do-not-ask list.
    public static let NOT_FOUND_RETRY_MS: Int64 = 600_000
    /// How long a ring may hold still with no wall heading before the visitor is told the wall can't be seen.
    public static let NO_WALL_HINT_MS: Int64 = 3_000
    /// How long an unreadable candidate must persist before "Step closer".
    public static let UNREADABLE_HINT_MS: Int64 = 1_500
    /// A failed lookup is retried after this long, doubling per failure up to the cap; success resets it.
    public static let LOOKUP_RETRY_MIN_MS: Int64 = 2_000
    public static let LOOKUP_RETRY_MAX_MS: Int64 = 30_000
}
