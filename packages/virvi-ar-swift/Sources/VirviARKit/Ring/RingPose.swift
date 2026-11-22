import Foundation
import simd

// Port of apps/quest/app/src/main/java/io/virvi/ar/ring/RingPose.kt. Pure maths: no ARKit here. Everything after
// `markerInCamera` runs in the Virvi world frame (left-handed, Y up, +Z forward; headings in degrees from +Z toward
// +X); `Space/ArFrame.swift` converts ARKit's camera and planes into it.

/// Pinhole intrinsics at the detector's image size (see `intrinsics(fromARKit:imageSize:scaledTo:height:)`).
public struct CameraIntrinsics: Equatable, Sendable {
    public var fx: Double
    public var fy: Double
    public var cx: Double
    public var cy: Double
    public var width: Int
    public var height: Int

    public init(fx: Double, fy: Double, cx: Double, cy: Double, width: Int, height: Int) {
        self.fx = fx
        self.fy = fy
        self.cx = cx
        self.cy = cy
        self.width = width
        self.height = height
    }
}

/// Where a detected ring marker is, in the image camera frame (metres; +x right, +y down, +z forward, as in the image).
///
/// The distance comes from the finder ring's size: its outer edge is the printed diameter `diameterM`, and its fitted
/// semi-major axis barely shrinks when the marker is tilted (tilt squashes the minor axis), so the range along the ray
/// is `fx * (diameterM / 2) / semiMajor`. The direction is the ray through the ellipse centre. `k` must be the
/// intrinsics at the detector's image size.
public func markerInCamera(_ d: RingDetection, _ k: CameraIntrinsics, diameterM: Double) -> Vec3 {
    let range = k.fx * (diameterM / 2) / d.semiMajor
    let rx = (d.cx - k.cx) / k.fx
    let ry = (d.cy - k.cy) / k.fy
    let n = (rx * rx + ry * ry + 1).squareRoot()
    return Vec3(x: rx / n * range, y: ry / n * range, z: range / n)
}

/// A wall: its centre and unit normal in the Virvi world frame (the normal into the room where the scan says so;
/// `wallFix` turns it toward the viewer anyway), and its half extents along and up the wall. Walls are vertical.
public struct WallPlane: Equatable {
    public var centre: Vec3
    public var normal: Vec3
    public var halfWidth: Double
    public var halfHeight: Double

    public init(centre: Vec3, normal: Vec3, halfWidth: Double, halfHeight: Double) {
        self.centre = centre
        self.normal = normal
        self.halfWidth = halfWidth
        self.halfHeight = halfHeight
    }
}

/// A wall the camera ray hits: its flat unit `normal` (as scanned, not turned into the room) and the ray distance `t`.
public struct WallHit: Equatable {
    public var wall: WallPlane
    public var normal: Vec3
    public var t: Double
}

/// The distance along the ray from `origin` in the unit direction `dir` to the plane through `planePoint` with normal
/// `planeNormal`, or nil when the ray is parallel to it or the plane is behind.
public func rangeToPlane(origin: Vec3, dir: Vec3, planePoint: Vec3, planeNormal: Vec3) -> Double? {
    let denom = dot(dir, planeNormal)
    if abs(denom) < 1e-6 { return nil }
    let t = dot(sub(planePoint, origin), planeNormal) / denom
    return t > 0 ? t : nil
}

/// The walls the ray from `origin` through `marker` hits, nearest first: the ray meets the wall's plane inside its
/// edges (give or take `WALL_TOLERANCE_M`), at a distance within `PRINT_SCALE_TOLERANCE` of the marker's own. The
/// marker's position is `r / s` along the ray for a print scaled by `s`; the ray's direction doesn't depend on it.
public func wallHitsAlongRay(origin: Vec3, marker: Vec3, walls: [WallPlane]) -> [WallHit] {
    let delta = sub(marker, origin)
    let r = length(delta)
    if r < 1e-6 { return [] }
    let dir = scale(delta, 1 / r)
    var hits: [WallHit] = []
    for w in walls {
        let len = (w.normal.x * w.normal.x + w.normal.z * w.normal.z).squareRoot()
        if len < 1e-3 { continue }
        let n = Vec3(x: w.normal.x / len, y: 0, z: w.normal.z / len)
        let c = w.centre
        guard let t = rangeToPlane(origin: origin, dir: dir, planePoint: c, planeNormal: n) else { continue }
        if t < r * (1 - PRINT_SCALE_TOLERANCE) || t > r * (1 + PRINT_SCALE_TOLERANCE) { continue }
        let h = sub(add(origin, scale(dir, t)), c)
        let along = abs(h.x * n.z - h.z * n.x)
        if along > w.halfWidth + WALL_TOLERANCE_M || abs(h.y) > w.halfHeight + WALL_TOLERANCE_M { continue }
        hits.append(WallHit(wall: w, normal: n, t: t))
    }
    return hits.sorted { $0.t < $1.t }
}

/// The marker's wall as `wallFix` picks it: its `headingDeg` (nil when another wall agrees with the tilt about as
/// well), and `viewAngleDeg`, the level angle between the best wall's into-room normal and the ray from the marker
/// toward the viewer (0 head-on).
public struct WallFix: Equatable {
    public var headingDeg: Double?
    public var viewAngleDeg: Double

    public init(headingDeg: Double?, viewAngleDeg: Double) {
        self.headingDeg = headingDeg
        self.viewAngleDeg = viewAngleDeg
    }
}

/// The heading, in degrees from +z toward +x in (-180, 180], of the wall the marker is on (see `wallFix`).
public func wallHeading(_ marker: Vec3, _ walls: [WallPlane], viewer: Vec3, tilt: [Vec3]?) -> Double? {
    wallFix(marker, walls, viewer: viewer, tilt: tilt)?.headingDeg
}

/// The wall the marker is on: the normal of a wall the ray from `viewer` through `marker` hits (see
/// `wallHitsAlongRay`), turned toward `viewer`'s side of the wall, into the room.
///
/// `tilt` (the circle's own tilt, from `circleNormals`) checks that the marker is on that wall: a wall counts only if
/// its into-room normal is within `TILT_TOLERANCE_DEG` of one of the tilt's normals, and of the walls that count the
/// one that agrees best wins. When a wall facing another way (by more than `TILT_AMBIGUOUS_DEG`) agrees within
/// `TILT_AMBIGUOUS_DEG` of the best, the pick would be decided by measurement error, so there is no heading. Nil when
/// no wall is close or none agrees with the tilt. A nil `tilt` skips the check and takes the nearest wall.
public func wallFix(_ marker: Vec3, _ walls: [WallPlane], viewer: Vec3, tilt: [Vec3]?) -> WallFix? {
    var passing: [(Vec3, Double)] = []
    for hit in wallHitsAlongRay(origin: viewer, marker: marker, walls: walls) {
        let w = hit.wall
        let n = hit.normal
        let side = (viewer.x - w.centre.x) * n.x + (viewer.z - w.centre.z) * n.z
        let inward = side < 0 ? Vec3(x: -n.x, y: 0, z: -n.z) : n
        let score: Double
        if let tilt {
            guard let best = tilt.map({ angleDeg(inward, $0) }).min(), best <= TILT_TOLERANCE_DEG else { continue }
            score = best
        } else {
            score = hit.t
        }
        passing.append((inward, score))
    }
    guard let (n, bestScore) = passing.min(by: { $0.1 < $1.1 }) else { return nil }
    let view = flatUnit(Vec3(x: viewer.x - marker.x, y: 0, z: viewer.z - marker.z)).map { angleDeg(n, $0) } ?? 0
    let ambiguous = tilt != nil &&
        passing.contains { m, score in angleDeg(m, n) > TILT_AMBIGUOUS_DEG && score - bestScore < TILT_AMBIGUOUS_DEG }
    if ambiguous { return WallFix(headingDeg: nil, viewAngleDeg: view) }
    let deg = atan2(n.x, n.z) * 180 / .pi
    return WallFix(headingDeg: deg <= -180 ? deg + 360 : deg, viewAngleDeg: view) // (-180, 180]
}

/// The plane normals (Virvi world, unit, toward the camera) a printed circle with `d`'s outline could have, seen by
/// the ARKit camera at `cameraTransform`. A tilted circle's outline is squashed along its minor axis by the cosine of
/// the tilt, so the normal leans from the ray toward the camera by `acos(minor / major)`, one way or the other along
/// the minor axis: two candidates. A nearly round outline (minor / major above `ROUND_RATIO`) gives the one candidate
/// of the ray toward the camera. The outline is treated as seen along its own ray (no perspective skew).
public func circleNormals(_ d: RingDetection, _ k: CameraIntrinsics, cameraTransform: simd_float4x4) -> [Vec3] {
    let ray = unit(Vec3(x: (d.cx - k.cx) / k.fx, y: (d.cy - k.cy) / k.fy, z: 1))
    let toCamera = scale(ray, -1)
    let ratio = d.semiMajor > 0 ? d.semiMinor / d.semiMajor : 1
    let inCamera: [Vec3]
    if ratio > ROUND_RATIO {
        inCamera = [toCamera]
    } else {
        let th = d.angleDeg * .pi / 180
        // The minor axis, lifted from the image to camera space at the ellipse's centre, square to the ray.
        let u = Vec3(x: -sin(th) / k.fx, y: cos(th) / k.fy, z: 0)
        let m = unit(sub(u, scale(ray, dot(u, ray))))
        let tau = acos(min(max(ratio, 0), 1))
        let c = cos(tau), s = sin(tau)
        inCamera = [add(scale(toCamera, c), scale(m, s)), sub(scale(toCamera, c), scale(m, s))]
    }
    let origin = cameraToVirviWorld(Vec3(x: 0, y: 0, z: 0), cameraTransform: cameraTransform)
    return inCamera.map { unit(sub(cameraToVirviWorld($0, cameraTransform: cameraTransform), origin)) }
}

/// How far `d`'s circle is tilted from facing the camera, from its outline alone: `acos(minor / major)`, in degrees.
public func circleTiltDeg(_ d: RingDetection) -> Double {
    acos(min(max(d.semiMajor > 0 ? d.semiMinor / d.semiMajor : 1, 0), 1)) * 180 / .pi
}

/// How far a print's size may be off, as a share of the range, for the wall behind it to be taken for its wall.
public let PRINT_SCALE_TOLERANCE = 0.25

/// How far a ray's hit may be past a wall's edges and still count as on it.
public let WALL_TOLERANCE_M = 0.10

/// How far a wall's normal may be from the circle's tilt (see `circleNormals`) and still count as the marker's wall.
public let TILT_TOLERANCE_DEG = 20.0

/// Two walls facing ways more than this apart that both agree with the tilt, the runner-up by less than this more
/// than the best, leave the marker's wall in doubt (see `wallFix`).
public let TILT_AMBIGUOUS_DEG = 15.0

/// An outline rounder than this (minor / major) says nothing about which way the circle is tilted.
public let ROUND_RATIO = 0.97

/// The last `capacity` world positions of one marker, averaged before the scene snaps to it. `ready` once there are
/// at least `minCount`. Clear it when the marker is lost. Not thread-safe (main thread only).
public final class PoseAverager {
    private let capacity: Int
    private let minCount: Int
    private var samples: [Vec3] = []

    public init(capacity: Int = 15, minCount: Int = 5) {
        self.capacity = capacity
        self.minCount = minCount
    }

    public var count: Int { samples.count }
    public var ready: Bool { samples.count >= minCount }

    public func add(_ p: Vec3) {
        if samples.count == capacity { samples.removeFirst() }
        samples.append(p)
    }

    public func clear() { samples.removeAll() }

    /// The mean position, or nil with no samples.
    public func mean() -> Vec3? {
        if samples.isEmpty { return nil }
        let n = Double(samples.count)
        let s = samples.reduce(Vec3(x: 0, y: 0, z: 0)) { Vec3(x: $0.x + $1.x, y: $0.y + $1.y, z: $0.z + $1.z) }
        return Vec3(x: s.x / n, y: s.y / n, z: s.z / n)
    }

    /// The largest distance of a sample from the `mean`, in metres, or nil with no samples.
    public func spread() -> Double? {
        guard let m = mean() else { return nil }
        return samples.map { length(sub($0, m)) }.max()
    }
}

// MARK: - Vec3 helpers (file-local, so they can't clash with simd's)

private func add(_ a: Vec3, _ b: Vec3) -> Vec3 { Vec3(x: a.x + b.x, y: a.y + b.y, z: a.z + b.z) }
private func sub(_ a: Vec3, _ b: Vec3) -> Vec3 { Vec3(x: a.x - b.x, y: a.y - b.y, z: a.z - b.z) }
private func scale(_ a: Vec3, _ s: Double) -> Vec3 { Vec3(x: a.x * s, y: a.y * s, z: a.z * s) }
private func dot(_ a: Vec3, _ b: Vec3) -> Double { a.x * b.x + a.y * b.y + a.z * b.z }
private func length(_ a: Vec3) -> Double { dot(a, a).squareRoot() }
private func unit(_ a: Vec3) -> Vec3 { scale(a, 1 / length(a)) }

/// The angle between unit vectors `a` and `b`, in degrees.
private func angleDeg(_ a: Vec3, _ b: Vec3) -> Double { acos(min(max(dot(a, b), -1), 1)) * 180 / .pi }

private func flatUnit(_ v: Vec3) -> Vec3? {
    let len = (v.x * v.x + v.z * v.z).squareRoot()
    return len < 1e-3 ? nil : Vec3(x: v.x / len, y: 0, z: v.z / len)
}
