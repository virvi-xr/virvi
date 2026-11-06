import { signinPath } from './landing-route'
import { safeNextPath } from './next-path'
import { payloadOf, readSession } from './session'

export interface HandoffDeps {
  href: string                                   // window.location.href at load
  replaceUrl: (url: string) => void              // history.replaceState(null, '', url)
  exchange: (code: string) => Promise<{ status: number; body?: { accessToken: string; refreshToken: string | null; user: unknown } }>
  saveSession: (s: { token: string; refresh: string | null; user: unknown }) => void // localStorage 'virvi_auth', same shape as auth/callback
  go: (url: string) => void                      // window.location.href = url (full load so AuthProvider reads the session)
  storedSession?: () => string | null            // localStorage.getItem('virvi_auth')
  /** Asked only when the link signs in a different account than the stored one. Absent → stay. */
  choose?: (c: { them: string; stored: string }) => Promise<'them' | 'stay'>
  now?: () => number
}

const shortWallet = (w: string) => (w.length > 12 ? `${w.slice(0, 6)}…${w.slice(-4)}` : w)

const maskEmail = (e: string) => {
  const at = e.lastIndexOf('@')
  return at > 0 ? `${e[0]}•••${e.slice(at)}` : null
}

/**
 * What to call an account on the choice. The display name is freely editable (anyone can copy yours), so it is never
 * shown alone: always with the short wallet, else the masked email; with neither, "another Virvi account".
 */
function accountLabel(user: unknown, token: string): string {
  const u = (user ?? {}) as { displayName?: unknown; email?: unknown }
  const claims = payloadOf(token) ?? {}
  const wallet = typeof claims.wallet === 'string' && claims.wallet ? shortWallet(claims.wallet) : null
  const emailRaw = typeof claims.email === 'string' && claims.email ? claims.email : typeof u.email === 'string' && u.email ? u.email : null
  const proof = wallet ?? (emailRaw ? maskEmail(emailRaw) : null)
  if (!proof) return 'another Virvi account'
  const name = typeof u.displayName === 'string' ? u.displayName.trim() : ''
  return name ? `${name} (${proof})` : proof
}

function userIdOf(user: unknown, token: string): string | null {
  const id = (user as { id?: unknown } | null)?.id ?? payloadOf(token)?.id
  return typeof id === 'string' ? id : null
}

function parseStored(stored: string | null): { token: string; user: unknown } | null {
  if (!stored) return null
  try {
    const s = JSON.parse(stored)
    return typeof s?.token === 'string' ? { token: s.token, user: s.user } : null
  } catch {
    return null
  }
}

/** A stored refresh token that can still renew the session: unexpired if it is a JWT, merely present if it is opaque. */
function refreshAlive(refresh: unknown, now: number): boolean {
  if (typeof refresh !== 'string' || !refresh) return false
  const exp = payloadOf(refresh)?.exp
  return typeof exp === 'number' ? exp * 1000 > now : payloadOf(refresh) === null
}

/**
 * True when `virvi_auth` holds a full website session, which a hand-off must never replace with a scene pass. That is
 * an account access token that is unexpired, or expired (they last 15 minutes) with a refresh token that is still live:
 * AuthProvider renews those silently, so the person is still signed in.
 */
export function hasAccountSession(stored: string | null, now: number): boolean {
  if (!stored) return false
  try {
    const s = JSON.parse(stored)
    if (typeof s?.token !== 'string') return false
    const live = readSession(s.token, now)
    if (live.ok) return live.scenePass === null
    return payloadOf(s.token)?.kind === 'account' && refreshAlive(s.refresh, now)
  } catch {
    return false
  }
}

/**
 * Reads the code and `next` from the URL fragment only (fragments never reach a server, a log or a Referer),
 * strips the fragment and query from the address bar (keeping the path) before anything else, exchanges the code once,
 * then goes to `next` (signed in) or to sign-in with `next`. A `?code=` in the query string is never exchanged.
 * Over an existing full (account) session: a scene pass never replaces it (kept, no save); the same account refreshes it;
 * a different account is only taken after `choose` says so (the exchanged session stays in memory until then).
 * With no stored account session, whatever exchanges is saved. When there is no code, or it fails, a full session is kept.
 */
export async function runHandoff(d: HandoffDeps): Promise<'signed-in' | 'fallback'> {
  const u = new URL(d.href)
  const frag = new URLSearchParams(u.hash.replace(/^#/, ''))
  const code = frag.get('code')
  const next = safeNextPath(frag.get('next')) ?? '/analytics/'
  d.replaceUrl(u.pathname)
  const now = d.now?.() ?? Date.now()
  const storedRaw = d.storedSession?.() ?? null
  const storedAccount = hasAccountSession(storedRaw, now) ? parseStored(storedRaw) : null
  if (code) {
    let body: NonNullable<Awaited<ReturnType<HandoffDeps['exchange']>>['body']> | null = null
    try {
      const r = await d.exchange(code)
      if (r.status === 200 && r.body) body = r.body
    } catch {
      /* network error → fall through to a kept session or sign-in */
    }
    if (body) {
      const save = () => d.saveSession({ token: body.accessToken, refresh: body.refreshToken, user: body.user })
      if (!storedAccount) {
        save()
      } else if (hasAccountSession(JSON.stringify({ token: body.accessToken }), now)) {
        const theirs = userIdOf(body.user, body.accessToken)
        const mine = userIdOf(storedAccount.user, storedAccount.token)
        if (theirs !== null && theirs === mine) {
          save()
        } else {
          const pick = d.choose
            ? await d.choose({ them: accountLabel(body.user, body.accessToken), stored: accountLabel(storedAccount.user, storedAccount.token) })
            : 'stay'
          if (pick === 'them') save()
        }
      }
      // else: a scene pass never replaces a full session; the stored one is kept.
      d.go(next)
      return 'signed-in'
    }
  }
  // The code failed (or there was none): an existing full session is kept.
  if (storedAccount) {
    d.go(next)
    return 'signed-in'
  }
  d.go(signinPath(next))
  return 'fallback'
}
