package io.virvi.ar.builder

import io.virvi.ar.api.ArApi
import io.virvi.ar.api.BuilderCall
import io.virvi.ar.api.DeviceKind
import io.virvi.ar.api.MintedPass
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import java.time.Instant
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FakeSecureStore : SecureStore {
  val map = HashMap<String, String>()

  override fun get(key: String) = map[key]

  override fun put(key: String, value: String?) {
    if (value == null) map.remove(key) else map[key] = value
  }

  override fun remove(vararg keys: String) {
    keys.forEach { map.remove(it) }
  }
}

class DeviceAuthTest {
  private val server = MockWebServer()
  private val store = FakeSecureStore()
  private var now = 1_800_000_000_000L

  @After
  fun tearDown() {
    runCatching { server.shutdown() }
  }

  private fun auth(): DeviceAuth {
    server.start()
    return DeviceAuth(ArApi(server.url("/").toString()), store, { now }, pollMs = 1)
  }

  private fun iso(ms: Long) = Instant.ofEpochMilli(ms).toString()

  private fun json(body: String, status: Int = 200) = MockResponse().setResponseCode(status).setBody(body)

  private fun start() = json("""{"code":"ABC123","approveUrl":"https://virvi.io/pair/headset/ABC123","codeExpiresAt":"${iso(now + 600_000)}"}""")

  private val pending = json("""{"status":"pending"}""")

  private fun approved(kind: String = "personal") = json("""{"status":"approved","deviceId":"dev1","kind":"$kind","expiresAt":"${iso(now + 86_400_000)}"}""")

  private fun pass(leftMs: Long, token: String = "jwt") = json("""{"pass":"$token","passExpiresAt":"${iso(now + leftMs)}","sceneId":"sc1"}""")

  private fun pairedAuth(kind: String = "personal"): DeviceAuth {
    server.enqueue(start())
    server.enqueue(approved(kind))
    val a = auth()
    runBlocking { a.beginPairing() }
    server.takeRequest()
    server.takeRequest()
    return a
  }

  @Test
  fun `pairs and stores the device`() {
    server.enqueue(start())
    server.enqueue(pending)
    server.enqueue(pending)
    server.enqueue(approved())
    val a = auth()
    runBlocking { a.beginPairing() }
    assertEquals(AuthState.Paired("dev1", DeviceKind.PERSONAL), a.state.value)
    assertEquals("dev1", store.get(DeviceAuth.KEY_ID))
    val secret = store.get(DeviceAuth.KEY_SECRET)
    assertNotNull(secret)
    assertEquals(64, secret!!.length)
    assertEquals(4, server.requestCount)
  }

  @Test
  fun `refused or expired goes back to signed out`() {
    server.enqueue(start())
    server.enqueue(json("""{"status":"refused"}"""))
    val a = auth()
    runBlocking { a.beginPairing() }
    assertEquals(AuthState.SignedOut, a.state.value)
    assertNull(store.get(DeviceAuth.KEY_SECRET))

    server.enqueue(start())
    server.enqueue(json("""{"error":"not_found"}""", 404))
    runBlocking { a.beginPairing() }
    assertEquals(AuthState.SignedOut, a.state.value)
    assertTrue(store.map.isEmpty())
  }

  @Test
  fun `a code that outlives its time signs out`() {
    server.enqueue(start())
    val a = auth()
    now += 700_000
    runBlocking { a.beginPairing() }
    assertEquals(AuthState.SignedOut, a.state.value)
    assertTrue(store.map.isEmpty())
  }

  @Test
  fun `re-mints a pass before it expires`() {
    val a = pairedAuth()
    server.enqueue(pass(30_000, "old"))
    server.enqueue(pass(900_000, "new"))
    assertEquals(PassResult.Ok("old", "sc1"), runBlocking { a.passFor("sp1") })
    assertEquals(PassResult.Ok("new", "sc1"), runBlocking { a.passFor("sp1") })
    // The fresh one has plenty left: cached.
    assertEquals(PassResult.Ok("new", "sc1"), runBlocking { a.passFor("sp1") })
    assertEquals(2, server.requestCount - 2)
  }

  @Test
  fun `revoked clears everything`() {
    val a = pairedAuth()
    server.enqueue(json("""{"error":"device_revoked"}""", 401))
    assertEquals(PassResult.Revoked, runBlocking { a.passFor("sp1") })
    assertTrue(store.map.isEmpty())
    assertEquals(AuthState.SignedOut, a.state.value)
  }

  @Test
  fun `no access and offline are reported`() {
    val a = pairedAuth()
    server.enqueue(json("""{"error":"no_access"}""", 403))
    assertEquals(PassResult.NoAccess, runBlocking { a.passFor("sp1") })
    server.shutdown()
    assertEquals(PassResult.Offline, runBlocking { a.passFor("sp1") })
    assertTrue(a.state.value is AuthState.Paired)
  }

  @Test
  fun `a 401 Session expired during a save is retried once with a fresh pass`() {
    val a = pairedAuth()
    server.enqueue(pass(900_000, "p1"))
    server.enqueue(pass(900_000, "p2"))
    val seen = ArrayList<String>()
    val r =
        runBlocking {
          a.withPass("sp1") { token ->
            seen += token
            if (token == "p1") BuilderCall.Unauthorized else BuilderCall.Ok("saved")
          }
        }
    assertEquals(BuilderCall.Ok("saved"), r)
    assertEquals(listOf("p1", "p2"), seen)

    // Twice unauthorized: gives up after the one retry.
    server.enqueue(pass(900_000, "p3"))
    var calls = 0
    val r2 = runBlocking { a.withPass("sp1") { _: String -> calls++; BuilderCall.Unauthorized } }
    assertEquals(BuilderCall.Unauthorized, r2)
    assertEquals(2, calls)
  }

  @Test
  fun `withPass treats device_revoked as revoked and does not retry`() {
    val a = pairedAuth()
    server.enqueue(pass(900_000))
    var calls = 0
    val r = runBlocking { a.withPass("sp1") { _: String -> calls++; BuilderCall.Revoked } }
    assertEquals(BuilderCall.Revoked, r)
    assertEquals(1, calls)
    assertEquals(AuthState.SignedOut, a.state.value)
    assertTrue(store.map.isEmpty())
  }

  @Test
  fun `the secret never appears in the request log`() {
    server.enqueue(start())
    server.enqueue(approved())
    val a = auth()
    runBlocking { a.beginPairing() }
    val secret = store.get(DeviceAuth.KEY_SECRET)!!
    val startReq = server.takeRequest()
    assertEquals("/api/ar/pair", startReq.path)
    assertEquals("""{"secretHash":"${DeviceAuth.sha256Hex(secret)}"}""", startReq.body.readUtf8())
    assertFalse(startReq.headers.toString().contains(secret))
    // The claim carries it in the body only, never in the URL.
    val claimReq = server.takeRequest()
    assertFalse(claimReq.path!!.contains(secret))
  }

  @Test
  fun `shared end calls the server and clears, personal only drops passes`() {
    val shared = pairedAuth("shared")
    server.enqueue(MockResponse().setResponseCode(204))
    runBlocking { shared.endSession() }
    assertEquals("/api/ar/devices/dev1/end", server.takeRequest().path)
    assertTrue(store.map.isEmpty())
    assertEquals(AuthState.SignedOut, shared.state.value)
  }

  @Test
  fun `personal end keeps the pairing`() {
    val a = pairedAuth()
    val before = server.requestCount
    runBlocking { a.endSession() }
    assertEquals(before, server.requestCount)
    assertTrue(a.state.value is AuthState.Paired)
    assertEquals("dev1", store.get(DeviceAuth.KEY_ID))
  }

  @Test
  fun `a stored pairing is restored`() {
    store.put(DeviceAuth.KEY_ID, "dev9")
    store.put(DeviceAuth.KEY_SECRET, "s")
    store.put(DeviceAuth.KEY_KIND, "SHARED")
    assertEquals(AuthState.Paired("dev9", DeviceKind.SHARED), auth().state.value)
  }

  @Test
  fun `the pairing code is shown as XXX-XXX`() {
    assertEquals("ABC-123", formatPairingCode("abc123"))
    assertEquals("ABC-123", formatPairingCode("ABC-123"))
  }

  @Test
  fun `deviceSpaces parses the list and sends the secret`() {
    val a = pairedAuth()
    server.enqueue(json("""[{"spaceId":"sp1","spaceName":"Loft","sceneId":"sc1","sceneName":"Scene","markers":[{"markerId":"m1","floorId":"f1","code":"ABCD"}]}]"""))
    val secret = store.get(DeviceAuth.KEY_SECRET)!!
    val r = runBlocking { a.spaces() }
    val spaces = (r as BuilderCall.Ok).value
    assertEquals("Loft", spaces[0].spaceName)
    assertEquals("ABCD", spaces[0].markers[0].code)
    val req = server.takeRequest()
    assertEquals("/api/ar/devices/dev1/spaces", req.path)
    assertEquals("""{"secret":"$secret"}""", req.body.readUtf8())
  }

  @Test
  fun `a mint in flight when the session ends is not served`() {
    val a = pairedAuth("shared")
    server.enqueue(pass(900_000, "late").setBodyDelay(400, java.util.concurrent.TimeUnit.MILLISECONDS))
    server.enqueue(MockResponse().setResponseCode(204))
    val inFlight = java.util.concurrent.CompletableFuture.supplyAsync { runBlocking { a.passFor("sp1") } }
    server.takeRequest() // the mint has reached the server
    runBlocking { a.endSession() }
    assertEquals(PassResult.Revoked, inFlight.get())
    assertEquals(PassResult.Revoked, runBlocking { a.passFor("sp1") })
    assertTrue(store.map.isEmpty())
  }

  @Test
  fun `cancelling a pairing stops polling and leaves the store empty`() {
    server.enqueue(start())
    repeat(3) { server.enqueue(pending) }
    server.start()
    val a = DeviceAuth(ArApi(server.url("/").toString()), store, { now }, pollMs = 50)
    runBlocking {
      val job = launch(Dispatchers.Default) { a.beginPairing() }
      server.takeRequest() // start
      server.takeRequest() // first claim
      job.cancelAndJoin()
    }
    val polled = server.requestCount
    Thread.sleep(200)
    assertEquals(polled, server.requestCount)
    assertEquals(AuthState.SignedOut, a.state.value)
    assertTrue(store.map.isEmpty())
  }

  @Test
  fun `a shared end clears the store even when the server is offline`() {
    val a = pairedAuth("shared")
    server.shutdown()
    runBlocking { a.endSession() }
    assertTrue(store.map.isEmpty())
    assertEquals(AuthState.SignedOut, a.state.value)
  }

  @Test
  fun `a failed re-pair does not leave a stale secret and an unexpected 401 is a failure`() {
    val a = pairedAuth()
    server.enqueue(json("""{"error":"Unauthorized","message":"Invalid or missing token"}""", 401))
    assertEquals(PassResult.Failed(401), runBlocking { a.passFor("sp1") })
    assertTrue(a.state.value is AuthState.Paired)
    server.enqueue(start())
    server.enqueue(json("""{"status":"refused"}"""))
    runBlocking { a.beginPairing() }
    assertTrue(store.map.isEmpty())
  }

  @Test
  fun `credentials are redacted in toString`() {
    val p = MintedPass("tok-secret", 5L, "sc")
    assertFalse(p.toString().contains("tok-secret"))
    assertFalse(PassResult.Ok("tok-secret", "sc").toString().contains("tok-secret"))
    assertFalse(AuthState.Pairing("ABC123", "https://x/ABC123", 1L).toString().contains("ABC123"))
  }

  @Test
  fun `a sign-out between a mint and the cache check serves nothing and caches nothing`() {
    val a = pairedAuth("shared")
    server.enqueue(pass(900_000, "p"))
    a.afterMintForTest = { Thread { a.signOutForTest() }.apply { start() }.join() }
    assertEquals(PassResult.Revoked, runBlocking { a.passFor("sp1") })
    assertEquals(0, a.cachedPassCount)
    assertTrue(store.map.isEmpty())
  }

  @Test
  fun `sign-out cannot run between the cache check and the put`() {
    val a = pairedAuth("shared")
    server.enqueue(pass(900_000, "p"))
    var signer: Thread? = null
    a.insideCacheForTest = { signer = Thread { a.signOutForTest() }.apply { start() }; Thread.sleep(150) }
    // The signer is held out until the put is done...
    assertTrue(runBlocking { a.passFor("sp1") } is PassResult.Ok)
    signer!!.join()
    // ...and then clears what was cached.
    assertEquals(0, a.cachedPassCount)
    assertEquals(AuthState.SignedOut, a.state.value)
    assertEquals(PassResult.Revoked, runBlocking { a.passFor("sp1") })
  }

  @Test
  fun `a pass cached for one device is not served to another`() {
    val a = pairedAuth()
    server.enqueue(pass(900_000, "dev1-pass"))
    assertEquals(PassResult.Ok("dev1-pass", "sc1"), runBlocking { a.passFor("sp1") })
    a.signOutForTest()
    store.put(DeviceAuth.KEY_ID, "dev2")
    store.put(DeviceAuth.KEY_SECRET, "s2")
    server.enqueue(pass(900_000, "dev2-pass"))
    assertEquals(PassResult.Ok("dev2-pass", "sc1"), runBlocking { a.passFor("sp1") })
  }

  @Test
  fun `a second beginPairing while one is polling is ignored`() {
    server.enqueue(start())
    repeat(5) { server.enqueue(pending) }
    server.start()
    val a = DeviceAuth(ArApi(server.url("/").toString()), store, { now }, pollMs = 50)
    val paths = ArrayList<String>()
    runBlocking {
      val job = launch(Dispatchers.Default) { a.beginPairing() }
      paths += server.takeRequest().path!! // the first start
      a.beginPairing() // returns at once: no second pairing
      job.cancelAndJoin()
    }
    while (true) paths += (server.takeRequest(100, java.util.concurrent.TimeUnit.MILLISECONDS) ?: break).path!!
    assertEquals(1, paths.count { it == "/api/ar/pair" })
  }

  @Test
  fun `spaces signs out when the device was revoked`() {
    val a = pairedAuth()
    server.enqueue(json("""{"error":"device_revoked"}""", 401))
    assertEquals(BuilderCall.Revoked, runBlocking { a.spaces() })
    assertEquals(AuthState.SignedOut, a.state.value)
    assertTrue(store.map.isEmpty())
  }

  @Test
  fun `unpair ends the session on the server and forgets a personal pairing too`() {
    val a = pairedAuth()
    server.enqueue(MockResponse().setResponseCode(204))
    runBlocking { a.unpair() }
    val r = server.takeRequest()
    assertEquals("/api/ar/devices/dev1/end", r.path)
    assertTrue(store.map.isEmpty())
    assertEquals(AuthState.SignedOut, a.state.value)
  }

  @Test
  fun `unpair signs out even when the server can't be reached`() {
    val a = pairedAuth()
    server.shutdown()
    runBlocking { a.unpair() }
    assertTrue(store.map.isEmpty())
    assertEquals(AuthState.SignedOut, a.state.value)
  }

  @Test
  fun `a shared end is signed out before the server answers`() {
    val a = pairedAuth("shared")
    server.enqueue(MockResponse().setResponseCode(204).setHeadersDelay(1, java.util.concurrent.TimeUnit.SECONDS))
    val ending = java.util.concurrent.CompletableFuture.runAsync { runBlocking { a.endSession() } }
    val r = server.takeRequest() // /end has reached the server; its answer is a second away
    assertEquals("/api/ar/devices/dev1/end", r.path)
    assertFalse(ending.isDone)
    assertEquals(AuthState.SignedOut, a.state.value)
    assertTrue(store.map.isEmpty())
    ending.get()
  }

  @Test
  fun `an exception from the server call still leaves a shared headset signed out`() {
    store.put(DeviceAuth.KEY_ID, "dev9")
    store.put(DeviceAuth.KEY_SECRET, "s")
    store.put(DeviceAuth.KEY_KIND, "SHARED")
    // A file: URL isn't HTTP, so the call throws (a ClassCastException, not an IOException).
    val a = DeviceAuth(ArApi("file:///nowhere"), store, { now })
    assertTrue(a.state.value is AuthState.Paired)
    assertTrue(runCatching { runBlocking { a.endSession() } }.isFailure)
    assertEquals(AuthState.SignedOut, a.state.value)
    assertTrue(store.map.isEmpty())
  }

  @Test
  fun `unpair is signed out before the server answers, and sends the captured secret`() {
    val a = pairedAuth()
    val secret = store.get(DeviceAuth.KEY_SECRET)!!
    server.enqueue(MockResponse().setResponseCode(204).setHeadersDelay(1, java.util.concurrent.TimeUnit.SECONDS))
    val ending = java.util.concurrent.CompletableFuture.runAsync { runBlocking { a.unpair() } }
    val r = server.takeRequest()
    assertEquals("""{"secret":"$secret"}""", r.body.readUtf8())
    assertFalse(ending.isDone)
    assertEquals(AuthState.SignedOut, a.state.value)
    ending.get()
  }

  @Test
  fun `credential is the paired device's id and secret, and hides the secret when printed`() {
    val a = pairedAuth()
    val c = a.credential()!!
    assertEquals("dev1", c.deviceId)
    assertEquals(store.map[DeviceAuth.KEY_SECRET], c.secret)
    assertFalse(c.toString().contains(c.secret))
  }

  @Test
  fun `credential is null unless paired`() {
    val a = auth()
    assertNull(a.credential())
  }
}
