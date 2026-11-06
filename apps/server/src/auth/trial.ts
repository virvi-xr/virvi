import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'

export interface TrialUser {
  id: string
  displayName: string | null
  role: string
  trialLastActiveAt: Date | null
}

/** A trial lapses after `TRIAL_IDLE_DAYS` without activity. */
export function trialExpiresAt(lastActive: Date): Date {
  return new Date(lastActive.getTime() + config.trialIdleDays * 86_400_000)
}

export function trialClaims(user: { id: string }) {
  return { id: user.id, email: null, role: 'creator', kind: 'trial' as const, verified: false }
}

/** Issue the access + refresh tokens of a trial session. */
export function issueTrialSession(app: FastifyInstance, user: TrialUser) {
  const claims = trialClaims(user)
  return {
    user: {
      id: user.id,
      displayName: user.displayName,
      trial: true as const,
      expiresAt: trialExpiresAt(user.trialLastActiveAt ?? new Date()).toISOString(),
    },
    accessToken: app.jwt.sign(claims, { expiresIn: config.jwtAccessExpiry }),
    refreshToken: app.jwt.sign({ ...claims, refresh: true }, { expiresIn: config.jwtRefreshExpiry }),
  }
}
