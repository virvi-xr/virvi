package io.virvi.ar.builder

import io.virvi.ar.Vec3
import io.virvi.ar.api.ArFloor
import io.virvi.ar.api.BuilderCall
import io.virvi.ar.api.MarkerPose
import io.virvi.ar.space.RootPose
import io.virvi.ar.space.angleDiffDeg
import io.virvi.ar.space.markerInScene
import java.util.Locale
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.roundToInt

/** A ring may be recorded only within this straight-line distance of the last ring the scene was anchored from (keeps drift small). */
const val RECORD_RADIUS_M = 4.0

/** A ring check warns above this distance (m) or this turn (degrees). */
private const val WARN_DISTANCE_M = 0.05
private const val WARN_HEADING_DEG = 1.0

/** How far a ring is from its recorded pose: [distanceM] in 3-D and [headingDeg] as an absolute turn. */
data class CheckResult(val distanceM: Double, val headingDeg: Double, val warn: Boolean)

/** Compares the ring [measured] (in scene coordinates) with its [expected] recorded pose. */
fun checkRing(expected: MarkerPose, measured: MarkerPose): CheckResult {
  val d = hypot(hypot(measured.x - expected.x, measured.y - expected.y), measured.z - expected.z)
  val a = abs(angleDiffDeg(measured.headingDeg, expected.headingDeg))
  return CheckResult(d, a, d > WARN_DISTANCE_M || a > WARN_HEADING_DEG)
}

/** Whether a ring at [ringWorld] is near enough to [lastAnchorWorld] to record (within [RECORD_RADIUS_M], straight line). */
fun mayRecord(ringWorld: Vec3, lastAnchorWorld: Vec3): Boolean =
    hypot(hypot(ringWorld.x - lastAnchorWorld.x, ringWorld.y - lastAnchorWorld.y), ringWorld.z - lastAnchorWorld.z) <= RECORD_RADIUS_M

/** The ring check copy: [d] to whole centimetres, [a] to one decimal. */
fun checkLine(result: CheckResult): String {
  val cm = (result.distanceM * 100).roundToInt()
  val deg = String.format(Locale.ROOT, "%.1f", result.headingDeg)
  return "This ARC is $cm cm and $deg° from where it should be"
}

/** A steady ring of the current floor in view: which one, its averaged world position and wall heading. */
data class RingInView(val ringId: Long, val world: Vec3, val headingDeg: Double)

enum class RingButton { None, Record, ReRecord }

/**
 * What the panel shows for the ring in view; [line] and [suggestion] are null when there is nothing to say.
 * [refusal] is why a ring that is off can't be re-recorded from here ([RingCheckCopy.TOO_FAR]), else null.
 */
data class RingCheckView(
    val button: RingButton,
    val line: String?,
    val warn: Boolean,
    val suggestion: String?,
    val refusal: String? = null,
)

/**
 * The record / check / re-record journey for the other rings of one floor, with no view or I/O. [view] says what the
 * panel shows; [requestSave] gives the pose to send for the ring in view (through `BuilderApi.savePose`, as alignment
 * does), and [saved] takes the answer. The floor is fixed for the flow's life: once a save lands, make a new flow from
 * the feed's newer floor, passing the old [status] on. Main thread only.
 */
class RingCheckFlow(private val floor: ArFloor, status: String? = null) {
  /** The save's progress copy, or null: "Saving…", "ARC saved" or a refusal. */
  var status: String? = status
    private set

  fun view(root: RootPose, lastAnchorWorld: Vec3, ring: RingInView): RingCheckView {
    val marker = floor.markers.firstOrNull { it.ringId == ring.ringId } ?: return RingCheckView(RingButton.None, null, false, null)
    val suggestion = if (floor.markers.size == 1) RingCheckCopy.ADD_SECOND_RING else null
    val expected = marker.pose
    if (expected == null) {
      return if (mayRecord(ring.world, lastAnchorWorld)) RingCheckView(RingButton.Record, null, false, suggestion)
      else RingCheckView(RingButton.None, RingCheckCopy.TOO_FAR, false, suggestion)
    }
    val result = checkRing(expected, markerInScene(root, ring.world, ring.headingDeg))
    if (!result.warn) return RingCheckView(RingButton.None, checkLine(result), false, suggestion)
    // Far from the anchor, the difference may be the drift itself: re-recording would save it as the ring's pose.
    return if (mayRecord(ring.world, lastAnchorWorld)) RingCheckView(RingButton.ReRecord, checkLine(result), true, suggestion)
    else RingCheckView(RingButton.None, checkLine(result), true, suggestion, RingCheckCopy.TOO_FAR)
  }

  /**
   * Starts saving the ring in view: its pose in the scene and its height above the floor (the world `y`, as in
   * [AlignFlow]). Null when it is not on this floor, or when it is out of recording range ([RECORD_RADIUS_M] from
   * the last anchor), for Record and Re-record alike: drift grows with distance from the anchor.
   */
  fun requestSave(root: RootPose, lastAnchorWorld: Vec3, ring: RingInView): AlignSave? {
    if (status == RingCheckCopy.SAVING) return null
    val marker = floor.markers.firstOrNull { it.ringId == ring.ringId } ?: return null
    if (!mayRecord(ring.world, lastAnchorWorld)) {
      status = RingCheckCopy.TOO_FAR
      return null
    }
    status = RingCheckCopy.SAVING
    return AlignSave(markerInScene(root, ring.world, ring.headingDeg), ring.world.y)
  }

  fun saved(result: BuilderCall<List<String>>) {
    status =
        when (result) {
          is BuilderCall.Ok -> RingCheckCopy.SAVED
          BuilderCall.NoAccess -> AlignCopy.NO_ACCESS
          BuilderCall.Offline -> AlignCopy.OFFLINE
          else -> RingCheckCopy.SAVE_FAILED
        }
  }
}

object RingCheckCopy {
  const val TOO_FAR = "Too far from the last ARC to record accurately: walk back, or align from this ARC instead"
  const val ADD_SECOND_RING = "Add a second ARC on this floor so visitors stay lined up"
  const val SAVING = "Saving…"
  const val SAVED = "ARC saved"
  const val SAVE_FAILED = "Couldn't save the ARC: try again"
}
