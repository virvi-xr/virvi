package io.virvi.ar.visitor

import io.virvi.ar.Vec3
import io.virvi.ar.api.ArSpace
import io.virvi.ar.space.RootPose
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HintTextTest {
  private val space = ArSpace("sp", "Cafe", null, true, emptyList())
  private val locking = VisitorState.Locking(space)

  @Test fun `the visitor copy word for word`() {
    assertEquals("Look for an ARC like this, at eye level near the entrance.", hintText(VisitorState.Hint))
    assertEquals("Step closer to the ARC", hintText(VisitorState.StepCloser))
    assertEquals("Opening Cafe…", hintText(VisitorState.Loading("ABC", "Cafe")))
    assertEquals("Opening…", hintText(VisitorState.Loading("ABC", null)))
    assertEquals("Hold still…", hintText(locking, GatherStatus.GATHERING))
    assertEquals("This space isn't set up yet", hintText(VisitorState.NotSetUp("Cafe")))
    assertEquals(VisitorCopy.OFFLINE, hintText(VisitorState.Failed(VisitorCopy.OFFLINE)))
  }

  @Test fun `the new device and wall copy`() {
    assertEquals(
        "Set up your space on this headset first: Settings → Physical space → Space setup.",
        VisitorCopy.NO_ROOM_SCAN,
    )
    assertEquals(
        "Virvi AR needs camera access to find ARCs. Allow it in Settings → Apps → Virvi AR.",
        VisitorCopy.NO_CAMERA,
    )
    assertEquals(
        "Virvi AR needs spatial data access to line spaces up with the room. Allow it in Settings → Apps → Virvi AR.",
        VisitorCopy.NO_SPATIAL_DATA,
    )
    assertEquals(
        "Can't see the wall behind this ARC. Look around the room so the headset can map it.",
        VisitorCopy.NO_WALL,
    )
  }

  @Test fun `a ring seen too steeply says stand in front`() {
    assertEquals("Stand in front of the ARC", VisitorCopy.STAND_IN_FRONT)
    assertEquals("Look at the ARC again", VisitorCopy.LOOK_AGAIN)
    assertEquals("Look at the ARC when you get there", VisitorCopy.LOOK_AT_RING)
    assertEquals(VisitorCopy.STAND_IN_FRONT, lockingHint(GatherStatus.TOO_STEEP, 0))
    assertEquals(VisitorCopy.STAND_IN_FRONT, hintText(locking, GatherStatus.TOO_STEEP))
  }

  @Test fun `locking says hold still only while a ring is being gathered`() {
    assertEquals(VisitorCopy.HINT, lockingHint(GatherStatus.NONE_IN_VIEW, 0))
    assertEquals(VisitorCopy.HOLD_STILL, lockingHint(GatherStatus.GATHERING, 0))
    assertEquals(VisitorCopy.TOO_FAR, lockingHint(GatherStatus.TOO_FAR, 0))
    assertEquals(VisitorCopy.HINT, lockingHint(GatherStatus.UNREADABLE, VisitorTuning.UNREADABLE_HINT_MS - 1))
    assertEquals(VisitorCopy.TOO_FAR, lockingHint(GatherStatus.UNREADABLE, VisitorTuning.UNREADABLE_HINT_MS))
    assertEquals(VisitorCopy.NO_WALL, lockingHint(GatherStatus.NO_WALL, 0))
  }

  @Test fun `the hint card while locking follows the gather status`() {
    assertEquals(VisitorCopy.HINT, hintText(locking))
    assertEquals(VisitorCopy.HINT, hintText(locking, GatherStatus.NONE_IN_VIEW))
    assertEquals(VisitorCopy.TOO_FAR, hintText(locking, GatherStatus.TOO_FAR))
    assertEquals(VisitorCopy.TOO_FAR, hintText(locking, GatherStatus.UNREADABLE, 2_000))
    assertEquals(VisitorCopy.NO_WALL, hintText(locking, GatherStatus.NO_WALL))
  }

  @Test fun `the gather status only matters while locking`() {
    assertEquals(VisitorCopy.HINT, hintText(VisitorState.Hint, GatherStatus.TOO_FAR))
    assertEquals(VisitorCopy.NOT_SET_UP, hintText(VisitorState.NotSetUp("Cafe"), GatherStatus.NO_WALL))
  }

  @Test fun `a device problem comes first, camera before room scan`() {
    for (st in listOf(VisitorState.Hint, VisitorState.StepCloser, VisitorState.Loading("ABC", "Cafe"), locking, VisitorState.Failed(VisitorCopy.OFFLINE))) {
      assertEquals(VisitorCopy.NO_CAMERA, hintText(st, GatherStatus.GATHERING, 0, DeviceProblem.NO_CAMERA_PERMISSION))
      assertEquals(VisitorCopy.NO_ROOM_SCAN, hintText(st, GatherStatus.GATHERING, 0, DeviceProblem.NO_ROOM_SCAN))
      assertEquals(VisitorCopy.NO_SPATIAL_DATA, hintText(st, GatherStatus.GATHERING, 0, DeviceProblem.NO_SPATIAL_PERMISSION))
    }
  }

  @Test fun `while the permission dialogs are up the hint says why, before any other problem`() {
    for (st in listOf(VisitorState.Hint, VisitorState.StepCloser, VisitorState.Loading("ABC", "Cafe"), locking, VisitorState.Failed(VisitorCopy.OFFLINE))) {
      assertEquals(VisitorCopy.PERMISSION_RATIONALE, hintText(st, GatherStatus.GATHERING, 0, DeviceProblem.ASKING_PERMISSIONS))
    }
  }

  @Test fun `the rationale wording is the same as the string resources`() {
    val xml = java.io.File("src/main/res/values/strings.xml").readText().replace("\\'", "'")
    assertEquals(
        "Virvi AR looks for ARCs through the headset's cameras to line a space up with the room. Camera images stay on the headset.",
        VisitorCopy.PERMISSION_RATIONALE_CAMERA,
    )
    assertTrue(xml.contains(">${VisitorCopy.PERMISSION_RATIONALE_CAMERA}<"))
    assertTrue(xml.contains(">${VisitorCopy.PERMISSION_RATIONALE_SPATIAL}<"))
  }

  @Test fun `no card while the scene is shown`() {
    val shown = VisitorState.Shown(space, RootPose(Vec3(0.0, 0.0, 0.0), 0.0))
    assertNull(hintText(shown))
    assertNull(hintText(shown, GatherStatus.NO_WALL, 0, DeviceProblem.NO_ROOM_SCAN))
  }

  @Test fun `the menu button shows whenever a space is up, never on the plain hint`() {
    val shown = VisitorState.Shown(space, RootPose(Vec3(0.0, 0.0, 0.0), 0.0))
    assertEquals(true, menuButtonShown(shown, true))
    assertEquals(true, menuButtonShown(locking, true))
    assertEquals(true, menuButtonShown(VisitorState.NotSetUp("Cafe"), true))
    assertEquals(true, menuButtonShown(VisitorState.Failed(VisitorCopy.OFFLINE), true))
    assertEquals(false, menuButtonShown(VisitorState.Failed(VisitorCopy.NOT_OPEN), false))
    assertEquals(false, menuButtonShown(VisitorState.Hint, false))
    assertEquals(false, menuButtonShown(VisitorState.StepCloser, false))
  }
}
