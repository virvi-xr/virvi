import CoreGraphics
import CoreVideo
import ImageIO
import simd
import XCTest
import VirviARKit
@testable import VirviAR

/// Review Focus 1: the captured image goes to the detector in its native sensor orientation, scaled, with the
/// intrinsics scaled to match.
final class FramePipelineTests: XCTestCase {
    /// .../apps/iphone/Tests/FramePipelineTests.swift -> repo root
    static let testsetDir: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }
        return url.appendingPathComponent("apps/ring-marker/testset")
    }()

    private struct Expected {
        var file: String
        var id: UInt32
        var center: (Double, Double)
        var focalPx: Double
    }

    private func expected(_ name: String) throws -> Expected {
        let url = Self.testsetDir.appendingPathComponent("manifest.json")
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw NSError(domain: "FramePipelineTests", code: 1, userInfo: [NSLocalizedDescriptionKey:
                "Ring test set not found at \(Self.testsetDir.path). Generate it first: " +
                "cd apps/ring-marker && python3 -m ringmarker.testset testset"])
        }
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [[String: Any]])
        let o = try XCTUnwrap(root.first { $0["name"] as? String == name }, name)
        let m = try XCTUnwrap((o["markers"] as? [[String: Any]])?.first)
        let c = try XCTUnwrap(m["center_px"] as? [NSNumber])
        return Expected(file: o["file"] as! String, id: (m["id"] as! NSNumber).uint32Value,
                        center: (c[0].doubleValue, c[1].doubleValue), focalPx: (o["focal_px"] as! NSNumber).doubleValue)
    }

    /// A camera-style luma buffer (420f, plane 0 filled) of `width` × `height` holding `image` scaled to fill it.
    private func lumaBuffer(_ image: CGImage, width: Int, height: Int) throws -> CVPixelBuffer {
        var pb: CVPixelBuffer?
        let attrs = [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary
        XCTAssertEqual(CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_420YpCbCr8BiPlanarFullRange, attrs, &pb),
                       kCVReturnSuccess)
        let buffer = try XCTUnwrap(pb)
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        let ctx = try XCTUnwrap(CGContext(data: CVPixelBufferGetBaseAddressOfPlane(buffer, 0), width: width, height: height,
                                          bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRowOfPlane(buffer, 0),
                                          space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue))
        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return buffer
    }

    func testFindsTheRingInAFullResolutionSensorFrameAndScalesTheIntrinsics() throws {
        let e = try expected("range-RING140-0.6-0")
        let src = try XCTUnwrap(CGImageSourceCreateWithURL(Self.testsetDir.appendingPathComponent(e.file) as CFURL, nil))
        let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(src, 0, nil))
        XCTAssertEqual(image.width, 1280)
        XCTAssertEqual(image.height, 960)
        // ARKit's full-resolution capture, 1.5x the test set's 1280 x 960, in sensor (landscape) orientation.
        let luma = try lumaBuffer(image, width: 1920, height: 1440)
        let fx = Float(e.focalPx * 1.5)
        XCTAssertEqual(fx, 1300.5)
        let k = simd_float3x3(columns: (SIMD3<Float>(fx, 0, 0), SIMD3<Float>(0, fx, 0), SIMD3<Float>(960, 720, 1)))
        var t = matrix_identity_float4x4
        t.columns.3 = SIMD4<Float>(0.1, 1.4, -0.2, 1)

        let r = FramePipeline().process(luma: luma, intrinsics: k, cameraTransform: t)

        let d = try XCTUnwrap(r.frame.detections.first { $0.id == e.id }, "RING140 not found: \(r.frame.detections)")
        XCTAssertEqual(d.cx, e.center.0, accuracy: 2)
        XCTAssertEqual(d.cy, e.center.1, accuracy: 2)
        XCTAssertEqual(r.intrinsics.width, 1280)
        XCTAssertEqual(r.intrinsics.height, 960)
        XCTAssertEqual(r.intrinsics.fx, 867, accuracy: 1e-6)
        XCTAssertEqual(r.intrinsics.fy, 867, accuracy: 1e-6)
        XCTAssertEqual(r.intrinsics.cx, 640, accuracy: 1e-6)
        XCTAssertEqual(r.intrinsics.cy, 480, accuracy: 1e-6)
        XCTAssertEqual(r.cameraTransform, t)
    }

    func testScaledSizeKeepsTheCapturedAspect() {
        XCTAssertEqual(FramePipeline.scaledSize(width: 1920, height: 1440).width, 1280)
        XCTAssertEqual(FramePipeline.scaledSize(width: 1920, height: 1440).height, 960)
        XCTAssertEqual(FramePipeline.scaledSize(width: 1920, height: 1080).height, 720)
        // Already small enough: left as it is.
        XCTAssertEqual(FramePipeline.scaledSize(width: 640, height: 480).width, 640)
    }

    func testGateTakesAboutEightFramesASecondAndOneAtATime() {
        var gate = FrameGate(intervalMs: 125)
        XCTAssertTrue(gate.take(nowMs: 0))
        XCTAssertFalse(gate.take(nowMs: 200), "one frame in flight at most")
        gate.finished()
        XCTAssertTrue(gate.take(nowMs: 200))
        gate.finished()
        XCTAssertFalse(gate.take(nowMs: 300), "too soon after the last")
        XCTAssertTrue(gate.take(nowMs: 325))
    }
}
