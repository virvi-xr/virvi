import Foundation

/// A ring's averaged pose while it is steady in view: its Virvi-world position and wall heading (degrees from +Z toward
/// +X). The Quest's `io.virvi.ar.space.SteadyPose`.
public struct SteadyPose: Sendable, Equatable {
    public var world: Vec3
    public var headingDeg: Double

    public init(world: Vec3, headingDeg: Double) {
        self.world = world
        self.headingDeg = headingDeg
    }
}
