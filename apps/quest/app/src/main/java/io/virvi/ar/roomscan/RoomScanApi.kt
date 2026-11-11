package io.virvi.ar.roomscan

import io.virvi.ar.api.ArApi
import io.virvi.ar.api.BuilderCall
import io.virvi.ar.builder.DeviceAuth
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/** Room scan copy (the shared-device line is the plan's, word for word; the owner may reword the rest). */
object RoomScanCopy {
  const val SCAN_THIS_ROOM = "Scan this room"
  const val SHARED_DEVICE = "Room scans need a personal headset. This one is shared."
  /** A trial at its room-scan cap (the plan's line, word for word). */
  const val TRIAL_SCAN_LIMIT = "Your trial holds 5 room scans. Create a free account on virvi.io to keep more."
  const val EMPTY_SCAN = "This scan has no rooms: set up your space and try again"
  const val INVALID_SCAN = "This room scan couldn't be read: set up your space again and retry"
  const val NO_ROOMS = "No rooms are set up on this headset yet"
  const val SET_UP_SPACE = "Set up my space"
  const val UPLOAD = "Upload"
  const val UPLOADING = "Uploading…"
  const val OFFLINE = "Can't reach virvi.io: check the connection and try again"
  const val FAILED = "Couldn't upload the scan: try again"
  const val SIGNED_OUT = "This headset was signed out: pair it again to upload"

  fun uploaded(name: String) = "Uploaded “$name”: pick it on virvi.io to build a set from it"
}

/** How the server took a scan. */
sealed interface RoomScanUpload {
  data class Uploaded(val id: String, val name: String) : RoomScanUpload
  /** Refused with a line to show: a shared headset, an empty scan or a layout the server can't read. */
  data class Refused(val message: String) : RoomScanUpload
}

/**
 * Uploads room scans: with the headset's AR pass for the space being built ([upload]; any space it builds on, the scan
 * is the account's), or with the headset secret when no space is being built ([uploadWithDevice]; how a trial scans).
 */
class RoomScanApi(private val api: ArApi, private val auth: DeviceAuth) {
  /** `POST /api/ar/room-scans` with [name] (1–120 characters) and the [layout] from [RoomScanMapper]. */
  suspend fun upload(spaceId: String, name: String, layout: JsonObject): BuilderCall<RoomScanUpload> =
      auth.withPass(spaceId) { token ->
        api.bearer(
            "POST",
            "/api/ar/room-scans",
            token,
            buildJsonObject {
              put("name", name)
              put("layout", layout)
            },
            answer = { status, body -> refusal(status, body) },
            parse = ::uploaded,
        )
      }

  /**
   * `POST /api/ar/devices/:id/room-scans` with the headset secret, [name] and [layout]: the scan goes to the headset's
   * approver. A revoked headset is signed out ([DeviceAuth.withCredential]).
   */
  suspend fun uploadWithDevice(name: String, layout: JsonObject): BuilderCall<RoomScanUpload> =
      auth.withCredential { c ->
        api.deviceCall(
            "/api/ar/devices/${api.pathSegment(c.deviceId)}/room-scans",
            buildJsonObject {
              put("secret", c.secret)
              put("name", name)
              put("layout", layout)
            },
            answer = { status, body -> refusal(status, body) },
            parse = ::uploaded,
        )
      }

  private fun refusal(status: Int, body: String): RoomScanUpload? {
    val o = obj(body)
    return when {
      status == 403 && str(o, "error") == "shared_device" -> RoomScanUpload.Refused(str(o, "message") ?: RoomScanCopy.SHARED_DEVICE)
      status == 403 && str(o, "error") == "personal_only" -> RoomScanUpload.Refused(RoomScanCopy.SHARED_DEVICE)
      status == 403 && str(o, "error") == "account_required" && str(o, "action") == "more_scans" ->
          RoomScanUpload.Refused(RoomScanCopy.TRIAL_SCAN_LIMIT)
      status == 400 && str(o, "error") == "empty_scan" -> RoomScanUpload.Refused(RoomScanCopy.EMPTY_SCAN)
      status == 400 && str(o, "error") == "invalid_layout" -> RoomScanUpload.Refused(RoomScanCopy.INVALID_SCAN)
      else -> null
    }
  }

  private fun uploaded(body: String): RoomScanUpload? {
    val scan = obj(body)?.get("scan") as? JsonObject ?: return null
    val id = str(scan, "id") ?: return null
    return RoomScanUpload.Uploaded(id, str(scan, "name") ?: "")
  }

  private fun obj(body: String): JsonObject? = runCatching { Json.parseToJsonElement(body).jsonObject }.getOrNull()

  private fun str(o: JsonObject?, key: String) = (o?.get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content
}
