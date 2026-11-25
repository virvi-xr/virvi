package io.virvi.ar.visitor

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val NOW = 1_795_532_400_000L // inside the window

private fun card(claim: AppBeatClaim? = null, wallets: List<String> = emptyList()) =
    AppBeatCard(
        "b1", "Opening Night", "https://x/i.png", 5, "2026-11-24T10:00:00.000Z", "2026-11-24T20:00:00.000Z",
        "in_person", "The Loft", claim, wallets,
    )

private fun present(seconds: Int) = AppBeatClaim("present", seconds, null, null)

/** A scripted [BeatRoutes]: each call answers the next queued result and is recorded. */
class FakeRoutes : BeatRoutes {
  val calls = java.util.concurrent.CopyOnWriteArrayList<String>()
  var spaceCard: BeatResult<AppBeatCard?> = BeatResult.Ok(null)
  val tracks = ArrayDeque<BeatResult<AppBeatCard>>()
  val checkIns = ArrayDeque<BeatResult<AppBeatCard>>()
  val claims = ArrayDeque<BeatResult<AppBeatCard>>()
  var stop: BeatResult<Unit> = BeatResult.Ok(Unit)

  override suspend fun spaceBeat(spaceId: String): BeatResult<AppBeatCard?> = spaceCard.also { calls += "card:$spaceId" }

  override suspend fun track(beatId: String, spaceId: String): BeatResult<AppBeatCard> =
      tracks.removeFirst().also { calls += "track:$beatId:$spaceId" }

  override suspend fun checkIn(beatId: String, spaceId: String): BeatResult<AppBeatCard> =
      checkIns.removeFirst().also { calls += "checkin:$beatId:$spaceId" }

  override suspend fun claim(beatId: String, wallet: String?): BeatResult<AppBeatCard> =
      claims.removeFirst().also { calls += "claim:$beatId:${wallet ?: "-"}" }

  override suspend fun stopTracking(beatId: String): BeatResult<Unit> = stop.also { calls += "stop:$beatId" }
}

class BeatControllerTest {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
  private val routes = FakeRoutes()
  private var signedIn = true
  private var signInAsked = 0
  private var view: BeatView? = null
  private val views = mutableListOf<BeatView?>()

  @After
  fun tearDown() = scope.cancel()

  private fun controller(checkInMs: Long = 5): BeatController =
      BeatController(
          scope, routes,
          signedIn = { signedIn }, startSignIn = { signInAsked++ },
          publish = { view = it; views += it }, nowMs = { NOW }, checkInMs = checkInMs,
      )

  private fun waitFor(what: String, ms: Long = 2000, cond: () -> Boolean) {
    val end = System.currentTimeMillis() + ms
    while (!cond()) {
      if (System.currentTimeMillis() > end) error("timed out: $what; calls=${routes.calls}")
      Thread.sleep(2)
    }
  }

  @Test
  fun `a shown space with a BEAT shows its card`() {
    routes.spaceCard = BeatResult.Ok(card())
    val c = controller()
    c.spaceShown("s1")
    waitFor("card") { view != null }
    assertEquals("Opening Night", view!!.name)
    assertEquals("Attend for 5 minutes to earn the Opening Night BEAT.", view!!.text)
    assertEquals("Track my attendance", view!!.button)
    assertEquals(listOf("card:s1"), routes.calls)
  }

  @Test
  fun `no BEAT, or the space going away, hides the card`() {
    routes.spaceCard = BeatResult.Ok(card())
    val c = controller()
    c.spaceShown("s1")
    waitFor("card") { view != null }
    c.spaceShown(null)
    assertNull(view)
    routes.spaceCard = BeatResult.Ok(null)
    c.spaceShown("s2")
    waitFor("fetched") { routes.calls.contains("card:s2") }
    assertNull(view)
  }

  @Test
  fun `signed out the card asks to sign in, and the button starts the sign-in`() {
    signedIn = false
    routes.spaceCard = BeatResult.Ok(card())
    val c = controller()
    c.spaceShown("s1")
    waitFor("card") { view != null }
    assertEquals("Sign in to earn this BEAT", view!!.button)
    c.primary()
    assertEquals(1, signInAsked)
  }

  @Test
  fun `every track asks for consent, and sends it only once accepted`() {
    routes.spaceCard = BeatResult.Ok(card())
    routes.tracks += BeatResult.Ok(card(present(0)))
    routes.tracks += BeatResult.Ok(card(present(0)))
    val c = controller(checkInMs = 10_000)
    c.spaceShown("s1")
    waitFor("card") { view != null }
    c.primary()
    assertEquals(beatAppConsentText("Opening Night"), view!!.consent)
    assertFalse(routes.calls.any { it.startsWith("track") })
    c.acceptConsent()
    waitFor("tracked") { routes.calls.contains("track:b1:s1") }
    waitFor("counting") { view?.canStop == true && view?.consent == null }
    // Stopping and tracking again asks again: nothing is remembered between tracks
    c.stopTracking()
    waitFor("track again") { view?.button == "Track my attendance" }
    c.primary()
    assertEquals(beatAppConsentText("Opening Night"), view!!.consent)
    assertEquals(1, routes.calls.count { it.startsWith("track") })
    c.acceptConsent()
    waitFor("tracked twice") { routes.calls.count { it.startsWith("track") } == 2 }
  }

  @Test
  fun `declining the consent sends nothing`() {
    routes.spaceCard = BeatResult.Ok(card())
    val c = controller()
    c.spaceShown("s1")
    waitFor("card") { view != null }
    c.primary()
    c.declineConsent()
    assertNull(view!!.consent)
    assertEquals(listOf("card:s1"), routes.calls)
  }

  @Test
  fun `check-ins run only while counting and only while the space is shown`() {
    routes.spaceCard = BeatResult.Ok(card(present(0)))
    routes.checkIns += BeatResult.Ok(card(present(30)))
    routes.checkIns += BeatResult.Ok(card(present(60)))
    routes.checkIns += BeatResult.Ok(card(present(300)))
    val c = controller(checkInMs = 5)
    c.spaceShown("s1")
    waitFor("three check-ins") { routes.calls.count { it.startsWith("checkin") } >= 3 }
    // Claimable now: the loop ends
    waitFor("claimable") { view?.button == "Claim your BEAT" }
    val n = routes.calls.count { it.startsWith("checkin") }
    Thread.sleep(40)
    assertEquals(n, routes.calls.count { it.startsWith("checkin") })
  }

  @Test
  fun `the space going away stops the check-ins`() {
    routes.spaceCard = BeatResult.Ok(card(present(0)))
    repeat(200) { routes.checkIns += BeatResult.Ok(card(present(0))) }
    val c = controller(checkInMs = 5)
    c.spaceShown("s1")
    waitFor("one check-in") { routes.calls.any { it.startsWith("checkin") } }
    c.spaceShown(null)
    Thread.sleep(30)
    val n = routes.calls.count { it.startsWith("checkin") }
    Thread.sleep(60)
    assertEquals(n, routes.calls.count { it.startsWith("checkin") })
  }

  @Test
  fun `a signed-out card does not check in`() {
    signedIn = false
    routes.spaceCard = BeatResult.Ok(card())
    val c = controller(checkInMs = 5)
    c.spaceShown("s1")
    waitFor("card") { view != null }
    Thread.sleep(40)
    assertFalse(routes.calls.any { it.startsWith("checkin") })
  }

  @Test
  fun `claiming with one wallet shows the sent words`() {
    routes.spaceCard = BeatResult.Ok(card(present(300)))
    routes.claims += BeatResult.Ok(card(AppBeatClaim("claimed", 300, "0xA", null)))
    val c = controller()
    c.spaceShown("s1")
    waitFor("claimable") { view?.button == "Claim your BEAT" }
    c.primary()
    waitFor("sent") { view?.text == "Your Opening Night BEAT is in your wallet" }
    assertTrue(routes.calls.contains("claim:b1:-"))
    assertTrue(views.any { it?.claiming == true })
  }

  @Test
  fun `several wallets offer a choice, and the chosen one is claimed`() {
    routes.spaceCard = BeatResult.Ok(card(present(300), wallets = listOf("0xAAAA1111BBBB2222", "0xCCCC3333DDDD4444")))
    routes.claims += BeatResult.Error(AppBeatError(409, "choose_wallet", "Choose.", listOf("0xAAAA1111BBBB2222", "0xCCCC3333DDDD4444")))
    routes.claims += BeatResult.Ok(card(AppBeatClaim("waiting", 300, null, null)))
    val c = controller()
    c.spaceShown("s1")
    waitFor("claimable") { view?.button == "Claim your BEAT" }
    c.primary()
    waitFor("choice") { view?.wallets?.size == 2 }
    assertNull(view!!.button?.takeIf { view!!.wallets.isEmpty() })
    c.claimWith("0xCCCC3333DDDD4444")
    waitFor("waiting") { view?.text == "Saved for you. Link a wallet at virvi.io and it'll be sent." }
    assertTrue(routes.calls.contains("claim:b1:0xCCCC3333DDDD4444"))
  }

  @Test
  fun `stop tracking deletes the claim and goes back to track`() {
    routes.spaceCard = BeatResult.Ok(card(present(60)))
    val c = controller(checkInMs = 10_000)
    c.spaceShown("s1")
    waitFor("counting") { view?.canStop == true }
    c.stopTracking()
    waitFor("track") { view?.button == "Track my attendance" }
    assertTrue(routes.calls.contains("stop:b1"))
  }

  @Test
  fun `an error shows the server's words, and a retry asks again`() {
    routes.spaceCard = BeatResult.Ok(card())
    routes.tracks += BeatResult.Error(AppBeatError(403, "verify_first", "Verify your email at virvi.io to earn BEATs."))
    routes.tracks += BeatResult.Ok(card(present(0)))
    val c = controller(checkInMs = 10_000)
    c.spaceShown("s1")
    waitFor("card") { view != null }
    c.primary()
    c.acceptConsent()
    waitFor("error") { view?.text == "Verify your email at virvi.io to earn BEATs." }
    assertTrue(view!!.canRetry)
    c.retry()
    c.acceptConsent() // a retried track asks for consent again
    waitFor("counting") { view?.canStop == true }
  }

  @Test
  fun `the account changing asks for the card again`() {
    signedIn = false
    routes.spaceCard = BeatResult.Ok(card())
    val c = controller()
    c.spaceShown("s1")
    waitFor("card") { view?.button == "Sign in to earn this BEAT" }
    signedIn = true
    c.accountChanged()
    waitFor("track") { view?.button == "Track my attendance" }
    assertEquals(2, routes.calls.count { it == "card:s1" })
  }

  @Test
  fun `the account changing forgets what to retry`() {
    routes.spaceCard = BeatResult.Ok(card())
    routes.tracks += BeatResult.Error(AppBeatError(403, "verify_first", "Verify first."))
    val c = controller(checkInMs = 10_000)
    c.spaceShown("s1")
    waitFor("card") { view != null }
    c.primary()
    c.acceptConsent()
    waitFor("error") { view?.canRetry == true }
    c.accountChanged()
    waitFor("track") { view?.button == "Track my attendance" }
    c.retry() // shows the card as the server gave it; sends no track
    assertEquals(1, routes.calls.count { it.startsWith("track") })
  }

  @Test
  fun `an answer for a space that has gone is dropped`() {
    routes.spaceCard = BeatResult.Ok(card())
    val c = controller()
    c.spaceShown("s1")
    c.spaceShown(null)
    Thread.sleep(20)
    assertNull(view)
    assertNotNull(c)
  }
}
