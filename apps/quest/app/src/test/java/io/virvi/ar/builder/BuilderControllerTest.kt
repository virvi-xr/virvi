package io.virvi.ar.builder

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
import io.virvi.ar.api.BuilderCall
import io.virvi.ar.api.DeviceKind
import io.virvi.ar.api.DeviceMarker
import io.virvi.ar.api.DeviceSpace
import io.virvi.ar.api.FeedStatus
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
import io.virvi.ar.visitor.CameraRings
import io.virvi.ar.visitor.RecentSpace
import io.virvi.ar.visitor.VisitorController
import io.virvi.ar.visitor.VisitorCopy
import io.virvi.ar.visitor.VisitorPrefs
import io.virvi.ar.visitor.VisitorTuning
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private fun json(s: String): JsonObject = Json.parseToJsonElement(s).jsonObject

/**
 * Builder mode end to end with the headset faked: the space session's scene, feed and outline, the pairing, the
 * builder's calls, the renderer's builder side and the pointer tools. Visitor mode is the real controller on the same
 * session, so leaving builder mode is checked where visitors see it. Coroutines run by hand ([drain]).
 */
class BuilderControllerTest {
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
    var items = 0

    override fun apply(next: List<RenderItem>) {
      items = next.size
    }

    override fun setRoot(pose: RootPose) {
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

  /** Each start as (space, the token its requests would carry). */
  private class FakeFeed(val onStatus: (FeedStatus) -> Unit, val onSnapshot: (ArFeedSnapshot) -> Unit) : SpaceFeed {
    val started = mutableListOf<Pair<String, String?>>()
    var stops = 0

    override fun start(spaceId: String, token: (() -> String?)?) {
      started += spaceId to token?.invoke()
      onStatus(FeedStatus.CONNECTING)
    }

    override fun stop() {
      stops++
    }
  }

  private class FakeOutline : OutlineView {
    override fun flash(world: Vec3, headingDeg: Double, diameterM: Double, nowMs: Long) {}

    override fun tick(nowMs: Long) {}

    override fun clear() {}
  }

  private class FakePrefs : VisitorPrefs {
    override val keepLoadedBetweenVisitors = false
    override var recentSpaces: List<RecentSpace> = emptyList()
  }

  /** Pairing as DeviceAuth does it: Pairing while it polls, then Paired as [approveAs], or SignedOut if cancelled. */
  private class FakeAuth(start: AuthState = AuthState.SignedOut) : BuilderAuth {
    override val state = MutableStateFlow(start)
    var approveAs: DeviceKind? = null
    var spacesAnswer: BuilderCall<List<DeviceSpace>> = BuilderCall.Ok(emptyList())
    var pairings = 0
    var ends = 0
    var unpairs = 0
    val passesFor = mutableListOf<String>()
    var passAnswer: PassResult? = null
    var passThrows = false

    fun pair(kind: DeviceKind) {
      state.value = AuthState.Paired("dev1", kind)
    }

    override suspend fun beginPairing() {
      pairings++
      state.value = AuthState.Pairing("ABC123", "https://virvi.io/pair/headset/ABC123", Long.MAX_VALUE)
      try {
        val kind = approveAs ?: awaitCancellation()
        state.value = AuthState.Paired("dev1", kind)
      } finally {
        if (state.value !is AuthState.Paired) state.value = AuthState.SignedOut
      }
    }

    override suspend fun spaces() = spacesAnswer

    override suspend fun passFor(spaceId: String): PassResult {
      passesFor += spaceId
      if (passThrows) throw IllegalStateException("boom")
      passAnswer?.let { return it }
      return if (state.value is AuthState.Paired) PassResult.Ok("jwt", "sc1") else PassResult.Revoked
    }

    override suspend fun endSession() {
      ends++
      if ((state.value as? AuthState.Paired)?.kind == DeviceKind.SHARED) state.value = AuthState.SignedOut
    }

    override suspend fun unpair() {
      unpairs++
      state.value = AuthState.SignedOut
    }
  }

  private class FakeRemote : BuilderRemote {
    val sent = mutableListOf<String>()

    override suspend fun draft(sk: String, element: String, t: ItemTransform): BuilderCall<DraftAnswer> {
      sent += "draft $sk"
      return BuilderCall.Ok(DraftAnswer.Ok)
    }

    override suspend fun endDraft(sk: String, saved: Boolean): BuilderCall<Unit> {
      sent += "end $sk $saved"
      return BuilderCall.Ok(Unit)
    }

    override suspend fun updateInstance(sk: String, t: ItemTransform): BuilderCall<Unit> {
      sent += "update $sk"
      return BuilderCall.Ok(Unit)
    }

    override suspend fun putAdjustment(sk: String, a: Adjustment) = BuilderCall.Ok(Unit)

    override suspend fun deleteAdjustment(sk: String) = BuilderCall.Ok(Unit)
  }

  private class FakeCalls : BuilderSpaceCalls {
    override val editor = FakeRemote()
    val poses = mutableListOf<Pair<String, MarkerPose>>()
    val placed = mutableListOf<Triple<String, LibraryEntry, ItemTransform>>()

    override suspend fun scene(sceneId: String) =
        BuilderCall.Ok(
            json(
                """{"scene":{"id":"$sceneId","activePresetId":"pr1","presets":[{"id":"pr1","name":"Main","elements":[
                  {"id":"v1","type":"video","name":"Big screen","properties":{"offType":1,"enableLiveStream":true,"liveSrc":"https://live/old.m3u8"}}]}]}}"""
            )
        )

    val cleared = mutableListOf<String>()

    override suspend fun clearCopies(elementId: String): BuilderCall<Int> {
      cleared += elementId
      return BuilderCall.Ok(2)
    }

    val puts = mutableListOf<Pair<String, JsonObject>>()
    val lives = mutableListOf<Pair<String, Boolean>>()

    override suspend fun streams(sceneId: String) =
        BuilderCall.Ok(json("""{"streams":[{"id":"s1","name":"Main Stage","hlsPlaylistUrl":"https://live/main.m3u8","live":true,"mine":false}]}"""))

    override suspend fun putProperties(elementId: String, properties: JsonObject): BuilderCall<Unit> {
      puts += elementId to properties
      return BuilderCall.Ok(Unit)
    }

    override suspend fun setLive(elementId: String, on: Boolean): BuilderCall<Unit> {
      lives += elementId to on
      return BuilderCall.Ok(Unit)
    }

    override suspend fun sceneSpaces(sceneId: String) = BuilderCall.Ok(listOf(SpaceName("sp-a", "Cafe"), SpaceName("sp-x", "Gallery")))

    override suspend fun library(sceneId: String) =
        BuilderCall.Ok(
            json("""{"items":[{"id":"lib1","kind":"media","name":"Flyer","url":"https://x/flyer.png","contentType":"image/png","status":"ready"}]}""")
        )

    override suspend fun place(presetId: String, entry: LibraryEntry, t: ItemTransform): BuilderCall<PlacedItem> {
      placed += Triple(presetId, entry, t)
      return BuilderCall.Ok(PlacedItem("el9", "in9"))
    }

    override suspend fun savePose(markerId: String, pose: MarkerPose, heightAboveFloorM: Double): BuilderCall<List<String>> {
      poses += markerId to pose
      return BuilderCall.Ok(emptyList())
    }
  }

  private class FakeScene : BuilderScene {
    override var builderMode = false
    var shown: Map<String, ItemTransform> = emptyMap()

    override fun setOverrides(next: Map<String, ItemTransform>) {
      shown = next
    }
  }

  private class FakeTools : BuilderTools {
    var editor: BuilderEditor? = null
    var ticks = 0

    override fun start(editor: BuilderEditor, root: () -> RootPose?) {
      this.editor = editor
    }

    override fun tick() {
      ticks++
    }

    override fun stop() {
      editor = null
    }
  }

  private val ring = 0x1D2C3B4AL
  private val code = RingCodec.codeOf(ring)
  private val otherRing = 0x2E3D4C5BL
  private val saved = MarkerPose(1.0, 1.5, 2.0, 90.0)

  private fun arSpace(pose: MarkerPose? = saved) =
      ArSpace("sp-a", "Cafe", null, true, listOf(ArFloor("f1", "Ground", 0.0, 0, listOf(ArMarker("m1", ring, code, 140.0, null, pose)))))

  private val spaceA = DeviceSpace("sp-a", "Cafe", "sc1", "Cafe scene", listOf(DeviceMarker("m1", "f1", code)))
  private val spaceB = DeviceSpace("sp-b", "Gallery", "sc2", "Gallery scene", listOf(DeviceMarker("m7", "f7", RingCodec.codeOf(otherRing))))

  private val poster =
      """{"sk":"el1","name":"Poster","textureSrc":"https://x/p.png","instances":[
        {"sk":"in1","position":{"x":1,"y":1.5,"z":2},"rotation":{"x":0,"y":0,"z":0},"scale":{"x":1,"y":1,"z":1}}]}"""
  private val flyer =
      """{"sk":"el9","name":"Flyer","textureSrc":"https://x/flyer.png","instances":[
        {"sk":"in9","position":{"x":0,"y":1.6,"z":1},"rotation":{"x":0,"y":180,"z":0},"scale":{"x":1,"y":1,"z":1}}]}"""

  private var now = 1_000_000L
  private var nowNs = 5_000_000_000L
  private val dispatcher = QueueDispatcher()
  private val scope = CoroutineScope(dispatcher + Job())
  private val view = FakeView()
  private lateinit var feed: FakeFeed
  private val session = SpaceSession(view, { onStatus, onSnapshot -> FakeFeed(onStatus, onSnapshot).also { feed = it } }, FakeOutline(), { now })
  private val ui = AppState()
  private val posted = mutableListOf<String>()
  private val visitor =
      VisitorController(
          scope,
          session,
          lookup = { ApiResult.NotFound },
          analytics = VisitAnalytics({ _, body -> posted += body; AnalyticsPost.Sent }, { 1_700_000_000_000L }),
          prefs = FakePrefs(),
          ui = ui,
          setRegistered = {},
          clock = { now },
          nanoClock = { nowNs },
      )
  private val auth = FakeAuth()
  private val calls = mutableMapOf<String, FakeCalls>()
  private val scene = FakeScene()
  private val tools = FakeTools()
  private val builder =
      BuilderController(
          scope,
          session,
          auth,
          calls = { id -> calls.getOrPut(id) { FakeCalls() } },
          visitor = visitor,
          scene = scene,
          tools = tools,
          ui = ui,
          clock = { now },
          nanoClock = { nowNs },
      )

  // The camera at the head, looking along +z; the ring 1 m ahead, head-on, on a wall facing back at the head.
  private val k = CameraIntrinsics(867.0, 867.0, 640.0, 480.0, FloatArray(0), FloatArray(0))
  private var head = Pose(Vector3(0f, 1.6f, 0f))
  private val walls = listOf(WallPlane(Vector3(0f, 1.6f, 1f), Vector3(0f, 0f, -1f), 2f, 1.5f))
  private val seen = RingDetection(ring, 0, 0, 640.0, 480.0, 867.0 * 0.07 / 1.0, 867.0 * 0.07 / 1.0, 0.0, 0.0)
  private val ringWorld = Vec3(0.0, 1.6, 1.0)

  @After fun tearDown() = scope.cancel()

  private fun sceneOf(vararg images: String) = json("""{"images":[${images.joinToString(",")}]}""")

  /** One frame (16 ms on) with a new camera frame of [rings], ticked as MainActivity does. */
  private fun frame(rings: List<RingDetection> = listOf(seen), sticks: AlignSticks = AlignSticks()) {
    now += 16
    nowNs += 16_000_000
    val r = CameraRings(rings, rings.lastOrNull(), false, nowNs)
    if (!builder.tick(head, r, k, walls, { sticks })) visitor.tick(head, r, k, walls)
    dispatcher.drain()
  }

  private fun steady() = repeat(VisitorTuning.MIN_FRAMES + 1) { frame() }

  private fun snapshot(v: String, space: ArSpace = arSpace(), scene: JsonObject? = sceneOf(poster)) {
    feed.onSnapshot(ArFeedSnapshot(v, space, scene))
    dispatcher.drain()
  }

  /** Paired as [kind], with a ring of sp-a in view: Builder enters sp-a and places it from the ring. */
  private fun toBuilding(kind: DeviceKind = DeviceKind.PERSONAL, space: ArSpace = arSpace()) {
    auth.pair(kind)
    auth.spacesAnswer = BuilderCall.Ok(listOf(spaceB, spaceA))
    frame()
    builder.open()
    dispatcher.drain()
    snapshot("1", space)
    steady()
  }

  @Test fun `entering with a ring in view opens that ring's space with its pass, then places it from the ring`() {
    toBuilding()
    assertEquals("sp-a" to "jwt", feed.started.last())
    assertTrue(ui.builderActive)
    assertNull(ui.hint) // visitor mode is paused
    assertNull(ui.builderPrompt) // no pick list
    val hud = ui.hud!!
    assertEquals(BUILDER_BANNER, hud.banner)
    assertEquals(listOf("Poster"), hud.rows.map { it.name })
    assertEquals(listOf("This scene is also shown at Gallery: changes set to Everywhere move things there too."), hud.warnings)
    val root = rootFromMarker(ringWorld, 180.0, saved)
    assertEquals(root.yawDeg, view.placed!!.yawDeg, 1e-3)
    assertEquals(root.position.x, view.placed!!.position.x, 1e-3)
    assertEquals(root.position.z, view.placed!!.position.z, 1e-3)
    assertTrue(scene.builderMode)
    assertNotNull(tools.editor)
    assertTrue(tools.ticks > 0)
    assertEquals(listOf("Flyer"), ui.assets.entries!!.map { it.name })
  }

  @Test fun `only a personal headset's HUD offers Scan this room, for the space being built`() {
    toBuilding(DeviceKind.PERSONAL)
    assertTrue(ui.hud!!.canScanRoom)
    assertEquals("sp-a", builder.buildingSpaceId)
  }

  @Test fun `a shared headset's HUD has no Scan this room`() {
    toBuilding(DeviceKind.SHARED)
    assertFalse(ui.hud!!.canScanRoom)
  }

  @Test fun `the Stream tab lists the screens, streams and images, and each change keeps the screen's other properties`() {
    toBuilding(DeviceKind.PERSONAL)
    assertTrue(ui.hud!!.canStream)
    builder.hudActions.selectTab(HudTab.STREAM)
    dispatcher.drain()
    assertEquals(HudTab.STREAM, ui.hud!!.tab)
    val st = ui.streams
    assertEquals(listOf("Big screen"), st.screens!!.map { it.name })
    assertEquals(listOf("Main Stage"), st.streams.map { it.name })
    assertEquals(listOf("Flyer"), st.images.map { it.name })
    val c = calls.getValue("sp-a")

    builder.streamActions.chooseOffImage("v1", "https://x/flyer.png")
    dispatcher.drain()
    val (id, props) = c.puts.last()
    assertEquals("v1", id)
    assertEquals(JsonPrimitive("https://x/flyer.png"), props["offImageSrc"])
    assertEquals(JsonPrimitive(1), props["offType"])
    assertEquals(JsonPrimitive("https://live/old.m3u8"), props["liveSrc"])

    builder.streamActions.chooseStream("v1", "s1")
    dispatcher.drain()
    assertEquals(JsonPrimitive("https://live/main.m3u8"), c.puts.last().second["liveSrc"])
    assertNull(ui.streams.picking)

    builder.streamActions.toggleLive("v1")
    dispatcher.drain()
    assertEquals(listOf("v1" to false), c.lives)
    assertNull(ui.streams.message)
  }

  private val twoPosters =
      """{"sk":"el1","name":"Poster","textureSrc":"https://x/p.png","instances":[
        {"sk":"in1","position":{"x":1,"y":1.5,"z":2},"rotation":{"x":0,"y":0,"z":0},"scale":{"x":1,"y":1,"z":1}},
        {"sk":"in2","position":{"x":3,"y":1.5,"z":2},"rotation":{"x":0,"y":0,"z":0},"scale":{"x":1,"y":1,"z":1}}]}"""

  @Test fun `the picked item's bar offers Clear for every copy of its object, asks first, then removes them in one call`() {
    toBuilding(DeviceKind.SHARED)
    snapshot("2", scene = sceneOf(twoPosters))
    builder.hudActions.pick("in1")
    dispatcher.drain()
    val offer = ui.hud!!.clear!!
    assertEquals(ClearOffer("el1", "Poster", 2, confirming = false), offer)
    builder.clearActions.ask()
    assertEquals("Remove all 2 copies of Poster? The object stays. This can't be undone.", clearCopiesPrompt(ui.hud!!.clear!!))
    builder.clearActions.cancel()
    assertFalse(ui.hud!!.clear!!.confirming)
    builder.clearActions.ask()
    builder.clearActions.confirm()
    dispatcher.drain()
    assertEquals(listOf("el1"), calls.getValue("sp-a").cleared)
    assertEquals("Removed 2 copies of Poster", ui.hud!!.message)
  }

  @Test fun `Clear isn't offered while the picked item has unsaved changes`() {
    toBuilding(DeviceKind.PERSONAL)
    builder.hudActions.pick("in1")
    builder.hudActions.setExact(TransformMode.MOVE, Axis.X, 2.5)
    dispatcher.drain()
    assertNull(ui.hud!!.clear)
  }

  @Test fun `a shared headset's HUD has no Stream tab`() {
    toBuilding(DeviceKind.SHARED)
    assertFalse(ui.hud!!.canStream)
  }

  @Test fun `a personal headset's space list offers Scan this room, even with no spaces`() {
    auth.pair(DeviceKind.PERSONAL)
    auth.spacesAnswer = BuilderCall.Ok(emptyList())
    builder.open()
    assertFalse(ui.builderPrompt!!.scanRoom) // not while finding
    dispatcher.drain()
    assertEquals(BuilderCopy.NO_SPACES, ui.builderPrompt?.text)
    assertTrue(ui.builderPrompt!!.scanRoom)
  }

  @Test fun `a personal headset's pick list offers Scan this room`() {
    auth.pair(DeviceKind.PERSONAL)
    auth.spacesAnswer = BuilderCall.Ok(listOf(spaceA, spaceB))
    builder.open()
    dispatcher.drain()
    assertTrue(ui.builderPrompt!!.scanRoom)
  }

  @Test fun `a shared headset's pick list doesn't offer Scan this room`() {
    auth.pair(DeviceKind.SHARED)
    auth.spacesAnswer = BuilderCall.Ok(listOf(spaceA, spaceB))
    builder.open()
    dispatcher.drain()
    assertFalse(ui.builderPrompt!!.scanRoom)
  }

  @Test fun `with no ring in view the builder picks the space from a list`() {
    auth.pair(DeviceKind.PERSONAL)
    auth.spacesAnswer = BuilderCall.Ok(listOf(spaceA, spaceB))
    builder.open()
    assertEquals(BuilderCopy.FINDING_SPACES, ui.builderPrompt?.text)
    dispatcher.drain()
    assertEquals(BuilderCopy.CHOOSE_SPACE, ui.builderPrompt?.text)
    assertEquals(listOf(spaceA, spaceB), ui.builderPrompt?.spaces)
    assertFalse(ui.builderActive) // visitor mode carries on under the list
    builder.pickSpace(spaceB)
    dispatcher.drain()
    assertEquals("sp-b" to "jwt", feed.started.last())
    assertTrue(ui.builderActive)
    assertEquals(BuilderCopy.lookAtRing("Gallery"), ui.builderPrompt?.text)
  }

  @Test fun `a ring of another space in view still gives the pick list`() {
    auth.pair(DeviceKind.PERSONAL)
    auth.spacesAnswer = BuilderCall.Ok(listOf(spaceB))
    frame()
    builder.open()
    dispatcher.drain()
    assertEquals(listOf(spaceB), ui.builderPrompt?.spaces)
  }

  @Test fun `a floor whose ring has no pose is aligned first, then built`() {
    toBuilding(space = arSpace(pose = null))
    assertNull(ui.hud)
    val align = ui.align!!
    val placed = align.state as AlignState.Placed
    val expected = defaultRoot(ringWorld, 180.0, 0.0, 1.6)
    assertEquals(expected.yawDeg, placed.root.yawDeg, 1e-3)
    assertEquals(expected.position.x, view.placed!!.position.x, 1e-3)
    assertEquals(expected.position.z, view.placed!!.position.z, 1e-3)
    assertTrue("show" in view.calls)
    // A held stick nudges the scene, once per step.
    frame(sticks = AlignSticks(rightX = 1.0))
    assertEquals(expected.yawDeg + 2.5, view.placed!!.yawDeg, 1e-3)
    builder.saveAlignment()
    dispatcher.drain()
    val (markerId, pose) = calls.getValue("sp-a").poses.single()
    assertEquals("m1", markerId)
    assertEquals(1.6, pose.y, 0.01) // the ring's height in the scene, on a floor at 0 m
    assertTrue(ui.align!!.state is AlignState.Saved)
    builder.closeAlign()
    assertNull(ui.align)
    assertNotNull(ui.hud)
    assertTrue(scene.builderMode)
  }

  @Test fun `a shared headset off for over 2 minutes signs out and is back at the hint card with nothing loaded`() {
    toBuilding(DeviceKind.SHARED)
    assertTrue(builder.headsetOff())
    assertEquals(1, dispatcher.tasks.size) // the off timer
    now += 2 * 60_000L + 1
    builder.offTick()
    dispatcher.drain()
    assertEquals(1, auth.ends)
    assertEquals(AuthState.SignedOut, auth.state.value)
    assertFalse(ui.builderActive)
    assertNull(ui.hud)
    assertEquals(VisitorCopy.HINT, ui.hint)
    assertNull(session.spaceId)
    assertEquals(0, session.itemCount())
    assertFalse(scene.builderMode)
    assertNull(tools.editor)
    assertFalse(ui.ownerControls)
    // Back on, visitor mode has it.
    assertFalse(builder.headsetOn())
  }

  @Test fun `a shared headset put back on after over 2 minutes is signed out then`() {
    toBuilding(DeviceKind.SHARED)
    builder.headsetOff()
    now += 3 * 60_000L
    assertFalse(builder.headsetOn())
    dispatcher.drain()
    assertEquals(AuthState.SignedOut, auth.state.value)
    assertEquals(VisitorCopy.HINT, ui.hint)
    assertNull(session.spaceId)
  }

  @Test fun `a personal headset off for a minute resumes with its drafts once a ring places the scene again`() {
    toBuilding(DeviceKind.PERSONAL)
    builder.hudActions.pick("in1")
    builder.hudActions.setExact(TransformMode.MOVE, Axis.X, 2.5)
    dispatcher.drain()
    assertTrue(ui.hud!!.rows.single().edited)
    assertTrue(builder.headsetOff())
    assertTrue("hideNow" in view.calls)
    assertNull(ui.hud) // the scene must be placed again first
    now += 60_000L
    assertTrue(builder.headsetOn())
    steady()
    val hud = ui.hud!!
    assertTrue(hud.rows.single().edited)
    assertTrue(hud.canSave)
    assertEquals(0, auth.ends)
    assertEquals(2.5, scene.shown.getValue("el1:in1").position.x, 1e-9)
  }

  @Test fun `Done returns to visitor mode with the space still shown`() {
    toBuilding()
    val root = session.rootOf()
    builder.hudActions.done() // nothing to save: leaves at once
    dispatcher.drain()
    assertFalse(ui.builderActive)
    assertNull(ui.hud)
    assertFalse(scene.builderMode)
    assertTrue(scene.shown.isEmpty())
    assertTrue(ui.sceneShown)
    assertNull(ui.hint)
    assertEquals(root, session.rootOf())
    assertEquals("sp-a" to null, feed.started.last()) // the published feed, as a visitor
    assertEquals(1, auth.ends) // a personal headset only drops its passes
    assertTrue(auth.state.value is AuthState.Paired)
    assertTrue(ui.ownerControls)
    // Visitor mode carries on from there, as a visit: leaving it sends the visit's enter and leave.
    snapshot("2")
    frame()
    assertTrue(ui.sceneShown)
    visitor.lookAgain()
    dispatcher.drain()
    val body = posted.joinToString()
    assertTrue(body, "\"type\":\"enter\"" in body && "\"type\":\"leave\"" in body)
  }

  @Test fun `Done on an unpublished space leaves nothing loaded for the next person`() {
    toBuilding(space = arSpace().copy(published = false))
    builder.hudActions.done()
    dispatcher.drain()
    assertFalse(ui.builderActive)
    assertEquals(VisitorCopy.HINT, ui.hint)
    assertNull(session.spaceId)
    assertEquals(0, session.itemCount())
  }

  // ── a shared headset signs out whenever builder mode closes ──

  private fun sharedChoosing() {
    auth.pair(DeviceKind.SHARED)
    auth.spacesAnswer = BuilderCall.Ok(listOf(spaceA, spaceB))
    builder.open()
    dispatcher.drain()
    assertEquals(listOf(spaceA, spaceB), ui.builderPrompt?.spaces)
  }

  @Test fun `shared, cancelling the pick list signs out`() {
    sharedChoosing()
    builder.cancel()
    dispatcher.drain()
    assertEquals(AuthState.SignedOut, auth.state.value)
    assertNull(ui.builderPrompt)
    assertFalse(ui.ownerControls)
  }

  @Test fun `shared, the headset coming off at the pick list signs out`() {
    sharedChoosing()
    assertFalse(builder.headsetOff()) // visitor mode handles the rest
    dispatcher.drain()
    assertEquals(AuthState.SignedOut, auth.state.value)
    assertNull(ui.builderPrompt)
  }

  @Test fun `shared, Done signs out`() {
    toBuilding(DeviceKind.SHARED)
    builder.hudActions.done()
    dispatcher.drain()
    assertEquals(AuthState.SignedOut, auth.state.value)
    assertFalse(ui.ownerControls)
    assertEquals(0, auth.pairings) // our own sign-out: nothing asks to pair again
  }

  @Test fun `shared, a pass refused on entering signs out`() {
    auth.pair(DeviceKind.SHARED)
    auth.passAnswer = PassResult.NoAccess
    auth.spacesAnswer = BuilderCall.Ok(listOf(spaceA))
    frame()
    builder.open()
    dispatcher.drain()
    assertEquals(AuthState.SignedOut, auth.state.value)
    assertEquals(AlignCopy.NO_ACCESS, ui.builderPrompt?.text)
    assertEquals(VisitorCopy.HINT, ui.hint)
  }

  @Test fun `shared, the feed saying not found mid-build signs out`() {
    toBuilding(DeviceKind.SHARED)
    feed.onStatus(FeedStatus.NOT_FOUND)
    dispatcher.drain()
    assertEquals(AuthState.SignedOut, auth.state.value)
    assertFalse(ui.builderActive)
    assertNull(session.spaceId)
    assertEquals(AlignCopy.NO_ACCESS, ui.builderPrompt?.text)
  }

  @Test fun `a shared pairing restored at startup is ended at once, a personal one is kept`() {
    for (kind in DeviceKind.entries) {
      val a = FakeAuth(AuthState.Paired("dev1", kind))
      val u = AppState()
      BuilderController(scope, session, a, { FakeCalls() }, visitor, FakeScene(), FakeTools(), u, { now }, { nowNs })
      dispatcher.drain()
      if (kind == DeviceKind.SHARED) {
        assertEquals(1, a.ends)
        assertEquals(AuthState.SignedOut, a.state.value)
        assertFalse(u.ownerControls)
      } else {
        assertEquals(0, a.ends)
        assertTrue(u.ownerControls)
      }
    }
  }

  @Test fun `edit rights lost mid-build close builder mode with the notice, and a shared headset signs out`() {
    toBuilding(DeviceKind.SHARED)
    auth.passAnswer = PassResult.NoAccess
    now += BuilderController.PASS_REFRESH_MS
    frame()
    assertFalse(ui.builderActive)
    assertEquals(AlignCopy.NO_ACCESS, ui.builderPrompt?.text)
    assertEquals(AuthState.SignedOut, auth.state.value)
  }

  @Test fun `a pass refresh that fails is tried again after the interval, not every frame`() {
    toBuilding()
    val before = auth.passesFor.size
    auth.passThrows = true
    now += BuilderController.PASS_REFRESH_MS
    frame()
    frame()
    assertEquals(before + 1, auth.passesFor.size)
    auth.passThrows = false
    now += BuilderController.PASS_REFRESH_MS
    frame()
    assertEquals(before + 2, auth.passesFor.size)
    assertTrue(ui.builderActive)
  }

  @Test fun `a space link while building says to finish first`() {
    toBuilding()
    assertTrue(builder.linkOpened())
    assertEquals(BuilderCopy.FINISH_FIRST, ui.hud!!.message)
    assertTrue(ui.builderActive)
    builder.hudActions.done()
    dispatcher.drain()
    assertFalse(builder.linkOpened())
  }

  @Test fun `a personal headset off launches no off timer`() {
    toBuilding(DeviceKind.PERSONAL)
    builder.headsetOff()
    assertEquals(0, dispatcher.tasks.size) // nothing launched to watch the time
  }

  @Test fun `a headset revoked while building goes back to the hint card and is asked to pair again`() {
    toBuilding()
    auth.state.value = AuthState.SignedOut // a call answered device_revoked
    dispatcher.drain()
    assertFalse(ui.builderActive)
    assertNull(ui.hud)
    assertEquals(VisitorCopy.HINT, ui.hint)
    assertNull(session.spaceId)
    assertEquals(1, auth.pairings)
    assertEquals("ABC123", ui.pairing?.code)
    builder.cancelPairing()
    dispatcher.drain()
    assertNull(ui.pairing)
    assertEquals(AuthState.SignedOut, auth.state.value)
  }

  @Test fun `Assets place puts the item ahead of the builder, then picks it once the feed has it`() {
    toBuilding()
    val entry = ui.assets.entries!!.single()
    builder.place(entry)
    dispatcher.drain()
    val (preset, sent, t) = calls.getValue("sp-a").placed.single()
    assertEquals("pr1", preset)
    assertEquals(entry, sent)
    assertEquals(placeAhead(Vec3(0.0, 1.6f.toDouble(), 0.0), 0.0, session.rootOf()!!), t)
    assertNull(ui.hud!!.bar) // not in the feed yet
    snapshot("2", scene = sceneOf(poster, flyer))
    assertEquals("Flyer", ui.hud!!.bar?.name)
    assertEquals(listOf("in9"), ui.hud!!.rows.filter { it.picked }.map { it.sk })
  }

  @Test fun `Builder on a signed-out headset pairs first, and Cancel stops the pairing`() {
    assertFalse(ui.ownerControls)
    builder.open()
    dispatcher.drain()
    assertEquals("ABC123", ui.pairing?.code)
    builder.cancelPairing()
    dispatcher.drain()
    assertNull(ui.pairing)
    assertEquals(AuthState.SignedOut, auth.state.value)
    assertNull(ui.builderPrompt)
    // Approved this time: on to the spaces.
    auth.approveAs = DeviceKind.PERSONAL
    auth.spacesAnswer = BuilderCall.Ok(listOf(spaceA))
    builder.open()
    dispatcher.drain()
    assertNull(ui.pairing)
    assertTrue(ui.ownerControls)
    assertEquals(listOf(spaceA), ui.builderPrompt?.spaces)
  }

  @Test fun `Sign out leaves builder mode with nothing loaded and forgets the pairing`() {
    toBuilding()
    builder.signOut()
    dispatcher.drain()
    assertEquals(1, auth.unpairs)
    assertFalse(ui.builderActive)
    assertFalse(ui.ownerControls)
    assertEquals(VisitorCopy.HINT, ui.hint)
    assertNull(session.spaceId)
    assertEquals(0, auth.pairings) // our own sign-out doesn't ask to pair again
  }

  @Test fun `a space this account can't edit closes builder mode with a notice`() {
    auth.pair(DeviceKind.PERSONAL)
    auth.passAnswer = PassResult.NoAccess
    auth.spacesAnswer = BuilderCall.Ok(listOf(spaceA))
    frame()
    builder.open()
    dispatcher.drain()
    assertFalse(ui.builderActive)
    assertEquals(VisitorCopy.HINT, ui.hint)
    assertEquals(BuilderPrompt(AlignCopy.NO_ACCESS, button = "Close"), ui.builderPrompt)
    builder.cancel()
    assertNull(ui.builderPrompt)
  }

  // ── whole-branch review fixes ──

  @Test fun `shared Sign out ends the session once`() {
    toBuilding(DeviceKind.SHARED)
    builder.signOut()
    dispatcher.drain()
    assertEquals(1, auth.unpairs)
    assertEquals(0, auth.ends) // the unpair's /end is the only one
    assertEquals(AuthState.SignedOut, auth.state.value)
  }

  @Test fun `a pass that throws on entering closes builder mode with a notice`() {
    auth.pair(DeviceKind.PERSONAL)
    auth.passThrows = true
    auth.spacesAnswer = BuilderCall.Ok(listOf(spaceA))
    frame()
    builder.open()
    dispatcher.drain()
    assertFalse(ui.builderActive)
    assertEquals(BuilderPrompt(BuilderCopy.COULDNT_OPEN, button = "Close"), ui.builderPrompt)
    assertEquals(VisitorCopy.HINT, ui.hint)
  }

  @Test fun `a tracking jump hides the scene, keeps the edits and blocks building until a ring places it again`() {
    toBuilding()
    builder.hudActions.pick("in1")
    builder.hudActions.setExact(TransformMode.MOVE, Axis.X, 2.5)
    dispatcher.drain()
    view.calls.clear()
    head = Pose(Vector3(1.5f, 1.6f, 0f)) // 1.5 m in one frame
    frame(rings = emptyList())
    assertTrue("hideNow" in view.calls)
    assertTrue(ui.builderActive)
    assertNull(ui.hud)
    assertNull(ui.ringCheck)
    assertNull(tools.editor) // no carries or drags
    assertEquals(BuilderCopy.lookAtRing("Cafe"), ui.builderPrompt?.text)
    // Placing and recording wait for the scene to be placed again.
    builder.place(ui.assets.entries!!.single())
    builder.recordRing()
    builder.saveAlignment()
    dispatcher.drain()
    assertTrue(calls.getValue("sp-a").placed.isEmpty())
    assertTrue(calls.getValue("sp-a").poses.isEmpty())
    // Back at the ring (from where the head is now), the build carries on with its edits.
    head = Pose(Vector3(0f, 1.6f, 0f))
    frame(rings = emptyList())
    steady()
    val hud = ui.hud!!
    assertTrue(hud.rows.single().edited)
    assertNotNull(tools.editor)
    assertEquals(2.5, scene.shown.getValue("el1:in1").position.x, 1e-9)
  }

  @Test fun `Finish building first comes down after 4 s`() {
    toBuilding()
    builder.linkOpened()
    assertEquals(BuilderCopy.FINISH_FIRST, ui.hud!!.message)
    now += BuilderController.FINISH_FIRST_MS - 100
    frame()
    assertEquals(BuilderCopy.FINISH_FIRST, ui.hud!!.message)
    now += 100
    frame()
    assertNull(ui.hud!!.message)
  }

  @Test fun `Finish building first comes down on the next HUD action`() {
    toBuilding()
    builder.linkOpened()
    builder.hudActions.selectTab(HudTab.ASSETS)
    assertNull(ui.hud!!.message)
    builder.linkOpened()
    builder.hudActions.pick("in1")
    assertNull(ui.hud!!.message)
  }

  @Test fun `closing with a notice ends the drafts`() {
    toBuilding()
    builder.hudActions.pick("in1")
    builder.hudActions.setExact(TransformMode.MOVE, Axis.X, 2.5)
    dispatcher.drain()
    val remote = calls.getValue("sp-a").editor
    remote.sent.clear()
    feed.onStatus(FeedStatus.NOT_FOUND)
    dispatcher.drain()
    assertFalse(ui.builderActive)
    assertEquals(listOf("end in1 false"), remote.sent)
  }
}
