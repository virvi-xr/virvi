import simd
import XCTest

/// The gizmo's drag math (Core/Edit/GizmoMath.swift), in Virvi scene coordinates.
final class GizmoMathTests: XCTestCase {
    private let start = ItemTransform(position: [1, 0, 2], rotation: [0, 0, 0], scale: [1, 1, 1])

    private func assertClose(_ a: SIMD3<Double>?, _ b: SIMD3<Double>, _ accuracy: Double = 1e-6,
                             file: StaticString = #filePath, line: UInt = #line) {
        guard let a else { return XCTFail("nil", file: file, line: line) }
        for i in 0..<3 { XCTAssertEqual(a[i], b[i], accuracy: accuracy, file: file, line: line) }
    }

    // MARK: - Which handles work in which mode

    func testHandlesOnlyWorkInTheirMode() {
        XCTAssertTrue(GizmoHandle.body.fits(.move))
        XCTAssertTrue(GizmoHandle.arrow(.x).fits(.move))
        XCTAssertFalse(GizmoHandle.body.fits(.rotate))
        XCTAssertFalse(GizmoHandle.body.fits(.resize))
        XCTAssertTrue(GizmoHandle.ring(.y).fits(.rotate))
        XCTAssertFalse(GizmoHandle.ring(.y).fits(.move))
        XCTAssertTrue(GizmoHandle.uniform.fits(.resize))
        XCTAssertTrue(GizmoHandle.stretch(.z).fits(.resize))
        XCTAssertFalse(GizmoHandle.stretch(.z).fits(.rotate))
        XCTAssertNil(GizmoDrag(handle: .ring(.y), mode: .move, lock: .free, start: start, grab: [2, 0, 2]))
    }

    // MARK: - Move

    func testArrowMovesAlongItsAxisOnly() {
        var d = GizmoDrag(handle: .arrow(.x), mode: .move, lock: .free, start: start, grab: [1.5, 0, 2])!
        assertClose(d.update(to: [2.0, 0.3, 2.4])?.position, [1.5, 0, 2])
    }

    func testArrowFollowsTheLock() {
        XCTAssertNil(GizmoDrag(handle: .arrow(.x), mode: .move, lock: .y, start: start, grab: [1.5, 0, 2]))
        var d = GizmoDrag(handle: .arrow(.y), mode: .move, lock: .y, start: start, grab: [1, 0.5, 2])!
        assertClose(d.update(to: [3, 1.5, 9])?.position, [1, 1, 2])
    }

    func testBodyMovesFreelyOrAlongTheLockedAxis() {
        var free = GizmoDrag(handle: .body, mode: .move, lock: .free, start: start, grab: [1, 0.5, 2])!
        assertClose(free.update(to: [2, 1, 1])?.position, [2, 0.5, 1])
        var locked = GizmoDrag(handle: .body, mode: .move, lock: .z, start: start, grab: [1, 0.5, 2])!
        assertClose(locked.update(to: [2, 1, 1])?.position, [1, 0, 1])
    }

    func testMoveKeepsRotationAndScale() {
        let s = ItemTransform(position: [1, 0, 2], rotation: [0, 45, 0], scale: [2, 2, 2])
        var d = GizmoDrag(handle: .body, mode: .move, lock: .free, start: s, grab: [1, 0, 2])!
        let t = d.update(to: [1, 1, 2])!
        XCTAssertEqual(t.rotation, s.rotation)
        XCTAssertEqual(t.scale, s.scale)
    }

    // MARK: - Rotate

    func testRingTurnsByTheHandsAngleAroundTheItem() {
        let s = ItemTransform(position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1])
        // Turning +x towards -z about y is +90 in Virvi's (Decentraland's) yaw: yaw 90 takes forward (+z) to +x.
        var d = GizmoDrag(handle: .ring(.y), mode: .rotate, lock: .free, start: s, grab: [1, 0.4, 0])!
        assertClose(d.update(to: [0, 0.9, -1])?.rotation, [0, 90, 0])
    }

    func testRingAddsUpPastAHalfTurn() {
        let s = ItemTransform(position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1])
        var d = GizmoDrag(handle: .ring(.y), mode: .rotate, lock: .free, start: s, grab: [1, 0, 0])!
        _ = d.update(to: [0, 0, -1])
        _ = d.update(to: [-1, 0, 0])
        assertClose(d.update(to: [0, 0, 1])?.rotation, [0, 270, 0])
    }

    func testRingComposesWithTheStartRotation() {
        let s = ItemTransform(position: [0, 0, 0], rotation: [0, 90, 0], scale: [1, 1, 1])
        var d = GizmoDrag(handle: .ring(.y), mode: .rotate, lock: .free, start: s, grab: [1, 0, 0])!
        assertClose(d.update(to: [0, 0, -1])?.rotation, [0, 180, 0])
    }

    func testRingWithNoNetTurnKeepsTheStartEulerExactly() {
        let s = ItemTransform(position: [0, 0, 0], rotation: [10, 20, 30], scale: [1, 1, 1])
        var d = GizmoDrag(handle: .ring(.x), mode: .rotate, lock: .free, start: s, grab: [0, 1, 0])!
        XCTAssertEqual(d.update(to: [0.3, 1, 0])?.rotation, [10, 20, 30])
    }

    func testRingIgnoresTheLock() {
        XCTAssertNotNil(GizmoDrag(handle: .ring(.z), mode: .rotate, lock: .x, start: start, grab: [2, 0, 2]))
    }

    // MARK: - Resize

    func testUniformScalesByTheDistanceRatio() {
        let s = ItemTransform(position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 2, 1])
        var d = GizmoDrag(handle: .uniform, mode: .resize, lock: .free, start: s, grab: [0.3, 0.4, 0])!
        assertClose(d.update(to: [0.6, 0.8, 0])?.scale, [2, 4, 2])
        assertClose(d.update(to: [0.0001, 0, 0])?.scale, [0.05, 0.05, 0.05]) // floored at MIN_SCALE
    }

    func testStretchFollowsTheItemsOwnAxis() {
        // Yawed 90: the item's own +x points along scene -z.
        let s = ItemTransform(position: [0, 0, 0], rotation: [0, 90, 0], scale: [1, 1, 1])
        var d = GizmoDrag(handle: .stretch(.x), mode: .resize, lock: .free, start: s, grab: [0, 0, -0.5])!
        assertClose(d.update(to: [0.3, 0.2, -1])?.scale, [2, 1, 1])
    }

    func testAGrabOnTheCentreCantResize() {
        var d = GizmoDrag(handle: .uniform, mode: .resize, lock: .free, start: start, grab: start.position)!
        XCTAssertNil(d.update(to: [3, 3, 3]))
    }

    // MARK: - Sizes

    func testHandlesAreAtLeast6cmAndGrowWithDistance() {
        XCTAssertEqual(gizmoHandleSize(distance: 0.3), 0.06, accuracy: 1e-9)
        XCTAssertEqual(gizmoHandleSize(distance: 0), 0.06, accuracy: 1e-9)
        XCTAssertGreaterThan(gizmoHandleSize(distance: 5), gizmoHandleSize(distance: 2))
        // The same angular size from 2 m to 5 m: about 2.9 degrees.
        XCTAssertEqual(gizmoHandleSize(distance: 2) / 2, gizmoHandleSize(distance: 5) / 5, accuracy: 1e-9)
        XCTAssertEqual(gizmoHandleSize(distance: 2), 0.1, accuracy: 1e-9)
    }

    func testRingRadiusAndHandleOffsetAsDecentraland() {
        XCTAssertEqual(gizmoRingRadius(scale: [0.2, 0.3, 0.1]), 0.5)
        XCTAssertEqual(gizmoRingRadius(scale: [1, -2, 1]), 1.2, accuracy: 1e-9)
        XCTAssertEqual(gizmoHandleOffset(0.1), 0.3)
        XCTAssertEqual(gizmoHandleOffset(1), 0.65, accuracy: 1e-9)
    }

    // MARK: - Euler (Decentraland's) and quaternions

    func testEulerQuaternionMatchesYXZAndRoundTrips() {
        let e: SIMD3<Double> = [20, 135, 350]
        let q = eulerDegreesToQuat(e)
        let r = quaternionYXZ(e * .pi / 180)
        XCTAssertEqual(abs(simd_dot(q.vector, r.vector)), 1, accuracy: 1e-9)
        assertClose(quatToEulerDegrees(q), e, 1e-9)
    }
}

/// EditModeBar.tsx's Exact panel: `parseExact` and applying typed axes over the live value.
final class ExactFieldTests: XCTestCase {
    func testParseExactAsDecentraland() {
        XCTAssertEqual(parseExact(" 1.5 "), 1.5)
        XCTAssertEqual(parseExact("-2"), -2)
        XCTAssertNil(parseExact(""))
        XCTAssertNil(parseExact("  "))
        XCTAssertNil(parseExact("1abc"))
        XCTAssertNil(parseExact("Infinity"))
    }

    func testTypedAxesReplaceOnlyThemselvesAndJunkKeepsTheOldValue() {
        XCTAssertEqual(exactValue([1, 2, 3], typed: [0: "5", 2: "x"]), [5, 2, 3])
        XCTAssertNil(exactValue([1, 2, 3], typed: [1: "nope"])) // nothing to apply
        XCTAssertNil(exactValue([1, 2, 3], typed: [:]))
    }

    func testExactFieldForMode() {
        XCTAssertEqual(ExactField(.move), .position)
        XCTAssertEqual(ExactField(.rotate), .rotation)
        XCTAssertEqual(ExactField(.resize), .scale)
        XCTAssertEqual(exactTitle(.move), "Position (m)")
        XCTAssertEqual(exactTitle(.rotate), "Rotation (degrees)")
        XCTAssertEqual(exactTitle(.resize), "Scale")
        XCTAssertEqual(formatExact(1.23456), "1.235")
        XCTAssertEqual(formatExact(2), "2")
    }
}

/// Handles sit outside the item's mesh, so a pinch on one isn't taken by the item's own hit box.
final class GizmoLayoutTests: XCTestCase {
    func testWithoutBoundsItIsDecentralandsLayout() {
        let l = gizmoLayout(scale: [1, 2, 0.5], rotation: .zero, bounds: nil)
        XCTAssertEqual(l.ringRadius, gizmoRingRadius(scale: [1, 2, 0.5]), accuracy: 1e-9)
        XCTAssertEqual(l.arrowOffset, [gizmoHandleOffset(1), gizmoHandleOffset(2), gizmoHandleOffset(0.5)])
        XCTAssertEqual(l.handleOffset, l.arrowOffset)
    }

    func testATallMeshPushesRingsArrowsAndHandlesOutside() {
        // A duck-like mesh: origin at its feet, 1.6 m tall, while its scale is 1.
        let b = GizmoBounds(min: [-0.5, 0, -0.4], max: [0.5, 1.6, 0.4])
        let l = gizmoLayout(scale: [1, 1, 1], rotation: .zero, bounds: b)
        let corner = (0.25 + 2.56 + 0.16).squareRoot()
        XCTAssertEqual(l.ringRadius, corner + 0.15, accuracy: 1e-9)
        XCTAssertEqual(l.arrowOffset.y, 1.75, accuracy: 1e-9)
        XCTAssertEqual(l.arrowOffset.x, 0.65, accuracy: 1e-9) // Decentraland's offset already clears 0.5
        XCTAssertEqual(l.handleOffset.y, 1.75, accuracy: 1e-9)
    }

    func testArrowsUseTheTurnedMeshOnTheScenesAxesAndHandlesTheItemsOwn() {
        let b = GizmoBounds(min: [-1, 0, -0.2], max: [1, 0.5, 0.2])
        let straight = gizmoLayout(scale: [1, 1, 1], rotation: .zero, bounds: b)
        XCTAssertEqual(straight.arrowOffset.x, 1.15, accuracy: 1e-9)
        XCTAssertEqual(straight.arrowOffset.z, 0.65, accuracy: 1e-9)
        // Yawed 90: the long side now lies along scene z.
        let turned = gizmoLayout(scale: [1, 1, 1], rotation: [0, 90, 0], bounds: b)
        XCTAssertEqual(turned.arrowOffset.x, 0.65, accuracy: 1e-9)
        XCTAssertEqual(turned.arrowOffset.z, 1.15, accuracy: 1e-9)
        // Resize handles turn with the item: still along its own x.
        XCTAssertEqual(turned.handleOffset.x, 1.15, accuracy: 1e-9)
    }
}
