package io.virvi.ar.api

import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

sealed interface ApiResult<out T> {
  data class Ok<T>(val value: T) : ApiResult<T>
  data object NotFound : ApiResult<Nothing>
  data object RateLimited : ApiResult<Nothing>
  /** The server could not be reached (no network, DNS, timeout). */
  data object Offline : ApiResult<Nothing>
  data class Failed(val status: Int) : ApiResult<Nothing>
}

/** How a visitor's report of a space ended. */
enum class ReportResult { Sent, RateLimited, Failed }

/** The outcome of a report the server answered with HTTP [status]: 201 is taken, 429 is the per-IP limit, else it failed. */
fun reportResultFor(status: Int): ReportResult =
    when (status) {
      201 -> ReportResult.Sent
      429 -> ReportResult.RateLimited
      else -> ReportResult.Failed
    }

/**
 * How a headset-secret call (pairing and the device routes) or a builder call made with an AR pass (see
 * `DeviceAuth.withPass`) ended. A 401 is told apart by the server's error code:
 * [BadSecret], [Revoked], else [Unauthorized] (an expired or missing token on a bearer call).
 */
sealed interface BuilderCall<out T> {
  data class Ok<T>(val value: T) : BuilderCall<T>
  /** 404: an expired code, an unknown device or space. */
  data object NotFound : BuilderCall<Nothing>
  /** 403: the approver can no longer build on that space. */
  data object NoAccess : BuilderCall<Nothing>
  data object BadSecret : BuilderCall<Nothing>
  data object Revoked : BuilderCall<Nothing>
  data object Unauthorized : BuilderCall<Nothing>
  data object RateLimited : BuilderCall<Nothing>
  data object Offline : BuilderCall<Nothing>
  data class Failed(val status: Int) : BuilderCall<Nothing>
}

/** What became of an analytics batch: taken, worth sending again later, or refused for good. */
enum class AnalyticsPost { Sent, Retry, Drop }

/**
 * The fate of a batch the server answered with HTTP [status]: a 4xx other than 408 (request timeout) and 429 will
 * never be taken.
 */
fun analyticsPostFor(status: Int): AnalyticsPost =
    when {
      status in 200..299 -> AnalyticsPost.Sent
      status == 408 || status == 429 -> AnalyticsPost.Retry
      status in 400..499 -> AnalyticsPost.Drop
      else -> AnalyticsPost.Retry
    }

/**
 * The AR endpoints of a Virvi server. A bearer token is sent only when one is given. Tokens are never logged.
 * Safe to call from any dispatcher: requests run on IO.
 */
class ArApi(baseUrl: String, private val userAgentVersion: Int = 1) {
  private val base = baseUrl.trim().trimEnd('/')

  /** `GET /api/ar/markers/by-code/:code`; a builder's [token] also finds unpublished spaces it may edit. */
  suspend fun lookup(code: String, token: String? = null): ApiResult<MarkerLookup> =
      get("/api/ar/markers/by-code/${enc(code)}", token, 15_000, ::parseLookup)

  /** `GET /api/ar/spaces/:id/feed?since=`: the server holds the request up to 25 s until the version changes. */
  suspend fun feed(spaceId: String, since: String, token: String? = null): ApiResult<ArFeedSnapshot> =
      get("/api/ar/spaces/${enc(spaceId)}/feed?since=${enc(since)}", token, 40_000, ::parseFeed)

  /** `POST /api/ar/spaces/:id/analytics` (see [analyticsPostFor]); offline is [AnalyticsPost.Retry]. Anonymous; sends no token. */
  suspend fun postAnalytics(spaceId: String, body: String): AnalyticsPost =
      withContext(Dispatchers.IO) {
        val c =
            try {
              URL("$base/api/ar/spaces/${enc(spaceId)}/analytics").openConnection() as HttpURLConnection
            } catch (e: java.io.IOException) {
              return@withContext AnalyticsPost.Retry
            }
        try {
          c.requestMethod = "POST"
          c.connectTimeout = 15_000
          c.readTimeout = 15_000
          c.useCaches = false
          c.doOutput = true
          c.setRequestProperty("X-Virvi-App-Version", userAgentVersion.toString())
          c.setRequestProperty("Content-Type", "application/json")
          c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
          analyticsPostFor(c.responseCode)
        } catch (e: java.io.IOException) {
          AnalyticsPost.Retry
        } finally {
          c.disconnect()
        }
      }

  /**
   * `POST /api/ar/spaces/:id/report` (see [reportResultFor]); [reason] is `offensive`, `unsafe`, `spam` or `other`. Anonymous;
   * sends no token. Offline is [ReportResult.Failed].
   */
  suspend fun report(spaceId: String, reason: String): ReportResult =
      withContext(Dispatchers.IO) {
        val c =
            try {
              URL("$base/api/ar/spaces/${enc(spaceId)}/report").openConnection() as HttpURLConnection
            } catch (e: java.io.IOException) {
              return@withContext ReportResult.Failed
            }
        try {
          c.requestMethod = "POST"
          c.connectTimeout = 15_000
          c.readTimeout = 15_000
          c.useCaches = false
          c.doOutput = true
          c.setRequestProperty("X-Virvi-App-Version", userAgentVersion.toString())
          c.setRequestProperty("Content-Type", "application/json")
          val body = buildJsonObject {
            put("reason", reason)
            put("platform", "ar-quest")
          }
          c.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
          reportResultFor(c.responseCode)
        } catch (e: java.io.IOException) {
          ReportResult.Failed
        } finally {
          c.disconnect()
        }
      }

  /** `POST /api/ar/pair`: [secretHash] is the hex SHA-256 of the headset's secret. The secret itself is never sent here. */
  suspend fun startPairing(secretHash: String, deviceName: String?): BuilderCall<PairStart> =
      device(
          "/api/ar/pair",
          buildJsonObject {
            put("secretHash", secretHash)
            if (deviceName != null) put("deviceName", deviceName)
          },
          ::parsePairStart,
      )

  /** `POST /api/ar/pair/:code/claim`: [BuilderCall.NotFound] is an expired code. */
  suspend fun claim(code: String, secret: String): BuilderCall<PairClaim> =
      device("/api/ar/pair/${enc(code)}/claim", secretBody(secret), ::parseClaim)

  /** `POST /api/ar/devices/:id/pass`: an AR pass for [spaceId]. */
  suspend fun mintPass(deviceId: String, secret: String, spaceId: String): BuilderCall<MintedPass> =
      device(
          "/api/ar/devices/${enc(deviceId)}/pass",
          buildJsonObject {
            put("secret", secret)
            put("spaceId", spaceId)
          },
          ::parsePass,
      )

  /** `POST /api/ar/devices/:id/end` (204). */
  suspend fun endSession(deviceId: String, secret: String): BuilderCall<Unit> =
      device("/api/ar/devices/${enc(deviceId)}/end", secretBody(secret)) { Unit }

  /** `POST /api/ar/devices/:id/spaces`: the spaces the approver can build on. */
  suspend fun deviceSpaces(deviceId: String, secret: String): BuilderCall<List<DeviceSpace>> =
      device("/api/ar/devices/${enc(deviceId)}/spaces", secretBody(secret), ::parseDeviceSpaces)

  private fun secretBody(secret: String) = buildJsonObject { put("secret", secret) }

  private suspend fun <T> device(path: String, body: JsonObject, parse: (String) -> T?): BuilderCall<T> =
      send("POST", path, null, body, parse)

  /**
   * A `POST` authed by the headset secret in [body] (no bearer), with [answer] for the route's own non-2xx answers as
   * in [bearer]; other statuses map as for the device routes.
   */
  internal suspend fun <T> deviceCall(
      path: String,
      body: JsonObject,
      answer: (status: Int, body: String) -> T? = { _, _ -> null },
      parse: (String) -> T?,
  ): BuilderCall<T> = send("POST", path, null, body, parse, answer)

  /** [path] segment escaping, for callers outside this class. */
  internal fun pathSegment(s: String) = enc(s)

  /**
   * A builder call made with an AR pass ([token]); see `DeviceAuth.withPass`. 2xx is parsed by [parse] (a body of
   * "" for a 204). A non-2xx status for which [answer] gives a value is [BuilderCall.Ok] with it (for answers
   * that are part of the route's contract, like a 409); other statuses map as for the device routes.
   */
  internal suspend fun <T> bearer(
      method: String,
      path: String,
      token: String,
      body: JsonObject?,
      answer: (status: Int, body: String) -> T? = { _, _ -> null },
      parse: (String) -> T?,
  ): BuilderCall<T> = send(method, path, token, body, parse, answer)

  private suspend fun <T> send(
      method: String,
      path: String,
      token: String?,
      body: JsonObject?,
      parse: (String) -> T?,
      answer: (Int, String) -> T? = { _, _ -> null },
  ): BuilderCall<T> =
      withContext(Dispatchers.IO) {
        val c =
            try {
              URL(base + path).openConnection() as HttpURLConnection
            } catch (e: java.io.IOException) {
              return@withContext BuilderCall.Offline
            }
        try {
          c.requestMethod = method
          c.connectTimeout = 15_000
          c.readTimeout = 15_000
          c.useCaches = false
          c.setRequestProperty("X-Virvi-App-Version", userAgentVersion.toString())
          if (!token.isNullOrEmpty()) c.setRequestProperty("Authorization", "Bearer $token")
          if (body != null) {
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            c.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
          }
          val status = c.responseCode
          val text =
              (if (status in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
          val given = if (status in 200..299) null else answer(status, text)
          when {
            given != null -> BuilderCall.Ok(given)
            status in 200..299 -> parse(text)?.let { BuilderCall.Ok(it) } ?: BuilderCall.Failed(status)
            status == 401 ->
                when (errorCode(text)) {
                  "bad_secret" -> BuilderCall.BadSecret
                  "device_revoked" -> BuilderCall.Revoked
                  else -> BuilderCall.Unauthorized
                }
            status == 403 -> BuilderCall.NoAccess
            status == 404 -> BuilderCall.NotFound
            status == 429 -> BuilderCall.RateLimited
            else -> BuilderCall.Failed(status)
          }
        } catch (e: java.io.IOException) {
          BuilderCall.Offline
        } finally {
          c.disconnect()
        }
      }

  private suspend fun <T> get(path: String, token: String?, readTimeoutMs: Int, parse: (String) -> T?): ApiResult<T> =
      withContext(Dispatchers.IO) {
        val c =
            try {
              URL(base + path).openConnection() as HttpURLConnection
            } catch (e: java.io.IOException) {
              return@withContext ApiResult.Offline
            }
        try {
          c.connectTimeout = 15_000
          c.readTimeout = readTimeoutMs
          c.useCaches = false
          c.setRequestProperty("X-Virvi-App-Version", userAgentVersion.toString())
          if (!token.isNullOrEmpty()) c.setRequestProperty("Authorization", "Bearer $token")
          val code = c.responseCode
          when {
            code == 404 -> ApiResult.NotFound
            code == 429 -> ApiResult.RateLimited
            code in 200..299 -> {
              val body = c.inputStream.bufferedReader().use { it.readText() }
              parse(body)?.let { ApiResult.Ok(it) } ?: ApiResult.Failed(code)
            }
            else -> ApiResult.Failed(code)
          }
        } catch (e: java.io.IOException) {
          ApiResult.Offline
        } finally {
          c.disconnect()
        }
      }

  private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
}
