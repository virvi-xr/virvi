export interface ScenePass { sceneId: string; locationId: string | null }

function payloadOf(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1]
  if (!part) return null
  try {
    const json = typeof atob === 'function' ? atob(part.replace(/-/g, '+').replace(/_/g, '/')) : Buffer.from(part, 'base64url').toString()
    return JSON.parse(json)
  } catch { return null }
}

/** A stored session is usable only if unexpired and of a known kind. Visitor passes (no scene) are never kept. */
export function readSession(token: string, now: number): { ok: false } | { ok: true; scenePass: ScenePass | null } {
  const p = payloadOf(token)
  if (!p || typeof p.exp !== 'number' || p.exp * 1000 <= now) return { ok: false }
  if (p.kind === 'account') return { ok: true, scenePass: null }
  if (p.kind === 'scene' && typeof p.sceneId === 'string') return { ok: true, scenePass: { sceneId: p.sceneId, locationId: typeof p.locationId === 'string' ? p.locationId : null } }
  return { ok: false }
}

/** Pages a scene pass may open: that scene's analytics. Extend here when HUD links to more scene pages. */
export function scenePassAllows(pathname: string, search: string, pass: ScenePass): boolean {
  if (pathname !== '/analytics' && !pathname.startsWith('/analytics/')) return false
  const q = new URLSearchParams(search)
  return q.get('scene') === pass.sceneId || (!!pass.locationId && q.get('location') === pass.locationId)
}

/** An unexpired trial session token (kept by the web app beside account sessions; never a scene pass). */
export function readTrialSession(token: string, now: number): boolean {
  const p = payloadOf(token)
  return !!p && typeof p.exp === 'number' && p.exp * 1000 > now && p.kind === 'trial'
}
