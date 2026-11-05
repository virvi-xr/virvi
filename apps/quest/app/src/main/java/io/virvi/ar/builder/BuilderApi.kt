package io.virvi.ar.builder

import io.virvi.ar.Vec3
import io.virvi.ar.api.ArApi
import io.virvi.ar.api.BuilderCall
import io.virvi.ar.api.MarkerPose
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/** How the server took a draft. */
sealed interface DraftAnswer {
  data object Ok : DraftAnswer
  /** Someone else is moving that item. */
  data class Held(val name: String) : DraftAnswer
  /** Live drafts are down; saving still works. */
  data object Unavailable : DraftAnswer
}

data class PlacedItem(val elementId: String, val instanceId: String)

data class SpaceName(val id: String, val name: String)

/** The names of the scene's AR spaces other than [spaceId], for [hudWarnings]. */
fun otherPlaces(spaces: List<SpaceName>, spaceId: String): List<String> = spaces.filter { it.id != spaceId }.map { it.name }

/**
 * The calls the builder makes with an AR pass. Each takes the [spaceId] the pass is for and goes through
 * [DeviceAuth.withPass].
 */
class BuilderApi(private val api: ArApi, private val auth: DeviceAuth) {
  /** `GET /api/scenes/:id`: the scene with its presets, for preset and booking info. */
  suspend fun scene(spaceId: String, sceneId: String): BuilderCall<JsonObject> =
      call(spaceId, "GET", "/api/scenes/${enc(sceneId)}", null, ::obj)

  /** `PUT /api/instances/:id`: the shared transform (Everywhere). */
  suspend fun updateInstance(spaceId: String, id: String, t: ItemTransform): BuilderCall<Unit> =
      call(spaceId, "PUT", "/api/instances/${enc(id)}", transformBody(t)) { Unit }

  /** `PUT /api/ar/spaces/:id/adjustments/:instanceId`: this place's offset (Just this place). */
  suspend fun putAdjustment(spaceId: String, instanceId: String, a: Adjustment): BuilderCall<Unit> =
      call(
          spaceId,
          "PUT",
          "/api/ar/spaces/${enc(spaceId)}/adjustments/${enc(instanceId)}",
          buildJsonObject {
            put("dPosition", vec(a.dPosition))
            put("dRotation", vec(a.dRotation))
            put("scaleFactor", vec(a.scaleFactor))
          },
      ) { Unit }

  suspend fun deleteAdjustment(spaceId: String, instanceId: String): BuilderCall<Unit> =
      call(spaceId, "DELETE", "/api/ar/spaces/${enc(spaceId)}/adjustments/${enc(instanceId)}", null) { Unit }

  /**
   * `POST /api/ar/drafts`: a live preview of a move; 409 `held` and 503 are answers, not failures. [sk] is the
   * instance's sk; [element] is the element type (image, video, model, sound or ad_space), not the element's id.
   */
  suspend fun draft(spaceId: String, sk: String, element: String, t: ItemTransform): BuilderCall<DraftAnswer> =
      auth.withPass(spaceId) { token ->
        api.bearer(
            "POST",
            "/api/ar/drafts",
            token,
            buildJsonObject {
              put("element", element)
              put("sk", sk)
              put("position", vec(t.position))
              put("rotation", vec(t.rotation))
              put("scale", vec(t.scale))
            },
            answer = { status, body ->
              when {
                status == 409 && errorOf(body) == "held" -> DraftAnswer.Held(holderOf(body))
                status == 503 -> DraftAnswer.Unavailable
                else -> null
              }
            },
        ) {
          DraftAnswer.Ok
        }
      }

  /** `POST /api/ar/drafts/end`. */
  suspend fun endDraft(spaceId: String, sk: String, saved: Boolean): BuilderCall<Unit> =
      call(
          spaceId,
          "POST",
          "/api/ar/drafts/end",
          buildJsonObject {
            put("sk", sk)
            put("saved", saved)
          },
      ) { Unit }

  /**
   * `GET /api/scenes/:sceneId/ar/spaces`: the scene's AR spaces (id and name), for the "also shown at" warning.
   * Entries without an id or name are skipped.
   */
  suspend fun sceneSpaces(spaceId: String, sceneId: String): BuilderCall<List<SpaceName>> =
      call(spaceId, "GET", "/api/scenes/${enc(sceneId)}/ar/spaces", null) { body ->
        (runCatching { Json.parseToJsonElement(body) }.getOrNull() as? JsonArray)?.mapNotNull { e ->
          val o = e as? JsonObject ?: return@mapNotNull null
          val id = (o["id"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return@mapNotNull null
          val name = (o["name"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return@mapNotNull null
          SpaceName(id, name)
        }
      }

  /** `GET /api/scenes/:sceneId/streams`: the streams a screen can play (never a stream key). Personal headsets only. */
  suspend fun streams(spaceId: String, sceneId: String): BuilderCall<JsonObject> =
      call(spaceId, "GET", "/api/scenes/${enc(sceneId)}/streams", null, ::obj)

  /** `PUT /api/elements/:id { properties }`: replaces the element's properties whole. */
  suspend fun putProperties(spaceId: String, elementId: String, properties: JsonObject): BuilderCall<Unit> =
      call(spaceId, "PUT", "/api/elements/${enc(elementId)}", buildJsonObject { put("properties", properties) }) { Unit }

  /** `POST /api/elements/:id/live { enabled }`: turns a screen's live stream on or off. Personal headsets only. */
  suspend fun setLive(spaceId: String, elementId: String, on: Boolean): BuilderCall<Unit> =
      call(spaceId, "POST", "/api/elements/${enc(elementId)}/live", buildJsonObject { put("enabled", on) }) { Unit }

  /** `GET /api/scenes/:sceneId/library`: the models and images the builder can place. */
  suspend fun library(spaceId: String, sceneId: String): BuilderCall<JsonObject> =
      call(spaceId, "GET", "/api/scenes/${enc(sceneId)}/library", null, ::obj)

  suspend fun placeModel(spaceId: String, presetId: String, name: String, src: String, t: ItemTransform): BuilderCall<PlacedItem> =
      place(spaceId, presetId, "model", name, buildJsonObject { put("modelSrc", src) }, t)

  suspend fun placeImage(spaceId: String, presetId: String, name: String, src: String, t: ItemTransform): BuilderCall<PlacedItem> =
      place(spaceId, presetId, "image", name, buildJsonObject { put("textureSrc", src) }, t)

  /** A library video as a screen that plays it (a one-video playlist, as `offType` 2 PLAYLIST). */
  suspend fun placeVideo(spaceId: String, presetId: String, name: String, src: String, t: ItemTransform): BuilderCall<PlacedItem> =
      place(
          spaceId,
          presetId,
          "video",
          name,
          buildJsonObject {
            put("offType", 2)
            put("enableLiveStream", false)
            put("playlist", JsonArray(listOf(JsonPrimitive(src))))
          },
          t,
      )

  /** `PUT /api/ar/markers/:id/pose`: the alignment of a ring; the answer is the server's warnings. */
  suspend fun savePose(spaceId: String, markerId: String, pose: MarkerPose, heightAboveFloorM: Double): BuilderCall<List<String>> =
      call(
          spaceId,
          "PUT",
          "/api/ar/markers/${enc(markerId)}/pose",
          buildJsonObject {
            put("x", pose.x)
            put("y", pose.y)
            put("z", pose.z)
            put("headingDeg", pose.headingDeg)
            put("heightAboveFloorM", heightAboveFloorM)
          },
      ) { body ->
        (obj(body)?.get("warnings") as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content } ?: emptyList()
      }

  /**
   * The element, then its instance, as the Hyperfy HUD does. If the instance can't be made the element is deleted
   * again so no empty one is left behind.
   */
  private suspend fun place(
      spaceId: String,
      presetId: String,
      type: String,
      name: String,
      properties: JsonObject,
      t: ItemTransform,
  ): BuilderCall<PlacedItem> {
    val el =
        call(
            spaceId,
            "POST",
            "/api/presets/${enc(presetId)}/elements",
            buildJsonObject {
              put("type", type)
              put("name", name)
              put("properties", properties)
            },
        ) { idIn(it, "element") }
    val elementId = (el as? BuilderCall.Ok)?.value ?: return el.asFailure()
    val inst = call(spaceId, "POST", "/api/elements/${enc(elementId)}/instances", transformBody(t)) { idIn(it, "instance") }
    if (inst is BuilderCall.Ok) return BuilderCall.Ok(PlacedItem(elementId, inst.value))
    call(spaceId, "DELETE", "/api/elements/${enc(elementId)}", null) { Unit }
    return inst.asFailure()
  }

  private suspend fun <T> call(spaceId: String, method: String, path: String, body: JsonObject?, parse: (String) -> T?): BuilderCall<T> =
      auth.withPass(spaceId) { token -> api.bearer(method, path, token, body, parse = parse) }

  private fun transformBody(t: ItemTransform) =
      buildJsonObject {
        put("position", vec(t.position))
        put("rotation", vec(t.rotation))
        put("scale", vec(t.scale))
      }

  private fun vec(v: Vec3) =
      buildJsonObject {
        put("x", v.x)
        put("y", v.y)
        put("z", v.z)
      }

  private fun enc(s: String) = java.net.URLEncoder.encode(s, "UTF-8")

  private fun obj(body: String): JsonObject? = runCatching { Json.parseToJsonElement(body).jsonObject }.getOrNull()

  private fun errorOf(body: String) = (obj(body)?.get("error") as? JsonPrimitive)?.content

  private fun holderOf(body: String) = (obj(body)?.get("holderName") as? JsonPrimitive)?.takeIf { it.isString }?.content ?: ""

  /** `{ [key]: { id } }`. */
  private fun idIn(body: String, key: String): String? =
      ((obj(body)?.get(key) as? JsonObject)?.get("id") as? JsonPrimitive)?.takeIf { it.isString }?.content

  @Suppress("UNCHECKED_CAST") private fun <T> BuilderCall<*>.asFailure(): BuilderCall<T> = this as BuilderCall<T>
}
