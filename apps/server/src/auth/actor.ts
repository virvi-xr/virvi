import type { SessionClaims } from './tokens.js'

export interface Actor {
  userId: string | null
  role: string
  wallet: string | null
  verified: boolean
  /** A signed-out visitor's trial session: owner-only scene access (getSceneAccess), reached only on trial-allowlisted routes. */
  trial?: true
}

export const ANONYMOUS: Actor = Object.freeze({ userId: null, role: 'viewer', wallet: null, verified: false })

/** Normalize JWT claims (or request.user) into an Actor. Only an explicit `verified: true` counts: every token issuer sets it, so a claim-less token is unverified. */
export function actorFromClaims(c: Partial<SessionClaims> | null | undefined): Actor {
  if (!c || c.guest || !c.id) return ANONYMOUS
  // A trial is never verified and never more than a creator, whatever its claims say. Its token is no Colyseus session.
  if (c.kind === 'trial') return { userId: c.id, role: 'creator', wallet: null, verified: false, trial: true }
  return {
    userId: c.id,
    role: c.role ?? 'viewer',
    wallet: c.wallet ? c.wallet.toLowerCase() : null,
    verified: c.verified === true,
  }
}
