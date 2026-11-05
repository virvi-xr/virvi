package io.virvi.ar.builder

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * The builder HUD's Stream tab (LIV-53, LIV-54), as the Decentraland HUD's Stream panel (adapter-dcl streams.ts): the
 * live preset's video screens, the scene's streams each can play, the live switch, and the image shown when nothing
 * plays. Personal headsets only, as the server's streams and live routes are.
 */

/** A video screen of the live preset. `liveSrc` and `offImageSrc` are "" for none. */
data class StreamScreen(val id: String, val name: String, val liveSrc: String, val liveOn: Boolean, val offImageSrc: String)

/** A stream as `GET /api/scenes/:id/streams` lists it (never the stream key). */
data class SceneStream(val id: String, val name: String, val hlsPlaylistUrl: String, val live: Boolean, val mine: Boolean)

/** An image from the scene library that can be a screen's off image. */
data class OffImage(val id: String, val name: String, val url: String)

/** Which list is open on which screen. */
data class StreamPick(val elementId: String, val list: List) {
  enum class List { STREAM, OFF_IMAGE }
}

/** The Stream tab's state: [screens] is null while it loads or if it didn't ([failed]). */
data class StreamsState(
    val screens: List<StreamScreen>? = null,
    val streams: List<SceneStream> = emptyList(),
    val images: List<OffImage> = emptyList(),
    val failed: Boolean = false,
    val busy: Boolean = false,
    val picking: StreamPick? = null,
    /** Why the last change didn't go through. */
    val message: String? = null,
)

/** What the Stream tab's controls do (the builder controller's [BuilderController.streamActions]). */
interface StreamActions {
  fun pick(elementId: String, list: StreamPick.List)

  fun chooseStream(elementId: String, streamId: String)

  fun chooseOffImage(elementId: String, url: String)

  fun toggleLive(elementId: String)
}

const val STREAMS_LOADING = "Loading the screens…"
const val STREAMS_FAILED = "Couldn't load the screens: try again"
const val NO_SCREENS = "No video screens in this scene"
const val NO_STREAMS = "No streams yet: set one up on the Streaming page at virvi.io"
const val NO_IMAGES = "No images yet: upload one from the Assets tab"
const val OFF_IMAGE_HINT = "Shown when the screen has nothing to play"
/** How many images the list shows; the rest are chosen on the dashboard. */
const val OFF_IMAGE_LIST_MAX = 8

private fun JsonElement?.str(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
private fun JsonElement?.bool(): Boolean? = (this as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

private fun presets(sceneBody: JsonObject): List<JsonObject> =
    ((sceneBody["scene"] as? JsonObject)?.get("presets") as? JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList()

private fun activePreset(sceneBody: JsonObject): JsonObject? {
  val id = activePresetId(sceneBody) ?: return null
  return presets(sceneBody).firstOrNull { it["id"].str() == id }
}

private fun elementsOf(preset: JsonObject?): List<JsonObject> = (preset?.get("elements") as? JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList()

/** The live preset's video screens (`GET /api/scenes/:id`). */
fun streamScreens(sceneBody: JsonObject): List<StreamScreen> =
    elementsOf(activePreset(sceneBody))
        .filter { it["type"].str() == "video" }
        .mapNotNull { el ->
          val id = el["id"].str() ?: return@mapNotNull null
          val p = el["properties"] as? JsonObject
          StreamScreen(
              id = id,
              name = el["name"].str()?.takeIf { it.isNotBlank() } ?: "Video screen",
              liveSrc = p?.get("liveSrc").str()?.trim() ?: "",
              liveOn = p?.get("enableLiveStream").bool() == true,
              offImageSrc = p?.get("offImageSrc").str()?.trim() ?: "",
          )
        }

/** `{ streams }` of `GET /api/scenes/:id/streams`; malformed entries are dropped. */
fun parseSceneStreams(body: JsonObject): List<SceneStream> =
    (body["streams"] as? JsonArray)?.mapNotNull { e ->
      val o = e as? JsonObject ?: return@mapNotNull null
      SceneStream(
          id = o["id"].str() ?: return@mapNotNull null,
          name = o["name"].str() ?: return@mapNotNull null,
          hlsPlaylistUrl = o["hlsPlaylistUrl"].str() ?: return@mapNotNull null,
          live = o["live"].bool() == true,
          mine = o["mine"].bool() == true,
      )
    } ?: emptyList()

/** Image types a screen can show (as the Decentraland HUD offers). */
private val OFF_IMAGE_TYPES = setOf("image/png", "image/jpeg", "image/webp", "image/gif")

/** The scene library's ready images (`GET /api/scenes/:id/library`), for the off image list. */
fun offImageChoices(library: JsonObject): List<OffImage> =
    (library["items"] as? JsonArray)?.mapNotNull { e ->
      val o = e as? JsonObject ?: return@mapNotNull null
      if (o["status"].str() != "ready" || o["kind"].str() != "media" || o["contentType"].str() !in OFF_IMAGE_TYPES) return@mapNotNull null
      OffImage(o["id"].str() ?: return@mapNotNull null, o["name"].str() ?: return@mapNotNull null, o["url"].str()?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null)
    } ?: emptyList()

/** "Main Stage (live)", "Editor Cam (offline, yours)". */
fun streamOptionLabel(s: SceneStream): String = "${s.name} (${if (s.live) "live" else "offline"}${if (s.mine) ", yours" else ""})"

/** What a screen's live source is: one of the scene's streams, a link pasted elsewhere, or nothing. */
fun screenSourceLabel(screen: StreamScreen, streams: List<SceneStream>): String {
  if (screen.liveSrc.isEmpty()) return "No stream"
  return streams.firstOrNull { it.hlsPlaylistUrl == screen.liveSrc }?.let(::streamOptionLabel) ?: "Custom link"
}

/** "Off image: Poster", by its library name as the dashboard shows it. */
fun offImageLabel(screen: StreamScreen, images: List<OffImage>): String {
  if (screen.offImageSrc.isEmpty()) return "No off image"
  return "Off image: ${images.firstOrNull { it.url == screen.offImageSrc }?.name ?: "from a link"}"
}

/** An element's properties (the live preset's first, then any other's), or null when it's gone. */
fun elementProperties(sceneBody: JsonObject, elementId: String): JsonObject? {
  val all = elementsOf(activePreset(sceneBody)) + presets(sceneBody).flatMap(::elementsOf)
  val el = all.firstOrNull { it["id"].str() == elementId } ?: return null
  return el["properties"] as? JsonObject ?: JsonObject(emptyMap())
}

/**
 * The properties with [key] set to [value]. `PUT /api/elements` replaces properties whole, so the rest are kept; a
 * cleared value is "" rather than dropped, since the in-world update only applies keys that are present.
 */
fun withProperty(properties: JsonObject?, key: String, value: String): JsonObject =
    JsonObject((properties ?: JsonObject(emptyMap())) + (key to JsonPrimitive(value)))

/** Why a screen change didn't go through. */
fun streamChangeFailed(r: io.virvi.ar.api.BuilderCall<*>): String =
    when (r) {
      io.virvi.ar.api.BuilderCall.NotFound -> "That screen no longer exists: reopen the tab to refresh"
      io.virvi.ar.api.BuilderCall.NoAccess -> "You don't have permission to change this screen"
      io.virvi.ar.api.BuilderCall.Offline -> "Can't reach virvi.io: check the connection and try again"
      else -> "Couldn't change that: try again"
    }
