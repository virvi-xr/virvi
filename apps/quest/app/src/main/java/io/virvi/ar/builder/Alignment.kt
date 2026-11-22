package io.virvi.ar.builder

import io.virvi.ar.Vec3
import io.virvi.ar.api.BuilderCall
import io.virvi.ar.api.MarkerPose
import io.virvi.ar.ring.WallPlane
import io.virvi.ar.ring.wallHitsAlongRay
import io.virvi.ar.space.RootPose
import io.virvi.ar.space.markerInScene
import io.virvi.ar.space.rootFromMarker
import io.virvi.ar.space.rotateY
import io.virvi.ar.visitor.VisitorTuning
import java.util.Locale
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.roundToInt
import kotlin.math.sin

/** Where the scene starts on a floor's first visit: the ring at the middle of its north wall, facing into the scene. */
private const val DEFAULT_RING_X = 8.0

/** A printed ring's size is checked to this (the share it is off, 1/ratio − 1). */
private const val SIZE_TOLERANCE = 0.03

/**
 * The first visit's starting spot: the ring seen at [markerWorld] facing [headingWorldDeg] is at scene point
 * `(8, floorHeightM + markerHeightAboveFloorM, 0)` facing +Z (the scene's north wall centre, facing in).
 */
fun defaultRoot(markerWorld: Vec3, headingWorldDeg: Double, floorHeightM: Double, markerHeightAboveFloorM: Double): RootPose =
    rootFromMarker(markerWorld, headingWorldDeg, MarkerPose(DEFAULT_RING_X, floorHeightM + markerHeightAboveFloorM, 0.0, 0.0))

/**
 * [root] moved by ([dx], [dz]) in world metres and turned [dYawDeg] about the world point [pivot] (the ring), so the
 * ring keeps its scene position and only its scene heading changes, by −[dYawDeg].
 */
fun nudge(root: RootPose, dx: Double, dz: Double, dYawDeg: Double, pivot: Vec3): RootPose {
  val d = Vec3(root.position.x - pivot.x, root.position.y - pivot.y, root.position.z - pivot.z)
  val r = rotateY(dYawDeg, d)
  return RootPose(Vec3(pivot.x + r.x + dx, root.position.y, pivot.z + r.z + dz), root.yawDeg + dYawDeg)
}

/**
 * The ellipse range (from the recorded diameter) over the depth range (from the room scan). A print scaled by `s`
 * reads `1/s` as far by its size, so a ratio above 1 means the print is smaller than recorded.
 */
fun sizeRatio(rangeFromEllipseM: Double, rangeFromDepthM: Double): Double = rangeFromEllipseM / rangeFromDepthM

/** The printed-size copy for [ratio] (see [sizeRatio]), or null when it is within 3% or not a usable number. */
fun sizeWarning(ratio: Double): String? {
  if (!ratio.isFinite() || ratio <= 0.0) return null
  val off = abs(1.0 / ratio - 1.0)
  if (off <= SIZE_TOLERANCE) return null
  val n = (off * 100).roundToInt()
  val how = if (ratio > 1.0) "smaller" else "larger"
  return "This ARC looks about $n% $how than its recorded size: was it printed at 100%?"
}

/**
 * The depth range for the printed-size check: from [origin] (the camera) along the ray through [ring] to the plane of
 * the scanned wall the ray hits behind or in front of it (see [wallHitsAlongRay]; the nearest hit), or null when there
 * is none. The ray, not [ring] itself, picks the wall: a print off size puts [ring] off its wall along the ray.
 */
fun depthRange(origin: Vec3, ring: Vec3, walls: List<WallPlane>): Double? = wallHitsAlongRay(origin, ring, walls).firstOrNull()?.t

/** One thumbstick reading's worth of change: world metres and degrees of turn (see [stickNudge]). */
data class StickNudge(val dx: Double, val dz: Double, val dYawDeg: Double)

private const val STICK_DEADZONE = 0.5
private const val FINE_STEP_M = 0.01
private const val FINE_STEP_DEG = 0.5
/** Without the grip a step is this many times the fine one. */
private const val COARSE_FACTOR = 5.0

/**
 * One step from the sticks: the left stick ([leftX] right, [leftY] forward) moves the scene in the direction the
 * head faces ([headHeadingDeg], from +Z toward +X), the right stick's [rightX] turns it. Each axis past the dead zone
 * is one step: 1 cm and 0.5° with the grip held ([fine]), five times that without.
 */
fun stickNudge(leftX: Double, leftY: Double, rightX: Double, headHeadingDeg: Double, fine: Boolean): StickNudge {
  val k = if (fine) 1.0 else COARSE_FACTOR
  val side = if (abs(leftX) > STICK_DEADZONE) Math.signum(leftX) else 0.0
  val fwd = if (abs(leftY) > STICK_DEADZONE) Math.signum(leftY) else 0.0
  val turn = if (abs(rightX) > STICK_DEADZONE) Math.signum(rightX) else 0.0
  val h = Math.toRadians(headHeadingDeg)
  // Forward is (sin h, cos h) on (x, z); right is (cos h, −sin h).
  return StickNudge(
      dx = (fwd * sin(h) + side * cos(h)) * FINE_STEP_M * k,
      dz = (fwd * cos(h) - side * sin(h)) * FINE_STEP_M * k,
      dYawDeg = turn * FINE_STEP_DEG * k,
  )
}

/** A steady ring as the align flow sees it: its averaged world position and wall heading, and its distance from the head. */
data class RingSight(val world: Vec3, val headingDeg: Double, val distanceM: Double)

/** What the builder sends to save an alignment. */
data class AlignSave(val pose: MarkerPose, val heightAboveFloorM: Double)

sealed interface AlignState {
  /** Waiting for the ring to be steady and within reach. */
  data object LookAtRing : AlignState
  /** The scene is up at [root] for the builder to adjust. */
  data class Placed(val root: RootPose) : AlignState
  data object Saving : AlignState
  /** Saved; [warnings] are the server's codes (see [AlignFlow.warningLines]). */
  data class Saved(val warnings: List<String>) : AlignState
  /** The last step was refused ([reason] is copy); the scene, if placed, can still be adjusted and saved. */
  data class Refused(val reason: String) : AlignState
}

/**
 * The align journey for one floor's ring, with no view or I/O: the caller feeds it the ring's steady sights, the sticks
 * and the save answer, and shows [state]. The height above the floor is the ring's world `y`, since the app runs in
 * LOCAL_FLOOR space. Main thread only.
 */
class AlignFlow(private val floorName: String, private val floorHeightM: Double) {
  var state: AlignState = AlignState.LookAtRing
    private set

  /** The printed-size warning, once [checkSize] has found one. */
  var sizeMessage: String? = null
    private set

  private var ring: RingSight? = null
  private var root: RootPose? = null
  private var sizeChecked = false
  private var nudged = false

  /**
   * A steady sight of the ring: the first one within reach places the scene at [defaultRoot]. Later ones refresh the
   * placement until the builder first nudges it, which fixes the ring where it was.
   */
  fun onSteadyRing(sight: RingSight) {
    if (sight.distanceM > VisitorTuning.MAX_LOCK_DISTANCE_M) return
    if (state != AlignState.LookAtRing && !(state is AlignState.Placed && !nudged)) return
    ring = sight
    val r = defaultRoot(sight.world, sight.headingDeg, floorHeightM, sight.world.y)
    root = r
    state = AlignState.Placed(r)
  }

  /** Moves and turns the scene about the ring (see [nudge]); does nothing before the scene is placed or while saving. */
  fun nudge(dx: Double, dz: Double, dYawDeg: Double) {
    val r = ring ?: return
    val cur = root ?: return
    if (state is AlignState.Saving || state is AlignState.Saved) return
    val next = nudge(cur, dx, dz, dYawDeg, r.world)
    nudged = true
    root = next
    state = AlignState.Placed(next)
  }

  /**
   * Starts a save with the head at [head]: the pose to send, or null when the scene isn't placed or the head is
   * beyond [VisitorTuning.MAX_LOCK_DISTANCE_M] of the ring (then [state] is Refused with [AlignCopy.STEP_CLOSER]).
   */
  fun requestSave(head: Vec3): AlignSave? {
    val r = ring ?: return null
    val cur = root ?: return null
    if (state is AlignState.Saving || state is AlignState.Saved) return null
    val dx = head.x - r.world.x
    val dy = head.y - r.world.y
    val dz = head.z - r.world.z
    if (hypot(hypot(dx, dy), dz) > VisitorTuning.MAX_LOCK_DISTANCE_M) {
      state = AlignState.Refused(AlignCopy.STEP_CLOSER)
      return null
    }
    state = AlignState.Saving
    return AlignSave(markerInScene(cur, r.world, r.headingDeg), r.world.y)
  }

  /** The answer to the save [requestSave] started. */
  fun saved(result: BuilderCall<List<String>>) {
    state =
        when (result) {
          is BuilderCall.Ok -> AlignState.Saved(result.value)
          BuilderCall.NoAccess -> AlignState.Refused(AlignCopy.NO_ACCESS)
          BuilderCall.Offline -> AlignState.Refused(AlignCopy.OFFLINE)
          else -> AlignState.Refused(AlignCopy.SAVE_FAILED)
        }
  }

  /**
   * The printed-size check, once per alignment: [rangeFromEllipseM] over [rangeFromDepthM] (null when the room scan
   * has no wall behind the ring, which leaves the check for a later try).
   */
  fun checkSize(rangeFromEllipseM: Double, rangeFromDepthM: Double?) {
    if (sizeChecked || rangeFromDepthM == null || rangeFromDepthM <= 0.0) return
    sizeChecked = true
    sizeMessage = sizeWarning(sizeRatio(rangeFromEllipseM, rangeFromDepthM))
  }

  /** The copy for the saved warnings this app knows; others are not shown. */
  fun warningLines(): List<String> =
      (state as? AlignState.Saved)?.warnings.orEmpty().mapNotNull {
        if (it == FLOOR_HEIGHT_OFF) "Floor height doesn't match $floorName (${metres(floorHeightM)} m): check the floor" else null
      }

  private fun metres(h: Double) = String.format(Locale.ROOT, "%.2f", h).trimEnd('0').trimEnd('.')

  private companion object {
    const val FLOOR_HEIGHT_OFF = "floor_height_off"
  }
}

/** The align flow's refusal copy in one place. [OFFLINE] and [SAVE_FAILED] are new (the owner may reword them). */
object AlignCopy {
  const val STEP_CLOSER = "Step closer to the ARC to save"
  const val NO_ACCESS = "This account can't edit this scene"
  const val OFFLINE = "Can't reach virvi.io: check the connection and save again"
  const val SAVE_FAILED = "Couldn't save the alignment: try again"
}
