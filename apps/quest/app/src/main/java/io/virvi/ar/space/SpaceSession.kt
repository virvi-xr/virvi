package io.virvi.ar.space

import android.util.Log
import com.meta.spatial.core.Pose
import com.meta.spatial.core.Vector3
import io.virvi.ar.RenderItem
import io.virvi.ar.Vec3
import io.virvi.ar.api.ArFeedSnapshot
import io.virvi.ar.api.FeedStatus
import io.virvi.ar.planScene
import io.virvi.ar.resolveScheduled
import io.virvi.ar.ring.CameraIntrinsics
import io.virvi.ar.ring.RingDetection
import io.virvi.ar.ring.WallPlane
import io.virvi.ar.ring.cameraToWorld
import io.virvi.ar.ring.circleNormals
import io.virvi.ar.ring.circleTiltDeg
import io.virvi.ar.ring.markerInCamera
import io.virvi.ar.ring.wallFix
import io.virvi.ar.visitor.Gate
import io.virvi.ar.visitor.LockStep
import io.virvi.ar.visitor.RingLock
import io.virvi.ar.visitor.lockHeading

/** Draws a space's scene (the headset's `SceneRenderer`; a fake in tests). */
interface SceneView {
  fun apply(next: List<RenderItem>)

  fun setRoot(pose: RootPose)

  fun setVisible(on: Boolean, nowMs: Long)

  fun hideNow()

  fun clear()

  fun tick(nowMs: Long)

  fun count(): Int

  /** The server's clock minus the headset's wall clock (ms), for scheduled showings (LIV-87). */
  fun setServerOffset(offsetMs: Long) {}
}

/** Follows one space's feed (`ArFeed`; a fake in tests). */
interface SpaceFeed {
  fun start(spaceId: String, token: (() -> String?)? = null)

  fun stop()
}

/** The outline flashed on a ring when the scene locks on (`RingOutline`; a fake in tests). */
interface OutlineView {
  fun flash(world: Vec3, headingDeg: Double, diameterM: Double, nowMs: Long)

  fun tick(nowMs: Long)

  fun clear()
}

/** A ring's averaged world position and wall heading, on a frame its lock was STEADY. */
data class SteadyPose(val world: Vec3, val headingDeg: Double)

/**
 * One space on the headset, whoever is looking at it (visitor or builder): its feed and latest snapshot, its scene
 * (root, items, fade), the lock tracks of its rings in view, the ring outline, and where the scene is placed. It knows
 * nothing of the visitor's journey: the caller decides when to place, show and hide. [feed] builds the feed from the
 * session's own status and snapshot callbacks. Main thread only.
 */
class SpaceSession(
    private val view: SceneView,
    feed: (onStatus: (FeedStatus) -> Unit, onSnapshot: (ArFeedSnapshot) -> Unit) -> SpaceFeed,
    private val outline: OutlineView,
    private val clock: () -> Long,
    /** The headset's wall clock (UTC ms); the server's is this plus the offset its last answer showed. */
    private val wallClock: () -> Long = System::currentTimeMillis,
) {
  /** A new snapshot of the running space, after its scene has been applied. */
  var onSnapshot: ((ArFeedSnapshot) -> Unit)? = null
  var onStatus: ((FeedStatus) -> Unit)? = null
  /** A ring of the space has just become steady (see [RingLock]). */
  var onSteady: ((ringId: Long, world: Vec3, headingDeg: Double) -> Unit)? = null

  private val feed = feed({ s -> onStatus?.invoke(s) }, ::snapshotArrived)

  /** The space whose feed is running, or null. */
  var spaceId: String? = null
    private set

  private var snapshot: ArFeedSnapshot? = null
  /** The scene's plan as the feed gives it, and what was last applied (scheduled screens resolved to what's on). */
  private var basePlan: List<RenderItem> = emptyList()
  private var applied: List<RenderItem>? = null
  private var serverOffsetMs = 0L
  private var root: RootPose? = null
  /** The space's rings in view, and each one's step on the newest frame. */
  private val tracks = HashMap<Long, RingLock>()
  private val lastSteps = HashMap<Long, LockStep>()
  /** Where each ring last became steady, for its outline. */
  private val lockedAt = HashMap<Long, SteadyPose>()

  /** Follows [spaceId]'s feed, sending [token]'s answer (if any) with each request. */
  fun start(spaceId: String, token: (() -> String?)? = null) {
    this.spaceId = spaceId
    snapshot = null
    basePlan = emptyList()
    applied = null
    feed.start(spaceId, token)
  }

  /** Stops the feed and drops the space: its snapshot, rings, outline, placement and scene (video players included). */
  fun stop() {
    feed.stop()
    spaceId = null
    snapshot = null
    basePlan = emptyList()
    applied = null
    root = null
    resetLocks()
    lockedAt.clear()
    outline.clear()
    view.clear()
  }

  /** The running space's latest snapshot, or null before its first. */
  fun snapshot(): ArFeedSnapshot? = snapshot

  /** An exception in here would end the feed's loop silently, so it's caught and logged. */
  private fun snapshotArrived(s: ArFeedSnapshot) {
    try {
      if (s.space.id != spaceId) return
      snapshot = s
      basePlan = planScene(s.scene)
      s.serverTime?.let {
        serverOffsetMs = it - wallClock()
        view.setServerOffset(serverOffsetMs)
      }
      applied = null
      applyPlan()
      onSnapshot?.invoke(s)
    } catch (e: Exception) {
      Log.e(TAG, "Snapshot ${s.version} failed", e)
    }
  }

  /**
   * One camera frame's trusted rings, with the head pose, the camera's intrinsics and the room's walls: steps the lock
   * of each of the space's rings in view (others are ignored) and returns their steps. A ring that has just become
   * steady is reported to [onSteady] as it is stepped.
   */
  fun onRings(tracked: List<RingDetection>, head: Pose, k: CameraIntrinsics?, walls: List<WallPlane>): List<LockStep> {
    val now = clock()
    val seen = tracked.associateBy { it.id }
    tracks.keys.retainAll(seen.keys)
    lastSteps.keys.retainAll(seen.keys)
    val space = snapshot?.space
    val steps = ArrayList<LockStep>()
    for ((id, d) in seen) {
      val marker = space?.markerByRing(id)?.second
      if (marker == null || k == null) {
        lastSteps.remove(id) // so steadyPoses() is this frame's alone
        continue
      }
      val w = cameraToWorld(markerInCamera(d, k, marker.diameterMm / 1000.0), head, k)
      // An ambiguous corner seen steeply is also told where to stand.
      val lh = lockHeading(wallFix(w, walls, head.t, circleNormals(d, k, head)), circleTiltDeg(d))
      val step = tracks.getOrPut(id) { RingLock() }.step(w.vec(), lh.headingDeg, head.t.vec(), now, lh.steep)
      steps += step
      lastSteps[id] = step
      if (step.becameSteady) {
        lockedAt[id] = SteadyPose(step.world, step.headingDeg!!)
        onSteady?.invoke(id, step.world, step.headingDeg)
      }
    }
    return steps
  }

  /** Forgets the rings in view: each must gather a steady pose afresh. */
  fun resetLocks() {
    tracks.clear()
    lastSteps.clear()
  }

  /** The averaged poses of the space's rings that were steady on the newest frame. */
  fun steadyPoses(): Map<Long, SteadyPose> =
      lastSteps.filterValues { it.gate == Gate.STEADY }.mapValues { (_, s) -> SteadyPose(s.world, s.headingDeg!!) }

  /** Places the scene: its origin at `root.position`, turned `root.yawDeg` about +Y. */
  fun setRoot(root: RootPose) {
    this.root = root
    view.setRoot(root)
  }

  /** Where the scene is placed while it is shown; null before it is placed and once it is hidden. */
  fun rootOf(): RootPose? = root

  /** Fades the scene in. */
  fun show() = view.setVisible(true, clock())

  /** Fades the scene out. */
  fun hide() {
    view.setVisible(false, clock())
    root = null
    outline.clear()
  }

  /** Hides the scene at once, without a fade (it is in the wrong place). */
  fun hideNow() {
    view.hideNow()
    root = null
    outline.clear()
  }

  /** Flashes the outline on [ringId] where it last became steady, if it has and is one of the space's rings. */
  fun flashOutline(ringId: Long) {
    val at = lockedAt[ringId] ?: return
    val marker = snapshot?.space?.markerByRing(ringId)?.second ?: return
    outline.flash(at.world, at.headingDeg, marker.diameterMm / 1000.0, clock())
  }

  /** Applies the plan with scheduled screens as they are now; only a change reaches the view. */
  private fun applyPlan() {
    val next = if (basePlan.any { it.scheduled }) resolveScheduled(basePlan, snapshot?.showings ?: emptyMap(), wallClock() + serverOffsetMs) else basePlan
    if (next == applied) return
    applied = next
    view.apply(next)
  }

  /** Advances the fade and the outline, and moves scheduled screens on with the show; call every frame. */
  fun tick() {
    if (basePlan.any { it.scheduled }) applyPlan()
    val now = clock()
    view.tick(now)
    outline.tick(now)
  }

  /** How many items the scene has. */
  fun itemCount(): Int = view.count()

  private fun Vector3.vec() = Vec3(x.toDouble(), y.toDouble(), z.toDouble())

  private companion object {
    const val TAG = "VirviAR"
  }
}
