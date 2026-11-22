import Foundation

// Port of apps/quest/app/src/main/java/io/virvi/ar/visitor/HeadingAverager.kt.

/// The last `capacity` per-frame wall headings of one ring (degrees, as `wallHeading` gives them), kept beside its
/// `PoseAverager`. Headings are averaged on the circle, so 179° and −179° average to 180°. A frame with no wall (nil)
/// anywhere in the window means there is no heading: heading comes from the wall the ring is on.
public final class HeadingAverager {
    private let capacity: Int
    private var samples: [Double?] = []

    public init(capacity: Int = 15) {
        self.capacity = capacity
    }

    public func add(_ headingDeg: Double?) {
        if samples.count == capacity { samples.removeFirst() }
        samples.append(headingDeg)
    }

    public func clear() { samples.removeAll() }

    /// The circular mean in (−180, 180], or nil when empty or when a frame in the window had no wall.
    public func mean() -> Double? {
        guard let hs = complete() else { return nil }
        let s = hs.reduce(0) { $0 + sin($1 * .pi / 180) }
        let c = hs.reduce(0) { $0 + cos($1 * .pi / 180) }
        let deg = atan2(s, c) * 180 / .pi
        return deg <= -180 ? deg + 360 : deg
    }

    /// The largest angle between a heading and the `mean`, in degrees, or nil as for `mean`.
    public func spread() -> Double? {
        guard let m = mean(), let hs = complete() else { return nil }
        return hs.map { abs(angleDiffDeg($0, m)) }.max()
    }

    private func complete() -> [Double]? {
        if samples.isEmpty || samples.contains(where: { $0 == nil }) { return nil }
        return samples.map { $0! }
    }
}
