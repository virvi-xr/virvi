import { isIP } from 'node:net'
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

/**
 * The key a trial's per-IP daily limit counts by. IPv4 as is (also when mapped into IPv6); IPv6 by its /64, since one
 * home or phone gets a whole /64 and could otherwise start a new trial from every address in it.
 */
export function trialIpKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
  if (mapped) return mapped[1]
  if (isIP(ip) !== 6) return ip
  const [head, tail = ''] = ip.toLowerCase().split('::')
  const left = head ? head.split(':') : []
  const right = ip.includes('::') ? (tail ? tail.split(':') : []) : []
  const groups = ip.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left
  return `${groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':')}::/64`
}
