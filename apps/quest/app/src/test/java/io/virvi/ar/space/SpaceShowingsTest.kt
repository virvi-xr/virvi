package io.virvi.ar.space

import io.virvi.ar.ProgrammeItem
import io.virvi.ar.RenderItem
import io.virvi.ar.ScheduledPlay
import io.virvi.ar.ShowingInstance
import io.virvi.ar.Vec3
import io.virvi.ar.api.ArFeedSnapshot
import io.virvi.ar.api.ArSpace
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

/** A space with a Schedule-mode screen: its picture follows the server's clock (LIV-87). */
class SpaceShowingsTest {
  private val t0 = 1_800_000_000_000L
  private var now = 1_000L // the frame clock (fades)
  private var wall = t0 - 30_000 // the headset's own wall clock, 30 s before the show
  private var onSnapshot: (ArFeedSnapshot) -> Unit = {}

  private class View : SceneView {
    val applied = mutableListOf<List<RenderItem>>()
    var offset: Long? = null
    override fun apply(next: List<RenderItem>) { applied += next }
    override fun setRoot(pose: RootPose) {}
    override fun setVisible(on: Boolean, nowMs: Long) {}
    override fun hideNow() {}
    override fun clear() {}
    override fun tick(nowMs: Long) {}
    override fun count(): Int = applied.lastOrNull()?.size ?: 0
    override fun setServerOffset(offsetMs: Long) { offset = offsetMs }
  }

  private class Outline : OutlineView {
    override fun flash(world: Vec3, headingDeg: Double, diameterM: Double, nowMs: Long) {}
    override fun tick(nowMs: Long) {}
    override fun clear() {}
  }

  private val view = View()
  private val session =
      SpaceSession(view, { _, snap -> onSnapshot = snap; object : SpaceFeed {
        override fun start(spaceId: String, token: (() -> String?)?) {}
        override fun stop() {}
      } }, Outline(), { now }, wallClock = { wall })

  private val scene =
      Json.parseToJsonElement("""{"videos":[{"sk":"tv","offType":6,"offImageSrc":"https://x/poster.png","instances":[{"sk":"i1"}]}]}""").jsonObject
  private val film = ShowingInstance("s1", t0, listOf(ProgrammeItem("https://x/film.mp4", 600.0, "video")), "Film")

  @Test
  fun `the screen switches from the holding image to the film when the server says the show starts`() {
    session.start("sp1")
    // The server's clock is 20 s ahead of the headset's: the show starts in 10 s of the headset's time
    onSnapshot(ArFeedSnapshot("1", ArSpace("sp1", "Loft", null, true, emptyList()), scene, mapOf("tv" to listOf(film)), serverTime = wall + 20_000))
    assertEquals(20_000L, view.offset)
    assertEquals(RenderItem.Kind.IMAGE, view.applied.last().single().kind)

    // Frames before the start change nothing
    wall += 5_000
    session.tick()
    assertEquals(1, view.applied.size)

    wall += 6_000
    session.tick()
    val playing = view.applied.last().single()
    assertEquals(RenderItem.Kind.VIDEO, playing.kind)
    assertEquals(ScheduledPlay(t0, 600.0), playing.play)
    session.tick()
    assertEquals(2, view.applied.size)

    // After the film, back to the poster
    wall += 600_000
    session.tick()
    assertEquals(RenderItem.Kind.IMAGE, view.applied.last().single().kind)
  }
}
