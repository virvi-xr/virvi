package io.virvi.ar.visitor

import com.meta.spatial.core.Pose
import com.meta.spatial.core.Vector3
import io.virvi.ar.AppState
import io.virvi.ar.RenderItem
import io.virvi.ar.Vec3
import io.virvi.ar.api.AnalyticsPost
import io.virvi.ar.api.ApiResult
import io.virvi.ar.api.ArFeedSnapshot
import io.virvi.ar.api.ArFloor
import io.virvi.ar.api.ArMarker
import io.virvi.ar.api.ArSpace
import io.virvi.ar.api.FeedStatus
import io.virvi.ar.api.MarkerLookup
import io.virvi.ar.api.ReportResult
import io.virvi.ar.api.MarkerPose
import io.virvi.ar.api.VisitAnalytics
import io.virvi.ar.ring.CameraIntrinsics
import io.virvi.ar.ring.RingCodec
import io.virvi.ar.ring.RingDetection
import io.virvi.ar.ring.WallPlane
import io.virvi.ar.space.OutlineView
import io.virvi.ar.space.RootPose
import io.virvi.ar.space.SceneView
import io.virvi.ar.space.SpaceFeed
import io.virvi.ar.space.SpaceSession
import io.virvi.ar.space.rootFromMarker
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The visitor controller with the space session's scene, feed and outline faked, and coroutines run by hand. */
class VisitorControllerTest {
  /** Runs coroutines only when [drain] is called, as the main thread would after the current frame. */
  private class QueueDispatcher : CoroutineDispatcher() {
    val tasks = ArrayDeque<Runnable>()

    override fun dispatch(context: CoroutineContext, block: Runnable) {
      tasks.addLast(block)
    }

    fun drain() {
      while (tasks.isNotEmpty()) tasks.removeFirst().run()
    }
  }

  private class FakeView : SceneView {
    val calls = mutableListOf<String>()
    var placed: RootPose? = null
    private var items = 0

    override fun apply(next: List<RenderItem>) {
      calls += "apply"
      items = next.size
    }

    override fun setRoot(pose: RootPose) {
      calls += "setRoot"
      placed = pose
    }

    override fun setVisible(on: Boolean, nowMs: Long) {
      calls += if (on) "show" else "hide"
    }

    override fun hideNow() {
      calls += "hideNow"
    }

    override fun clear() {
      calls += "clear"
      items = 0
    }

    override fun tick(nowMs: Long) {}

    override fun count() = items
  }

  private class FakeFeed(val onStatus: (FeedStatus) -> Unit, val onSnapshot: (ArFeedSnapshot) -> Unit) : SpaceFeed {
    val started = mutableListOf<String>()
    var stops = 0

    override fun start(spaceId: String, token: (() -> String?)?) {
      started += spaceId
      onStatus(FeedStatus.CONNECTING)
    }

    override fun stop() {
      stops++
    }
  }

  private class FakeOutline : OutlineView {
    var flashes = 0

    override fun flash(world: Vec3, headingDeg: Double, diameterM: Double, nowMs: Long) {
      flashes++
    }

    override fun tick(nowMs: Long) {}

    override fun clear() {}
  }

  private class FakePrefs : VisitorPrefs {
    override val keepLoadedBetweenVisitors = false
    override var recentSpaces: List<RecentSpace> = emptyList()
  }

  private val ring = 0x1D2C3B4AL
  private val code = RingCodec.codeOf(ring)
  private val saved = MarkerPose(1.0, 1.5, 2.0, 90.0)
  private val space = ArSpace("sp-a", "Cafe", null, true, listOf(ArFloor("f1", "Ground", 0.0, 0, listOf(ArMarker("m1", ring, code, 140.0, null, saved)))))

  private var now = 1_000_000L
  private var nowNs = 5_000_000_000L
  private val dispatcher = QueueDispatcher()
  private val scope = CoroutineScope(dispatcher + Job())
  private val view = FakeView()
  private val outline = FakeOutline()
  private lateinit var feed: FakeFeed
  private val session =
      SpaceSession(view, { onStatus, onSnapshot -> FakeFeed(onStatus, onSnapshot).also { feed = it } }, outline, { now })
  private val posted = mutableListOf<Pair<String, String>>()
  private val analytics = VisitAnalytics({ id, body -> posted += id to body; AnalyticsPost.Sent }, { 1_700_000_000_000L })
  private val ui = AppState()
  private val reports = mutableListOf<Pair<String, String>>()
  private var reportAnswer = ReportResult.Sent
  private val lookups = mutableListOf<String>()
  private val controller =
      VisitorController(
          scope,
          session,
          lookup = { c ->
            lookups += c
            ApiResult.Ok(MarkerLookup("sp-a", "f1", "m1", "Cafe", null))
          },
          analytics = analytics,
          report = { id, reason ->
            reports += id to reason
            reportAnswer
          },
          prefs = FakePrefs(),
          ui = ui,
          setRegistered = {},
          clock = { now },
          nanoClock = { nowNs },
      )

  // The camera at the head, looking along +z; the ring 1 m ahead, head-on, on a wall facing back at the head.
  private val k = CameraIntrinsics(867.0, 867.0, 640.0, 480.0, FloatArray(0), FloatArray(0))
  private val head = Pose(Vector3(0f, 1.6f, 0f))
  private val walls = listOf(WallPlane(Vector3(0f, 1.6f, 1f), Vector3(0f, 0f, -1f), 2f, 1.5f))
  private val seen = RingDetection(ring, 0, 0, 640.0, 480.0, 867.0 * 0.07 / 1.0, 867.0 * 0.07 / 1.0, 0.0, 0.0)

  @After fun tearDown() = scope.cancel()

  /** One frame (16 ms on) with a new camera frame of [rings] seen from [at]. */
  private fun frame(rings: List<RingDetection> = listOf(seen), at: Pose = head) {
    now += 16
    nowNs += 16_000_000
    controller.tick(at, CameraRings(rings, rings.lastOrNull(), false, nowNs), k, walls)
  }

  private fun toShown() {
    frame() // agreed: looked up
    dispatcher.drain() // the lookup answers and the feed starts
    assertEquals(listOf(code), lookups)
    assertEquals(listOf("sp-a"), feed.started)
    feed.onSnapshot(ArFeedSnapshot("1", space, null))
    repeat(VisitorTuning.MIN_FRAMES) { frame() }
    assertTrue(ui.sceneShown)
  }

  @Test fun `the menu is reachable from the scanner, and Look again only once a space is up`() {
    frame()
    assertNotNull(ui.hint)
    assertTrue("sign-in is reachable with hands before any scan", ui.menuButtonShown)
    assertFalse("nothing to look at again yet", ui.lookAgainShown)
    toShown()
    assertTrue(ui.menuButtonShown)
    assertTrue(ui.lookAgainShown)
  }

  @Test fun `showing the scene places it, then fades it in`() {
    toShown()
    val setRoot = view.calls.indexOf("setRoot")
    assertTrue(view.calls.toString(), setRoot >= 0 && view.calls.indexOf("show") > setRoot)
    val root = rootFromMarker(Vec3(0.0, 1.6, 1.0), 180.0, saved)
    assertEquals(root.yawDeg, view.placed!!.yawDeg, 1e-4)
    assertEquals(root.position.x, view.placed!!.position.x, 1e-4)
    assertEquals(root.position.z, view.placed!!.position.z, 1e-4)
    assertEquals(view.placed, session.rootOf())
    assertEquals(1, outline.flashes)
  }

  @Test fun `a report names the space now up and tells the menu how it went`() {
    controller.reportSpace("spam") // nothing chosen yet
    dispatcher.drain()
    assertTrue(reports.isEmpty())
    assertNull(ui.reportSpaceId)
    toShown()
    assertEquals("sp-a", ui.reportSpaceId)
    controller.reportSpace("spam")
    dispatcher.drain()
    assertEquals(listOf("sp-a" to "spam"), reports)
    assertEquals(VisitorCopy.REPORT_SENT, ui.menuNote)
    reportAnswer = ReportResult.RateLimited
    controller.reportSpace("other")
    dispatcher.drain()
    assertEquals(VisitorCopy.REPORT_RATE_LIMITED, ui.menuNote)
    reportAnswer = ReportResult.Failed
    controller.reportSpace("other")
    dispatcher.drain()
    assertEquals(VisitorCopy.REPORT_FAILED, ui.menuNote)
    controller.lookAgain()
    dispatcher.drain()
    assertNull(ui.reportSpaceId)
  }

  @Test fun `a tracking jump hides the scene at once`() {
    toShown()
    view.calls.clear()
    frame(emptyList(), Pose(Vector3(1f, 1.6f, 0f))) // 1 m in 16 ms
    assertEquals(listOf("hideNow"), view.calls)
    assertFalse(ui.sceneShown)
    assertNull(session.rootOf())
  }

  @Test fun `looking again stops the feed and clears the scene`() {
    toShown()
    controller.lookAgain()
    assertEquals(1, feed.stops)
    assertTrue("clear" in view.calls)
    assertNull(ui.feed)
    assertNull(session.spaceId)
    assertNull(session.snapshot())
  }

  @Test fun `a visit is entered when shown and left when the space is forgotten`() {
    toShown()
    dispatcher.drain()
    assertTrue(posted.isEmpty()) // nothing is sent before the flush interval
    controller.lookAgain()
    dispatcher.drain() // the visit's end is sent at once
    assertEquals(listOf("sp-a"), posted.map { it.first })
    val body = posted.single().second
    assertTrue(body, "\"type\":\"enter\"" in body)
    assertTrue(body, "\"type\":\"leave\"" in body)
  }

  @Test fun `the headset coming off ends the visit`() {
    toShown()
    controller.headsetOff()
    dispatcher.drain()
    assertTrue("\"type\":\"leave\"" in posted.single().second)
    assertTrue("hideNow" in view.calls)
  }

  private val moved = MarkerPose(1.2, 1.5, 2.0, 80.0)
  private val movedSpace =
      space.copy(floors = listOf(space.floors[0].copy(markers = listOf(space.floors[0].markers[0].copy(pose = moved)))))

  @Test fun `a snapshot that moves the anchor ring re-anchors the scene from the ring in view`() {
    toShown()
    view.calls.clear()
    feed.onSnapshot(ArFeedSnapshot("2", movedSpace, null))
    assertEquals(listOf("apply", "setRoot"), view.calls)
    val root = rootFromMarker(Vec3(0.0, 1.6, 1.0), 180.0, moved)
    assertEquals(root.yawDeg, view.placed!!.yawDeg, 1e-4)
    assertEquals(root.position.x, view.placed!!.position.x, 1e-4)
    assertEquals(root.position.z, view.placed!!.position.z, 1e-4)
    assertTrue(ui.sceneShown)
  }

  @Test fun `a snapshot that moves the anchor ring out of view hides the scene at once`() {
    toShown()
    frame(emptyList()) // the ring has left view
    view.calls.clear()
    feed.onSnapshot(ArFeedSnapshot("2", movedSpace, null))
    assertEquals(listOf("apply", "hideNow"), view.calls)
    assertFalse(ui.sceneShown)
  }
}
