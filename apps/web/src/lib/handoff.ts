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

/** What to call an account on the choice: its display name, else its short wallet, else "another account". */
function accountLabel(user: unknown, token: string): string {
  const name = (user as { displayName?: unknown } | null)?.displayName
  if (typeof name === 'string' && name.trim()) return name.trim()
  const wallet = payloadOf(token)?.wallet
  return typeof wallet === 'string' && wallet ? shortWallet(wallet) : 'another account'
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
