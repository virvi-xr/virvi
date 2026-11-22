package io.virvi.ar.ring

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CameraStatusTest {
  @Test
  fun cameraStatusText() {
    assertEquals("Camera permission denied: ARC detection is off", cameraStatusText(CameraStatus.NO_PERMISSION))
    assertEquals("Camera running: look at a printed ARC", cameraStatusText(CameraStatus.RUNNING))
    assertEquals(
        "No passthrough camera found (needs Quest 3/3S, Horizon OS v74+)",
        cameraStatusText(CameraStatus.NO_CAMERA),
    )
    CameraStatus.values().forEach { assertTrue(it.name, cameraStatusText(it).isNotBlank()) }
  }

  @Test
  fun failureStreakReportsOnceAtTheLimit() {
    val f = FailureStreak(3)
    assertEquals(listOf(false, false, true, false), List(4) { f.fail() })
    f.succeed()
    assertEquals(listOf(false, false, true), List(3) { f.fail() })
    f.succeed()
    f.fail()
    f.succeed()
    assertEquals(listOf(false, false, true), List(3) { f.fail() })
  }
}
