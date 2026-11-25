package io.virvi.ar.visitor

import io.virvi.ar.api.AppResponse
import io.virvi.ar.api.ArApi
import io.virvi.ar.api.BuilderCall
import io.virvi.ar.api.PairClaim
import io.virvi.ar.api.RefreshResult
import io.virvi.ar.api.errorCode
import io.virvi.ar.builder.DeviceAuth
import io.virvi.ar.builder.SecureStore
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

sealed interface SignInState {
  data object SignedOut : SignInState
  /** The code is a credential: it is not printed. */
  data class ShowingCode(val code: String, val approveUrl: String, val expiresAtMs: Long) : SignInState {
    override fun toString() = "ShowingCode(expiresAtMs=$expiresAtMs)"
  }
  data class SignedIn(val userId: String, val userName: String?) : SignInState
}

/**
 * The visitor's own sign-in on the headset: the headset shows a code, and the visitor approves it at virvi.io/pair or
 * from the Virvi iPhone app (a `purpose: 'visitor'` pairing). The claim gives the approver's account session, kept in
 * [store] (encrypted on the headset), and the pairing's id, sent as `X-Virvi-Device` on BEAT writes. This is not the
 * builder's headset pairing (`DeviceAuth`): that one can build, this one can only earn BEATs.
 *
 * It follows the Virvi app's session rules (`AppSession.swift`): refresh once on a 401 about the token, one refresh at
 * a time; a 401 about the install (`attest_required`, `bad_assertion`) doesn't refresh; a refused refresh signs out; a
 * server error or being offline keeps the session. Tokens and codes are never logged. Signing in or out never touches
 * the AR scene.
 */
class VisitorSignIn(
    private val api: ArApi,
    private val store: SecureStore,
    private val clock: () -> Long,
    private val pollMs: Long = DeviceAuth.POLL_MS,
    private val deviceName: String? = null,
) {
  @Volatile
  var state: SignInState = restored()
    private set

  /** Told each time [state] changes, on the thread that changed it. */
  @Volatile var onState: ((SignInState) -> Unit)? = null

  private val pairing = AtomicBoolean(false)
  private val refreshLock = Mutex()

  /** The access tokens this session has had, newest last (a few): how a refused token is known as the visitor's own and not a builder's pass. */
  private val had = ArrayDeque<String>()

  private fun remember(token: String) = synchronized(had) {
    had.addLast(token)
    while (had.size > 4) had.removeFirst()
  }

  private fun wasMine(token: String) = synchronized(had) { token in had }

  init {
    store.get(KEY_ACCESS)?.let(::remember)
  }

  private fun restored(): SignInState {
    val id = store.get(KEY_USER_ID)
    return if (store.get(KEY_ACCESS) != null && store.get(KEY_REFRESH) != null && store.get(KEY_DEVICE) != null && id != null)
        SignInState.SignedIn(id, store.get(KEY_USER_NAME))
    else SignInState.SignedOut
  }

  private fun set(next: SignInState) {
    state = next
    onState?.invoke(next)
  }

  /** The access token to send, or null when signed out. */
  fun bearer(): String? = if (state is SignInState.SignedIn) store.get(KEY_ACCESS) else null

  /** The pairing's id, for `X-Virvi-Device`, while signed in. */
  fun deviceId(): String? = if (state is SignInState.SignedIn) store.get(KEY_DEVICE) else null

  /** The signed-in account's id, to key what the headset remembers per account. */
  fun userId(): String? = (state as? SignInState.SignedIn)?.userId

  /**
   * Starts a visitor pairing and polls the claim until the visitor approves, refuses, or the code lapses (10 minutes),
   * or the caller cancels. Ends in [SignInState.SignedIn] or [SignInState.SignedOut]. A second call while one is
   * polling is ignored.
   */
  suspend fun begin() {
    if (!pairing.compareAndSet(false, true)) return
    try {
      pairOnce()
    } finally {
      pairing.set(false)
    }
  }

  private suspend fun pairOnce() {
    val secret = newSecret()
    try {
      val start =
          when (val r = api.startPairing(DeviceAuth.sha256Hex(secret), deviceName, "visitor")) {
            is BuilderCall.Ok -> r.value
            else -> return settleSignedOut()
          }
      set(SignInState.ShowingCode(start.code, start.approveUrl, start.codeExpiresAtMs))
      while (clock() < start.codeExpiresAtMs) {
        delay(pollMs)
        when (val r = api.claim(start.code, secret)) {
          is BuilderCall.Ok ->
              when (val c = r.value) {
                PairClaim.Pending -> Unit
                // A refused code, or a builder claim a visitor pairing never gets
                PairClaim.Refused, is PairClaim.Approved -> return settleSignedOut()
                is PairClaim.Visitor -> {
                  remember(c.session.accessToken)
                  store.put(KEY_ACCESS, c.session.accessToken)
                  store.put(KEY_REFRESH, c.session.refreshToken)
                  store.put(KEY_DEVICE, c.deviceId)
                  store.put(KEY_USER_ID, c.session.userId)
                  store.put(KEY_USER_NAME, c.session.userName)
                  set(SignInState.SignedIn(c.session.userId, c.session.userName))
                  return
                }
              }
          // Offline, rate limited or a server hiccup: keep trying until the code runs out.
          BuilderCall.Offline, BuilderCall.RateLimited, is BuilderCall.Failed -> Unit
          else -> return settleSignedOut()
        }
      }
      settleSignedOut()
    } finally {
      // Cancelled while showing the code: back to signed out, unless the sign-in finished
      if (state is SignInState.ShowingCode) settleSignedOut()
    }
  }

  /** The visitor cancels the code, or signs out: forgets the session here at once. */
  fun signOut() {
    store.remove(KEY_ACCESS, KEY_REFRESH, KEY_DEVICE, KEY_USER_ID, KEY_USER_NAME)
    set(SignInState.SignedOut)
  }

  private fun settleSignedOut() {
    if (state !is SignInState.SignedOut) signOut()
  }

  /**
   * Sends with the access token and the device id. When the server answers 401 about the token, it refreshes once and
   * sends again with the new token; that answer is returned whatever it is. A 401 about the install (`attest_required`,
   * `bad_assertion`) is returned as it is: a new token wouldn't help. Null when signed out, with nothing sent.
   */
  suspend fun authorized(send: suspend (token: String, deviceId: String) -> AppResponse): AppResponse? {
    val used = bearer() ?: return null
    val device = deviceId() ?: return null
    val first = send(used, device)
    if (first !is AppResponse.Response || first.status != 401 || isInstallRefusal(first.body)) return first
    if (!refreshAfter(used)) return first
    val next = bearer()?.takeIf { it != used } ?: return first
    return send(next, deviceId() ?: return first)
  }

  private fun isInstallRefusal(body: String) = errorCode(body).let { it == "attest_required" || it == "bad_assertion" }

  /**
   * The server refused [used]. Refreshes the session, one refresh at a time: callers that wait their turn find the token
   * already changed. True when [used] was this session's token (it is refreshed, signed out, or kept after a refresh
   * that couldn't be tried); false when it is not (a builder's pass).
   */
  suspend fun refreshAfter(used: String): Boolean =
      refreshLock.withLock {
        if (!wasMine(used)) return@withLock false
        // Signed out meanwhile, or another call refreshed already: the token to use now is the caller's to read
        if (state !is SignInState.SignedIn) return@withLock true
        val current = store.get(KEY_ACCESS) ?: return@withLock true
        if (current != used) return@withLock true
        val refresh = store.get(KEY_REFRESH) ?: return@withLock false
        when (val r = api.refresh(refresh)) {
          is RefreshResult.Tokens ->
              // Only while it is still the same session: a sign-out (or a new sign-in) during the call wins
              if (store.get(KEY_REFRESH) == refresh) {
                remember(r.accessToken)
                store.put(KEY_ACCESS, r.accessToken)
                if (r.refreshToken != null) store.put(KEY_REFRESH, r.refreshToken)
              }
          RefreshResult.Refused -> if (store.get(KEY_REFRESH) == refresh) signOut()
          RefreshResult.Unavailable -> Unit
        }
        true
      }

  private fun newSecret(): String {
    val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
    return bytes.joinToString("") { "%02x".format(it) }
  }

  companion object {
    const val KEY_ACCESS = "visitor_access"
    const val KEY_REFRESH = "visitor_refresh"
    const val KEY_DEVICE = "visitor_device"
    const val KEY_USER_ID = "visitor_user_id"
    const val KEY_USER_NAME = "visitor_user_name"
  }
}
