package io.virvi.ar.visitor

import android.os.SystemClock
import android.util.Log
import com.meta.spatial.core.Pose
import com.meta.spatial.core.Vector3
import io.virvi.ar.AppState
import io.virvi.ar.Vec3
import io.virvi.ar.api.ApiResult
import io.virvi.ar.api.ArFeedSnapshot
import io.virvi.ar.api.FeedStatus
import io.virvi.ar.api.MarkerLookup
import io.virvi.ar.api.ReportResult
import io.virvi.ar.api.VisitAnalytics
import io.virvi.ar.ring.CameraIntrinsics
import io.virvi.ar.ring.RingCodec
import io.virvi.ar.ring.RingDetection
import io.virvi.ar.ring.WallPlane
import io.virvi.ar.space.RootPose
import io.virvi.ar.space.SpaceSession
import io.virvi.ar.space.markerInScene
import kotlin.coroutines.cancellation.CancellationException
import kotlin.math.atan2
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * One camera frame's rings: the trusted ones (agreed by `RingTracker`), the last raw detection of any id (for the
 * developer panel), whether a ring was seen but not readable, and when the frame was processed
 * (SystemClock.elapsedRealtimeNanos).
 */
class CameraRings(
    val tracked: List<RingDetection>,
    val last: RingDetection?,
    val unreadable: Boolean,
    val receivedNs: Long,
)

/** What the visitor controller keeps between launches (`AppPrefs` on the headset). */
interface VisitorPrefs {
  val keepLoadedBetweenVisitors: Boolean
  var recentSpaces: List<RecentSpace>
}

/** No BEAT card (the visitor tests'). */
private object NoBeats : BeatLink {
  override fun spaceShown(spaceId: String?) = Unit

  override fun accountChanged() = Unit
}

/** Builder mode's hold on visitor mode ([VisitorController] in the app). */
interface VisitorLink {
  /** Builder mode takes the space session: visitor mode forgets its space (nothing loaded) and waits. */
  fun pause()

  /**
   * Builder mode has ended: visitor mode takes the session back, showing [handoff]'s space where builder mode left
   * it, or at the hint card with nothing loaded when it's null.
   */
  fun resume(handoff: Handoff?)
}

/** The space builder mode was showing as it left: its last snapshot, where it is placed, and the ring it was placed from. */
data class Handoff(val snapshot: ArFeedSnapshot, val root: RootPose, val ringId: Long)

/**
 * Visitor mode, joined to the headset: owns the [VisitorFlow], turns camera rings, head poses and the lifecycle into
 * the flow's events, and carries out its effects on the space [session] (feed, scene, ring locks, outline), the ring
 * tracker ([setRegistered]) and the visit [analytics]. Writes what the hint card says into [ui]. [clock] and
 * [nanoClock] are `SystemClock.elapsedRealtime` and `elapsedRealtimeNanos` on the headset (the session's clock must
 * match [clock]). While builder mode holds the session ([pause] to [resume]) it does nothing. Main thread only.
 */
class VisitorController(
    private val scope: CoroutineScope,
    private val session: SpaceSession,
    private val lookup: suspend (code: String) -> ApiResult<MarkerLookup>,
    private val analytics: VisitAnalytics,
    private val report: suspend (spaceId: String, reason: String) -> ReportResult = { _, _ -> ReportResult.Failed },
    private val prefs: VisitorPrefs,
    private val ui: AppState,
    private val setRegistered: (Set<Long>?) -> Unit,
    /** The signed-in visitor's access token for the feed (null: signed out, so an anonymous poll). */
    private val visitorToken: () -> String? = { null },
    /** Told which space is shown (null: none), for its BEAT card. */
    private val beats: BeatLink = NoBeats,
    private val clock: () -> Long = SystemClock::elapsedRealtime,
    private val nanoClock: () -> Long = SystemClock::elapsedRealtimeNanos,
) : VisitorLink {
  private val flow = VisitorFlow()
  private val trackingWatch = TrackingWatch()
  private val unreadableWatch = UnreadableWatch()

  private var lastFrameNs = 0L
  /** How gathering the space's rings went on the newest camera frame (the hint while locking). */
  private var gather = GatherStatus.NONE_IN_VIEW
  /** When the current run of unreadable-ring sightings began (as [UnreadableWatch] reports it), or null. */
  private var unreadableSince: Long? = null
  /** When [tick] last had a head pose, for the tracking watch's speed limits. */
  private var lastHeadMs: Long? = null
  private var askingPermissions = false
  private var cameraDenied = false
  private var spatialDenied = false
  private var roomScanMissing = false

  /** The ring that last became steady, for naming the space a scene was just shown for. */
  private var steadyRing: Long? = null

  /** Builder mode holds the session. */
  private var paused = false

  init {
    attach()
    ui.recentSpaces = prefs.recentSpaces
    scope.launch {
      while (true) {
        delay(FLUSH_INTERVAL_MS)
        flushAnalytics()
      }
    }
    refreshUi()
  }

  /** Takes the session's callbacks (builder mode sets its own while it holds the session). */
  private fun attach() {
    session.onStatus = ::onFeedStatus
    session.onSnapshot = ::onSnapshot
    session.onSteady = { id, world, heading ->
      // A new steady pose locks on, or re-anchors a shown scene.
      steadyRing = id
      dispatch(VisitorEvent.Steady(id, world, heading))
    }
  }

  override fun pause() {
    if (paused) return
    dispatch(VisitorEvent.LookAgain) // stops the feed and the visit, and clears the scene
    resetSightings()
    paused = true
    ui.hint = null
    ui.sceneShown = false
    ui.spacePage = null
    ui.spaceProblem = null
    // The "⋯" button stays, so the menu (Sign out) can be reached with hands too.
    ui.menuButtonShown = true
  }

  override fun resume(handoff: Handoff?) {
    if (!paused) return
    paused = false
    attach()
    trackingWatch.reset()
    lastHeadMs = null
    resetSightings()
    if (handoff != null) {
      steadyRing = handoff.ringId
      dispatch(VisitorEvent.Adopt(handoff.snapshot, handoff.root, handoff.ringId))
    } else {
      refreshUi()
    }
  }

  private fun resetSightings() {
    unreadableWatch.reset()
    unreadableSince = null
    gather = GatherStatus.NONE_IN_VIEW
    lastFrameNs = 0L
  }

  /** Posts queued analytics; a failure stays queued for the next flush. */
  private suspend fun flushAnalytics() {
    try {
      analytics.flush()
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      Log.w(TAG, "Analytics flush failed", e)
    }
  }

  /** Ends the visit (the space is forgotten or the headset is off) and sends its `leave` at once. */
  private fun endVisit() {
    analytics.end()
    scope.launch { flushAnalytics() }
  }

  /** Call every frame with the head pose, the newest camera rings, the camera's intrinsics and the room's walls. */
  fun tick(head: Pose, rings: CameraRings?, k: CameraIntrinsics?, walls: List<WallPlane>) {
    if (paused) return
    val now = clock()
    if (head != Pose()) {
      (flow.state as? VisitorState.Shown)?.let { shown ->
        val p = markerInScene(shown.root, head.t.vec(), 0.0)
        analytics.position(Vec3(p.x, p.y, p.z))
      }
      val fwd = head.q.times(Vector3(0f, 0f, 1f))
      val yaw = Math.toDegrees(atan2(fwd.x.toDouble(), fwd.z.toDouble()))
      val dtS = lastHeadMs?.let { (now - it) / 1000.0 } ?: 0.0
      lastHeadMs = now
      if (trackingWatch.onHead(head.t.vec(), yaw, dtS)) {
        Log.i(TAG, "Tracking jumped: hiding the scene")
        dispatch(VisitorEvent.TrackingJump)
      }
      val fresh = rings?.takeIf { nanoClock() - it.receivedNs < STALE_NS }
      if (fresh == null) noRings(now)
      else if (fresh.receivedNs != lastFrameNs) {
        lastFrameNs = fresh.receivedNs
        onFrame(fresh, head, k, walls, now)
      }
    }
    session.tick()
    dispatch(VisitorEvent.Tick) // also refreshes the panels
  }

  fun headsetOff() {
    if (paused) return
    dispatch(VisitorEvent.HeadsetOff)
    endVisit()
    // A shared headset: the next person starts at the hint card with nothing loaded, unless a builder chose otherwise.
    if (!prefs.keepLoadedBetweenVisitors) dispatch(VisitorEvent.LookAgain)
    resetSightings()
    refreshUi()
  }

  fun headsetOn() {
    if (paused) return
    trackingWatch.reset()
    lastHeadMs = null
    dispatch(VisitorEvent.HeadsetOn)
  }

  fun lookAgain() {
    if (!paused) dispatch(VisitorEvent.LookAgain)
  }

  /** Opens the space with [code] (from a link or the Spaces list): shows its page and looks it up. Not while building. */
  fun openSpace(code: String) {
    if (!paused) dispatch(VisitorEvent.OpenSpace(code))
  }

  /** Reports the space now up (or loading) for [reason] and tells the menu how it went. Not while building. */
  fun reportSpace(reason: String) {
    val id = flow.reportSpaceId
    if (paused || id == null) return
    scope.launch {
      val r =
          try {
            report.invoke(id, reason)
          } catch (e: CancellationException) {
            throw e
          } catch (e: Exception) {
            Log.w(TAG, "Report failed", e)
            ReportResult.Failed
          }
      ui.menuNote = reportNote(r)
    }
  }

  fun closeSpacePage() {
    ui.spacePage = null
  }

  /** Whether the system permission dialogs are up (the hint and an open space page then say why the app asks). */
  fun setAskingPermissions(asking: Boolean) {
    askingPermissions = asking
    refreshUi()
  }

  /** Whether the camera permission has been refused (the hint then says how to allow it). */
  fun setCameraDenied(denied: Boolean) {
    cameraDenied = denied
    refreshUi()
  }

  /** Whether the spatial data permission has been refused (the room scan can't be read; the hint says how to allow it). */
  fun setSpatialDenied(denied: Boolean) {
    spatialDenied = denied
    refreshUi()
  }

  /** Whether the room scan is missing, or failed to load after its retries (the hint then says how to make one). */
  fun setRoomScanMissing(missing: Boolean) {
    roomScanMissing = missing
    refreshUi()
  }

  /** The app is closing: stops the feed and releases the scene (video players included). */
  fun stop() = session.stop()

  // ── rings ────────────────────────────────────────────────────────────

  private fun noRings(now: Long) {
    session.resetLocks()
    unreadableWatch.onFrame(false, now)?.let(::onUnreadable)
    gather = GatherStatus.NONE_IN_VIEW
  }

  private fun onUnreadable(e: VisitorEvent) {
    unreadableSince = (e as? VisitorEvent.UnreadableSeen)?.sinceMs
    dispatch(e)
  }

  private fun onFrame(f: CameraRings, head: Pose, k: CameraIntrinsics?, walls: List<WallPlane>, now: Long) {
    unreadableWatch.onFrame(f.unreadable, now)?.let(::onUnreadable)
    // The flow only acts on agreed rings while searching; there's no need to tell it every frame otherwise.
    val st = flow.state
    if (st == VisitorState.Hint || st == VisitorState.StepCloser || st is VisitorState.Failed) {
      for (d in f.tracked) dispatch(VisitorEvent.RingAgreed(d.id))
    }
    val steps = session.onRings(f.tracked, head, k, walls)
    gather = gatherStatus(steps, unreadableSince != null)
  }

  // ── feed ─────────────────────────────────────────────────────────────

  private fun onFeedStatus(s: FeedStatus) {
    ui.feed = s
    dispatch(VisitorEvent.FeedStatus(s))
  }

  /** The session has applied the scene; the session catches and logs an exception in here. */
  private fun onSnapshot(snapshot: ArFeedSnapshot) = dispatch(VisitorEvent.Feed(snapshot, session.steadyPoses()))

  // ── flow ─────────────────────────────────────────────────────────────

  /** Events raised while an event's effects are being carried out (the feed reports CONNECTING from inside start). */
  private val pending = ArrayDeque<VisitorEvent>()
  private var dispatching = false

  /** Hands [e] to the flow and carries out its effects; events raised meanwhile wait their turn. */
  private fun dispatch(e: VisitorEvent) {
    pending.addLast(e)
    if (dispatching) return
    dispatching = true
    try {
      while (pending.isNotEmpty()) {
        val next = pending.removeFirst()
        val now = clock()
        for (fx in flow.on(next, now)) run(fx)
      }
    } finally {
      // A throw must not leave events queued to replay, stale, on the next dispatch.
      pending.clear()
      dispatching = false
    }
    refreshUi()
  }

  private fun run(fx: VisitorEffect) {
    when (fx) {
      is VisitorEffect.Lookup -> lookup(fx.code)
      is VisitorEffect.StartFeed -> session.start(fx.spaceId, visitorToken)
      VisitorEffect.StopFeed -> {
        session.stop()
        endVisit()
        ui.feed = null
      }
      is VisitorEffect.ShowScene -> {
        // The scene is up, so the visit counts. The ring's own code names the space in the list.
        val s = session.snapshot()?.space
        val ring = steadyRing
        if (s != null && ring != null) visited(RingCodec.codeOf(ring), s.name)
        s?.let { analytics.shown(it.id) }
        session.setRoot(fx.root)
        session.show()
      }
      is VisitorEffect.Reanchor -> session.setRoot(fx.root)
      VisitorEffect.HideScene -> {
        session.hide()
        analytics.hidden()
      }
      VisitorEffect.HideNow -> {
        session.hideNow()
        analytics.hidden()
      }
      is VisitorEffect.FlashOutline -> session.flashOutline(fx.ringId)
      VisitorEffect.ResetAveragers -> {
        session.resetLocks()
        gather = GatherStatus.NONE_IN_VIEW
      }
      is VisitorEffect.SetRegistered -> setRegistered(fx.ids)
      is VisitorEffect.ShowSpacePage -> ui.spacePage = SpacePageInfo(fx.code, null, null)
      VisitorEffect.CloseSpacePage -> ui.spacePage = null
    }
  }

  private fun lookup(code: String) {
    scope.launch {
      val r =
          try {
            lookup.invoke(code)
          } catch (e: CancellationException) {
            throw e
          } catch (e: Exception) {
            Log.e(TAG, "Lookup failed", e)
            ApiResult.Failed(-1)
          }
      dispatch(VisitorEvent.Lookup(code, r))
      // Only a lookup the flow accepted counts; one it dropped as superseded is neither a visit nor the page's space.
      val accepted = (flow.state as? VisitorState.Loading)?.let { it.code == code && it.spaceName != null } == true
      if (r is ApiResult.Ok && accepted) {
        visited(code, r.value.spaceName)
        ui.spacePage = ui.spacePage?.takeIf { it.code == code }?.copy(spaceName = r.value.spaceName, whereText = r.value.whereText)
            ?: ui.spacePage
        refreshUi()
      }
    }
  }

  /** Puts the space first in the recent list and saves it. */
  private fun visited(code: String, spaceName: String) {
    val list = remember(ui.recentSpaces, RecentSpace(code, spaceName, System.currentTimeMillis()))
    ui.recentSpaces = list
    prefs.recentSpaces = list
  }

  private fun refreshUi() {
    if (paused) return
    val st = flow.state
    ui.spacePage = spacePageFor(ui.spacePage, st)
    ui.spaceProblem = if (ui.spacePage?.spaceName == null) (st as? VisitorState.Failed)?.message else null
    val now = clock()
    val device =
        when {
          askingPermissions -> DeviceProblem.ASKING_PERMISSIONS
          cameraDenied -> DeviceProblem.NO_CAMERA_PERMISSION
          spatialDenied -> DeviceProblem.NO_SPATIAL_PERMISSION
          roomScanMissing -> DeviceProblem.NO_ROOM_SCAN
          else -> null
        }
    ui.hint = hintText(st, gather, unreadableSince?.let { now - it } ?: 0L, device)
    ui.sceneShown = st is VisitorState.Shown
    // The BEAT card (and its check-ins) belong to the space while its scene is shown, and to no other state
    beats.spaceShown((st as? VisitorState.Shown)?.space?.id)
    ui.menuButtonShown = menuButtonShown(st, flow.spaceChosen)
    ui.reportSpaceId = flow.reportSpaceId
    ui.visitorState = st::class.simpleName ?: ""
    ui.itemCount = session.itemCount()
  }

  private fun Vector3.vec() = Vec3(x.toDouble(), y.toDouble(), z.toDouble())

  companion object {
    private const val TAG = "VirviAR"
    private const val FLUSH_INTERVAL_MS = 10_000L
    /** A camera frame older than this (camera stalled or stopped) shows no rings. */
    private const val STALE_NS = 250_000_000L
  }
}
