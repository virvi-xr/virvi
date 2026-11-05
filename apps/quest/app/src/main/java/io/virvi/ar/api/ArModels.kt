package io.virvi.ar.api

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull

// The wire shapes of packages/shared/src/ar.ts (ArFeedResponse, ArMarkerLookup).

data class MarkerPose(val x: Double, val y: Double, val z: Double, val headingDeg: Double)

data class ArMarker(
    val id: String,
    val ringId: Long,
    val code: String,
    val diameterMm: Double,
    val whereText: String?,
    val pose: MarkerPose?,
)

data class ArFloor(val id: String, val name: String, val heightM: Double, val sortOrder: Int, val markers: List<ArMarker>)

data class ArSpace(val id: String, val name: String, val place: String?, val published: Boolean, val floors: List<ArFloor>) {
  fun markerByRing(ringId: Long): Pair<ArFloor, ArMarker>? {
    for (f in floors) for (m in f.markers) if (m.ringId == ringId) return f to m
    return null
  }
}

data class MarkerLookup(val spaceId: String, val floorId: String, val markerId: String, val spaceName: String, val whereText: String?)

/**
 * [version] is opaque; [scene] is the serialized scene for [planScene], or null when the space has none. [showings] are
 * the scheduled screens' shows by element id (LIV-87), and [serverTime] the server's clock when it answered (UTC ms).
 */
data class ArFeedSnapshot(
    val version: String,
    val space: ArSpace,
    val scene: JsonObject?,
    val showings: Map<String, List<io.virvi.ar.ShowingInstance>> = emptyMap(),
    val serverTime: Long? = null,
)

private fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
private fun JsonObject.num(k: String): Double? = (this[k] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
private fun JsonObject.optStr(k: String): String? = if (this[k] is JsonNull || k !in this) null else str(k)

private fun parsePose(e: JsonElement?): MarkerPose? {
  val o = e as? JsonObject ?: return null
  return MarkerPose(o.num("x") ?: return null, o.num("y") ?: return null, o.num("z") ?: return null, o.num("headingDeg") ?: return null)
}

private fun parseMarker(e: JsonElement): ArMarker? {
  val o = e as? JsonObject ?: return null
  return ArMarker(
      id = o.str("id") ?: return null,
      ringId = (o["ringId"] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull ?: return null,
      code = o.str("code") ?: return null,
      diameterMm = o.num("diameterMm") ?: return null,
      whereText = o.optStr("whereText"),
      pose = parsePose(o["pose"]),
  )
}

private fun parseFloor(e: JsonElement): ArFloor? {
  val o = e as? JsonObject ?: return null
  val markers = (o["markers"] as? JsonArray)?.map { parseMarker(it) ?: return null } ?: return null
  return ArFloor(
      id = o.str("id") ?: return null,
      name = o.str("name") ?: return null,
      heightM = o.num("heightM") ?: return null,
      sortOrder = (o["sortOrder"] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull ?: return null,
      markers = markers,
  )
}

private fun parseSpace(e: JsonElement?): ArSpace? {
  val o = e as? JsonObject ?: return null
  val floors = (o["floors"] as? JsonArray)?.map { parseFloor(it) ?: return null } ?: return null
  return ArSpace(
      id = o.str("id") ?: return null,
      name = o.str("name") ?: return null,
      place = o.optStr("place"),
      published = (o["published"] as? JsonPrimitive)?.content == "true",
      floors = floors,
  )
}

private fun parseObject(body: String): JsonObject? = runCatching { Json.parseToJsonElement(body).jsonObject }.getOrNull()

/** `{ v: 1, version, space, scene }`; null for any other version or a malformed body. */
fun parseFeed(body: String): ArFeedSnapshot? {
  val o = parseObject(body) ?: return null
  if ((o["v"] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull != 1) return null
  val version = o.str("version") ?: return null
  val space = parseSpace(o["space"]) ?: return null
  val serverTime = (o["serverTime"] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull
  return ArFeedSnapshot(version, space, o["scene"] as? JsonObject, io.virvi.ar.parseShowings(o["showings"]), serverTime)
}

fun parseLookup(body: String): MarkerLookup? {
  val o = parseObject(body) ?: return null
  return MarkerLookup(
      o.str("spaceId") ?: return null,
      o.str("floorId") ?: return null,
      o.str("markerId") ?: return null,
      o.str("spaceName") ?: return null,
      o.optStr("whereText"),
  )
}
