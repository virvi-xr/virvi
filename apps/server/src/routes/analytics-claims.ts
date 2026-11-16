import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { analyticsScenes } from '../db/schema.js'
import { DirectoryUnavailableError } from '../analytics/dcl-directory.js'
import { hasDclAuthHeaders, verifyDclSignedFetch } from '../middleware/dcl-auth.js'
import { isWalletBlocked } from '../auth/wallet-blocks.js'
import { TokenBucketLimiter, checkRequesterLimits } from '../analytics/limiter.js'
import { controls } from '../analytics/claims.js'

let signedLimiter = new TokenBucketLimiter()
let sweepTimer: NodeJS.Timeout | null = null

/** Test hook. */
export function setSignedClaimLimiter(l: TokenBucketLimiter): void {
  signedLimiter = l
}

/** Unauthenticated-by-JWT eligibility probe for the in-world SDK. Never creates users, auth methods or sessions. */
export async function analyticsClaimSignedRoutes(app: FastifyInstance) {
  if (!sweepTimer) {
    sweepTimer = setInterval(() => signedLimiter.sweep(new Date().toISOString().slice(0, 10)), 60_000)
    sweepTimer.unref()
  }
  app.post<{ Body: { locationKey?: string } }>('/api/analytics/claims/check-signed', async (request, reply) => {
    const no = { eligible: false, known: false }
    const key = request.body?.locationKey
    const headers = request.headers as Record<string, string | string[] | undefined>
    const ipLimit = checkRequesterLimits(signedLimiter, { requesterKey: `ip:${request.ip}`, verified: false, eventCount: 1 })
    if (!ipLimit.ok) return reply.status(429).send({ error: 'rate_limited', retryAfter: Math.ceil(ipLimit.retryAfterMs / 1000) })
    if (typeof key !== 'string' || !key || !hasDclAuthHeaders(headers)) return reply.send(no)
    let wallet: string
    try {
      wallet = (await verifyDclSignedFetch(request.method, request.url.split('?')[0], headers)).walletAddress.toLowerCase()
    } catch {
      return reply.send(no)
    }
    // A blocked wallet (LIV-11 reissue) is eligible for nothing
    if (await isWalletBlocked(wallet)) return reply.send(no)
    const limit = checkRequesterLimits(signedLimiter, { requesterKey: `w:${wallet}`, verified: true, eventCount: 1 })
    if (!limit.ok) return reply.status(429).send({ error: 'rate_limited', retryAfter: Math.ceil(limit.retryAfterMs / 1000) })
    const scene = await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.locationKey, key) })
    if (!scene) return reply.send(no)
    try {
      return reply.send({ eligible: await controls(scene, wallet), known: true })
    } catch (err) {
      // Distinct from "not the owner": the SDK retries later instead of giving up.
      if (err instanceof DirectoryUnavailableError) return reply.send({ eligible: false, known: true, unavailable: true })
      throw err
    }
  })
}
