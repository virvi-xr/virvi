package io.virvi.ar.api

import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ArFeedTest {
  private val server = MockWebServer()
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

  @After
  fun tearDown() {
    scope.cancel()
    runCatching { server.shutdown() }
  }

  private fun feedBody(version: String) =
      """{"v":1,"version":"$version","space":{"id":"s1","name":"Loft","place":null,"lat":null,"lng":null,"published":true,"floors":[]},"scene":null}"""

  @Test
  fun `lookup maps 404, 429 and connection failure`() = runBlocking {
    server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"not_found"}"""))
    server.enqueue(MockResponse().setResponseCode(429).setBody("""{"error":"rate_limited","retryAfter":3}"""))
    server.start()
    val api = ArApi(server.url("/").toString())
    assertEquals(ApiResult.NotFound, api.lookup("ABCD"))
    assertEquals(ApiResult.RateLimited, api.lookup("ABCD"))
    server.shutdown()
    assertEquals(ApiResult.Offline, api.lookup("ABCD"))
  }

  @Test
  fun `lookup sends the app version and no token by default`() = runBlocking {
    server.enqueue(MockResponse().setBody("""{"spaceId":"s","floorId":"f","markerId":"m","spaceName":"Loft","whereText":null}"""))
    server.start()
    val r = ArApi(server.url("/").toString()).lookup("AB CD")
    assertEquals(MarkerLookup("s", "f", "m", "Loft", null), (r as ApiResult.Ok).value)
    val req = server.takeRequest()
    assertEquals("/api/ar/markers/by-code/AB+CD", req.path)
    assertEquals("1", req.getHeader("X-Virvi-App-Version"))
    assertNull(req.getHeader("Authorization"))
  }

  @Test
  fun `a builder's lookup sends its pass as a bearer token`() = runBlocking {
    server.enqueue(MockResponse().setBody("""{"spaceId":"s","floorId":"f","markerId":"m","spaceName":"Loft","whereText":null}"""))
    server.start()
    ArApi(server.url("/").toString()).lookup("ABCD", "pass-1")
    assertEquals("Bearer pass-1", server.takeRequest().getHeader("Authorization"))
  }

  @Test
  fun `a report posts the reason and platform, and the status maps to sent, rate limited or failed`() = runBlocking {
    server.enqueue(MockResponse().setResponseCode(201).setBody("""{"ok":true}"""))
    server.enqueue(MockResponse().setResponseCode(429).setBody("""{"error":"rate_limited"}"""))
    server.enqueue(MockResponse().setResponseCode(404))
    server.enqueue(MockResponse().setResponseCode(400))
    server.enqueue(MockResponse().setResponseCode(500))
    server.start()
    val api = ArApi(server.url("/").toString())
    assertEquals(ReportResult.Sent, api.report("s1", "unsafe"))
    val sent = server.takeRequest()
    assertEquals("POST", sent.method)
    assertEquals("/api/ar/spaces/s1/report", sent.path)
    assertEquals("""{"reason":"unsafe","platform":"ar-quest"}""", sent.body.readUtf8())
    assertNull(sent.getHeader("Authorization"))
    assertEquals(ReportResult.RateLimited, api.report("s1", "spam"))
    for (i in 1..3) assertEquals(ReportResult.Failed, api.report("s1", "other"))
  }

  @Test
  fun `a report that cannot reach the server failed`() = runBlocking {
    server.start()
    val url = server.url("/").toString()
    server.shutdown()
    assertEquals(ReportResult.Failed, ArApi(url).report("s1", "spam"))
  }

  @Test
  fun `the feed long-polls with since and stops on NOT_FOUND`() {
    val paths = CopyOnWriteArrayList<String>()
    var n = 0
    server.dispatcher =
        object : Dispatcher() {
          override fun dispatch(request: RecordedRequest): MockResponse {
            paths += request.path!!
            return when (n++) {
              0 -> MockResponse().setBody(feedBody("a"))
              else -> MockResponse().setResponseCode(404).setBody("""{"error":"not_found"}""")
            }
          }
        }
    server.start()
    val statuses = CopyOnWriteArrayList<FeedStatus>()
    val snaps = CopyOnWriteArrayList<String>()
    ArFeed(scope, ArApi(server.url("/").toString()), { statuses += it }, { snaps += it.version }).start("s1") { "tok" }
    val deadline = System.currentTimeMillis() + 10_000
    while (FeedStatus.NOT_FOUND !in statuses && System.currentTimeMillis() < deadline) Thread.sleep(20)
    assertEquals(listOf("/api/ar/spaces/s1/feed?since=", "/api/ar/spaces/s1/feed?since=a"), paths.toList())
    assertEquals(listOf("a"), snaps.toList())
    assertEquals(listOf(FeedStatus.CONNECTING, FeedStatus.LIVE, FeedStatus.NOT_FOUND), statuses.toList())
    Thread.sleep(300)
    assertEquals(2, paths.size) // stopped
    assertTrue(server.requestCount == 2)
  }

  @Test
  fun `an unparseable body reports BAD_DATA and other errors FAILED, then it keeps trying`() {
    var n = 0
    server.dispatcher =
        object : Dispatcher() {
          override fun dispatch(request: RecordedRequest): MockResponse =
              when (n++) {
                0 -> MockResponse().setBody("not json")
                1 -> MockResponse().setResponseCode(500)
                else -> MockResponse().setResponseCode(404)
              }
        }
    server.start()
    val statuses = CopyOnWriteArrayList<FeedStatus>()
    ArFeed(scope, ArApi(server.url("/").toString()), { statuses += it }, {}).start("s1")
    val deadline = System.currentTimeMillis() + 10_000
    while (FeedStatus.NOT_FOUND !in statuses && System.currentTimeMillis() < deadline) Thread.sleep(20)
    assertEquals(
        listOf(FeedStatus.CONNECTING, FeedStatus.BAD_DATA, FeedStatus.FAILED, FeedStatus.NOT_FOUND),
        statuses.toList(),
    )
  }

  /** A feed whose answers depend on the Authorization header: [answer] gets it (null for none). */
  private fun feedServer(answer: (auth: String?) -> MockResponse): CopyOnWriteArrayList<String?> {
    val auths = CopyOnWriteArrayList<String?>()
    server.dispatcher =
        object : Dispatcher() {
          override fun dispatch(request: RecordedRequest): MockResponse {
            auths += request.getHeader("Authorization")
            return answer(request.getHeader("Authorization"))
          }
        }
    server.start()
    return auths
  }

  private fun waitForSnapshot(snaps: List<String>) {
    val deadline = System.currentTimeMillis() + 10_000
    while (snaps.isEmpty() && System.currentTimeMillis() < deadline) Thread.sleep(10)
  }

  @Test
  fun `a refused visitor token is refreshed and the feed goes on with the new one`() {
    var token = "old"
    val auths = feedServer { a -> if (a == "Bearer new") MockResponse().setBody(feedBody("a")) else MockResponse().setResponseCode(401).setBody("""{"error":"unauthorized"}""") }
    val snaps = CopyOnWriteArrayList<String>()
    val refused = CopyOnWriteArrayList<String>()
    ArFeed(scope, ArApi(server.url("/").toString()), {}, { snaps += it.version }, refused = { used -> refused += used; token = "new"; true })
        .start("s1") { token }
    waitForSnapshot(snaps)
    assertEquals(listOf("old"), refused.toList())
    assertEquals(listOf("Bearer old", "Bearer new"), auths.take(2))
  }

  @Test
  fun `a token that stays refused falls back to an anonymous poll`() {
    val auths = feedServer { a -> if (a == null) MockResponse().setBody(feedBody("a")) else MockResponse().setResponseCode(401).setBody("""{"error":"unauthorized"}""") }
    val snaps = CopyOnWriteArrayList<String>()
    ArFeed(scope, ArApi(server.url("/").toString()), {}, { snaps += it.version }, refused = { true }).start("s1") { "same" }
    waitForSnapshot(snaps)
    assertEquals(listOf("Bearer same", null), auths.take(2))
  }

  @Test
  fun `a visitor who signed out while refused polls anonymously`() {
    var token: String? = "old"
    val auths = feedServer { a -> if (a == null) MockResponse().setBody(feedBody("a")) else MockResponse().setResponseCode(401) }
    val snaps = CopyOnWriteArrayList<String>()
    ArFeed(scope, ArApi(server.url("/").toString()), {}, { snaps += it.version }, refused = { token = null; true }).start("s1") { token }
    waitForSnapshot(snaps)
    assertEquals(listOf("Bearer old", null), auths.take(2))
  }

  @Test
  fun `a refused token that is not the visitor's (a builder's pass) is not retried or dropped`() {
    val auths = feedServer { MockResponse().setResponseCode(401).setBody("""{"error":"unauthorized"}""") }
    val statuses = CopyOnWriteArrayList<FeedStatus>()
    ArFeed(scope, ArApi(server.url("/").toString()), { statuses += it }, {}, refused = { false }).start("s1") { "pass" }
    val deadline = System.currentTimeMillis() + 10_000
    while (FeedStatus.FAILED !in statuses && System.currentTimeMillis() < deadline) Thread.sleep(10)
    assertEquals(FeedStatus.FAILED, statuses.last())
    assertTrue(auths.all { it == "Bearer pass" })
  }
}
