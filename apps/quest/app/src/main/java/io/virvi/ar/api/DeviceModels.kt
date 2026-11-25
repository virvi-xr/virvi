package io.virvi.ar.api

import java.time.Instant
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

// The wire shapes of packages/shared/src/ar.ts for headset pairing (ArPairStartResponse, ArPairClaimResponse,
// ArPassResponse, ArDeviceSpace).

enum class DeviceKind { PERSONAL, SHARED }

data class PairStart(val code: String, val approveUrl: String, val codeExpiresAtMs: Long) {
  /** The code is a credential: it is not printed. */
  override fun toString() = "PairStart(codeExpiresAtMs=$codeExpiresAtMs)"
}

/** A visitor's signed-in account, as a visitor pairing's claim gives it. The tokens are credentials: they are not printed. */
data class AccountSession(val userId: String, val userName: String?, val accessToken: String, val refreshToken: String) {
  override fun toString() = "AccountSession(userId=$userId)"
}

sealed interface PairClaim {
  data object Pending : PairClaim
  data class Approved(val deviceId: String, val kind: DeviceKind, val expiresAtMs: Long) : PairClaim
  /**
   * A visitor pairing: the approver's account session, and the pairing's id, which BEAT writes send as `X-Virvi-Device`.
   * The id is no builder device: it can mint no pass.
   */
  data class Visitor(val deviceId: String, val session: AccountSession) : PairClaim
  data object Refused : PairClaim
}

data class MintedPass(val pass: String, val expiresAtMs: Long, val sceneId: String) {
  /** The pass is a credential: it is not printed. */
  override fun toString() = "MintedPass(expiresAtMs=$expiresAtMs, sceneId=$sceneId)"
}

data class DeviceMarker(val markerId: String, val floorId: String, val code: String)

data class DeviceSpace(
    val spaceId: String,
    val spaceName: String,
    val sceneId: String,
    val sceneName: String,
    val markers: List<DeviceMarker>,
)

private fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun obj(body: String): JsonObject? = runCatching { Json.parseToJsonElement(body).jsonObject }.getOrNull()

private fun instantMs(s: String?): Long? = s?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }

/** The `error` code of a failure body, or null. */
fun errorCode(body: String): String? = obj(body)?.str("error")

fun parsePairStart(body: String): PairStart? {
  val o = obj(body) ?: return null
  return PairStart(
      o.str("code") ?: return null,
      o.str("approveUrl") ?: return null,
      instantMs(o.str("codeExpiresAt")) ?: return null,
  )
}

fun parseClaim(body: String): PairClaim? {
  val o = obj(body) ?: return null
  return when (o.str("status")) {
    "pending" -> PairClaim.Pending
    "refused" -> PairClaim.Refused
    "approved" ->
        if (o.str("purpose") == "visitor") parseVisitorClaim(o) else
        PairClaim.Approved(
            o.str("deviceId") ?: return null,
            when (o.str("kind")) {
              "personal" -> DeviceKind.PERSONAL
              "shared" -> DeviceKind.SHARED
              else -> return null
            },
            instantMs(o.str("expiresAt")) ?: return null,
        )
    else -> null
  }
}

private fun parseVisitorClaim(o: JsonObject): PairClaim? {
  val s = o["session"] as? JsonObject ?: return null
  val user = s["user"] as? JsonObject ?: return null
  return PairClaim.Visitor(
      o.str("deviceId") ?: return null,
      AccountSession(
          user.str("id") ?: return null,
          user.str("displayName"),
          s.str("accessToken")?.takeIf { it.isNotEmpty() } ?: return null,
          s.str("refreshToken")?.takeIf { it.isNotEmpty() } ?: return null,
      ),
  )
}

/** What `POST /api/auth/refresh` came to: new tokens, a refusal of the refresh token, or nothing learned (offline, a server error). */
sealed interface RefreshResult {
  /** [refreshToken] is null when the server kept the old one. */
  data class Tokens(val accessToken: String, val refreshToken: String?) : RefreshResult
  data object Refused : RefreshResult
  data object Unavailable : RefreshResult
}

fun parseRefresh(body: String): RefreshResult.Tokens? {
  val o = obj(body) ?: return null
  return RefreshResult.Tokens(
      o.str("accessToken")?.takeIf { it.isNotEmpty() } ?: return null,
      o.str("refreshToken")?.takeIf { it.isNotEmpty() },
  )
}

fun parsePass(body: String): MintedPass? {
  val o = obj(body) ?: return null
  return MintedPass(
      o.str("pass") ?: return null,
      instantMs(o.str("passExpiresAt")) ?: return null,
      o.str("sceneId") ?: return null,
  )
}

fun parseDeviceSpaces(body: String): List<DeviceSpace>? {
  val arr = runCatching { Json.parseToJsonElement(body) as? JsonArray }.getOrNull() ?: return null
  return arr.map { e ->
    val o = e as? JsonObject ?: return null
    val markers =
        (o["markers"] as? JsonArray)?.map { m ->
          val mo = m as? JsonObject ?: return null
          DeviceMarker(mo.str("markerId") ?: return null, mo.str("floorId") ?: return null, mo.str("code") ?: return null)
        } ?: return null
    DeviceSpace(
        o.str("spaceId") ?: return null,
        o.str("spaceName") ?: return null,
        o.str("sceneId") ?: return null,
        o.str("sceneName") ?: return null,
        markers,
    )
  }
}
