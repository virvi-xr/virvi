/**
 * Wording for a failed or refused in-world edit, and the reconnect loop that makes "Reconnecting…" true.
 * Pure (no @dcl/sdk), so it is unit-tested. The Vision Pro HUD mirrors these messages (HudModel.swift).
 */

export const SIGNED_OUT = "You're signed out. Sign in again to edit."
export const NO_PERMISSION = "You don't have permission to edit this scene."
export const DISCONNECTED = 'Disconnected from Virvi. Reconnecting…'
export const NOT_FOUND = 'That item no longer exists — reopen the panel to refresh'
export const SOMETHING_WRONG = 'Something went wrong — try again'
/** The server's 426: this HUD is older than the oldest one allowed to edit (x-virvi-hud-protocol). */
export const REDEPLOY = 'This scene needs a redeploy to edit'

/** The HTTP status of a @virvixr/client error (`HTTP 403: {...}`), or null when the request got no answer. */
export function httpStatusOf(err: unknown): number | null {
  const m = /^HTTP (\d+):/.exec(err instanceof Error ? err.message : String(err))
  return m ? Number(m[1]) : null
}

/** A request that never got an answer: fetch rejects with a TypeError (or a runtime's network / timeout error). */
function isNetworkError(err: unknown): boolean {
  if (httpStatusOf(err) !== null) return false
  if (err instanceof TypeError) return true
  return /network|fetch|timed? ?out|offline|ECONN|socket/i.test(err instanceof Error ? err.message : String(err))
}

/**
 * Map a @virvixr/client error from a media / layout edit to text for the Assets and Layout panels.
 * `connected: false` means the scene room is down: a request with no answer, or a 401 (the 15 min pass ran out
 * while offline and is re-signed on reconnect), then reads as disconnected. A 403 is always the server's refusal.
 */
export function friendlyEditError(err: unknown, opts: { connected?: boolean } = {}): string {
  const status = httpStatusOf(err)
  const connected = opts.connected !== false
  if (status === 403) return NO_PERMISSION
  if (status === 426) return REDEPLOY
  if (status === 401) return connected ? SIGNED_OUT : DISCONNECTED
  if (status === 404) return NOT_FOUND
  if (status === null && (!connected || isNetworkError(err))) return DISCONNECTED
  return SOMETHING_WRONG
}

export function friendlyRenameError(err: unknown, opts: { connected?: boolean } = {}): string {
  const status = httpStatusOf(err)
  if (status === 400) return 'Names need 1-120 characters, without slashes'
  if (status === 409) return "That file isn't ready yet"
  return friendlyEditError(err, opts)
}

/**
 * Why an edit can't be sent yet, or null when it can. A role that says "can't edit" is fetched again first,
 * so a role gone stale (promoted since joining, a reconnect) never blocks an editor. A failed fetch keeps the role.
 */
export async function editBlockedMessage(o: {
  connected: boolean
  canEdit: () => boolean
  refreshRole: () => Promise<void>
}): Promise<string | null> {
  if (!o.connected) return DISCONNECTED
  if (o.canEdit()) return null
  try {
    await o.refreshRole()
  } catch {
    // keep the current role
  }
  return o.canEdit() ? null : NO_PERMISSION
}

/** Reconnect delays after the scene room drops; the last one repeats until a connect succeeds. */
export const RECONNECT_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000]

/**
 * Rejoins the scene room after a drop: `connect` with backoff until it succeeds, then `onReconnected`
 * (which fetches the role again). `schedule` returns a cancel function.
 */
export function createReconnector(o: {
  connect: () => Promise<void>
  onReconnected: () => Promise<void>
  onFailed?: (err: unknown) => void
  schedule: (fn: () => void, ms: number) => () => void
  delaysMs?: number[]
}) {
  const delays = o.delaysMs ?? RECONNECT_DELAYS_MS
  let attempt = 0
  let cancel: (() => void) | null = null
  let active = false
  // Bumped by stop(), so an attempt in flight when stopped doesn't schedule another
  let gen = 0

  const next = () => {
    const g = gen
    cancel = o.schedule(() => {
      cancel = null
      void o.connect().then(
        async () => {
          if (g !== gen) return
          active = false
          attempt = 0
          await o.onReconnected().catch(() => {})
        },
        (err) => {
          if (g !== gen) return
          o.onFailed?.(err)
          attempt++
          next()
        },
      )
    }, delays[Math.min(attempt, delays.length - 1)])
  }

  return {
    get reconnecting() { return active },
    /** The room dropped: start reconnecting (once; a drop while already reconnecting changes nothing). */
    lost() {
      if (active) return
      active = true
      attempt = 0
      next()
    },
    /** A manual Retry or a teardown: cancel any pending attempt. */
    stop() {
      gen++
      cancel?.()
      cancel = null
      active = false
      attempt = 0
    },
  }
}
