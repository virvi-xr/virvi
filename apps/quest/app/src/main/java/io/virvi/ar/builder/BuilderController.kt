package io.virvi.ar.builder

import kotlinx.serialization.json.JsonObject
import android.os.SystemClock
import android.util.Log
import com.meta.spatial.core.Pose
import com.meta.spatial.core.Vector3
import io.virvi.ar.AppState
import io.virvi.ar.Vec3
import io.virvi.ar.api.ArFeedSnapshot
import io.virvi.ar.api.ArFloor
import io.virvi.ar.api.BuilderCall
import io.virvi.ar.api.DeviceKind
import io.virvi.ar.api.DeviceSpace
import io.virvi.ar.api.FeedStatus
import io.virvi.ar.api.MarkerPose
import io.virvi.ar.ring.CameraIntrinsics
import io.virvi.ar.ring.RingCodec
import io.virvi.ar.ring.WallPlane
import io.virvi.ar.ring.cameraToWorld
import io.virvi.ar.ring.markerInCamera
import io.virvi.ar.space.RootPose
import io.virvi.ar.space.SpaceSession
import io.virvi.ar.space.rootFromMarker
import io.virvi.ar.space.rotateY
import io.virvi.ar.visitor.CameraRings
import io.virvi.ar.visitor.Handoff
import io.virvi.ar.visitor.TrackingWatch
import io.virvi.ar.visitor.VisitorLink
import kotlin.coroutines.cancellation.CancellationException
import kotlin.math.atan2
import kotlin.math.hypot
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Builder mode, joined to the headset: the counterpart of `VisitorController`. It owns the builder's lifecycle:
 * - **Entering** ([open]): pairing first when the headset is signed out (the pairing panel; Cancel cancels the pairing),
 *   then the space: the one whose ring is in view, matched by code against [BuilderAuth.spaces], else a pick list.
 *   Entering pauses visitor mode ([visitor]) and follows the space's feed on the shared [session] with its AR pass.
 * - **Placing:** the scene is placed from a steady ring that has a saved pose; a ring on a floor with no saved pose
 *   goes to the **Align** panel first ([AlignFlow]), whose saved alignment places it.
 * - **Building:** the HUD ([hudModel]) and [BuilderEditor], with the pointer [tools], the renderer's overrides, the
 *   Assets tab and the ring panel ([RingCheckFlow]) for the floor's other rings.
 * - **Headset off and on** ([BuilderSession]): drafts are kept; a personal headset off for over 10 minutes drops
 *   them, a shared one off for over 2 minutes signs out, back at the hint card with nothing loaded. Back on, the scene
 *   is placed afresh from a ring (tracking may have moved).
 * - **Done** returns to visitor mode with the space still shown; **Sign out** and a revoked headset return to it at the
 *   hint card with nothing loaded (a revoked headset is then asked to pair again).
 *
 * [calls] gives a space's builder calls; [clock] and [nanoClock] are `SystemClock.elapsedRealtime` and
 * `elapsedRealtimeNanos` on the headset (the session's clock must match [clock]). Writes what the panels show into
 * [ui]. Main thread only.
 */
class BuilderController(
    private val scope: CoroutineScope,
    private val session: SpaceSession,
    private val auth: BuilderAuth,
    private val calls: (spaceId: String) -> BuilderSpaceCalls,
    private val visitor: VisitorLink,
    private val scene: BuilderScene,
    private val tools: BuilderTools,
    private val ui: AppState,
    private val clock: () -> Long = SystemClock::elapsedRealtime,
    private val nanoClock: () -> Long = SystemClock::elapsedRealtimeNanos,
) {
  private enum class Stage { OFF, PAIRING, FINDING, CHOOSING, PLACING, ALIGNING, BUILDING }

  /** One space being built, from entering it to leaving. */
  private inner class Build(val space: DeviceSpace, val kind: DeviceKind, val api: BuilderSpaceCalls) {
    val rules = BuilderSession(kind, clock)
    val editor = BuilderEditor(api.editor, DraftStore(clock), clock, launch = { block -> go(block) })
    /** The space's AR pass, sent with each feed request. */
    var token: String? = null
    var passAt = 0L
    var passing = false
    /** The scene is faded in. */
    var visible = false
    var offJob: Job? = null

    // Where the scene was last placed from: the ring, its world position and its floor.
    var anchorRing: Long? = null
    var anchorWorld: Vec3? = null
    var floorId: String? = null

    // Aligning a floor with no saved pose.
    var align: AlignFlow? = null
    var alignRing: Long? = null
    var alignMarkerId: String? = null
    var alignFloorId: String? = null
    var alignRoot: RootPose? = null
    var alignSaved: MarkerPose? = null
    var stickAt = 0L

    // The ring panel.
    var ringFlow: RingCheckFlow? = null
    var ringFlowRing: Long? = null
    var ringInView: RingInView? = null

    // The HUD.
    var tab = HudTab.LAYOUT
    var infoLoaded = false
    var presetId: String? = null
    var booking = false
    var otherPlaces: List<String> = emptyList()
    var note: String? = null
    /** When [BuilderCopy.FINISH_FIRST] (the only note that times out) is taken down. */
    var finishFirstUntil = 0L
    /** **Clear** is asking (LIV-12), and [note] is what the last clear did (taken down by the next HUD touch). */
    var confirmingClear = false
    var noteFromClear = false
  }

  private var stage = Stage.OFF
  private var build: Build? = null
  /** Bumped whenever builder mode ends or changes course, so an answer to an older call is dropped. */
  private var generation = 0
  private var pairingJob: Job? = null
  private var head: Pose? = null
  /** Spots tracking jumping while builder mode holds the space; [lastHeadMs] is when it last saw the head. */
  private val trackingWatch = TrackingWatch()
  private var lastHeadMs: Long? = null
  private var lastFrameNs = 0L
  /** The ids of the rings the newest camera frame trusted, for entering with a ring in view. */
  private var ringsInView: List<Long> = emptyList()
  private var prompt: BuilderPrompt? = null
  /** Why builder mode closed or didn't open, shown on the builder panel until it is closed. */
  private var notice: String? = null

  /** The space being built (the HUD is up), whose AR pass a room scan uploads with; null otherwise. */
  val buildingSpaceId: String?
    get() = build?.takeIf { stage == Stage.BUILDING }?.space?.spaceId

  /** Builder mode holds the space session (placing, aligning or building). */
  val active: Boolean
    get() = stage == Stage.PLACING || stage == Stage.ALIGNING || stage == Stage.BUILDING

  init {
    scope.launch { auth.state.collect(::onAuth) }
    // A shared session never outlives the app process: one restored from storage, with nothing being built, ends now.
    endIfShared()
    refreshUi()
  }

  /**
   * Builder mode is leaving to OFF: a shared headset's session ends with it, whatever the reason, so the next person
   * never inherits the pairing (or the spaces it can see).
   */
  private fun endIfShared() {
    if ((auth.state.value as? AuthState.Paired)?.kind == DeviceKind.SHARED) go { auth.endSession() }
  }

  // ── entering ─────────────────────────────────────────────────────────

  /** The menu's **Builder**: pairs a signed-out headset first, then finds the space. */
  fun open() {
    if (stage != Stage.OFF) return
    notice = null
    if (auth.state.value is AuthState.Paired) findSpaces() else startPairing()
  }

  private fun startPairing() {
    val g = ++generation
    stage = Stage.PAIRING
    pairingJob =
        scope.launch {
          try {
            auth.beginPairing()
          } catch (e: CancellationException) {
            throw e
          } catch (e: Exception) {
            Log.e(TAG, "Pairing failed", e)
          }
          if (g != generation) return@launch
          pairingJob = null
          if (auth.state.value is AuthState.Paired) {
            findSpaces()
          } else {
            stage = Stage.OFF
            notice = BuilderCopy.PAIRING_ENDED
            refreshUi()
          }
        }
    refreshUi()
  }

  /** The pairing panel's **Cancel**: stops the pairing (the code is dropped). */
  fun cancelPairing() {
    if (stage != Stage.PAIRING) return
    generation++
    pairingJob?.cancel()
    pairingJob = null
    stage = Stage.OFF
    refreshUi()
  }

  private fun findSpaces() {
    val g = ++generation
    stage = Stage.FINDING
    prompt = BuilderPrompt(BuilderCopy.FINDING_SPACES)
    go {
      val r = auth.spaces()
      if (g != generation) return@go
      when (r) {
        is BuilderCall.Ok -> spacesFound(r.value)
        BuilderCall.Revoked, BuilderCall.BadSecret -> signedOutElsewhere()
        BuilderCall.Offline -> prompt = BuilderPrompt(BuilderCopy.OFFLINE)
        else -> prompt = BuilderPrompt(BuilderCopy.SPACES_FAILED)
      }
      refreshUi()
    }
    refreshUi()
  }

  /** The space whose ring is in view, if any of [spaces] has one; else the pick list. */
  private fun spacesFound(spaces: List<DeviceSpace>) {
    for (ring in ringsInView) {
      for (s in spaces) {
        if (s.markers.any { RingCodec.parseCode(it.code) == ring }) return enter(s)
      }
    }
    stage = Stage.CHOOSING
    prompt = if (spaces.isEmpty()) BuilderPrompt(BuilderCopy.NO_SPACES) else BuilderPrompt(BuilderCopy.CHOOSE_SPACE, spaces)
  }

  /** A space from the pick list. */
  fun pickSpace(space: DeviceSpace) {
    if (stage != Stage.CHOOSING) return
    enter(space)
    refreshUi()
  }

  /** The builder panel's button: closes a notice or the pick list, or leaves builder mode while waiting for a ring. */
  fun cancel() {
    when (stage) {
      Stage.OFF -> {
        notice = null
        refreshUi()
      }
      Stage.FINDING, Stage.CHOOSING -> {
        generation++
        stage = Stage.OFF
        prompt = null
        endIfShared()
        refreshUi()
      }
      // Leaving before the scene is placed again: edits kept from before the headset came off are dropped.
      Stage.PLACING -> {
        build?.editor?.revert()
        leave(toShown = false, endSession = true)
      }
      else -> Unit
    }
  }

  private fun enter(space: DeviceSpace) {
    // Signed out since the list was fetched: ask to pair again rather than leave the list up.
    val kind = (auth.state.value as? AuthState.Paired)?.kind ?: return signedOutElsewhere()
    val g = ++generation
    visitor.pause()
    val b = Build(space, kind, calls(space.spaceId))
    build = b
    b.editor.onChange = ::refreshHud
    b.editor.onLeave = { leave(toShown = true, endSession = true) }
    session.onStatus = ::onFeedStatus
    session.onSnapshot = ::onSnapshot
    session.onSteady = { id, world, heading -> onSteady(id, world, heading) }
    stage = Stage.PLACING
    lastFrameNs = 0L
    resetWatch()
    b.passing = true
    go {
      val pass =
          try {
            auth.passFor(space.spaceId)
          } catch (e: CancellationException) {
            throw e
          } catch (e: Exception) {
            // Not left waiting in PLACING for a pass that will never come.
            Log.e(TAG, "Couldn't get a pass", e)
            PassResult.Failed(0)
          } finally {
            b.passing = false
            b.passAt = clock()
          }
      if (g != generation) return@go
      when (pass) {
        is PassResult.Ok -> {
          b.token = pass.token
          session.start(space.spaceId) { b.token }
        }
        PassResult.NoAccess -> leaveWithNote(AlignCopy.NO_ACCESS)
        PassResult.Offline -> leaveWithNote(BuilderCopy.OFFLINE)
        is PassResult.Failed -> leaveWithNote(BuilderCopy.COULDNT_OPEN)
        PassResult.Revoked -> signedOutElsewhere()
      }
      refreshUi()
    }
  }

  // ── every frame ──────────────────────────────────────────────────────

  /**
   * Call every frame with the head pose, the newest camera rings, the camera's intrinsics, the room's walls and the
   * sticks (read only while aligning). Returns whether builder mode holds the session (visitor mode is paused and needn't be ticked).
   */
  fun tick(head: Pose, rings: CameraRings?, k: CameraIntrinsics?, walls: List<WallPlane>, sticks: () -> AlignSticks): Boolean {
    val fresh = rings?.takeIf { nanoClock() - it.receivedNs < STALE_NS }
    ringsInView = fresh?.tracked?.map { it.id } ?: emptyList()
    val b = build
    if (b == null || !active) return false
    if (head != Pose()) {
      this.head = head
      watchTracking(b, head)
      if (fresh == null) session.resetLocks()
      else if (fresh.receivedNs != lastFrameNs) {
        lastFrameNs = fresh.receivedNs
        session.onRings(fresh.tracked, head, k, walls)
        if (stage == Stage.ALIGNING) checkSize(b, fresh, head, k, walls)
      }
    }
    session.tick()
    expireNote(b)
    when (stage) {
      Stage.ALIGNING -> stickStep(b, sticks())
      Stage.BUILDING -> buildingFrame(b)
      else -> Unit
    }
    refreshPass(b)
    refreshUi()
    return true
  }

  /**
   * A head move faster than a person moves is the headset's tracking jumping: where the scene was placed is wrong
   * now, so it is hidden at once and placed again from a ring (edits are kept). Wrong placement is worse than a delay.
   */
  private fun watchTracking(b: Build, head: Pose) {
    val now = clock()
    val dtS = lastHeadMs?.let { (now - it) / 1000.0 } ?: 0.0
    lastHeadMs = now
    if (!trackingWatch.onHead(head.t.vec(), yawOf(head), dtS)) return
    Log.i(TAG, "Tracking jumped: placing the scene again")
    relock(b)
  }

  private fun resetWatch() {
    trackingWatch.reset()
    lastHeadMs = null
  }

  /** "Finish building first" comes down after [FINISH_FIRST_MS]. */
  private fun expireNote(b: Build) {
    if (b.note == BuilderCopy.FINISH_FIRST && clock() >= b.finishFirstUntil) b.note = null
  }

  /** Any HUD action takes "Finish building first" down. */
  private fun hudTouched() {
    val b = build ?: return
    if (b.note == BuilderCopy.FINISH_FIRST || (b.noteFromClear && b.note != null)) {
      b.note = null
      b.noteFromClear = false
    }
  }

  /** The AR pass is minted again before it runs out (the cached one is served while it has over a minute left). */
  private fun refreshPass(b: Build) {
    if (b.passing || b.token == null || clock() - b.passAt < PASS_REFRESH_MS) return
    val g = generation
    b.passing = true
    go {
      // A refresh that throws is tried again after the next interval, not every frame.
      val pass =
          try {
            auth.passFor(b.space.spaceId)
          } finally {
            b.passing = false
            b.passAt = clock()
          }
      if (g != generation) return@go
      when (pass) {
        is PassResult.Ok -> b.token = pass.token
        // The account lost its edit rights while building.
        PassResult.NoAccess -> leaveWithNote(AlignCopy.NO_ACCESS)
        PassResult.Revoked -> signedOutElsewhere()
        // Offline or a hiccup: the current pass serves until the next try.
        PassResult.Offline, is PassResult.Failed -> Unit
      }
      refreshUi()
    }
  }

  private fun buildingFrame(b: Build) {
    b.editor.tick()
    tools.tick()
    scene.setOverrides(b.editor.overrides())
    ringCheck(b)
  }

  // ── placing and aligning ─────────────────────────────────────────────

  private fun onSteady(id: Long, world: Vec3, headingDeg: Double) {
    val b = build ?: return
    val space = session.snapshot()?.space ?: return
    val (floor, marker) = space.markerByRing(id) ?: return
    when (stage) {
      Stage.PLACING -> {
        val pose = marker.pose
        when {
          pose != null -> placeScene(b, rootFromMarker(world, headingDeg, pose), id, world, floor.id)
          floor.markers.any { it.pose != null } -> b.note = BuilderCopy.LOOK_AT_LINED_UP_RING
          else -> {
            b.align = AlignFlow(floor.name, floor.heightM)
            b.alignRing = id
            b.alignMarkerId = marker.id
            b.alignFloorId = floor.id
            b.alignRoot = null
            b.alignSaved = null
            b.note = null
            stage = Stage.ALIGNING
            sight(b, world, headingDeg)
          }
        }
      }
      Stage.ALIGNING -> if (id == b.alignRing) sight(b, world, headingDeg)
      else -> Unit
    }
  }

  private fun sight(b: Build, world: Vec3, headingDeg: Double) {
    val h = head?.t ?: return
    val d = hypot(hypot(world.x - h.x, world.y - h.y), world.z - h.z)
    b.align?.onSteadyRing(RingSight(world, headingDeg, d))
    alignChanged(b)
  }

  /** Puts the scene where the align flow has it. */
  private fun alignChanged(b: Build) {
    val st = b.align?.state as? AlignState.Placed ?: return
    if (st.root == b.alignRoot) return
    b.alignRoot = st.root
    session.setRoot(st.root)
    showScene(b)
  }

  /** One nudge every [STICK_STEP_MS] while a stick is held past its dead zone. */
  private fun stickStep(b: Build, s: AlignSticks) {
    val flow = b.align ?: return
    val now = clock()
    if (now - b.stickAt < STICK_STEP_MS) return
    val h = head ?: return
    val n = stickNudge(s.leftX, s.leftY, s.rightX, yawOf(h), s.fine)
    if (n.dx == 0.0 && n.dz == 0.0 && n.dYawDeg == 0.0) return
    b.stickAt = now
    flow.nudge(n.dx, n.dz, n.dYawDeg)
    alignChanged(b)
  }

  /**
   * The printed-size check for the ring being aligned: its range from its size in the image over the range along the
   * camera ray to the scanned wall, both from the passthrough lens.
   */
  private fun checkSize(b: Build, f: CameraRings, head: Pose, k: CameraIntrinsics?, walls: List<WallPlane>) {
    val flow = b.align ?: return
    if (k == null || flow.state !is AlignState.Placed) return
    val d = f.tracked.firstOrNull { it.id == b.alignRing } ?: return
    val marker = session.snapshot()?.space?.markerByRing(d.id)?.second ?: return
    val p = markerInCamera(d, k, marker.diameterMm / 1000.0)
    val origin = cameraToWorld(Vec3(0.0, 0.0, 0.0), head, k).vec()
    val ring = cameraToWorld(p, head, k).vec()
    flow.checkSize(hypot(hypot(p.x, p.y), p.z), depthRange(origin, ring, walls))
  }

  /** The align panel's **Save alignment**. */
  fun saveAlignment() {
    val b = build ?: return
    if (stage != Stage.ALIGNING) return
    val flow = b.align ?: return
    val markerId = b.alignMarkerId ?: return
    val h = head?.t ?: return
    val save = flow.requestSave(h.vec())
    refreshUi()
    if (save == null) return
    val g = generation
    go {
      val r = b.api.savePose(markerId, save.pose, save.heightAboveFloorM)
      if (g != generation || b.align !== flow) return@go
      flow.saved(r)
      if (r is BuilderCall.Ok) b.alignSaved = save.pose
      refreshUi()
    }
  }

  /** The align panel's **Done** (once saved: start building) or **Cancel** (look at a ring again). */
  fun closeAlign() {
    val b = build ?: return
    if (stage != Stage.ALIGNING) return
    val root = b.alignRoot
    val saved = b.alignSaved
    val ring = b.alignRing
    val floorId = b.alignFloorId
    if (b.align?.state is AlignState.Saved && root != null && saved != null && ring != null && floorId != null) {
      placeScene(b, root, ring, worldOf(root, saved), floorId)
    } else {
      relock(b)
    }
    refreshUi()
  }

  private fun placeScene(b: Build, root: RootPose, ring: Long, world: Vec3, floorId: String) {
    session.setRoot(root)
    showScene(b)
    session.flashOutline(ring)
    b.anchorRing = ring
    b.anchorWorld = world
    b.floorId = floorId
    b.align = null
    b.note = null
    stage = Stage.BUILDING
    scene.builderMode = true
    tools.start(b.editor) { session.rootOf() }
    loadInfo(b)
    refreshHud()
  }

  private fun showScene(b: Build) {
    if (b.visible) return
    b.visible = true
    session.show()
  }

  /** Hides the scene at once and waits for a ring to place it again; edits are kept. */
  private fun relock(b: Build) {
    tools.stop()
    session.hideNow()
    session.resetLocks()
    b.visible = false
    b.align = null
    b.ringFlow = null
    b.ringFlowRing = null
    b.ringInView = null
    b.note = null
    stage = Stage.PLACING
  }

  /** A space link opened while builder mode holds the space: it says to finish first. Returns whether it did. */
  fun linkOpened(): Boolean {
    val b = build ?: return false
    if (!active) return false
    b.note = BuilderCopy.FINISH_FIRST
    b.finishFirstUntil = clock() + FINISH_FIRST_MS
    refreshUi()
    return true
  }

  /** The menu's **Look at the ring again** while building: places the scene afresh from the next ring. */
  fun lookAgain(): Boolean {
    val b = build ?: return false
    if (!active) return false
    relock(b)
    refreshUi()
    return true
  }

  // ── building ─────────────────────────────────────────────────────────

  /** The booking flag, the other places and the library, once per space. */
  private fun loadInfo(b: Build) {
    if (b.infoLoaded) return
    b.infoLoaded = true
    val g = generation
    val sceneId = b.space.sceneId
    ui.assets = AssetsState(null)
    go {
      val r = b.api.scene(sceneId)
      if (g != generation || r !is BuilderCall.Ok) return@go
      b.presetId = activePresetId(r.value)
      b.booking = activePresetIsBooking(r.value)
      refreshHud()
    }
    go {
      val r = b.api.sceneSpaces(sceneId)
      if (g != generation || r !is BuilderCall.Ok) return@go
      b.otherPlaces = otherPlaces(r.value, b.space.spaceId)
      refreshHud()
    }
    go {
      val r = b.api.library(sceneId)
      if (g != generation) return@go
      ui.assets = if (r is BuilderCall.Ok) AssetsState(libraryEntries(r.value)) else AssetsState(null, failed = true)
    }
  }

  /** The Assets tab's **Place**: 1 m ahead of the builder, facing them, then picked once the feed shows it. */
  fun place(entry: LibraryEntry) {
    val b = build ?: return
    if (stage != Stage.BUILDING || !entry.drawable) return
    val presetId = b.presetId
    val root = session.rootOf()
    val h = head
    if (presetId == null || root == null || h == null) {
      b.note = PLACE_FAILED
      refreshHud()
      return
    }
    val t = placeAhead(h.t.vec(), yawOf(h), root)
    b.note = null
    val g = generation
    go {
      val r = b.api.place(presetId, entry, t)
      if (g != generation) return@go
      if (r is BuilderCall.Ok) b.editor.pickWhenPresent(r.value.instanceId) else b.note = PLACE_FAILED
      refreshHud()
    }
    refreshHud()
  }

  /** The ring panel for the floor's ring steady in view: its check, and **Record** / **Re-record**. */
  private fun ringCheck(b: Build) {
    val floor = currentFloor(b)
    val root = session.rootOf()
    val anchor = b.anchorWorld
    val steady = floor?.let { f -> session.steadyPoses().entries.firstOrNull { (id, _) -> f.markers.any { it.ringId == id } } }
    if (floor == null || root == null || anchor == null || steady == null) {
      b.ringInView = null
      return
    }
    if (steady.key != b.ringFlowRing || b.ringFlow == null) {
      // A different ring: a fresh flow, so the last ring's save status doesn't carry over.
      b.ringFlow = RingCheckFlow(floor)
      b.ringFlowRing = steady.key
    }
    b.ringInView = RingInView(steady.key, steady.value.world, steady.value.headingDeg)
  }

  /** The ring panel's **Record this ring** / **Re-record this ring**. */
  fun recordRing() {
    val b = build ?: return
    // Not while the scene is being placed again (a tracking jump, or Look at the ring again).
    if (stage != Stage.BUILDING) return
    val flow = b.ringFlow ?: return
    val ring = b.ringInView ?: return
    val root = session.rootOf() ?: return
    val anchor = b.anchorWorld ?: return
    val markerId = currentFloor(b)?.markers?.firstOrNull { it.ringId == ring.ringId }?.id ?: return
    val save = flow.requestSave(root, anchor, ring)
    refreshUi()
    if (save == null) return
    val g = generation
    go {
      val r = b.api.savePose(markerId, save.pose, save.heightAboveFloorM)
      if (g != generation || b.ringFlow !== flow) return@go
      flow.saved(r)
      // The floor the flow holds is the old one; the feed's newer one has the saved pose.
      currentFloor(b)?.let { b.ringFlow = RingCheckFlow(it, flow.status) }
      refreshUi()
    }
  }

  private fun currentFloor(b: Build): ArFloor? = session.snapshot()?.space?.floors?.firstOrNull { it.id == b.floorId }

  private fun refreshHud() {
    val b = build
    if (b == null || stage != Stage.BUILDING) {
      ui.hud = null
      return
    }
    val personal = b.kind == DeviceKind.PERSONAL
    val view = b.editor.view()
    val m = hudModel(view, b.tab, hudWarnings(b.booking, b.otherPlaces)).copy(canScanRoom = personal, canStream = personal, clear = clearOffer(b, view))
    ui.hud = if (m.message == null && b.note != null) m.copy(message = b.note) else m
  }

  /** The HUD's controls, on the current editor (the tab is kept here). */
  val hudActions: BuilderHudActions =
      EditorHudActions({ hudTouched(); build?.takeIf { stage == Stage.BUILDING }?.also { it.confirmingClear = false }?.editor }) { tab ->
        hudTouched()
        val b = build
        // The Stream tab is a personal headset's (the server refuses a shared one)
        if (b != null && (tab != HudTab.STREAM || b.kind == DeviceKind.PERSONAL)) {
          b.tab = tab
          if (tab == HudTab.STREAM) loadStreams(b)
        }
        refreshHud()
      }

  // ── Clear every copy (LIV-12) ───────────────────────────────────────

  /** The picked item's object and how many copies it has here; only with nothing unsaved, so no edit is lost. */
  private fun clearOffer(b: Build, view: EditorView): ClearOffer? {
    val item = view.items.firstOrNull { it.sk == view.picked } ?: return null
    if (view.edited.isNotEmpty() || view.saving) return null
    val elementId = item.renderKey.substringBefore(':')
    val copies = view.items.count { it.renderKey.substringBefore(':') == elementId }
    return ClearOffer(elementId, item.name, copies, b.confirmingClear)
  }

  val clearActions: ClearActions =
      object : ClearActions {
        override fun ask() = setConfirming(true)

        override fun cancel() = setConfirming(false)

        override fun confirm() {
          val b = build?.takeIf { stage == Stage.BUILDING } ?: return
          val offer = clearOffer(b, b.editor.view()) ?: return
          b.confirmingClear = false
          val g = generation
          go {
            val r = b.api.clearCopies(offer.elementId)
            if (g != generation) return@go
            b.note = if (r is BuilderCall.Ok) clearedNote(offer.name, r.value) else CLEAR_FAILED
            b.noteFromClear = true
            refreshHud()
          }
          refreshHud()
        }

        private fun setConfirming(on: Boolean) {
          val b = build?.takeIf { stage == Stage.BUILDING } ?: return
          hudTouched()
          b.confirmingClear = on
          refreshHud()
        }
      }

  // ── the Stream tab (LIV-53, LIV-54) ─────────────────────────────────

  /** The live preset's screens, the scene's streams and the library's images; each open of the tab loads them again. */
  private fun loadStreams(b: Build, keep: StreamsState = StreamsState()) {
    val g = generation
    ui.streams = keep.copy(screens = keep.screens, failed = false)
    go {
      val sceneId = b.space.sceneId
      val scene = b.api.scene(sceneId)
      val streams = b.api.streams(sceneId)
      val library = b.api.library(sceneId)
      if (g != generation) return@go
      ui.streams =
          if (scene is BuilderCall.Ok) {
            ui.streams.copy(
                screens = streamScreens(scene.value),
                streams = (streams as? BuilderCall.Ok)?.value?.let(::parseSceneStreams) ?: emptyList(),
                images = (library as? BuilderCall.Ok)?.value?.let(::offImageChoices) ?: emptyList(),
            )
          } else ui.streams.copy(screens = null, failed = true)
    }
  }

  /** One change to a screen: [change] gets its current properties (read again, as another editor may have changed them). */
  private fun changeScreen(elementId: String, change: suspend (Build, JsonObject) -> BuilderCall<Unit>) {
    val b = build?.takeIf { stage == Stage.BUILDING && it.kind == DeviceKind.PERSONAL } ?: return
    if (ui.streams.busy) return
    val g = generation
    ui.streams = ui.streams.copy(busy = true, message = null)
    go {
      val scene = b.api.scene(b.space.sceneId)
      val props = (scene as? BuilderCall.Ok)?.value?.let { elementProperties(it, elementId) }
      val r = if (props == null) BuilderCall.NotFound else change(b, props)
      if (g != generation) return@go
      val next = ui.streams.copy(busy = false, message = if (r is BuilderCall.Ok) null else streamChangeFailed(r))
      loadStreams(b, if (r is BuilderCall.Ok) next.copy(picking = null) else next)
    }
  }

  val streamActions: StreamActions =
      object : StreamActions {
        override fun pick(elementId: String, list: StreamPick.List) {
          val open = StreamPick(elementId, list)
          ui.streams = ui.streams.copy(picking = if (ui.streams.picking == open) null else open)
        }

        override fun chooseStream(elementId: String, streamId: String) {
          val stream = ui.streams.streams.firstOrNull { it.id == streamId } ?: return
          changeScreen(elementId) { b, props -> b.api.putProperties(elementId, withProperty(props, "liveSrc", stream.hlsPlaylistUrl)) }
        }

        override fun chooseOffImage(elementId: String, url: String) =
            changeScreen(elementId) { b, props -> b.api.putProperties(elementId, withProperty(props, "offImageSrc", url)) }

        override fun toggleLive(elementId: String) {
          val on = ui.streams.screens?.firstOrNull { it.id == elementId }?.liveOn ?: return
          changeScreen(elementId) { b, _ -> b.api.setLive(elementId, !on) }
        }
      }

  // ── the feed ─────────────────────────────────────────────────────────

  private fun onFeedStatus(s: FeedStatus) {
    ui.feed = s
    // The space is gone, or this account can't see it.
    if (s == FeedStatus.NOT_FOUND) leaveWithNote(AlignCopy.NO_ACCESS)
  }

  private fun onSnapshot(s: ArFeedSnapshot) {
    val b = build ?: return
    b.editor.setItems(builderItems(s.scene))
    // A ring flow holds its floor as it was: take the newer one, unless a save of it is still under way.
    val flow = b.ringFlow
    if (flow != null && flow.status != RingCheckCopy.SAVING) currentFloor(b)?.let { b.ringFlow = RingCheckFlow(it, flow.status) }
    refreshUi()
  }

  // ── headset off and on ───────────────────────────────────────────────

  /** The headset came off. Returns whether builder mode handled it (visitor mode is paused). */
  fun headsetOff(): Boolean {
    when (stage) {
      // Nobody should come back to a pairing code or someone's pick list.
      Stage.PAIRING -> cancelPairing()
      Stage.FINDING, Stage.CHOOSING -> cancel()
      else -> Unit
    }
    notice = null
    val b = build
    if (b == null || !active) return false
    b.rules.headsetOff()
    relock(b)
    b.offJob?.cancel()
    // Only a shared session ends while the headset is off; a personal one is judged when it is back on.
    if (b.kind == DeviceKind.SHARED) {
      b.offJob =
          scope.launch {
            while (true) {
              delay(OFF_CHECK_MS)
              offTick()
            }
          }
    }
    refreshUi()
    return true
  }

  /** While the headset is off: a shared headset off for over 2 minutes signs out now, not when it is next put on. */
  internal fun offTick() {
    val b = build ?: return
    if (b.rules.tick()) endShared(b)
  }

  /** The headset is back on. Returns whether builder mode handled it (otherwise visitor mode should). */
  fun headsetOn(): Boolean {
    val b = build
    if (b == null || !active) return false
    b.offJob?.cancel()
    b.offJob = null
    resetWatch()
    when (b.rules.headsetOn()) {
      Resume.RESUME_WITH_DRAFTS -> Unit
      Resume.RESUME_DRAFTS_EXPIRED -> b.editor.revert()
      Resume.SIGNED_OUT -> {
        endShared(b)
        return false
      }
    }
    refreshUi()
    return true
  }

  /** A shared headset's session has ended: its drafts are dropped and it signs out, with nothing left loaded. */
  private fun endShared(b: Build) {
    b.rules.signOut()
    b.editor.revert()
    leave(toShown = false, endSession = true)
  }

  // ── leaving ──────────────────────────────────────────────────────────

  /** The menu's **Sign out**: leaves builder mode (unsaved drafts are dropped) and forgets the pairing. */
  fun signOut() {
    cancelPairing()
    if (stage == Stage.FINDING || stage == Stage.CHOOSING) cancel()
    build?.let { b ->
      b.rules.signOut()
      b.editor.revert()
      // The session is ended by the unpair below, once: not also by leaving.
      leave(toShown = false, endSession = false, unpairing = true)
    }
    go { auth.unpair() }
  }

  private fun leaveWithNote(note: String) {
    // The drafts' holds are ended (best effort) rather than left for the server to time out.
    build?.editor?.discard()
    leave(toShown = false, endSession = false)
    notice = note
    refreshUi()
  }

  /**
   * Leaves builder mode for visitor mode: with the space still shown ([toShown], when it is placed and published), or
   * at the hint card with nothing loaded. A shared headset's session always ends here (it signs out); [endSession] also
   * ends a personal one's (its cached passes are dropped). [unpairing]: the caller ends the session itself (Sign out).
   */
  private fun leave(toShown: Boolean, endSession: Boolean, unpairing: Boolean = false) {
    val b = build ?: return
    val snapshot = session.snapshot()
    val root = session.rootOf()
    val ring = b.anchorRing
    // Only a published space is handed over: its snapshot is then exactly what the visitor feed serves (the pass only
    // adds access to unpublished spaces), so nothing the builder's pass could see is left up for the next person.
    val handoff =
        if (toShown && stage == Stage.BUILDING && snapshot != null && snapshot.space.published && root != null && ring != null) {
          Handoff(snapshot, root, ring)
        } else {
          null
        }
    generation++
    b.offJob?.cancel()
    b.editor.onChange = null
    b.editor.onLeave = null
    b.rules.done()
    tools.stop()
    scene.setOverrides(emptyMap())
    scene.builderMode = false
    build = null
    stage = Stage.OFF
    prompt = null
    if (handoff == null) session.stop()
    visitor.resume(handoff)
    if (!unpairing && (endSession || b.kind == DeviceKind.SHARED)) go { auth.endSession() }
    refreshUi()
  }

  private fun onAuth(s: AuthState) {
    if (s is AuthState.SignedOut) signedOutElsewhere()
    refreshUi()
  }

  /**
   * A sign-out this controller didn't start (the headset was revoked, seen by any call or by the auth state) leaves
   * builder mode and asks to pair again. Once is enough: after it, builder mode is pairing.
   */
  private fun signedOutElsewhere() {
    if (!(active || stage == Stage.FINDING || stage == Stage.CHOOSING)) return
    if (active) leave(toShown = false, endSession = false)
    stage = Stage.OFF
    prompt = null
    startPairing()
  }

  // ── panels ───────────────────────────────────────────────────────────

  private fun refreshUi() {
    val b = build
    val st = auth.state.value
    ui.builderActive = active
    ui.ownerControls = active || st is AuthState.Paired
    ui.pairing = if (stage == Stage.PAIRING) st as? AuthState.Pairing else null
    ui.builderPrompt =
        when (stage) {
          Stage.FINDING, Stage.CHOOSING -> prompt
          Stage.PLACING -> b?.let { BuilderPrompt(it.note ?: BuilderCopy.lookAtRing(it.space.spaceName)) }
          Stage.OFF -> notice?.let { BuilderPrompt(it, button = CLOSE) }
          else -> null
        }
    ui.align =
        b?.align?.takeIf { stage == Stage.ALIGNING }?.let { f -> AlignUi(f.state, listOfNotNull(b.note, f.sizeMessage) + f.warningLines()) }
    ui.ringCheck =
        if (stage != Stage.BUILDING || b == null) null
        else {
          val flow = b.ringFlow
          val ring = b.ringInView
          val root = session.rootOf()
          val anchor = b.anchorWorld
          if (flow == null || ring == null || root == null || anchor == null) null
          else RingCheckUi(flow.view(root, anchor, ring), flow.status)
        }
    refreshHud()
  }

  /** Runs [block] on the scope, logging (not crashing on) a failure. */
  private fun go(block: suspend () -> Unit) {
    scope.launch {
      try {
        block()
      } catch (e: CancellationException) {
        throw e
      } catch (e: Exception) {
        Log.e(TAG, "Builder call failed", e)
      }
    }
  }

  /** A scene pose [p] (a ring's) in world space, the scene placed at [root]. */
  private fun worldOf(root: RootPose, p: MarkerPose): Vec3 {
    val r = rotateY(root.yawDeg, Vec3(p.x, p.y, p.z))
    return Vec3(root.position.x + r.x, root.position.y + r.y, root.position.z + r.z)
  }

  private fun yawOf(head: Pose): Double {
    val fwd = head.q.times(Vector3(0f, 0f, 1f))
    return Math.toDegrees(atan2(fwd.x.toDouble(), fwd.z.toDouble()))
  }

  private fun Vector3.vec() = Vec3(x.toDouble(), y.toDouble(), z.toDouble())

  companion object {
    private const val TAG = "VirviAR"
    private const val CLOSE = "Close"
    /** A camera frame older than this (camera stalled or stopped) shows no rings. */
    private const val STALE_NS = 250_000_000L
    /** How often the space's AR pass is asked for again (a fresh one is minted when the cached one is nearly out). */
    const val PASS_REFRESH_MS = 30_000L
    /** While the headset is off, how often a shared session is checked for its 2 minutes. */
    const val OFF_CHECK_MS = 5_000L
    /** A thumbstick held while aligning nudges the scene once this often. */
    const val STICK_STEP_MS = 100L
    /** How long "Finish building first" stays up (unless a HUD action takes it down first). */
    const val FINISH_FIRST_MS = 4_000L
  }
}
