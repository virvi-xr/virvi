package io.virvi.ar.visitor

import io.virvi.ar.api.ArApi
import io.virvi.ar.api.AppResponse
import io.virvi.ar.builder.FakeSecureStore
import java.time.Instant
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VisitorSignInTest {
  private val server = MockWebServer()
  private val store = FakeSecureStore()
  private var now = 1_800_000_000_000L

  @After
  fun tearDown() {
    runCatching { server.shutdown() }
  }

  private fun signIn(clock: () -> Long = { now }): VisitorSignIn {
    server.start()
    return VisitorSignIn(ArApi(server.url("/").toString()), store, clock, pollMs = 1, deviceName = "Quest 3")
  }

  private fun iso(ms: Long) = Instant.ofEpochMilli(ms).toString()

  private fun json(body: String, status: Int = 200) = MockResponse().setResponseCode(status).setBody(body)

  private fun start() =
      json("""{"code":"ABC123","approveUrl":"https://virvi.io/pair/headset/ABC123","codeExpiresAt":"${iso(now + 600_000)}"}""")

  private val pending = json("""{"status":"pending"}""")

  private fun approved(access: String = "acc1", refresh: String = "ref1") =
      json(
          """{"status":"approved","purpose":"visitor","deviceId":"dev-9","session":{"user":{"id":"u1","displayName":"Ada","email":null,"role":"creator"},"accessToken":"$access","refreshToken":"$refresh"}}"""
      )

  private val api by lazy { ArApi(server.url("/").toString()) }

  /** A BEAT-style call made with the token and device id [VisitorSignIn.authorized] hands over. */
  private suspend fun raw(token: String, device: String, sent: MutableList<String>): AppResponse {
    sent += token
    return api.appCall("GET", "/api/app/x", token, device, null)
  }

  private fun signedInUser(): VisitorSignIn {
    server.enqueue(start())
    server.enqueue(approved())
    val s = signIn()
    runBlocking { s.begin() }
    server.takeRequest()
    server.takeRequest()
    return s
  }

  @Test
  fun `showing the code, then signed in on an approved claim, with the tokens stored`() {
    server.enqueue(start())
    server.enqueue(pending)
    server.enqueue(approved())
    val s = signIn()
    val seen = mutableListOf<SignInState>()
    s.onState = { seen += it }
    runBlocking { s.begin() }
    assertEquals(SignInState.ShowingCode("ABC123", "https://virvi.io/pair/headset/ABC123", now + 600_000), seen.first())
    assertEquals(SignInState.SignedIn("u1", "Ada"), s.state)
    assertEquals("acc1", s.bearer())
    assertEquals("dev-9", s.deviceId())
    assertEquals("acc1", store.get(VisitorSignIn.KEY_ACCESS))
    assertEquals("ref1", store.get(VisitorSignIn.KEY_REFRESH))
    // The start asks for a visitor pairing and sends only the secret's hash
    val startReq = server.takeRequest()
    assertEquals("/api/ar/pair", startReq.path)
    val body = startReq.body.readUtf8()
    assertTrue(body, body.contains(""""purpose":"visitor""""))
    assertTrue(body, body.contains("secretHash"))
    assertFalse(body, body.contains("\"secret\""))
  }

  @Test
  fun `an expired code goes back to signed out`() {
    server.enqueue(start())
    server.enqueue(pending)
    val ticks = AtomicLong(now)
    val s = signIn { ticks.addAndGet(400_000) } // the code lapses after one more poll
    runBlocking { s.begin() }
    assertEquals(SignInState.SignedOut, s.state)
    assertNull(s.bearer())
  }

  @Test
  fun `a refused code, or a claim that says expired, goes back to signed out`() {
    server.enqueue(start())
    server.enqueue(json("""{"status":"refused"}"""))
    val a = signIn()
    runBlocking { a.begin() }
    assertEquals(SignInState.SignedOut, a.state)
    server.enqueue(start())
    server.enqueue(json("""{"error":"not_found"}""", 404))
    runBlocking { a.begin() }
    assertEquals(SignInState.SignedOut, a.state)
  }

  @Test
  fun `a builder claim is not a visitor sign-in`() {
    server.enqueue(start())
    server.enqueue(json("""{"status":"approved","deviceId":"d","kind":"personal","expiresAt":"${iso(now + 1000)}"}"""))
    val s = signIn()
    runBlocking { s.begin() }
    assertEquals(SignInState.SignedOut, s.state)
    assertNull(store.get(VisitorSignIn.KEY_ACCESS))
  }

  @Test
  fun `restores from the store, and sign out clears it`() {
    store.put(VisitorSignIn.KEY_ACCESS, "a")
    store.put(VisitorSignIn.KEY_REFRESH, "r")
    store.put(VisitorSignIn.KEY_DEVICE, "d")
    store.put(VisitorSignIn.KEY_USER_ID, "u")
    store.put(VisitorSignIn.KEY_USER_NAME, "Ada")
    val s = signIn()
    assertEquals(SignInState.SignedIn("u", "Ada"), s.state)
    s.signOut()
    assertEquals(SignInState.SignedOut, s.state)
    assertTrue(store.map.keys.none { it.startsWith("visitor_") })
  }

  @Test
  fun `a 401 refreshes once and retries with the new token`() {
    val s = signedInUser()
    server.enqueue(json("""{"error":"unauthorized"}""", 401))
    server.enqueue(json("""{"accessToken":"acc2","refreshToken":"ref2"}"""))
    server.enqueue(json("""{"ok":true}"""))
    val sent = mutableListOf<String>()
    val r = runBlocking { s.authorized { token, device -> raw(token, device, sent) } }
    assertEquals(200, (r as AppResponse.Response).status)
    assertEquals(listOf("acc1", "acc2"), sent)
    assertEquals("acc2", s.bearer())
    assertEquals("ref2", store.get(VisitorSignIn.KEY_REFRESH))
    server.takeRequest()
    val refresh = server.takeRequest()
    assertEquals("/api/auth/refresh", refresh.path)
    assertEquals("Bearer ref1", refresh.getHeader("Authorization"))
  }

  @Test
  fun `a retry that is still refused is returned, not refreshed again`() {
    val s = signedInUser()
    server.enqueue(json("""{"error":"unauthorized"}""", 401))
    server.enqueue(json("""{"accessToken":"acc2"}"""))
    server.enqueue(json("""{"error":"unauthorized"}""", 401))
    val r = runBlocking { s.authorized { token, device -> raw(token, device, mutableListOf()) } }
    assertEquals(401, (r as AppResponse.Response).status)
    assertEquals(3, server.requestCount - 2)
  }

  @Test
  fun `a refused refresh signs out`() {
    val s = signedInUser()
    server.enqueue(json("""{"error":"unauthorized"}""", 401))
    server.enqueue(json("""{"error":"invalid_token"}""", 401))
    val r = runBlocking { s.authorized { token, device -> raw(token, device, mutableListOf()) } }
    assertEquals(401, (r as AppResponse.Response).status)
    assertEquals(SignInState.SignedOut, s.state)
    assertNull(store.get(VisitorSignIn.KEY_ACCESS))
  }

  @Test
  fun `a server error or being offline on refresh keeps the session`() {
    val s = signedInUser()
    server.enqueue(json("""{"error":"unauthorized"}""", 401))
    server.enqueue(json("""{"error":"boom"}""", 503))
    runBlocking { s.authorized { token, device -> raw(token, device, mutableListOf()) } }
    assertEquals(SignInState.SignedIn("u1", "Ada"), s.state)
    assertEquals("acc1", s.bearer())
  }

  @Test
  fun `an attest-type 401 does not refresh`() {
    val s = signedInUser()
    server.enqueue(json("""{"error":"attest_required"}""", 401))
    val r = runBlocking { s.authorized { token, device -> raw(token, device, mutableListOf()) } }
    assertEquals(401, (r as AppResponse.Response).status)
    assertEquals(1, server.requestCount - 2)
    assertEquals("acc1", s.bearer())
  }

  @Test
  fun `signed out sends nothing`() {
    val s = signIn()
    val r = runBlocking { s.authorized { _, _ -> error("not called") } }
    assertNull(r)
    assertEquals(0, server.requestCount)
  }

  @Test
  fun `concurrent refusals share one refresh`() {
    val s = signedInUser()
    server.dispatcher =
        object : Dispatcher() {
          override fun dispatch(request: RecordedRequest): MockResponse =
              when {
                request.path == "/api/auth/refresh" -> { Thread.sleep(50); json("""{"accessToken":"acc2"}""") }
                request.getHeader("Authorization") == "Bearer acc2" -> json("""{"ok":true}""")
                else -> json("""{"error":"unauthorized"}""", 401)
              }
        }
    val results = runBlocking {
      (1..4).map { async(kotlinx.coroutines.Dispatchers.IO) { s.authorized { t, d -> raw(t, d, mutableListOf()) } } }.awaitAll()
    }
    assertTrue(results.all { (it as AppResponse.Response).status == 200 })
    // 2 setup + 4 refused sends + 1 refresh + 4 retries
    assertEquals(11, server.requestCount)
  }

  @Test
  fun `signing out during a refresh stays signed out`() {
    val s = signedInUser()
    server.enqueue(json("""{"error":"unauthorized"}""", 401))
    server.enqueue(json("""{"accessToken":"acc2"}""").setBodyDelay(100, java.util.concurrent.TimeUnit.MILLISECONDS))
    server.enqueue(json("""{"ok":true}"""))
    runBlocking {
      val call = async(kotlinx.coroutines.Dispatchers.IO) { s.authorized { t, d -> raw(t, d, mutableListOf()) } }
      Thread.sleep(40)
      s.signOut()
      call.await()
    }
    assertEquals(SignInState.SignedOut, s.state)
    assertNull(store.get(VisitorSignIn.KEY_ACCESS))
    assertNotNull(s)
  }

  @Test
  fun `refreshAfter is false for a token that is not the visitor's`() {
    val s = signedInUser()
    assertFalse(runBlocking { s.refreshAfter("a-builder-pass") })
    assertEquals(0, server.requestCount - 2)
  }
}
