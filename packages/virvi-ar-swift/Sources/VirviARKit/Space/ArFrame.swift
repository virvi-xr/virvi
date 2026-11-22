import CoreGraphics
import Foundation
import simd
#if os(iOS)
import ARKit
#endif

// The boundary between ARKit and the Virvi world frame the ring maths runs in.
//
// Frames:
// - image camera frame (the detector's): +x right, +y down, +z forward;
// - ARKit camera frame: +x right, +y up, camera looks along -z (for the captured image in its native orientation);
// - ARKit / RealityKit world: right-handed, Y up;
// - Virvi world: ARKit world with z mirrored, (x, y, z)_virvi = (x, y, -z)_arkit: left-handed, Y up, headings in
//   degrees from +Z toward +X.

/// ARKit's camera intrinsics `k` (for the full-resolution captured image, `imageSize`) at the detector's
/// `width` × `height` grey frame, a plain resize of it. ARKit's matrix is column-major: fx = k[0][0], fy = k[1][1],
/// principal point (k[2][0], k[2][1]).
public func intrinsics(fromARKit k: simd_float3x3, imageSize: CGSize, scaledTo width: Int, height: Int) -> CameraIntrinsics {
    let sx = Double(width) / Double(imageSize.width)
    let sy = Double(height) / Double(imageSize.height)
    return CameraIntrinsics(fx: Double(k[0][0]) * sx, fy: Double(k[1][1]) * sy,
                            cx: Double(k[2][0]) * sx, cy: Double(k[2][1]) * sy,
                            width: width, height: height)
}

/// An image-camera-frame point (as `markerInCamera` gives it) in the Virvi world: flip y and z into ARKit's camera
/// frame, apply `cameraTransform` (`ARCamera.transform`, camera to ARKit world), then mirror z.
public func cameraToVirviWorld(_ p: Vec3, cameraTransform: simd_float4x4) -> Vec3 {
    let c = double(cameraTransform) * SIMD4<Double>(p.x, -p.y, -p.z, 1)
    return Vec3(x: c.x, y: c.y, z: -c.z)
}

private func double(_ m: simd_float4x4) -> simd_double4x4 {
    simd_double4x4(columns: (SIMD4<Double>(m.columns.0), SIMD4<Double>(m.columns.1), SIMD4<Double>(m.columns.2),
                             SIMD4<Double>(m.columns.3)))
}

/// An ARKit world point or direction in the Virvi world (z mirrored).
func virviFromARKit(_ v: SIMD3<Double>) -> Vec3 { Vec3(x: v.x, y: v.y, z: -v.z) }

/// The wall a vertical plane anchor is, in the Virvi frame; nil for a horizontal plane. The plane lies in the anchor's
/// x-z plane with its normal along anchor +y; `center` is in anchor coordinates; the extent's `width` runs along anchor
/// x and its `height` along anchor z after turning them by `rotationOnYAxis` about anchor y (ARKit's `planeExtent`).
/// The half extents are those of the extent rectangle's bounding box along and up the wall. Split from the
/// `ARPlaneAnchor` overload because an `ARPlaneAnchor` can't be built in tests.
func wallPlane(transform: simd_float4x4, center: SIMD3<Float>, width: Float, height: Float, rotationOnYAxis: Float,
               vertical: Bool) -> WallPlane? {
    guard vertical else { return nil }
    let m = double(transform)
    let world = { (v: SIMD3<Double>, w: Double) -> SIMD3<Double> in
        let r = m * SIMD4<Double>(v, w)
        return SIMD3<Double>(r.x, r.y, r.z)
    }
    let centre = world(SIMD3<Double>(center), 1)
    let normal = simd_normalize(world([0, 1, 0], 0))
    let a = Double(rotationOnYAxis)
    // The extent's axes, turned about anchor y (the same turn as simd_quatd(angle: a, axis: [0, 1, 0])).
    let wAxis = world([cos(a), 0, -sin(a)], 0)
    let hAxis = world([sin(a), 0, cos(a)], 0)
    let up = SIMD3<Double>(0, 1, 0)
    var along = simd_cross(up, normal)
    let l = simd_length(along)
    guard l > 1e-3 else { return nil } // not vertical after all
    along /= l
    let hw = Double(width) / 2, hh = Double(height) / 2
    let halfWidth: Double = abs(simd_dot(wAxis, along)) * hw + abs(simd_dot(hAxis, along)) * hh
    let halfHeight: Double = abs(simd_dot(wAxis, up)) * hw + abs(simd_dot(hAxis, up)) * hh
    return WallPlane(centre: virviFromARKit(centre), normal: virviFromARKit(normal), halfWidth: halfWidth, halfHeight: halfHeight)
}

#if os(iOS)
/// The wall a scanned vertical plane is, in the Virvi frame (centre, normal along the anchor's +y, half extents);
/// nil for a horizontal plane.
public func wallPlane(from anchor: ARPlaneAnchor) -> WallPlane? {
    wallPlane(transform: anchor.transform, center: anchor.center, width: anchor.planeExtent.width,
              height: anchor.planeExtent.height, rotationOnYAxis: anchor.planeExtent.rotationOnYAxis,
              vertical: anchor.alignment == .vertical)
}
#endif
