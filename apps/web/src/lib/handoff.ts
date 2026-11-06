import { signinPath } from './landing-route'
import { safeNextPath } from './next-path'
import { readSession } from './session'

export interface HandoffDeps {
  href: string                                   // window.location.href at load
  replaceUrl: (url: string) => void              // history.replaceState(null, '', url)
  exchange: (code: string) => Promise<{ status: number; body?: { accessToken: string; refreshToken: string | null; user: unknown } }>
  saveSession: (s: { token: string; refresh: string | null; user: unknown }) => void // localStorage 'virvi_auth', same shape as auth/callback
  go: (url: string) => void                      // window.location.href = url (full load so AuthProvider reads the session)
  storedSession?: () => string | null            // localStorage.getItem('virvi_auth')
  now?: () => number
}

/** True when `virvi_auth` holds a usable full website session, which a hand-off must never replace with a scene pass. */
export function hasAccountSession(stored: string | null, now: number): boolean {
  if (!stored) return false
  try {
    const token = JSON.parse(stored)?.token
    if (typeof token !== 'string') return false
    const s = readSession(token, now)
    return s.ok && s.scenePass === null
  } catch {
    return false
  }
}

/**
 * Reads the code and `next` from the URL fragment only (fragments never reach a server, a log or a Referer),
 * strips the fragment and query from the address bar (keeping the path) before anything else, exchanges the code once,
 * then goes to `next` (signed in) or to sign-in with `next`. A `?code=` in the query string is never exchanged.
 * A code that exchanges wins over an existing full (account) session, so a checkout link signs in its own account.
 * Only when there is no code, or it fails, is an existing full session kept (straight to `next`).
 */
export async function runHandoff(d: HandoffDeps): Promise<'signed-in' | 'fallback'> {
  const u = new URL(d.href)
  const frag = new URLSearchParams(u.hash.replace(/^#/, ''))
  const code = frag.get('code')
  const next = safeNextPath(frag.get('next')) ?? '/analytics/'
  d.replaceUrl(u.pathname)
  if (code) {
    try {
      const r = await d.exchange(code)
      if (r.status === 200 && r.body) {
        d.saveSession({ token: r.body.accessToken, refresh: r.body.refreshToken, user: r.body.user })
        d.go(next)
        return 'signed-in'
      }
    } catch {
      /* network error → fall through to a kept session or sign-in */
    }
  }
  // The code failed (or there was none): an existing full session is kept.
  if (hasAccountSession(d.storedSession?.() ?? null, d.now?.() ?? Date.now())) {
    d.go(next)
    return 'signed-in'
  }
  d.go(signinPath(next))
  return 'fallback'
}
