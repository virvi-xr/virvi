package io.virvi.ar.visitor

import io.virvi.ar.builder.SecureStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** What the BEAT panel draws (see [BeatController.publish]). Null while there is no card. */
data class BeatView(
    val name: String?,
    /** The line the card shows, or null. */
    val text: String?,
    /** The card's one button, or null. */
    val button: String?,
    /** With a wallet choice: the wallets to offer (the button is then not shown). */
    val wallets: List<String>,
    /** The claim is on its way. */
    val claiming: Boolean,
    /** The consent text waiting for the visitor's answer, or null. */
    val consent: String?,
    val canStop: Boolean,
    val canRetry: Boolean,
)

/** What the BEAT card's buttons do ([BeatController] on the headset). */
interface BeatActions {
  fun primary()
  fun claimWith(wallet: String)
  fun acceptConsent()
  fun declineConsent()
  fun stopTracking()
  fun retry()
}

/** Visitor mode's link to the BEAT card: which space is shown (null: none), and who is signed in. */
interface BeatLink {
  fun spaceShown(spaceId: String?)
  fun accountChanged()
}

/**
 * The BEAT card's behaviour in an AR space, mirroring the Virvi app's `BeatModel`: which BEAT the shown space has,
 * tracking (with the consent text first, on every track), check-ins every [checkInMs] while the shown space's BEAT is counting,
 * claiming (with the wallet choice), and stopping. [BeatCard] decides what it says. The Quest has no location and no
 * event ARCs, so there is no location check and no event card. A signed-out visitor sees the card and its **Sign in to earn
 * this BEAT** button ([startSignIn]). Main thread only.
 */
class BeatController(
    private val scope: CoroutineScope,
    private val routes: BeatRoutes,
    private val signedIn: () -> Boolean,
    private val startSignIn: () -> Unit,
    private val publish: (BeatView?) -> Unit,
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val checkInMs: Long = CHECK_IN_MS,
) : BeatActions, BeatLink {
  private val card = BeatCard()
  private var current: AppBeatCard? = null
  private var shownSpaceId: String? = null
  private var consentText: String? = null
  private var tracksAfterConsent = false
  private var checkIns: Job? = null
  private var lastAction: Action? = null
  private sealed interface Action {
    data object Track : Action
    data class Claim(val wallet: String?) : Action
  }

  /** Bumped whenever the card is replaced from outside, so a late answer for the old one is dropped. */
  private var generation = 0

  // ── what the card is for ─────────────────────────────────────────────

  /** The space now shown changes (null: none is). A shown space with a BEAT shows its card, and checks in every 30 s while counting. */
  override fun spaceShown(spaceId: String?) {
    if (spaceId == shownSpaceId) return
    shownSpaceId = spaceId
    clear()
    if (spaceId != null) load(spaceId)
  }

  /** The visitor signed in or out: the card is asked for again as the new account. */
  override fun accountChanged() {
    val id = shownSpaceId ?: return
    consentText = null
    tracksAfterConsent = false
    // What the last account tried is not the next one's to retry
    lastAction = null
    load(id)
  }

  private fun load(spaceId: String) {
    generation++
    val gen = generation
    cancelCheckIns()
    scope.launch {
      val r = routes.spaceBeat(spaceId)
      if (gen != generation) return@launch
      if (r is BeatResult.Ok) show(r.value) else clear()
    }
  }

  private fun show(found: AppBeatCard?) {
    current = found
    card.apply(found, signedIn(), nowMs())
    syncCheckIns()
    emit()
  }

  private fun clear() {
    generation++
    cancelCheckIns()
    current = null
    consentText = null
    tracksAfterConsent = false
    lastAction = null
    card.apply(null, false, 0)
    emit()
  }

  private fun emit() {
    val c = current
    val s = card.state
    if (c == null || (s == BeatCardState.Hidden && consentText == null)) return publish(null)
    publish(
        BeatView(
            name = c.name,
            text = card.text,
            button = if (s is BeatCardState.ChooseWallet) null else card.buttonTitle,
            wallets = (s as? BeatCardState.ChooseWallet)?.wallets ?: emptyList(),
            claiming = s == BeatCardState.Claiming,
            consent = consentText,
            canStop = s is BeatCardState.Counting || s is BeatCardState.Claimable,
            canRetry = (s == BeatCardState.PoorFix || s is BeatCardState.Outside || s is BeatCardState.Failed),
        )
    )
  }

  // ── tracking ─────────────────────────────────────────────────────────

  /** The card's button for its state. */
  override fun primary() {
    when (card.state) {
      is BeatCardState.SignInToEarn -> startSignIn()
      is BeatCardState.Track -> track()
      is BeatCardState.Claimable -> claim(null)
      else -> Unit
    }
  }

  /** Does again what the visitor last tried, or shows the card as the server last gave it. */
  override fun retry() {
    when (val a = lastAction) {
      Action.Track -> track()
      is Action.Claim -> claim(a.wallet)
      null -> show(current)
    }
  }

  private fun track() {
    val beat = current ?: return
    if (!signedIn()) return
    lastAction = Action.Track
    // Every track asks: nothing about an earlier answer is kept
    consentText = beatAppConsentText(beat.name)
    tracksAfterConsent = true
    emit()
  }

  override fun acceptConsent() {
    consentText = null
    val beat = current
    if (!tracksAfterConsent || beat == null) return emit()
    tracksAfterConsent = false
    emit()
    startTracking(beat)
  }

  override fun declineConsent() {
    consentText = null
    tracksAfterConsent = false
    emit()
  }

  private fun startTracking(beat: AppBeatCard) {
    val spaceId = shownSpaceId ?: return
    val gen = generation
    scope.launch {
      val r = routes.track(beat.beatId, spaceId)
      if (gen != generation) return@launch
      when (r) {
        is BeatResult.Ok -> show(r.value)
        is BeatResult.Error -> fail(r.error)
      }
    }
  }

  override fun stopTracking() {
    val beat = current ?: return
    val gen = generation
    scope.launch {
      val r = routes.stopTracking(beat.beatId)
      if (gen != generation) return@launch
      when (r) {
        is BeatResult.Ok -> show(beat.copy(claim = null))
        is BeatResult.Error -> fail(r.error)
      }
    }
  }

  // ── claiming ─────────────────────────────────────────────────────────

  override fun claimWith(wallet: String) = claim(wallet)

  /** Claims the BEAT; [wallet] is the one the visitor chose when the account has several. */
  private fun claim(wallet: String?) {
    val beat = current ?: return
    lastAction = Action.Claim(wallet)
    card.beginClaim()
    emit()
    val gen = generation
    scope.launch {
      val r = routes.claim(beat.beatId, wallet)
      if (gen != generation) return@launch
      when (r) {
        is BeatResult.Ok -> show(r.value)
        is BeatResult.Error -> fail(r.error)
      }
    }
  }

  private fun fail(e: AppBeatError) {
    card.apply(e)
    syncCheckIns()
    emit()
  }

  // ── check-ins ────────────────────────────────────────────────────────

  /** The check-in timer runs only while the shown space's BEAT is being counted. */
  private fun syncCheckIns() {
    if (shownSpaceId == null || card.state !is BeatCardState.Counting) return cancelCheckIns()
    if (checkIns != null) return
    checkIns =
        scope.launch {
          while (isActive) {
            delay(checkInMs)
            checkIn()
          }
        }
  }

  private fun cancelCheckIns() {
    checkIns?.cancel()
    checkIns = null
  }

  private suspend fun checkIn() {
    val id = shownSpaceId ?: return
    val beat = current ?: return
    val gen = generation
    val r = routes.checkIn(beat.beatId, id)
    if (gen != generation) return
    when (r) {
      is BeatResult.Ok -> show(r.value)
      is BeatResult.Error -> {
        // Dropped offline for a moment: check in again at the next tick. Any other failure is shown, and ends the loop.
        if (r.error.code == "offline") return
        cancelCheckIns()
        fail(r.error)
      }
    }
  }

  companion object {
    /** How often the shown space's BEAT is checked in. */
    const val CHECK_IN_MS = 30_000L
  }
}
