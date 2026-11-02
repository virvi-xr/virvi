package io.virvi.ar

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

/**
 * Port of packages/hyperfy-app/src/plan.ts (by way of the Swift spike's ScenePlan.swift): which nodes to show
 * for a Virvi scene snapshot. The scene is untyped JSON, so the JS `typeof` checks are mirrored by hand.
 */
data class RenderItem(
    /** "$elementSk:$instanceSk" */
    val key: String,
    /** The element's name in Virvi, or the media file name when it has none. */
    val name: String,
    val kind: Kind,
    /** For video, image and model, the URL to show; for audio, the sound. */
    val src: String,
    val loop: Boolean,
    val volume: Double,
    val width: Double,
    val height: Double,
    val transform: MappedTransform,
    val clickUrl: String?,
    /**
     * Playlist mode only (else empty): the videos to play in turn, starting with [src], back to the first after the
     * last. With one video, [loop] repeats it instead.
     */
    val playlist: List<String> = emptyList(),
) {
  enum class Kind { VIDEO, IMAGE, MODEL, AUDIO }
}

/** The formats the headset draws (shared with the Assets tab). */
internal val VIDEO_EXT = setOf("mp4", "m3u8")
internal val IMAGE_EXT = setOf("png", "jpg", "jpeg", "webp")
private const val CLICK_NONE = 0.0
private const val CLICK_EXTERNAL = 1.0
private const val OFF_IMAGE = 1.0
private const val OFF_PLAYLIST = 2.0

// ── JS-ish value helpers ─────────────────────────────────────────────

private fun JsonElement?.obj(): JsonObject? = this as? JsonObject

private fun JsonElement?.arr(): List<JsonElement> = (this as? JsonArray) ?: emptyList()

/** `typeof v === 'number' && Number.isFinite(v)` */
private fun number(v: JsonElement?): Double? {
  val p = v as? JsonPrimitive ?: return null
  if (p.isString || p is JsonNull || p.booleanOrNull != null) return null
  return p.doubleOrNull?.takeIf { it.isFinite() }
}

/** `v === false` */
private fun isFalse(v: JsonElement?): Boolean {
  val p = v as? JsonPrimitive ?: return false
  return !p.isString && p.booleanOrNull == false
}

/** JS truthiness. */
private fun truthy(v: JsonElement?): Boolean =
    when {
      v == null || v is JsonNull -> false
      v is JsonPrimitive && v.isString -> v.content.isNotEmpty()
      v is JsonPrimitive && v.booleanOrNull != null -> v.booleanOrNull!!
      v is JsonPrimitive -> v.doubleOrNull?.let { it != 0.0 && !it.isNaN() } ?: false
      else -> true
    }

private fun nonEmptyString(v: JsonElement?): String? {
  val p = v as? JsonPrimitive ?: return null
  return if (p.isString && p.content.isNotEmpty()) p.content else null
}

/** What a JS template literal prints for an `sk`. */
private fun templateString(v: JsonElement?): String {
  if (v == null) return "undefined"
  if (v is JsonNull) return "null"
  if (v is JsonPrimitive && v.isString) return v.content
  number(v)?.let { d -> return if (d == Math.rint(d) && Math.abs(d) < 1e15) d.toLong().toString() else d.toString() }
  return v.toString()
}

/** Extension of the URL's path, lowercased; "" when there is none. */
fun extOf(src: String): String {
  val path = src.split('?', '#').first()
  val dot = path.lastIndexOf('.')
  if (dot < 0) return ""
  val ext = path.substring(dot + 1)
  if (ext.isEmpty() || !ext.all { it.code < 128 && it.isLetterOrDigit() }) return ""
  return ext.lowercase()
}

private fun supported(src: JsonElement?, exts: Set<String>): String? =
    nonEmptyString(src)?.takeIf { extOf(it) in exts }

private fun vec(v: JsonElement?, fallback: Double): Vec3 {
  val o = v.obj()
  return Vec3(number(o?.get("x")) ?: fallback, number(o?.get("y")) ?: fallback, number(o?.get("z")) ?: fallback)
}

private fun externalUrl(click: JsonElement?): String? {
  val c = click.obj() ?: return null
  if (number(c["type"]) != CLICK_EXTERNAL) return null
  return nonEmptyString(c["externalLink"])
}

/** An instance's click applies only when it has a type other than NONE; otherwise the element's does. */
private fun clickOf(inst: JsonObject, el: JsonObject): JsonElement? {
  val own = inst["clickEvent"].obj()
  val t = number(own?.get("type"))
  if (own != null && t != null && t != CLICK_NONE) return own
  return el["clickEvent"]
}

private data class Media(
    val kind: RenderItem.Kind,
    val src: String,
    val loop: Boolean,
    val playlist: List<String> = emptyList(),
)

private fun videoMedia(el: JsonObject): Media? {
  val live = nonEmptyString(el["liveSrc"])
  if (truthy(el["isLive"]) && truthy(el["enableLiveStream"]) && live != null) {
    return supported(JsonPrimitive(live), VIDEO_EXT)?.let { Media(RenderItem.Kind.VIDEO, it, true) }
  }
  if (number(el["offType"]) == OFF_PLAYLIST) {
    val playlist = el["playlist"].arr().mapNotNull { supported(it, VIDEO_EXT) }
    return playlist.firstOrNull()?.let { Media(RenderItem.Kind.VIDEO, it, playlist.size == 1, playlist) }
  }
  if (number(el["offType"]) == OFF_IMAGE) {
    return supported(el["offImageSrc"], IMAGE_EXT)?.let { Media(RenderItem.Kind.IMAGE, it, false) }
  }
  return null
}

private fun elementMedia(kind: RenderItem.Kind, el: JsonObject): Media? =
    when (kind) {
      RenderItem.Kind.VIDEO -> videoMedia(el)
      RenderItem.Kind.IMAGE -> supported(el["textureSrc"], IMAGE_EXT)?.let { Media(kind, it, false) }
      RenderItem.Kind.MODEL -> nonEmptyString(el["modelSrc"])?.let { Media(kind, it, false) }
      RenderItem.Kind.AUDIO -> nonEmptyString(el["audioSrc"])?.let { Media(kind, it, true) }
    }

private fun lastPathComponent(src: String): String =
    src.split('?', '#').first().trimEnd('/').substringAfterLast('/').ifEmpty { src }

private fun planElements(out: MutableList<RenderItem>, elements: JsonElement?, kind: RenderItem.Kind) {
  for (e in elements.arr()) {
    val el = e.obj() ?: continue
    if (isFalse(el["enabled"])) continue
    val media = elementMedia(kind, el) ?: continue
    val volume =
        if (kind == RenderItem.Kind.VIDEO || kind == RenderItem.Kind.AUDIO) number(el["volume"]) ?: 1.0 else 0.0
    for (i in el["instances"].arr()) {
      val inst = i.obj() ?: continue
      if (isFalse(inst["enabled"])) continue
      val scale = vec(inst["scale"], 1.0)
      out.add(
          RenderItem(
              key = "${templateString(el["sk"])}:${templateString(inst["sk"])}",
              name = nonEmptyString(el["name"]) ?: lastPathComponent(media.src),
              kind = media.kind,
              src = media.src,
              loop = media.loop,
              volume = if (media.kind == RenderItem.Kind.IMAGE) 0.0 else volume,
              width = scale.x,
              height = scale.y,
              transform = toSpatialTransform(vec(inst["position"], 0.0), vec(inst["rotation"], 0.0), scale),
              clickUrl = externalUrl(clickOf(inst, el)),
              playlist = media.playlist,
          )
      )
    }
  }
}

/** The nodes to show for a scene snapshot (`scene` is the feed's `scene` object, null for null). */
fun planScene(scene: JsonObject?): List<RenderItem> {
  val out = mutableListOf<RenderItem>()
  if (scene == null) return out
  planElements(out, scene["videos"], RenderItem.Kind.VIDEO)
  planElements(out, scene["images"], RenderItem.Kind.IMAGE)
  planElements(out, scene["models"], RenderItem.Kind.MODEL)
  planElements(out, scene["sounds"], RenderItem.Kind.AUDIO)
  return out
}

data class PlanDiff(val add: List<RenderItem>, val remove: List<String>, val update: List<RenderItem>)

fun diffPlans(prev: List<RenderItem>, next: List<RenderItem>): PlanDiff {
  val before = prev.associateBy { it.key }
  val nextKeys = next.map { it.key }.toSet()
  val add = mutableListOf<RenderItem>()
  val update = mutableListOf<RenderItem>()
  for (item in next) {
    val old = before[item.key]
    if (old == null) add.add(item) else if (old != item) update.add(item)
  }
  return PlanDiff(add, prev.filter { it.key !in nextKeys }.map { it.key }, update)
}
