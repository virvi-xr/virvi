import Accelerate
import CoreGraphics
import CoreVideo
import Foundation
import simd
import VirviARKit

/// One camera frame through the detector: what it found, the intrinsics at the detector's image size, and the
/// frame's own camera transform (camera to ARKit world), so the rings are placed from where the camera was then.
struct PipelineResult: Sendable {
    var frame: RingFrame
    var intrinsics: CameraIntrinsics
    var cameraTransform: simd_float4x4
}

/// Runs the ring detector on ARKit's captured image: the luma plane (plane 0 of
/// `kCVPixelFormatType_420YpCbCr8BiPlanarFullRange`) **in its native sensor orientation** (landscape, never turned for
/// the portrait UI: `cameraToVirviWorld` assumes the image camera frame of the unrotated image), scaled down to
/// `maxWidth` wide with vImage. Not thread-safe (it owns a `RingDetector` and reuses its buffers): one per queue.
final class FramePipeline {
    static let maxWidth = 1280

    private let detector = RingDetector()
    private var gray: [UInt8] = []
    private var temp: [UInt8] = []

    /// The detector's image size for a captured image: `maxWidth` wide at the same aspect, or as it is if smaller.
    static func scaledSize(width: Int, height: Int) -> (width: Int, height: Int) {
        guard width > maxWidth else { return (width, height) }
        return (maxWidth, Int((Double(height) * Double(maxWidth) / Double(width)).rounded()))
    }

    /// `intrinsics` is `ARCamera.intrinsics` (for the full-resolution captured image), `cameraTransform`
    /// `ARCamera.transform`.
    func process(luma: CVPixelBuffer, intrinsics k: simd_float3x3, cameraTransform: simd_float4x4) -> PipelineResult {
        CVPixelBufferLockBaseAddress(luma, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(luma, .readOnly) }
        let planar = CVPixelBufferIsPlanar(luma)
        let w = planar ? CVPixelBufferGetWidthOfPlane(luma, 0) : CVPixelBufferGetWidth(luma)
        let h = planar ? CVPixelBufferGetHeightOfPlane(luma, 0) : CVPixelBufferGetHeight(luma)
        let rowBytes = planar ? CVPixelBufferGetBytesPerRowOfPlane(luma, 0) : CVPixelBufferGetBytesPerRow(luma)
        let base = planar ? CVPixelBufferGetBaseAddressOfPlane(luma, 0) : CVPixelBufferGetBaseAddress(luma)
        assert(w >= h, "the captured image must stay in sensor (landscape) orientation, got \(w) x \(h)")
        let (sw, sh) = Self.scaledSize(width: w, height: h)
        // The intrinsics scale x and y separately, so a grey frame of another shape would put rings in the wrong place.
        assert(abs(Double(sw) / Double(sh) - Double(w) / Double(h)) < 0.01,
               "grey frame \(sw) x \(sh) doesn't keep the captured image's aspect (\(w) x \(h))")
        let k2 = intrinsics(fromARKit: k, imageSize: CGSize(width: w, height: h), scaledTo: sw, height: sh)
        guard let base else {
            return PipelineResult(frame: RingFrame(detections: [], unreadable: []), intrinsics: k2, cameraTransform: cameraTransform)
        }
        let frame: RingFrame
        if sw == w && sh == h {
            let buf = UnsafeBufferPointer(start: base.assumingMemoryBound(to: UInt8.self), count: rowBytes * h)
            frame = detector.detectFrame(gray: buf, width: w, height: h, rowStride: rowBytes)
        } else {
            scale(base, width: w, height: h, rowBytes: rowBytes, to: sw, sh)
            frame = gray.withUnsafeBufferPointer { detector.detectFrame(gray: $0, width: sw, height: sh, rowStride: sw) }
        }
        return PipelineResult(frame: frame, intrinsics: k2, cameraTransform: cameraTransform)
    }

    /// Scales the luma plane into `gray` (`sw` × `sh`, rows packed).
    private func scale(_ base: UnsafeMutableRawPointer, width: Int, height: Int, rowBytes: Int, to sw: Int, _ sh: Int) {
        if gray.count != sw * sh { gray = [UInt8](repeating: 0, count: sw * sh) }
        var src = vImage_Buffer(data: base, height: vImagePixelCount(height), width: vImagePixelCount(width), rowBytes: rowBytes)
        gray.withUnsafeMutableBytes { dstBytes in
            var dst = vImage_Buffer(data: dstBytes.baseAddress, height: vImagePixelCount(sh), width: vImagePixelCount(sw), rowBytes: sw)
            let need = vImageScale_Planar8(&src, &dst, nil, vImage_Flags(kvImageGetTempBufferSize))
            if need > 0 && temp.count < need { temp = [UInt8](repeating: 0, count: need) }
            temp.withUnsafeMutableBytes { t in
                _ = vImageScale_Planar8(&src, &dst, t.baseAddress, vImage_Flags(kvImageNoFlags))
            }
        }
    }
}

/// Lets a frame through when none is in flight and `intervalMs` has passed since the last one (125 ms: about 8 a
/// second). Main thread only.
struct FrameGate {
    let intervalMs: Int64
    private var inFlight = false
    private var lastMs: Int64?

    init(intervalMs: Int64 = 125) { self.intervalMs = intervalMs }

    mutating func take(nowMs: Int64) -> Bool {
        if inFlight { return false }
        if let last = lastMs, nowMs - last < intervalMs { return false }
        inFlight = true
        lastMs = nowMs
        return true
    }

    mutating func finished() { inFlight = false }
}

/// Hands ARKit frames to a `FramePipeline` on a serial background queue, at most one in flight and about 8 a second,
/// and delivers each result on the main thread. `submit` is main thread only.
final class FrameFeeder {
    private let queue = DispatchQueue(label: "io.virvi.ar.frames", qos: .userInitiated)
    private let pipeline = FramePipeline() // used on `queue` only
    private var gate = FrameGate()

    /// Starts `luma` through the detector if the gate lets it; `done` runs on the main thread.
    func submit(luma: CVPixelBuffer, intrinsics: simd_float3x3, cameraTransform: simd_float4x4, nowMs: Int64,
                done: @escaping @MainActor (PipelineResult) -> Void) {
        guard gate.take(nowMs: nowMs) else { return }
        let pipeline = pipeline
        queue.async {
            let result = pipeline.process(luma: luma, intrinsics: intrinsics, cameraTransform: cameraTransform)
            DispatchQueue.main.async {
                self.gate.finished()
                MainActor.assumeIsolated { done(result) }
            }
        }
    }
}
