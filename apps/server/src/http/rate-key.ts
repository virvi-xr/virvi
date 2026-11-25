import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ipKey } from '../errors/limits.js'

/** The address a per-address limit counts (an IPv6 address by its /64), as routes/errors.ts keys its limits. */
export const addressKey = (request: FastifyRequest): string => ipKey(request.ip)

/**
 * The global limit's key. A route with its own limit (sign-in, sign-up, pairing, ...) inherits this generator unless it
 * names one, and those limits are per address: only the global limit itself counts per account (rateKey).
 */
export function globalRateKey(app: FastifyInstance, request: FastifyRequest): string {
  const own = (request.routeOptions?.config as { rateLimit?: unknown } | undefined)?.rateLimit
  return own && typeof own === 'object' ? addressKey(request) : rateKey(app, request)
}

/**
 * Whose allowance a request uses: a signed-in account's own (`user:<id>`), so visitors sharing a venue's Wi-Fi don't
 * share one, or else the address's (`ip:<address>`). Only a bearer that verifies (`app.jwt.verify`) as an account
 * access token counts; anything else (no header, an API key, a refresh token, a pass, a forged or expired token) is
 * counted against the address. Never throws.
 */
export function rateKey(app: FastifyInstance, request: FastifyRequest): string {
  const header = request.headers.authorization
  if (header?.startsWith('Bearer ') && !header.startsWith('Bearer virvi_')) {
    try {
      const c = app.jwt.verify<{ id?: unknown; kind?: unknown; refresh?: unknown; guest?: unknown; via?: unknown }>(header.slice(7))
      if (c.kind === 'account' && !c.refresh && !c.guest && !c.via && typeof c.id === 'string' && c.id) return `user:${c.id}`
    } catch {
      // not a token of ours: the address's allowance
    }
  }
  return `ip:${request.ip}`
}
