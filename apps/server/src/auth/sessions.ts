import type { FastifyInstance } from 'fastify'
import type { SignInMethod } from '@virvixr/shared'
import { config } from '../config.js'

export interface SessionUser {
  id: string
  email: string | null
  role: string
  activeOrgId: string | null
  displayName: string | null
}

/** Issue the access + refresh tokens of a verified-wallet session (wallet sign-in and in-world hand-off). */
export function issueWalletSession(app: FastifyInstance, user: SessionUser, wallet: string) {
  // `am`: how the session signed in (reissue provenance, LIV-11); kept across refreshes
  const claims = { id: user.id, email: user.email, role: user.role, orgId: user.activeOrgId || null, wallet, verified: true, kind: 'account' as const, am: 'wallet' as const }
  return {
    user: { id: user.id, displayName: user.displayName, email: user.email, role: user.role },
    accessToken: app.jwt.sign(claims, { expiresIn: config.jwtAccessExpiry }),
    refreshToken: app.jwt.sign({ ...claims, refresh: true }, { expiresIn: config.jwtRefreshExpiry }),
  }
}

/** The session a password or OAuth sign-in answers with (no wallet claim). `am` says which (email by default). */
export function issueAccountSession(app: FastifyInstance, user: SessionUser, am: SignInMethod = 'email') {
  return {
    user: { id: user.id, displayName: user.displayName, email: user.email, role: user.role },
    accessToken: app.jwt.sign(
      { id: user.id, email: user.email, role: user.role, orgId: user.activeOrgId || null, verified: true, kind: 'account' as const, am },
      { expiresIn: config.jwtAccessExpiry },
    ),
    refreshToken: app.jwt.sign(
      { id: user.id, email: user.email, role: user.role, refresh: true, verified: true, kind: 'account' as const, am },
      { expiresIn: config.jwtRefreshExpiry },
    ),
  }
}
