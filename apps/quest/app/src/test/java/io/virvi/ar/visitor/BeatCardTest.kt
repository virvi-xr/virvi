package io.virvi.ar.visitor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The Quest's BEAT card mirrors packages/virvi-ar-swift's BeatCardTests: the same states, words and mapping. */
class BeatCardTest {
  private fun card(
      claim: AppBeatClaim? = null,
      minMinutes: Int = 5,
      venue: String? = "The Loft",
      wallets: List<String> = emptyList(),
  ) =
      AppBeatCard(
          "b1", "Opening Night", "https://x/i.png", minMinutes, "2026-11-24T10:00:00.000Z", "2026-11-24T20:00:00.000Z",
          "in_person", venue, claim, wallets,
      )

  private fun claim(status: String, seconds: Int = 0, wallet: String? = null) =
      AppBeatClaim(status, seconds, wallet, "2026-11-24T10:00:00.000Z")

  private val now = 1_795_532_400_000L // 2026-11-24T15:00Z, inside the window

  private fun state(c: AppBeatCard?, signedIn: Boolean = true): BeatCardState {
    val b = BeatCard()
    b.apply(c, signedIn, now)
    return b.state
  }

  @Test
  fun `no card is hidden`() = assertEquals(BeatCardState.Hidden, state(null))

  @Test
  fun `signed out asks to sign in`() =
      assertEquals(BeatCardState.SignInToEarn("Opening Night", 5), state(card(), signedIn = false))

  @Test
  fun `no claim offers to track`() = assertEquals(BeatCardState.Track("Opening Night", 5), state(card()))

  @Test
  fun `three of five minutes counts two left, and a part minute rounds up`() {
    assertEquals(BeatCardState.Counting("Opening Night", 2), state(card(claim("present", 180))))
    assertEquals(BeatCardState.Counting("Opening Night", 2), state(card(claim("present", 181))))
    assertEquals(BeatCardState.Counting("Opening Night", 5), state(card(claim("present", 0))))
  }

  @Test
  fun `five of five is claimable`() {
    assertEquals(BeatCardState.Claimable("Opening Night"), state(card(claim("present", 300))))
    assertEquals(BeatCardState.Claimable("Opening Night"), state(card(claim("present", 900))))
  }

  @Test
  fun `waiting for a wallet`() =
      assertEquals(BeatCardState.WaitingForWallet("Opening Night"), state(card(claim("waiting", 300))))

  @Test
  fun `claimed, minting and minted are sent`() {
    for (s in listOf("claimed", "minting", "minted")) {
      assertEquals(s, BeatCardState.Sent("Opening Night"), state(card(claim(s, 300, "0xA"))))
    }
  }

  @Test
  fun `failed shows the try again words`() =
      assertEquals(BeatCardState.Failed("Something went wrong. Try again in a moment."), state(card(claim("failed"))))

  @Test
  fun `removed is hidden, and an ended BEAT you never tracked is hidden`() {
    assertEquals(BeatCardState.Hidden, state(card(claim("removed"))))
    val b = BeatCard()
    b.apply(card(), true, 1_795_564_800_000L) // after endsAt
    assertEquals(BeatCardState.Hidden, b.state)
  }

  @Test
  fun `choose wallet keeps the list`() {
    val b = BeatCard()
    b.apply(card(claim("present", 300)), true, now)
    b.apply(AppBeatError(409, "choose_wallet", "Choose the wallet to send this BEAT to.", listOf("0xA", "0xB")))
    assertEquals(BeatCardState.ChooseWallet("Opening Night", listOf("0xA", "0xB")), b.state)
    assertEquals("Claim your BEAT", b.buttonTitle)
  }

  @Test
  fun `outside names the venue and says it in the right words`() {
    val b = BeatCard()
    b.apply(card(claim("present", 300)), true, now)
    b.apply(AppBeatError(403, "outside", "x"))
    assertEquals(BeatCardState.Outside("The Loft"), b.state)
    assertEquals("Come back to The Loft to claim this BEAT.", b.text)
    val c = BeatCard()
    c.apply(card(), true, now)
    c.apply(AppBeatError(403, "outside", "x"))
    assertEquals("You need to be at The Loft to check in.", c.text)
    val d = BeatCard()
    d.apply(card(venue = null), true, now)
    d.apply(AppBeatError(403, "outside", "x"))
    assertEquals(BeatCardState.Outside("the venue"), d.state)
  }

  @Test
  fun `poor fix`() {
    val b = BeatCard()
    b.apply(card(), true, now)
    b.apply(AppBeatError(422, "poor_fix", "x"))
    assertEquals(BeatCardState.PoorFix, b.state)
    assertEquals("Couldn't get your location accurately. Step outside or near a window and try again.", b.text)
  }

  @Test
  fun `not yet goes back to counting`() {
    val b = BeatCard()
    b.apply(card(claim("present", 240)), true, now)
    b.apply(AppBeatError(409, "not_yet", "x"))
    assertEquals(BeatCardState.Counting("Opening Night", 1), b.state)
  }

  @Test
  fun `other errors show the server's words`() {
    for (code in listOf("this_device", "verify_first", "all_claimed", "too_late")) {
      val b = BeatCard()
      b.apply(card(), true, now)
      b.apply(AppBeatError(409, code, "server said $code"))
      assertEquals(code, BeatCardState.Failed("server said $code"), b.state)
    }
  }

  @Test
  fun `claiming, then the card replaces it`() {
    val b = BeatCard()
    b.apply(card(claim("present", 300)), true, now)
    b.beginClaim()
    assertEquals(BeatCardState.Claiming, b.state)
    assertNull(b.text)
    b.apply(card(claim("claimed", 300, "0xA")), true, now)
    assertEquals(BeatCardState.Sent("Opening Night"), b.state)
  }

  @Test
  fun `the words of each state`() {
    val b = BeatCard()
    b.apply(card(), false, now)
    assertEquals("Attend for 5 minutes to earn the Opening Night BEAT.", b.text)
    assertEquals("Sign in to earn this BEAT", b.buttonTitle)
    b.apply(card(), true, now)
    assertEquals("Track my attendance", b.buttonTitle)
    b.apply(card(claim("present", 180)), true, now)
    assertEquals("Attend for 2 minutes to earn the Opening Night BEAT.", b.text)
    b.apply(card(claim("present", 300)), true, now)
    assertEquals("Claim your BEAT", b.buttonTitle)
    b.apply(card(claim("waiting", 300)), true, now)
    assertEquals("Saved for you. Link a wallet at virvi.io and it'll be sent.", b.text)
    b.apply(card(claim("claimed", 300, "0xA")), true, now)
    assertEquals("Your Opening Night BEAT is in your wallet", b.text)
  }

  @Test
  fun `parses the server's card`() {
    val json =
        """{"beatId":"b1","name":"Opening Night","imageUrl":"https://x/i.png","minMinutes":5,
          |"startsAt":"2026-11-24T10:00:00.000Z","endsAt":"2026-11-24T20:00:00.000Z",
          |"location":{"type":"in_person","venue":"The Loft"},
          |"claim":{"status":"present","secondsPresent":180,"wallet":null,"checkedInAt":"2026-11-24T10:00:00.000Z"},
          |"wallets":["0xA"]}"""
            .trimMargin()
    assertEquals(card(claim("present", 180), wallets = listOf("0xA")), parseAppBeatCard(json))
    assertNull(parseAppBeatCard("""{"beatId":"b1"}"""))
    assertNull(parseAppBeatCard("not json"))
  }

  @Test
  fun `the consent text is the global constraints' word for word`() {
    assertEquals(1, BEAT_APP_CONSENT_VERSION)
    assertEquals(
        "To track your attendance for the Opening Night BEAT, Virvi stores your account, how long you're here and, when you claim, the wallet you choose. Virvi checks your location only when you check in and when you claim, and doesn't keep it. The hosts of this event will see your name and time. If you claim, your wallet, this BEAT and the time it was sent are recorded on Polygon, a public blockchain: anyone can see that record, and nobody can delete it. You can stop tracking at any time before you claim, which deletes what was stored.",
        beatAppConsentText("Opening Night"),
    )
  }

  @Test
  fun `the visitor copy matches the plan`() {
    assertEquals("Sign in", VisitorCopy.MENU_SIGN_IN)
    assertEquals("Sign out", VisitorCopy.MENU_SIGN_OUT)
    assertEquals(
        "Go to virvi.io/pair or open the Virvi app on your phone and enter this code:",
        VisitorCopy.PAIR_INSTRUCTION,
    )
  }
}
