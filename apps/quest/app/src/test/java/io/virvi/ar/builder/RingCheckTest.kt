package io.virvi.ar.builder

import io.virvi.ar.Vec3
import io.virvi.ar.api.ArFloor
import io.virvi.ar.api.ArMarker
import io.virvi.ar.api.BuilderCall
import io.virvi.ar.api.MarkerPose
import io.virvi.ar.space.RootPose
import io.virvi.ar.space.markerInScene
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RingCheckTest {
  private val expected = MarkerPose(2.0, 1.5, 3.0, 90.0)

  private fun at(dx: Double = 0.0, dy: Double = 0.0, dz: Double = 0.0, dh: Double = 0.0) =
      MarkerPose(expected.x + dx, expected.y + dy, expected.z + dz, expected.headingDeg + dh)

  @Test fun `3 cm and half a degree do not warn`() {
    val r = checkRing(expected, at(dx = 0.03, dh = 0.5))
    assertFalse(r.warn)
    assertEquals(0.03, r.distanceM, 1e-9)
    assertEquals(0.5, r.headingDeg, 1e-9)
  }

  @Test fun `6 cm warns`() = assertTrue(checkRing(expected, at(dz = 0.06)).warn)

  @Test fun `1_2 degrees warns, either way round`() {
    assertTrue(checkRing(expected, at(dh = 1.2)).warn)
    assertTrue(checkRing(expected, at(dh = -1.2)).warn)
  }

  @Test fun `distance combines horizontal and vertical`() {
    val r = checkRing(expected, at(dx = 0.03, dy = 0.04))
    assertEquals(0.05, r.distanceM, 1e-9)
    assertTrue(checkRing(expected, at(dx = 0.04, dy = 0.04)).warn)
  }

  @Test fun `heading difference wraps round north`() {
    assertEquals(2.0, checkRing(MarkerPose(0.0, 0.0, 0.0, 359.0), MarkerPose(0.0, 0.0, 0.0, 1.0)).headingDeg, 1e-9)
  }

  @Test fun `mayRecord at 3_9 m true and 4_1 m false`() {
    val anchor = Vec3(1.0, 1.4, 1.0)
    assertTrue(mayRecord(Vec3(1.0 + 3.9, 1.4, 1.0), anchor))
    assertFalse(mayRecord(Vec3(1.0 + 4.1, 1.4, 1.0), anchor))
    assertFalse(mayRecord(Vec3(1.0, 1.4, 1.0 - 4.1), anchor))
  }

  @Test fun `mayRecord counts height in the straight line`() {
    assertFalse(mayRecord(Vec3(0.0, 4.1, 0.0), Vec3(0.0, 0.0, 0.0)))
  }

  @Test fun `check line copy rounds cm to whole and degrees to one decimal`() {
    assertEquals("This ARC is 6 cm and 1.2° from where it should be", checkLine(CheckResult(0.0649, 1.24, true)))
    assertEquals("This ARC is 7 cm and 0.0° from where it should be", checkLine(CheckResult(0.065, 0.0, true)))
    assertEquals("This ARC is 3 cm and 0.5° from where it should be", checkLine(CheckResult(0.03, 0.5, false)))
    assertEquals("This ARC is 0 cm and 12.0° from where it should be", checkLine(CheckResult(0.004, 11.96, true)))
  }

  // --- the flow ---

  private val root = RootPose(Vec3(10.0, 0.0, 5.0), 30.0)
  private val anchor = Vec3(10.0, 1.5, 5.0)

  private fun marker(id: Long, pose: MarkerPose?) = ArMarker("m$id", id, "code$id", 140.0, null, pose)
  private fun floor(vararg m: ArMarker) = ArFloor("f", "Ground", 0.0, 0, m.toList())

  /** The ring in view placed so that it reads exactly [pose] (plus [dx] in scene x). */
  private fun seen(id: Long, pose: MarkerPose, dx: Double = 0.0): RingInView {
    val p = pose.copy(x = pose.x + dx)
    // Invert markerInScene: the world spot of scene point p under root.
    val rad = Math.toRadians(root.yawDeg)
    val wx = root.position.x + p.x * Math.cos(rad) + p.z * Math.sin(rad)
    val wz = root.position.z - p.x * Math.sin(rad) + p.z * Math.cos(rad)
    return RingInView(id, Vec3(wx, root.position.y + p.y, wz), p.headingDeg + root.yawDeg)
  }

  @Test fun `no pose and near the anchor shows Record`() {
    val f = floor(marker(1, expected), marker(2, null))
    val ring = RingInView(2, Vec3(12.0, 1.5, 5.0), 0.0)
    val v = RingCheckFlow(f).view(root, anchor, ring)
    assertEquals(RingButton.Record, v.button)
    assertNull(v.line)
    assertNull(v.suggestion)
  }

  @Test fun `no pose and past the radius is refused with the copy`() {
    val f = floor(marker(1, expected), marker(2, null))
    val ring = RingInView(2, Vec3(14.5, 1.5, 5.0), 0.0)
    val flow = RingCheckFlow(f)
    val v = flow.view(root, anchor, ring)
    assertEquals(RingButton.None, v.button)
    assertEquals("Too far from the last ARC to record accurately: walk back, or align from this ARC instead", v.line)
    assertNull(flow.requestSave(root, anchor, ring))
    assertEquals(RingCheckCopy.TOO_FAR, flow.status)
  }

  @Test fun `a ring with a pose that checks out shows the line and no button`() {
    val f = floor(marker(1, expected), marker(2, expected.copy(x = 5.0)))
    val v = RingCheckFlow(f).view(root, anchor, seen(1, expected, dx = 0.03))
    assertEquals(RingButton.None, v.button)
    assertEquals("This ARC is 3 cm and 0.0° from where it should be", v.line)
    assertFalse(v.warn)
  }

  @Test fun `a ring that is off warns and offers Re-record`() {
    val f = floor(marker(1, expected), marker(2, expected.copy(x = 5.0)))
    val v = RingCheckFlow(f).view(root, anchor, seen(1, expected, dx = 0.06))
    assertEquals(RingButton.ReRecord, v.button)
    assertEquals("This ARC is 6 cm and 0.0° from where it should be", v.line)
    assertTrue(v.warn)
  }

  @Test fun `re-record saves only this ring's pose`() {
    val f = floor(marker(1, expected), marker(2, expected.copy(x = 5.0)))
    val ring = seen(1, expected, dx = 0.06)
    val flow = RingCheckFlow(f)
    val save = flow.requestSave(root, ring.world, ring)!!
    assertEquals(expected.x + 0.06, save.pose.x, 1e-9)
    assertEquals(expected.z, save.pose.z, 1e-9)
    assertEquals(ring.world.y, save.heightAboveFloorM, 1e-9)
    assertEquals(RingCheckCopy.SAVING, flow.status)
    assertNull(flow.requestSave(root, ring.world, ring))
    flow.saved(BuilderCall.Ok(emptyList()))
    assertEquals("ARC saved", flow.status)
  }

  @Test fun `re-record past the radius is refused with Record's copy`() {
    val f = floor(marker(1, expected), marker(2, expected.copy(x = 5.0)))
    val ring = seen(1, expected, dx = 0.06)
    val far = Vec3(ring.world.x + 4.1, ring.world.y, ring.world.z)
    val flow = RingCheckFlow(f)
    val v = flow.view(root, far, ring)
    assertEquals(RingButton.None, v.button)
    assertEquals("This ARC is 6 cm and 0.0° from where it should be", v.line)
    assertTrue(v.warn)
    assertEquals("Too far from the last ARC to record accurately: walk back, or align from this ARC instead", v.refusal)
    assertEquals(listOf(v.line, RingCheckCopy.TOO_FAR), ringCheckLines(v, null))
    assertNull(flow.requestSave(root, far, ring))
    assertEquals(RingCheckCopy.TOO_FAR, flow.status)
    assertEquals(listOf(v.line, RingCheckCopy.TOO_FAR), ringCheckLines(v, flow.status)) // said once
    // Within the radius it is offered again.
    val near = Vec3(ring.world.x + 3.9, ring.world.y, ring.world.z)
    assertEquals(RingButton.ReRecord, flow.view(root, near, ring).button)
  }

  @Test fun `a floor with one ring suggests a second`() {
    val v = RingCheckFlow(floor(marker(1, expected))).view(root, anchor, seen(1, expected))
    assertEquals("Add a second ARC on this floor so visitors stay lined up", v.suggestion)
  }

  @Test fun `a ring from another floor shows nothing`() {
    val v = RingCheckFlow(floor(marker(1, expected))).view(root, anchor, RingInView(9, anchor, 0.0))
    assertEquals(RingCheckView(RingButton.None, null, false, null), v)
  }

  @Test fun `save failures show their copy`() {
    val f = floor(marker(2, null), marker(1, expected))
    val flow = RingCheckFlow(f)
    flow.requestSave(root, anchor, RingInView(2, Vec3(11.0, 1.5, 5.0), 0.0))!!
    flow.saved(BuilderCall.NoAccess)
    assertEquals(AlignCopy.NO_ACCESS, flow.status)
    flow.requestSave(root, anchor, RingInView(2, Vec3(11.0, 1.5, 5.0), 0.0))!!
    flow.saved(BuilderCall.Offline)
    assertEquals(AlignCopy.OFFLINE, flow.status)
  }

  @Test fun `a flow made from the newer floor keeps the saved status and checks the recorded ring`() {
    val before = floor(marker(2, null), marker(1, expected))
    val ring = RingInView(2, Vec3(11.0, 1.5, 5.0), 0.0)
    val flow = RingCheckFlow(before)
    val save = flow.requestSave(root, anchor, ring)!!
    flow.saved(BuilderCall.Ok(emptyList()))
    val next = RingCheckFlow(floor(marker(2, save.pose), marker(1, expected)), flow.status)
    assertEquals(RingCheckCopy.SAVED, next.status)
    val v = next.view(root, anchor, ring)
    assertEquals(RingButton.None, v.button)
    assertEquals("This ARC is 0 cm and 0.0° from where it should be", v.line)
  }
}
