import Foundation

// Port of apps/quest/app/src/main/java/io/virvi/ar/visitor/LockGate.kt.

public enum Gate: Sendable, Equatable {
    case gathering, tooFar, steady
}

/// Decides whether a ring's averaged pose is good enough to place the scene from.
public enum LockGate {
    public static func evaluate(count: Int, spreadM: Double, headingSpreadDeg: Double, distanceM: Double) -> Gate {
        if !spreadM.isFinite || !headingSpreadDeg.isFinite || !distanceM.isFinite { return .gathering }
        if count < VisitorTuning.MIN_FRAMES { return .gathering }
        if distanceM > VisitorTuning.MAX_LOCK_DISTANCE_M { return .tooFar }
        if spreadM > VisitorTuning.MAX_SPREAD_M || headingSpreadDeg > VisitorTuning.MAX_HEADING_SPREAD_DEG { return .gathering }
        return .steady
    }
}
