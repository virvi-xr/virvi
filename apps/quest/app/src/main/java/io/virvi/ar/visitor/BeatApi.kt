package io.virvi.ar.visitor

import io.virvi.ar.api.AppResponse
import io.virvi.ar.api.ArApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

sealed interface BeatResult<out T> {
  data class Ok<T>(val value: T) : BeatResult<T>
  data class Error(val error: AppBeatError) : BeatResult<Nothing>
}

/** The app routes a BEAT card needs (`AppBeatRoutes` on the headset; a fake in tests). All for the signed-in visitor, except the card. */
interface BeatRoutes {
  /** `GET /api/app/spaces/:spaceId/beat`: the BEAT running in a space, if any. Signed out it is asked without a token. */
  suspend fun spaceBeat(spaceId: String): BeatResult<AppBeatCard?>

  /** `POST /api/app/beats/:beatId/track`: consents to the current text and starts tracking, from a space. */
  suspend fun track(beatId: String, spaceId: String): BeatResult<AppBeatCard>

  /** `POST /api/app/beats/:beatId/checkin` */
  suspend fun checkIn(beatId: String, spaceId: String): BeatResult<AppBeatCard>

  /** `POST /api/app/beats/:beatId/claim`: with no [wallet] the server picks the only one, asks to choose (`choose_wallet`), or saves the claim. */
  suspend fun claim(beatId: String, wallet: String?): BeatResult<AppBeatCard>

  /** `DELETE /api/app/beats/:beatId/track`: stops tracking and deletes what was stored. */
  suspend fun stopTracking(beatId: String): BeatResult<Unit>
}

/**
 * [BeatRoutes] over [ArApi], with the visitor's session ([VisitorSignIn.authorized]). A Quest has no App Attest: its
 * writes carry no `X-Virvi-Attest`, and the server accepts the signed-in visitor device (`X-Virvi-Device`, which
 * `ArApi.appCall` adds beside the bearer) as the install. Mirrors the Virvi app's `AppBeatApi`.
 */
class AppBeatRoutes(private val api: ArApi, private val signIn: VisitorSignIn) : BeatRoutes {
  override suspend fun spaceBeat(spaceId: String): BeatResult<AppBeatCard?> =
      run("GET", "/api/app/spaces/${api.pathSegment(spaceId)}/beat", null, anonymousOk = true) { o ->
        val beat = o["beat"]
        if (beat == null || beat is JsonNull) Parsed(null) else parseAppBeatCard(beat)?.let { Parsed(it) }
      }

  override suspend fun track(beatId: String, spaceId: String): BeatResult<AppBeatCard> =
      write("POST", "/api/app/beats/${api.pathSegment(beatId)}/track") {
        put("consentVersion", BEAT_APP_CONSENT_VERSION)
        put("spaceId", spaceId)
      }

  override suspend fun checkIn(beatId: String, spaceId: String): BeatResult<AppBeatCard> =
      write("POST", "/api/app/beats/${api.pathSegment(beatId)}/checkin") { put("spaceId", spaceId) }

  override suspend fun claim(beatId: String, wallet: String?): BeatResult<AppBeatCard> =
      write("POST", "/api/app/beats/${api.pathSegment(beatId)}/claim") { if (wallet != null) put("wallet", wallet) }

  override suspend fun stopTracking(beatId: String): BeatResult<Unit> =
      run("DELETE", "/api/app/beats/${api.pathSegment(beatId)}/track", null) { Parsed(Unit) }

  private suspend fun write(method: String, path: String, fill: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit): BeatResult<AppBeatCard> =
      run(method, path, buildJsonObject(fill).toString()) { o -> parseAppBeatCard(o["beat"])?.let { Parsed(it) } }

  /** Wraps a parsed value, so a parse of `null` (a space with no BEAT) is told apart from a parse that failed. */
  private class Parsed<T>(val value: T)

  private suspend fun <T> run(
      method: String,
      path: String,
      body: String?,
      anonymousOk: Boolean = false,
      parse: (JsonObject) -> Parsed<T>?,
  ): BeatResult<T> {
    val answer =
        if (anonymousOk && signIn.bearer() == null) api.appCall(method, path, null, null, body)
        else signIn.authorized { token, device -> api.appCall(method, path, token, device, body) }
    return when (answer) {
      null -> BeatResult.Error(AppBeatError(0, "signed_out", VisitorCopy.BEAT_SIGN_IN))
      AppResponse.Offline -> BeatResult.Error(AppBeatError(0, "offline", VisitorCopy.OFFLINE))
      is AppResponse.Response -> {
        val o = runCatching { Json.parseToJsonElement(answer.body) as? JsonObject }.getOrNull()
        if (answer.status in 200..299) {
          // A 204 has no body; its parse takes an empty object
          parse(o ?: JsonObject(emptyMap()))?.let { BeatResult.Ok(it.value) }
              ?: BeatResult.Error(AppBeatError(answer.status, "bad_data", VisitorCopy.BEAT_TRY_AGAIN))
        } else {
          BeatResult.Error(
              AppBeatError(
                  answer.status,
                  (o?.get("error") as? JsonPrimitive)?.contentOrNull ?: "http_${answer.status}",
                  (o?.get("message") as? JsonPrimitive)?.contentOrNull ?: VisitorCopy.BEAT_TRY_AGAIN,
                  (o?.get("wallets") as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull } ?: emptyList(),
              )
          )
        }
      }
    }
  }
}
