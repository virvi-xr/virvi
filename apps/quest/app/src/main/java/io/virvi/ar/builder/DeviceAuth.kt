package io.virvi.ar.builder

import io.virvi.ar.api.ArApi
import io.virvi.ar.api.BuilderCall
import io.virvi.ar.api.DeviceKind
import io.virvi.ar.api.DeviceSpace
import io.virvi.ar.api.MintedPass
import io.virvi.ar.api.PairClaim
import java.security.MessageDigest
import java.security.SecureRandom
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

sealed interface AuthState {
  data object SignedOut : AuthState
  data class Pairing(val code: String, val approveUrl: String, val expiresAtMs: Long) : AuthState {
    /** The code is a credential: it is not printed. */
    override fun toString() = "Pairing(expiresAtMs=$expiresAtMs)"
  }
  data class Paired(val deviceId: String, val kind: DeviceKind) : AuthState
}

/** The paired headset's id and secret, for the routes the secret itself authorises. The secret is not printed. */
data class DeviceCredential(val deviceId: String, val secret: String) {
  override fun toString() = "DeviceCredential(deviceId=$deviceId)"
}

sealed interface PassResult {
  data class Ok(val token: String, val sceneId: String) : PassResult {
    override fun toString() = "Ok(sceneId=$sceneId)"
  }
  data object NoAccess : PassResult
  /**
   * This headset is no longer signed in: it was unpaired on the website, or ended its session, or was signed out
   * while the call was running. The store is cleared and the state is [AuthState.SignedOut].
   */
  data object Revoked : PassResult
  data object Offline : PassResult
  /** The server answered something unexpected (including a 401 that isn't a revocation). */
  data class Failed(val status: Int) : PassResult
}

/** What builder mode needs of the headset's pairing ([DeviceAuth] on the headset; a fake in tests). */
interface BuilderAuth {
  val state: StateFlow<AuthState>

  suspend fun beginPairing()

  suspend fun spaces(): BuilderCall<List<DeviceSpace>>

  suspend fun passFor(spaceId: String): PassResult

  suspend fun endSession()

  suspend fun unpair()
}

/**
 * The headset's identity: pairs it with a Virvi account, keeps the device id and secret in [store], and mints (and
 * caches) AR passes. The secret and passes are never logged, and only the secret's SHA-256 goes out when pairing.
 */
class DeviceAuth(
    private val api: ArApi,
    private val store: SecureStore,
    private val clock: () -> Long,
    private val pollMs: Long = POLL_MS,
    private val deviceName: String? = null,
) : BuilderAuth {
  private val _state = MutableStateFlow<AuthState>(restored())
  override val state: StateFlow<AuthState> = _state.asStateFlow()

  /** Cached passes by device id and space id: a pass is never served to a device it wasn't minted for. */
  private val passes = java.util.concurrent.ConcurrentHashMap<Pair<String, String>, MintedPass>()
  private val mintLock = Mutex()

  /**
   * Guards sign-out against the cache's check-then-put: [signOut] and the check-and-cache both hold it, so a pass
   * is never cached (or served) once a sign-out has happened. Plain monitor: both sides are non-suspending.
   */
  private val cacheLock = Any()

  /** Bumped by every sign-out, so a mint that was in flight across one can tell and discards its pass. */
  @Volatile private var epoch = 0

  private val pairing = java.util.concurrent.atomic.AtomicBoolean(false)

  /** Test seams: run after a mint returns, before the check; and inside the check-and-cache. */
  internal var afterMintForTest: () -> Unit = {}
  internal var insideCacheForTest: () -> Unit = {}
  internal val cachedPassCount get() = passes.size
  internal fun signOutForTest() = signOut()

  private fun restored(): AuthState {
    val id = store.get(KEY_ID)
    val kind = store.get(KEY_KIND)?.let { k -> DeviceKind.entries.firstOrNull { it.name == k } }
    return if (id != null && kind != null && store.get(KEY_SECRET) != null) AuthState.Paired(id, kind) else AuthState.SignedOut
  }

  /**
   * Makes a secret, starts a pairing and polls until the approver answers, the code expires (10 minutes) or the caller
   * cancels. Ends in [AuthState.Paired] or [AuthState.SignedOut].
   */
  override suspend fun beginPairing() {
    // One pairing at a time: a second call while one is polling is ignored.
    if (!pairing.compareAndSet(false, true)) return
    try {
      pairOnce()
    } finally {
      pairing.set(false)
    }
  }

  private suspend fun pairOnce() {
    // Pairing again is an explicit re-pair: forget the old pairing first.
    if (_state.value is AuthState.Paired) signOut()
    val secret = newSecret()
    try {
      val start =
          when (val r = api.startPairing(sha256Hex(secret), deviceName)) {
            is BuilderCall.Ok -> r.value
            else -> return signOut()
          }
      _state.value = AuthState.Pairing(start.code, start.approveUrl, start.codeExpiresAtMs)
      while (clock() < start.codeExpiresAtMs) {
        delay(pollMs)
        when (val r = api.claim(start.code, secret)) {
          is BuilderCall.Ok ->
              when (val c = r.value) {
                PairClaim.Pending -> Unit
                PairClaim.Refused -> return signOut()
                is PairClaim.Approved -> {
                  store.put(KEY_SECRET, secret)
                  store.put(KEY_ID, c.deviceId)
                  store.put(KEY_KIND, c.kind.name)
                  _state.value = AuthState.Paired(c.deviceId, c.kind)
                  return
                }
              }
          // Offline, rate limited or a server hiccup: keep trying until the code runs out.
          BuilderCall.Offline, BuilderCall.RateLimited, is BuilderCall.Failed -> Unit
          else -> return signOut()
        }
      }
      signOut()
    } finally {
      // Cancelled (or failed) while pairing: don't leave a half-made secret behind.
      if (_state.value !is AuthState.Paired) signOut()
    }
  }

  /** A pass for [spaceId]: the cached one while it has more than 60 s left, else a freshly minted one. */
  override suspend fun passFor(spaceId: String): PassResult = mintLock.withLock { passLocked(spaceId) }

  private suspend fun passLocked(spaceId: String): PassResult {
    val id: String
    val secret: String
    val startEpoch: Int
    synchronized(cacheLock) {
      id = store.get(KEY_ID) ?: return PassResult.Revoked
      secret = store.get(KEY_SECRET) ?: return PassResult.Revoked
      val cached = passes[id to spaceId]
      if (cached != null && cached.expiresAtMs - clock() > MIN_LEFT_MS) return PassResult.Ok(cached.pass, cached.sceneId)
      startEpoch = epoch
    }
    val r = api.mintPass(id, secret, spaceId)
    afterMintForTest()
    if (r is BuilderCall.Ok) {
      // Check and cache as one step against sign-out: a pass minted across a sign-out belongs to nobody now.
      synchronized(cacheLock) {
        if (epoch != startEpoch || store.get(KEY_ID) != id) return PassResult.Revoked
        insideCacheForTest()
        passes[id to spaceId] = r.value
      }
    } else if (epoch != startEpoch) {
      return PassResult.Revoked
    }
    return when (r) {
      is BuilderCall.Ok -> PassResult.Ok(r.value.pass, r.value.sceneId)
      BuilderCall.NoAccess, BuilderCall.NotFound -> PassResult.NoAccess
      BuilderCall.Revoked, BuilderCall.BadSecret -> {
        signOut()
        PassResult.Revoked
      }
      BuilderCall.Offline -> PassResult.Offline
      BuilderCall.RateLimited -> PassResult.Failed(429)
      BuilderCall.Unauthorized -> PassResult.Failed(401)
      is BuilderCall.Failed -> PassResult.Failed(r.status)
    }
  }

  /**
   * Runs [block] with a pass for [spaceId]. If it answers [BuilderCall.Unauthorized] (the pass expired mid-call) the
   * cached pass is dropped and [block] runs once more with a fresh one. A revoked device ends as [BuilderCall.Revoked].
   */
  suspend fun <T> withPass(spaceId: String, block: suspend (token: String) -> BuilderCall<T>): BuilderCall<T> {
    for (attempt in 1..2) {
      val pass =
          when (val p = passFor(spaceId)) {
            is PassResult.Ok -> p
            PassResult.NoAccess -> return BuilderCall.NoAccess
            PassResult.Revoked -> return BuilderCall.Revoked
            PassResult.Offline -> return BuilderCall.Offline
            is PassResult.Failed -> return BuilderCall.Failed(p.status)
          }
      val r = block(pass.token)
      if (r is BuilderCall.Revoked) {
        signOut()
        return r
      }
      if (r !is BuilderCall.Unauthorized || attempt == 2) return r
      mintLock.withLock {
        val id = store.get(KEY_ID)
        if (id != null) passes.remove(id to spaceId)
      }
    }
    return BuilderCall.Unauthorized
  }

  /**
   * Shared headset: forgets the pairing at once, then ends the session on the server (best effort, with the
   * credentials read before forgetting). Personal: only drops the cached passes.
   */
  override suspend fun endSession() {
    val s = _state.value as? AuthState.Paired ?: return
    if (s.kind == DeviceKind.PERSONAL) {
      mintLock.withLock { passes.clear() }
      return
    }
    signOutThenEnd()
  }

  /**
   * **Sign out** from the menu, either kind of headset: forgets the pairing here at once, then tells the server the
   * session is over (it ends this headset's drafts; a shared headset is unpaired there), best effort. A personal
   * headset stays listed on the website until it is revoked there.
   */
  override suspend fun unpair() {
    if (_state.value !is AuthState.Paired) return
    signOutThenEnd()
  }

  /**
   * Signs out before anything can fail or wait: a slow, failing or cancelled `/end` must never leave the headset
   * paired for the next person. The server call then uses the credentials captured beforehand.
   */
  private suspend fun signOutThenEnd() {
    val id = store.get(KEY_ID)
    val secret = store.get(KEY_SECRET)
    signOut()
    if (id != null && secret != null) api.endSession(id, secret)
  }

  /** The headset's id and secret while it is paired; null otherwise. */
  fun credential(): DeviceCredential? {
    if (_state.value !is AuthState.Paired) return null
    val id = store.get(KEY_ID) ?: return null
    val secret = store.get(KEY_SECRET) ?: return null
    return DeviceCredential(id, secret)
  }

  /**
   * Runs [block] with the headset's [credential]. Not paired is [BuilderCall.Revoked]; an answer of revoked or bad
   * secret signs the headset out (if it is still the same pairing) and is [BuilderCall.Revoked].
   */
  suspend fun <T> withCredential(block: suspend (DeviceCredential) -> BuilderCall<T>): BuilderCall<T> {
    val c = credential() ?: return BuilderCall.Revoked
    val r = block(c)
    if (r is BuilderCall.Revoked || r is BuilderCall.BadSecret) {
      if (store.get(KEY_ID) == c.deviceId) signOut()
      return BuilderCall.Revoked
    }
    return r
  }

  /** The spaces the approver can build on. A revoked device is signed out here like everywhere else. */
  override suspend fun spaces(): BuilderCall<List<DeviceSpace>> {
    val id = store.get(KEY_ID)
    val secret = store.get(KEY_SECRET)
    if (id == null || secret == null) return BuilderCall.Revoked
    val r = api.deviceSpaces(id, secret)
    if (r is BuilderCall.Revoked || r is BuilderCall.BadSecret) {
      if (store.get(KEY_ID) == id) signOut()
      return BuilderCall.Revoked
    }
    return r
  }

  private fun signOut() {
    synchronized(cacheLock) {
      epoch++
      store.remove(KEY_ID, KEY_KIND, KEY_SECRET)
      passes.clear()
      _state.value = AuthState.SignedOut
    }
  }

  private fun newSecret(): String {
    val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
    return hex(bytes)
  }

  companion object {
    const val POLL_MS = 2_000L
    const val MIN_LEFT_MS = 60_000L
    const val KEY_ID = "device_id"
    const val KEY_SECRET = "device_secret"
    const val KEY_KIND = "device_kind"

    /** Hex SHA-256 of the UTF-8 [s]: how the server hashes a secret. */
    fun sha256Hex(s: String): String = hex(MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8)))

    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }
  }
}
