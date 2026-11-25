package io.virvi.ar.visitor

import java.time.Instant
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject

// The Quest's BEAT card, mirroring packages/virvi-ar-swift's Beats/BeatCard.swift: the wire shapes of
// packages/shared/src/beats.ts (AppBeatCard), the states the card shows and how a card or a refusal maps to them. Event
// ARC BEATs are phone-only (the headset has no location and no ARC to scan), so there is no location handling here.

/** The version of the consent text, stored with each app claim: `BEAT_APP_CONSENT_VERSION` in packages/shared/src/beats.ts. */
const val BEAT_APP_CONSENT_VERSION = 1

/**
 * What the visitor agrees to before tracking a BEAT: `beatAppConsentText(name)` in packages/shared/src/beats.ts, word for
 * word, except its sentence about location checks. The headset never checks the location (event BEATs are phone-only), so
 * saying it would be untrue here.
 */
fun beatAppConsentText(name: String) =
    "To track your attendance for the $name BEAT, Virvi stores your account, how long you're here and, when you claim, the wallet you choose. The hosts of this event will see your name, your time and, if you claim, the wallet you choose. If you claim, your wallet, this BEAT and the time it was sent are recorded on Polygon, a public blockchain: anyone can see that record, and nobody can delete it. You can stop tracking at any time before you claim, which deletes what was stored."

data class AppBeatClaim(
    /** `present`, `waiting`, `claimed`, `minting`, `minted`, `failed` or `removed`. */
    val status: String,
    val secondsPresent: Int,
    val wallet: String?,
    val checkedInAt: String?,
)

/** A BEAT as the card shows it; [claim] is the caller's own, [wallets] the caller's wallets that can collect BEATs. */
data class AppBeatCard(
    val beatId: String,
    val name: String,
    val imageUrl: String,
    val minMinutes: Int,
    val startsAt: String,
    val endsAt: String,
    val locationType: String,
    val venue: String?,
    val claim: AppBeatClaim?,
    val wallets: List<String>,
    /** The BEAT has a venue pin, so claiming it checks the phone's location. The headset never does, so it is sent to the phone. */
    val pinned: Boolean = false,
)

/**
 * A refusal from an app route: the server's `{error, message}` (and `wallets` with `choose_wallet`). [status] 0 is a
 * request that never got an answer; [code] then is `offline` or `signed_out`.
 */
data class AppBeatError(val status: Int, val code: String, val message: String, val wallets: List<String> = emptyList())

private fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun JsonObject.int(k: String): Int? = (this[k] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull

/** An [AppBeatCard] from its JSON object text; null when a required field is missing or the wrong type. */
fun parseAppBeatCard(body: String): AppBeatCard? =
    runCatching { Json.parseToJsonElement(body) }.getOrNull()?.let(::parseAppBeatCard)

fun parseAppBeatCard(e: kotlinx.serialization.json.JsonElement?): AppBeatCard? {
  val o = e as? JsonObject ?: return null
  val location = o["location"] as? JsonObject ?: return null
  val claim =
      (o["claim"] as? JsonObject)?.let { c ->
        AppBeatClaim(
            c.str("status") ?: return null,
            c.int("secondsPresent") ?: 0,
            c.str("wallet"),
            c.str("checkedInAt"),
        )
      }
  return AppBeatCard(
      o.str("beatId") ?: return null,
      o.str("name") ?: return null,
      o.str("imageUrl") ?: "",
      o.int("minMinutes") ?: return null,
      o.str("startsAt") ?: "",
      o.str("endsAt") ?: "",
      location.str("type") ?: return null,
      location.str("venue"),
      claim,
      (o["wallets"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull } ?: emptyList(),
      (o["pinned"] as? JsonPrimitive)?.takeIf { !it.isString }?.contentOrNull == "true",
  )
}

sealed interface BeatCardState {
  data object Hidden : BeatCardState
  data class SignInToEarn(val name: String, val minutes: Int) : BeatCardState
  data class Track(val name: String, val minutes: Int) : BeatCardState
  data class Counting(val name: String, val minutesLeft: Int) : BeatCardState
  data class Claimable(val name: String) : BeatCardState
  data class ChooseWallet(val name: String, val wallets: List<String>) : BeatCardState
  data object Claiming : BeatCardState
  data class WaitingForWallet(val name: String) : BeatCardState
  data class Sent(val name: String) : BeatCardState
  data class Outside(val venue: String) : BeatCardState
  data object PoorFix : BeatCardState
  data class Failed(val message: String) : BeatCardState
}

/**
 * What the BEAT card shows, from the server's card ([apply] a card) and from a refused request ([apply] an error). The
 * server's `secondsPresent` is the clock: it is as of the card's fetch, so the card is fetched again to count down.
 */
class BeatCard {
  var state: BeatCardState = BeatCardState.Hidden
    private set

  private var card: AppBeatCard? = null

  fun apply(card: AppBeatCard?, signedIn: Boolean, nowMs: Long) {
    this.card = card
    if (card == null) {
      state = BeatCardState.Hidden
      return
    }
    if (!signedIn) {
      state = BeatCardState.SignInToEarn(card.name, card.minMinutes)
      return
    }
    val claim = card.claim
    if (claim == null) {
      // No one can start tracking a BEAT that has ended
      val end = endMs(card.endsAt)
      state = if (end != null && nowMs > end) BeatCardState.Hidden else BeatCardState.Track(card.name, card.minMinutes)
      return
    }
    state =
        when (claim.status) {
          "present" -> {
            val left = minutesLeft(card, claim)
            if (left > 0) BeatCardState.Counting(card.name, left) else BeatCardState.Claimable(card.name)
          }
          "waiting" -> BeatCardState.WaitingForWallet(card.name)
          "claimed", "minting", "minted" -> BeatCardState.Sent(card.name)
          "failed" -> BeatCardState.Failed(VisitorCopy.BEAT_TRY_AGAIN)
          else -> BeatCardState.Hidden
        }
  }

  /** The claim is on its way to the server: the card shows progress until the answer (a card or an error) replaces it. */
  fun beginClaim() {
    state = BeatCardState.Claiming
  }

  fun apply(error: AppBeatError) {
    val name = card?.name ?: ""
    val c = card
    state =
        when (error.code) {
          "choose_wallet" -> BeatCardState.ChooseWallet(name, error.wallets)
          "outside" -> BeatCardState.Outside(c?.venue ?: VisitorCopy.THE_VENUE)
          "poor_fix" -> BeatCardState.PoorFix
          // A pinned BEAT's claim wants a location the headset can't give
          "location_needed" -> BeatCardState.Failed(VisitorCopy.BEAT_PHONE_ONLY)
          "not_yet" -> {
            val claim = c?.claim
            if (c != null && claim != null) BeatCardState.Counting(name, maxOf(1, minutesLeft(c, claim)))
            else BeatCardState.Failed(error.message)
          }
          else -> BeatCardState.Failed(error.message)
        }
  }

  /** The line the card shows for its state; null when it shows none. */
  val text: String?
    get() =
        when (val s = state) {
          BeatCardState.Hidden, BeatCardState.Claiming, is BeatCardState.ChooseWallet -> null
          is BeatCardState.SignInToEarn -> VisitorCopy.beatAttend(s.minutes, s.name)
          is BeatCardState.Track -> VisitorCopy.beatAttend(s.minutes, s.name)
          is BeatCardState.Counting -> VisitorCopy.beatAttend(s.minutesLeft, s.name)
          is BeatCardState.Claimable -> VisitorCopy.beatAttend(card?.minMinutes ?: 0, s.name)
          is BeatCardState.WaitingForWallet -> VisitorCopy.BEAT_WAITING
          is BeatCardState.Sent -> VisitorCopy.beatSent(s.name)
          // Before a claim exists it is the check-in that was refused
          is BeatCardState.Outside ->
              if (card?.claim == null) VisitorCopy.beatOutsideCheckIn(s.venue) else VisitorCopy.beatOutsideClaim(s.venue)
          BeatCardState.PoorFix -> VisitorCopy.BEAT_POOR_FIX
          is BeatCardState.Failed -> s.message
        }

  /** The card's button, when its state has one. */
  val buttonTitle: String?
    get() =
        when (state) {
          is BeatCardState.SignInToEarn -> VisitorCopy.BEAT_SIGN_IN
          is BeatCardState.Track -> VisitorCopy.BEAT_TRACK
          is BeatCardState.Claimable, is BeatCardState.ChooseWallet -> VisitorCopy.BEAT_CLAIM
          else -> null
        }

  private fun minutesLeft(card: AppBeatCard, claim: AppBeatClaim): Int {
    val leftSeconds = card.minMinutes * 60 - claim.secondsPresent
    return if (leftSeconds <= 0) 0 else (leftSeconds + 59) / 60
  }

  private fun endMs(s: String): Long? = runCatching { Instant.parse(s).toEpochMilli() }.getOrNull()
}
