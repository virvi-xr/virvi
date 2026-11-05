package io.virvi.ar

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

/**
 * Scheduled showings on a video screen (LIV-87), a port of packages/shared src/showings.ts: everyone works out the same
 * moment of the same video from the show's start instant (UTC ms) and the server's clock, so a visitor who walks in
 * mid-film joins where everyone else is. The server applies hosts' delays and early ends before sending the shows.
 */
data class ProgrammeItem(val url: String, val duration: Double, val kind: String = "video")

data class ShowingInstance(val showingId: String, val startsAt: Long, val items: List<ProgrammeItem>, val title: String? = null)

sealed class ScreenState {
  /** [offset] is seconds into [item]; [itemStartsAt] (UTC ms) is when [item] began, the same for every frame of it. */
  data class Playing(val showing: ShowingInstance, val item: ProgrammeItem, val index: Int, val offset: Double, val itemStartsAt: Long) : ScreenState()

  /** [startsIn] is seconds until [next], or null with nothing scheduled. */
  data class Between(val next: ShowingInstance?, val startsIn: Double?) : ScreenState()
}

private fun playable(d: Double) = d.isFinite() && d > 0

/** What a scheduled screen shows at server time [now] (UTC ms). If showings overlap, the later start wins. */
fun screenStateAt(showings: List<ShowingInstance>, now: Long): ScreenState {
  val sorted = showings.sortedBy { it.startsAt }
  fun nextAfter(t: Long) = sorted.firstOrNull { it.startsAt > t }
  for (showing in sorted.asReversed()) {
    if (showing.startsAt > now) continue
    val elapsed = (now - showing.startsAt) / 1000.0
    var start = 0.0
    showing.items.forEachIndexed { index, item ->
      if (!playable(item.duration)) return@forEachIndexed
      if (elapsed < start + item.duration) {
        return ScreenState.Playing(showing, item, index, elapsed - start, showing.startsAt + Math.round(start * 1000))
      }
      start += item.duration
    }
    break // the most recent showing has ended
  }
  val next = nextAfter(now)
  return ScreenState.Between(next, next?.let { (it.startsAt - now) / 1000.0 })
}

private fun JsonElement?.prim(): JsonPrimitive? = this as? JsonPrimitive

private fun parseItem(e: JsonElement): ProgrammeItem? {
  val o = e as? JsonObject ?: return null
  val url = o["url"].prim()?.takeIf { it.isString }?.content ?: return null
  val duration = o["duration"].prim()?.takeIf { !it.isString }?.doubleOrNull ?: return null
  val kind = o["kind"].prim()?.takeIf { it.isString }?.content ?: "video"
  return ProgrammeItem(url, duration, kind)
}

private fun parseInstance(e: JsonElement): ShowingInstance? {
  val o = e as? JsonObject ?: return null
  val id = o["showingId"].prim()?.takeIf { it.isString }?.content ?: return null
  val startsAt = o["startsAt"].prim()?.takeIf { !it.isString }?.longOrNull ?: return null
  val items = (o["items"] as? JsonArray)?.mapNotNull(::parseItem) ?: return null
  return ShowingInstance(id, startsAt, items, o["title"].prim()?.takeIf { it.isString }?.content)
}

/** The feed's `showings` (`[{ elementId, showings }]`) by screen element id; malformed entries are dropped. */
fun parseShowings(e: JsonElement?): Map<String, List<ShowingInstance>> {
  val out = mutableMapOf<String, List<ShowingInstance>>()
  for (entry in (e as? JsonArray) ?: return out) {
    val o = entry as? JsonObject ?: continue
    val id = o["elementId"].prim()?.takeIf { it.isString }?.content ?: continue
    out[id] = (o["showings"] as? JsonArray)?.mapNotNull(::parseInstance) ?: continue
  }
  return out
}

/** A scheduled screen's video: it began at [itemStartsAtMs] (UTC ms) and runs [durationS]. Players start where the show is. */
data class ScheduledPlay(val itemStartsAtMs: Long, val durationS: Double)

/**
 * The plan with each Schedule-mode screen as it is at server time [now]: the programme's video (with where it began,
 * which stays the same while it plays, so the plan only changes when the show moves on), else the holding image, else
 * nothing. A video the headset can't play counts as between shows. Other items pass through.
 */
fun resolveScheduled(plan: List<RenderItem>, showings: Map<String, List<ShowingInstance>>, now: Long): List<RenderItem> =
    plan.mapNotNull { item ->
      if (!item.scheduled) return@mapNotNull item
      val state = screenStateAt(showings[item.key.substringBefore(':')] ?: emptyList(), now)
      if (state is ScreenState.Playing && extOf(state.item.url) in VIDEO_EXT) {
        return@mapNotNull item.copy(kind = RenderItem.Kind.VIDEO, src = state.item.url, loop = false, play = ScheduledPlay(state.itemStartsAt, state.item.duration))
      }
      item.holdingImage?.let { item.copy(kind = RenderItem.Kind.IMAGE, src = it, loop = false, volume = 0.0, play = null) }
    }

/**
 * When to move a scheduled video back to where the show is, with Decentraland's and Hyperfy's guards: a player that has
 * slipped more than 2 s, checked at most every 5 s, 30 s after its last start or seek, 3 times per video, never in a
 * video's last 10 s. Times in ms of any one clock; positions in seconds.
 */
class SeekGuard(startedAt: Long) {
  private var seekAt = startedAt
  private var checkAt = startedAt
  private var seeks = 0

  fun shouldSeek(now: Long, expected: Double, actual: Double, duration: Double, playing: Boolean): Boolean {
    if (!playing) return false
    if (now - checkAt < DRIFT_CHECK_MS || now - seekAt < SETTLE_MS) return false
    if (seeks >= MAX_RESEEKS || duration - expected < MIN_LEFT_S) return false
    checkAt = now
    if (Math.abs(expected - actual) <= TOLERANCE_S) return false
    seeks++
    seekAt = now
    return true
  }

  /** Playback restarted at the right place (shown again, back from the background): a fresh settle, same tries. */
  fun restarted(now: Long) {
    seekAt = now
  }

  companion object {
    const val DRIFT_CHECK_MS = 5_000L
    const val SETTLE_MS = 30_000L
    const val MAX_RESEEKS = 3
    const val MIN_LEFT_S = 10.0
    const val TOLERANCE_S = 2.0
  }
}
