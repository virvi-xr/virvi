package io.virvi.ar.builder

import com.meta.spatial.core.Vector3
import io.virvi.ar.Vec3
import io.virvi.ar.api.BuilderCall
import io.virvi.ar.ring.WallPlane
import io.virvi.ar.ring.rangeToPlane
import io.virvi.ar.space.angleDiffDeg
import io.virvi.ar.space.markerInScene
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AlignmentTest {
  private val ring = Vec3(2.0, 1.4, -3.0)
  private val heading = 135.0

  @Test fun `defaultRoot puts the ring at scene 8, h, 0 facing north`() {
    val p = markerInScene(defaultRoot(ring, heading, 0.0, 1.5), ring, heading)
    assertEquals(8.0, p.x, 1e-9)
    assertEquals(1.5, p.y, 1e-9)
    assertEquals(0.0, p.z, 1e-9)
    assertEquals(0.0, p.headingDeg, 1e-9)
  }

  @Test fun `defaultRoot adds the floor height`() {
    assertEquals(4.5, markerInScene(defaultRoot(ring, heading, 3.0, 1.5), ring, heading).y, 1e-9)
  }

  @Test fun `nudge turns about the ring`() {
    val root = defaultRoot(ring, heading, 0.0, 1.5)
    val turned = nudge(root, 0.0, 0.0, 10.0, ring)
    val before = markerInScene(root, ring, heading)
    val after = markerInScene(turned, ring, heading)
    assertEquals(before.x, after.x, 1e-9)
    assertEquals(before.y, after.y, 1e-9)
    assertEquals(before.z, after.z, 1e-9)
    assertEquals(-10.0, angleDiffDeg(after.headingDeg, before.headingDeg), 1e-9)
  }

  @Test fun `nudge moves the scene in world x and z only`() {
    val root = defaultRoot(ring, heading, 0.0, 1.5)
    val moved = nudge(root, 0.01, -0.02, 0.0, ring)
    assertEquals(root.position.x + 0.01, moved.position.x, 1e-12)
    assertEquals(root.position.y, moved.position.y, 1e-12)
    assertEquals(root.position.z - 0.02, moved.position.z, 1e-12)
    assertEquals(root.yawDeg, moved.yawDeg, 1e-12)
  }

  @Test fun `sizeRatio and sizeWarning`() {
    assertEquals(1.5, sizeRatio(1.5, 1.0), 1e-12)
    assertNull(sizeWarning(1.02))
    assertNull(sizeWarning(0.98))
    assertNull(sizeWarning(1.0))
    assertEquals("This ARC looks about 8% smaller than its recorded size: was it printed at 100%?", sizeWarning(1.087))
    assertEquals("This ARC looks about 5% larger than its recorded size: was it printed at 100%?", sizeWarning(0.95))
  }

  @Test fun `sizeWarning ignores a ratio that is not a number`() {
    assertNull(sizeWarning(Double.NaN))
    assertNull(sizeWarning(0.0))
    assertNull(sizeWarning(Double.POSITIVE_INFINITY))
  }

  // ── the depth range ──

  @Test fun `rangeToPlane is the distance along the ray`() {
    // A wall at z = 3 facing -z; the ray leans 60° from the normal, so the range is 3 / cos 60° = 6.
    val dir = Vec3(Math.sin(Math.PI / 3), 0.0, Math.cos(Math.PI / 3))
    assertEquals(6.0, rangeToPlane(Vec3(0.0, 1.6, 0.0), dir, Vec3(0.0, 1.0, 3.0), Vec3(0.0, 0.0, -1.0))!!, 1e-9)
  }

  @Test fun `rangeToPlane is null for a parallel ray or a plane behind`() {
    val n = Vec3(0.0, 0.0, -1.0)
    assertNull(rangeToPlane(Vec3(0.0, 0.0, 0.0), Vec3(1.0, 0.0, 0.0), Vec3(0.0, 0.0, 3.0), n))
    assertNull(rangeToPlane(Vec3(0.0, 0.0, 0.0), Vec3(0.0, 0.0, -1.0), Vec3(0.0, 0.0, 3.0), n))
  }

  private fun wall(cx: Float, cz: Float, nx: Float, nz: Float) = WallPlane(Vector3(cx, 1.25f, cz), Vector3(nx, 0f, nz), 2f, 1.25f)

  @Test fun `depthRange uses the wall the ring is on`() {
    val walls = listOf(wall(0f, 3f, 0f, -1f), wall(2f, 0f, -1f, 0f))
    val eye = Vec3(0.0, 1.6, 0.0)
    val onFront = Vec3(0.5, 1.5, 3.0)
    val dx = onFront.x - eye.x
    val dy = onFront.y - eye.y
    val dz = onFront.z - eye.z
    assertEquals(Math.sqrt(dx * dx + dy * dy + dz * dz), depthRange(eye, onFront, walls)!!, 1e-6)
  }

  @Test fun `depthRange and the size warning for a print that came out smaller or larger`() {
    val walls = listOf(wall(0f, 3f, 0f, -1f))
    val eye = Vec3(0.0, 1.6, 0.0)
    val onWall = Vec3(0.5, 1.5, 3.0)
    val depth = Math.sqrt(0.5 * 0.5 + 0.1 * 0.1 + 3.0 * 3.0)
    // A print scaled by s reads 1/s as far by its size: behind the wall for 92%, in front of it for 105%.
    for ((scale, expected) in listOf(0.92 to "8% smaller", 1.05 to "5% larger")) {
      val measured = Vec3(eye.x + (onWall.x - eye.x) / scale, eye.y + (onWall.y - eye.y) / scale, eye.z + (onWall.z - eye.z) / scale)
      val range = depthRange(eye, measured, walls)!!
      assertEquals("x$scale", depth, range, 1e-9)
      val ellipse = depth / scale
      assertTrue("x$scale", sizeWarning(sizeRatio(ellipse, range))!!.contains(expected))
    }
  }

  @Test fun `depthRange ignores a wall far beyond a plausible print size`() {
    val walls = listOf(wall(0f, 3f, 0f, -1f))
    assertNull(depthRange(Vec3(0.0, 1.5, 0.0), Vec3(0.0, 1.5, 1.0), walls))
  }

  @Test fun `depthRange is null with no wall under the ring`() {
    assertNull(depthRange(Vec3(0.0, 1.6, 0.0), Vec3(0.5, 1.5, 1.0), listOf(wall(0f, 3f, 0f, -1f))))
  }

  // ── the flow ──

  private val sight = RingSight(Vec3(2.0, 1.4, -3.0), 90.0, 1.0)

  /** A head [distanceM] from the ring. */
  private fun head(distanceM: Double) = Vec3(sight.world.x, sight.world.y, sight.world.z + distanceM)

  private fun placed(): AlignFlow = AlignFlow("Ground floor", 0.0).also { it.onSteadyRing(sight) }

  @Test fun `starts looking at the ring and places the scene when it is steady and near`() {
    val f = AlignFlow("Ground floor", 0.0)
    assertEquals(AlignState.LookAtRing, f.state)
    f.onSteadyRing(sight.copy(distanceM = 1.6))
    assertEquals(AlignState.LookAtRing, f.state)
    f.onSteadyRing(sight)
    val s = f.state as AlignState.Placed
    assertEquals(8.0, markerInScene(s.root, sight.world, sight.headingDeg).x, 1e-9)
    assertEquals(1.4, markerInScene(s.root, sight.world, sight.headingDeg).y, 1e-9)
  }

  @Test fun `a later sighting refreshes the placed scene until the first nudge`() {
    val f = placed()
    val later = sight.copy(world = Vec3(2.01, 1.41, -3.0), headingDeg = 91.0)
    f.onSteadyRing(later)
    assertEquals(defaultRoot(later.world, later.headingDeg, 0.0, 1.41), (f.state as AlignState.Placed).root)
    f.nudge(0.01, 0.0, 0.0)
    val root = (f.state as AlignState.Placed).root
    f.onSteadyRing(sight)
    assertEquals(root, (f.state as AlignState.Placed).root)
    assertEquals(1.41, f.requestSave(head(1.0))!!.heightAboveFloorM, 1e-12)
  }

  @Test fun `nudging turns about the ring`() {
    val f = placed()
    val start = markerInScene((f.state as AlignState.Placed).root, sight.world, sight.headingDeg)
    f.nudge(0.0, 0.0, 5.0)
    val p = markerInScene((f.state as AlignState.Placed).root, sight.world, sight.headingDeg)
    assertEquals(8.0, p.x, 1e-9)
    assertEquals(-5.0, angleDiffDeg(p.headingDeg, start.headingDeg), 1e-9)
  }

  @Test fun `save beyond 1_5 m is refused and the scene stays adjustable`() {
    val f = placed()
    assertNull(f.requestSave(head(1.51)))
    assertEquals(AlignState.Refused("Step closer to the ARC to save"), f.state)
    f.nudge(0.01, 0.0, 0.0)
    assertTrue(f.state is AlignState.Placed)
    assertNotNull(f.requestSave(head(1.5)))
  }

  @Test fun `save gives the ring's scene pose and its height above the floor`() {
    val f = placed()
    f.nudge(0.0, 0.0, 10.0)
    val root = (f.state as AlignState.Placed).root
    val req = f.requestSave(head(1.0))!!
    assertEquals(AlignState.Saving, f.state)
    assertEquals(markerInScene(root, sight.world, sight.headingDeg), req.pose)
    assertEquals(1.4, req.heightAboveFloorM, 1e-12)
  }

  @Test fun `save before the scene is placed gives nothing`() {
    assertNull(AlignFlow("Ground floor", 0.0).requestSave(head(1.0)))
  }

  @Test fun `a saved answer carries its warnings as copy`() {
    val f = AlignFlow("Mezzanine", 3.5).also { it.onSteadyRing(sight) }
    f.requestSave(head(1.0))
    f.saved(BuilderCall.Ok(listOf("floor_height_off", "something_new")))
    assertEquals(AlignState.Saved(listOf("floor_height_off", "something_new")), f.state)
    assertEquals(listOf("Floor height doesn't match Mezzanine (3.5 m): check the floor"), f.warningLines())
  }

  @Test fun `a failed save is refused with a reason and can be tried again`() {
    val f = placed()
    f.requestSave(head(1.0))
    f.saved(BuilderCall.NoAccess)
    assertEquals(AlignState.Refused("This account can't edit this scene"), f.state)
    assertNotNull(f.requestSave(head(1.0)))
    f.saved(BuilderCall.Offline)
    assertTrue((f.state as AlignState.Refused).reason.isNotEmpty())
  }

  @Test fun `the size check runs once per alignment`() {
    val f = placed()
    assertNull(f.sizeMessage)
    f.checkSize(1.087, 1.0)
    assertEquals("This ARC looks about 8% smaller than its recorded size: was it printed at 100%?", f.sizeMessage)
    f.checkSize(1.0, 1.0)
    assertNotNull(f.sizeMessage)
  }

  @Test fun `the size check with no depth range is skipped but not spent`() {
    val f = placed()
    f.checkSize(1.0, null)
    f.checkSize(1.087, 1.0)
    assertNotNull(f.sizeMessage)
  }

  // ── the sticks ──

  @Test fun `stick steps are 1 cm and half a degree with the grip held`() {
    val s = stickNudge(0.0, 1.0, 1.0, 0.0, fine = true)
    assertEquals(0.0, s.dx, 1e-12)
    assertEquals(0.01, s.dz, 1e-12)
    assertEquals(0.5, s.dYawDeg, 1e-12)
  }

  @Test fun `left stick moves relative to where the head faces`() {
    // Facing +x (heading 90°): forward is +x, right is -z.
    val fwd = stickNudge(0.0, 1.0, 0.0, 90.0, fine = true)
    assertEquals(0.01, fwd.dx, 1e-12)
    assertEquals(0.0, fwd.dz, 1e-12)
    val right = stickNudge(1.0, 0.0, 0.0, 90.0, fine = true)
    assertEquals(0.0, right.dx, 1e-12)
    assertEquals(-0.01, right.dz, 1e-12)
  }

  @Test fun `a stick near the middle does nothing`() {
    assertEquals(StickNudge(0.0, 0.0, 0.0), stickNudge(0.2, -0.2, 0.3, 0.0, fine = false))
  }
}
