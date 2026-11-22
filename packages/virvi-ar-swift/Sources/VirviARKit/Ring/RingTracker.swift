import Foundation

/// Turns per-frame ring detections into trusted ones: an ID counts only if it is `registered` (any ID
/// while that is nil), its format version is in `supportedVersions`, and it was detected in
/// `framesToAgree` frames in a row. A frame that misses an ID resets its count, so one bad decode never
/// shows up as a marker. A port of apps/quest/.../ring/RingTracker.kt.
///
/// Call `update` and `reset` from the camera queue only; `registered` may be set from any thread.
public final class RingTracker {
    /// Marker format versions this app reads; a marker of any other version is someone else's layout.
    public static let supportedVersions: Set<Int> = [0]

    private let framesToAgree: Int
    private let lock = NSLock()
    private var _registered: Set<UInt32>?
    private var streak: [UInt32: Int] = [:]

    public init(registered: Set<UInt32>?, framesToAgree: Int = 3) {
        _registered = registered
        self.framesToAgree = framesToAgree
    }

    public var registered: Set<UInt32>? {
        get { lock.withLock { _registered } }
        set { lock.withLock { _registered = newValue } }
    }

    /// Feeds one frame's detections; returns the registered ones seen in the last `framesToAgree` frames.
    public func update(_ detections: [RingDetection]) -> [RingDetection] {
        let accept = registered
        var ids = Set<UInt32>()
        var seen: [RingDetection] = []
        for d in detections where Self.supportedVersions.contains(d.version) && (accept?.contains(d.id) ?? true) {
            if ids.insert(d.id).inserted { seen.append(d) }
        }
        streak = streak.filter { ids.contains($0.key) }
        for id in ids { streak[id, default: 0] += 1 }
        return seen.filter { streak[$0.id]! >= framesToAgree }
    }

    /// Forgets every streak, as at a new camera run, so frames before a gap never count toward agreement.
    public func reset() {
        streak.removeAll()
    }
}

/// The detection whose centre is nearest the middle of a `width` x `height` image, or nil if there are none.
public func nearestToCentre(_ d: [RingDetection], width: Int, height: Int) -> RingDetection? {
    let mx = Double(width) / 2, my = Double(height) / 2
    return d.min { hypot($0.cx - mx, $0.cy - my) < hypot($1.cx - mx, $1.cy - my) }
}
