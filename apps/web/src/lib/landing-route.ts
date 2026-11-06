import { safeNextPath } from './next-path'

/** The sign-in screen, optionally returning to `next` afterwards or opening on registration. */
export function signinPath(next?: string | null, mode?: 'register'): string {
  const q = new URLSearchParams()
  if (next) q.set('next', next)
  if (mode) q.set('mode', mode)
  const s = q.toString()
  return s ? `/signin/?${s}` : '/signin/'
}

/**
 * What `/` does: forward old `/?next=` sign-in links, send signed-in users to their scenes,
 * otherwise show the landing page. A scene pass or trial visitor sees the landing page so they can sign in properly.
 */
export function landingRoute(a: { search: string; loading: boolean; signedIn: boolean; scenePass: boolean; trial?: boolean }): { go: string } | 'wait' | 'show' {
  const next = safeNextPath(new URLSearchParams(a.search).get('next'))
  if (next) return { go: signinPath(next) }
  if (a.loading) return 'wait'
  if (a.signedIn && !a.scenePass && !a.trial) return { go: '/scenes' }
  return 'show'
}
