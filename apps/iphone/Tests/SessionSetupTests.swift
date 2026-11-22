import ARKit
import XCTest
@testable import VirviAR

final class SessionSetupTests: XCTestCase {
    func testOcclusionOnALiDARPhoneHidesBehindPeopleAndTheScannedMesh() {
        let s = SessionSetup(occlusion: true, supportsDepth: true, supportsMesh: true)
        XCTAssertEqual(s.frameSemantics, [.sceneDepth, .personSegmentationWithDepth])
        XCTAssertEqual(s.sceneReconstruction, .mesh)
    }

    func testOcclusionOffAsksForNeitherDepthNorMesh() {
        let s = SessionSetup(occlusion: false, supportsDepth: true, supportsMesh: true)
        XCTAssertEqual(s.frameSemantics, [])
        XCTAssertEqual(s.sceneReconstruction, [])
    }

    func testNoMeshWhereThePhoneCantReconstructOne() {
        let s = SessionSetup(occlusion: true, supportsDepth: true, supportsMesh: false)
        XCTAssertEqual(s.frameSemantics, [.sceneDepth, .personSegmentationWithDepth])
        XCTAssertEqual(s.sceneReconstruction, [])
    }

    func testNothingWithoutSceneDepth() {
        let s = SessionSetup(occlusion: true, supportsDepth: false, supportsMesh: true)
        XCTAssertEqual(s, SessionSetup(occlusion: false, supportsDepth: false, supportsMesh: false))
    }
}
