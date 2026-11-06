import type { SessionClaims } from './tokens.js'

export interface Actor {
  userId: string | null
  role: string
  wallet: string | null
  verified: boolean
}

export const ANONYMOUS: Actor = Object.freeze({ userId: null, role: 'viewer', wallet: null, verified: false })

/** Normalize JWT claims (or request.user) into an Actor. Only an explicit `verified: true` counts: every token issuer sets it, so a claim-less token is unverified. */
export function actorFromClaims(c: Partial<SessionClaims> | null | undefined): Actor {
  // A trial session is no actor: it reaches the Studio routes through request.user, never a scene or room.
  if (!c || c.guest || !c.id || c.kind === 'trial') return ANONYMOUS
  return {
    userId: c.id,
    role: c.role ?? 'viewer',
    wallet: c.wallet ? c.wallet.toLowerCase() : null,
    verified: c.verified === true,
  }
}
